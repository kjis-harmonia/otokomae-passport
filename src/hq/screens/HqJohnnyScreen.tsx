// 本部 JOHNNY：テイテイと何でも話す相棒＋慶一郎さんとの伝言（「確認して」は OK / NG / 返事で答える）。
// 見た目は紺と水色の近未来（呼吸するホログラムのコア）。本部のほかの画面は白のまま。
import { useCallback, useEffect, useRef, useState } from 'react'
import { JohnnyCore } from '../components/JohnnyCore'
import { answerMessage, askJohnny, listMessages, STATUS_LABEL, type ChatTurn, type HqMessage } from '../hqJohnnyStore'
import './hqJohnny.css'

const CHAT_KEY = 'ginjiro_hq_johnny_chat'
function loadChat(): ChatTurn[] {
  try { const raw = localStorage.getItem(CHAT_KEY); return raw ? (JSON.parse(raw) as ChatTurn[]).slice(-60) : [] } catch { return [] }
}
function saveChat(turns: ChatTurn[]) {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(turns.slice(-60))) } catch { /* 覚えられなくても話せる */ }
}

const when = (iso: string) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

function greeting(): string {
  const h = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo', hour: 'numeric', hour12: false }))
  if (h >= 5 && h < 11) return 'テイテイ、おはよう。'
  if (h >= 11 && h < 18) return 'テイテイ、おつかれさま。'
  return 'テイテイ、今日もおつかれ。'
}

/** コアの大きさ：画面の幅に合わせる */
function useCoreSize(): number {
  const [size, setSize] = useState(300)
  useEffect(() => {
    const fit = () => setSize(Math.max(240, Math.min(340, window.innerWidth - 64, Math.round(window.innerHeight * 0.42))))
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  return size
}

export function HqJohnnyScreen() {
  const [messages, setMessages] = useState<HqMessage[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [thinking, setThinking] = useState(false)
  const coreSize = useCoreSize()
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
    <div className="hqj">
      <div className="hqj-scan" aria-hidden="true" />
      <header className="hqj-hero">
        <JohnnyCore size={coreSize} mode={thinking ? 'thinking' : 'idle'} />
        <p className="hqj-label"><span className="hqj-dot" aria-hidden="true" />{thinking ? 'JOHNNY · THINKING' : 'JOHNNY · ONLINE'}</p>
        <h2 className="hqj-title">{greeting()}</h2>
        <p className="hqj-sub">{waiting.length ? `慶一郎さんから伝言が${waiting.length}件あります。` : '何でも話しかけてね。慶一郎さんへの伝言もまかせて。'}</p>
      </header>

      <div className="hqj-grid">
        {(waiting.length > 0 || loadError) && (
          <section className="hqj-panel">
            <h3>慶一郎さんからの伝言<span>INBOX</span></h3>
            {loadError && <p className="hqj-error">伝言を読み込めませんでした。</p>}
            <div style={{ display: 'grid', gap: 10 }}>
              {waiting.map(m => <InboxItem key={m.id} m={m} onDone={reload} />)}
            </div>
          </section>
        )}

        <section className="hqj-panel">
          <h3>JOHNNY と話す<span>CHAT</span></h3>
          <Chat onChanged={reload} onThinking={setThinking} />
        </section>

        {inbox.length > waiting.length && (
          <section className="hqj-panel">
            <h3>返事した伝言<span>DONE</span></h3>
            <div style={{ display: 'grid', gap: 10 }}>
              {inbox.filter(m => !waiting.includes(m)).slice(0, 6).map(m => <InboxItem key={m.id} m={m} onDone={reload} />)}
            </div>
          </section>
        )}

        {!!sent.length && (
          <section className="hqj-panel">
            <h3>慶一郎さんへ送った伝言<span>SENT</span></h3>
            <div style={{ display: 'grid', gap: 10 }}>
              {sent.map(m => (
                <div key={m.id} className="hqj-item">
                  <div className="hqj-item-head">
                    <strong>{m.urgent ? '【急ぎ】' : ''}{m.kind === 'request' ? '【確認して】' : ''}{m.title}</strong>
                    <span className={m.status === 'open' ? 'hqj-time' : 'hqj-ok'}>{m.status === 'open' ? 'まだ読まれていない' : STATUS_LABEL[m.status]}</span>
                  </div>
                  <p className="hqj-item-body" style={{ color: 'var(--hqj-fg-2)' }}>{m.body}</p>
                  {m.reply && <p className="hqj-item-body">慶一郎さん：{m.reply}</p>}
                  <p className="hqj-time" style={{ margin: '6px 0 0' }}>{when(m.created_at)}</p>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
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
    <div className={'hqj-item' + (m.urgent && pending ? ' is-urgent' : '')}>
      <div className="hqj-item-head">
        <strong>{m.urgent ? '【急ぎ】' : ''}{m.kind === 'request' ? '【確認して】' : ''}{m.title}</strong>
        <span className="hqj-time">{when(m.created_at)}</span>
      </div>
      <p className="hqj-item-body">{m.body}</p>
      {m.kind === 'request' && pending && (
        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          <input className="hqj-input" value={reply} onChange={e => setReply(e.target.value)} placeholder="ひとこと（なくても OK）" />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="hqj-btn hqj-btn-primary" disabled={busy} onClick={() => void act('approved')}>OK</button>
            <button className="hqj-btn" disabled={busy} onClick={() => void act('rejected')}>NG</button>
            <button className="hqj-btn" disabled={busy || !reply.trim()} onClick={() => void act('answered')}>返事だけ送る</button>
          </div>
        </div>
      )}
      {!pending && <p className="hqj-ok" style={{ margin: '8px 0 0', fontSize: 12 }}>{STATUS_LABEL[m.status]}{m.reply ? `：${m.reply}` : ''}</p>}
    </div>
  )
}

function Chat({ onChanged, onThinking }: { onChanged: () => void; onThinking: (on: boolean) => void }) {
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
    setTurns(next); setText(''); setBusy(true); setError(''); onThinking(true)
    try {
      const r = await askJohnny(message, before)
      const done = [...next, { role: 'assistant' as const, content: r.reply }]
      setTurns(done); saveChat(done)
      if (r.changed) onChanged()
    } catch {
      setError('JOHNNY が返事できませんでした。もう一度送ってください。')
      setTurns(before); setText(message)
    } finally { setBusy(false); onThinking(false) }
  }

  return (
    <div>
      <div className="hqj-chat">
        {!turns.length && <p className="hqj-muted">例：「今週ヒマな日ある？」「慶一郎さんに、来週の土曜イベントしたいって伝えといて」</p>}
        {turns.map((t, i) => <div key={i} className={'hqj-bubble ' + (t.role === 'user' ? 'is-user' : 'is-johnny')}>{t.content}</div>)}
        {busy && <p className="hqj-muted">JOHNNY が考えています…</p>}
        <div ref={end} />
      </div>
      {error && <p role="alert" className="hqj-error">{error}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <textarea className="hqj-textarea" value={text} onChange={e => setText(e.target.value)} rows={2} placeholder="JOHNNY に話しかける"
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
        <button className="hqj-btn hqj-btn-primary" disabled={busy || !text.trim()} onClick={() => void send()}>送る</button>
      </div>
      {!!turns.length && <button className="hqj-btn" style={{ marginTop: 8 }} onClick={() => { setTurns([]); saveChat([]) }}>会話を消す</button>}
    </div>
  )
}
