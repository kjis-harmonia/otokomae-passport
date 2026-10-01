/**
 * 会員データのアクセス（すべて Supabase RPC 経由）。
 *
 * - お客様アプリ：本人の user_id を指定する get_my_* RPC のみ
 * - 店舗端末：スタッフセッション付きの staff_* RPC
 * 書き込み（登録・復旧）は失敗時に例外／エラーを返し、成功扱いにしない。
 */

import type { TicketRow } from '../data/ticket'
import { supabase } from '../lib/supabase'
import { callStaffRpc, rpcErrorMessage } from './staffSession'
import { readAsCustomer } from './customerSession'
import { getJapanDateString } from './dateUtils'

// ── 移行期間（ステップB 適用前）に、顧客セッションの無い既存会員だけが使う直接読み取り ─────────────────────────

async function legacyReadLastVisit(userId: string): Promise<string | null> {
  const { data, error } = await supabase.from('maintenance_visits').select('last_visit_date').eq('user_id', userId).maybeSingle()
  if (error) throw error
  return (data?.last_visit_date as string | undefined) ?? null
}

async function legacyReadCustomer(userId: string): Promise<CustomerRow | null> {
  const { data, error } = await supabase.from('customers').select('*').eq('user_id', userId).maybeSingle()
  if (error) throw error
  return (data ?? null) as CustomerRow | null
}

async function legacyReadTodayUsage(userId: string): Promise<{ used_type: string | null }> {
  const { data, error } = await supabase
    .from('ticket_usage_logs')
    .select('ticket_type')
    .eq('user_id', userId)
    .eq('usage_date', getJapanDateString())
    .eq('status', 'used')
    .order('used_at', { ascending: true })
    .limit(1)
  if (error) throw error
  return { used_type: (data?.[0] as { ticket_type?: string } | undefined)?.ticket_type ?? null }
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

// ── 店舗端末 ──────────────────────────────────────────────────────────────────

/** 名前で曖昧検索（スタッフ端末用） */
export async function searchCustomersByName(name: string): Promise<CustomerRow[]> {
  try {
    return (await callStaffRpc<CustomerRow[] | null>('staff_search_customers', {
      p_query: name,
    })) ?? []
  } catch {
    return []
  }
}

/** 会員復旧（staff_recover_member RPC・1トランザクション） */
export async function recoverMember(
  oldUserId: string,
  newUserId: string,
  staffName: string,
  recoveryReason: string,
): Promise<{ success: true } | { error: string }> {
  try {
    await callStaffRpc('staff_recover_member', {
      p_old_user_id: oldUserId,
      p_new_user_id: newUserId,
      p_staff_name:  staffName,
      p_reason:      recoveryReason,
    })
    return { success: true }
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'customer_not_found') {
      return { error: '会員が見つかりません。旧会員データが登録されていない可能性があります。' }
    }
    if (code === 'invalid_new_user_id') return { error: '新しい端末のQRを読み取ってください。' }
    return { error: rpcErrorMessage(e, '復旧に失敗しました。通信環境を確認してください。') }
  }
}

// ── お客様アプリ・共通（本人の user_id 指定） ─────────────────────────────────

/** 最終来店日（YYYY-MM-DD）。未登録なら null。通信失敗時も null。 */
export async function getLastVisitDateForUser(userId: string): Promise<string | null> {
  try {
    const d = await readAsCustomer<string | null>('customer_get_last_visit', () => legacyReadLastVisit(userId))
    return d ? String(d).slice(0, 10) : null
  } catch {
    return null
  }
}

/**
 * 最終来店日。通信失敗を「来店記録なし」と区別したい画面用。
 * 戻り値：YYYY-MM-DD / null（記録なし）。通信失敗は例外。
 */
export async function fetchLastVisitDateStrict(userId: string): Promise<string | null> {
  const d = await readAsCustomer<string | null>('customer_get_last_visit', () => legacyReadLastVisit(userId))
  return d ? String(d).slice(0, 10) : null
}

/** userId で会員レコードを取得（本人の復旧コード表示用） */
export async function getCustomerByUserId(userId: string): Promise<CustomerRow | null> {
  try {
    return await readAsCustomer<CustomerRow | null>('customer_get_profile', () => legacyReadCustomer(userId))
  } catch {
    return null
  }
}

/** JST当日に使用済みの割引種別（未使用なら null） */
export async function fetchTodayUsedType(userId: string): Promise<string | null> {
  const r = await readAsCustomer<{ used_type: string | null }>('customer_get_today_usage', () => legacyReadTodayUsage(userId))
  return r?.used_type ?? null
}

// ── 店舗端末：会員QR読み取り時の一括取得 ───────────────────────────────────────

export interface StaffCustomerContext {
  customer:        CustomerRow | null
  last_visit_date: string | null
  days_remaining:  number | null
  today_used_type: string | null
  tickets:         TicketRow[]
}

/**
 * 会員登録（初回登録・名前更新）と、来店日・チケット・当日利用状況の取得を1回で行う。
 * 失敗時は例外（会員登録に失敗した状態で発行に進ませない）。
 */
export async function registerCustomerWithContext(userId: string, name: string): Promise<StaffCustomerContext> {
  const r = await callStaffRpc<StaffCustomerContext>('staff_register_customer', { p_user_id: userId, p_name: name })
  return {
    ...r,
    last_visit_date: r.last_visit_date ? String(r.last_visit_date).slice(0, 10) : null,
    tickets: r.tickets ?? [],
  }
}

/**
 * 店舗端末用：会員の情報（会員・最終来店日・当日利用・チケット）をスタッフ認証で取得。
 * お客様用の読み取り（顧客セッション）は店舗端末では使わない。
 */
export async function getCustomerContextForStaff(userId: string): Promise<StaffCustomerContext> {
  const r = await callStaffRpc<StaffCustomerContext>('staff_customer_context', { p_user_id: userId })
  return {
    ...r,
    last_visit_date: r.last_visit_date ? String(r.last_visit_date).slice(0, 10) : null,
    tickets: r.tickets ?? [],
  }
}

/** 店舗端末用：既存会員のアプリ紐付けコード（6桁・10分有効・1回限り）を発行 */
export async function issueBindCode(userId: string, staffName: string): Promise<{ code: string; expires_at: string }> {
  return callStaffRpc('staff_issue_bind_code', { p_user_id: userId, p_staff_name: staffName })
}
