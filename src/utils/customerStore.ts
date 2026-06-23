import { supabase } from '../lib/supabase'
import { getJapanDateString } from './dateUtils'

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // I, O, 0, 1 を除外

function generateRecoveryCode(): string {
  const rand = (n: number) =>
    Array.from({ length: n }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('')
  return `GIN-${rand(4)}-${rand(4)}`
}

export interface CustomerRow {
  id: string
  user_id: string
  name: string
  normalized_name?: string | null
  phone_last4: string | null
  recovery_code: string
  created_at: string
  updated_at: string
}

/**
 * 顧客名の照合用正規化（前後/半角/全角スペース除去・連続スペース除去・大文字小文字吸収）。
 * 「山田太郎」「山田 太郎」「山田　太郎」を同一人物候補として扱うための内部キー。
 */
export function normalizeCustomerName(name: string): string {
  return name.trim().replace(/[ 　]+/g, '').toLowerCase()
}

function generateGuestUserId(): string {
  return `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// customers.normalized_name は追加マイグレーション（schema.sql参照）が必要な列。
// 未適用環境でQR会員登録・編集が壊れないよう、列が無いと分かった時点でこのプロセス内では
// 以後 normalized_name を送らないようにフォールバックする。
let normalizedNameColumnAvailable = true

function isUndefinedColumnError(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null
  return e?.code === '42703' || e?.code === 'PGRST204' || (e?.message ?? '').includes('normalized_name')
}

function withNormalizedName(name: string): Record<string, unknown> {
  return normalizedNameColumnAvailable ? { normalized_name: normalizeCustomerName(name) } : {}
}

/** スタッフがQRスキャンしたとき、会員テーブルへ初回登録または名前更新 */
export async function upsertCustomer(userId: string, name: string): Promise<CustomerRow | null> {
  try {
    const { data: existing } = await supabase
      .from('customers')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    if (existing) {
      if ((existing as CustomerRow).name !== name) {
        const { error } = await supabase
          .from('customers')
          .update({ name, updated_at: new Date().toISOString(), ...withNormalizedName(name) })
          .eq('user_id', userId)
        if (error && isUndefinedColumnError(error)) {
          normalizedNameColumnAvailable = false
          await supabase
            .from('customers')
            .update({ name, updated_at: new Date().toISOString() })
            .eq('user_id', userId)
        }
      }
      return existing as CustomerRow
    }

    // 新規登録 — recovery_code 衝突時は最大5回リトライ
    for (let attempt = 0; attempt < 5; attempt++) {
      const recoveryCode = generateRecoveryCode()
      const { data, error } = await supabase
        .from('customers')
        .insert({ user_id: userId, name, recovery_code: recoveryCode, ...withNormalizedName(name) })
        .select()
        .single()
      if (!error && data) {
        const customer = data as CustomerRow
        // 初期エイリアス登録（非致命的）
        void supabase.from('customer_user_aliases').insert({
          customer_id: customer.id,
          user_id: userId,
          is_current: true,
        })
        return customer
      }
      if (error && isUndefinedColumnError(error)) {
        normalizedNameColumnAvailable = false
        continue // 同じattemptを normalized_name なしで再試行
      }
      if ((error as { code?: string })?.code !== '23505') break // 一意制約以外のエラーはリトライしない
    }
    return null
  } catch {
    return null
  }
}

/**
 * ゲスト顧客（QR未読み込み）を新規登録する。user_id は "guest-" prefix で自動生成。
 * 同姓同名の自動統合は行わない —
 * 呼び出し側（会計アシストUI）が既存候補を表示し、スタッフが選択した場合のみ既存顧客を使う。
 */
export async function createGuestCustomer(name: string): Promise<CustomerRow | null> {
  const trimmed = name.trim()
  if (!trimmed) return null
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const userId = generateGuestUserId()
      const recoveryCode = generateRecoveryCode()
      const { data, error } = await supabase
        .from('customers')
        .insert({ user_id: userId, name: trimmed, recovery_code: recoveryCode, ...withNormalizedName(trimmed) })
        .select()
        .single()
      if (!error && data) {
        const customer = data as CustomerRow
        void supabase.from('customer_user_aliases').insert({
          customer_id: customer.id,
          user_id: userId,
          is_current: true,
        })
        return customer
      }
      if (error && isUndefinedColumnError(error)) {
        normalizedNameColumnAvailable = false
        continue
      }
      if ((error as { code?: string })?.code !== '23505') break
    }
    return null
  } catch {
    return null
  }
}

/**
 * 正規化名が一致する既存顧客候補を検索する（会計アシストの「名前で紐付け」用）。
 * normalized_name 列が未適用の環境でも、name のあいまい検索＋クライアント側の
 * normalizeCustomerName 比較にフォールバックして動作する。
 */
export async function findCustomersByNormalizedName(name: string): Promise<CustomerRow[]> {
  const normalized = normalizeCustomerName(name)
  if (!normalized) return []

  if (normalizedNameColumnAvailable) {
    try {
      const { data, error } = await supabase
        .from('customers')
        .select('*')
        .eq('normalized_name', normalized)
        .order('updated_at', { ascending: false })
        .limit(10)
      if (!error) return (data ?? []) as CustomerRow[]
      if (isUndefinedColumnError(error)) {
        normalizedNameColumnAvailable = false
      } else {
        return []
      }
    } catch {
      return []
    }
  }

  // フォールバック：name のあいまい検索結果をクライアント側で正規化一致のみに絞る
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .ilike('name', `%${name.trim()}%`)
      .order('updated_at', { ascending: false })
      .limit(30)
    if (error || !data) return []
    return (data as CustomerRow[]).filter(c => normalizeCustomerName(c.name) === normalized)
  } catch {
    return []
  }
}

/** maintenance_visits から最終来店日を取得（候補カードの「前回来店」表示用） */
export async function getLastVisitDateForUser(userId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('maintenance_visits')
      .select('last_visit_date')
      .eq('user_id', userId)
      .maybeSingle()
    if (error || !data) return null
    return (data as { last_visit_date: string }).last_visit_date
  } catch {
    return null
  }
}

/** userId で会員レコードを取得 */
export async function getCustomerByUserId(userId: string): Promise<CustomerRow | null> {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()
    if (error || !data) return null
    return data as CustomerRow
  } catch {
    return null
  }
}

/** 名前で曖昧検索（スタッフ端末用） */
export async function searchCustomersByName(name: string): Promise<CustomerRow[]> {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .ilike('name', `%${name}%`)
      .order('updated_at', { ascending: false })
      .limit(20)
    if (error || !data) return []
    return data as CustomerRow[]
  } catch {
    return []
  }
}

export interface CustomerStats {
  total: number
  today: number
  thisMonth: number
}

/** JST基準の日付境界をISO文字列(UTC)で返す */
function jstBoundaryISO(jstDateStr: string): string {
  return new Date(`${jstDateStr}T00:00:00+09:00`).toISOString()
}

/**
 * 登録者数ダッシュボード用の集計（スタッフ端末専用）。
 * 現在の登録者数 / 本日登録数 / 今月登録数 を customers テーブルから count 取得する。
 */
export async function getCustomerStats(): Promise<CustomerStats> {
  const todayStr = getJapanDateString()
  const tomorrowStr = getJapanDateString(new Date(Date.now() + 24 * 60 * 60 * 1000))
  const [yearStr, monthStr] = todayStr.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr) // 1-indexed (1-12)
  const monthStartStr = `${yearStr}-${monthStr}-01`
  const nextMonthStr = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`

  try {
    const [totalRes, todayRes, monthRes] = await Promise.all([
      supabase.from('customers').select('*', { count: 'exact', head: true }),
      supabase.from('customers').select('*', { count: 'exact', head: true })
        .gte('created_at', jstBoundaryISO(todayStr))
        .lt('created_at', jstBoundaryISO(tomorrowStr)),
      supabase.from('customers').select('*', { count: 'exact', head: true })
        .gte('created_at', jstBoundaryISO(monthStartStr))
        .lt('created_at', jstBoundaryISO(nextMonthStr)),
    ])
    return {
      total: totalRes.count ?? 0,
      today: todayRes.count ?? 0,
      thisMonth: monthRes.count ?? 0,
    }
  } catch {
    return { total: 0, today: 0, thisMonth: 0 }
  }
}

/** recover_member RPC を呼び出す */
export async function recoverMember(
  oldUserId: string,
  newUserId: string,
  staffName: string,
  recoveryReason: string,
): Promise<{ success: true } | { error: string }> {
  try {
    const { data, error } = await supabase.rpc('recover_member', {
      p_old_user_id:     oldUserId,
      p_new_user_id:     newUserId,
      p_staff_name:      staffName,
      p_recovery_reason: recoveryReason,
    })
    if (error) return { error: error.message }
    const result = data as { success?: boolean; error?: string }
    if (result?.error) {
      return {
        error: result.error === 'customer_not_found'
          ? '会員が見つかりません。旧会員データが登録されていない可能性があります。'
          : result.error,
      }
    }
    return { success: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : '不明なエラーが発生しました。' }
  }
}
