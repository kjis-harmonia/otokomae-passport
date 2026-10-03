import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { getJapanDateString, addDaysToDateString } from '../../utils/dateUtils'
import { rpcErrorMessage } from '../../utils/staffSession'
import {
  jstDateLabel, jstIsoFromMinutes, jstMinutesOf, jstTime, yen, BLOCK_LABEL, SOURCE_LABEL, STATUS_LABEL,
  type BookingApi, type BookingOptions, type Ledger, type Reservation,
} from '../../utils/bookingApi'
import { C, SANS, linkStyle } from './ledgerTheme'
import { NewReservationFlow, type NewReservationPreset } from './NewReservationFlow'
import { ReservationDetail } from './ReservationDetail'
import { CustomerLedger } from './CustomerLedger'
import type { CustomerApi } from '../../utils/customerApi'
import type { GinpayClientApi } from '../../utils/ginpayApi'
import { Checkout } from './Checkout'
import type { CheckoutApi } from '../../utils/checkoutApi'

// 予約台帳（横＝時間、縦＝予約枠）。行は予約を受けるスタッフ（テイテイ・銀二郎）＋「フリー」。
// フリーは指名なし予約を表示する行で、3人目のスタッフではない。指名なし予約も実在のスタッフの時間を使うため、
// そのスタッフの行には「フリー」として使用中の時間を薄く表示する（同時に受けられる人数は増えない）。
// 店舗端末と本部で同じ画面を使い、api だけ差し替える。行・勤務時間・予約・ブロックはすべて day_ledger
// （予約エンジンと同じ effective_shifts）から。画面側で予約の可否は判定しない。

const SLOT_W = 44 // 15分の幅（30分の予約で名前が読める幅）
const LABEL_W = 92
const HEAD_H = 40
const LANE_MIN = 60 // 重なりがある行の1段の最小の高さ
const ROW_MIN = 96
const ROW_MAX = 190 // 3行が画面の高さに収まるよう、表示領域を3等分（上限・下限つき）
const REFRESH_MS = 30_000

/** 時間を占有している状態（DB の EXCLUDE 制約と同じ集合） */
const OCCUPYING = new Set(['confirmed', 'checked_in', 'in_service', 'awaiting_payment', 'completed'])

export interface LedgerActor {
  /** 記録に残る操作者名。未選択なら空 */
  name: string
  pick: () => void
}

type Item = { r: Reservation; kind: 'booking' | 'free-use'; a: number; b: number }
interface Row { key: string; name: string; staffId: string | null; shifts: [number, number][]; items: (Item & { lane: number })[]; lanes: number }

