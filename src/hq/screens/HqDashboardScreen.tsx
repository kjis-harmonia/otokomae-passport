import { useState } from 'react'
import { ArrowUpRight, CalendarDays, Check, ChevronRight, FileText, Package, Store } from 'lucide-react'
import { getJapanDateString } from '../../utils/dateUtils'
import type { HqTab } from '../hqMockData'
import { money, type HqPeriod } from '../hqInsights'
import { useHqOverview, type HqOverview } from '../hqOverviewStore'
import { splitStockAlerts } from '../hqInventoryStore'
import { HqMetrics, HqPaymentPanel, HqPeriodToolbar, HqRankingPanel, HqRevenuePanel } from '../components/HqOverviewParts'

export function HqDashboardScreen({ onNavigate }: { onNavigate: (tab: HqTab) => void }) {
  const [period, setPeriod] = useState<HqPeriod>('today')
  const [date, setDate] = useState(getJapanDateString)
  const { data, error, retry } = useHqOverview(period, date)
  return <>
    <HqPeriodToolbar period={period} date={date} onPeriod={setPeriod} onDate={setDate} updatedAt={data?.updatedAt} />
    {!data ? error ? <div className="hq-error" role="alert"><h2>店舗のデータを取得できませんでした</h2><p>{error}</p><button className="hq-button" onClick={retry}>もう一度読み込む</button></div> : <div className="hq-loading" role="status">店舗のデータを読み込んでいます…</div> : <>
      {(error || data.unavailable.length > 0) && <p className="hq-partial-notice" role="status">{error ?? data.unavailable.join('・') + 'を取得できませんでした。取得できた情報を表示しています。'}</p>}
      <HqMetrics data={data} />
      <div className="hq-overview-grid">
        <div className="hq-overview-main"><HqRevenuePanel data={data} /><Attention data={data} onNavigate={onNavigate} /><HqRankingPanel data={data} /></div>
        <div className="hq-overview-side"><StoreSummary data={data} date={date} onNavigate={onNavigate} /><StaffSummary data={data} onNavigate={onNavigate} /><HqPaymentPanel data={data} /></div>
      </div>
    </>}
  </>
}

function StoreSummary({ data, date, onNavigate }: { data: HqOverview; date: string; onNavigate: (tab: HqTab) => void }) {
  const ledger = data.ledger
  const active = ledger?.reservations.filter(r => r.status !== 'cancelled' && r.status !== 'no_show')
  const serving = active?.filter(r => r.status === 'in_service' || r.status === 'checked_in').length
  const hours = ledger?.business_hours
  const closed = ledger?.closure || hours?.is_closed
  const schedule = !ledger ? '取得できません' : closed ? '店休日' : hours?.open_time && hours.close_time ? hours.open_time + ' – ' + hours.close_time : '未設定'
  return <section className="hq-surface"><div className="hq-surface-header"><h2>店舗の状況</h2><span className="hq-eyebrow">{date.slice(5).replace('-', '/')}</span></div><div className="hq-store-head"><span className="hq-store-icon"><Store size={22} strokeWidth={1.5} /></span><div><h3>銀二郎</h3><p>現在の接続店舗</p></div></div><div className="hq-fact-row"><span>営業時間</span><strong>{schedule}</strong></div><div className="hq-fact-row"><span>予約</span><strong>{active ? active.length + ' 件' : '—'}</strong></div><div className="hq-fact-row"><span>来店済み・施術中</span><strong>{serving === undefined ? '—' : serving + ' 件'}</strong></div><div className="hq-fact-row"><span>シフト登録</span><strong>{ledger ? ledger.staff.filter(s => s.shifts.length > 0).length + ' 名' : '—'}</strong></div><button className="hq-text-button hq-store-link" onClick={() => onNavigate('ledger')}>予約台帳をみる<ArrowUpRight size={13} /></button></section>
}

function Attention({ data, onNavigate }: { data: HqOverview; onNavigate: (tab: HqTab) => void }) {
  const alerts = data.products ? splitStockAlerts(data.products) : null
  const unassigned = data.ledger?.reservations.filter(r => r.status === 'confirmed' && !r.staff_confirmed).length ?? 0
  const tasks = [
    ...(alerts && alerts.reorder.length > 0 ? [{ title: '発注を確認する商品', detail: alerts.reorder.slice(0, 2).map(p => p.name).join('、'), count: alerts.reorder.length, tab: 'inventory' as HqTab, Icon: Package }] : []),
    ...(unassigned > 0 ? [{ title: '担当が未確定の予約', detail: '予約台帳で担当者を確認してください', count: unassigned, tab: 'ledger' as HqTab, Icon: CalendarDays }] : []),
    ...(alerts && alerts.low.length > 0 ? [{ title: '在庫が少ない商品', detail: alerts.low.slice(0, 2).map(p => p.name).join('、'), count: alerts.low.length, tab: 'inventory' as HqTab, Icon: Package }] : []),
  ]
  return <section className="hq-surface"><div className="hq-surface-header"><h2>確認すること</h2><span className="hq-eyebrow">{tasks.length} 項目</span></div>{tasks.length ? tasks.map(task => <button className="hq-action-row" key={task.title} onClick={() => onNavigate(task.tab)}><span className="hq-action-icon"><task.Icon size={17} strokeWidth={1.6} /></span><span><strong>{task.title}</strong><p>{task.detail}</p></span><span className="hq-action-count">{task.count} 件</span><ChevronRight size={14} /></button>) : <p className="hq-empty-inline"><Check size={15} style={{ verticalAlign: 'middle', marginRight: 7 }} />{data.unavailable.includes('在庫') || data.unavailable.includes('予約') ? '一部の状況を確認できません。再読み込みしてください。' : '今すぐ確認する項目はありません。'}</p>}<p className="hq-report-note"><FileText size={13} /><span>一日の振り返りは日報から。</span><button className="hq-text-button" style={{ marginLeft: 'auto' }} onClick={() => onNavigate('reports')}>日報をみる<ChevronRight size={12} /></button></p></section>
}

function StaffSummary({ data, onNavigate }: { data: HqOverview; onNavigate: (tab: HqTab) => void }) {
  const total = data.summary.sales
  return <section className="hq-surface"><div className="hq-surface-header"><h2>スタッフの実績</h2><button className="hq-text-button" onClick={() => onNavigate('stylist')}>詳しく<ChevronRight size={12} /></button></div>{data.summary.staff.length ? data.summary.staff.map(staff => <div className="hq-staff-row" key={staff.name}><span className="hq-staff-avatar">{staff.name.slice(0, 1)}</span><div className="hq-staff-detail"><strong>{staff.name}</strong><p>{staff.count}件の会計</p><div className="hq-staff-bar"><span style={{ width: (total ? staff.sales / total * 100 : 0) + '%' }} /></div></div><span className="hq-staff-value">{money(staff.sales)}</span></div>) : <p className="hq-empty-inline">この期間の会計はありません。</p>}</section>
}
