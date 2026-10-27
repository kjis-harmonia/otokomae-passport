import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Bell, BellOff, CalendarDays, Check, ChevronLeft, ChevronRight, Circle, Clipboard, List, LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import { addDaysToDateString, getJapanDateString } from '../utils/dateUtils'
import { jstDateLabel, jstMinutesOf, jstTime, STATUS_LABEL, yen } from '../utils/bookingApi'
import { callStaffRpc } from './sbRpc'
import { sbApi, sbError, salonBoardCopy, type SbOutcome } from './sbApi'
import { sbPending, subscribeSbPending } from './sbPending'
import type { SbCommand, SbLedger, SbOptions, SbReservation, TransferStatus } from './sbTypes'
import { SbBookingEditor, type SbPreset } from './SbBookingEditor'
import { SbModal } from './SbModal'
import { SbCommandBar } from './SbCommandBar'
import { SbCloseSheet, SbReopenSheet, type SbClosePreset } from './SbCloseSheet'
import { SbToday } from './SbToday'
import { SbMoveSheet } from './SbMove'
import { useReservationDrag, type SbMoveTarget } from './sbDrag'
import { SbHotpepper } from './SbHotpepper'
import { hpbApi, type HpbList } from './sbHotpepperApi'
import { sbPushOff, sbPushOn, sbPushRefresh, sbPushState, type SbPushState } from './sbPush'
import { announceVoice, playChime, unlockChime } from './sbChime'
import './sb.css'

const ACTOR = 'ginjiro_staff_name'
const OCCUPYING = new Set(['confirmed', 'checked_in', 'in_service', 'awaiting_payment', 'completed'])
const TRANSFER: Record<TransferStatus, string> = { pending: '未転記', done: '転記済み', not_required: '転記不要' }
const SLOT_W = 44
const LABEL_W = 96
const LANE_H = 72
const loadActor = () => { try { return localStorage.getItem(ACTOR) ? JSON.parse(localStorage.getItem(ACTOR)!) as string : '' } catch { return '' } }
function errorText(err: unknown) { return sbError(err instanceof Error && !(err instanceof TypeError) ? err.message : err) }