export function ReservationLedger({ api, customers, ginpay, checkout, actor, bottomGap = 0 }: {
  api: BookingApi
  /** 顧客台帳（予約から顧客を開く） */
  customers?: CustomerApi
  /** GINPay（顧客台帳内に表示） */
  ginpay?: GinpayClientApi
  /** 会計（店舗端末のみ。本部は会計を閲覧するだけ） */
  checkout?: CheckoutApi
  /** 店舗端末のみ。本部は「本部」として記録されるので不要 */
  actor?: LedgerActor
  /** 親の下余白（高さ計算用） */
  bottomGap?: number
}) {
  const today = getJapanDateString()
  const [date, setDate] = useState(today)
  const [ledger, setLedger] = useState<Ledger | null>(null)
  const [options, setOptions] = useState<BookingOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showCancelled, setShowCancelled] = useState(false)
  const [detail, setDetail] = useState<Reservation | null>(null)
  const [creating, setCreating] = useState<NewReservationPreset | null>(null)
  const [customerOf, setCustomerOf] = useState<string | null>(null)
  // 会計：予約から（予約ID）／予約なしの店頭会計（null）
  const [checkoutFor, setCheckoutFor] = useState<{ reservationId: string | null } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<{ row: string; minutes: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrolledFor = useRef<string | null>(null)
  const [height, setHeight] = useState<number | null>(null)
  const [viewH, setViewH] = useState(0)

  const ensureActor = useCallback(() => {
    if (!actor || actor.name) return true
    actor.pick()
    return false
  }, [actor])

  // ── 読み込み・自動更新（画面が見えている間だけ） ──
  const dateRef = useRef(date)
  const load = useCallback(async (d: string) => {
    try {
      const l = await api.ledger(d)
      if (dateRef.current !== d) return
      setLedger(l); setError(null); setNow(Date.now())
    } catch (err) {
      if (dateRef.current === d) setError(rpcErrorMessage(err, '予約台帳を読み込めませんでした。'))
    }
  }, [api])

  useEffect(() => {
    api.options().then(setOptions).catch(err => setError(rpcErrorMessage(err, '予約設定を読み込めませんでした。')))
  }, [api])
  useEffect(() => { dateRef.current = date; setLedger(null); setPending(null); void load(date) }, [date, load]) // eslint-disable-line react-hooks/set-state-in-effect

  useEffect(() => {
    let timer: number | undefined
    const start = () => { if (timer === undefined) timer = window.setInterval(() => void load(dateRef.current), REFRESH_MS) }
    const stop = () => { if (timer !== undefined) { window.clearInterval(timer); timer = undefined } }
    const onVisible = () => {
      if (document.visibilityState === 'visible') { void load(dateRef.current); start() } else stop()
    }
    const onFocus = () => void load(dateRef.current)
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    return () => { stop(); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onFocus) }
  }, [load])

  // ── 高さ：画面の残りいっぱい。行の高さは表示領域に合わせて広げる ──
  useLayoutEffect(() => {
    const measure = () => {
      const top = rootRef.current?.getBoundingClientRect().top ?? 0
      setHeight(Math.max(360, Math.floor(window.innerHeight - top - bottomGap)))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [bottomGap])
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── 表示範囲：営業時間（なければ勤務時間の範囲）。範囲外の予約があれば広げる ──
  const view = useMemo(() => {
    if (!ledger) return null
    const d = ledger.date
    const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
    let a = Infinity, b = -Infinity
    const bh = ledger.business_hours
    if (bh && !bh.is_closed && bh.open_time && bh.close_time) { a = toMin(bh.open_time); b = toMin(bh.close_time) }
    else for (const s of ledger.staff) for (const r of s.shifts) { a = Math.min(a, jstMinutesOf(r.start, d)); b = Math.max(b, jstMinutesOf(r.end, d)) }
    if (a === Infinity) { a = 10 * 60; b = 20 * 60 }
    for (const r of ledger.reservations) {
      if (r.status === 'cancelled' && !showCancelled) continue
      a = Math.min(a, jstMinutesOf(r.starts_at, d)); b = Math.max(b, jstMinutesOf(r.occupied_until, d))
    }
    a = Math.max(0, Math.floor(a / 60) * 60)
    b = Math.min(24 * 60, Math.ceil(b / 60) * 60)
    return { start: a, end: b }
  }, [ledger, showCancelled])

  const x = useCallback((min: number) => view ? (min - view.start) / 15 * SLOT_W : 0, [view])
  const nowMin = ledger && ledger.date === getJapanDateString(new Date(now)) ? jstMinutesOf(new Date(now).toISOString(), ledger.date) : null
  const isPastDay = !!ledger && ledger.date < getJapanDateString(new Date(now))

  // ── 行：スタッフ（並び順）＋フリー。重なる予約は段を分ける ──
  const rows = useMemo<Row[]>(() => {
    if (!ledger) return []
    const d = ledger.date
    const visible = ledger.reservations.filter(r => showCancelled || r.status !== 'cancelled')
    const item = (r: Reservation, kind: Item['kind']): Item => ({ r, kind, a: jstMinutesOf(r.starts_at, d), b: jstMinutesOf(r.occupied_until, d) })
    const pack = (items: Item[]) => {
      const ends: number[] = []
      const out = [...items].sort((p, q) => p.a - q.a || Number(OCCUPYING.has(q.r.status)) - Number(OCCUPYING.has(p.r.status))).map(it => {
        let lane = ends.findIndex(e => e <= it.a)
        if (lane < 0) { lane = ends.length; ends.push(it.b) } else ends[lane] = it.b
        return { ...it, lane }
      })
      return { items: out, lanes: Math.max(1, ends.length) }
    }
    const shiftsOf = (s: Ledger['staff'][number]) => s.shifts.map(r => [jstMinutesOf(r.start, d), jstMinutesOf(r.end, d)] as [number, number])
    const staffRows: Row[] = ledger.staff.map(s => ({
      key: s.id, name: s.name, staffId: s.id, shifts: shiftsOf(s),
      ...pack([
        ...visible.filter(r => r.staff_id === s.id && r.nominated).map(r => item(r, 'booking')),
        ...visible.filter(r => r.staff_id === s.id && !r.nominated && OCCUPYING.has(r.status)).map(r => item(r, 'free-use')),
      ]),
    }))
    const free = pack(visible.filter(r => !r.nominated).map(r => item(r, 'booking')))
    return [...staffRows, { key: 'free', name: 'フリー', staffId: null, shifts: ledger.staff.flatMap(shiftsOf), ...free }]
  }, [ledger, showCancelled])

  const fillH = rows.length ? Math.floor((viewH - HEAD_H - 1) / rows.length) : 0
  const rowH = (row: Row) => Math.max(row.lanes * LANE_MIN, Math.min(ROW_MAX, Math.max(ROW_MIN, fillH)))

  // 今日を開いたら現在時刻が左寄りに見える位置へ（日付ごとに1回）
  useLayoutEffect(() => {
    if (!ledger || !view || !scrollRef.current || scrolledFor.current === ledger.date) return
    scrolledFor.current = ledger.date
    const el = scrollRef.current
    el.scrollLeft = nowMin !== null ? Math.max(0, x(nowMin) - (el.clientWidth - LABEL_W) * 0.3) : 0
  }, [ledger, view, nowMin, x])

  const counts = useMemo(() => {
    const all = ledger?.reservations ?? []
    const booked = all.filter(r => OCCUPYING.has(r.status)).length
    const done = all.filter(r => r.status === 'completed').length
    return { booked, done, rest: booked - done, noShow: all.filter(r => r.status === 'no_show').length, cancelled: all.filter(r => r.status === 'cancelled').length }
  }, [ledger])

  function afterChange(r: Reservation) {
    setDetail(r)
    void load(date)
  }

  function tapRow(row: Row, offsetX: number) {
    if (!ledger || !view || isPastDay) return
    const minutes = view.start + Math.floor(offsetX / SLOT_W) * 15
    const working = row.shifts.some(([a, b]) => a <= minutes && minutes < b)
    if (!working || (nowMin !== null && minutes + 15 <= nowMin)) { setPending(null); return }
    // 1回目は選択だけ。誤操作を避けるため、登録は下の確認バーから
    setPending(pending && pending.row === row.key && pending.minutes === minutes ? null : { row: row.key, minutes })
  }

  const bodyW = view ? x(view.end) : 0
  const hours = view ? Array.from({ length: (view.end - view.start) / 60 + 1 }, (_, i) => view.start + i * 60) : []
  const pendingRow = pending && rows.find(r => r.key === pending.row)

  return (
    <div ref={rootRef} style={{ height: height ?? undefined, display: 'flex', flexDirection: 'column', background: C.bg, color: C.text, fontFamily: SANS, minWidth: 0 }}>
      {/* ── 日付・操作 ── */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 12, rowGap: 2, padding: '6px 12px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <button type="button" aria-label="前の日" onClick={() => setDate(addDaysToDateString(date, -1))} style={navBtn}>‹</button>
          <span style={{ position: 'relative', fontSize: 18, fontWeight: 600, padding: '0 4px', minWidth: 132, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
            {jstDateLabel(date)}
            {/* 日付をタップすると任意の日付へ（OS 標準の日付選択） */}
            <input type="date" value={date} aria-label="日付を選ぶ" onChange={e => e.target.value && setDate(e.target.value)}
              style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', cursor: 'pointer', colorScheme: 'light' }} />
          </span>
          <button type="button" aria-label="次の日" onClick={() => setDate(addDaysToDateString(date, 1))} style={navBtn}>›</button>
          {date !== today && <button type="button" onClick={() => setDate(today)} style={{ ...linkStyle, marginLeft: 8, color: C.text }}>今日</button>}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
          {actor && (
            <button type="button" onClick={actor.pick} style={linkStyle}>操作者 {actor.name || '未選択'}</button>
          )}
          {checkout && (
            <button type="button" onClick={() => { setPending(null); setCheckoutFor({ reservationId: null }) }} style={{ ...linkStyle, color: C.text }}>店頭会計</button>
          )}
          <button type="button" disabled={!options}
            onClick={() => { setPending(null); setCreating({ date: date < today ? today : date }) }}
            style={{ minHeight: 40, padding: '0 16px', borderRadius: 8, fontSize: 15, fontWeight: 600, fontFamily: SANS, background: C.text, color: C.bg, border: 'none', cursor: 'pointer', opacity: options ? 1 : 0.5 }}>
            新規予約
          </button>
        </div>
      </div>

      {/* ── 1行サマリー ── */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 14, padding: '0 12px', minHeight: 36, fontSize: 14, color: C.sub, fontVariantNumeric: 'tabular-nums' }}>
        {ledger?.closure ? <span style={{ color: C.text }}>休業日{ledger.closure.reason ? `（${ledger.closure.reason}）` : ''}</span> : null}
        <span>予約 <b style={{ color: C.text, fontWeight: 600 }}>{counts.booked}</b>名</span>
        <span>完了 <b style={{ color: C.text, fontWeight: 600 }}>{counts.done}</b>名</span>
        <span>残り <b style={{ color: C.text, fontWeight: 600 }}>{counts.rest}</b>名</span>
        {counts.noShow > 0 && <span>無断キャンセル {counts.noShow}名</span>}
        {counts.cancelled > 0 && (
          <button type="button" onClick={() => setShowCancelled(v => !v)} style={{ ...linkStyle, minHeight: 36, fontSize: 14 }}>
            キャンセル {counts.cancelled}件{showCancelled ? 'を隠す' : 'を表示'}
          </button>
        )}
        {notice && <span role="status" style={{ color: C.text }}>{notice}</span>}
        {error && (
          <span style={{ color: C.danger }}>{error} <button type="button" onClick={() => void load(date)} style={{ ...linkStyle, minHeight: 36, color: C.danger }}>再読み込み</button></span>
        )}
      </div>

      {/* ── タイムライン（時間方向に横スクロール） ── */}
      <div ref={scrollRef} style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', borderTop: `1px solid ${C.line}`, overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}>
        {!ledger || !view ? (
          <p style={{ padding: 16, color: C.sub, fontSize: 14 }}>{error ? '' : '読み込み中…'}</p>
        ) : ledger.staff.length === 0 ? (
          <p style={{ padding: 16, color: C.sub, fontSize: 14 }}>予約を受けるスタッフがいません。本部の予約設定でスタッフを登録してください。</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: `${LABEL_W}px ${bodyW}px`, width: LABEL_W + bodyW }}>
            {/* 時間目盛り（固定） */}
            <div style={{ ...headCell, left: 0, zIndex: 6, borderRight: `1px solid ${C.line}` }} />
            <div style={{ ...headCell, zIndex: 5 }}>
              {hours.filter(m => nowMin === null || Math.abs(m - nowMin) >= 25).map(m => (
                <span key={m} style={{
                  position: 'absolute', left: x(m) + 6, top: 0, lineHeight: `${HEAD_H}px`, fontSize: 13, whiteSpace: 'nowrap',
                  color: (nowMin !== null && m + 60 <= nowMin) || isPastDay ? C.mute : C.sub, fontVariantNumeric: 'tabular-nums',
                }}>{`${Math.floor(m / 60)}:00`}</span>
              ))}
              {hours.map(m => <span key={`t${m}`} style={{ position: 'absolute', left: x(m), bottom: 0, width: 1, height: 10, background: C.lineStrong }} />)}
              {nowMin !== null && nowMin >= view.start && nowMin <= view.end && (
                <span style={{ position: 'absolute', left: x(nowMin) - 22, top: 0, width: 44, textAlign: 'center', lineHeight: `${HEAD_H}px`, fontSize: 13, color: C.text, background: C.bg, fontVariantNumeric: 'tabular-nums' }}>
                  {jstTime(new Date(now).toISOString())}
                </span>
              )}
            </div>

            {rows.map(row => (
              <RowView
                key={row.key}
                row={row}
                ledger={ledger}
                view={view}
                x={x}
                width={bodyW}
                height={rowH(row)}
                nowMin={nowMin}
                pastDay={isPastDay}
                pending={pending?.row === row.key ? pending.minutes : null}
                onTapEmpty={off => tapRow(row, off)}
                onOpen={r => { setPending(null); setNotice(null); setDetail(r) }}
              />
            ))}
          </div>
        )}
      </div>

      {/* 空き枠の確認バー（2回目の操作で新規予約へ） */}
      {pending && pendingRow && ledger && (
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px calc(10px + env(safe-area-inset-bottom, 0px))', borderTop: `1px solid ${C.lineStrong}`, background: C.surface }}>
          <span style={{ fontSize: 15, flex: 1, minWidth: 0, fontVariantNumeric: 'tabular-nums' }}>
            {jstTime(jstIsoFromMinutes(ledger.date, pending.minutes))} {pendingRow.name}
          </span>
          <button type="button" onClick={() => setPending(null)} style={linkStyle}>やめる</button>
          <button type="button" disabled={!options}
            onClick={() => { setCreating({ date: ledger.date, minutes: pending.minutes, staffId: pendingRow.staffId }); setPending(null) }}
            style={{ minHeight: 44, padding: '0 18px', borderRadius: 8, fontSize: 15, fontWeight: 600, fontFamily: SANS, background: C.text, color: C.bg, border: 'none', cursor: 'pointer' }}>
            この時間で予約
          </button>
        </div>
      )}

      {detail && options && (
        <ReservationDetail
          key={detail.id + detail.status + detail.starts_at + detail.staff_id + String(detail.staff_confirmed)}
          api={api}
          options={options}
          reservation={detail}
          ensureActor={ensureActor}
          onClose={() => setDetail(null)}
          onChanged={afterChange}
          onOpenCustomer={customers ? () => setCustomerOf(detail.id) : undefined}
          onCheckout={checkout ? () => setCheckoutFor({ reservationId: detail.id }) : undefined}
        />
      )}
      {checkoutFor && checkout && (
        <Checkout
          api={checkout}
          customers={customers}
          reservationId={checkoutFor.reservationId}
          ensureActor={ensureActor}
          onClose={() => setCheckoutFor(null)}
          onDone={sale => {
            // 会計を確定したら予約台帳へ戻る（予約は完了になっている）
            setCheckoutFor(null); setDetail(null)
            setNotice(`会計を確定しました ${sale.client?.name ?? sale.customer_name ?? ''} ${yen(sale.total)}`)
            void load(date)
          }}
        />
      )}
      {customerOf && customers && (
        <CustomerLedger
          api={customers}
          ginpayApi={ginpay}
          target={{ reservationId: customerOf }}
          ensureActor={ensureActor}
          onClose={() => { setCustomerOf(null); setDetail(null); void load(date) }}
          onChanged={() => void load(date)}
        />
      )}
      {creating && options && (
        <NewReservationFlow
          api={api}
          options={options}
          preset={creating}
          ensureActor={ensureActor}
          findClients={customers ? q => customers.candidates(null, q) : undefined}
          onClose={() => setCreating(null)}
          onDone={r => {
            setCreating(null)
            const d = getJapanDateString(new Date(r.starts_at))
            if (d === date) void load(d); else setDate(d)
          }}
        />
      )}
    </div>
  )
}

const navBtn: CSSProperties = {
  minWidth: 44, minHeight: 44, background: 'none', border: 'none', color: C.text, fontSize: 24, lineHeight: 1, cursor: 'pointer', fontFamily: SANS,
}
const headCell: CSSProperties = {
  position: 'sticky', top: 0, height: HEAD_H, background: C.bg, borderBottom: `1px solid ${C.line}`,
}

// ── 1行（スタッフ または フリー） ─────────────────────────────────────────────

// 勤務時間外：ごく薄い斜線（予約できない時間）
const OFF_HOURS_BG = `repeating-linear-gradient(135deg, ${C.offHours} 0 7px, #ECECE8 7px 8px)`

function RowView({ row, ledger, view, x, width, height, nowMin, pastDay, pending, onTapEmpty, onOpen }: {
  row: Row
  ledger: Ledger
  view: { start: number; end: number }
  x: (min: number) => number
  width: number
  height: number
  nowMin: number | null
  pastDay: boolean
  pending: number | null
  onTapEmpty: (offsetX: number) => void
  onOpen: (r: Reservation) => void
}) {
  const d = ledger.date
  const lines: number[] = []
  for (let m = view.start + 30; m < view.end; m += 30) lines.push(m)
  const blocks = row.staffId ? ledger.blocks.filter(b => b.staff_id === null || b.staff_id === row.staffId) : []
  const pastEnd = pastDay ? view.end : nowMin
  const laneH = height / row.lanes
  const free = row.staffId === null
  const off = row.shifts.length === 0
  // フリー行はスタッフ行と罫線で区切る（別の種類の行であることを示す）
  const divider = free ? `1px solid ${C.lineStrong}` : undefined

  return (
    <>
      {/* 行の名前（横スクロールしても固定） */}
      <div style={{
        position: 'sticky', left: 0, zIndex: 5, height, boxSizing: 'border-box', padding: '12px 14px', background: C.bg,
        borderRight: `1px solid ${C.line}`, borderBottom: `1px solid ${C.line}`, borderTop: divider,
      }}>
        <span style={{ display: 'block', fontSize: 15, fontWeight: 600, color: off && !free ? C.mute : C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.name}</span>
        {free && <span style={{ display: 'block', fontSize: 12, color: C.mute, marginTop: 3 }}>指名なし</span>}
        {off && !free && <span style={{ display: 'block', fontSize: 12, color: C.mute, marginTop: 3 }}>休み</span>}
      </div>
      <div
        onClick={e => onTapEmpty(e.clientX - e.currentTarget.getBoundingClientRect().left)}
        style={{
          position: 'relative', width, height, boxSizing: 'border-box', background: OFF_HOURS_BG, cursor: pastDay ? 'default' : 'pointer',
          borderBottom: `1px solid ${C.line}`, borderTop: divider,
        }}
      >
        {/* 勤務時間＝白（空いている所がそのまま白く見える）。フリー行は誰かが勤務している時間 */}
        {row.shifts.map(([sa, sb], i) => {
          const a = Math.max(view.start, sa), b = Math.min(view.end, sb)
          return b > a ? <div key={i} style={{ position: 'absolute', top: 0, bottom: 0, left: x(a), width: x(b) - x(a), background: C.bg }} /> : null
        })}
        {/* 罫線：1時間は実線、30分はごく薄く */}
        {lines.map(m => (
          <div key={m} style={{ position: 'absolute', top: 0, bottom: 0, left: x(m), width: 1, background: m % 60 === 0 ? C.line : C.lineSoft }} />
        ))}
        {/* 過ぎた時間はわずかに沈める */}
        {pastEnd !== null && pastEnd > view.start && (
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: x(Math.min(pastEnd, view.end)), background: 'rgba(27,27,26,0.035)' }} />
        )}
        {/* 予定ブロック（休憩など） */}
        {blocks.map(b => {
          const a = Math.max(view.start, jstMinutesOf(b.starts_at, d)), e = Math.min(view.end, jstMinutesOf(b.ends_at, d))
          if (e <= a) return null
          return (
            <div key={b.id} onClick={ev => ev.stopPropagation()} style={{ position: 'absolute', top: 0, bottom: 0, left: x(a), width: x(e) - x(a), background: OFF_HOURS_BG, cursor: 'default' }}>
              <span style={{ display: 'block', padding: '10px 9px', fontSize: 12, color: C.mute }}>{BLOCK_LABEL[b.kind] ?? '予定'}</span>
            </div>
          )
        })}
        {/* 空き枠の選択（1回目のタップ） */}
        {pending !== null && (
          <div style={{ position: 'absolute', top: 4, bottom: 4, left: x(pending) + 2, width: SLOT_W - 4, border: `1.5px solid ${C.text}`, borderRadius: 4, boxSizing: 'border-box', pointerEvents: 'none' }} />
        )}
        {/* 予約 */}
        {row.items.map(it => it.kind === 'free-use'
          ? <FreeHold key={it.r.id} it={it} x={x} top={it.lane * laneH} h={laneH} />
          : <Block key={it.r.id} r={it.r} d={d} x={x} top={it.lane * laneH} h={laneH} freeRow={free} onOpen={onOpen} />)}
        {/* 現在時刻 */}
        {nowMin !== null && nowMin >= view.start && nowMin <= view.end && (
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: x(nowMin), width: 1, background: C.text, opacity: 0.55, pointerEvents: 'none', zIndex: 4 }} />
        )}
      </div>
    </>
  )
}

