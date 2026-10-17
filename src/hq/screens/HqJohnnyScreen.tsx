// 本部 JOHNNY：画面いっぱいの近未来の相棒。声で話しかけて、声で返事。文字でも話せる。
// 慶一郎さんからの「確認して」は画面に出して OK / NG / 返事で答える。会話と伝言の記録は「履歴」に。
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, History, Keyboard, Mic, Send, Square, Volume2, VolumeX, X } from 'lucide-react'
import { JohnnyStage, type StageMode } from '../components/JohnnyStage'
import { stageLayout } from '../components/stageLayout'
import { answerMessage, askJohnny, closeTask, listMessages, listTasks, STATUS_LABEL, type ChatTurn, type HqMessage, type HqTask } from '../hqJohnnyStore'
import { recordUtterance, speak, unlockAudio, voiceLevel } from '../hqVoice'
import { HQ_TABS } from '../hqMockData'
import './hqJohnny.css'

const CHAT_KEY = 'ginjiro_hq_johnny_chat'
const VOICE_KEY = 'ginjiro_hq_johnny_voice'
function loadChat(): ChatTurn[] {
  try { const raw = localStorage.getItem(CHAT_KEY); return raw ? (JSON.parse(raw) as ChatTurn[]).slice(-60) : [] } catch { return [] }
}
function saveChat(turns: ChatTurn[]) {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(turns.slice(-60))) } catch { /* 覚えられなくても話せる */ }
}
function loadVoiceOn(): boolean {
  try { return localStorage.getItem(VOICE_KEY) !== 'off' } catch { return true }
}

const when = (iso: string) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

function jstNow() {
  const d = new Date(Date.now() + 9 * 3600_000)
  const wd = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getUTCDay()]
  const iso = d.toISOString()
  return { clock: `${iso.slice(0, 10).replaceAll('-', '.')} ${wd} ${iso.slice(11, 19)} JST`, hour: d.getUTCHours() }
}

function greeting(hour: number): string {
  if (hour >= 5 && hour < 11) return 'テイテイさん、おはよう。'
  if (hour >= 11 && hour < 18) return 'テイテイさん、おつかれさま。'
  return 'テイテイさん、今日もおつかれ。'
}

