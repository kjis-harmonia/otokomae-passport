// 本部 JOHNNY：テイテイと何でも話す相棒＋慶一郎さんとの伝言（「確認して」は OK / NG / 返事で答える）。
import { useCallback, useEffect, useRef, useState } from 'react'
import { HqPanel } from '../components/HqPanel'
import { HQ_COLORS, HQ_SANS } from '../hqTheme'
import { answerMessage, askJohnny, listMessages, STATUS_LABEL, type ChatTurn, type HqMessage } from '../hqJohnnyStore'

const CHAT_KEY = 'ginjiro_hq_johnny_chat'
function loadChat(): ChatTurn[] {
  try { const raw = localStorage.getItem(CHAT_KEY); return raw ? (JSON.parse(raw) as ChatTurn[]).slice(-60) : [] } catch { return [] }
}
function saveChat(turns: ChatTurn[]) {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(turns.slice(-60))) } catch { /* 覚えられなくても話せる */ }
}

const when = (iso: string) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function HqJohnnyScreen() {
  const [messages, setMessages] = useState<HqMessage[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const reload = useCallback(() => { listMessages().then(m => { setMessages(m); setLoadError(false) }, () => setLoadError(true)) }, [])
  useEffect(() => {
    reload()
    const t = window.setInterval(reload, 30_000)
    return () => window.clearInterval(t)
  }, [reload])

  const inbox = (messages ?? []).filter(m => m.direction === 'to_shop')
  const waiting = inbox.filter(m => m.status === 'open' || m.status === 'seen')
  const sent = (messages ?? []).filter(m => m.direction === 'to_owner').slice(0, 8)

  return (
    <div style={{ display: 'grid', gap: 16, fontFamily: HQ_SANS }}>
      <HqPanel title={waiting.length ? `慶一郎さんからの伝言（${waiting.length}件）` : '慶一郎さんからの伝言'} code="INBOX">
        {loadError && <p style={{ color: HQ_COLORS.red, fontSize: 13 }}>伝言を読み込めませんでした。</p>}
        {messages && !inbox.length && <p style={{ color: HQ_COLORS.textMute, fontSize: 13, margin: 0 }}>まだ伝言はありません。</p>}
        <div style={{ display: 'grid', gap: 10 }}>
          {inbox.slice(0, 10).map(m => <InboxItem key={m.id} m={m} onDone={reload} />)}
        </div>
      </HqPanel>

      <HqPanel title="JOHNNY と話す" code="CHAT">
        <Chat onChanged={reload} />
      </HqPanel>

      {!!sent.length && (
        <HqPanel title="慶一郎さんへ送った伝言" code="SENT">
          <div style={{ display: 'grid', gap: 8 }}>
            {sent.map(m => (
              <div key={m.id} style={{ fontSize: 13, borderBottom: `1px solid ${HQ_COLORS.panelBorder}`, paddingBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong>{m.urgent ? '【急ぎ】' : ''}{m.title}</strong>
                  <span style={{ color: m.status === 'open' ? HQ_COLORS.textMute : HQ_COLORS.positive, whiteSpace: 'nowrap' }}>{m.status === 'open' ? 'まだ読まれていない' : STATUS_LABEL[m.status]}</span>
                </div>
                <p style={{ margin: '4px 0 0', color: HQ_COLORS.textSecondary, whiteSpace: 'pre-wrap' }}>{m.body}</p>
                {m.reply && <p style={{ margin: '4px 0 0', color: HQ_COLORS.textPrimary }}>慶一郎さん：{m.reply}</p>}
                <p style={{ margin: '4px 0 0', color: HQ_COLORS.textMute, fontSize: 11 }}>{when(m.created_at)}</p>
              </div>
            ))}
          </div>
        </HqPanel>
      )}
    </div>
  )
}

function InboxItem({ m, onDone }: { m: HqMessage; onDone: () => void }) {
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = m.status === 'open' || m.status === 'seen'
  useEffect(() => { if (m.status === 'open' && m.kind === 'note') void answerMessage(m.id, 'seen').then(onDone, () => {}) }, [m.id, m.status, m.kind, onDone])
  const act = async (status: 'approved' | 'rejected' | 'answered') => {
    setBusy(true)
    try { await answerMessage(m.id, status, reply.trim() || null); onDone() } finally { setBusy(false) }
  }
  return (
    <div style={{ border: `1px solid ${m.urgent && pending ? HQ_COLORS.red : HQ_COLORS.panelBorder}`, borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
        <strong>{m.urgent ? '【急ぎ】' : ''}{m.kind === 'request' ? '【確認して】' : ''}{m.title}</strong>
        <span style={{ color: HQ_COLORS.textMute, whiteSpace: 'nowrap' }}>{when(m.created_at)}</span>
      </div>
      <p style={{ margin: '6px 0 0', fontSize: 14, whiteSpace: 'pre-wrap', color: HQ_COLORS.textPrimary }}>{m.body}</p>
      {m.kind === 'request' && pending && (
        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          <input value={reply} onChange={e => setReply(e.target.value)} placeholder="ひとこと（なくても OK）" style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${HQ_COLORS.panelBorderStrong}`, fontSize: 14 }} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="hq-button hq-button-primary" disabled={busy} onClick={() => void act('approved')}>OK</button>
            <button className="hq-button" disabled={busy} onClick={() => void act('rejected')}>NG</button>
            <button className="hq-button" disabled={busy || !reply.trim()} onClick={() => void act('answered')}>返事だけ送る</button>
          </div>
        </div>
      )}
      {!pending && <p style={{ margin: '8px 0 0', fontSize: 12, color: HQ_COLORS.positive }}>{STATUS_LABEL[m.status]}{m.reply ? `：${m.reply}` : ''}</p>}
    </div>
  )
}

function Chat({ onChanged }: { onChanged: () => void }) {
  const [turns, setTurns] = useState<ChatTurn[]>(loadChat)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }) }, [turns, busy])

  const send = async () => {
    const message = text.trim()
    if (!message || busy) return
    const before = turns
    const next = [...before, { role: 'user' as const, content: message }]
    setTurns(next); setText(''); setBusy(true); setError('')
    try {
      const r = await askJohnny(message, before)
      const done = [...next, { role: 'assistant' as const, content: r.reply }]
      setTurns(done); saveChat(done)
      if (r.changed) onChanged()
    } catch {
      setError('JOHNNY が返事できませんでした。もう一度送ってください。')
      setTurns(before); setText(message)
    } finally { setBusy(false) }
  }

  return (
    <div>
      <div style={{ display: 'grid', gap: 10, maxHeight: 460, overflowY: 'auto', padding: '4px 2px' }}>
        {!turns.length && <p style={{ margin: 0, fontSize: 13, color: HQ_COLORS.textMute }}>例：「今週ヒマな日ある？」「慶一郎さんに、来週の土曜イベントしたいって伝えといて」</p>}
        {turns.map((t, i) => (
          <div key={i} style={{ justifySelf: t.role === 'user' ? 'end' : 'start', maxWidth: '85%', padding: '9px 13px', borderRadius: 14, fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap',
            background: t.role === 'user' ? '#0071e3' : '#f0f0f3', color: t.role === 'user' ? '#fff' : HQ_COLORS.textPrimary }}>{t.content}</div>
        ))}
        {busy && <div style={{ justifySelf: 'start', fontSize: 13, color: HQ_COLORS.textMute }}>JOHNNY が考えています…</div>}
        <div ref={end} />
      </div>
      {error && <p role="alert" style={{ color: HQ_COLORS.red, fontSize: 12, margin: '8px 0 0' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={2} placeholder="JOHNNY に話しかける"
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }}
          style={{ flex: 1, padding: '10px 12px', borderRadius: 10, border: `1px solid ${HQ_COLORS.panelBorderStrong}`, fontSize: 15, fontFamily: HQ_SANS, resize: 'none' }} />
        <button className="hq-button hq-button-primary" disabled={busy || !text.trim()} onClick={() => void send()}>送る</button>
      </div>
      {!!turns.length && <button className="hq-button hq-button-quiet" style={{ marginTop: 8 }} onClick={() => { setTurns([]); saveChat([]) }}>会話を消す</button>}
    </div>
  )
}
