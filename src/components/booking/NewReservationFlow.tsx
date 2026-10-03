import { useEffect, useMemo, useState } from 'react'
import { getJapanDateString, addDaysToDateString } from '../../utils/dateUtils'
import { rpcErrorMessage } from '../../utils/staffSession'
import {
  bookingErrorMessage, jstDateLabel, jstIsoFromMinutes, jstMinutesOf, jstTime, yen, SOURCE_LABEL,
  type AvailableSlot, type BookingApi, type BookingOptions, type Ledger, type Reservation,
} from '../../utils/bookingApi'
import { matchText, type ClientCandidate } from '../../utils/customerApi'
import { Chip, ChipRow, Field, OptionRow, PrimaryButton, SecondaryButton, Section, Sheet, TimeGrid } from './ledgerUi'
import { C, inputStyle, linkStyle } from './ledgerTheme'

// 新規予約：日時 → お客様 → メニュー → 担当 → 確認。
// 担当の候補は予約エンジン（available_slots）が返した「その時間に空いている人」だけ。

const STEPS = ['日時', 'お客様', 'メニュー', '担当', '確認'] as const

/** staffId：台帳でタップした行（null＝フリー行＝指名なし） */
export interface NewReservationPreset { date: string; minutes?: number; staffId?: string | null }

