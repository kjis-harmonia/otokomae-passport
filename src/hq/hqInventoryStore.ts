import { REALTIME_SUBSCRIBE_STATES } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { callStoreOrHqRpc, getDataAuthMode } from '../utils/dataAuthMode'

// 銀二郎本部 — 在庫管理（Phase5-A）
//
// セキュリティ監査対応：products は直接書き込み不可。
//   本部画面 → hq_product_* / 店舗端末 → staff_product_*（どちらも同じ処理）。
//   お客様アプリ（SHOP タブ）→ 店販・販売中の商品だけ公開読み取り（表示に必要な列のみ）。

export const PRODUCT_CATEGORIES = ['店販', 'パーマ液', 'カラー剤', '消耗品', '備品'] as const
export type ProductCategory = typeof PRODUCT_CATEGORIES[number]

export interface Product {
  id: string
  name: string
  category: ProductCategory
  is_active: boolean
  current_stock: number
  min_stock: number
  // price / accounting_group: category='店販'の商品の価格とサブカテゴリー
  // （スタイリング剤／シャンプー・ケア／その他）。お客様アプリの SHOP 表示に使う。店販以外では使用しない。
  price: number
  accounting_group: string | null
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

/** products から 要発注(reorder) / 少ない(low) 商品を抜き出す共通ロジック。 */
export function splitStockAlerts(products: Product[]): { reorder: Product[]; low: Product[] } {
  const reorder: Product[] = []
  const low: Product[] = []
  for (const p of products) {
    const status = getStockStatus(p.current_stock, p.min_stock)
    if (status === 'reorder') reorder.push(p)
    else if (status === 'low') low.push(p)
  }
  return { reorder, low }
}

const PUBLIC_SHOP_COLUMNS = 'id, name, category, is_active, current_stock, price, accounting_group, created_at, updated_at'

function normalizeProducts(rows: Product[]): Product[] {
  return rows
    .filter((p) => p.is_active !== false)
    .map((p) => ({
      ...p,
      min_stock: p.min_stock ?? 0,
      category: (PRODUCT_CATEGORIES as readonly string[]).includes(p.category) ? p.category : '店販',
    }))
}

/**
 * 在庫一覧取得。is_active=false の商品のみ除外する（論理削除済み）。
 * is_active が null/未設定の行（想定外データ）は非表示にせず表示する側に倒す。
 * category が未設定/不明な値の行も、不明カテゴリーのまま落とさず「店販」にフォールバックする
 * （PRODUCT_CATEGORIES のタブ分けに乗らない値だと、どのタブにも出ず一覧から消えてしまうため）。
 *
 * 本部画面・店舗端末：全カテゴリー（RPC）。お客様アプリ：店販のみ（公開読み取り・最低在庫数は含まない）。
 */
export async function getProducts(): Promise<Product[]> {
  try {
    if (getDataAuthMode() === 'customer') {
      const { data, error } = await supabase
        .from('products')
        .select(PUBLIC_SHOP_COLUMNS)
        .eq('category', '店販')
        .order('name', { ascending: true })
      if (error || !data) return []
      return normalizeProducts(data as unknown as Product[])
    }
    const rows = await callStoreOrHqRpc<Product[] | null>('staff_products_list', 'hq_products_list')
    return normalizeProducts(rows ?? [])
  } catch {
    return []
  }
}

/** 商品追加。失敗時は null（成功扱いにしない）。 */
export async function createProduct(input: {
  name: string
  category: ProductCategory
  currentStock: number
  minStock: number
  price?: number
  accountingGroup?: string | null
}): Promise<Product | null> {
  try {
    return await callStoreOrHqRpc<Product>('staff_product_create', 'hq_product_create', {
      p: {
        name: input.name,
        category: input.category,
        current_stock: input.currentStock,
        min_stock: input.minStock,
        price: input.price ?? 0,
        accounting_group: input.accountingGroup?.trim() || null,
      },
    })
  } catch (e) {
    console.error('[hqInventoryStore] createProduct failed', e)
    return null
  }
}

/** 商品更新（指定した項目のみ）。失敗時は null（成功扱いにしない）。 */
export async function updateProduct(
  id: string,
  patch: { name?: string; category?: ProductCategory; minStock?: number; price?: number; accountingGroup?: string | null },
): Promise<Product | null> {
  const p: Record<string, unknown> = {}
  if (patch.name !== undefined) p.name = patch.name
  if (patch.category !== undefined) p.category = patch.category
  if (patch.minStock !== undefined) p.min_stock = patch.minStock
  if (patch.price !== undefined) p.price = patch.price
  if (patch.accountingGroup !== undefined) p.accounting_group = patch.accountingGroup?.trim() || null
  try {
    return await callStoreOrHqRpc<Product>('staff_product_update', 'hq_product_update', { p_id: id, p })
  } catch (e) {
    console.error('[hqInventoryStore] updateProduct failed', e)
    return null
  }
}

/** 論理削除（is_active=false）。過去の会計履歴・日報との整合性のため物理削除はしない。失敗時は false。 */
export async function deleteProduct(id: string): Promise<boolean> {
  try {
    await callStoreOrHqRpc('staff_product_delete', 'hq_product_delete', { p_id: id })
    return true
  } catch (e) {
    console.error('[hqInventoryStore] deleteProduct failed', e)
    return false
  }
}

export type HqInventoryRealtimeStatus = 'connecting' | 'live' | 'error'

/** 在庫一覧の再取得間隔。products は店舗・本部向けの行・列が非公開になり Realtime では
 *  全件の変更を受け取れないため、定期取得で補う（SHOP 表示用の店販は Realtime でも届く）。 */
const PRODUCTS_POLL_MS = 20_000

/**
 * products の変更（会計確定による自動減算、本部・店舗からの CRUD 操作）を検知して onChange を呼ぶ。
 * 店販の公開行は Realtime、それ以外は定期取得で検知する。購読失敗でも画面は壊さない。
 */
export function subscribeProductsRealtime(
  onChange: () => void,
  onStatus?: (status: HqInventoryRealtimeStatus) => void,
): () => void {
  const timer = window.setInterval(() => onChange(), PRODUCTS_POLL_MS)
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
          // Realtime が使えなくても定期取得で最新化されるため、表示は live 扱いのままにする
          onStatus?.(getDataAuthMode() === 'customer' ? 'error' : 'live')
        }
      })
    return () => { window.clearInterval(timer); void supabase.removeChannel(channel) }
  } catch (e) {
    console.error('[hqInventoryStore] subscribeProductsRealtime exception:', e)
    onStatus?.('error')
    return () => { window.clearInterval(timer) }
  }
}

/** 在庫増減。delta は正負どちらも可。結果が0未満になる場合は0でクランプする（サーバー側）。失敗時は null。 */
export async function adjustProductStock(id: string, delta: number): Promise<Product | null> {
  try {
    return await callStoreOrHqRpc<Product>('staff_product_adjust', 'hq_product_adjust', { p_id: id, p_delta: delta })
  } catch (e) {
    console.error('[hqInventoryStore] adjustProductStock failed', e)
    return null
  }
}
