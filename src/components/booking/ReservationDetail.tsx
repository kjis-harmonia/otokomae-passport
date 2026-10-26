import { useEffect, useMemo, useState } from 'react'
import { getJapanDateString, addDaysToDateString } from '../../utils/dateUtils'
import { rpcErrorMessage } from '../../utils/staffSession'
import {
  bookingErrorMessage, jstDateLabel, jstTime, yen, SOURCE_LABEL, STATUS_LABEL,
  type AvailableSlot, type BookingApi, type BookingStaffCandidate, type BookingOptions, type Reservation, type ReservationEvent, type StoreStatus,
} from '../../utils/bookingApi'
import { Chip, ChipRow, Field, PrimaryButton, SecondaryButton, Section, Sheet, TimeGrid } from './ledgerUi'
import { C, inputStyle, linkStyle } from './ledgerTheme'

// 予約の詳細と操作（来店・施術開始・会計待ち・完了・無断キャンセル・担当変更・日時変更・キャンセル）。
// すべて既存の予約 RPC（状態変更／日時・担当変更）を呼ぶだけで、画面側では判定しない。

const EVENT_LABEL: Record<ReservationEvent['event_type'], string> = {
  created: '作成', rescheduled: '日時変更', staff_changed: '担当変更', staff_confirmed: '担当確定', cancelled: 'キャンセル', checked_in: '来店',
  in_service: '施術開始', awaiting_payment: '会計待ち', completed: '完了', no_show: '無断キャンセル',
}

type Mode = 'view' | 'cancel' | 'staff' | 'reschedule'

