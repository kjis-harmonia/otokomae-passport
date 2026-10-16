import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { getJapanDateString } from '../../utils/dateUtils'
import { rpcErrorMessage } from '../../utils/staffSession'
import { jstDateLabel, jstTime } from '../../utils/bookingApi'
import type { AppFilter, ClientListRow, CustomerApi } from '../../utils/customerApi'
import type { GinpayClientApi } from '../../utils/ginpayApi'
import { CustomerLedger } from './CustomerLedger'
import { C, SANS, inputStyle, linkStyle } from './ledgerTheme'

// 顧客一覧（本部・店舗で共通）。顧客マスター（clients）の検索と一覧。行を開くと予約から開くときと同じ顧客台帳。
// 毎日使う業務画面として、検索欄と表だけにする（カード・グラフは置かない）。

const FILTERS: { id: AppFilter; label: string }[] = [
  { id: 'all', label: 'すべて' },
  { id: 'app', label: 'App連携' },
  { id: 'non_app', label: 'App未連携' },
]
const WIDE = '(min-width: 760px)'
const subscribeWide = (cb: () => void) => { const m = window.matchMedia(WIDE); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb) }
const isWide = () => window.matchMedia(WIDE).matches
const COLS = 'minmax(140px, 1.6fr) minmax(110px, 1fr) 116px 52px 76px minmax(130px, 1.2fr) 40px'

export function ClientList({ api, ginpayApi, ensureActor, toolbar }: {
  api: CustomerApi
  ginpayApi?: GinpayClientApi
  ensureActor: () => boolean
  /** 見出しの右側（店舗端末の操作者など） */
  toolbar?: ReactNode
}) {
  const wide = useSyncExternalStore(subscribeWide, isWide, () => true)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<AppFilter>('all')
  const [rows, setRows] = useState<ClientListRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const seq = useRef(0)

  const load = useCallback(async (q: string, f: AppFilter) => {
    const my = ++seq.current
    try {
      const res = await api.list(q.trim(), f, 0)
      if (my !== seq.current) return
      setRows(res.rows); setTotal(res.total); setError(null)
    } catch (err) {
      if (my === seq.current) setError(rpcErrorMessage(err, '顧客一覧を読み込めませんでした。'))
    }
  }, [api])

  useEffect(() => {
    const t = window.setTimeout(() => void load(query, filter), query ? 250 : 0)
    return () => window.clearTimeout(t)
  }, [load, query, filter])

  async function more() {
    if (!rows) return
    setLoadingMore(true)
    try {
      const res = await api.list(query.trim(), filter, rows.length)
      setRows([...rows, ...res.rows]); setTotal(res.total)
    } catch (err) { setError(rpcErrorMessage(err)) } finally { setLoadingMore(false) }
  }

  const today = getJapanDateString()

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: SANS, minHeight: '100%' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '16px 16px 48px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>顧客</h1>
          {rows && <span style={{ fontSize: 14, color: C.sub, fontVariantNumeric: 'tabular-nums' }}>{total.toLocaleString()}人</span>}
          {toolbar && <span style={{ marginLeft: 'auto' }}>{toolbar}</span>}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} type="search" aria-label="顧客を検索"
          placeholder="氏名・電話番号・予約番号で検索"
          style={{ ...inputStyle, marginTop: 12 }} autoComplete="off" />
        <div role="tablist" style={{ display: 'flex', gap: 20, marginTop: 6, borderBottom: `1px solid ${C.line}` }}>
          {FILTERS.map(f => (
            <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)} style={{
              minHeight: 44, padding: 0, background: 'none', border: 'none', fontFamily: SANS, fontSize: 14, cursor: 'pointer', marginBottom: -1,
              color: filter === f.id ? C.text : C.sub, fontWeight: filter === f.id ? 600 : 400,
              borderBottom: `2px solid ${filter === f.id ? C.text : 'transparent'}`,
            }}>{f.label}</button>
          ))}
        </div>

        {error && <p style={{ color: C.danger, fontSize: 14, marginTop: 12 }}>{error}</p>}
        {!rows ? (!error && <p style={{ color: C.sub, fontSize: 14, marginTop: 16 }}>読み込み中…</p>)
          : rows.length === 0 ? <p style={{ color: C.mute, fontSize: 14, marginTop: 16 }}>{query ? '該当する顧客はいません' : '顧客はまだいません'}</p>
          : (
            <div role="table" aria-label="顧客一覧" style={{ marginTop: 4 }}>
              {wide && (
                <div role="row" style={{ ...rowGrid, minHeight: 36, fontSize: 12, color: C.mute, borderBottom: `1px solid ${C.line}` }}>
                  <span role="columnheader">氏名</span><span role="columnheader">電話</span><span role="columnheader">前回来店</span>
                  <span role="columnheader" style={{ textAlign: 'right' }}>来店</span><span role="columnheader">主担当</span>
                  <span role="columnheader">次回予約</span><span role="columnheader">App</span>
                </div>
              )}
              {rows.map(r => (
                <button key={r.id} type="button" role="row" onClick={() => setOpen(r.id)} aria-label={`${r.name} の顧客台帳`}
                  style={wide ? { ...rowButton, ...rowGrid } : rowButton}>
                  {wide ? (
                    <>
                      <span style={cell}><b style={{ fontWeight: 600 }}>{r.name}</b>{r.kana && <span style={{ fontSize: 12, color: C.mute, marginLeft: 8 }}>{r.kana}</span>}</span>
                      <span style={{ ...cell, color: C.sub, fontVariantNumeric: 'tabular-nums' }}>{phoneText(r)}</span>
                      <span style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>{r.last_visit ? shortDate(r.last_visit) : <span style={{ color: C.mute }}>—</span>}
                        {r.last_visit && <span style={{ fontSize: 12, color: C.mute, marginLeft: 6 }}>{daysAgo(r.last_visit, today)}</span>}</span>
                      <span style={{ ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.visit_count}回</span>
                      <span style={cell}>{r.main_stylist ?? <span style={{ color: C.mute }}>—</span>}</span>
                      <span style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>{r.next_reservation ? nextText(r) : <span style={{ color: C.mute }}>—</span>}</span>
                      <span style={{ ...cell, color: C.sub }}>{r.app_linked ? '連携' : ''}</span>
                    </>
                  ) : (
                    <>
                      <span style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                        <span style={{ ...cell, fontSize: 15 }}><b style={{ fontWeight: 600 }}>{r.name}</b></span>
                        <span style={{ fontSize: 12, color: C.sub, whiteSpace: 'nowrap' }}>{r.app_linked ? 'App連携' : ''}</span>
                      </span>
                      <span style={{ display: 'block', marginTop: 3, fontSize: 13, color: C.sub, lineHeight: 1.6 }}>
                        {[r.last_visit ? `前回 ${shortDate(r.last_visit)}` : '来店記録なし', `来店${r.visit_count}回`, r.main_stylist,
                          r.next_reservation ? `次回 ${nextText(r)}` : null].filter(Boolean).join('・')}
                      </span>
                    </>
                  )}
                </button>
              ))}
              {rows.length < total && (
                <button type="button" onClick={() => void more()} disabled={loadingMore} style={{ ...linkStyle, marginTop: 8 }}>
                  {loadingMore ? '読み込み中…' : `さらに表示（残り ${total - rows.length}人）`}
                </button>
              )}
            </div>
          )}
      </div>

      {open && (
        <CustomerLedger
          api={api}
          ginpayApi={ginpayApi}
          target={{ clientId: open }}
          backLabel="顧客一覧に戻る"
          ensureActor={ensureActor}
          onClose={() => { setOpen(null); void load(query, filter) }}
          onChanged={() => void load(query, filter)}
        />
      )}
    </div>
  )
}

