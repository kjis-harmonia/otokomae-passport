import { buildTodayAggregates } from './hqDataStore'
import type { PaymentBreakdownEntry, RankingItem, StylistSummary } from './hqDataStore'
import { splitStockAlerts } from './hqInventoryStore'
import type { Product } from './hqInventoryStore'
import { callHqRpc } from './hqSession'
import { rpcErrorMessage } from '../utils/staffSession'

// 銀二郎本部 — 日報（Phase7）
// 営業終了時のみ生成。営業中は生成しない。日報一覧の取得はRealtime不要（表示時取得のみ）。
// セキュリティ監査対応：daily_reports・会計データは直接読み書きしない。
//   作成（本部画面の手動作成）：hq_daily_report_source → 集計 → hq_save_daily_report
//   一覧：hq_daily_reports（いずれも本部セッション必須）

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
  payment_summary: PaymentBreakdownEntry[]
  created_at: string
}

export interface GenerateDailyReportResult {
  ok: boolean
  report: DailyReport | null
  /** スタッフ端末に表示してよい程度に短い、人間向けの失敗理由（ok=falseの場合のみ）。 */
  errorMessage?: string
}

/**
 * その日のcompleted会計・在庫アラートを集計し、daily_reportsへupsertする（report_date一意）。
 * 既存の営業終了フロー（handleCloseShop）から呼ばれる想定。失敗してもこの関数自体は例外を
 * 投げず ok:false を返すだけなので、呼び出し側の営業終了処理自体はブロックしない。
 */
export async function generateAndSaveDailyReport(): Promise<GenerateDailyReportResult> {
  try {
    // 本日JSTの completed 会計・明細・在庫をサーバーから取得（日付はサーバー基準）
    const source = await callHqRpc<{
      report_date: string
      sessions: { id: string; total: number | null; stylist_name: string | null; payment_method: string | null }[]
      items: { item_name: string; category: string; quantity: number | null }[]
      products: Product[]
    }>('hq_daily_report_source')

    const agg = buildTodayAggregates(source.sessions ?? [], source.items ?? [])
    const products = (source.products ?? []).filter((p) => p.is_active !== false)
    const { reorder, low } = splitStockAlerts(products)

    const inventoryAlerts: InventoryAlertEntry[] = [
      ...reorder.map((p) => ({ name: p.name, status: 'reorder' as const, currentStock: p.current_stock, minStock: p.min_stock })),
      ...low.map((p) => ({ name: p.name, status: 'low' as const, currentStock: p.current_stock, minStock: p.min_stock })),
    ]

    const row = {
      total_sales: agg.todaySales,
      customer_count: agg.todayVisitors,
      average_spend: agg.todayUnitPrice,
      stylist_summary: agg.stylists,
      menu_summary: agg.menuRanking,
      retail_summary: agg.retailRanking.map((r) => ({ name: r.name, count: r.count })),
      inventory_alerts: inventoryAlerts,
      payment_summary: agg.paymentBreakdown,
    }

    // 会計データはあるはずなのに日報が空になる、といった原因追跡用に集計結果を必ずログ出力する。
    console.log('[hqDailyReportStore] generateAndSaveDailyReport: 集計結果', {
      reportDate: source.report_date,
      agg,
      productsCount: products.length,
      inventoryAlertsCount: inventoryAlerts.length,
    })

    const saved = await callHqRpc<DailyReport>('hq_save_daily_report', { p: row })
    return { ok: true, report: saved }
  } catch (e) {
    console.error('[hqDailyReportStore] generateAndSaveDailyReport failed:', e)
    return {
      ok: false,
      report: null,
      errorMessage: rpcErrorMessage(e, '日報の保存に失敗しました。'),
    }
  }
}

/** 日報一覧を新しい順に取得（最大30件）。Realtimeなし、表示時に毎回取得するだけ。 */
export async function getDailyReports(limit = 30): Promise<DailyReport[]> {
  try {
    return (await callHqRpc<DailyReport[] | null>('hq_daily_reports', { p_limit: limit })) ?? []
  } catch {
    return []
  }
}
