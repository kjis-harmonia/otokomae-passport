import { supabase } from '../lib/supabase'

export type AccountingCategory = 'menu' | 'option' | 'retail'

export interface AccountingItem {
  id: string
  name: string
  category: AccountingCategory
  // retail_group: 店販(retail)商品の選択UI用サブカテゴリー（例：スタイリング剤、シャンプー・ケア）。
  // menu/optionでは使用しない。固定enumではなく自由入力 — 新カテゴリーは商品マスタ管理で
  // 文字列を入力するだけで増やせる（コード変更不要）。
  retail_group: string | null
  price: number
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

/**
 * 商品マスタ取得。activeOnly=true で有効商品のみ（会計選択UI用）。
 * is_active が null/未設定の行は非表示にせず表示する側に倒す
 * （retail_group・price が null/未設定の行も対象外にはしない —
 * それぞれUI側で「その他」「¥0」にフォールバックする）。
 */
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

// accounting_items.retail_group は追加マイグレーション（schema.sql参照）が必要な列。
// 未適用環境でも商品マスタの追加・編集が壊れないよう、列が無いと分かった時点でこの
// プロセス内では以後 retail_group を送らないようにフォールバックする
// （customerStore.ts の normalized_name と同じ防御パターン）。
let retailGroupColumnAvailable = true

function isUndefinedColumnError(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null
  return e?.code === '42703' || e?.code === 'PGRST204' || (e?.message ?? '').includes('retail_group')
}

export async function createAccountingItem(input: {
  name: string
  category: AccountingCategory
  price: number
  retailGroup?: string | null
  sort_order?: number
}): Promise<AccountingItem | null> {
  try {
    const retailGroup = input.category === 'retail' ? (input.retailGroup?.trim() || null) : null
    const basePayload = {
      name: input.name,
      category: input.category,
      price: input.price,
      sort_order: input.sort_order ?? 0,
    }
    const payload = retailGroupColumnAvailable ? { ...basePayload, retail_group: retailGroup } : basePayload
    const { data, error } = await supabase.from('accounting_items').insert(payload).select().single()
    if (!error && data) return data as AccountingItem
    if (error && retailGroupColumnAvailable && isUndefinedColumnError(error)) {
      retailGroupColumnAvailable = false
      const { data: retryData, error: retryError } = await supabase
        .from('accounting_items').insert(basePayload).select().single()
      if (retryError || !retryData) return null
      return retryData as AccountingItem
    }
    return null
  } catch {
    return null
  }
}

export async function updateAccountingItem(
  id: string,
  patch: Partial<Pick<AccountingItem, 'name' | 'price' | 'category' | 'is_active' | 'sort_order' | 'retail_group'>>,
): Promise<AccountingItem | null> {
  try {
    const { retail_group, ...rest } = patch
    const fullPatch = { ...rest, updated_at: new Date().toISOString() }
    const payload = retailGroupColumnAvailable && retail_group !== undefined
      ? { ...fullPatch, retail_group }
      : fullPatch

    const { data, error } = await supabase.from('accounting_items').update(payload).eq('id', id).select().single()
    if (!error && data) return data as AccountingItem
    if (error && retailGroupColumnAvailable && isUndefinedColumnError(error)) {
      retailGroupColumnAvailable = false
      const { data: retryData, error: retryError } = await supabase
        .from('accounting_items').update(fullPatch).eq('id', id).select().single()
      if (retryError || !retryData) return null
      return retryData as AccountingItem
    }
    return null
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
    if (error || !data) return { sessionId: null, ok: false }
    const sessionId = (data as { id: string }).id

    if (input.items.length > 0) {
      const { error: itemsError } = await supabase.from('accounting_session_items').insert(
        input.items.map(it => ({
          session_id: sessionId,
          item_id: it.item_id,
          item_name: it.item_name,
          category: it.category,
          price: it.price,
          quantity: it.quantity ?? 1,
        })),
      )
      if (itemsError) {
        await setAccountingSessionStatus(sessionId, 'failed')
        return { sessionId, ok: false }
      }
    }
    return { sessionId, ok: true }
  } catch {
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
    return !error
  } catch {
    return false
  }
}
