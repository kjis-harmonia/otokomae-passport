import { supabase } from '../lib/supabase'
import { getJapanDateString } from '../utils/dateUtils'
import { getHqDashboardData } from './hqDataStore'
import type { RankingItem, StylistSummary } from './hqDataStore'
import { getProducts, splitStockAlerts } from './hqInventoryStore'

// 銀二郎本部 — 日報（Phase7）
// 営業終了時のみ生成。営業中は生成しない。日報一覧の取得はRealtime不要（表示時取得のみ）。

export interface InventoryAlertEntry {
  name: string
  status: 'reorder' | 'low'
  currentStock: number
  minStock: number
}

export interface DailyReport {
  id: string
  report_date: string // YYYY-MM-DD
  total_sales: number
  customer_count: number
  average_spend: number
  stylist_summary: StylistSummary[]
  menu_summary: RankingItem[]
  retail_summary: { name: string; count: number }[]
  inventory_alerts: InventoryAlertEntry[]
  created_at: string
}

/**
 * その日のcompleted会計・在庫アラートを集計し、daily_reportsへupsertする（report_date一意）。
 * 既存の営業終了フロー（handleCloseShop）から呼ばれる想定。失敗してもnullを返すだけで、
 * 呼び出し側の営業終了処理自体はブロックしない。
 */
export async function generateAndSaveDailyReport(): Promise<DailyReport | null> {
  try {
    const reportDate = getJapanDateString()
    const dashboard = await getHqDashboardData()
    const products = await getProducts()
    const { reorder, low } = splitStockAlerts(products)

    const inventoryAlerts: InventoryAlertEntry[] = [
      ...reorder.map((p) => ({ name: p.name, status: 'reorder' as const, currentStock: p.current_stock, minStock: p.min_stock })),
      ...low.map((p) => ({ name: p.name, status: 'low' as const, currentStock: p.current_stock, minStock: p.min_stock })),
    ]

    const row = {
      report_date: reportDate,
      total_sales: dashboard.todaySales,
      customer_count: dashboard.todayVisitors,
      average_spend: dashboard.todayUnitPrice,
      stylist_summary: dashboard.stylists,
      menu_summary: dashboard.menuRanking,
      retail_summary: dashboard.retailRanking.map((r) => ({ name: r.name, count: r.count })),
      inventory_alerts: inventoryAlerts,
    }

    const { data, error } = await supabase
      .from('daily_reports')
      .upsert(row, { onConflict: 'report_date' })
      .select()
      .single()
    if (error || !data) {
      console.error('[hqDailyReportStore] generateAndSaveDailyReport upsert error:', error)
      return null
    }
    return data as DailyReport
  } catch (e) {
    console.error('[hqDailyReportStore] generateAndSaveDailyReport exception:', e)
    return null
  }
}

/** 日報一覧を新しい順に取得（最大30件）。Realtimeなし、表示時に毎回取得するだけ。 */
export async function getDailyReports(limit = 30): Promise<DailyReport[]> {
  try {
    const { data, error } = await supabase
      .from('daily_reports')
      .select('*')
      .order('report_date', { ascending: false })
      .limit(limit)
    if (error || !data) return []
    return data as DailyReport[]
  } catch {
    return []
  }
}
