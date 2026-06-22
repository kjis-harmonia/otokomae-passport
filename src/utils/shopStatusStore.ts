import { supabase } from '../lib/supabase'

export type ShopStatusValue = 'open' | 'closed'

export interface ShopStatusRow {
  id: string
  status: ShopStatusValue
  opened_at: string | null
  closed_at: string | null
  updated_at: string
}

const SHOP_STATUS_ID = 'main'

/**
 * 現在の営業状態を取得。id='main' の行が存在しない場合は
 * status='closed' の初期レコードを作成して返す（テーブル自体が無い場合はnull）。
 */
export async function getShopStatus(): Promise<ShopStatusRow | null> {
  try {
    const { data, error } = await supabase
      .from('shop_status')
      .select('*')
      .eq('id', SHOP_STATUS_ID)
      .maybeSingle()
    if (error) {
      console.error('[shopStatusStore] getShopStatus error:', error)
      return null
    }
    if (data) return data as ShopStatusRow

    // 行が存在しない場合は初期レコードを作成
    const { data: created, error: insertError } = await supabase
      .from('shop_status')
      .insert({ id: SHOP_STATUS_ID, status: 'closed' })
      .select()
      .single()
    if (insertError || !created) {
      console.error('[shopStatusStore] initial insert error:', insertError)
      return null
    }
    return created as ShopStatusRow
  } catch (e) {
    console.error('[shopStatusStore] getShopStatus exception:', e)
    return null
  }
}

/** 営業開始／営業終了をワンタップで切替（店舗全体のステータス、単一行 id='main'） */
export async function setShopStatus(status: ShopStatusValue): Promise<ShopStatusRow | null> {
  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { id: SHOP_STATUS_ID, status, updated_at: now }
  if (status === 'open') patch.opened_at = now
  if (status === 'closed') patch.closed_at = now

  try {
    const { data, error } = await supabase
      .from('shop_status')
      .upsert(patch, { onConflict: 'id' })
      .select()
      .single()
    if (error || !data) {
      console.error('[shopStatusStore] setShopStatus error:', error)
      return null
    }
    return data as ShopStatusRow
  } catch (e) {
    console.error('[shopStatusStore] setShopStatus exception:', e)
    return null
  }
}
