import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { CalendarDays, Check, ChevronLeft, ChevronRight, Circle, Clipboard, FileClock, List, LoaderCircle, Plus, RefreshCw, UserRound } from 'lucide-react'
import { addDaysToDateString, getJapanDateString } from '../utils/dateUtils'
import { jstDateLabel, jstMinutesOf, jstTime, STATUS_LABEL, yen } from '../utils/bookingApi'
import { callStaffRpc } from './sbRpc'
import { sbApi, sbError, salonBoardCopy, type SbOutcome } from './sbApi'
import { sbPending, subscribeSbPending } from './sbPending'
import type { SbCommand, SbLedger, SbOptions, SbReservation, TransferStatus } from './sbTypes'
import { SbBookingEditor, type SbPreset } from './SbBookingEditor'
import { SbModal } from './SbModal'
import { SbCommandBar } from './SbCommandBar'
import { SbToday } from './SbToday'
import './sb.css'

const ACTOR = 'ginjiro_staff_name'
const OCCUPYING = new Set(['confirmed', 'checked_in', 'in_service', 'awaiting_payment', 'completed'])
const TRANSFER: Record<TransferStatus, string> = { pending: '未転記', done: '転記済み', not_required: '転記不要' }
const SLOT_W = 44
const LABEL_W = 96
const LANE_H = 84
const loadActor = () => { try { return localStorage.getItem(ACTOR) ? JSON.parse(localStorage.getItem(ACTOR)!) as string : '' } catch { return '' } }
function errorText(err: unknown) { return sbError(err instanceof Error && !(err instanceof TypeError) ? err.message : err) }