export function ReservationDetail({ api, options, reservation: r, ensureActor, onClose, onChanged, onOpenCustomer, onCheckout }: {
  api: BookingApi
  options: BookingOptions
  reservation: Reservation
  ensureActor: () => boolean
  onClose: () => void
  onChanged: (r: Reservation) => void
  /** 顧客台帳を開く */
  onOpenCustomer?: () => void
  /** 会計を開く（店舗端末のみ。売上は会計の確定でだけ発生する） */
  onCheckout?: () => void
}) {
  const [mode, setMode] = useState<Mode>('view')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [events, setEvents] = useState<ReservationEvent[] | null>(null)
  const [started] = useState(() => new Date(r.starts_at).getTime() <= Date.now())
  const date = getJapanDateString(new Date(r.starts_at))
  const duration = r.items.reduce((n, i) => n + i.duration_min, 0)
  const cleanup = Math.round((new Date(r.occupied_until).getTime() - new Date(r.ends_at).getTime()) / 60000)

  async function run(fn: () => Promise<Reservation | { error: string }>) {
    if (!ensureActor()) return
    setBusy(true); setError(null)
    try {
      const res = await fn()
      if ('error' in res) setError(bookingErrorMessage(res.error))
      else { setMode('view'); setEvents(null); onChanged(res) }
    } catch (err) {
      setError(rpcErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const status = (s: StoreStatus, why?: string) => run(() => api.setStatus(r.id, s, why))

  async function loadEvents() {
    try { setEvents(await api.events(r.id)) } catch (err) { setError(rpcErrorMessage(err)) }
  }

  const unconfirmed = !r.nominated && !r.staff_confirmed
  const title = `${jstDateLabel(date)} ${jstTime(r.starts_at)}〜${jstTime(r.ends_at)}`

  return (
    <Sheet title={title} onClose={onClose}>
      {mode === 'staff' ? (
        <StaffChange api={api} reservation={r} busy={busy} onCancel={() => setMode('view')}
          onPick={id => void run(() => api.reschedule(r.id, r.starts_at, id))} />
      ) : mode === 'reschedule' ? (
        <Reschedule api={api} options={options} reservation={r} busy={busy} onCancel={() => setMode('view')}
          onPick={(iso, staffId) => void run(() => api.reschedule(r.id, iso, staffId === r.staff_id ? null : staffId))} />
      ) : (
        <>
          <p style={{ fontSize: 20, fontWeight: 600, textDecoration: r.status === 'cancelled' ? 'line-through' : undefined }}>{r.customer_name}</p>
          {r.customer_phone && <a href={`tel:${r.customer_phone}`} style={{ display: 'inline-block', marginTop: 4, fontSize: 15, color: C.text }}>{r.customer_phone}</a>}
          {onOpenCustomer && (
            <p style={{ marginTop: 2, fontSize: 13, color: C.mute }}>
              <button type="button" onClick={onOpenCustomer} style={{ ...linkStyle, color: C.text }}>顧客台帳</button>
            </p>
          )}
          <p style={{ marginTop: 8, fontSize: 15 }}>{STATUS_LABEL[r.status]}{r.cancel_reason ? `（${r.cancel_reason}）` : ''}</p>

          <dl style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '84px 1fr', rowGap: 8, fontSize: 14 }}>
            <dt style={{ color: C.sub }}>メニュー</dt>
            <dd>{r.items.map(i => <span key={i.menu_code} style={{ display: 'block' }}>{i.name}（{i.duration_min}分 {yen(i.price)}）</span>)}</dd>
            <dt style={{ color: C.sub }}>担当</dt><dd>{r.nominated ? `${r.staff_name}（指名）` : `フリー（指名なし） / ${r.staff_name}${r.staff_confirmed ? '' : '（仮）'}`}</dd>
            <dt style={{ color: C.sub }}>所要時間</dt><dd>{duration}分</dd>
            <dt style={{ color: C.sub }}>片付け</dt><dd>{cleanup > 0 ? `${cleanup}分（${jstTime(r.occupied_until)}まで）` : 'なし'}</dd>
            <dt style={{ color: C.sub }}>金額</dt><dd>{yen(r.total_price)}</dd>
            <dt style={{ color: C.sub }}>予約経路</dt><dd>{SOURCE_LABEL[r.source]}</dd>
            {r.external_ref && (<><dt style={{ color: C.sub }}>予約番号</dt><dd style={{ fontVariantNumeric: 'tabular-nums' }}>{r.external_ref}</dd></>)}
            {r.note && (<><dt style={{ color: C.sub }}>メモ</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{r.note}</dd></>)}
          </dl>

          {error && <p style={{ color: C.danger, fontSize: 14, marginTop: 14 }}>{error}</p>}

          {mode === 'cancel' ? (
            <div style={{ marginTop: 18 }}>
              <Field label="キャンセル理由（任意）">
                <input value={reason} onChange={e => setReason(e.target.value)} maxLength={100} style={inputStyle} />
              </Field>
              <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                <SecondaryButton onClick={() => setMode('view')} disabled={busy}>戻る</SecondaryButton>
                <PrimaryButton onClick={() => void status('cancelled', reason)} disabled={busy} danger style={{ flex: 1 }}>キャンセルする</PrimaryButton>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {r.status === 'confirmed' && <PrimaryButton onClick={() => void status('checked_in')} disabled={busy}>来店</PrimaryButton>}
              {r.status === 'checked_in' && <PrimaryButton onClick={() => void status('in_service')} disabled={busy}>施術開始</PrimaryButton>}
              {r.status === 'in_service' && <PrimaryButton onClick={() => void status('awaiting_payment')} disabled={busy}>会計待ちにする</PrimaryButton>}
              {onCheckout ? (
                <>
                  {/* 店舗端末：会計待ち → 会計へ（確定すると予約は完了になる）。施術中・来店済みからも直接会計へ進める */}
                  {r.status === 'awaiting_payment' && <PrimaryButton onClick={onCheckout} disabled={busy}>会計へ</PrimaryButton>}
                  {(r.status === 'checked_in' || r.status === 'in_service') && <SecondaryButton onClick={onCheckout} disabled={busy}>会計へ</SecondaryButton>}
                  {r.status === 'awaiting_payment' && <SecondaryButton onClick={() => void status('completed')} disabled={busy}>会計なしで完了</SecondaryButton>}
                  {r.status === 'completed' && <SecondaryButton onClick={onCheckout} disabled={busy}>会計を確認</SecondaryButton>}
                </>
              ) : (
                <>
                  {r.status === 'awaiting_payment' && <PrimaryButton onClick={() => void status('completed')} disabled={busy}>完了</PrimaryButton>}
                  {(r.status === 'checked_in' || r.status === 'in_service') && (
                    <SecondaryButton onClick={() => void status('completed')} disabled={busy}>完了</SecondaryButton>
                  )}
                  {r.status === 'checked_in' && (
                    <SecondaryButton onClick={() => void status('awaiting_payment')} disabled={busy}>会計待ちにする</SecondaryButton>
                  )}
                </>
              )}
              {(r.status === 'confirmed' || r.status === 'checked_in') && (
                <div style={{ display: 'flex', gap: 10 }}>
                  <SecondaryButton onClick={() => setMode('staff')} disabled={busy}>{unconfirmed ? '担当確定' : '担当変更'}</SecondaryButton>
                  {r.status === 'confirmed' && <SecondaryButton onClick={() => setMode('reschedule')} disabled={busy}>日時変更</SecondaryButton>}
                </div>
              )}
              {r.status === 'confirmed' && (
                <div style={{ display: 'flex', gap: 10 }}>
                  {started && <SecondaryButton onClick={() => void status('no_show')} disabled={busy}>無断キャンセル</SecondaryButton>}
                  <SecondaryButton onClick={() => setMode('cancel')} disabled={busy} danger>キャンセル</SecondaryButton>
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: 18, borderTop: `1px solid ${C.line}`, paddingTop: 4 }}>
            {events === null ? (
              <button type="button" onClick={() => void loadEvents()} style={linkStyle}>変更履歴を見る</button>
            ) : (
              <div style={{ paddingTop: 8 }}>
                {events.map((e, i) => (
                  <p key={i} style={{ fontSize: 13, color: C.sub, lineHeight: 1.9 }}>
                    {new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(e.created_at))}
                    {' '}{EVENT_LABEL[e.event_type]}{eventDetail(e)}{e.actor_name ? ` / ${e.actor_name}` : ''}
                  </p>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </Sheet>
  )
}

function eventDetail(e: ReservationEvent): string {
  if (e.event_type === 'rescheduled' && e.before && e.after) return `（${jstTime(String(e.before.starts_at))} → ${jstTime(String(e.after.starts_at))}）`
  if (e.event_type === 'staff_changed' && e.before && e.after) return `（${e.before.staff_name} → ${e.after.staff_name}）`
  if (e.event_type === 'cancelled' && e.note) return `（${e.note}）`
  return ''
}

/** 担当変更：同じ時間のまま担当できるスタッフだけ（予約エンジン。来店後・開始時刻を過ぎていても可） */
function StaffChange({ api, reservation: r, busy, onCancel, onPick }: {
  api: BookingApi; reservation: Reservation; busy: boolean; onCancel: () => void; onPick: (staffId: string) => void
}) {
  const [free, setFree] = useState<BookingStaffCandidate[] | null>(null)
  const unconfirmed = !r.nominated && !r.staff_confirmed
  useEffect(() => {
    api.reassignCandidates(r.id).then(setFree).catch(() => setFree([]))
  }, [api, r.id])
  return (
    <>
      <p style={{ fontSize: 15 }}>{r.customer_name} {jstTime(r.starts_at)}〜 / 今の担当 {r.staff_name}{unconfirmed ? '（仮）' : ''}</p>
      {unconfirmed && (
        <Section title="担当を確定">
          <ChipRow><Chip selected={false} disabled={busy} onClick={() => onPick(r.staff_id)}>{r.staff_name}で確定</Chip></ChipRow>
        </Section>
      )}
      <Section title="同じ時間に担当できるスタッフ">
        {!free ? <p style={{ color: C.sub, fontSize: 14 }}>確認中…</p>
          : free.length === 0 ? <p style={{ color: C.sub, fontSize: 14 }}>この時間に代われるスタッフはいません。</p>
          : <ChipRow>{free.map(s => <Chip key={s.staff_id} selected={false} disabled={busy} onClick={() => onPick(s.staff_id)}>{s.staff_name}に変更</Chip>)}</ChipRow>}
      </Section>
      <button type="button" onClick={onCancel} style={{ ...linkStyle, marginTop: 12 }}>戻る</button>
    </>
  )
}

/** 日時変更：日付・担当を選ぶと、その予約自身の時間を空きとして扱った空き時間を表示 */
function Reschedule({ api, options, reservation: r, busy, onCancel, onPick }: {
  api: BookingApi; options: BookingOptions; reservation: Reservation; busy: boolean; onCancel: () => void; onPick: (iso: string, staffId: string) => void
}) {
  const today = getJapanDateString()
  const codes = useMemo(() => r.items.map(i => i.menu_code), [r])
  const [date, setDate] = useState(getJapanDateString(new Date(r.starts_at)))
  const [staffId, setStaffId] = useState(r.staff_id)
  const [time, setTime] = useState<string | null>(null)
  const [slots, setSlots] = useState<AvailableSlot[] | null>(null)
  const capable = options.staff.filter(s => codes.every(c => options.menus.find(m => m.code === c)?.staff_ids.includes(s.id)))
  useEffect(() => {
    let alive = true
    setSlots(null); setTime(null) // eslint-disable-line react-hooks/set-state-in-effect
    api.slots(date, codes, staffId, r.id).then(s => { if (alive) setSlots(s) }).catch(() => { if (alive) setSlots([]) })
    return () => { alive = false }
  }, [api, date, staffId, codes, r.id])
  return (
    <>
      <p style={{ fontSize: 15 }}>{r.customer_name}</p>
      <p style={{ fontSize: 13, color: C.sub, marginTop: 4 }}>今の予約 {jstDateLabel(getJapanDateString(new Date(r.starts_at)))} {jstTime(r.starts_at)} / {r.staff_name}</p>
      <Section title="担当">
        <ChipRow>{capable.map(s => <Chip key={s.id} selected={staffId === s.id} onClick={() => setStaffId(s.id)}>{s.name}</Chip>)}</ChipRow>
      </Section>
      <Section title="日付と時間">
        <input type="date" value={date} min={today} max={addDaysToDateString(today, options.settings.booking_window_days)}
          onChange={e => e.target.value && setDate(e.target.value)} style={inputStyle} aria-label="日付" />
        <TimeGrid loading={!slots} times={(slots ?? []).map(s => ({ iso: s.starts_at, text: jstTime(s.starts_at) }))} selected={time} onSelect={setTime} />
      </Section>
      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <SecondaryButton onClick={onCancel} disabled={busy}>戻る</SecondaryButton>
        <PrimaryButton onClick={() => time && onPick(time, staffId)} disabled={!time || busy} style={{ flex: 2 }}>
          {time ? `${jstTime(time)}に変更` : '時間を選んでください'}
        </PrimaryButton>
      </div>
    </>
  )
}
