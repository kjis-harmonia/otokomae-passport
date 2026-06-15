import { supabase } from '../lib/supabase'

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
  phone_last4: string | null
  recovery_code: string
  created_at: string
  updated_at: string
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
        await supabase
          .from('customers')
          .update({ name, updated_at: new Date().toISOString() })
          .eq('user_id', userId)
      }
      return existing as CustomerRow
    }

    // 新規登録 — recovery_code 衝突時は最大5回リトライ
    for (let attempt = 0; attempt < 5; attempt++) {
      const recoveryCode = generateRecoveryCode()
      const { data, error } = await supabase
        .from('customers')
        .insert({ user_id: userId, name, recovery_code: recoveryCode })
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
      if ((error as { code?: string })?.code !== '23505') break // 一意制約以外のエラーはリトライしない
    }
    return null
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
