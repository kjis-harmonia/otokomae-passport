import { getJapanDateString } from '../utils/dateUtils'
import { callHqRpc } from './hqSession'

// 銀二郎本部 — 経営ダッシュボード実データ集計
// accounting_sessions / accounting_session_items の status='completed' のみを集計対象とする。
// セキュリティ監査対応：会計データはテーブルを直接読まず、本部セッション必須の RPC
// （hq_accounting_sessions / hq_accounting_session_items）経由で取得する。

/** 支払い方法（過去の会計データの payment_method） */
export type PaymentMethod = 'cash' | 'credit' | 'qr'

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

export interface PaymentBreakdownEntry {
  method: PaymentMethod
  label: string
  total: number
}

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: '現金',
  credit: 'クレジット',
  qr: 'QR',
}

const PAYMENT_METHODS: PaymentMethod[] = ['cash', 'credit', 'qr']

function buildPaymentBreakdown(sessions: { payment_method?: string | null; total: number | null }[]): PaymentBreakdownEntry[] {
  return PAYMENT_METHODS.map((method) => ({
    method,
    label: PAYMENT_METHOD_LABELS[method],
    total: sessions
      .filter((s) => s.payment_method === method)
      .reduce((sum, s) => sum + (s.total ?? 0), 0),
  }))
}

