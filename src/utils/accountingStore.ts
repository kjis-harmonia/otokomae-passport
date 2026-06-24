import { supabase } from '../lib/supabase'

export type AccountingCategory = 'menu' | 'option' | 'retail'

// 店販(retail)は銀二郎本部 products（category='店販'）を正として扱うようになったため、
// accounting_items は menu / option 専用。既存の retail 行・retail_group 列はDBに残るが
// （既存データは削除しない方針）、このストア／会計アシストUIからは読み書きしない。
export interface AccountingItem {
  id: string
  name: string
  category: AccountingCategory
  price: number
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

/** 商品マスタ取得。activeOnly=true で有効商品のみ（会計選択UI用）。is_active が null/未設定の行は非表示にしない。 */
export async function getAccountingItems(opts: { activeOnly?: boolean } = {}): Promise<AccountingItem[]> {
  try {
    const { data, error } = await supabase.from('accounting_items').select('*').order('category').order('sort_order')
    if (error || !data) return []
    const items = data as AccountingItem[]
    return opts.activeOnly ? items.filter((i) => i.is_active !== false) : items
  } catch {
    return []
  }
}

export async function createAccountingItem(input: {
  name: string
  category: AccountingCategory
  price: number
  sort_order?: number
}): Promise<AccountingItem | null> {
  try {
    const { data, error } = await supabase
      .from('accounting_items')
      .insert({
        name: input.name,
        category: input.category,
        price: input.price,
        sort_order: input.sort_order ?? 0,
      })
      .select()
      .single()
    if (error || !data) return null
    return data as AccountingItem
  } catch {
    return null
  }
}

export async function updateAccountingItem(
  id: string,
  patch: Partial<Pick<AccountingItem, 'name' | 'price' | 'category' | 'is_active' | 'sort_order'>>,
): Promise<AccountingItem | null> {
  try {
    const { data, error } = await supabase
      .from('accounting_items')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error || !data) return null
    return data as AccountingItem
  } catch {
    return null
  }
}

export interface AccountingSessionItemInput {
  item_id: string | null
  item_name: string
  category: AccountingCategory
  price: number
  quantity?: number
}

export type AccountingSessionStatus = 'pending' | 'completed' | 'failed'

export type PaymentMethod = 'cash' | 'credit' | 'qr'

export interface CreateAccountingSessionInput {
  user_id: string | null
  customer_name: string | null
  staff_name: string
  stylist_name: string
  payment_method: PaymentMethod
  subtotal: number
  discount_total: number
  total: number
  used_ticket_ids: string[]
  items: AccountingSessionItemInput[]
}

export interface CreateAccountingSessionResult {
  sessionId: string | null
  ok: boolean
}

/**
 * 会計履歴を保存（status='pending' で作成）。
 * チケットused化等より必ず先に呼ぶこと —
 * 「チケットだけ使用済みになり会計履歴が残らない」事故を防ぐための順序。
 * accounting_session_items の保存に失敗した場合は status='failed' にして ok:false を返す
 * （sessionId 自体は返すので、呼び出し側は会計IDを案内できる）。
 */
/** Supabaseのエラーオブジェクトをconsole.errorへ詳細出力する（調査用。挙動は変えない）。 */
function logSupabaseError(step: string, error: unknown, context?: Record<string, unknown>): void {
  const e = error as { message?: string; details?: string; hint?: string; code?: string } | null
  console.error(`[accountingStore] ${step} failed`, {
    message: e?.message,
    details: e?.details,
    hint: e?.hint,
    code: e?.code,
    raw: error,
    context,
  })
}

export async function createAccountingSession(input: CreateAccountingSessionInput): Promise<CreateAccountingSessionResult> {
  try {
    const { data, error } = await supabase
      .from('accounting_sessions')
      .insert({
        user_id: input.user_id,
        customer_name: input.customer_name,
        staff_name: input.staff_name,
        stylist_name: input.stylist_name,
        payment_method: input.payment_method,
        status: 'pending',
        subtotal: input.subtotal,
        discount_total: input.discount_total,
        total: input.total,
        used_ticket_ids: input.used_ticket_ids,
      })
      .select()
      .single()
    if (error || !data) {
      logSupabaseError('createAccountingSession: accounting_sessions insert', error, {
        payment_method: input.payment_method,
        subtotal: input.subtotal,
        discount_total: input.discount_total,
        total: input.total,
        user_id: input.user_id,
      })
      return { sessionId: null, ok: false }
    }
    const sessionId = (data as { id: string }).id

    if (input.items.length > 0) {
      const itemRows = input.items.map(it => ({
        session_id: sessionId,
        item_id: it.item_id,
        item_name: it.item_name,
        category: it.category,
        price: it.price,
        quantity: it.quantity ?? 1,
      }))
      const { error: itemsError } = await supabase.from('accounting_session_items').insert(itemRows)
      if (itemsError) {
        logSupabaseError('createAccountingSession: accounting_session_items insert', itemsError, {
          sessionId, itemRows,
        })
        await setAccountingSessionStatus(sessionId, 'failed')
        return { sessionId, ok: false }
      }
    }
    return { sessionId, ok: true }
  } catch (e) {
    logSupabaseError('createAccountingSession: unexpected exception', e, { input })
    return { sessionId: null, ok: false }
  }
}

/** 会計完了処理の各段階で pending → completed / failed を反映する */
export async function setAccountingSessionStatus(sessionId: string, status: AccountingSessionStatus): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('accounting_sessions')
      .update({ status })
      .eq('id', sessionId)
    if (error) {
      logSupabaseError('setAccountingSessionStatus: accounting_sessions update', error, { sessionId, status })
      return false
    }
    return true
  } catch (e) {
    logSupabaseError('setAccountingSessionStatus: unexpected exception', e, { sessionId, status })
    return false
  }
}
