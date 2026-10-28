import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { StaffHome } from './StaffHome'
import { SecurityAlert } from '../components/SecurityAlert'
import { isStaging } from '../utils/env'
import { StgBadge } from '../components/StgBadge'
import { Delete } from 'lucide-react'
import { getStaffToken, staffLogin, verifyStaffSession, clearStaffSession, STAFF_AUTH_REQUIRED_EVENT, STAFF_PIN_LENGTH } from '../utils/staffSession'

import './staffTerminal.css'
// 旧版はPINの正誤をフロントで判定し、このキーに '1' を保存していた（現在は使用しない）
const LEGACY_PIN_AUTH_KEY = 'ginjiro_staff_pin_auth'

const ERROR_TEXT = {
  invalid_pin:    'PINが正しくありません',
  locked:         '入力ミスが続いたため10分間ロック中です',
  not_configured: 'PINがサーバーに未設定です（管理者へ連絡）',
  network:        '通信できません。電波を確認してください',
  device_pending: 'この端末は登録されていません。本部の「設定」で登録してください',
} as const
type PinError = keyof typeof ERROR_TEXT

/** children を渡すと、認証後にその画面を出す（SB など）。渡さなければ従来どおり店舗端末（StaffHome） */
export function StaffPinGate({ children, app = 'staff' }: { children?: ReactNode; app?: 'staff' | 'sb' } = {}) {
  // サーバー発行のスタッフセッション（14時間）を保持している間だけ端末画面を表示する
  const [authed, setAuthed] = useState(() => getStaffToken() !== null)
  const [pin, setPin] = useState('')
  const [errorKind, setErrorKind] = useState<PinError | null>(null)
  const error = errorKind !== null
  const [checking, setChecking] = useState(false)
  const [shakeKey, setShakeKey] = useState(0)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    try { localStorage.removeItem(LEGACY_PIN_AUTH_KEY) } catch { /* ignore */ }
    // 保存済みトークンがサーバーで失効していればPIN画面へ戻す
    void verifyStaffSession().then(ok => { if (!ok) setAuthed(false) })
    // 操作中にセッション切れ（staff_auth_required）になったらPIN画面へ戻す
    const onAuthRequired = () => { setAuthed(false); setSuccess(false); setPin('') }
    window.addEventListener(STAFF_AUTH_REQUIRED_EVENT, onAuthRequired)
    return () => window.removeEventListener(STAFF_AUTH_REQUIRED_EVENT, onAuthRequired)
  }, [])

  const submitPin = useCallback(async (candidate: string) => {
    setChecking(true)
    const result = await staffLogin(candidate, app)
    setChecking(false)
    if (result.ok) {
      setSuccess(true)
      setTimeout(() => setAuthed(true), 500)
      return
    }
    clearStaffSession()
    setErrorKind(result.reason)
    setShakeKey((k) => k + 1)
    setTimeout(() => {
      setPin('')
      setErrorKind(null)
    }, result.reason === 'invalid_pin' ? 700 : result.reason === 'device_pending' ? 8000 : 2400)
  }, [app])

  const handleDigit = useCallback((d: string) => {
    if (error || checking) return
    setPin((prev) => {
      if (prev.length >= STAFF_PIN_LENGTH) return prev
      const next = prev + d
      if (next.length === STAFF_PIN_LENGTH) {
        setTimeout(() => { void submitPin(next) }, 80)
      }
      return next
    })
  }, [error, checking, submitPin])

  const handleBack = useCallback(() => {
    if (error || checking) return
    setPin((p) => p.slice(0, -1))
  }, [error, checking])

  // Keyboard support
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key >= '0' && e.key <= '9') handleDigit(e.key)
      if (e.key === 'Backspace') handleBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleDigit, handleBack])

  // 登録していない端末が入ろうとしたら、了解を押すまで画面全体に警告を出す（店舗端末・SB の両方）
  if (authed) return <>{children ?? <StaffHome />}<SecurityAlert app={app} /></>

  // iPhone のパスコード画面のように：あたたかい白・明朝の店名・6つの点・丸いキー（端末メニューと同じ見た目）
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key="pin-gate"
        className="st-app st-pin"
        initial={{ opacity: 0 }}
        animate={{ opacity: success ? 0 : 1 }}
        transition={{ duration: success ? 0.4 : 0.3 }}
      >
        {isStaging() && <StgBadge />}

        <motion.header className="st-pin-head" initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05, duration: 0.4 }}>
          <h1><img src={`/icons/${app}-192.png`} alt="" width={56} height={56} style={{ objectFit: 'contain', alignSelf: 'center' }} /><span className="st-wordmark">銀二郎</span><span className="st-mark">{app === 'sb' ? 'SB' : '端末'}</span></h1>
          <p className="st-latin"><i aria-hidden="true" />GINJIRO</p>
        </motion.header>

        <p className="st-pin-prompt" aria-live="polite">
          {error && errorKind ? <span className="st-pin-error">{ERROR_TEXT[errorKind]}</span> : success ? 'ようこそ' : checking ? '確認しています…' : 'スタッフPINを入力'}
        </p>

        <motion.div
          key={shakeKey}
          className="st-pin-dots"
          role="img"
          aria-label={`${pin.length}桁入力済み`}
          animate={error ? { x: [-10, 10, -8, 8, -5, 5, -3, 3, 0] } : {}}
          transition={{ duration: 0.55 }}
        >
          {Array.from({ length: STAFF_PIN_LENGTH }, (_, i) => i).map((i) => (
            <span key={i} className={i < pin.length ? (error ? 'is-error' : success ? 'is-ok' : 'is-on') : undefined} />
          ))}
        </motion.div>

        <motion.div className="st-pin-pad" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12, duration: 0.4 }}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
            <NumKey key={n} label={String(n)} onPress={() => handleDigit(String(n))} />
          ))}
          <span />
          <NumKey label="0" onPress={() => handleDigit('0')} />
          <button type="button" className="st-pin-del" onClick={handleBack} aria-label="1文字消す" disabled={!pin.length}>
            <Delete size={26} />
          </button>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

function NumKey({ label, onPress }: { label: string; onPress: () => void }) {
  return <button type="button" className="st-pin-key" onClick={onPress}>{label}</button>
}
