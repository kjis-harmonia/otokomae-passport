import { supabase } from '../lib/supabase'

// 銀二郎本部 — 在庫管理（Phase5-A）
// 会計アシストとの連携（在庫の自動引き落とし等）はまだ実装しない。

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