export function SbScreen() {
  const today = getJapanDateString()
  const [date, setDate] = useState(today)
  const [ledger, setLedger] = useState<SbLedger | null>(null)
  const [options, setOptions] = useState<SbOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // 操作者は選ばない（SB はサブの道具：楽な操作を優先）。履歴に残す名前は、この端末で前に選んだ人、いなければスタッフの先頭
  const [actor] = useState(loadActor)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ preset: SbPreset; reservation?: SbReservation } | null>(null)
  // 時間を閉める（クローズ）・外す
  const [closing, setClosing] = useState<SbClosePreset | null>(null)
  const [reopening, setReopening] = useState<{ block: SbLedger['blocks'][number]; staffName: string } | null>(null)
  const [moving, setMoving] = useState<SbMoveTarget | null>(null)
  const [view, setView] = useState<'board' | 'list'>('board')
  const [archive, setArchive] = useState<'cancelled' | 'transfer' | null>(null)
  const [hpb, setHpb] = useState<HpbList | null>(null)
  const [hpbOpen, setHpbOpen] = useState(false)
  const wantedId = useRef<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [updated, setUpdated] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  const [online, setOnline] = useState(navigator.onLine)
  const [compact, setCompact] = useState(false)
  const pending = useSyncExternalStore(subscribeSbPending, sbPending.read)
  const sending = useRef(false)
  const generation = useRef(0)
  const dateRef = useRef(date)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrolled = useRef<string | null>(null)
  const blocked = busy || !!pending.pending || !!pending.error || !online || !!error
  // 予約をドラッグして時間・担当を変える（今日より前の日は動かさない）
  const drag = useReservationDrag({ date, slotW: SLOT_W, enabled: !blocked && !!options && date >= today, onDrop: t => { setNotice(null); setMoving(t) } })

  const operator = options?.actors.some(a => a.name === actor) ? actor : options?.actors[0]?.name ?? ''
  const loadHpb = useCallback(async () => {
    try { const value = await hpbApi.list(); if (Array.isArray(value?.mails)) setHpb(value) } catch { /* メールの取込一覧が読めなくても予約表は止めない */ }
  }, [])
  const refresh = useCallback(async (d: string) => {
    const gen = ++generation.current
    void loadHpb()
    try {
      const value = await sbApi.ledger(d)
      if (gen !== generation.current || dateRef.current !== d) return
      if (!value || !Array.isArray(value.staff) || !Array.isArray(value.reservations)) throw new Error('invalid_response')
      setLedger(value); setError(null); setUpdated(jstTime(new Date().toISOString()))
      if (wantedId.current && value.reservations.some(r => r.id === wantedId.current)) setSelectedId(wantedId.current)
      wantedId.current = null
    } catch { if (gen === generation.current && dateRef.current === d) setError('予約表を取得できません。接続とSBのサーバー設定を確認してください。') }
  }, [loadHpb])
  const loadOptions = useCallback(async () => {
    try { const value = await sbApi.options(); if (!Array.isArray(value.actors) || !Array.isArray(value.menus)) throw new Error(); setOptions(value) }
    catch { setError('予約設定を取得できません。SB用migrationの適用・端末認証を確認してください。') }
  }, [])
  // 新しい AI 予約・アプリでの取り消しの確認：誰かがサロンボードに反映して押すまで帯を出し、2分ごとに声で知らせる（確認は全端末で共通）
  const [unacked, setUnacked] = useState<{ id: string; kind?: 'new' | 'cancel'; starts_at: string; customer_name: string; staff_name: string; sent_at: string; rescheduled?: boolean }[]>([])
  const seen = useRef<Set<string> | null>(null)
  const lastVoice = useRef(0)
  const announce = (kind: 'new' | 'cancel' | 'final' = 'new') => { if (kind !== 'final' && Date.now() - lastVoice.current < 20_000) return; lastVoice.current = Date.now(); announceVoice(kind) }
  const loadUnacked = async () => {
    try {
      const list = await callStaffRpc<typeof unacked>('staff_new_unacked')
      // 開いている間に増えた分は、お知らせが届かなくても鳴らす（最初の読み込みでは鳴らさない）
      const fresh = seen.current ? list.filter(r => !seen.current!.has(`${r.kind}:${r.id}`)) : []
      if (fresh.length) announce(fresh.some(r => r.kind !== 'cancel') ? 'new' : 'cancel')
      seen.current = new Set(list.map(r => `${r.kind}:${r.id}`))
      setUnacked(list)
    } catch { /* 仕組みが無い・通信切れ：次の読み込みで */ }
  }
  useEffect(() => {
    void loadUnacked() // eslint-disable-line react-hooks/set-state-in-effect -- 通信の結果で入れる（同期的な setState ではない）
    const poll = window.setInterval(() => { if (document.visibilityState === 'visible') void loadUnacked() }, 30_000)
    // 画面に戻ったら（iPad のスリープ明け・別のアプリから戻ったとき）すぐ確かめる
    const onVisible = () => { if (document.visibilityState === 'visible') void loadUnacked() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(poll); document.removeEventListener('visibilitychange', onVisible) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!unacked.length) return
    const nag = window.setInterval(() => {
      const oldest = Date.parse(unacked[0].sent_at)
      // 2分：確認してください。5分：最終警告（テイテイさん、ギンジロウさん…）。押すまで2分ごと
      const age = Date.now() - oldest
      if (age >= 120_000 && Date.now() - lastVoice.current >= 120_000) { lastVoice.current = Date.now(); announceVoice(age >= 300_000 ? 'final' : unacked.every(r => r.kind === 'cancel') ? 'cancel' : 'remind') }
    }, 10_000)
    return () => clearInterval(nag)
  }, [unacked])
  const ackNew = async () => {
    unlockChime()
    // 画面に出ている分だけ確認済みにする（押す直前に届いた予約は、次の読み込みで帯に出る）
    try { await callStaffRpc('staff_ack_new', { p_staff_name: operator || null, p_ids: unacked.map(r => r.id) }); setUnacked([]); void loadUnacked(); window.speechSynthesis?.cancel(); void refresh(dateRef.current) } catch { /* 次の読み込みでもう一度 */ }
  }
  // AI 予約のお知らせ：この端末で受け取っているか。届いたら（開いているとき）ピコーンと鳴らして予約表を読み直す
  const [push, setPush] = useState<SbPushState | null>(null)
  const [pushNote, setPushNote] = useState<string | null>(null)
  useEffect(() => {
    void sbPushState().then(setPush); void sbPushRefresh()
    const onMessage = (e: MessageEvent) => { if (e.data?.type === 'sb-new-reservation' || e.data?.type === 'sb-cancel' || e.data?.type === 'sb-final') { announce(e.data.type === 'sb-final' ? 'final' : e.data.type === 'sb-cancel' ? 'cancel' : 'new'); void refresh(dateRef.current); void loadUnacked() } }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    window.addEventListener('pointerdown', unlockChime)
    return () => { navigator.serviceWorker?.removeEventListener('message', onMessage); window.removeEventListener('pointerdown', unlockChime) }
  }, [refresh]) // eslint-disable-line react-hooks/exhaustive-deps -- announce・loadUnacked は ref だけを使う
  const togglePush = async () => {
    unlockChime()
    try {
      const next = push === 'on' ? await sbPushOff() : await sbPushOn()
      setPush(next)
      if (next === 'on') { playChime(); setPushNote('この端末で「予約が入りました」を受け取ります。') }
      else if (next === 'needs-install') setPushNote('お知らせは、ホーム画面に追加した SB で受け取れます。Safari の共有ボタン →「ホーム画面に追加」から開いてください。')
      else if (next === 'denied') setPushNote('お知らせが許可されていません。設定 → 通知 → 銀二郎SB で「通知を許可」をオンにしてください。')
      else if (next === 'unsupported') setPushNote('この端末・ブラウザではお知らせを受け取れません。')
    } catch { setPushNote('お知らせの設定に失敗しました。通信を確かめて、もう一度押してください。') }
  }
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
  useEffect(() => {
    // 行ったり来たりしないよう、畳む位置と戻す位置をずらす
    // 共通CSSの都合で body がスクロールすることがあるので、どちらの位置も見る
    const onScroll = () => { const y = Math.max(window.scrollY, document.body.scrollTop); setCompact(c => (c ? y > 8 : y > 80)) }
    document.addEventListener('scroll', onScroll, { passive: true, capture: true })
    return () => document.removeEventListener('scroll', onScroll, { capture: true })
  }, [])
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
    // ちょうどの時刻（1時間前の正時）から見せる：目盛りの「18:00」が担当者の列に隠れて「8:00」に見えないように
    scrollRef.current.scrollLeft = minutesNow !== null ? Math.max(0, x(Math.floor(minutesNow / 60) * 60 - 60)) : 0
  }, [ledger, date, minutesNow, x])
  const selected = ledger?.reservations.find(r => r.id === selectedId)
  const active = ledger?.reservations.filter(r => OCCUPYING.has(r.status)) ?? []
  const cancelled = ledger?.reservations.filter(r => r.status === 'cancelled' || r.status === 'no_show') ?? []
  const toTransfer = ledger?.reservations.filter(r => r.transfer_status === 'pending') ?? []

  const applyOutcome = async (result: SbOutcome) => {
    setEditor(null); setSelectedId(null); setMoving(null)
    if (!result.ok) { setNotice(sbError(result.error)); await refresh(dateRef.current); return }
    const d = getJapanDateString(new Date(result.reservation.starts_at))
    setNotice('予約を更新しました。')
    if (d !== dateRef.current) setDate(d)
    else { await refresh(d); setSelectedId(result.reservation.id) }
  }
  async function send(command: SbCommand) {
    if (sending.current || blocked) return
    if (!operator) { setNotice('本部でスタッフの設定が必要です。'); return }
    sending.current = true; setBusy(true); setNotice(null)
    try { await applyOutcome(await sbPending.start(command, operator, sbApi.mutate)) }
    catch (err) { setEditor(null); setSelectedId(null); setMoving(null); setNotice(errorText(err)) }
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
  /** 予約の詳細を開く（別の日なら、その日の予約表に移ってから開く） */
  function openReservation(id: string, day: string) {
    if (day === dateRef.current) setSelectedId(id)
    else { wantedId.current = id; setDate(day) }
  }
  function openClose(preset: SbClosePreset) {
    if (blocked || !options) return
    setNotice(null); setClosing(preset)
  }
  const list = archive === 'cancelled' ? cancelled : archive === 'transfer' ? toTransfer : ledger?.reservations ?? []
  return <div className={`sb-app${compact ? ' sb-compact' : ''}`}>
    <header className="sb-toolbar"><h1><span className="sb-wordmark">銀二郎</span><span className="sb-mark">SB</span></h1>
      <div className="sb-date-nav"><button className="sb-nav" aria-label="前の日" title="前の日" onClick={() => setDate(addDaysToDateString(date, -1))}><ChevronLeft size={24} /></button>
        <label className="sb-date-label"><span>{jstDateLabel(date)}</span><input type="date" aria-label="予約表の日付" value={date} onChange={e => e.target.value && setDate(e.target.value)} /></label>
        <button className="sb-nav" aria-label="次の日" title="次の日" onClick={() => setDate(addDaysToDateString(date, 1))}><ChevronRight size={24} /></button><button className="sb-secondary sb-today" onClick={() => setDate(today)}>今日</button></div>
      <div className="sb-toolbar-actions"><button className="sb-actor sb-bell" aria-pressed={push === 'on'} title={push === 'on' ? '予約のお知らせ：受け取り中（押すと止める）' : '予約のお知らせを受け取る'} onClick={() => void togglePush()}>{push === 'on' ? <Bell size={18} /> : <BellOff size={18} />}<span>{push === 'on' ? '通知オン' : '通知'}</span></button>
        <button className="sb-primary" disabled={blocked || !options} onClick={() => newBooking({ date: date < today ? today : date })}><Plus size={19} /><span className="sb-primary-label">新規予約</span></button></div>
    </header>
    <SbCommandBar options={options} disabled={blocked} onDraft={draft => {
      const day = draft.date < today ? today : draft.date
      if (draft.close) openClose({ date: day, minutes: draft.minutes, endMinutes: draft.endMinutes, staffId: draft.staffId })
      else newBooking({ date: day, minutes: draft.minutes ?? undefined, staffId: draft.staffId, draft })
    }} />
    {(pending.error || pending.pending || !online || error) && <div className="sb-alert" role="alert">
      <span>{pending.error ? sbError('storage_error') : pending.pending ? '送信済み予約の結果確認が必要です。新しい予約の送信は停止中です。' : !online ? 'オフラインです。予約の登録・変更はできません。' : error}</span>
      {pending.pending && !pending.error && <button className="sb-secondary" disabled={busy || !online} onClick={() => void retry()}>{busy ? '確認中…' : '同じ内容で結果を確認'}</button>}
      {!pending.pending && !pending.error && online && <button className="sb-icon" aria-label="再読み込み" onClick={() => { void refresh(date); void loadOptions() }}><RefreshCw size={18} /></button>}
    </div>}
    {hpb && hpb.open > 0 && <div className="sb-alert" role="status"><span>HOT PEPPERのメールで確認が必要なものが{hpb.open}件あります。</span><button className="sb-secondary" onClick={() => setHpbOpen(true)}>確認する</button></div>}
    {unacked.length > 0 && <NewAlert list={unacked} onAck={() => void ackNew()} onOpen={openReservation} />}
    {ledger && date === today && <SbToday ledger={ledger} now={now} blocked={blocked} onOpen={setSelectedId}
      onNew={p => newBooking({ date, minutes: p.minutes, staffId: p.staffId })} onTransfer={() => setArchive('transfer')} />}
    <div className="sb-board-toolbar"><div className="sb-legend"><span><i className="sb-dot sb-blue" />予約</span><span><i className="sb-dot sb-green" />来店済み</span><span><i className="sb-dot sb-gold-dot" />未転記</span></div>
      <div className="sb-view-picker" role="group" aria-label="予約の表示"><button className="sb-icon" aria-label="予約表" title="予約表" aria-pressed={view === 'board'} onClick={() => setView('board')}><CalendarDays size={19} /></button><button className="sb-icon" aria-label="予約一覧" title="予約一覧" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={19} /></button><button className="sb-icon" aria-label="予約表を更新" title="更新" disabled={busy} onClick={() => void refresh(date)}><RefreshCw size={18} /></button></div></div>
    {notice && <p className="sb-notice" role="status">{notice}</p>}
    {!ledger ? <div className="sb-empty">{error ? '予約表を表示できません。' : <><LoaderCircle size={18} className="sb-spin" />読み込み中…</>}</div>
      : view === 'list' ? <div className="sb-agenda"><ReservationList reservations={ledger.reservations} onPick={setSelectedId} /></div>
      : <div className="sb-board-scroll" ref={scrollRef} role="region" aria-label="担当者別予約表"><div className="sb-grid" style={{ gridTemplateColumns: `${LABEL_W}px ${x(range.end)}px`, width: LABEL_W + x(range.end) }}>
        <div className="sb-axis-name">担当者</div><div className="sb-axis">{Array.from({ length: (range.end - range.start) / 60 }, (_, i) => range.start + i * 60).map(m => <span key={m} style={{ left: x(m) + 8 }}>{Math.floor(m / 60)}:00</span>)}</div>
        {ledger.staff.map(staff => { const bookings = active.filter(r => r.staff_id === staff.id); const used = Math.max(0, ...bookings.map(r => r.booking_lane + 1)); const lanes = Math.max(2, used) /* ふだんは2段。同時に3件入った日だけ3段に増やす */
          return <StaffRow key={staff.id} drag={drag} staff={staff} lanes={lanes} reservations={bookings} ledger={ledger} date={date} range={range} nowMin={minutesNow} x={x} blocked={blocked}
            onOpen={setSelectedId} onNew={minutes => newBooking({ date, staffId: staff.id, minutes })} onBlock={b => setReopening({ block: b, staffName: b.staff_id ? staff.name : '全員' })} /> })}
      </div>{!ledger.staff.length && <p className="sb-empty">本部で予約スタッフの設定が必要です。</p>}</div>}
    <footer className="sb-statusbar"><div>{ledger?.closure ? <span>休業日{ledger.closure.reason ? `：${ledger.closure.reason}` : ''}</span> : ledger && !ledger.staff.some(s => s.shifts.length) ? <span>本部で勤務時間の設定が必要です。</span> : <span>{active.length}件</span>}
      <button onClick={() => setHpbOpen(true)}>HPBメール</button>{cancelled.length > 0 && <button onClick={() => setArchive('cancelled')}>取消・不来店 {cancelled.length}件</button>}{toTransfer.length > 0 && <button onClick={() => setArchive('transfer')}>未転記 {toTransfer.length}件</button>}</div><span>{updated ? `${updated} 更新` : ''}</span></footer>
    {pushNote && <SbModal title="予約のお知らせ" onClose={() => setPushNote(null)}><p className="sb-push-note">{pushNote}</p></SbModal>}
    {hpbOpen && <SbHotpepper list={hpb} actor={operator} disabled={!online} onClose={() => setHpbOpen(false)}
      onChanged={() => void refresh(dateRef.current)}
      onOpen={(d, id) => { setHpbOpen(false); openReservation(id, d) }} />}
    {archive && <SbModal title={archive === 'transfer' ? '未転記の予約' : '取消・不来店'} onClose={() => setArchive(null)}><ReservationList reservations={list} onPick={id => { setArchive(null); setSelectedId(id) }} /></SbModal>}
    {selected && !editor && !archive && <ReservationDetails key={selected.id} reservation={selected} actor={operator} busy={busy} blocked={blocked} onClose={() => setSelectedId(null)}
      onEdit={() => { setEditor({ reservation: selected, preset: { date: getJapanDateString(new Date(selected.starts_at)) } }); setSelectedId(null) }} onSend={send} />}
    {closing && options && <SbCloseSheet options={options} preset={closing} actor={operator} onClose={() => setClosing(null)} onDone={m => { setClosing(null); setNotice(m); void refresh(dateRef.current) }} />}
    {reopening && <SbReopenSheet block={reopening.block} staffName={reopening.staffName} actor={operator} onClose={() => setReopening(null)} onDone={m => { setReopening(null); setNotice(m); void refresh(dateRef.current) }} />}
    {moving && options && <SbMoveSheet key={`${moving.r.id}:${moving.staffId}:${moving.minutes}`} target={moving} options={options} date={date} busy={busy} onSend={send} onClose={() => setMoving(null)} />}
    {editor && options && <SbBookingEditor key={editor.reservation?.id ?? 'new'} options={options} preset={editor.preset} reservation={editor.reservation} actor={operator} busy={busy} onSend={send} onClose={() => setEditor(null)} />}
  </div>
}