// ── 予約ブロック ──────────────────────────────────────────────────────────────
// 主情報はお客様名とメニュー。状態は面の濃さと左の細い線で表し、文字では小さな補助情報にする。

const BLOCK_STYLE: Record<Reservation['status'], CSSProperties> = {
  confirmed: { background: C.booked, border: `1px solid ${C.bookedLine}` },
  checked_in: { background: C.active, border: `1px solid ${C.bookedLine}`, boxShadow: `inset 2px 0 0 ${C.text}` },
  in_service: { background: C.active, border: `1px solid ${C.bookedLine}`, boxShadow: `inset 2px 0 0 ${C.text}` },
  awaiting_payment: { background: C.active, border: `1px solid ${C.bookedLine}`, boxShadow: `inset 2px 0 0 ${C.accent}` },
  completed: { background: '#F8F8F6', border: `1px solid ${C.line}` },
  no_show: { background: 'transparent', border: `1px dashed ${C.lineStrong}` },
  cancelled: { background: 'transparent', border: `1px dashed ${C.line}` },
}

function Block({ r, d, x, top, h, freeRow, onOpen }: {
  r: Reservation; d: string; x: (min: number) => number; top: number; h: number; freeRow: boolean; onOpen: (r: Reservation) => void
}) {
  const a = jstMinutesOf(r.starts_at, d), e = jstMinutesOf(r.ends_at, d), o = jstMinutesOf(r.occupied_until, d)
  const left = x(a), w = Math.max(SLOT_W, x(e) - left), cleanW = x(o) - x(e)
  const struck = r.status === 'cancelled' || r.status === 'no_show'
  const quiet = struck || r.status === 'completed'
  const menu = r.items.map(i => i.name).join('・')
  const status = r.status === 'confirmed' ? null : STATUS_LABEL[r.status]
  // 補助情報（小さく）：フリー行は時間を確保している担当（狭い枠でも「仮」が残るよう先頭に）、どちらの行も予約経路
  const aux = [freeRow ? `${r.staff_confirmed ? '' : '仮 '}${r.staff_name}` : null, SOURCE_LABEL[r.source]].filter(Boolean).join('・')
  const label = `${jstTime(r.starts_at)} ${r.customer_name} ${menu} ${r.staff_name}${r.nominated ? '' : r.staff_confirmed ? '（フリー）' : '（フリー・仮）'} ${SOURCE_LABEL[r.source]}${status ? ` ${status}` : ''}`
  const text: CSSProperties = { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
  const z = OCCUPYING.has(r.status) ? 3 : 1
  const showAux = h - 8 >= 64
  return (
    <>
      <button
        type="button"
        aria-label={label}
        onClick={ev => { ev.stopPropagation(); onOpen(r) }}
        style={{
          position: 'absolute', left: left + 2, width: w - 3, top: top + 4, height: h - 8, zIndex: z,
          boxSizing: 'border-box', borderRadius: 4, padding: '8px 9px', textAlign: 'left', fontFamily: SANS, cursor: 'pointer',
          display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', alignItems: 'stretch', gap: 2,
          overflow: 'hidden', color: quiet ? C.mute : C.text, ...BLOCK_STYLE[r.status],
          opacity: r.status === 'cancelled' ? 0.75 : 1,
        }}
      >
        <span style={{ ...text, fontSize: 14, lineHeight: '19px', fontWeight: 600, color: quiet ? C.sub : C.text, textDecoration: struck ? 'line-through' : undefined }}>{r.customer_name}</span>
        <span style={{ ...text, fontSize: 13, lineHeight: '18px', color: quiet ? C.mute : C.sub }}>{menu}</span>
        {showAux && (
          <span style={{ ...text, marginTop: 4, fontSize: 11, lineHeight: '15px', color: C.mute }}>
            {status && <span style={{ color: r.status === 'awaiting_payment' ? C.accent : C.sub }}>{status}</span>}
            {status && aux ? '・' : ''}{aux}
          </span>
        )}
      </button>
      {cleanW > 0 && (
        <div onClick={ev => ev.stopPropagation()} aria-hidden="true" style={{
          position: 'absolute', left: left + w - 1, width: cleanW - 1, top: top + 4, height: h - 8, zIndex: z, boxSizing: 'border-box',
          borderTop: `1px dashed ${C.bookedLine}`, borderRight: `1px dashed ${C.bookedLine}`, borderBottom: `1px dashed ${C.bookedLine}`,
          borderRadius: '0 4px 4px 0', opacity: struck ? 0.5 : 1, cursor: 'default',
        }}>
          {cleanW >= 38 && <span style={{ display: 'block', padding: '9px 4px', fontSize: 11, lineHeight: '14px', color: C.mute, whiteSpace: 'nowrap', overflow: 'hidden' }}>片付け</span>}
        </div>
      )}
    </>
  )
}

/**
 * スタッフ行：フリー予約が確保しているこのスタッフの時間。予約そのものはフリー行にだけ表示し、
 * ここは占有されていることだけが分かる薄い帯にする（同じ予約が2件あるように見せない）
 */
function FreeHold({ it, x, top, h }: { it: Item; x: (min: number) => number; top: number; h: number }) {
  const r = it.r
  const left = x(it.a), w = x(it.b) - left
  return (
    <div
      role="img"
      aria-label={`フリー予約で使用中 ${jstTime(r.starts_at)}〜${jstTime(r.occupied_until)}`}
      onClick={ev => ev.stopPropagation()}
      style={{
        position: 'absolute', left: left + 2, width: w - 3, top: top + 4, height: h - 8, zIndex: 2, boxSizing: 'border-box',
        borderRadius: 4, background: C.held, cursor: 'default', overflow: 'hidden', display: 'flex', alignItems: 'flex-end',
      }}
    >
      <span style={{ display: 'block', padding: '9px 9px', fontSize: 11, lineHeight: '14px', color: C.mute, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        フリー{r.staff_confirmed ? '' : '・仮'}
      </span>
    </div>
  )
}
