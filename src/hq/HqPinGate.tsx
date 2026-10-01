import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { HQ_COLORS, HQ_MONO, HQ_SANS, HQ_SERIF } from './hqTheme'
import { HQ_AUTH_REQUIRED_EVENT, HQ_PIN_LENGTH, clearHqSession, getHqToken, hqLogin, verifyHqSession } from './hqSession'

const ERROR_TEXT = {
  invalid_pin:    'PINが正しくありません',
  locked:         '入力ミスが続いたため一時的にロック中です',
  not_configured: '本部PINがサーバーに未設定です',
  network:        '通信できません。接続を確認してください',
} as const
type PinError = keyof typeof ERROR_TEXT

/**
 * 本部画面の入口。本部専用 PIN（6桁・店舗スタッフ PIN とは別）をサーバーで照合し、
 * 本部セッション（14時間）を持っている間だけ本部画面を表示する。
 */
export function HqPinGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(() => getHqToken() !== null)
  const [pin, setPin] = useState('')
  const [errorKind, setErrorKind] = useState<PinError | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    void verifyHqSession().then(ok => { if (!ok) setAuthed(false) })
    const onAuthRequired = () => { setAuthed(false); setPin('') }
    window.addEventListener(HQ_AUTH_REQUIRED_EVENT, onAuthRequired)
    return () => window.removeEventListener(HQ_AUTH_REQUIRED_EVENT, onAuthRequired)
  }, [])

  const submit = useCallback(async (candidate: string) => {
    setChecking(true)
    const r = await hqLogin(candidate)
    setChecking(false)
    if (r.ok) { setAuthed(true); setPin(''); return }
    clearHqSession()
    setErrorKind(r.reason)
    setTimeout(() => { setPin(''); setErrorKind(null) }, r.reason === 'invalid_pin' ? 900 : 2400)
  }, [])

  const press = useCallback((d: string) => {
    if (checking || errorKind) return
    setPin(prev => {
      if (prev.length >= HQ_PIN_LENGTH) return prev
      const next = prev + d
      if (next.length === HQ_PIN_LENGTH) setTimeout(() => { void submit(next) }, 80)
      return next
    })
  }, [checking, errorKind, submit])

  const back = useCallback(() => {
    if (checking || errorKind) return
    setPin(p => p.slice(0, -1))
  }, [checking, errorKind])

  useEffect(() => {
    if (authed) return
    function onKey(e: KeyboardEvent) {
      if (e.key >= '0' && e.key <= '9') press(e.key)
      if (e.key === 'Backspace') back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [authed, press, back])

  if (authed) return <>{children}</>

  return (
    <div style={{
      minHeight: '100dvh', background: HQ_COLORS.bg, color: HQ_COLORS.textPrimary,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '0 24px', fontFamily: HQ_SANS, userSelect: 'none',
    }}>
      <p style={{ fontFamily: HQ_MONO, fontSize: 11, letterSpacing: '0.3em', color: HQ_COLORS.gold, marginBottom: 8 }}>
        GINJIRO HEADQUARTERS
      </p>
      <h1 style={{ fontFamily: HQ_SERIF, fontSize: 24, fontWeight: 700, letterSpacing: '0.1em', marginBottom: 6 }}>銀二郎本部</h1>
      <p style={{ fontSize: 13, color: HQ_COLORS.textSecondary, marginBottom: 36 }}>本部専用PIN（6桁）を入力してください</p>

      <div style={{ display: 'flex', gap: 14, marginBottom: 20 }} aria-label={`${pin.length}桁入力済み`}>
        {Array.from({ length: HQ_PIN_LENGTH }, (_, i) => (
          <span key={i} style={{
            width: 14, height: 14, borderRadius: '50%',
            border: `1.5px solid ${errorKind ? HQ_COLORS.negative : HQ_COLORS.panelBorderStrong}`,
            background: i < pin.length ? (errorKind ? HQ_COLORS.negative : HQ_COLORS.gold) : 'transparent',
          }} />
        ))}
      </div>
      <p role="status" style={{ minHeight: 20, fontSize: 13, color: HQ_COLORS.negative, marginBottom: 20 }}>
        {errorKind ? ERROR_TEXT[errorKind] : checking ? '確認中…' : ''}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, width: '100%', maxWidth: 270 }}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(n => <Key key={n} label={n} onPress={() => press(n)} />)}
        <div />
        <Key label="0" onPress={() => press('0')} />
        <Key label="⌫" onPress={back} ariaLabel="1文字消す" />
      </div>
    </div>
  )
}

function Key({ label, onPress, ariaLabel }: { label: string; onPress: () => void; ariaLabel?: string }) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-label={ariaLabel ?? label}
      style={{
        minHeight: 56, borderRadius: 12,
        background: HQ_COLORS.panel, border: `1px solid ${HQ_COLORS.panelBorder}`,
        color: HQ_COLORS.textPrimary, fontFamily: HQ_SERIF, fontSize: 22, fontWeight: 700,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}