export function SbScreen() {
  const today = getJapanDateString()
  const [date, setDate] = useState(today)
  const [ledger, setLedger] = useState<SbLedger | null>(null)
  const [options, setOptions] = useState<SbOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [actor, setActorState] = useState(loadActor)
  const [pickActor, setPickActor] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ preset: SbPreset; reservation?: SbReservation } | null>(null)
  const [view, setView] = useState<'board' | 'list'>('board')
  const [archive, setArchive] = useState<'cancelled' | 'transfer' | null>(null)
  const [busy, setBusy] = useState(false)
  const [updated, setUpdated] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  const [online, setOnline] = useState(navigator.onLine)
  const pending = useSyncExternalStore(subscribeSbPending, sbPending.read)
  const sending = useRef(false)
  const generation = useRef(0)
  const dateRef = useRef(date)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrolled = useRef<string | null>(null)
  const blocked = busy || !!pending.pending || !!pending.error || !online || !!error

  const setActor = (name: string) => {
    setActorState(name)
    try { localStorage.setItem(ACTOR, JSON.stringify(name)) } catch { /* Sending fails closed if persistence is unavailable. */ }
  }
  const refresh = useCallback(async (d: string) => {
    const gen = ++generation.current
    try {
      const value = await sbApi.ledger(d)
      if (gen !== generation.current || dateRef.current !== d) return
      if (!value || !Array.isArray(value.staff) || !Array.isArray(value.reservations)) throw new Error('invalid_response')
      setLedger(value); setError(null); setUpdated(jstTime(new Date().toISOString()))
    } catch { if (gen === generation.current && dateRef.current === d) setError('予約表を取得できません。接続とSBのサーバー設定を確認してください。') }
  }, [])
  const loadOptions = useCallback(async () => {
    try { const value = await sbApi.options(); if (!Array.isArray(value.actors) || !Array.isArray(value.menus)) throw new Error(); setOptions(value) }
    catch { setError('予約設定を取得できません。SB用migrationの適用・端末認証を確認してください。') }
  }, [])
  useEffect(() => { void loadOptions() }, [loadOptions]) // eslint-disable-line react-hooks/set-state-in-effect -- 通信の結果で設定を入れる（同期的な setState ではない）
  useEffect(() => {
    dateRef.current = date; setLedger(null); setSelectedId(null) // eslint-disable-line react-hooks/set-state-in-effect
    void refresh(date)
    return () => { generation.current++ }
  }, [date, refresh])
  useEffect(() => {
    const reload = () => { if (document.visibilityState === 'visible') void refresh(dateRef.current) }
    const connection = () => { setOnline(navigator.onLine); if (navigator.onLine) { reload(); void loadOptions() } }
    const timer = window.setInterval(reload, 30000)
    const clock = window.setInterval(() => setNow(Date.now()), 30000)
    document.addEventListener('visibilitychange', reload); window.addEventListener('focus', reload)
    window.addEventListener('online', connection); window.addEventListener('offline', connection)
    return () => { clearInterval(timer); clearInterval(clock); document.removeEventListener('visibilitychange', reload); window.removeEventListener('focus', reload); window.removeEventListener('online', connection); window.removeEventListener('offline', connection) }
  }, [refresh, loadOptions])
  const range = useMemo(() => {
    const times = (ledger?.staff ?? []).flatMap(s => s.shifts.flatMap(t => [jstMinutesOf(t.start, date), jstMinutesOf(t.end, date)]))
    for (const r of ledger?.reservations ?? []) times.push(jstMinutesOf(r.starts_at, date), jstMinutesOf(r.occupied_until, date))
    if (ledger?.business_hours?.open_time && ledger.business_hours.close_time) for (const t of [ledger.business_hours.open_time, ledger.business_hours.close_time]) { const [h, m] = t.split(':').map(Number); times.push(h * 60 + m) }
    return { start: times.length ? Math.max(0, Math.floor(Math.min(...times) / 60) * 60) : 9 * 60,
      end: times.length ? Math.min(1440, Math.ceil(Math.max(...times) / 60) * 60) : 20 * 60 }
  }, [ledger, date])
  const x = useCallback((minute: number) => (minute - range.start) / 15 * SLOT_W, [range.start])
  const minutesNow = date === getJapanDateString(new Date(now)) ? jstMinutesOf(new Date(now).toISOString(), date) : null
  useEffect(() => {
    if (!ledger || !scrollRef.current || scrolled.current === date) return
    scrolled.current = date
    scrollRef.current.scrollLeft = minutesNow !== null ? Math.max(0, x(minutesNow) - 96) : 0
  }, [ledger, date, minutesNow, x])
  const selected = ledger?.reservations.find(r => r.id === selectedId)
  const active = ledger?.reservations.filter(r => OCCUPYING.has(r.status)) ?? []
  const cancelled = ledger?.reservations.filter(r => r.status === 'cancelled' || r.status === 'no_show') ?? []
  const toTransfer = ledger?.reservations.filter(r => r.transfer_status === 'pending') ?? []

  const applyOutcome = async (result: SbOutcome) => {
    setEditor(null); setSelectedId(null)
    if (!result.ok) { setNotice(sbError(result.error)); await refresh(dateRef.current); return }
    const d = getJapanDateString(new Date(result.reservation.starts_at))
    setNotice('予約を更新しました。')
    if (d !== dateRef.current) setDate(d)
    else { await refresh(d); setSelectedId(result.reservation.id) }
  }
  async function send(command: SbCommand) {
    if (sending.current || blocked) return
    if (!options?.actors.some(a => a.name === actor)) { setPickActor(true); return }
    sending.current = true; setBusy(true); setNotice(null)
    try { await applyOutcome(await sbPending.start(command, actor, sbApi.mutate)) }
    catch (err) { setEditor(null); setSelectedId(null); setNotice(errorText(err)) }
    finally { sending.current = false; setBusy(false) }
  }
  async function retry() {
    const current = sbPending.read()
    if (sending.current || current.error || !current.pending) return
    sending.current = true; setBusy(true); setNotice(null)
    try { await applyOutcome(await sbPending.retry(current.pending.id, sbApi.mutate)) }
    catch (err) { setNotice(errorText(err)) }
    finally { sending.current = false; setBusy(false) }
  }
  function newBooking(preset: SbPreset) {
    if (blocked || !options) return
    setNotice(null); setEditor({ preset })
  }
  const list = archive === 'cancelled' ? cancelled : archive === 'transfer' ? toTransfer : ledger?.reservations ?? []
  return <div className="sb-app">
    <header className="sb-toolbar"><h1><span className="sb-wordmark">銀二郎</span><span className="sb-mark">SB</span></h1>
      <div className="sb-date-nav"><button className="sb-nav" aria-label="前の日" title="前の日" onClick={() => setDate(addDaysToDateString(date, -1))}><ChevronLeft size={24} /></button>
        <label className="sb-date-label"><span>{jstDateLabel(date)}</span><input type="date" aria-label="予約表の日付" value={date} onChange={e => e.target.value && setDate(e.target.value)} /></label>
        <button className="sb-nav" aria-label="次の日" title="次の日" onClick={() => setDate(addDaysToDateString(date, 1))}><ChevronRight size={24} /></button><button className="sb-secondary sb-today" onClick={() => setDate(today)}>今日</button></div>
      <div className="sb-toolbar-actions"><button className="sb-actor" disabled={busy || !!pending.pending} onClick={() => setPickActor(true)}><UserRound size={18} /><span>{options?.actors.some(a => a.name === actor) ? actor : '操作者'}</span></button>
        <button className="sb-primary" disabled={blocked || !options} onClick={() => newBooking({ date: date < today ? today : date })}><Plus size={19} />新規予約</button></div>
    </header>
    <SbCommandBar options={options} disabled={blocked} onDraft={draft => newBooking({ date: draft.date < today ? today : draft.date, minutes: draft.minutes ?? undefined, staffId: draft.staffId, draft })} />
    {(pending.error || pending.pending || !online || error) && <div className="sb-alert" role="alert">
      <span>{pending.error ? sbError('storage_error') : pending.pending ? '送信済み予約の結果確認が必要です。新しい予約の送信は停止中です。' : !online ? 'オフラインです。予約の登録・変更はできません。' : error}</span>
      {pending.pending && !pending.error && <button className="sb-secondary" disabled={busy || !online} onClick={() => void retry()}>{busy ? '確認中…' : '同じ内容で結果を確認'}</button>}
      {!pending.pending && !pending.error && online && <button className="sb-icon" aria-label="再読み込み" onClick={() => { void refresh(date); void loadOptions() }}><RefreshCw size={18} /></button>}
    </div>}
    {ledger && date === today && <SbToday ledger={ledger} now={now} blocked={blocked} onOpen={setSelectedId}
      onNew={p => newBooking({ date, minutes: p.minutes, staffId: p.staffId })} onTransfer={() => setArchive('transfer')} />}
    <div className="sb-board-toolbar"><div className="sb-legend"><span><i className="sb-dot sb-blue" />予約</span><span><i className="sb-dot sb-green" />来店済み</span><span><FileClock size={13} />未転記</span></div>
      <div className="sb-view-picker" role="group" aria-label="予約の表示"><button className="sb-icon" aria-label="予約表" title="予約表" aria-pressed={view === 'board'} onClick={() => setView('board')}><CalendarDays size={19} /></button><button className="sb-icon" aria-label="予約一覧" title="予約一覧" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={19} /></button><button className="sb-icon" aria-label="予約表を更新" title="更新" disabled={busy} onClick={() => void refresh(date)}><RefreshCw size={18} /></button></div></div>
    {notice && <p className="sb-notice" role="status">{notice}</p>}
    {!ledger ? <div className="sb-empty">{error ? '予約表を表示できません。' : <><LoaderCircle size={18} className="sb-spin" />読み込み中…</>}</div>
      : view === 'list' ? <div className="sb-agenda"><ReservationList reservations={ledger.reservations} onPick={setSelectedId} /></div>
      : <div className="sb-board-scroll" ref={scrollRef} role="region" aria-label="担当者別予約表"><div className="sb-grid" style={{ gridTemplateColumns: `${LABEL_W}px ${x(range.end)}px`, width: LABEL_W + x(range.end) }}>
        <div className="sb-axis-name">担当者</div><div className="sb-axis">{Array.from({ length: (range.end - range.start) / 60 }, (_, i) => range.start + i * 60).map(m => <span key={m} style={{ left: x(m) + 8 }}>{Math.floor(m / 60)}:00</span>)}</div>
        {ledger.staff.map(staff => { const bookings = active.filter(r => r.staff_id === staff.id); const lanes = Math.max(staff.capacity, ...bookings.map(r => r.booking_lane + 1))
          return <StaffRow key={staff.id} staff={staff} lanes={lanes} reservations={bookings} ledger={ledger} date={date} range={range} nowMin={minutesNow} x={x} blocked={blocked}
            onOpen={setSelectedId} onNew={minutes => newBooking({ date, staffId: staff.id, minutes })} /> })}
      </div>{!ledger.staff.length && <p className="sb-empty">本部で予約スタッフの設定が必要です。</p>}</div>}
    <footer className="sb-statusbar"><div>{ledger?.closure ? <span>休業日{ledger.closure.reason ? `：${ledger.closure.reason}` : ''}</span> : ledger && !ledger.staff.some(s => s.shifts.length) ? <span>本部で勤務時間の設定が必要です。</span> : <span>{active.length}件</span>}
      {cancelled.length > 0 && <button onClick={() => setArchive('cancelled')}>取消・不来店 {cancelled.length}件</button>}{toTransfer.length > 0 && <button onClick={() => setArchive('transfer')}>未転記 {toTransfer.length}件</button>}</div><span>{updated ? `${updated} 更新` : ''}</span></footer>
    {pickActor && options && <SbModal title="操作者" onClose={() => setPickActor(false)}><div className="sb-actor-list">{options.actors.map(a => <button className="sb-secondary" aria-pressed={actor === a.name} key={a.id} onClick={() => { setActor(a.name); setPickActor(false) }}>{a.name}{actor === a.name && <Check size={18} />}</button>)}</div></SbModal>}
    {archive && <SbModal title={archive === 'transfer' ? '未転記の予約' : '取消・不来店'} onClose={() => setArchive(null)}><ReservationList reservations={list} onPick={id => { setArchive(null); setSelectedId(id) }} /></SbModal>}
    {selected && !editor && !archive && <ReservationDetails key={selected.id} reservation={selected} busy={busy} blocked={blocked} onClose={() => setSelectedId(null)}
      onEdit={() => { setEditor({ reservation: selected, preset: { date: getJapanDateString(new Date(selected.starts_at)) } }); setSelectedId(null) }} onSend={send} />}
    {editor && options && <SbBookingEditor key={editor.reservation?.id ?? 'new'} options={options} preset={editor.preset} reservation={editor.reservation} actor={actor} setActor={setActor} busy={busy} onSend={send} onClose={() => setEditor(null)} />}
  </div>
}