function StaffRow({ drag, staff, lanes, reservations, ledger, date, range, nowMin, x, blocked, onOpen, onNew, onBlock }: {
  drag: ReturnType<typeof useReservationDrag>
  staff: SbLedger['staff'][number]; lanes: number; reservations: SbReservation[]; ledger: SbLedger; date: string
  range: { start: number; end: number }; nowMin: number | null; x: (minute: number) => number; blocked: boolean
  onOpen: (id: string) => void; onNew: (minute?: number) => void; onBlock: (block: SbLedger['blocks'][number]) => void
}) {
  const blocks = ledger.blocks.filter(b => b.staff_id === null || b.staff_id === staff.id)
  return <><div className="sb-staff-name" style={{ minHeight: lanes * LANE_H }}><strong>{staff.name}</strong><small>{staff.shifts.length ? `同時${staff.capacity}枠` : '休み'}</small></div>
    <div className="sb-staff-timeline" data-staff-id={staff.id} style={{ height: lanes * LANE_H }}>
      {staff.shifts.map((s, i) => <div key={i} className="sb-working" style={{ left: x(jstMinutesOf(s.start, date)), width: x(jstMinutesOf(s.end, date)) - x(jstMinutesOf(s.start, date)) }} />)}
      {Array.from({ length: lanes }, (_, lane) => <button key={lane} className="sb-empty-lane" disabled={blocked || !staff.shifts.length || date < getJapanDateString()} aria-label={`${staff.name}の新規予約 枠${lane + 1}`} style={{ top: lane * LANE_H, height: LANE_H }}
        onClick={e => {
          if (e.detail === 0) { onNew(); return }
          const m = range.start + Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left) / SLOT_W) * 15
          if (nowMin !== null && m < nowMin) return
          if (staff.shifts.some(s => jstMinutesOf(s.start, date) <= m && jstMinutesOf(s.end, date) > m)) onNew(m)
        }} />)}
      {blocks.map(b => {
        const style = { left: x(Math.max(range.start, jstMinutesOf(b.starts_at, date))), width: x(Math.min(range.end, jstMinutesOf(b.ends_at, date))) - x(Math.max(range.start, jstMinutesOf(b.starts_at, date))) }
        // SB で閉めた時間（クローズ）は押して外せる。本部の休憩などは表示だけ
        return b.kind === 'unavailable'
          ? <button type="button" className="sb-time-block sb-closed" key={b.id} style={style} disabled={blocked} aria-label={`${staff.name} ${jstTime(b.starts_at)}から${jstTime(b.ends_at)}までクローズ`} onClick={() => onBlock(b)}>クローズ<small>{jstTime(b.starts_at)}–{jstTime(b.ends_at)}</small></button>
          : <div className="sb-time-block" key={b.id} style={style}>{b.kind === 'break' ? '休憩' : '受付外'}</div>
      })}
      {reservations.map(r => {
        const start = jstMinutesOf(r.starts_at, date), end = jstMinutesOf(r.ends_at, date), until = jstMinutesOf(r.occupied_until, date)
        const dragging = drag.view?.id === r.id ? drag.view : null
        return <div key={r.id}><button className={`sb-reservation sb-reservation-${r.status}${dragging ? ' sb-dragging' : ''}`} aria-label={`${jstTime(r.starts_at)} ${r.customer_name} ${r.items.map(i => i.name).join('・')} ${r.staff_name} ${STATUS_LABEL[r.status]}`}
          onPointerDown={e => drag.start(e, r)} onClick={() => { if (drag.clicked()) onOpen(r.id) }} onContextMenu={e => { if (r.status === 'confirmed') e.preventDefault() }}
          style={{ left: x(start) + 2, width: Math.max(12, x(end) - x(start) - 4), top: r.booking_lane * LANE_H + 5, height: LANE_H - 10, ...(dragging ? { transform: `translate(${dragging.dx}px, ${dragging.dy}px)` } : {}) }}>
          {dragging && <em className="sb-drag-time">{`${Math.floor(dragging.minutes / 60)}:${String(dragging.minutes % 60).padStart(2, '0')}`}</em>}
          <strong>{r.customer_name}</strong><span>{r.items.map(i => i.name).join('・')}</span><small>{jstTime(r.starts_at)}–{jstTime(r.ends_at)}{!r.nominated ? ' / 指名なし' : ''}{r.transfer_status === 'pending' && <i className="sb-dot sb-gold-dot" aria-label="未転記" />}</small>
        </button>{until > end && <div className="sb-buffer" aria-label="片付け時間" style={{ left: x(end), width: x(until) - x(end), top: r.booking_lane * LANE_H + 5, height: LANE_H - 10 }} />}</div>
      })}
      {nowMin !== null && nowMin >= range.start && nowMin < range.end && <div className="sb-now" style={{ left: x(nowMin) }} aria-hidden="true" />}
    </div></>
}

