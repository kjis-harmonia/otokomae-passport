import { useState } from 'react'
import { getJapanDateString } from '../../utils/dateUtils'
import { money, type HqPeriod } from '../hqInsights'
import { useHqOverview } from '../hqOverviewStore'
import { HqMetrics, HqPeriodToolbar } from '../components/HqOverviewParts'

export function HqStylistScreen() {
  const [period, setPeriod] = useState<HqPeriod>('today')
  const [date, setDate] = useState(getJapanDateString)
  const { data, error, retry } = useHqOverview(period, date)
  return <><HqPeriodToolbar period={period} date={date} onPeriod={setPeriod} onDate={setDate} updatedAt={data?.updatedAt} />{!data ? error ? <div className="hq-error" role="alert"><h2>スタッフの実績を取得できませんでした</h2><p>{error}</p><button className="hq-button" onClick={retry}>再試行</button></div> : <div className="hq-loading" role="status">実績を読み込んでいます…</div> : <>{error && <p className="hq-partial-notice" role="status">{error}</p>}<HqMetrics data={data} /><section className="hq-surface"><div className="hq-surface-header"><h2>担当者別の実績</h2><span className="hq-eyebrow">確定済み会計</span></div>{data.summary.staff.length === 0 ? <p className="hq-empty-inline">この期間の会計はありません。</p> : <div style={{ overflowX: 'auto' }}><table className="hq-data-table" style={{ minWidth: 460 }}><thead><tr><th>担当者</th><th className="is-number">会計件数</th><th className="is-number">平均単価</th><th className="is-number">売上</th><th className="is-number">構成比</th></tr></thead><tbody>{data.summary.staff.map(member => <tr key={member.name}><td><span className="hq-staff-avatar" style={{ display: 'inline-grid', marginRight: 10 }}>{member.name.slice(0, 1)}</span>{member.name}</td><td className="is-number">{member.count} 件</td><td className="is-number">{money(member.unitPrice)}</td><td className="is-number">{money(member.sales)}</td><td className="is-number is-muted">{data.summary.sales ? Math.round(member.sales / data.summary.sales * 100) : 0}%</td></tr>)}</tbody></table></div>}<p className="hq-report-note">会計に記録された担当者ごとの集計です。担当未記録の会計は「未設定」に含みます。</p></section></>}</>
}