const rowGrid: CSSProperties = { display: 'grid', gridTemplateColumns: COLS, columnGap: 12, alignItems: 'center' }
const rowButton: CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', minHeight: 52, padding: '10px 0', background: 'none', border: 'none',
  borderBottom: `1px solid ${C.line}`, color: C.text, fontFamily: SANS, fontSize: 14, cursor: 'pointer',
}
const cell: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

function phoneText(r: ClientListRow): string {
  if (!r.phone) return r.phone_last4 ? `下4桁 ${r.phone_last4}` : '—'
  // ハイフンなしで入力された携帯番号（11桁）は表示だけ区切る（保存値は変えない）
  return /^0d{10}$/.test(r.phone) ? `${r.phone.slice(0, 3)}-${r.phone.slice(3, 7)}-${r.phone.slice(7)}` : r.phone
}

function shortDate(ymd: string): string {
  const [, m, d] = ymd.split('-').map(Number)
  return `${m}月${d}日`
}

function nextText(r: ClientListRow): string {
  const n = r.next_reservation!
  const ymd = getJapanDateString(new Date(n.starts_at))
  return `${jstDateLabel(ymd).replace(/（.）/, '')} ${jstTime(n.starts_at)} ${n.staff_name}${n.nominated ? '' : '（フリー）'}`
}

function daysAgo(ymd: string, today: string): string {
  const n = Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(ymd + 'T00:00:00Z')) / 86400000)
  return n <= 0 ? '今日' : `${n}日前`
}
