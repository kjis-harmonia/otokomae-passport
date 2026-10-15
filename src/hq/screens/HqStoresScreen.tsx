import { ArrowUpRight, CalendarDays, Store } from 'lucide-react'
import { getJapanDateString } from '../../utils/dateUtils'
import type { HqTab } from '../hqMockData'
import { useHqOverview } from '../hqOverviewStore'
import { money } from '../hqInsights'

export function HqStoresScreen({ onNavigate }: { onNavigate: (tab: HqTab) => void }) {
  const { data, error, retry } = useHqOverview('today', getJapanDateString())
  return <><div className="hq-toolbar"><span className="hq-eyebrow">接続店舗 · 1店舗</span></div><div className="hq-store-directory"><section className="hq-surface"><div className="hq-store-head"><span className="hq-store-icon"><Store size={23} strokeWidth={1.5} /></span><div><h3>銀二郎</h3><p>店舗ワークスペース</p></div></div>{error && !data ? <div role="alert"><p className="hq-empty-inline">{error}</p><button className="hq-button" onClick={retry}>再試行</button></div> : <><div className="hq-store-metrics"><div><p>本日の売上</p><strong>{data ? money(data.summary.sales) : '—'}</strong></div><div><p>本日の会計</p><strong>{data ? data.summary.count + ' 件' : '—'}</strong></div><div><p>本日の予約</p><strong>{data?.ledger ? data.ledger.reservations.filter(r => r.status !== 'cancelled' && r.status !== 'no_show').length + ' 件' : '—'}</strong></div></div><div className="hq-store-directory-actions"><button className="hq-button hq-button-primary" onClick={() => onNavigate('dashboard')}>店舗の概況<ArrowUpRight size={14} /></button><button className="hq-button" onClick={() => onNavigate('ledger')}><CalendarDays size={14} />予約台帳</button></div></>}</section></div><p className="hq-report-note">現在の接続先で管理している店舗を表示しています。</p></>
}
