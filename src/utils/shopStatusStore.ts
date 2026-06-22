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

export async function getShopStatus(): Promise<ShopStatusRow | null> {
  try {
    const { data, error } = await supabase
      .from('shop_status')
      .select('*')
      .eq('id', SHOP_STATUS_ID)
      .maybeSingle()
    if (error || !data) return null
    return data as ShopStatusRow
  } catch {
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
    if (error || !data) return null
    return data as ShopStatusRow
  } catch {
    return null
  }
}
