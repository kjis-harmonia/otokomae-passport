import { supabase } from '../lib/supabase'

export type AccountingCategory = 'menu' | 'option' | 'retail'

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

/** 商品マスタ取得。activeOnly=true で有効商品のみ（会計選択UI用） */
export async function getAccountingItems(opts: { activeOnly?: boolean } = {}): Promise<AccountingItem[]> {
  try {
    let query = supabase.from('accounting_items').select('*')
    if (opts.activeOnly) query = query.eq('is_active', true)
    const { data, error } = await query.order('category').order('sort_order')
    if (error || !data) return []
    return data as AccountingItem[]
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

export interface CreateAccountingSessionInput {
  user_id: string | null
  customer_name: string | null
  staff_name: string
  stylist_name: string
  subtotal: number
  discount_total: number
  total: number
  used_ticket_ids: string[]
  items: AccountingSessionItemInput[]
}

/** 会計履歴を保存（会計完了ボタン押下時のみ呼ばれる） */
export async function createAccountingSession(input: CreateAccountingSessionInput): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('accounting_sessions')
      .insert({
        user_id: input.user_id,
        customer_name: input.customer_name,
        staff_name: input.staff_name,
        stylist_name: input.stylist_name,
        subtotal: input.subtotal,
        discount_total: input.discount_total,
        total: input.total,
        used_ticket_ids: input.used_ticket_ids,
      })
      .select()
      .single()
    if (error || !data) return null
    const sessionId = (data as { id: string }).id

    if (input.items.length > 0) {
      await supabase.from('accounting_session_items').insert(
        input.items.map(it => ({
          session_id: sessionId,
          item_id: it.item_id,
          item_name: it.item_name,
          category: it.category,
          price: it.price,
          quantity: it.quantity ?? 1,
        })),
      )
    }
    return sessionId
  } catch {
    return null
  }
}
