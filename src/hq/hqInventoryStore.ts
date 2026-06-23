import { REALTIME_SUBSCRIBE_STATES } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

// 銀二郎本部 — 在庫管理（Phase5-A）
// Phase5-Bで会計アシストとの連携（店販販売による在庫の自動引き落とし）を追加。

export interface Product {
  id: string
  name: string
  current_stock: number
  min_stock: number
  created_at: string
  updated_at: string
}

export type StockStatus = 'ok' | 'low' | 'reorder'

/** 在庫状態を判定。current_stock <= min_stock は要発注、その1.5倍以内は少ない、それ以外は正常。 */
export function getStockStatus(currentStock: number, minStock: number): StockStatus {
  if (currentStock <= minStock) return 'reorder'
  if (minStock > 0 && currentStock <= minStock * 1.5) return 'low'
  return 'ok'
}

export async function getProducts(): Promise<Product[]> {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('name', { ascending: true })
    if (error || !data) return []
    return data as Product[]
  } catch {
    return []
  }
}

export async function createProduct(input: {
  name: string
  currentStock: number
  minStock: number
}): Promise<Product | null> {
  try {
    const { data, error } = await supabase
      .from('products')
      .insert({
        name: input.name,
        current_stock: input.currentStock,
        min_stock: input.minStock,
      })
      .select()
      .single()
    if (error || !data) return null
    return data as Product
  } catch {
    return null
  }
}

export async function updateProduct(
  id: string,
  patch: { name?: string; minStock?: number },
): Promise<Product | null> {
  try {
    const dbPatch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (patch.name !== undefined) dbPatch.name = patch.name
    if (patch.minStock !== undefined) dbPatch.min_stock = patch.minStock

    const { data, error } = await supabase
      .from('products')
      .update(dbPatch)
      .eq('id', id)
      .select()
      .single()
    if (error || !data) return null
    return data as Product
  } catch {
    return null
  }
}

export type HqInventoryRealtimeStatus = 'connecting' | 'live' | 'error'

/**
 * products テーブルの変更（会計アシストからの自動減算、本部からのCRUD操作）を
 * リアルタイム購読する。在庫管理タブの再読み込みトリガー用。
 * 購読が確立／切断・失敗した場合は onStatus で通知し、画面は壊さない。
 */
export function subscribeProductsRealtime(
  onChange: () => void,
  onStatus?: (status: HqInventoryRealtimeStatus) => void,
): () => void {
  try {
    const channel = supabase
      .channel('hq-inventory-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => onChange())
      .subscribe((status) => {
        if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
          onStatus?.('live')
        } else if (
          status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
          status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT ||
          status === REALTIME_SUBSCRIBE_STATES.CLOSED
        ) {
          onStatus?.('error')
        }
      })
    return () => { void supabase.removeChannel(channel) }
  } catch (e) {
    console.error('[hqInventoryStore] subscribeProductsRealtime exception:', e)
    onStatus?.('error')
    return () => {}
  }
}

export interface RetailSaleItem {
  itemName: string
  quantity: number
}

/**
 * 会計アシストで販売された店販商品（accounting_session_items の category='retail'）分だけ
 * products.current_stock を減算する（Phase5-B）。
 *
 * - item_name と products.name の完全一致でのみ照合する。一致する商品が無い場合は会計自体を
 *   止めず、console.warn で控えめにログを残すのみ（在庫未連携の商品として扱う）。
 * - 一致する商品があるのに更新自体（DBアクセス）が失敗した場合のみ anyFailure=true を返す。
 *   呼び出し側（会計アシスト）はこの場合のみ「在庫更新に失敗しました」をスタッフに表示する。
 * - 在庫は0未満にならない（adjustProductStock側でクランプ済み）。
 */
export async function deductStockForRetailSale(soldItems: RetailSaleItem[]): Promise<{ anyFailure: boolean }> {
  if (soldItems.length === 0) return { anyFailure: false }

  try {
    const products = await getProducts()
    let anyFailure = false

    for (const sold of soldItems) {
      const product = products.find((p) => p.name === sold.itemName)
      if (!product) {
        console.warn(`[hqInventoryStore] 在庫連携: products に該当する商品が見つかりません（item_name="${sold.itemName}"）。在庫は更新されません。`)
        continue
      }
      const updated = await adjustProductStock(product.id, -sold.quantity)
      if (!updated) {
        console.warn(`[hqInventoryStore] 在庫連携: 在庫更新に失敗しました（product="${product.name}"）。`)
        anyFailure = true
      }
    }

    return { anyFailure }
  } catch (e) {
    console.error('[hqInventoryStore] deductStockForRetailSale exception:', e)
    return { anyFailure: true }
  }
}

/** 在庫増減。delta は正負どちらも可。結果が0未満になる場合は0でクランプする。 */
export async function adjustProductStock(id: string, delta: number): Promise<Product | null> {
  try {
    const { data: current, error: fetchError } = await supabase
      .from('products')
      .select('current_stock')
      .eq('id', id)
      .single()
    if (fetchError || !current) return null

    const nextStock = Math.max(0, (current.current_stock ?? 0) + delta)

    const { data, error } = await supabase
      .from('products')
      .update({ current_stock: nextStock, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error || !data) return null
    return data as Product
  } catch {
    return null
  }
}
