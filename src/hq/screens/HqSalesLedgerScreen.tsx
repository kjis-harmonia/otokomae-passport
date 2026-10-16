import { useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { getJapanDateString, addDaysToDateString } from '../../utils/dateUtils'
import { rpcErrorMessage } from '../../utils/staffSession'
import { jstDateLabel, jstTime, yen } from '../../utils/bookingApi'
import { checkoutErrorMessage, hqSalesApi, PAYMENT_LABEL, type Sale, type SalesDay } from '../../utils/checkoutApi'
import { Field, SecondaryButton, Sheet } from '../../components/booking/ledgerUi'
import { C, SANS, inputStyle, linkStyle } from '../../components/booking/ledgerTheme'

// 本部：確定した会計の閲覧（日別の一覧・会計の詳細・取消履歴）と取消。売上 Dashboard ではない。
// 一覧の合計は確定済みだけ（取消は件数のみ）。会計は確定時点の内容をそのまま表示する。

const WIDE = '(min-width: 760px)'
const subscribeWide = (cb: () => void) => { const m = window.matchMedia(WIDE); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb) }
const isWide = () => window.matchMedia(WIDE).matches

export function HqSalesLedgerScreen() {
  const wide = useSyncExternalStore(subscribeWide, isWide, () => true)
  const today = getJapanDateString()
  const [date, setDate] = useState(today)
  const [day, setDay] = useState<SalesDay | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async (d: string) => {
    try { setDay(await hqSalesApi.day(d)); setError(null) } catch (err) { setError(rpcErrorMessage(err, '会計を読み込めませんでした。')) }
  }, [])
  useEffect(() => { setDay(null); void load(date) }, [date, load]) // eslint-disable-line react-hooks/set-state-in-effect

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: SANS }}>
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '16px 16px 40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, marginRight: 12 }}>会計</h1>
          <button type="button" aria-label="前の日" onClick={() => setDate(addDaysToDateString(date, -1))} style={navBtn}>‹</button>
          <span style={{ position: 'relative', fontSize: 16, fontWeight: 600, minWidth: 120, textAlign: 'center' }}>
            {jstDateLabel(date)}
            <input type="date" value={date} aria-label="日付を選ぶ" onChange={e => e.target.value && setDate(e.target.value)}
              style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', cursor: 'pointer' }} />
          </span>
          <button type="button" aria-label="次の日" onClick={() => setDate(addDaysToDateString(date, 1))} style={navBtn}>›</button>
          {date !== today && <button type="button" onClick={() => setDate(today)} style={{ ...linkStyle, color: C.text, marginLeft: 8 }}>今日</button>}
        </div>
        {day && (
          <p style={{ marginTop: 8, fontSize: 14, color: C.sub, fontVariantNumeric: 'tabular-nums' }}>
            会計 <b style={{ color: C.text, fontWeight: 600 }}>{day.count}</b>件{'　'}合計 <b style={{ color: C.text, fontWeight: 600 }}>{yen(day.total)}</b>
            {day.voided > 0 && <>{'　'}取消 {day.voided}件</>}
          </p>
        )}
        {error && <p style={{ color: C.danger, fontSize: 14, marginTop: 12 }}>{error}</p>}
        {!day ? (!error && <p style={{ color: C.sub, fontSize: 14, marginTop: 16 }}>読み込み中…</p>)
          : day.rows.length === 0 ? <p style={{ color: C.mute, fontSize: 14, marginTop: 16 }}>この日の会計はありません</p>
          : (
            <div role="table" aria-label="会計一覧" style={{ marginTop: 8, borderTop: `1px solid ${C.line}` }}>
              {day.rows.map(r => {
                const voided = r.status === 'voided'
                return (
                  <button key={r.id} type="button" role="row" onClick={() => setOpen(r.id)} aria-label={`${jstTime(r.completed_at)} ${r.customer_name ?? '匿名'} ${yen(r.total)}${voided ? ' 取消' : ''}`}
                    style={{ ...rowBtn, ...(wide ? { display: 'grid', gridTemplateColumns: '56px minmax(120px, 1fr) minmax(160px, 2fr) 80px 64px 96px', columnGap: 12, alignItems: 'center' } : {}), color: voided ? C.mute : C.text }}>
                    {wide ? (
                      <>
                        <span style={{ fontVariantNumeric: 'tabular-nums', color: C.sub }}>{jstTime(r.completed_at)}</span>
                        <span style={cell}>{r.customer_name ?? <span style={{ color: C.mute }}>匿名</span>}</span>
                        <span style={{ ...cell, color: C.sub }}>{r.items ?? '—'}</span>
                        <span style={cell}>{r.stylist_name ?? '—'}</span>
                        <span style={{ color: C.sub }}>{r.payment_method ? PAYMENT_LABEL[r.payment_method] ?? r.payment_method : '—'}</span>
                        <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', textDecoration: voided ? 'line-through' : undefined }}>
                          {voided && <span style={{ fontSize: 12, marginRight: 6, textDecoration: 'none', display: 'inline-block' }}>取消</span>}{yen(r.total)}
                        </span>
                      </>
                    ) : (
                      <>
                        <span style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                          <span style={cell}><span style={{ color: C.sub, fontVariantNumeric: 'tabular-nums' }}>{jstTime(r.completed_at)}</span>{'　'}{r.customer_name ?? '匿名'}</span>
                          <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', textDecoration: voided ? 'line-through' : undefined }}>{yen(r.total)}</span>
                        </span>
                        <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: C.mute, ...cell }}>
                          {[voided ? '取消' : null, r.items, r.stylist_name, r.payment_method ? PAYMENT_LABEL[r.payment_method] : null].filter(Boolean).join('・')}
                        </span>
                      </>
                    )}
                  </button>
                )
              })}
            </div>
          )}
      </div>
      {open && <SaleDetail id={open} onClose={() => setOpen(null)} onChanged={() => void load(date)} />}
    </div>
  )
}

function SaleDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [s, setS] = useState<Sale | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [voiding, setVoiding] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { hqSalesApi.detail(id).then(setS).catch(err => setError(rpcErrorMessage(err))) }, [id])

  async function doVoid() {
    setBusy(true); setError(null)
    try {
      const res = await hqSalesApi.void(id, reason.trim())
      if ('error' in res) setError(checkoutErrorMessage(res.error))
      else { setS(res); setVoiding(false); onChanged() }
    } catch (err) { setError(rpcErrorMessage(err)) } finally { setBusy(false) }
  }

  const title = s ? `${jstDateLabel(getJapanDateString(new Date(s.completed_at)))} ${jstTime(s.completed_at)}` : '会計'
  return (
    <Sheet title={title} onClose={onClose}>
      {!s ? <p style={{ color: error ? C.danger : C.sub, fontSize: 14 }}>{error ?? '読み込み中…'}</p> : (
        <>
          <p style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>{s.client?.name ?? (s.customer_name || '匿名')}</p>
          <p style={{ fontSize: 13, color: C.sub, marginTop: 4, lineHeight: 1.7 }}>
            {[`担当 ${s.stylist_name ?? '—'}`, s.reservation ? `予約 ${jstTime(s.reservation.starts_at)}` : '予約なし', `操作 ${s.operator ?? '—'}`].join('　')}
          </p>
          {s.status === 'voided' && (
            <p style={{ marginTop: 8, fontSize: 14, color: C.danger }}>取消済み（{s.voided_by}・{s.voided_at ? jstTime(s.voided_at) : ''}）{s.void_reason}</p>
          )}
          <div style={{ marginTop: 14, borderTop: `1px solid ${C.text}` }}>
            {s.items.map((i, k) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: `1px solid ${C.line}`, fontSize: 14 }}>
                <span>
                  {i.name}
                  <span style={{ display: 'block', fontSize: 12, color: C.mute, marginTop: 2 }}>
                    {`${yen(i.unit_price)} × ${i.quantity}`}{i.line_discount ? `・値引き −${yen(i.line_discount)}` : ''}
                    {i.list_price !== null && i.list_price !== i.unit_price ? `・定価 ${yen(i.list_price)}` : ''}
                  </span>
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{yen(i.line_total)}</span>
              </div>
            ))}
            {s.discounts.map((d, k) => (
              <div key={`d${k}`} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: `1px solid ${C.line}`, fontSize: 14, color: C.sub }}>
                <span>{d.label}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>−{yen(d.amount)}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '12px 0' }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>お支払い</span>
              <span style={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums', textDecoration: s.status === 'voided' ? 'line-through' : undefined }}>{yen(s.total)}</span>
            </div>
          </div>
          <p style={{ fontSize: 13, color: C.sub, lineHeight: 1.8 }}>
            {`支払方法 ${s.payments.map(p => PAYMENT_LABEL[p.method] ?? p.method).join('・') || (s.payment_method ? PAYMENT_LABEL[s.payment_method] : '—')}`}
            {'　'}{s.tax_rate === null ? '税：未設定' : `税：${s.tax_mode === 'inclusive' ? '税込' : '税抜'} ${Math.round(s.tax_rate * 1000) / 10}%`}
          </p>
          {(s.ginpay ?? []).length > 0 && (
            <div style={{ marginTop: 8 }}>
              {s.ginpay!.map(g => (
                <p key={g.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, color: C.sub, lineHeight: 1.8 }}>
                  <span>{`GINPay ${g.type === 'payment' ? '支払い' : '取消（残高に戻し）'} ${jstTime(g.created_at)}`}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{g.amount > 0 ? '+' : '−'}{yen(Math.abs(g.amount))}</span>
                </p>
              ))}
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            {s.events.map((e, k) => (
              <p key={k} style={{ fontSize: 12, color: C.mute, lineHeight: 1.8 }}>
                {`${jstDateLabel(getJapanDateString(new Date(e.created_at)))} ${jstTime(e.created_at)} ${e.type === 'completed' ? '確定' : '取消'} / ${e.actor_name ?? ''}${e.reason ? `（${e.reason}）` : ''}`}
              </p>
            ))}
          </div>
          {error && <p style={{ color: C.danger, fontSize: 14, marginTop: 10 }}>{error}</p>}
          {s.status === 'completed' && (voiding ? (
            <div style={{ marginTop: 14 }}>
              <Field label="取消の理由（必須）"><input value={reason} onChange={e => setReason(e.target.value)} maxLength={200} style={inputStyle} /></Field>
              <p style={{ fontSize: 12, color: C.mute, marginTop: 6 }}>会計は削除されず「取消」として残ります。使ったクーポンはお客様に戻ります。{(s.ginpay ?? []).some(g => g.type === 'payment') ? 'GINPayの支払いは同じ口座の残高に戻ります。' : ''}訂正は取消のあと会計し直してください。</p>
              <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                <SecondaryButton onClick={() => setVoiding(false)} disabled={busy}>やめる</SecondaryButton>
                <SecondaryButton danger onClick={() => void doVoid()} disabled={busy || !reason.trim()}>取消する</SecondaryButton>
              </div>
            </div>
          ) : <button type="button" onClick={() => setVoiding(true)} style={{ ...linkStyle, marginTop: 8 }}>この会計を取消</button>)}
        </>
      )}
    </Sheet>
  )
}

const navBtn: CSSProperties = { minWidth: 40, minHeight: 40, background: 'none', border: 'none', color: C.text, fontSize: 22, cursor: 'pointer', fontFamily: SANS }
const rowBtn: CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', minHeight: 52, padding: '10px 0', background: 'none', border: 'none',
  borderBottom: `1px solid ${C.line}`, fontFamily: SANS, fontSize: 14, cursor: 'pointer',
}
const cell: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
