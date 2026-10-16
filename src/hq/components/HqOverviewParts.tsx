import { ArrowDownRight, ArrowUpRight, CalendarDays, Download } from 'lucide-react'
import { getJapanDateString } from '../../utils/dateUtils'
import { insightsCsv, percentageChange, money, type HqPeriod } from '../hqInsights'
import type { HqOverview } from '../hqOverviewStore'
import { HqInsightChart } from './HqInsightChart'

const PAYMENT_COLORS = ['#819fbe', '#b8c9db', '#cdd9e4', '#8b959f', '#dcdfe3']

export function HqPeriodToolbar({ period, date, onPeriod, onDate, updatedAt }: { period: HqPeriod; date: string; onPeriod: (p: HqPeriod) => void; onDate: (d: string) => void; updatedAt?: Date }) {
  return <div className="hq-toolbar"><div className="hq-toolbar-left"><div className="hq-segmented" aria-label="集計期間">{([['today', '今日'], ['week', '今週'], ['month', '今月']] as const).map(([key, label]) => <button key={key} aria-pressed={period === key} onClick={() => onPeriod(key)}>{label}</button>)}</div><label className="hq-date-input"><CalendarDays size={14} /><input type="date" aria-label="集計の基準日" value={date} max={getJapanDateString()} onChange={event => { if (event.target.value && event.target.validity.valid) onDate(event.target.value) }} /></label></div><div className="hq-update-status"><span className="hq-status-dot" />{updatedAt ? new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' }).format(updatedAt) + ' 更新' : '取得中'}</div></div>
}

function Metric({ label, value, unit, current, previous, comparison }: { label: string; value: string; unit?: string; current: number; previous: number; comparison: string }) {
  const change = percentageChange(current, previous)
  return <div className="hq-metric"><p className="hq-metric-label">{label}</p><p className="hq-metric-value">{value}{unit && <small>{unit}</small>}</p><p className="hq-metric-foot"><span className={'hq-delta' + (change === null || change === 0 ? ' is-neutral' : change < 0 ? ' is-down' : '')}>{change === null ? '—' : <>{change >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}{Math.abs(change).toFixed(1)}%</>}</span><span>{change === null ? '比較期間の実績なし' : comparison}</span></p></div>
}

export function HqMetrics({ data }: { data: HqOverview }) {
  return <section className="hq-metrics" aria-label="経営指標"><Metric label="売上" value={money(data.summary.sales)} current={data.summary.sales} previous={data.previous.sales} comparison={data.range.comparison} /><Metric label="会計件数" value={data.summary.count.toLocaleString()} unit="件" current={data.summary.count} previous={data.previous.count} comparison={data.range.comparison} /><Metric label="平均会計単価" value={money(data.summary.unitPrice)} current={data.summary.unitPrice} previous={data.previous.unitPrice} comparison={data.range.comparison} /></section>
}

export function HqRevenuePanel({ data }: { data: HqOverview }) {
  function download() {
    const blob = new Blob([insightsCsv(data.series)], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob), a = document.createElement('a')
    a.href = url; a.download = 'ginjiro-sales-' + data.range.start + '.csv'; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <section className="hq-surface"><div className="hq-surface-header"><div><h2>売上の推移</h2><p>{data.range.start.replaceAll('-', '/')} – {new Date(Date.parse(data.range.end) - 86400000).toISOString().slice(0, 10).replaceAll('-', '/')} · 累計</p></div><button className="hq-icon-button" onClick={download} aria-label="売上推移をCSVでダウンロード"><Download size={16} /></button></div><div className="hq-chart-caption"><span><i />選択期間</span><span><i />{data.range.comparison.replace('比', '')}</span></div><HqInsightChart points={data.series} /></section>
}

export function HqPaymentPanel({ data }: { data: HqOverview }) {
  const total = data.summary.sales
  return <section className="hq-surface"><div className="hq-surface-header"><h2>お支払いの内訳</h2></div>{total === 0 ? <p className="hq-empty-inline">この期間の会計はありません。</p> : <><div className="hq-payment-track" aria-hidden="true">{data.summary.payments.map((p, i) => <span key={p.method} style={{ width: p.total / total * 100 + '%', background: PAYMENT_COLORS[i] }} />)}</div>{data.summary.payments.filter(p => p.total > 0).map(p => { const i = data.summary.payments.indexOf(p); return <div key={p.method} className="hq-payment-row"><i style={{ background: PAYMENT_COLORS[i] }} /><span>{p.label}</span><strong>{money(p.total)}</strong><span className="hq-payment-percent">{Math.round(p.total / total * 100)}%</span></div> })}</>}</section>
}

export function HqRankingPanel({ data }: { data: HqOverview }) {
  const counts = new Map<string, number>()
  for (const item of data.items ?? []) if (item.category === 'menu' || item.category === 'option') counts.set(item.item_name, (counts.get(item.item_name) ?? 0) + (item.quantity ?? 1))
  const rows = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5)
  return <section className="hq-surface"><div className="hq-surface-header"><h2>選ばれているメニュー</h2><span className="hq-eyebrow">会計明細から集計</span></div>{!rows.length ? <p className="hq-empty-inline">{data.items === null ? '会計明細を取得できませんでした。' : 'この期間の施術明細はありません。'}</p> : <table className="hq-data-table"><thead><tr><th style={{ width: 43 }}>順位</th><th>メニュー</th><th className="is-number">点数</th></tr></thead><tbody>{rows.map(([name, count], i) => <tr key={name}><td><span className="hq-rank">{i + 1}</span></td><td>{name}</td><td className="is-number">{count}<span className="is-muted"> 点</span></td></tr>)}</tbody></table>}</section>
}
