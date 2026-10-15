import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Delete } from 'lucide-react'
import { HQ_AUTH_REQUIRED_EVENT, HQ_PIN_LENGTH, clearHqSession, getHqToken, hqLogin, verifyHqSession } from './hqSession'

const ERROR_TEXT = { invalid_pin: 'PINが正しくありません。', locked: '入力ミスが続いたため一時的にロック中です。', not_configured: '本部PINがサーバーに未設定です。', network: '通信できません。接続を確認してください。' } as const
type PinError = keyof typeof ERROR_TEXT

export function HqPinGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(() => getHqToken() !== null)
  const [pin, setPin] = useState('')
  const [errorKind, setErrorKind] = useState<PinError | null>(null)
  const [checking, setChecking] = useState(false)
  const busy = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    let alive = true
    void verifyHqSession().then(ok => { if (alive && !ok) setAuthed(false) })
    const onAuthRequired = () => { setAuthed(false); setPin('') }
    window.addEventListener(HQ_AUTH_REQUIRED_EVENT, onAuthRequired)
    return () => { alive = false; window.removeEventListener(HQ_AUTH_REQUIRED_EVENT, onAuthRequired); if (resetTimer.current) clearTimeout(resetTimer.current) }
  }, [])
  const submit = useCallback(async (candidate: string) => {
    if (busy.current) return
    busy.current = true; setChecking(true)
    const result = await hqLogin(candidate)
    busy.current = false; setChecking(false)
    if (result.ok) { setAuthed(true); setPin(''); return }
    clearHqSession(); setErrorKind(result.reason)
    resetTimer.current = setTimeout(() => { setPin(''); setErrorKind(null) }, result.reason === 'invalid_pin' ? 1000 : 3000)
  }, [])
  const press = useCallback((digit: string) => {
    if (checking || errorKind || pin.length >= HQ_PIN_LENGTH) return
    const next = pin + digit
    setPin(next)
    if (next.length === HQ_PIN_LENGTH) void submit(next)
  }, [checking, errorKind, pin, submit])
  const back = useCallback(() => { if (!checking && !errorKind) setPin(p => p.slice(0, -1)) }, [checking, errorKind])
  useEffect(() => {
    if (authed) return
    function onKey(event: KeyboardEvent) {
      if (/^[0-9]$/.test(event.key)) { event.preventDefault(); press(event.key) }
      if (event.key === 'Backspace') { event.preventDefault(); back() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [authed, press, back])
  if (authed) return <>{children}</>
  return <div className="hq-login"><div className="hq-login-panel"><span className="hq-brand-mark" aria-hidden="true">銀</span><h1>銀二郎本部</h1><p>店舗を見渡す、ひとつの場所。<br />本部専用の6桁のPINを入力してください。</p><div className={'hq-pin-dots' + (errorKind ? ' is-error' : '')} aria-label={pin.length + '桁入力済み'}>{Array.from({ length: HQ_PIN_LENGTH }, (_, i) => <span key={i} className={i < pin.length ? 'is-filled' : ''} />)}</div><div className="hq-pin-status" role="status">{errorKind ? ERROR_TEXT[errorKind] : checking ? '確認しています…' : ''}</div><div className="hq-keypad">{['1','2','3','4','5','6','7','8','9'].map(n => <button key={n} disabled={checking || !!errorKind} onClick={() => press(n)} aria-label={n}>{n}</button>)}<span /><button disabled={checking || !!errorKind} onClick={() => press('0')}>0</button><button disabled={checking || !!errorKind} onClick={back} aria-label="1文字消す"><Delete size={21} /></button></div><div className="hq-login-foot">本部専用の安全なワークスペース</div>{import.meta.env.DEV && <a href="/headquarters.html?preview=1" className="hq-login-preview">サンプルで画面をプレビュー</a>}</div></div>
}