export interface HqDashboardData {
  todaySales: number
  todayVisitors: number
  todayUnitPrice: number
  monthSales: number
  stylists: StylistSummary[]
  menuRanking: RankingItem[]
  retailRanking: RankingItem[]
  paymentBreakdown: PaymentBreakdownEntry[]
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

/** 本部 RPC が返す completed 会計 */
export interface HqSessionRow {
  id: string
  user_id: string | null
  total: number | null
  stylist_name: string | null
  staff_name: string | null
  payment_method: string | null
  created_at: string
}

export interface HqSessionItemRow {
  session_id?: string
  item_name: string
  category: string
  quantity: number | null
}

/** completed 会計（期間 [fromJst, toJst) ・会員で絞り込み可）。失敗時は例外。 */
export async function fetchHqSessions(opts: { fromJst?: string; toJst?: string; userId?: string } = {}): Promise<HqSessionRow[]> {
  return (await callHqRpc<HqSessionRow[] | null>('hq_accounting_sessions', {
    p_from: opts.fromJst ? jstBoundaryISO(opts.fromJst) : null,
    p_to: opts.toJst ? jstBoundaryISO(opts.toJst) : null,
    p_user_id: opts.userId ?? null,
  })) ?? []
}

/** 会計明細（指定した会計ID分）。失敗時は例外。 */
export async function fetchHqSessionItems(sessionIds: string[]): Promise<HqSessionItemRow[]> {
  if (sessionIds.length === 0) return []
  return (await callHqRpc<HqSessionItemRow[] | null>('hq_accounting_session_items', { p_session_ids: sessionIds })) ?? []
}

/** 当日分の会計・明細からダッシュボード／日報の共通集計を作る */
export interface TodayAggregates {
  todaySales: number
  todayVisitors: number
  todayUnitPrice: number
  stylists: StylistSummary[]
  menuRanking: RankingItem[]
  retailRanking: RankingItem[]
  paymentBreakdown: PaymentBreakdownEntry[]
}

export function buildTodayAggregates(
  todaySessions: { total: number | null; stylist_name: string | null; payment_method?: string | null }[],
  items: { item_name: string; category: string; quantity: number | null }[],
): TodayAggregates {
  const todaySales = todaySessions.reduce((sum, s) => sum + (s.total ?? 0), 0)
  const todayVisitors = todaySessions.length
  const todayUnitPrice = todayVisitors > 0 ? Math.round(todaySales / todayVisitors) : 0
  const stylists: StylistSummary[] = STYLISTS.map((name) => {
    const rows = todaySessions.filter((s) => (s.stylist_name || '未設定') === name)
    const sales = rows.reduce((sum, s) => sum + (s.total ?? 0), 0)
    const visitors = rows.length
    return { name, sales, visitors, unitPrice: visitors > 0 ? Math.round(sales / visitors) : 0 }
  })
  return {
    todaySales,
    todayVisitors,
    todayUnitPrice,
    stylists,
    menuRanking: groupAndCount(items.filter((it) => it.category === 'menu')).slice(0, 5),
    retailRanking: groupAndCount(items.filter((it) => it.category === 'retail')),
    paymentBreakdown: buildPaymentBreakdown(todaySessions),
  }
}

export type HqStylistPeriod = 'today' | 'month'

export interface StylistAnalysis extends StylistSummary {
  share: number // 全体売上に対する割合（%）。全体売上0の場合は0。
}

export interface HqStylistAnalysisData {
  period: HqStylistPeriod
  totalSales: number
  stylists: StylistAnalysis[]
}

/**
 * スタイリスト分析タブ用の集計データを取得する（期間: 本日 / 今月）。
 * Supabase エラー時は throw し、呼び出し側がエラーメッセージを表示する。
 */
export async function getHqStylistAnalysis(period: HqStylistPeriod): Promise<HqStylistAnalysisData> {
  const todayStr = getJapanDateString()
  let startStr: string
  let endStr: string
  if (period === 'today') {
    startStr = todayStr
    endStr = getJapanDateString(new Date(Date.now() + 24 * 60 * 60 * 1000))
  } else {
    const range = monthRangeFromToday(todayStr)
    startStr = range.start
    endStr = range.end
  }

  const sessions = await fetchHqSessions({ fromJst: startStr, toJst: endStr })
  const totalSales = sessions.reduce((sum, s) => sum + (s.total ?? 0), 0)

  const stylists: StylistAnalysis[] = STYLISTS.map((name) => {
    const rows = sessions.filter((s) => (s.stylist_name || '未設定') === name)
    const sales = rows.reduce((sum, s) => sum + (s.total ?? 0), 0)
    const visitors = rows.length
    return {
      name,
      sales,
      visitors,
      unitPrice: visitors > 0 ? Math.round(sales / visitors) : 0,
      share: totalSales > 0 ? Math.round((sales / totalSales) * 100) : 0,
    }
  })

  return { period, totalSales, stylists }
}

/**
 * 経営ダッシュボード用の集計データを取得する。
 * Supabase エラー時は throw せず、呼び出し側がエラーメッセージを表示できるよう例外を投げる。
 */
export async function getHqDashboardData(): Promise<HqDashboardData> {
  const todayStr = getJapanDateString()
  const tomorrowStr = getJapanDateString(new Date(Date.now() + 24 * 60 * 60 * 1000))
  const { start: monthStartStr, end: monthEndStr } = monthRangeFromToday(todayStr)

  const [todaySessions, monthSessions] = await Promise.all([
    fetchHqSessions({ fromJst: todayStr, toJst: tomorrowStr }),
    fetchHqSessions({ fromJst: monthStartStr, toJst: monthEndStr }),
  ])

  const monthSales = monthSessions.reduce((sum, s) => sum + (s.total ?? 0), 0)
  const items = (await fetchHqSessionItems(todaySessions.map((s) => s.id)))
    .filter((it) => it.category === 'menu' || it.category === 'retail')
  const agg = buildTodayAggregates(todaySessions, items)

  return {
    ...agg,
    monthSales,
  }
}

export type HqRealtimeStatus = 'connecting' | 'live' | 'error'

/** 会計データは本部 RPC 経由のため Realtime では受け取れない。定期取得で更新する */
const HQ_DASHBOARD_POLL_MS = 15_000

export function subscribeHqRealtime(
  onChange: () => void,
  onStatus?: (status: HqRealtimeStatus) => void,
): () => void {
  const timer = window.setInterval(() => onChange(), HQ_DASHBOARD_POLL_MS)
  onStatus?.('live')
  return () => { window.clearInterval(timer) }
}
