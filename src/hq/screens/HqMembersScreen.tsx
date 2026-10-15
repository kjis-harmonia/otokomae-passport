import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { getCustomerKarteList, type CustomerKarteSummary } from '../hqCustomerKarteStore'
import { money } from '../hqInsights'

export function HqMembersScreen() {
  const [members, setMembers] = useState<CustomerKarteSummary[] | null>(null)
  const [error, setError] = useState(false)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'visits' | 'sales'>('sales')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let alive = true
    getCustomerKarteList().then(data => { if (alive) { setMembers(data); setError(false) } }).catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [retry])
  const shown = useMemo(() => (members ?? []).filter(m => (m.name + ' ' + (m.phoneLast4 ?? '')).includes(query.trim())).sort((a, b) => sort === 'sales' ? b.totalSpend - a.totalSpend : b.visitCount - a.visitCount), [members, query, sort])
  if (!members) return error ? <div className="hq-error" role="alert"><h2>会員情報を取得できませんでした</h2><p>接続を確認して、もう一度お試しください。</p><button className="hq-button" onClick={() => setRetry(n => n + 1)}>再試行</button></div> : <div className="hq-loading" role="status">会員情報を読み込んでいます…</div>
  return <>{error && <p className="hq-partial-notice">更新できませんでした。前回取得した内容を表示しています。</p>}<section className="hq-metrics" aria-label="会員の状況">{[{ label: '登録会員', value: members.length }, { label: '会計履歴のある会員', value: members.filter(m => m.visitCount > 0).length }, { label: '複数回の会計履歴', value: members.filter(m => m.visitCount > 1).length }].map(m => <div className="hq-metric" key={m.label}><p className="hq-metric-label">{m.label}</p><p className="hq-metric-value">{m.value}<small>名</small></p></div>)}</section><section className="hq-surface"><div className="hq-surface-header"><h2>会員の利用状況</h2><span className="hq-eyebrow">{shown.length} 名</span></div><div className="hq-toolbar"><label className="hq-member-search"><Search size={15} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="名前・電話番号の下4桁" aria-label="会員を検索" /></label><div className="hq-segmented" aria-label="会員の並び順"><button aria-pressed={sort === 'sales'} onClick={() => setSort('sales')}>累計会計額</button><button aria-pressed={sort === 'visits'} onClick={() => setSort('visits')}>会計件数</button></div></div><div style={{ overflowX: 'auto' }}><table className="hq-data-table hq-member-table"><thead><tr><th>会員</th><th className="is-number">会計件数</th><th className="is-number">累計会計額</th><th className="is-number">最終会計日</th></tr></thead><tbody>{shown.map(member => <tr key={member.userId}><td>{member.name}<span className="hq-mobile-member-date">{member.lastVisitDate?.replaceAll('-', '/') ?? '会計履歴なし'}</span></td><td className="is-number">{member.visitCount} 件</td><td className="is-number">{money(member.totalSpend)}</td><td className="is-number is-muted">{member.lastVisitDate?.replaceAll('-', '/') ?? '—'}</td></tr>)}</tbody></table></div>{shown.length === 0 && <p className="hq-empty-inline">{query ? '一致する会員がいません。' : '登録会員はまだいません。'}</p>}<p className="hq-report-note">会員に紐づく確定済み会計を集計しています。予約の来店回数とは異なります。</p></section></>
}