/** 文字の位置：球の下から、操作ボタンの上まで */
function useTextTop(): number {
  const [top, setTop] = useState(() => stageLayout(window.innerWidth, window.innerHeight).textTop)
  useEffect(() => {
    const fit = () => setTop(stageLayout(window.innerWidth, window.innerHeight).textTop)
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  return top
}

function useClock() {
  const [now, setNow] = useState(jstNow)
  useEffect(() => { const t = window.setInterval(() => setNow(jstNow()), 1000); return () => window.clearInterval(t) }, [])
  return now
}

export function HqJohnnyScreen() {
  const [messages, setMessages] = useState<HqMessage[] | null>(null)
  const [tasks, setTasks] = useState<HqTask[]>([])
  const [turns, setTurns] = useState<ChatTurn[]>(loadChat)
  const [mode, setMode] = useState<StageMode>('idle')
  const [heard, setHeard] = useState('')
  const [reply, setReply] = useState('')
  const [error, setError] = useState('')
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState('')
  const [voiceOn, setVoiceOn] = useState(loadVoiceOn)
  const [historyOpen, setHistoryOpen] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const now = useClock()
  const textTop = useTextTop()

  const reload = useCallback(() => { listMessages().then(setMessages, () => {}); listTasks().then(setTasks, () => {}) }, [])
  useEffect(() => {
    reload()
    const t = window.setInterval(reload, 30_000)
    return () => window.clearInterval(t)
  }, [reload])
  // 画面いっぱいの間は、下の本部の画面を動かさない
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev; abort.current?.abort() }
  }, [])

  const inbox = (messages ?? []).filter(m => m.direction === 'to_shop')
  const waiting = inbox.filter(m => m.status === 'open' || m.status === 'seen')
  const soon = tasks.filter(t => t.days_left !== null && t.days_left <= 2)

  const respond = useCallback(async (input: string | { b64: string; mime: string }, signal: AbortSignal) => {
    setMode('thinking')
    const r = await askJohnny(input, turns)
    if (signal.aborted) return
    if (typeof input !== 'string' && !r.heard) { setMode('idle'); setError('うまく聞き取れんかった。もう一回話してみて。'); return }
    const said = typeof input === 'string' ? input : r.heard ?? ''
    setHeard(said)
    setReply(r.reply)
    const next = [...turns, { role: 'user' as const, content: said }, { role: 'assistant' as const, content: r.reply }]
    setTurns(next); saveChat(next)
    if (r.changed) reload()
    if (voiceOn) {
      setMode('speaking')
      await speak(r.reply, signal)
    }
    if (signal.aborted) return
    setMode('idle')
    // 執事：頼まれた画面を開く（この端末で使える画面だけ）
    if (r.open && HQ_TABS.some(t => t.id === r.open)) window.location.hash = r.open
  }, [turns, voiceOn, reload])

  const stop = () => { abort.current?.abort(); abort.current = null; setMode('idle') }

  const talk = async () => {
    if (mode === 'listening' || mode === 'speaking' || mode === 'thinking') { stop(); return }
    unlockAudio()
    const ac = new AbortController()
    abort.current = ac
    setError(''); setHeard(''); setReply('')
    setMode('listening')
    try {
      const rec = await recordUtterance(ac.signal)
      if (ac.signal.aborted) return
      if (!rec) { setMode('idle'); setError('声が聞こえんかった。マイクのボタンを押して話してね。'); return }
      await respond(rec, ac.signal)
    } catch (e) {
      if (ac.signal.aborted) return
      setMode('idle')
      setError(String(e).includes('NotAllowed') ? 'マイクが許可されていません。ブラウザの設定でマイクを許可してください。' : 'JOHNNY が返事できませんでした。もう一度どうぞ。')
    }
  }

  const sendText = async () => {
    const message = text.trim()
    if (!message || mode === 'thinking') return
    abort.current?.abort()
    unlockAudio()
    const ac = new AbortController()
    abort.current = ac
    setText(''); setError(''); setHeard(message); setReply('')
    try { await respond(message, ac.signal) } catch {
      if (ac.signal.aborted) return
      setMode('idle'); setText(message); setError('JOHNNY が返事できませんでした。もう一度送ってください。')
    }
  }

  const toggleVoice = () => {
    const on = !voiceOn
    setVoiceOn(on)
    try { localStorage.setItem(VOICE_KEY, on ? 'on' : 'off') } catch { /* 次回は既定に戻る */ }
    if (!on && mode === 'speaking') stop()
  }

  const status = mode === 'listening' ? 'LISTENING' : mode === 'thinking' ? 'THINKING' : mode === 'speaking' ? 'SPEAKING' : 'ONLINE'
  const busy = mode !== 'idle'

  return (
    <div className="hqj">
      <JohnnyStage mode={mode} level={voiceLevel} label="JOHNNY OS  GINJIRO HQ  VOICE LINK  二代目銀二郎" />

      <header className="hqj-top">
        <div className="hqj-top-left">
          <a className="hqj-icon-btn" href="#dashboard" aria-label="本部のメニューへ戻る"><ChevronLeft size={20} /><span>本部</span></a>
          <p className="hqj-clock">{now.clock}</p>
        </div>
        <div className="hqj-top-right">
          <button type="button" className="hqj-icon-btn" onClick={toggleVoice} aria-label={voiceOn ? '読み上げを止める' : '読み上げる'} aria-pressed={voiceOn}>
            {voiceOn ? <Volume2 size={19} /> : <VolumeX size={19} />}
          </button>
          <button type="button" className="hqj-icon-btn" onClick={() => setHistoryOpen(true)} aria-label="履歴"><History size={19} /></button>
        </div>
      </header>

      <section className="hqj-center" aria-live="polite" style={{ top: textTop }}>
        <p className="hqj-label"><span className="hqj-dot" aria-hidden="true" />JOHNNY · {status}</p>
        {mode === 'listening' && <p className="hqj-title">聞いてるよ…</p>}
        {mode === 'thinking' && <>{heard && <p className="hqj-heard">「{heard}」</p>}<p className="hqj-title is-small">考えてるけん待ってね…</p></>}
        {(mode === 'idle' || mode === 'speaking') && (reply ? (
          <>
            {heard && <p className="hqj-heard">「{heard}」</p>}
            <p className="hqj-reply">{reply}</p>
          </>
        ) : (
          <>
            <h2 className="hqj-title">{greeting(now.hour)}</h2>
            <p className="hqj-sub">{waiting.length ? `BOS から伝言が${waiting.length}件あるよ。` : soon.length ? `期限が近いやることが${soon.length}件あるよ（${soon[0].title}）。` : tasks.length ? `やることが${tasks.length}件あるよ。右上の履歴から見れるよ。` : 'マイクを押して、何でも話しかけてね。'}</p>
          </>
        ))}
        {error && <p role="alert" className="hqj-error">{error}</p>}
      </section>

      {waiting.length > 0 && (
        <aside className="hqj-inbox">
          {waiting.slice(0, 3).map(m => <InboxItem key={m.id} m={m} onDone={reload} />)}
        </aside>
      )}

      <footer className="hqj-bottom">
        {typing ? (
          <div className="hqj-typebar">
            <input className="hqj-input" autoFocus value={text} onChange={e => setText(e.target.value)} placeholder="JOHNNY に話しかける"
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void sendText() } }} />
            <button type="button" className="hqj-round is-small is-primary" onClick={() => void sendText()} disabled={!text.trim() || mode === 'thinking'} aria-label="送る"><Send size={18} /></button>
            <button type="button" className="hqj-round is-small" onClick={() => setTyping(false)} aria-label="声に戻す"><Mic size={18} /></button>
          </div>
        ) : (
          <div className="hqj-controls">
            <button type="button" className="hqj-round is-small" onClick={() => setTyping(true)} aria-label="文字で話す"><Keyboard size={19} /></button>
            <button type="button" className={'hqj-mic' + (mode === 'listening' ? ' is-live' : '')} onClick={() => void talk()} aria-label={busy ? '止める' : '話しかける'}>
              {busy ? <Square size={26} /> : <Mic size={30} />}
            </button>
            <span className="hqj-round is-small is-ghost" aria-hidden="true" />
          </div>
        )}
        <p className="hqj-hint">{mode === 'listening' ? '話し終わると自動で送るよ' : busy ? '押すと止まるよ' : '押して話す'}</p>
      </footer>

      {historyOpen && (
        <div className="hqj-drawer" role="dialog" aria-modal="true" aria-label="履歴">
          <div className="hqj-drawer-head">
            <h3>履歴</h3>
            <button type="button" className="hqj-icon-btn" onClick={() => setHistoryOpen(false)} aria-label="閉じる"><X size={20} /></button>
          </div>
          <div className="hqj-drawer-body">
            <h4>やること</h4>
            {!tasks.length && <p className="hqj-muted">いまは、やることはありません。</p>}
            <div style={{ display: 'grid', gap: 10 }}>
              {tasks.map(t => (
                <div key={t.id} className={'hqj-item' + (t.days_left !== null && t.days_left < 0 ? ' is-urgent' : '')}>
                  <div className="hqj-item-head">
                    <strong>{t.title}</strong>
                    <span className="hqj-time">{t.assignee}{t.due_date ? `・${t.due_date.slice(5).replace('-', '/')}まで` : ''}{t.days_left !== null && t.days_left < 0 ? '（過ぎてる）' : t.days_left === 0 ? '（今日）' : ''}</span>
                  </div>
                  {t.detail && <p className="hqj-item-body" style={{ color: 'var(--hqj-fg-2)' }}>{t.detail}</p>}
                  <button type="button" className="hqj-btn hqj-btn-primary" style={{ marginTop: 8 }} onClick={() => void closeTask(t.id).then(reload)}>終わった（BOS に知らせる）</button>
                </div>
              ))}
            </div>
            <h4>会話</h4>
            {!turns.length && <p className="hqj-muted">まだ会話はありません。</p>}
            <div className="hqj-chat">
              {turns.map((t, i) => <div key={i} className={'hqj-bubble ' + (t.role === 'user' ? 'is-user' : 'is-johnny')}>{t.content}</div>)}
            </div>
            {!!turns.length && <button type="button" className="hqj-btn" style={{ marginTop: 10 }} onClick={() => { setTurns([]); saveChat([]); setHeard(''); setReply('') }}>会話を消す</button>}
            <h4>BOS との伝言</h4>
            {!(messages ?? []).length && <p className="hqj-muted">まだ伝言はありません。</p>}
            <div style={{ display: 'grid', gap: 10 }}>
              {(messages ?? []).slice(0, 20).map(m => (
                <div key={m.id} className="hqj-item">
                  <div className="hqj-item-head">
                    <strong>{m.direction === 'to_owner' ? '→ BOS' : '← BOS'}{' '}{m.kind === 'request' ? '【確認して】' : ''}{m.title}</strong>
                    <span className="hqj-time">{when(m.created_at)}</span>
                  </div>
                  <p className="hqj-item-body">{m.body}</p>
                  <p className="hqj-ok" style={{ margin: '6px 0 0', fontSize: 12 }}>{m.status === 'open' ? 'まだ読まれていない' : STATUS_LABEL[m.status]}{m.reply ? `：${m.reply}` : ''}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function InboxItem({ m, onDone }: { m: HqMessage; onDone: () => void }) {
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (m.status === 'open' && m.kind === 'note') void answerMessage(m.id, 'seen').then(onDone, () => {}) }, [m.id, m.status, m.kind, onDone])
  const act = async (status: 'approved' | 'rejected' | 'answered') => {
    setBusy(true)
    try { await answerMessage(m.id, status, reply.trim() || null); onDone() } finally { setBusy(false) }
  }
  return (
    <div className={'hqj-item' + (m.urgent ? ' is-urgent' : '')}>
      <div className="hqj-item-head">
        <strong>BOS：{m.urgent ? '【急ぎ】' : ''}{m.kind === 'request' ? '【確認して】' : ''}{m.title}</strong>
        <span className="hqj-time">{when(m.created_at)}</span>
      </div>
      <p className="hqj-item-body">{m.body}</p>
      {m.kind === 'request' && (
        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          <input className="hqj-input" value={reply} onChange={e => setReply(e.target.value)} placeholder="ひとこと（なくても OK）" />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="hqj-btn hqj-btn-primary" disabled={busy} onClick={() => void act('approved')}>OK</button>
            <button className="hqj-btn" disabled={busy} onClick={() => void act('rejected')}>NG</button>
            <button className="hqj-btn" disabled={busy || !reply.trim()} onClick={() => void act('answered')}>返事だけ送る</button>
          </div>
        </div>
      )}
    </div>
  )
}