function ReservationList({ reservations, onPick }: { reservations: SbReservation[]; onPick: (id: string) => void }) {
  return reservations.length ? <div className="sb-reservation-list">{reservations.map(r => <button key={r.id} onClick={() => onPick(r.id)}><time>{jstTime(r.starts_at)}<small>{jstTime(r.ends_at)}</small></time><span><strong>{r.customer_name}</strong><small>{r.items.map(i => i.name).join('・')}</small><small>{r.staff_name}{!r.nominated ? ' / 指名なし' : ''} / {STATUS_LABEL[r.status]}</small></span>{r.transfer_status === 'pending' && <i className="sb-dot sb-gold-dot" aria-label="未転記" />}<ChevronRight size={18} /></button>)}</div> : <p className="sb-muted">予約はありません。</p>
}

function ReservationDetails({ reservation: r, actor, busy, blocked, onClose, onEdit, onSend }: {
  reservation: SbReservation; actor: string; busy: boolean; blocked: boolean; onClose: () => void; onEdit: () => void; onSend: (c: SbCommand) => Promise<void>
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
    {r.source === 'app' && <AiPause reservationId={r.id} actor={actor} blocked={blocked} />}
    <dl className="sb-facts"><dt>日付</dt><dd>{jstDateLabel(getJapanDateString(new Date(r.starts_at)))}</dd><dt>担当</dt><dd>{r.staff_name}{r.nominated ? '（指名）' : '（指名なし）'}</dd>
      <dt>メニュー</dt><dd>{r.items.map(i => <span className="sb-line" key={i.menu_code}>{i.name}<small>{i.duration_min}分 / {yen(i.price)}</small></span>)}</dd>
      <dt>予約時の金額</dt><dd>{yen(r.total_price)}</dd>{r.note && <><dt>メモ</dt><dd className="sb-prewrap">{r.note}</dd></>}{r.external_ref && <><dt>予約番号</dt><dd>{r.external_ref}</dd></>}
    </dl>
    {cancel ? <label className="sb-field">取消理由（任意）<input value={reason} maxLength={100} disabled={busy} onChange={e => setReason(e.target.value)} /></label> : <>
      <div className="sb-quick-actions">{r.status === 'confirmed' && <button className="sb-secondary" disabled={blocked} onClick={() => void onSend({ ...base, kind: 'status', status: 'checked_in' })}>来店済みにする</button>}
        {['checked_in', 'in_service', 'awaiting_payment'].includes(r.status) && <button className="sb-secondary" disabled={blocked} onClick={() => void onSend({ ...base, kind: 'status', status: 'completed' })}>施術完了</button>}
        {r.status === 'confirmed' && Date.parse(r.starts_at) <= openedAt && <button className="sb-secondary" disabled={blocked} onClick={() => void onSend({ ...base, kind: 'status', status: 'no_show' })}>不来店</button>}
        {r.status === 'confirmed' && <button className="sb-text-danger" disabled={blocked} onClick={() => setCancel(true)}>予約を取り消す</button>}</div>
      {!(r.source === 'hotpepper' && r.transfer_status === 'not_required') && <section className="sb-transfer"><h3>Salon Board <span>{TRANSFER[r.transfer_status]}</span></h3>
        <CopyRows r={r} />
        <button className="sb-secondary sb-grow" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setCopyFallback(false) }).catch(() => setCopyFallback(true)); if (!navigator.clipboard) setCopyFallback(true) }}><Clipboard size={18} />{copied ? 'コピーしました' : 'まとめてコピー'}</button>
        {copyFallback && <textarea className="sb-copy-text" readOnly value={text} aria-label="Salon Board転記用テキスト" onFocus={e => e.target.select()} />}
        <div className="sb-transfer-controls">{(['pending', 'done', 'not_required'] as const).map(s => <button className="sb-secondary" aria-pressed={r.transfer_status === s} key={s} disabled={blocked || r.transfer_status === s} onClick={() => void onSend({ ...base, kind: 'transfer', transfer_status: s })}>{r.transfer_status === s ? <Check size={16} /> : <Circle size={16} />}{TRANSFER[s]}</button>)}</div>
      </section>}
      <details className="sb-extra" onToggle={e => { if (e.currentTarget.open && !history) void callStaffRpc<typeof history>('staff_reservation_events', { p_reservation_id: r.id }).then(setHistory).catch(() => setHistoryError(true)) }}><summary>変更履歴</summary>{historyError ? <p className="sb-error">履歴を取得できません。</p> : history?.map((e, i) => <p className="sb-history" key={i}>{jstTime(e.created_at)} {labels[e.event_type] ?? e.event_type} / {e.actor_name}</p>)}</details>
    </>}
  </SbModal>
}

