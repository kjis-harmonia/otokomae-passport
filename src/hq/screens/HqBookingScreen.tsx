import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { HQ_COLORS, HQ_SANS } from '../hqTheme'
import { getJapanDateString, addDaysToDateString } from '../../utils/dateUtils'
import {
  getBookingMasters, updateBookingSettings, upsertStaffMember, getSchedule, setShiftTemplate, setDaySchedule,
  setBusinessHours, createTimeBlock, deleteTimeBlock, setClosure, deleteClosure, hqBookingErrorMessage, jstIso, BLOCK_KIND_LABEL,
  type BookingMasters, type Schedule, type BlockKind, type StaffMember, type BusinessHour, type DaySchedule,
} from '../hqBookingStore'

// 本部：予約設定（シフト・メニュー・スタッフ・営業・設定）
// 見た目は docs/DESIGN_PRINCIPLES.md に従う（文字中心・一覧は罫線・アクセントは選択中と保存だけ）

const T = {
  text: HQ_COLORS.textPrimary,
  sub: HQ_COLORS.textSecondary,
  mute: HQ_COLORS.textMute,
  line: 'rgba(255,255,255,0.09)',
  field: 'rgba(255,255,255,0.04)',
  accent: HQ_COLORS.gold,
  danger: HQ_COLORS.negative,
}
const WEEK = ['日', '月', '火', '水', '木', '金', '土']
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] // 月曜はじまりで表示

// メニュー・価格は本部の「メニュー・価格」で編集する（予約と会計で共通のマスター）
type Tab = 'shifts' | 'staff' | 'hours' | 'settings'
const TABS: { id: Tab; label: string }[] = [
  { id: 'shifts', label: 'シフト' },
  { id: 'staff', label: 'スタッフ' },
  { id: 'hours', label: '営業' },
  { id: 'settings', label: '設定' },
]