function StaffRow({ staff, lanes, reservations, ledger, date, range, nowMin, x, blocked, onOpen, onNew }: {
  staff: SbLedger['staff'][number]; lanes: number; reservations: SbReservation[]; ledger: SbLedger; date: string
  range: { start: number; end: number }; nowMin: number | null; x: (minute: number) => number; blocked: boolean
  onOpen: (id: string) => void; onNew: (minute?: number) => void
}) {
  const blocks = ledger.blocks.filter(b => b.staff_id === null || b.staff_id === staff.id)
  return <><div className="sb-staff-name" style={{ minHeight: lanes * LANE_H }}><strong>{staff.name}</strong><small>{staff.shifts.length ? `同時${staff.capacity}枠` : '休み'}</small></div>
    <div className="sb-staff-timeline" style={{ height: lanes * LANE_H }}>
      {staff.shifts.map((s, i) => <div key={i} className="sb-working" style={{ left: x(jstMinutesOf(s.start, date)), width: x(jstMinutesOf(s.end, date)) - x(jstMinutesOf(s.start, date)) }} />)}
      {Array.from({ length: lanes }, (_, lane) => <button key={lane} className="sb-empty-lane" disabled={blocked || !staff.shifts.length || date < getJapanDateString()} aria-label={`${staff.name}の新規予約 枠${lane + 1}`} style={{ top: lane * LANE_H, height: LANE_H }}
        onClick={e => {
          if (e.detail === 0) { onNew(); return }
          const m = range.start + Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left) / SLOT_W) * 15
          if (nowMin !== null && m < nowMin) return
          if (staff.shifts.some(s => jstMinutesOf(s.start, date) <= m && jstMinutesOf(s.end, date) > m)) onNew(m)
        }} />)}
      {blocks.map(b => <div className="sb-time-block" key={b.id} style={{ left: x(Math.max(range.start, jstMinutesOf(b.starts_at, date))), width: x(Math.min(range.end, jstMinutesOf(b.ends_at, date))) - x(Math.max(range.start, jstMinutesOf(b.starts_at, date))) }}>{b.kind === 'break' ? '休憩' : '受付外'}</div>)}
      {reservations.map(r => {
        const start = jstMinutesOf(r.starts_at, date), end = jstMinutesOf(r.ends_at, date), until = jstMinutesOf(r.occupied_until, date)
        return <div key={r.id}><button className={`sb-reservation sb-reservation-${r.status}`} aria-label={`${jstTime(r.starts_at)} ${r.customer_name} ${r.items.map(i => i.name).join('・')} ${r.staff_name} ${STATUS_LABEL[r.status]}`} onClick={() => onOpen(r.id)}
          style={{ left: x(start) + 2, width: Math.max(12, x(end) - x(start) - 4), top: r.booking_lane * LANE_H + 5, height: LANE_H - 10 }}>
          <strong>{r.customer_name}</strong><span>{r.items.map(i => i.name).join('・')}</span><small>{jstTime(r.starts_at)}–{jstTime(r.ends_at)}{!r.nominated ? ' / 指名なし' : ''}{r.transfer_status === 'pending' && <FileClock size={12} aria-label="未転記" />}</small>
        </button>{until > end && <div className="sb-buffer" aria-label="片付け時間" style={{ left: x(end), width: x(until) - x(end), top: r.booking_lane * LANE_H + 5, height: LANE_H - 10 }} />}</div>
      })}
      {nowMin !== null && nowMin >= range.start && nowMin < range.end && <div className="sb-now" style={{ left: x(nowMin) }} aria-hidden="true" />}
    </div></>
}