/** アプリ会員の予約：当日キャンセル・無断キャンセルで AI 予約が止まっていれば、再開日と「解除」（体調不良など）を出す */
function AiPause({ reservationId, actor, blocked }: { reservationId: string; actor: string; blocked: boolean }) {
  const [st, setSt] = useState<{ paused: boolean; resume_on?: string; reason?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => { let alive = true; void callStaffRpc<typeof st>('staff_ai_penalty_for_reservation', { p_reservation_id: reservationId }).then(v => { if (alive) setSt(v) }).catch(() => {}); return () => { alive = false } }, [reservationId])
  if (!st?.paused || !st.resume_on) return null
  const [, m, d] = st.resume_on.split('-').map(Number)
  return <p className="sb-ai-pause">AI予約 停止中（{st.reason === 'no_show' ? '無断キャンセル' : '当日キャンセル'}・{m}月{d}日から再開）
    <button className="sb-secondary" disabled={blocked || busy || !actor} onClick={() => { setBusy(true); setError(false); void callStaffRpc('staff_lift_ai_penalty', { p_reservation_id: reservationId, p_staff_name: actor }).then(() => setSt({ paused: false }), () => setError(true)).finally(() => setBusy(false)) }}>{busy ? '解除しています…' : '解除する'}</button>
    {error && <small className="sb-error">解除できませんでした。通信を確かめて、もう一度押してください。</small>}</p>
}

