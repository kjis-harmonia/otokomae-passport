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

export interface SbClosePreset { date: string; minutes: number | null; endMinutes: number | null; staffId: string | null }

const pad = (n: number) => String(n).padStart(2, '0')
const hm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
const iso = (date: string, m: number) => `${date}T${hm(m)}:00+09:00`
// 8:00〜22:00 を15分ごと
const TIMES = Array.from({ length: (22 - 8) * 4 + 1 }, (_, i) => 8 * 60 + i * 15)
const snap = (m: number) => Math.round(m / 15) * 15

export function SbCloseSheet({ options, preset, actor, setActor, onClose, onDone }: {
  options: SbOptions; preset: SbClosePreset; actor: string; setActor: (name: string) => void
  onClose: () => void; onDone: (message: string) => void
}) {
  const today = getJapanDateString()
  const [date, setDate] = useState(preset.date < today ? today : preset.date)
  const [start, setStart] = useState<number | null>(preset.minutes === null ? null : snap(preset.minutes))
  const [end, setEnd] = useState<number | null>(preset.endMinutes !== null ? snap(preset.endMinutes) : preset.minutes !== null ? snap(preset.minutes) + 60 : null)
  // 閉める担当：言った担当、言わなければ未選択（選ばせる）。「両方」は全員
  const [staffIds, setStaffIds] = useState<string[]>(preset.staffId ? [preset.staffId] : [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const all = options.staff.map(s => s.id)
  const both = all.length > 1 && all.every(id => staffIds.includes(id))
  const ready = !!actor && start !== null && end !== null && end > start && staffIds.length > 0

  const submit = async () => {
    if (!ready || busy) return
    setBusy(true); setError(null)
    try {
      const r = await callStaffRpc<{ ok?: boolean; overlap?: number; error?: string }>('staff_close_time', {
        p_staff_ids: staffIds, p_starts_at: iso(date, start!), p_ends_at: iso(date, end!), p_actor: actor, p_note: null,
      })
      if (r.error) { setError(r.error === 'past' ? 'もう過ぎた時間は閉められません。' : r.error === 'invalid_staff' ? '担当を選び直してください。' : '時間を確かめてください（15分刻み・終わりは始まりより後）。'); return }
      const who = options.staff.filter(s => staffIds.includes(s.id)).map(s => s.name).join('・')
      onDone(`${jstDateLabel(date)} ${hm(start!)}〜${hm(end!)}（${who}）をクローズしました。AI 予約は入りません。${r.overlap ? `この時間にはすでに予約が${r.overlap}件あります（そのまま残ります）。` : ''}`)
    } catch { setError('閉められませんでした。通信を確かめて、もう一度押してください。') }
    finally { setBusy(false) }
  }

  return <SbModal title="時間をクローズ" busy={busy} onClose={onClose}
    footer={<div className="sb-actions"><button className="sb-primary sb-grow" disabled={!ready || busy} onClick={() => void submit()}><Check size={18} />{busy ? '閉めています…' : 'クローズする'}</button></div>}>
    <fieldset disabled={busy} className="sb-fieldset">
      <p className="sb-understood">サロンボードに入れた時間を閉めて、AI 予約が入らないようにします。</p>
      {!actor && <label className="sb-field">操作者<select value={actor} onChange={e => setActor(e.target.value)} required><option value="">選択してください</option>{options.actors.map(a => <option key={a.id} value={a.name}>{a.name}</option>)}</select></label>}
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