export function NewReservationFlow({ api, options, preset, ensureActor, onClose, onDone, findClients }: {
  api: BookingApi
  /** 既存の顧客を探す（名前・電話番号）。選ばなければ新しい顧客として登録される */
  findClients?: (query: string) => Promise<ClientCandidate[]>
  options: BookingOptions
  preset: NewReservationPreset
  ensureActor: () => boolean
  onClose: () => void
  onDone: (r: Reservation) => void
}) {
  const today = getJapanDateString()
  const [step, setStep] = useState(0)
  const [date, setDate] = useState(preset.date < today ? today : preset.date)
  const [start, setStart] = useState<string | null>(preset.minutes !== undefined ? jstIsoFromMinutes(preset.date, preset.minutes) : null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [source, setSource] = useState<'phone' | 'hotpepper' | 'staff'>('phone')
  const [ref, setRef] = useState('')
  const [note, setNote] = useState('')
  const [menuCodes, setMenuCodes] = useState<string[]>([])
  const [staffId, setStaffId] = useState<string | null | undefined>(undefined) // undefined = 未選択 / null = 指名なし
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [client, setClient] = useState<ClientCandidate | null>(null)

  // 2. お客様：入力した電話番号（4桁以上）か名前で既存の顧客を探す。選ぶのは人（自動では同じ顧客にしない）
  const [found, setFound] = useState<ClientCandidate[]>([])
  const digits = phone.replace(/\D/g, '')
  const query = digits.length >= 4 ? digits : name.trim().length >= 2 ? name.trim() : ''
  useEffect(() => {
    if (step !== 1 || !findClients || client) return
    let alive = true
    const t = window.setTimeout(() => {
      if (!query) { setFound([]); return }
      findClients(query).then(x => { if (alive) setFound(x.slice(0, 5)) }).catch(() => { if (alive) setFound([]) })
    }, 300)
    return () => { alive = false; window.clearTimeout(t) }
  }, [step, findClients, client, query])

  // 1. 日時：その日に誰かが勤務している時間（15分刻み）
  const [dayLedger, setDayLedger] = useState<Ledger | null>(null)
  useEffect(() => {
    let alive = true
    setDayLedger(null) // eslint-disable-line react-hooks/set-state-in-effect
    api.ledger(date).then(l => { if (alive) setDayLedger(l) }).catch(() => { if (alive) setDayLedger(null) })
    return () => { alive = false }
  }, [api, date])
  const workingTimes = useMemo(() => {
    if (!dayLedger || dayLedger.closure) return []
    const slot = dayLedger.slot_minutes
    const set = new Set<number>()
    const nowMin = date === today ? jstMinutesOf(new Date().toISOString(), date) : -1
    for (const s of dayLedger.staff) for (const r of s.shifts) {
      const a = jstMinutesOf(r.start, date), b = jstMinutesOf(r.end, date)
      for (let m = Math.ceil(a / slot) * slot; m < b; m += slot) if (m >= nowMin) set.add(m)
    }
    return [...set].sort((x, y) => x - y).map(m => { const iso = jstIsoFromMinutes(date, m); return { iso, text: jstTime(iso) } })
  }, [dayLedger, date, today])

  // 4. 担当：選んだ時間に空いているスタッフ（予約エンジン）
  const [slots, setSlots] = useState<AvailableSlot[] | null>(null)
  useEffect(() => {
    if (step !== 3 || menuCodes.length === 0) return
    let alive = true
    setSlots(null) // eslint-disable-line react-hooks/set-state-in-effect
    api.slots(date, menuCodes, null).then(s => { if (alive) setSlots(s) }).catch(() => { if (alive) setSlots([]) })
    return () => { alive = false }
  }, [api, step, date, menuCodes])
  const sameTime = (a: string, b: string) => new Date(a).getTime() === new Date(b).getTime()
  const freeStaff = useMemo(() => (slots ?? []).filter(s => start && sameTime(s.starts_at, start)), [slots, start])
  const nearby = useMemo(() => {
    if (!start || !slots) return []
    const t = new Date(start).getTime()
    const uniq = [...new Set(slots.map(s => s.starts_at))].filter(x => new Date(x).getTime() !== t)
    return uniq.sort((a, b) => Math.abs(new Date(a).getTime() - t) - Math.abs(new Date(b).getTime() - t)).slice(0, 8)
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
  }, [slots, start])
  useEffect(() => {
    if (step !== 3 || !slots) return
    // 台帳で選んだ行（スタッフ／フリー）が空いていれば最初から選んでおく
    if (staffId === undefined && preset.staffId && freeStaff.some(s => s.staff_id === preset.staffId)) setStaffId(preset.staffId) // eslint-disable-line react-hooks/set-state-in-effect
    if (staffId === undefined && preset.staffId === null && freeStaff.length > 0) setStaffId(null)
    if (staffId && !freeStaff.some(s => s.staff_id === staffId)) setStaffId(undefined)
  }, [step, slots, freeStaff, staffId, preset.staffId])

  const menus = options.menus.filter(m => menuCodes.includes(m.code))
  const totalMin = menus.reduce((n, m) => n + m.duration_min, 0)
  const totalPrice = menus.every(m => m.price !== null) ? menus.reduce((n, m) => n + (m.price ?? 0), 0) : null
  const staffName = staffId ? options.staff.find(s => s.id === staffId)?.name : 'フリー（指名なし）'

  const canNext = [
    !!start,
    name.trim() !== '' && (source !== 'hotpepper' || ref.trim() !== ''),
    menuCodes.length > 0,
    staffId !== undefined && !!start && (staffId === null ? freeStaff.length > 0 : freeStaff.some(s => s.staff_id === staffId)),
    true,
  ][step]

  async function submit() {
    if (!start || staffId === undefined) return
    if (!ensureActor()) return
    setBusy(true); setError(null)
    try {
      const res = await api.create({
        starts_at: start, menu_codes: menuCodes, staff_id: staffId, customer_name: name.trim(),
        customer_phone: phone.trim() || undefined, source, external_ref: source === 'hotpepper' ? ref.trim() : undefined,
        note: note.trim() || undefined, client_id: client?.id,
      })
      if ('error' in res) {
        setError(bookingErrorMessage(res.error))
        if (res.error === 'slot_taken') { setStep(3); setSlots(null); setStaffId(undefined) }
      } else onDone(res)
    } catch (err) {
      setError(rpcErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <div style={{ display: 'flex', gap: 10 }}>
      {step > 0 && <SecondaryButton onClick={() => { setError(null); setStep(step - 1) }} disabled={busy}>戻る</SecondaryButton>}
      {step < 4
        ? <PrimaryButton onClick={() => { setError(null); setStep(step + 1) }} disabled={!canNext} style={{ flex: 2 }}>次へ</PrimaryButton>
        : <PrimaryButton onClick={() => void submit()} disabled={busy} style={{ flex: 2 }}>{busy ? '登録中…' : '予約を登録'}</PrimaryButton>}
    </div>
  )

  return (
    <Sheet title={`新規予約 ${step + 1}/${STEPS.length} ${STEPS[step]}`} onClose={onClose} footer={footer}>
      {step === 0 && (
        <Section title="日付と開始時刻">
          <input type="date" value={date} min={today} max={addDaysToDateString(today, options.settings.booking_window_days)}
            onChange={e => { if (e.target.value) { setDate(e.target.value); setStart(null) } }} style={inputStyle} aria-label="日付" />
          <TimeGrid loading={!dayLedger} times={workingTimes} selected={start} onSelect={setStart} label="この日は勤務しているスタッフがいません。" />
        </Section>
      )}

      {step === 1 && (
        <Section title="お客様">
          <Field label="お名前">
            <input value={name} onChange={e => setName(e.target.value)} maxLength={60} style={inputStyle} autoComplete="off" />
          </Field>
          <Field label="電話番号（任意）">
            <input value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" maxLength={20} style={inputStyle} autoComplete="off" />
          </Field>
          <Field label="予約経路">
            <ChipRow>
              {(['phone', 'hotpepper', 'staff'] as const).map(s => (
                <Chip key={s} selected={source === s} onClick={() => setSource(s)}>{SOURCE_LABEL[s]}</Chip>
              ))}
            </ChipRow>
          </Field>
          {source === 'hotpepper' && (
            <Field label="HOT PEPPER 予約番号">
              <input value={ref} onChange={e => setRef(e.target.value)} maxLength={40} style={inputStyle} autoComplete="off" />
            </Field>
          )}
          <Field label="メモ（任意）">
            <textarea value={note} onChange={e => setNote(e.target.value)} maxLength={500} rows={2}
              style={{ ...inputStyle, height: 'auto', padding: '10px 12px', resize: 'vertical' }} />
          </Field>
          {findClients && (
            <div style={{ marginTop: 18, borderTop: `1px solid ${C.line}`, paddingTop: 10 }}>
              {client ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <p style={{ fontSize: 14, lineHeight: 1.6 }}>
                    既存の顧客 <b style={{ fontWeight: 600 }}>{client.name}</b>（来店{client.visit_count}回）の予約として登録します
                  </p>
                  <button type="button" onClick={() => setClient(null)} style={{ ...linkStyle, flexShrink: 0 }}>選び直す</button>
                </div>
              ) : (
                <>
                  <p style={{ fontSize: 13, color: C.sub }}>
                    {found.length ? '既存の顧客（同じ人なら選んでください）' : '選ばなければ新しい顧客として登録します'}
                  </p>
                  {found.map(k => (
                    <OptionRow key={k.id} selected={false} check={false} onClick={() => { setClient(k); if (!name.trim()) setName(k.name) }}>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontWeight: 600 }}>{k.name}</span>
                        <span style={{ display: 'block', fontSize: 12, color: C.mute, marginTop: 2 }}>
                          {[matchText(k), k.phone ?? (k.phone_last4 ? `下4桁 ${k.phone_last4}` : null), `来店${k.visit_count}回`, k.app_linked ? 'App連携済み' : null].filter(Boolean).join('・')}
                        </span>
                      </span>
                      <span style={{ color: C.sub, whiteSpace: 'nowrap', fontSize: 14 }}>この顧客</span>
                    </OptionRow>
                  ))}
                </>
              )}
            </div>
          )}
        </Section>
      )}

      {step === 2 && (
        <Section title="メニュー">
          {options.menus.length === 0 && <p style={{ color: C.sub, fontSize: 14 }}>予約できるメニューがありません。本部の予約設定で所要時間と担当を設定してください。</p>}
          {options.menus.map(m => {
            const on = menuCodes.includes(m.code)
            return (
              <OptionRow key={m.code} selected={on} onClick={() => { setStaffId(undefined); setMenuCodes(on ? menuCodes.filter(c => c !== m.code) : [...menuCodes, m.code]) }}>
                <span>{m.name}</span>
                <span style={{ color: C.sub, whiteSpace: 'nowrap' }}>{m.duration_min}分 / {yen(m.price)}</span>
              </OptionRow>
            )
          })}
        </Section>
      )}

      {step === 3 && (
        <Section title={`担当（${start ? jstTime(start) : ''} から ${totalMin}分）`}>
          {!slots ? <p style={{ color: C.sub, fontSize: 14 }}>空いている担当を確認中…</p> : freeStaff.length > 0 ? (
            <ChipRow>
              <Chip selected={staffId === null} onClick={() => setStaffId(null)}>フリー（指名なし）</Chip>
              {freeStaff.map(s => <Chip key={s.staff_id} selected={staffId === s.staff_id} onClick={() => setStaffId(s.staff_id)}>{s.staff_name}</Chip>)}
            </ChipRow>
          ) : (
            <>
              <p style={{ fontSize: 14, color: C.sub, lineHeight: 1.7 }}>この時間はこのメニューを受けられる担当が空いていません。近い空き時間：</p>
              <TimeGrid loading={false} times={nearby.map(x => ({ iso: x, text: jstTime(x) }))} selected={null}
                onSelect={iso => { setStart(iso); setStaffId(undefined) }} label="この日は空き時間がありません。日付を変えてください。" />
            </>
          )}
        </Section>
      )}

      {step === 4 && start && (
        <Section title="内容を確認">
          <dl style={{ display: 'grid', gridTemplateColumns: '84px 1fr', rowGap: 10, fontSize: 15 }}>
            <dt style={{ color: C.sub }}>日時</dt><dd>{jstDateLabel(date)} {jstTime(start)}〜（{totalMin}分）</dd>
            <dt style={{ color: C.sub }}>お客様</dt><dd>{name}{phone ? `（${phone}）` : ''}</dd>
            {findClients && (<><dt style={{ color: C.sub }}>顧客</dt><dd>{client ? `既存の顧客（${client.name}・来店${client.visit_count}回）` : '新しい顧客として登録'}</dd></>)}
            <dt style={{ color: C.sub }}>メニュー</dt><dd>{menus.map(m => m.name).join('、')}</dd>
            <dt style={{ color: C.sub }}>担当</dt><dd>{staffName}</dd>
            <dt style={{ color: C.sub }}>金額</dt><dd>{yen(totalPrice)}</dd>
            <dt style={{ color: C.sub }}>予約経路</dt><dd>{SOURCE_LABEL[source]}{source === 'hotpepper' && ref ? ` ${ref}` : ''}</dd>
            {note && (<><dt style={{ color: C.sub }}>メモ</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{note}</dd></>)}
          </dl>
        </Section>
      )}

      {error && <p style={{ color: C.danger, fontSize: 14, marginTop: 14 }}>{error}</p>}
    </Sheet>
  )
}