/** サロンボードに1項目ずつ貼れるように、項目ごとのコピー。行のどこを押してもコピー（電話番号は数字だけ） */
function CopyRows({ r }: { r: SbReservation }) {
  const [done, setDone] = useState<string | null>(null)
  const rows: [string, string][] = ([
    ['お名前', r.customer_name],
    ['電話番号', (r.customer_phone ?? '').replace(/[^0-9]/g, '')],
    ['日付', getJapanDateString(new Date(r.starts_at)).replace(/-/g, '/')],
    ['時刻', `${jstTime(r.starts_at)}〜${jstTime(r.ends_at)}`],
    ['メニュー', r.items.map(i => i.name).join(' / ')],
    ['担当', r.nominated ? `${r.staff_name}（指名）` : '指名なし'],
  ] as [string, string][]).filter(([, v]) => v)
  const copy = (label: string, value: string) => { void navigator.clipboard?.writeText(value).then(() => setDone(label), () => setDone(null)) }
  return <div className="sb-copy-rows">{rows.map(([label, value]) => <button type="button" className="sb-copy-row" key={label} aria-label={`${label}をコピー`} onClick={() => copy(label, value)}>
    <span><small>{label}</small>{value}</span><b aria-live="polite">{done === label ? <><Check size={15} />コピー済み</> : <><Clipboard size={15} />コピー</>}</b></button>)}</div>
}

