import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, Check } from 'lucide-react'
import { addDaysToDateString, getJapanDateString } from '../utils/dateUtils'
import { jstDateLabel, jstIsoFromMinutes, jstTime, yen } from '../utils/bookingApi'
import { createStaffCustomerApi, type ClientCandidate } from '../utils/customerApi'
import { sbApi, sbError } from './sbApi'
import type { SbCommand, SbInput, SbOptions, SbPreview, SbReservation } from './sbTypes'
import { SbModal } from './SbModal'
import { SbMenuPicker } from './SbMenuPicker'
import { recordMenuUsage } from './sbMenuUsage'

/** 新規予約の初期値。draft は「話して予約登録」で読み取った内容（スタッフがフォームで確かめてから送る） */
export interface SbPreset {
  date: string; minutes?: number; staffId?: string | null
  draft?: { customerName: string | null; phone: string | null; menuCodes: string[]; source: SbInput['source'] | null; externalRef: string | null; understood: string[] }
}
export function SbBookingEditor({ options, preset, reservation, actor, setActor, busy: sending, onSend, onClose }: {
  options: SbOptions; preset: SbPreset; reservation?: SbReservation; actor: string; setActor: (name: string) => void
  busy: boolean; onSend: (command: SbCommand) => Promise<void>; onClose: () => void
}) {
  const r = reservation
  const d = r ? undefined : preset.draft
  const [name, setName] = useState(r?.customer_name ?? d?.customerName ?? '')
  const [phone, setPhone] = useState(r?.customer_phone ?? d?.phone ?? '')
  const [source, setSource] = useState<SbInput['source']>(r?.source === 'hotpepper' ? 'hotpepper' : r?.source === 'phone' ? 'phone' : r ? 'staff' : d?.source ?? 'staff')
  const [externalRef, setExternalRef] = useState(r?.external_ref ?? d?.externalRef ?? '')
  const [note, setNote] = useState(r?.note ?? '')
  const [client, setClient] = useState<{ id: string; name: string } | null>(r ? { id: r.client_id, name: r.customer_name } : null)
  const [codes, setCodes] = useState<string[]>(r?.items.map(i => i.menu_code) ?? d?.menuCodes ?? [])
  const [date, setDate] = useState(preset.date)
  const [time, setTime] = useState(r ? jstTime(r.starts_at) : preset.minutes !== undefined ? `${String(Math.floor(preset.minutes / 60)).padStart(2, '0')}:${String(preset.minutes % 60).padStart(2, '0')}` : '')
  const [staffId, setStaffId] = useState<string | null>(r ? r.nominated ? r.staff_id : null : preset.staffId ?? null)
  const [candidates, setCandidates] = useState<ClientCandidate[]>([])
  const [slots, setSlots] = useState<{ starts_at: string; staff_id: string }[] | null>(null)
  const [slotError, setSlotError] = useState(false)
  const [preview, setPreview] = useState<{ input: SbInput; value: SbPreview; actor: string } | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const reviewing = useRef(false)
  const busy = sending || checking
  const query = phone.replace(/\D/g, '').length >= 4 ? phone.replace(/\D/g, '') : name.trim().length >= 2 ? name.trim() : ''
  const codeKey = JSON.stringify(codes)
  const searchApi = useMemo(() => createStaffCustomerApi(() => actor), [actor])

  useEffect(() => {
    if (r || client || !query || preview) return
    let alive = true
    const timer = window.setTimeout(() => { void searchApi.candidates(null, query).then(v => { if (alive) setCandidates(v.slice(0, 5)) }).catch(() => { if (alive) setCandidates([]) }) }, 300)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [r, client, query, searchApi, preview])
  useEffect(() => {
    let alive = true
    setSlots(null); setSlotError(false) // eslint-disable-line react-hooks/set-state-in-effect
    if (!codes.length || !date) return
    void sbApi.slots(date, codes, staffId, r?.id).then(v => { if (alive) setSlots(v) }).catch(() => { if (alive) { setSlots([]); setSlotError(true) } })
    return () => { alive = false }
  }, [date, codeKey, staffId, r?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function review() {
    if (reviewing.current || busy || !form.current?.reportValidity()) return
    if (!options.actors.some(a => a.name === actor)) { setError('操作者を選択してください。'); return }
    if (!codes.length) { setError('メニューを選択してください。'); return }
    reviewing.current = true; setChecking(true); setError(null)
    try {
      const [h, m] = time.split(':').map(Number)
      const input: SbInput = { starts_at: jstIsoFromMinutes(date, h * 60 + m), menu_codes: [...codes], staff_id: staffId,
        customer_name: name.trim(), customer_phone: phone.trim() || undefined, source,
        external_ref: source === 'hotpepper' ? externalRef.trim() : undefined, note: note.trim() || undefined, client_id: client?.id }
      const value = await sbApi.preview(input, r?.id)
      // Freeze the reviewed request, not the mutable controls.
      setPreview({ input: JSON.parse(JSON.stringify(input)), value, actor })
    } catch (err) { setError(sbError(err)) } finally { reviewing.current = false; setChecking(false) }
  }

  const availableTimes = [...new Set((slots ?? []).map(s => s.starts_at))]
  const submit = () => {
    if (!preview || busy) return
    recordMenuUsage(preview.input.menu_codes)
    void onSend(r ? { kind: 'edit', reservation_id: r.id, expected_updated_at: r.updated_at, input: preview.input, plan_hash: preview.value.plan_hash }
      : { kind: 'create', input: preview.input, plan_hash: preview.value.plan_hash })
  }
  return <SbModal title={preview ? '予約内容の確認' : r ? '予約を編集' : '新規予約'} busy={busy} onClose={onClose}
    footer={<div className="sb-actions">{preview ? <>
      <button className="sb-secondary" disabled={busy} onClick={() => setPreview(null)}><ChevronLeft size={18} />戻る</button>
      <button className="sb-primary" disabled={busy} onClick={submit}><Check size={18} />{sending ? '送信中…' : r ? '変更を保存' : '予約を登録'}</button>
    </> : <button className="sb-primary sb-grow" disabled={busy || !options.menus.length} onClick={() => void review()}>{checking ? '内容を確認中…' : '内容を確認'}</button>}</div>}>
    {preview ? <dl className="sb-facts">
      <dt>お客様</dt><dd>{preview.input.customer_name}{preview.input.customer_phone && <small>{preview.input.customer_phone}</small>}</dd>
      <dt>日時</dt><dd>{jstDateLabel(date)} {jstTime(preview.input.starts_at)}〜</dd>
      <dt>担当</dt><dd>{options.staff.find(s => s.id === preview.value.staff_id)?.name}{preview.input.staff_id === null ? '（指名なし）' : '（指名）'}</dd>
      <dt>メニュー</dt><dd>{preview.value.items.map(i => <span className="sb-line" key={i.menu_code}>{i.name}<small>{i.duration_min}分 / {yen(i.price)}</small></span>)}</dd>
      <dt>所要時間</dt><dd>{preview.value.duration_min}分{preview.value.buffer_min ? ` ＋片付け${preview.value.buffer_min}分` : ''}</dd>
      <dt>予約時の金額</dt><dd className="sb-price">{yen(preview.value.total_price)}</dd>
      <dt>操作者</dt><dd>{preview.actor}</dd>
      {preview.input.note && <><dt>メモ</dt><dd className="sb-prewrap">{preview.input.note}</dd></>}
    </dl> : <form ref={form} onSubmit={e => { e.preventDefault(); void review() }}>
      <fieldset disabled={busy} className="sb-fieldset">
        {d && <p className="sb-understood">{d.understood.length ? `読み取った内容：${d.understood.join("・")}` : "読み取れた内容がありません"}。足りないところを入れて確かめてください。</p>}
        <label className="sb-field">操作者<select value={actor} onChange={e => setActor(e.target.value)} required><option value="">選択してください</option>{options.actors.map(a => <option key={a.id} value={a.name}>{a.name}</option>)}</select></label>
        <label className="sb-field">お客様名<input value={name} onChange={e => { setName(e.target.value); if (!r) setClient(null) }} required maxLength={60} autoComplete="off" placeholder="お名前" /></label>
        <label className="sb-field">電話番号（任意）<input type="tel" value={phone} onChange={e => { setPhone(e.target.value); if (!r) setClient(null) }} maxLength={20} autoComplete="off" /></label>
        {!r && !client && query && candidates.length > 0 && <div className="sb-candidates">{candidates.map(c => <button type="button" className="sb-candidate" key={c.id} onClick={() => { setClient(c); setName(c.name); if (c.phone) setPhone(c.phone) }}><span>{c.name}<small>{c.phone || (c.phone_last4 ? `電話 下4桁 ${c.phone_last4}` : '')}{c.last_visit ? ` / 前回 ${c.last_visit}` : ''}</small></span><span>選択</span></button>)}</div>}
        {client && <div className="sb-client">既存顧客：{client.name}{!r && <button type="button" onClick={() => setClient(null)}>解除</button>}</div>}
        <section className="sb-form-section"><h3>メニュー</h3>
          {options.menus.length > 0 && <SbMenuPicker menus={options.menus} codes={codes} onChange={setCodes} />}
          {!options.menus.length && <p className="sb-muted">本部で所要時間・担当メニューの設定が必要です。</p>}
          {r?.items.filter(i => !options.menus.some(m => m.code === i.menu_code)).map(i => <p key={i.menu_code} className="sb-muted">{i.name}（現在の予約内容）</p>)}
        </section>
        <label className="sb-field">担当<select value={staffId ?? ''} onChange={e => setStaffId(e.target.value || null)}><option value="">指名なし</option>{options.staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <div className="sb-form-grid"><label className="sb-field">日付<input type="date" value={date} min={getJapanDateString()} max={addDaysToDateString(getJapanDateString(), options.settings.booking_window_days)} required onChange={e => { setDate(e.target.value); setTime('') }} /></label><label className="sb-field">開始時刻<input type="time" step={options.settings.slot_minutes * 60} value={time} required onChange={e => setTime(e.target.value)} /></label></div>
        {codes.length > 0 && <details className="sb-times"><summary>空き時間を選ぶ</summary>{slotError ? <p role="alert">空き時間を取得できませんでした。</p> : !slots ? <p className="sb-muted">確認中…</p> : !availableTimes.length ? <p className="sb-muted">この条件の空き時間はありません。</p> : <div className="sb-time-grid">{availableTimes.map(iso => <button type="button" key={iso} aria-pressed={time === jstTime(iso)} onClick={() => setTime(jstTime(iso))}>{jstTime(iso)}</button>)}</div>}</details>}
        <details className="sb-extra" open={source === 'hotpepper' || undefined}><summary>予約経路・メモ</summary>
          <label className="sb-field">予約経路<select value={source} onChange={e => setSource(e.target.value as SbInput['source'])}><option value="staff">店舗入力</option><option value="phone">電話</option><option value="hotpepper">HOT PEPPER</option></select></label>
          {source === 'hotpepper' && <label className="sb-field">HOT PEPPER予約番号<input value={externalRef} onChange={e => setExternalRef(e.target.value)} maxLength={40} required /></label>}
          <label className="sb-field">メモ<textarea value={note} onChange={e => setNote(e.target.value)} maxLength={500} rows={3} /></label>
        </details>
      </fieldset>
    </form>}
    {error && <p role="alert" className="sb-error">{error}</p>}
  </SbModal>
}