export function HqBookingScreen() {
  const [tab, setTab] = useState<Tab>('shifts')
  const [masters, setMasters] = useState<BookingMasters | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try { setMasters(await getBookingMasters()); setError(null) } catch (err) { setError(hqBookingErrorMessage(err)) }
  }, [])
  useEffect(() => { void reload() }, [reload]) // eslint-disable-line react-hooks/set-state-in-effect

  return (
    <div style={{ fontFamily: HQ_SANS, color: T.text, maxWidth: 760 }}>
      <div role="tablist" style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${T.line}`, overflowX: 'auto' }}>
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              padding: '10px 10px', background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', minHeight: 44,
              fontSize: 14, fontFamily: HQ_SANS, color: tab === t.id ? T.text : T.sub,
              borderBottom: `2px solid ${tab === t.id ? T.accent : 'transparent'}`, marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {error && <p style={{ color: T.danger, fontSize: 14, marginTop: 16 }}>{error}</p>}
      {!masters ? (
        !error && <p style={{ color: T.sub, fontSize: 14, marginTop: 16 }}>読み込み中…</p>
      ) : (
        <div style={{ marginTop: 20 }}>
          {tab === 'shifts' && <ShiftsTab masters={masters} onSaved={reload} />}
          {tab === 'staff' && <StaffTab masters={masters} onSaved={reload} />}
          {tab === 'hours' && <HoursTab masters={masters} onSaved={reload} />}
          {tab === 'settings' && <SettingsTab masters={masters} onSaved={reload} />}
        </div>
      )}
    </div>
  )
}

// ── シフト：通常週＋日付ごとの変更・休憩 ─────────────────────────────────────

function mondayOf(ymd: string): string {
  return addDaysToDateString(ymd, -((weekdayOf(ymd) + 6) % 7))
}
function weekdayOf(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}
function dayLabel(ymd: string): string {
  const [, m, d] = ymd.split('-').map(Number)
  return `${m}/${d}（${WEEK[weekdayOf(ymd)]}）`
}
const hm = (iso: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))

function ShiftsTab({ masters, onSaved }: { masters: BookingMasters; onSaved: () => Promise<void> }) {
  const staff = masters.staff.filter(s => s.is_active)
  return (
    <>
      <TemplateEditor masters={masters} staff={staff} onSaved={onSaved} />
      <WeekSchedule masters={masters} staff={staff} />
    </>
  )
}

type TemplateRows = Record<number, { on: boolean; start: string; end: string }>

/** 通常週：スタッフごとに曜日の出勤時間を登録（チェックのない曜日は休み）。毎週くり返し使われる */
function TemplateEditor({ masters, staff, onSaved }: { masters: BookingMasters; staff: StaffMember[]; onSaved: () => Promise<void> }) {
  const [staffId, setStaffId] = useState(staff[0]?.id ?? '')
  const initial = useCallback((id: string): TemplateRows => Object.fromEntries(WEEK_ORDER.map(w => {
    const t = masters.templates.find(x => x.staff_id === id && x.weekday === w)
    return [w, { on: !!t, start: t?.start_time ?? '10:00', end: t?.end_time ?? '19:00' }]
  })), [masters])
  const [rows, setRows] = useState<TemplateRows>(() => initial(staffId))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // 保存後の読み直しで表を更新（結果メッセージは残す）。スタッフを切り替えたときだけメッセージを消す
  useEffect(() => { setRows(initial(staffId)) }, [staffId, initial]) // eslint-disable-line react-hooks/set-state-in-effect
  useEffect(() => { setMsg(null) }, [staffId]) // eslint-disable-line react-hooks/set-state-in-effect

  async function save() {
    setBusy(true); setMsg(null)
    try {
      await setShiftTemplate(staffId, WEEK_ORDER.filter(w => rows[w].on).map(w => ({ weekday: w, start_time: rows[w].start, end_time: rows[w].end })))
      await onSaved()
      setMsg({ ok: true, text: '通常週を保存しました。毎週この時間で予約を受け付けます。' })
    } catch (err) {
      setMsg({ ok: false, text: hqBookingErrorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <SubHeading>通常週</SubHeading>
      <p style={{ fontSize: 13, color: T.sub, lineHeight: 1.7, marginBottom: 10 }}>
        いつもの出勤時間です。毎週くり返し使われます。休みや時間の変更は、下の「日付ごとの勤務」で上書きできます。
      </p>
      <Select label="スタッフ" value={staffId} onChange={setStaffId}>
        {staff.map(s => <option key={s.id} value={s.id}>{s.display_name}</option>)}
      </Select>
      <div style={{ marginTop: 10, borderTop: `1px solid ${T.line}` }}>
        {WEEK_ORDER.map(w => {
          const r = rows[w]
          const set = (patch: Partial<typeof r>) => setRows({ ...rows, [w]: { ...r, ...patch } })
          return (
            <div key={w} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 52, borderBottom: `1px solid ${T.line}` }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, width: 58, fontSize: 15, cursor: 'pointer', minHeight: 44 }}>
                <input type="checkbox" checked={r.on} onChange={e => set({ on: e.target.checked })} style={{ width: 18, height: 18 }} />
                {WEEK[w]}
              </label>
              {r.on ? (
                <>
                  <TimeField value={r.start} onChange={v => set({ start: v })} label={`${WEEK[w]}曜の開始`} />
                  <span style={{ color: T.sub }}>〜</span>
                  <TimeField value={r.end} onChange={v => set({ end: v })} label={`${WEEK[w]}曜の終了`} />
                </>
              ) : (
                <span style={{ fontSize: 14, color: T.mute }}>休み</span>
              )}
            </div>
          )
        })}
      </div>
      {msg && <p style={{ fontSize: 14, color: msg.ok ? T.sub : T.danger, marginTop: 10, lineHeight: 1.6 }}>{msg.text}</p>}
      <div style={{ marginTop: 12 }}>
        <PrimaryButton disabled={busy || !staffId} onClick={() => void save()}>{busy ? '保存中…' : '通常週を保存'}</PrimaryButton>
      </div>
    </section>
  )
}

type DayEdit = { date: string; staffId: string; start: string; end: string }

/** 週ごとの実際の勤務（通常週＋日付の変更）と休憩・予定。日付ごとに上書きできる */
function WeekSchedule({ masters, staff }: { masters: BookingMasters; staff: StaffMember[] }) {
  const nameOf = (id: string | null) => (id ? masters.staff.find(s => s.id === id)?.display_name ?? '—' : '全員')
  const [week, setWeek] = useState(() => mondayOf(getJapanDateString()))
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysToDateString(week, i)), [week])
  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<DayEdit | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [blockForm, setBlockForm] = useState({ staffId: '', date: getJapanDateString(), start: '13:00', end: '14:00', kind: 'break' as BlockKind })
  const [showBlockForm, setShowBlockForm] = useState(false)

  const load = useCallback(async () => {
    try { setSchedule(await getSchedule(days[0], days[6])) } catch (err) { setError(hqBookingErrorMessage(err)) }
  }, [days])
  // 週の切り替え・通常週の保存のたびに読み直す
  useEffect(() => { void load() }, [load, masters.templates]) // eslint-disable-line react-hooks/set-state-in-effect

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null)
    try { await fn(); setEditing(null); setAdding(null); await load() } catch (err) { setError(hqBookingErrorMessage(err)) } finally { setBusy(false) }
  }

  function startEdit(day: DaySchedule) {
    setAdding(null)
    setEditing({ date: day.date, staffId: day.staff_id, start: day.ranges[0]?.start ?? '10:00', end: day.ranges[0]?.end ?? '19:00' })
  }

  return (
    <section style={{ marginTop: 32 }}>
      <SubHeading>日付ごとの勤務</SubHeading>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <TextButton onClick={() => setWeek(addDaysToDateString(week, -7))}>‹ 前の週</TextButton>
        <p style={{ fontSize: 15 }}>{dayLabel(days[0])} 〜 {dayLabel(days[6])}</p>
        <TextButton onClick={() => setWeek(addDaysToDateString(week, 7))}>次の週 ›</TextButton>
      </div>
      {error && <p style={{ color: T.danger, fontSize: 14, marginTop: 8, lineHeight: 1.6 }}>{error}</p>}

      <div style={{ marginTop: 8, borderTop: `1px solid ${T.line}` }}>
        {!schedule ? <p style={{ color: T.sub, fontSize: 14, padding: '16px 0' }}>読み込み中…</p> : days.map(d => {
          const closed = schedule.closures.find(c => c.date === d)
          const entries = schedule.days.filter(x => x.date === d && (x.ranges.length > 0 || x.source === 'off' || x.source === 'override'))
          const blocks = schedule.blocks.filter(b => getJapanDateString(new Date(b.starts_at)) === d)
          const booked = schedule.reservations.filter(r => getJapanDateString(new Date(r.starts_at)) === d).length
          const others = staff.filter(s => !entries.some(e => e.staff_id === s.id))
          const past = d < getJapanDateString() // 過去の日は表示だけ
          return (
            <div key={d} style={{ display: 'grid', gridTemplateColumns: '78px 1fr', gap: 10, padding: '6px 0', borderBottom: `1px solid ${T.line}` }}>
              <div>
                <p style={{ fontSize: 15, lineHeight: '40px' }}>{dayLabel(d)}</p>
                {booked > 0 && <p style={{ fontSize: 12, color: T.sub }}>予約 {booked}件</p>}
              </div>
              <div style={{ minWidth: 0 }}>
                {closed ? (
                  <p style={{ fontSize: 14, lineHeight: '40px' }}>店休日{closed.reason ? `（${closed.reason}）` : ''}</p>
                ) : (
                  <>
                    {entries.length === 0 && !editing && <p style={{ fontSize: 14, color: T.mute, lineHeight: '40px' }}>出勤なし</p>}
                    {entries.map(e => (
                      editing && editing.date === d && editing.staffId === e.staff_id
                        ? <DayEditor key={e.staff_id} name={nameOf(e.staff_id)} edit={editing} busy={busy} onChange={setEditing}
                            onWork={() => void run(() => setDaySchedule(e.staff_id, d, 'work', editing.start, editing.end))}
                            onOff={e.source !== 'off' ? () => void run(() => setDaySchedule(e.staff_id, d, 'off')) : undefined}
                            onReset={e.source === 'override' || e.source === 'off' ? () => void run(() => setDaySchedule(e.staff_id, d, 'template')) : undefined}
                            onCancel={() => setEditing(null)} />
                        : (
                          <Row key={e.staff_id} muted={e.source === 'off'} action={past ? undefined : <TextButton onClick={() => startEdit(e)}>変更</TextButton>}>
                            {nameOf(e.staff_id)}{' '}
                            {e.source === 'off' ? '休み' : e.ranges.map(r => `${r.start}〜${r.end}`).join(' / ')}
                            {e.source === 'override' || e.source === 'off' ? <span style={{ color: T.sub, fontSize: 12 }}>（この日だけ）</span> : null}
                          </Row>
                        )
                    ))}
                    {editing && editing.date === d && !entries.some(e => e.staff_id === editing.staffId) && (
                      <DayEditor name={nameOf(editing.staffId)} edit={editing} busy={busy} onChange={setEditing}
                        onWork={() => void run(() => setDaySchedule(editing.staffId, d, 'work', editing.start, editing.end))}
                        onCancel={() => setEditing(null)} />
                    )}
                    {blocks.map(b => (
                      <Row key={b.id} muted action={<TextButton onClick={() => void run(() => deleteTimeBlock(b.id))}>削除</TextButton>}>
                        {BLOCK_KIND_LABEL[b.kind]} {hm(b.starts_at)}〜{hm(b.ends_at)} / {nameOf(b.staff_id)}
                      </Row>
                    ))}
                    {others.length > 0 && !editing && !past && (adding === d ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '4px 0' }}>
                        {others.map(s => (
                          <Toggle key={s.id} on={false} onClick={() => { setAdding(null); setEditing({ date: d, staffId: s.id, start: '10:00', end: '19:00' }) }}>{s.display_name}</Toggle>
                        ))}
                        <TextButton onClick={() => setAdding(null)}>やめる</TextButton>
                      </div>
                    ) : (
                      <TextButton onClick={() => setAdding(d)}>＋ 出勤を追加</TextButton>
                    ))}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ marginTop: 16 }}>
        {showBlockForm ? (
          <>
            <SubHeading>休憩・予定を追加（予約ではない時間）</SubHeading>
            <FormRow>
              <Select value={blockForm.staffId} onChange={v => setBlockForm({ ...blockForm, staffId: v })} label="対象">
                <option value="">全員</option>
                {staff.map(s => <option key={s.id} value={s.id}>{s.display_name}</option>)}
              </Select>
              <Input type="date" label="日付" value={blockForm.date} onChange={v => setBlockForm({ ...blockForm, date: v })} />
              <Input type="time" label="開始" value={blockForm.start} step={900} onChange={v => setBlockForm({ ...blockForm, start: v })} />
              <Input type="time" label="終了" value={blockForm.end} step={900} onChange={v => setBlockForm({ ...blockForm, end: v })} />
              <Select value={blockForm.kind} onChange={v => setBlockForm({ ...blockForm, kind: v as BlockKind })} label="種類">
                {(Object.keys(BLOCK_KIND_LABEL) as BlockKind[]).map(k => <option key={k} value={k}>{BLOCK_KIND_LABEL[k]}</option>)}
              </Select>
              <PrimaryButton disabled={busy} onClick={() => void run(async () => {
                await createTimeBlock({ staff_id: blockForm.staffId || null, starts_at: jstIso(blockForm.date, blockForm.start), ends_at: jstIso(blockForm.date, blockForm.end), kind: blockForm.kind })
                setShowBlockForm(false)
              })}>追加</PrimaryButton>
              <TextButton onClick={() => setShowBlockForm(false)}>やめる</TextButton>
            </FormRow>
          </>
        ) : (
          <TextButton onClick={() => setShowBlockForm(true)}>＋ 休憩・予定を追加</TextButton>
        )}
      </div>
    </section>
  )
}

function DayEditor({ name, edit, busy, onChange, onWork, onOff, onReset, onCancel }: {
  name: string
  edit: DayEdit
  busy: boolean
  onChange: (e: DayEdit) => void
  onWork: () => void
  onOff?: () => void
  onReset?: () => void
  onCancel: () => void
}) {
  return (
    <div style={{ padding: '6px 0' }}>
      <p style={{ fontSize: 14, marginBottom: 6 }}>{name}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <TimeField value={edit.start} onChange={v => onChange({ ...edit, start: v })} label="開始" />
        <span style={{ color: T.sub }}>〜</span>
        <TimeField value={edit.end} onChange={v => onChange({ ...edit, end: v })} label="終了" />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 8 }}>
        <PrimaryButton disabled={busy} onClick={onWork}>この時間で出勤</PrimaryButton>
        {onOff && <TextButton onClick={onOff}>この日は休み</TextButton>}
        {onReset && <TextButton onClick={onReset}>通常週に戻す</TextButton>}
        <TextButton onClick={onCancel}>やめる</TextButton>
      </div>
    </div>
  )
}

// ── スタッフ ─────────────────────────────────────────────────────────────────

function StaffTab({ masters, onSaved }: { masters: BookingMasters; onSaved: () => Promise<void> }) {
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null)
    try { await fn(); await onSaved() } catch (err) { setError(hqBookingErrorMessage(err)) } finally { setBusy(false) }
  }

  return (
    <>
      <div style={{ borderTop: `1px solid ${T.line}` }}>
        {masters.staff.map(s => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: `1px solid ${T.line}` }}>
            <span style={{ fontSize: 15, color: s.is_active ? T.text : T.mute }}>{s.display_name}</span>
            <span style={{ display: 'flex', gap: 8 }}>
              <Toggle on={s.is_bookable} disabled={busy || !s.is_active} onClick={() => void run(() => upsertStaffMember({ id: s.id, is_bookable: !s.is_bookable }))}>予約を受ける</Toggle>
              <Toggle on={s.is_active} disabled={busy} onClick={() => void run(() => upsertStaffMember({ id: s.id, is_active: !s.is_active }))}>在籍</Toggle>
            </span>
          </div>
        ))}
      </div>
      <FormRow style={{ marginTop: 16 }}>
        <Input label="スタッフを追加" value={newName} onChange={setNewName} />
        <PrimaryButton disabled={busy || newName.trim() === ''} onClick={() => void run(async () => { await upsertStaffMember({ display_name: newName.trim(), sort_order: 100 }); setNewName('') })}>
          追加
        </PrimaryButton>
      </FormRow>
      {error && <p style={{ color: T.danger, fontSize: 14, marginTop: 12 }}>{error}</p>}
    </>
  )
}

// ── 営業：営業時間・店休日 ─────────────────────────────────────────────────────

type HourRows = Record<number, { set: boolean; closed: boolean; open: string; close: string }>

function HoursTab({ masters, onSaved }: { masters: BookingMasters; onSaved: () => Promise<void> }) {
  const [rows, setRows] = useState<HourRows>(() => Object.fromEntries(WEEK_ORDER.map(w => {
    const b = masters.business_hours.find(x => x.weekday === w)
    return [w, { set: !!b, closed: b?.is_closed ?? false, open: b?.open_time ?? '10:00', close: b?.close_time ?? '20:00' }]
  })))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const today = getJapanDateString()
  const [closures, setClosures] = useState<{ date: string; reason: string | null }[] | null>(null)
  const [closureDate, setClosureDate] = useState(today)
  const [closureReason, setClosureReason] = useState('')
  const [closureError, setClosureError] = useState<string | null>(null)

  const loadClosures = useCallback(async () => {
    try { setClosures((await getSchedule(today, addDaysToDateString(today, 62))).closures) } catch (err) { setClosureError(hqBookingErrorMessage(err)) }
  }, [today])
  useEffect(() => { void loadClosures() }, [loadClosures]) // eslint-disable-line react-hooks/set-state-in-effect

  async function saveHours() {
    setBusy(true); setMsg(null)
    try {
      const days: BusinessHour[] = WEEK_ORDER.filter(w => rows[w].set).map(w => ({
        weekday: w, is_closed: rows[w].closed, open_time: rows[w].closed ? null : rows[w].open, close_time: rows[w].closed ? null : rows[w].close,
      }))
      await setBusinessHours(days)
      await onSaved()
      setMsg({ ok: true, text: '営業時間を保存しました。' })
    } catch (err) {
      setMsg({ ok: false, text: hqBookingErrorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  async function closure(fn: () => Promise<unknown>) {
    setBusy(true); setClosureError(null)
    try { await fn(); await loadClosures() } catch (err) { setClosureError(hqBookingErrorMessage(err)) } finally { setBusy(false) }
  }

  return (
    <>
      <SubHeading>営業時間</SubHeading>
      <p style={{ fontSize: 13, color: T.sub, lineHeight: 1.7, marginBottom: 10 }}>
        予約はシフトと営業時間の両方に収まる時間だけ受け付けます。「指定しない」曜日はシフトだけで判断します。
      </p>
      <div style={{ borderTop: `1px solid ${T.line}` }}>
        {WEEK_ORDER.map(w => {
          const r = rows[w]
          const set = (patch: Partial<typeof r>) => setRows({ ...rows, [w]: { ...r, ...patch } })
          const mode = !r.set ? 'none' : r.closed ? 'closed' : 'open'
          return (
            <div key={w} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 52, padding: '6px 0', borderBottom: `1px solid ${T.line}`, flexWrap: 'wrap' }}>
              <span style={{ width: 22, fontSize: 15 }}>{WEEK[w]}</span>
              <select aria-label={`${WEEK[w]}曜の営業`} value={mode} style={{ ...fieldStyle, width: 112 }}
                onChange={e => set({ set: e.target.value !== 'none', closed: e.target.value === 'closed' })}>
                <option value="open">営業</option>
                <option value="closed">定休日</option>
                <option value="none">指定しない</option>
              </select>
              {mode === 'open' && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <TimeField value={r.open} onChange={v => set({ open: v })} label={`${WEEK[w]}曜の開店`} />
                  <span style={{ color: T.sub }}>〜</span>
                  <TimeField value={r.close} onChange={v => set({ close: v })} label={`${WEEK[w]}曜の閉店`} />
                </span>
              )}
            </div>
          )
        })}
      </div>
      {msg && <p style={{ fontSize: 14, color: msg.ok ? T.sub : T.danger, marginTop: 10, lineHeight: 1.6 }}>{msg.text}</p>}
      <div style={{ marginTop: 12 }}>
        <PrimaryButton disabled={busy} onClick={() => void saveHours()}>{busy ? '保存中…' : '営業時間を保存'}</PrimaryButton>
      </div>

      <SubHeading>店休日（臨時休業など）</SubHeading>
      <FormRow>
        <Input type="date" label="日付" value={closureDate} onChange={setClosureDate} />
        <Input label="理由（任意）" value={closureReason} onChange={setClosureReason} />
        <PrimaryButton disabled={busy} onClick={() => void closure(async () => { await setClosure(closureDate, closureReason); setClosureReason('') })}>追加</PrimaryButton>
      </FormRow>
      {closureError && <p style={{ color: T.danger, fontSize: 14, marginTop: 10, lineHeight: 1.6 }}>{closureError}</p>}
      <div style={{ marginTop: 12, borderTop: `1px solid ${T.line}` }}>
        {closures === null ? <p style={{ color: T.sub, fontSize: 14, padding: '12px 0' }}>読み込み中…</p>
          : closures.length === 0 ? <p style={{ color: T.mute, fontSize: 14, padding: '12px 0' }}>今後2か月の店休日はありません。</p>
          : closures.map(c => (
            <Row key={c.date} action={<TextButton onClick={() => void closure(() => deleteClosure(c.date))}>解除</TextButton>}>
              {dayLabel(c.date)}{c.reason ? ` ${c.reason}` : ''}
            </Row>
          ))}
      </div>
    </>
  )
}

// ── 受付設定 ─────────────────────────────────────────────────────────────────

function SettingsTab({ masters, onSaved }: { masters: BookingMasters; onSaved: () => Promise<void> }) {
  const s = masters.settings
  const [v, setV] = useState({
    slot_minutes: String(s.slot_minutes), booking_window_days: String(s.booking_window_days), min_lead_minutes: String(s.min_lead_minutes),
    hold_minutes: String(s.hold_minutes), customer_cancel_deadline_minutes: String(s.customer_cancel_deadline_minutes),
  })
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true); setMsg(null)
    try {
      await updateBookingSettings(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Number(x)])))
      await onSaved()
      setMsg('保存しました。')
    } catch (err) {
      setMsg(hqBookingErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
      <Select label="予約の時間刻み" value={v.slot_minutes} onChange={x => setV({ ...v, slot_minutes: x })}>
        {[5, 10, 15, 20, 30, 60].map(n => <option key={n} value={n}>{n}分</option>)}
      </Select>
      <Input label="何日先まで受け付けるか（日）" type="number" value={v.booking_window_days} onChange={x => setV({ ...v, booking_window_days: x })} />
      <Input label="当日予約の締切（開始の何分前まで）" type="number" value={v.min_lead_minutes} onChange={x => setV({ ...v, min_lead_minutes: x })} />
      <Input label="予約確定前の仮確保（分）" type="number" value={v.hold_minutes} onChange={x => setV({ ...v, hold_minutes: x })} />
      <Input label="アプリからのキャンセル締切（開始の何分前まで）" type="number" value={v.customer_cancel_deadline_minutes} onChange={x => setV({ ...v, customer_cancel_deadline_minutes: x })} />
      <p style={{ fontSize: 14, color: T.sub }}>
        お客様アプリからの予約：{s.app_booking_enabled ? '受付中' : '停止中'}（本番公開時に切り替えます）
      </p>
      {msg && <p style={{ fontSize: 14, color: msg === '保存しました。' ? T.sub : T.danger }}>{msg}</p>}
      <PrimaryButton disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</PrimaryButton>
    </div>
  )
}

// ── 共通部品 ─────────────────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  height: 40, boxSizing: 'border-box', padding: '0 10px', borderRadius: 6, fontSize: 15, fontFamily: HQ_SANS,
  background: T.field, color: T.text, border: `1px solid ${T.line}`, outline: 'none', colorScheme: 'dark', width: '100%',
}

function SubHeading({ children }: { children: ReactNode }) {
  return <h3 style={{ fontSize: 13, fontWeight: 600, color: T.sub, marginTop: 24, marginBottom: 8 }}>{children}</h3>
}

function FormRow({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, ...style }}>{children}</div>
}

function Input({ label, value, onChange, type = 'text', step }: { label: string; value: string; onChange: (v: string) => void; type?: string; step?: number }) {
  return (
    <label style={{ display: 'block', flex: type === 'time' ? '0 0 104px' : type === 'date' ? '0 0 150px' : '1 1 140px' }}>
      <span style={{ display: 'block', fontSize: 12, color: T.sub, marginBottom: 4 }}>{label}</span>
      <input type={type} value={value} step={step} onChange={e => onChange(e.target.value)} style={fieldStyle} />
    </label>
  )
}

function TimeField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return <input type="time" step={900} value={value} aria-label={label} onChange={e => onChange(e.target.value)} style={{ ...fieldStyle, width: 104 }} />
}

function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <label style={{ display: 'block', flex: '0 0 130px' }}>
      <span style={{ display: 'block', fontSize: 12, color: T.sub, marginBottom: 4 }}>{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)} style={fieldStyle}>{children}</select>
    </label>
  )
}

function PrimaryButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        height: 40, padding: '0 18px', borderRadius: 6, fontSize: 14, fontWeight: 600, fontFamily: HQ_SANS,
        background: disabled ? 'rgba(255,255,255,0.08)' : T.accent, color: disabled ? T.mute : '#14100A',
        border: 'none', cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {children}
    </button>
  )
}

function TextButton({ onClick, children, style }: { onClick: () => void; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <button type="button" onClick={onClick}
      style={{ display: 'inline-flex', alignItems: 'center', minHeight: 40, background: 'none', border: 'none', padding: 0, color: T.sub, fontSize: 14, fontFamily: HQ_SANS, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3, ...style }}>
      {children}
    </button>
  )
}

function Toggle({ on, onClick, disabled, children }: { on: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-pressed={on}
      style={{
        minHeight: 40, padding: '0 12px', borderRadius: 20, fontSize: 13, fontFamily: HQ_SANS, cursor: disabled ? 'default' : 'pointer',
        background: on ? T.text : 'transparent', color: on ? '#0B0B0B' : T.sub, border: `1px solid ${on ? T.text : T.line}`, opacity: disabled ? 0.5 : 1,
      }}>
      {children}
    </button>
  )
}

function Row({ children, action, muted }: { children: ReactNode; action?: ReactNode; muted?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 14, color: muted ? T.sub : T.text, minHeight: 40 }}>
      <span style={{ minWidth: 0 }}>{children}</span>
      {action}
    </div>
  )
}