type AlertItem = { id: string; kind?: 'new' | 'cancel'; starts_at: string; customer_name: string; staff_name: string; rescheduled?: boolean }
/** 新しい AI 予約・アプリでの取り消しの帯。日付も出す（明日以降の予約をサロンボードの今日に入れない）。中身に合わせて「入れました／消しました」 */
/** 帯の予約を押すと詳細（項目ごとのコピー）が開く */
function NewAlert({ list, onAck, onOpen }: { list: AlertItem[]; onAck: () => void; onOpen: (id: string, day: string) => void }) {
  const added = list.filter(r => r.kind !== 'cancel'), removed = list.filter(r => r.kind === 'cancel')
  const today = getJapanDateString()
  const day = (iso: string) => { const d = getJapanDateString(new Date(iso)); if (d === today) return '今日'; const [, m, dd] = d.split('-').map(Number); return `${m}/${dd}` }
  const title = [added.length ? `新しい予約 ${added.length}件` : '', removed.length ? `キャンセル ${removed.length}件` : ''].filter(Boolean).join('・')
  const label = !removed.length ? 'サロンボードに入れました' : !added.length ? 'サロンボードから消しました' : 'サロンボードに反映しました'
  return <div className={`sb-new-alert${removed.length ? ' is-cancel' : ''}`} role="alert"><Bell size={18} /><span><b>{title}</b>
    {list.slice(0, 3).map(r => <button type="button" className="sb-alert-row" key={`${r.kind}:${r.id}`} onClick={() => onOpen(r.id, getJapanDateString(new Date(r.starts_at)))}>{r.kind === 'cancel' ? (r.rescheduled ? '日時変更（元の予約を消す） ' : '取消 ') : ''}{day(r.starts_at)} {jstTime(r.starts_at)} {r.customer_name}様（{r.staff_name}）<ChevronRight size={14} /></button>)}
    {list.length > 3 && <small>ほか {list.length - 3}件</small>}</span>
    <button className="sb-primary" onClick={onAck}>{label}</button></div>
}
