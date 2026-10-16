import { useEffect, useState } from 'react'
import { callHqRpc } from './hqSession'
import { fetchHqSessions, fetchHqSessionItems, type HqSessionRow, type HqSessionItemRow } from './hqDataStore'
import type { Product } from './hqInventoryStore'
import type { Ledger } from '../utils/bookingApi'
import type { DailyReport } from './hqDailyReportStore'
import { insightRange, insightSeries, summarizeInsights, type HqPeriod, type InsightRange } from './hqInsights'

export interface HqOverview {
  range: InsightRange
  sessions: HqSessionRow[]
  items: HqSessionItemRow[] | null
  summary: ReturnType<typeof summarizeInsights>
  previous: ReturnType<typeof summarizeInsights>
  series: ReturnType<typeof insightSeries>
  ledger: Ledger | null
  products: Product[] | null
  reports: DailyReport[] | null
  unavailable: string[]
  updatedAt: Date
}

export async function fetchHqOverview(period: HqPeriod, date: string): Promise<HqOverview> {
  const range = insightRange(period, date)
  const [sessions, previousSessions] = await Promise.all([
    fetchHqSessions({ fromJst: range.start, toJst: range.end }),
    fetchHqSessions({ fromJst: range.previousStart, toJst: range.previousEnd }),
  ])
  const [items, products, ledger, reports] = await Promise.allSettled([
    fetchHqSessionItems(sessions.map(s => s.id)),
    callHqRpc<Product[] | null>('hq_products_list'),
    callHqRpc<Ledger>('hq_day_ledger', { p_date: date }),
    callHqRpc<DailyReport[] | null>('hq_daily_reports', { p_limit: 30 }),
  ])
  const unavailable: string[] = []
  if (items.status === 'rejected') unavailable.push('会計明細')
  if (products.status === 'rejected') unavailable.push('在庫')
  if (ledger.status === 'rejected') unavailable.push('予約')
  if (reports.status === 'rejected') unavailable.push('日報')
  return { range, sessions, items: items.status === 'fulfilled' ? items.value : null,
    summary: summarizeInsights(sessions), previous: summarizeInsights(previousSessions), series: insightSeries(sessions, previousSessions, range),
    products: products.status === 'fulfilled' ? (products.value ?? []).filter(p => p.is_active !== false) : null,
    ledger: ledger.status === 'fulfilled' ? ledger.value : null,
    reports: reports.status === 'fulfilled' ? reports.value ?? [] : null, unavailable, updatedAt: new Date() }
}

export function useHqOverview(period: HqPeriod, date: string) {
  const key = period + ':' + date
  const [result, setResult] = useState<{ key: string; data?: HqOverview; error?: string }>({ key: '' })
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let alive = true, busy = false
    const load = async () => {
      if (busy) return
      busy = true
      try {
        const data = await fetchHqOverview(period, date)
        if (alive) setResult({ key, data })
      } catch {
        if (alive) setResult(prev => ({ key, data: prev.key === key ? prev.data : undefined, error: 'データを取得できませんでした。接続を確認して、もう一度お試しください。' }))
      } finally { busy = false }
    }
    void load()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, 30_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [period, date, key, retry])
  return { data: result.key === key ? result.data : undefined, error: result.key === key ? result.error : undefined, retry: () => setRetry(n => n + 1) }
}
