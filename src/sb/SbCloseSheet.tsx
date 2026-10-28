// 時間を閉める（クローズ）：サロンボードに入れた電話予約などの時間に、AI 予約が入らないようにする。
// 例：「今日15時から16時半 クローズ」。担当を言わなければ、ここで選ぶ（テイテイ・銀二郎・両方）。
// 閉めた時間は予約表に「クローズ」と出て、押すと外せる（ReopenSheet）。
import { useState } from 'react'
import { Check } from 'lucide-react'
import { addDaysToDateString, getJapanDateString } from '../utils/dateUtils'
import { jstDateLabel, jstTime } from '../utils/bookingApi'
import { callStaffRpc } from './sbRpc'
import { SbModal } from './SbModal'
import type { SbOptions } from './sbTypes'

/** quick：予約表の空いた時間を押して開いた（時間・担当は決まっていて、いつまでかを選ぶだけ）。shiftEnd はその担当の出勤の終わり */
export interface SbClosePreset { date: string; minutes: number | null; endMinutes: number | null; staffId: string | null; quick?: boolean; shiftEnd?: number }

const pad = (n: number) => String(n).padStart(2, '0')
const hm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
const iso = (date: string, m: number) => `${date}T${hm(m)}:00+09:00`
// 8:00〜22:00 を15分ごと
const TIMES = Array.from({ length: (22 - 8) * 4 + 1 }, (_, i) => 8 * 60 + i * 15)
const snap = (m: number) => Math.round(m / 15) * 15

