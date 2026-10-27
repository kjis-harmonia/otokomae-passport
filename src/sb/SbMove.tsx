// 予約表の予約をドラッグして、ほかの時間・担当へ動かす（10/27 慶一郎さん）。
//   掴んで動かすのは sbDrag.ts。離したら「この時間に変更」の確認を出し、DB の予約エンジンで空きを確かめてから変更する（編集画面の「変更を保存」と同じ送り方）。
import { useEffect, useState } from 'react'
import { ArrowRight, Check, ChevronLeft } from 'lucide-react'
import { jstDateLabel, jstIsoFromMinutes, jstTime } from '../utils/bookingApi'
import { sbApi, sbError } from './sbApi'
import type { SbCommand, SbInput, SbOptions, SbPreview } from './sbTypes'
import { SbModal } from './SbModal'
import type { SbMoveTarget } from './sbDrag'

/** 動かす先の確認。予約エンジンで空き・担当を確かめてから「この時間に変更」 */
export function SbMoveSheet({ target, options, date, busy: sending, onSend, onClose }: {
  target: SbMoveTarget; options: SbOptions; date: string; busy: boolean
  onSend: (command: SbCommand) => Promise<void>; onClose: () => void
}) {
  const { r, staffId, minutes } = target
  const [preview, setPreview] = useState<{ input: SbInput; value: SbPreview } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const name = (id: string | null) => options.staff.find(s => s.id === id)?.name ?? ''
  const hhmm = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

  useEffect(() => {
    let alive = true
    // 編集画面の「内容を確認」と同じ内容。別の担当の行へ動かしたらその担当（指名）、同じ行なら今までどおり
    const input: SbInput = {
      starts_at: jstIsoFromMinutes(date, minutes), menu_codes: r.items.map(i => i.menu_code),
      staff_id: staffId !== r.staff_id ? staffId : r.nominated ? r.staff_id : null,
      customer_name: r.customer_name, customer_phone: r.customer_phone || undefined,
      source: r.source === 'hotpepper' ? 'hotpepper' : r.source === 'phone' ? 'phone' : 'staff',
      external_ref: r.source === 'hotpepper' ? r.external_ref ?? undefined : undefined, note: r.note || undefined, client_id: r.client_id,
    }
    void sbApi.preview(input, r.id)
      .then(value => { if (alive) setPreview({ input: JSON.parse(JSON.stringify(input)), value }) })
      .catch(err => { if (alive) setError(sbError(err)) })
    return () => { alive = false }
  }, [r, staffId, minutes, date])

  const submit = () => {
    if (!preview || sending) return
    void onSend({ kind: 'edit', reservation_id: r.id, expected_updated_at: r.updated_at, input: preview.input, plan_hash: preview.value.plan_hash })
  }
  return <SbModal title="予約の時間を変更" busy={sending} onClose={onClose}
    footer={<div className="sb-actions">
      <button className="sb-secondary" disabled={sending} onClick={onClose}><ChevronLeft size={18} />やめる</button>
      <button className="sb-primary" disabled={sending || !preview} onClick={submit}><Check size={18} />{sending ? '送信中…' : 'この時間に変更'}</button>
    </div>}>
    <dl className="sb-facts">
      <dt>お客様</dt><dd>{r.customer_name}<small>{r.items.map(i => i.name).join('・')}</small></dd>
      <dt>変更</dt><dd className="sb-move-change">
        <span>{jstTime(r.starts_at)} {r.staff_name}</span><ArrowRight size={16} aria-label="から" />
        <strong>{jstDateLabel(date)} {hhmm} {preview ? name(preview.value.staff_id) : name(staffId)}</strong>
      </dd>
    </dl>
    {!preview && !error && <p className="sb-notice">空きを確認しています…</p>}
    {error && <p className="sb-error" role="alert">この時間には変更できません：{error}</p>}
  </SbModal>
}
