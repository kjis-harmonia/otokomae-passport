import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { jstDateLabel, jstTime } from '../utils/bookingApi'
import { getJapanDateString } from '../utils/dateUtils'
import { RpcError } from './sbRpc'
import { hpbApi, hpbResult, KIND, WARNING, type HpbList } from './sbHotpepperApi'
import { SbModal } from './SbModal'

function errorText(err: unknown) {
  const code = err instanceof RpcError ? err.code : ''
  if (code === 'staff_name_required') return '先に操作者を選んでください。'
  if (code === 'invalid_mail') return 'メールの本文をそのまま貼り付けてください。'
  return '取り込めませんでした。接続を確認してください。'
}

export function SbHotpepper({ list, actor, disabled, onClose, onChanged, onOpen }: {
  list: HpbList | null; actor: string; disabled: boolean; onClose: () => void
  onChanged: () => void; onOpen: (date: string, reservationId: string) => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  async function run<T>(task: () => Promise<T>, done: (v: T) => string) {
    setBusy(true); setMessage(null)
    try { setMessage({ text: done(await task()), error: false }); onChanged() }
    catch (err) { setMessage({ text: errorText(err), error: true }) }
    finally { setBusy(false) }
  }
  return <SbModal title="HOT PEPPERのメール" busy={busy} onClose={onClose}>
    <p className="sb-muted sb-hpb-lead">SALON BOARD の予約メールは自動で予約表に入ります。届いていないときは本文を貼り付けてください。</p>
    <label className="sb-field">メールの本文<textarea value={text} disabled={busy} maxLength={20000} onChange={e => setText(e.target.value)} /></label>
    <div className="sb-actions sb-hpb-actions"><button className="sb-primary" disabled={busy || disabled || text.trim().length < 20}
      onClick={() => void run(() => hpbApi.importText(text, actor), m => { setText(''); return hpbResult(m) })}>{busy ? '取込中…' : '取り込む'}</button></div>
    {message && <p className={message.error ? 'sb-error' : 'sb-hpb-message'} role="status">{message.text}</p>}
    <h3 className="sb-hpb-heading">届いたメール</h3>
    {!list ? <p className="sb-muted">読み込み中…</p> : !list.mails.length ? <p className="sb-muted">まだありません。</p>
      : <div className="sb-hpb-list">{list.mails.map(m => {
        const date = m.starts_at ? getJapanDateString(new Date(m.starts_at)) : null
        const canOpen = !!(m.reservation_id && date)
        const body = <><time>{m.starts_at ? <>{jstTime(m.starts_at)}<small>{jstDateLabel(date!)}</small></> : '—'}</time>
          <span><strong>{m.status === 'ignored' && m.reason === 'notice' ? 'お知らせ' : `${KIND[m.kind]} ${m.customer_name ?? '名前不明'}`}</strong>
            <small>{[m.stylist, m.menu].filter(Boolean).join(' / ')}</small>
            <small className={m.status === 'needs_review' ? 'sb-hpb-review' : undefined}>{m.status === 'needs_review' ? '要確認：' : m.status === 'checked' ? `確認済み（${m.checked_by}）：` : ''}{hpbResult(m)}{m.warnings.length ? `（${m.warnings.map(w => WARNING[w] ?? w).join('・')}）` : ''}</small></span></>
        return <div className="sb-hpb-row" key={m.id}>
          {canOpen ? <button onClick={() => onOpen(date!, m.reservation_id!)}>{body}<ChevronRight size={18} /></button> : <div>{body}</div>}
          {m.status === 'needs_review' && <button className="sb-secondary" disabled={busy || disabled} onClick={() => void run(() => hpbApi.check(m.id, actor), () => '確認済みにしました。')}>確認済みにする</button>}
        </div>
      })}</div>}
  </SbModal>
}