export function SbCloseSheet({ options, preset, actor, onClose, onDone, onNewBooking }: {
  options: SbOptions; preset: SbClosePreset; actor: string
  onClose: () => void; onDone: (message: string) => void; onNewBooking?: () => void
}) {
  const today = getJapanDateString()
  const [date, setDate] = useState(preset.date < today ? today : preset.date)
  const [start, setStart] = useState<number | null>(preset.minutes === null ? null : snap(preset.minutes))
  const [end, setEnd] = useState<number | null>(preset.endMinutes !== null ? snap(preset.endMinutes) : preset.quick ? null : preset.minutes !== null ? snap(preset.minutes) + 60 : null)
  // 閉める担当：言った担当、言わなければ未選択（選ばせる）。「両方」は全員
  const [staffIds, setStaffIds] = useState<string[]>(preset.staffId ? [preset.staffId] : [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const all = options.staff.map(s => s.id)
  const both = all.length > 1 && all.every(id => staffIds.includes(id))
  const ready = start !== null && end !== null && end > start && staffIds.length > 0

  const submit = async () => {
    if (!ready || busy) return
    setBusy(true); setError(null)
    try {
      const r = await callStaffRpc<{ ok?: boolean; overlap?: number; error?: string }>('staff_close_time', {
        p_staff_ids: staffIds, p_starts_at: iso(date, start!), p_ends_at: iso(date, end!), p_actor: actor || 'SB', p_note: null,
      })
      if (r.error) { setError(r.error === 'past' ? 'もう過ぎた時間は閉められません。' : r.error === 'invalid_staff' ? '担当を選び直してください。' : '時間を確かめてください（15分刻み・終わりは始まりより後）。'); return }
      const who = options.staff.filter(s => staffIds.includes(s.id)).map(s => s.name).join('・')
      onDone(`${jstDateLabel(date)} ${hm(start!)}〜${hm(end!)}（${who}）をクローズしました。AI 予約は入りません。${r.overlap ? `この時間にはすでに予約が${r.overlap}件あります（そのまま残ります）。` : ''}`)
    } catch { setError('閉められませんでした。通信を確かめて、もう一度押してください。') }
    finally { setBusy(false) }
  }

  // 予約表の空いた時間を押したとき：押した時間・担当は決まり。いつまでかを選んで確認するだけ
  if (preset.quick && start !== null && staffIds.length === 1) {
    const who = options.staff.find(s => s.id === staffIds[0])?.name ?? ''
    const limit = preset.shiftEnd ?? 22 * 60
    const choices = [30, 60, 90, 120].map(d => start + d).filter(m => m <= limit)
    if (limit > start && !choices.includes(limit)) choices.push(limit)
    return <SbModal title="この時間をクローズ" busy={busy} onClose={onClose}
      footer={<div className="sb-actions"><button className="sb-primary sb-grow" disabled={!ready || busy} onClick={() => void submit()}><Check size={18} />{busy ? '閉めています…' : end !== null ? `${hm(end)}までクローズする` : 'いつまでか選んでください'}</button></div>}>
      <fieldset disabled={busy} className="sb-fieldset">
        <div className="sb-qc-card">
          <div><small>担当</small><strong>{who}</strong></div>
          <div><small>日付</small><strong>{jstDateLabel(date)}</strong></div>
          <div className="sb-qc-range"><small>クローズ</small><strong>{hm(start)}<span aria-hidden="true">→</span><em className={end === null ? 'is-empty' : undefined}>{end !== null ? hm(end) : '--:--'}</em></strong></div>
        </div>
        <h3 className="sb-qc-title">いつまで？</h3>
        <div className="sb-qc-choices" role="group" aria-label="いつまでクローズするか">
          {choices.map(m => {
            const mins = m - start
            const tag = m === limit && preset.shiftEnd ? '終わりまで' : mins % 60 === 0 ? `${mins / 60}時間` : mins > 60 ? `${Math.floor(mins / 60)}時間${mins % 60}分` : `${mins}分`
            return <button type="button" key={m} className="sb-qc-choice" aria-pressed={end === m} onClick={() => setEnd(m)}><small>{tag}</small><strong>{hm(m)}</strong></button>
          })}
        </div>
        <label className="sb-field sb-qc-other">ほかの時間<select value={end !== null && !choices.includes(end) ? end : ''} onChange={e => e.target.value && setEnd(Number(e.target.value))}><option value="">選ぶ</option>{TIMES.filter(m => m > start).map(m => <option key={m} value={m}>{hm(m)}</option>)}</select></label>
        {onNewBooking && <button type="button" className="sb-text-link" onClick={onNewBooking}>クローズではなく、この時間に新規予約を入れる</button>}
      </fieldset>
      {error && <p role="alert" className="sb-error">{error}</p>}
    </SbModal>
  }

  return <SbModal title="時間をクローズ" busy={busy} onClose={onClose}
    footer={<div className="sb-actions"><button className="sb-primary sb-grow" disabled={!ready || busy} onClick={() => void submit()}><Check size={18} />{busy ? '閉めています…' : !staffIds.length ? '担当を選んでください' : 'クローズする'}</button></div>}>
    <fieldset disabled={busy} className="sb-fieldset">
      <p className="sb-understood">サロンボードに入れた時間を閉めて、AI 予約が入らないようにします。</p>
      <section className="sb-form-section"><h3>担当</h3>
        <div className="sb-close-staff" role="group" aria-label="閉める担当">
          {options.staff.map(s => <button type="button" key={s.id} className="sb-secondary" aria-pressed={staffIds.length === 1 && staffIds[0] === s.id} onClick={() => setStaffIds([s.id])}>{s.name}</button>)}
          {all.length > 1 && <button type="button" className="sb-secondary" aria-pressed={both} onClick={() => setStaffIds(all)}>両方</button>}
        </div>
      </section>
      <label className="sb-field">日付<input type="date" value={date} min={today} max={addDaysToDateString(today, options.settings.booking_window_days)} required onChange={e => e.target.value && setDate(e.target.value)} /></label>
      <div className="sb-form-grid">
        <label className="sb-field">から<select value={start ?? ''} required onChange={e => { const v = Number(e.target.value); setStart(v); if (end === null || end <= v) setEnd(v + 60) }}><option value="">選択</option>{TIMES.map(m => <option key={m} value={m}>{hm(m)}</option>)}</select></label>
        <label className="sb-field">まで<select value={end ?? ''} required onChange={e => setEnd(Number(e.target.value))}><option value="">選択</option>{TIMES.filter(m => start === null || m > start).map(m => <option key={m} value={m}>{hm(m)}</option>)}</select></label>
      </div>
    </fieldset>
    {error && <p role="alert" className="sb-error">{error}</p>}
  </SbModal>
}

/** 予約表の「クローズ」を押したとき：外す */
export function SbReopenSheet({ block, staffName, actor, onClose, onDone }: {
  block: { id: string; starts_at: string; ends_at: string }; staffName: string; actor: string
  onClose: () => void; onDone: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reopen = async () => {
    setBusy(true); setError(null)
    try {
      const r = await callStaffRpc<{ ok?: boolean; error?: string }>('staff_reopen_time', { p_block_id: block.id, p_actor: actor || 'SB' })
      if (r.error) { setError('この時間は本部で閉めたものです。本部で外してください。'); return }
      onDone(`${jstTime(block.starts_at)}〜${jstTime(block.ends_at)}（${staffName}）のクローズを外しました。AI 予約が入るようになります。`)
    } catch { setError('外せませんでした。通信を確かめて、もう一度押してください。') }
    finally { setBusy(false) }
  }
  return <SbModal title="クローズ" busy={busy} onClose={onClose}
    footer={<div className="sb-actions"><button className="sb-secondary sb-grow" disabled={busy} onClick={() => void reopen()}>{busy ? '外しています…' : 'クローズを外す'}</button></div>}>
    <dl className="sb-facts"><dt>担当</dt><dd>{staffName}</dd><dt>時間</dt><dd>{jstTime(block.starts_at)}〜{jstTime(block.ends_at)}</dd></dl>
    <p className="sb-muted">サロンボードの予約が取り消しになったときだけ外してください。</p>
    {error && <p role="alert" className="sb-error">{error}</p>}
  </SbModal>
}