function ReservationList({ reservations, onPick }: { reservations: SbReservation[]; onPick: (id: string) => void }) {
  return reservations.length ? <div className="sb-reservation-list">{reservations.map(r => <button key={r.id} onClick={() => onPick(r.id)}><time>{jstTime(r.starts_at)}<small>{jstTime(r.ends_at)}</small></time><span><strong>{r.customer_name}</strong><small>{r.items.map(i => i.name).join('・')}</small><small>{r.staff_name}{!r.nominated ? ' / 指名なし' : ''} / {STATUS_LABEL[r.status]}</small></span>{r.transfer_status === 'pending' && <FileClock size={17} aria-label="未転記" />}<ChevronRight size={18} /></button>)}</div> : <p className="sb-muted">予約はありません。</p>
}

function ReservationDetails({ reservation: r, busy, blocked, onClose, onEdit, onSend }: {
  reservation: SbReservation; busy: boolean; blocked: boolean; onClose: () => void; onEdit: () => void; onSend: (c: SbCommand) => Promise<void>
}) {
  const [cancel, setCancel] = useState(false)
  const [reason, setReason] = useState('')
  const [copied, setCopied] = useState(false)
  const [copyFallback, setCopyFallback] = useState(false)
  // 詳細を開いた時刻（開始時刻を過ぎた予約だけ「不来店」を出す）
  const [openedAt] = useState(() => Date.now())
  const [history, setHistory] = useState<{ event_type: string; actor_name: string; created_at: string }[] | null>(null)
  const [historyError, setHistoryError] = useState(false)
  const text = salonBoardCopy(r)
  const base = { reservation_id: r.id, expected_updated_at: r.updated_at }
  const labels: Record<string, string> = { created: '登録', edited: '内容変更', transfer_updated: '転記状態変更', rescheduled: '日時変更', staff_changed: '担当変更', checked_in: '来店', completed: '完了', cancelled: '取消', no_show: '不来店' }
  return <SbModal title={`${jstTime(r.starts_at)}–${jstTime(r.ends_at)} ${STATUS_LABEL[r.status]}`} busy={busy} onClose={onClose}
    footer={cancel ? <div className="sb-actions"><button className="sb-secondary" disabled={busy} onClick={() => setCancel(false)}>戻る</button><button className="sb-danger" disabled={blocked} onClick={() => void onSend({ ...base, kind: 'cancel', reason })}>予約を取り消す</button></div> : ['confirmed', 'checked_in'].includes(r.status) ? <button className="sb-primary sb-grow" disabled={blocked} onClick={onEdit}>内容を変更</button> : undefined}>
    <h3 className="sb-customer-name">{r.customer_name}</h3>{r.customer_phone && <a className="sb-phone" href={`tel:${r.customer_phone}`}>{r.customer_phone}</a>}
    <dl className="sb-facts"><dt>日付</dt><dd>{jstDateLabel(getJapanDateString(new Date(r.starts_at)))}</dd><dt>担当</dt><dd>{r.staff_name}{r.nominated ? '（指名）' : '（指名なし）'}</dd>
      <dt>メニュー</dt><dd>{r.items.map(i => <span className="sb-line" key={i.menu_code}>{i.name}<small>{i.duration_min}分 / {yen(i.price)}</small></span>)}</dd>
      <dt>予約時の金額</dt><dd>{yen(r.total_price)}</dd>{r.note && <><dt>メモ</dt><dd className="sb-prewrap">{r.note}</dd></>}{r.external_ref && <><dt>予約番号</dt><dd>{r.external_ref}</dd></>}
    </dl>
    {cancel ? <label className="sb-field">取消理由（任意）<input value={reason} maxLength={100} disabled={busy} onChange={e => setReason(e.target.value)} /></label> : <>
      <div className="sb-quick-actions">{r.status === 'confirmed' && <button className="sb-secondary" disabled={blocked} onClick={() => void onSend({ ...base, kind: 'status', status: 'checked_in' })}>来店済みにする</button>}
        {['checked_in', 'in_service', 'awaiting_payment'].includes(r.status) && <button className="sb-secondary" disabled={blocked} onClick={() => void onSend({ ...base, kind: 'status', status: 'completed' })}>施術完了</button>}
        {r.status === 'confirmed' && Date.parse(r.starts_at) <= openedAt && <button className="sb-secondary" disabled={blocked} onClick={() => void onSend({ ...base, kind: 'status', status: 'no_show' })}>不来店</button>}
        {r.status === 'confirmed' && <button className="sb-text-danger" disabled={blocked} onClick={() => setCancel(true)}>予約を取り消す</button>}</div>
      <section className="sb-transfer"><h3>Salon Board <span>{TRANSFER[r.transfer_status]}</span></h3>
        <button className="sb-secondary sb-grow" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setCopyFallback(false) }).catch(() => setCopyFallback(true)); if (!navigator.clipboard) setCopyFallback(true) }}><Clipboard size={18} />{copied ? 'コピーしました' : '転記用テキストをコピー'}</button>
        {copyFallback && <textarea className="sb-copy-text" readOnly value={text} aria-label="Salon Board転記用テキスト" onFocus={e => e.target.select()} />}
        <div className="sb-transfer-controls">{(['pending', 'done', 'not_required'] as const).map(s => <button className="sb-secondary" aria-pressed={r.transfer_status === s} key={s} disabled={blocked || r.transfer_status === s} onClick={() => void onSend({ ...base, kind: 'transfer', transfer_status: s })}>{r.transfer_status === s ? <Check size={16} /> : <Circle size={16} />}{TRANSFER[s]}</button>)}</div>
      </section>
      <details className="sb-extra" onToggle={e => { if (e.currentTarget.open && !history) void callStaffRpc<typeof history>('staff_reservation_events', { p_reservation_id: r.id }).then(setHistory).catch(() => setHistoryError(true)) }}><summary>変更履歴</summary>{historyError ? <p className="sb-error">履歴を取得できません。</p> : history?.map((e, i) => <p className="sb-history" key={i}>{jstTime(e.created_at)} {labels[e.event_type] ?? e.event_type} / {e.actor_name}</p>)}</details>
    </>}
  </SbModal>
}
