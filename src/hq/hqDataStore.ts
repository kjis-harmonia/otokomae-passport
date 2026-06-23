import { supabase } from '../lib/supabase'
import { getJapanDateString } from '../utils/dateUtils'
import { getShopStatus } from '../utils/shopStatusStore'
import type { ShopStatusValue } from '../utils/shopStatusStore'

// 銀二郎本部 — 経営ダッシュボード実データ集計
// accounting_sessions / accounting_session_items の status='completed' のみを集計対象とする。

export type StylistKey = 'テイテイ' | '銀二郎' | 'フリー' | '未設定'

const STYLISTS: StylistKey[] = ['テイテイ', '銀二郎', 'フリー', '未設定']

export interface StylistSummary {
  name: StylistKey
  sales: number
  visitors: number
  unitPrice: number
}

export interface RankingItem {
  rank: number
  name: string
  count: number
}

export interface HqDashboardData {
  todaySales: number
  todayVisitors: number
  todayUnitPrice: number
  monthSales: number
  shopStatus: ShopStatusValue | null
  stylists: StylistSummary[]
  menuRanking: RankingItem[]
  retailRanking: RankingItem[]
}

function jstBoundaryISO(jstDateStr: string): string {
  return new Date(`${jstDateStr}T00:00:00+09:00`).toISOString()
}

function monthRangeFromToday(todayStr: string): { start: string; end: string } {
  const [yearStr, monthStr] = todayStr.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr) // 1-indexed
  const start = `${yearStr}-${monthStr}-01`
  const end = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`
  return { start, end }
}

function groupAndCount(items: { item_name: string; quantity: number | null }[]): RankingItem[] {
  const counts = new Map<string, number>()
  for (const it of items) {
    const qty = it.quantity ?? 1
    counts.set(it.item_name, (counts.get(it.item_name) ?? 0) + qty)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count], i) => ({ rank: i + 1, name, count }))
}

/**
 * 経営ダッシュボード用の集計データを取得する。
 * Supabase エラー時は throw せず、呼び出し側がエラーメッセージを表示できるよう例外を投げる。
 */
export async function getHqDashboardData(): Promise<HqDashboardData> {
  const todayStr = getJapanDateString()
  const tomorrowStr = getJapanDateString(new Date(Date.now() + 24 * 60 * 60 * 1000))
  const { start: monthStartStr, end: monthEndStr } = monthRangeFromToday(todayStr)

  const [todayRes, monthRes, shopStatusRow] = await Promise.all([
    supabase
      .from('accounting_sessions')
      .select('id, total, stylist_name')
      .eq('status', 'completed')
      .gte('created_at', jstBoundaryISO(todayStr))
      .lt('created_at', jstBoundaryISO(tomorrowStr)),
    supabase
      .from('accounting_sessions')
      .select('total', { count: 'exact' })
      .eq('status', 'completed')
      .gte('created_at', jstBoundaryISO(monthStartStr))
      .lt('created_at', jstBoundaryISO(monthEndStr)),
    getShopStatus(),
  ])

  if (todayRes.error) throw todayRes.error
  if (monthRes.error) throw monthRes.error

  const todaySessions = todayRes.data ?? []
  const monthSessions = monthRes.data ?? []

  const todaySales = todaySessions.reduce((sum, s) => sum + (s.total ?? 0), 0)
  const todayVisitors = todaySessions.length
  const todayUnitPrice = todayVisitors > 0 ? Math.round(todaySales / todayVisitors) : 0
  const monthSales = monthSessions.reduce((sum, s) => sum + (s.total ?? 0), 0)

  const stylists: StylistSummary[] = STYLISTS.map((name) => {
    const rows = todaySessions.filter((s) => (s.stylist_name || '未設定') === name)
    const sales = rows.reduce((sum, s) => sum + (s.total ?? 0), 0)
    const visitors = rows.length
    return {
      name,
      sales,
      visitors,
      unitPrice: visitors > 0 ? Math.round(sales / visitors) : 0,
    }
  })

  const sessionIds = todaySessions.map((s) => s.id)
  let menuRanking: RankingItem[] = []
  let retailRanking: RankingItem[] = []

  if (sessionIds.length > 0) {
    const itemsRes = await supabase
      .from('accounting_session_items')
      .select('item_name, category, quantity')
      .in('session_id', sessionIds)
      .in('category', ['menu', 'retail'])

    if (itemsRes.error) throw itemsRes.error

    const items = itemsRes.data ?? []
    menuRanking = groupAndCount(items.filter((it) => it.category === 'menu')).slice(0, 5)
    retailRanking = groupAndCount(items.filter((it) => it.category === 'retail'))
  }

  return {
    todaySales,
    todayVisitors,
    todayUnitPrice,
    monthSales,
    shopStatus: shopStatusRow?.status ?? null,
    stylists,
    menuRanking,
    retailRanking,
  }
}
