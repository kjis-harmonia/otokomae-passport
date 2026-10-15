import { useState } from 'react'
import { getJapanDateString } from '../../utils/dateUtils'
import { useHqOverview } from '../hqOverviewStore'
import type { HqPeriod } from '../hqInsights'
import { HqMetrics, HqPaymentPanel, HqPeriodToolbar, HqRankingPanel, HqRevenuePanel } from '../components/HqOverviewParts'

export function HqSalesScreen() {
  const [period, setPeriod] = useState<HqPeriod>('week')
  const [date, setDate] = useState(getJapanDateString)
  const { data, error, retry } = useHqOverview(period, date)
  return <><HqPeriodToolbar period={period} date={date} onPeriod={setPeriod} onDate={setDate} updatedAt={data?.updatedAt} />{!data ? error ? <div className="hq-error" role="alert"><h2>売上を取得できませんでした</h2><p>{error}</p><button className="hq-button" onClick={retry}>再試行</button></div> : <div className="hq-loading" role="status">売上を読み込んでいます…</div> : <>{error && <p className="hq-partial-notice" role="status">{error}</p>}<HqMetrics data={data} /><div className="hq-overview-grid"><div className="hq-overview-main"><HqRevenuePanel data={data} /><HqRankingPanel data={data} /></div><div className="hq-overview-side"><HqPaymentPanel data={data} /><section className="hq-surface"><div className="hq-surface-header"><h2>この数字について</h2></div><p className="hq-empty-inline">確定した会計を会計記録日時で集計しています。予約の予定金額と取消済みの会計は含みません。</p><p className="hq-report-note">比較対象は、選択期間の直前の同じ日数です。</p></section></div></div></>}</>
}
