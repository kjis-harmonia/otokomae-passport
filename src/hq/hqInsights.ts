export type HqPeriod = 'today' | 'week' | 'month'
export interface InsightSession { id: string; total: number | null; stylist_name: string | null; payment_method: string | null; created_at: string }
export interface InsightRange { start: string; end: string; previousStart: string; previousEnd: string; days: number; comparison: string }
export interface InsightPoint { label: string; current: number; previous: number }
export interface InsightStaff { name: string; sales: number; count: number; unitPrice: number }
export const money = (value: number) => '¥' + value.toLocaleString('ja-JP')

export function shiftDate(date: string, days: number): string {
  const value = new Date(date + 'T00:00:00Z')
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

/** Inclusive anchor; the comparison is the immediately preceding equal number of days. */
export function insightRange(period: HqPeriod, date: string): InsightRange {
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay()
  const start = period === 'month' ? date.slice(0, 8) + '01' : period === 'week' ? shiftDate(date, -((weekday + 6) % 7)) : date
  const end = shiftDate(date, 1)
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000)
  return { start, end, previousStart: shiftDate(start, -days), previousEnd: start, days, comparison: days === 1 ? '前日比' : '直前' + days + '日間比' }
}

export function summarizeInsights(sessions: InsightSession[]) {
  const paymentNames: Record<string, string> = { cash: '現金', credit: 'カード', qr: 'QR決済', ginpay: 'GINPay', other: 'その他' }
  const payments = Object.keys(paymentNames).map(method => ({ method, label: paymentNames[method], total: 0 }))
  const staff = new Map<string, InsightStaff>()
  let sales = 0
  for (const row of sessions) {
    const total = Number.isFinite(row.total) ? row.total! : 0
    sales += total
    const name = row.stylist_name?.trim() || '未設定'
    const member = staff.get(name) ?? { name, sales: 0, count: 0, unitPrice: 0 }
    member.sales += total; member.count += 1
    staff.set(name, member)
    const method = row.payment_method === 'card' ? 'credit' : row.payment_method
    const payment = payments.find(p => p.method === method) ?? payments[payments.length - 1]
    payment.total += total
  }
  return { sales, count: sessions.length, unitPrice: sessions.length ? Math.round(sales / sessions.length) : 0,
    staff: [...staff.values()].map(s => ({ ...s, unitPrice: Math.round(s.sales / s.count) })).sort((a, b) => b.sales - a.sales), payments }
}

export function percentageChange(current: number, previous: number): number | null {
  return previous === 0 ? null : Math.round(((current - previous) / previous) * 1000) / 10
}

/** JST date grouping; cumulative values preserve the full period total. */
export function insightSeries(current: InsightSession[], previous: InsightSession[], range: InsightRange): InsightPoint[] {
  const sumByDate = (rows: InsightSession[]) => {
    const sums = new Map<string, number>()
    for (const row of rows) {
      const date = new Date(Date.parse(row.created_at) + 9 * 3_600_000).toISOString().slice(0, 10)
      sums.set(date, (sums.get(date) ?? 0) + (row.total ?? 0))
    }
    return sums
  }
  if (range.days === 1) {
    const hours = (rows: InsightSession[]) => {
      const buckets = Array<number>(24).fill(0)
      for (const row of rows) buckets[new Date(Date.parse(row.created_at) + 9 * 3_600_000).getUTCHours()] += row.total ?? 0
      return buckets
    }
    const a = hours(current), b = hours(previous)
    let totalA = 0, totalB = 0
    return a.map((value, i) => { totalA += value; totalB += b[i]; return { label: String(i).padStart(2, '0') + ':00', current: totalA, previous: totalB } })
  }
  const a = sumByDate(current), b = sumByDate(previous)
  let totalA = 0, totalB = 0
  return Array.from({ length: range.days }, (_, i) => {
    const date = shiftDate(range.start, i)
    totalA += a.get(date) ?? 0; totalB += b.get(shiftDate(range.previousStart, i)) ?? 0
    return { label: date.slice(5).replace('-', '/'), current: totalA, previous: totalB }
  })
}

export function insightsCsv(points: InsightPoint[]): string {
  return '\uFEFF' + ['時点,選択期間の累計売上,比較期間の累計売上', ...points.map(p => [p.label, p.current, p.previous].join(','))].join('\r\n')
}
