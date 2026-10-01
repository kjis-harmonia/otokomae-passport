import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { getUserId } from '../utils/userId'
import {
  bindWithCode, hasCustomerSession,
  CUSTOMER_AUTH_REQUIRED_EVENT, type CustomerAuthRequiredDetail,
} from '../utils/customerSession'
import { callRpc, isMissingRpc, RpcError } from '../utils/staffSession'

// 以前のチケットを引き継ぐ（既存会員の端末に顧客セッションを発行する）。
// 仕組みは従来どおり：店頭でスタッフが発行する6桁コード（10分有効・1回限り）→ customer_bind_with_code。
// 顧客セッションを持つ端末（新規登録・引き継ぎ済み）には何も表示しない。

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const IVORY = '#F2E6C8'

/** 「あとで」を選んだら、自動の案内はこの期間出さない（操作に引き継ぎが必要なときは出す） */
const SNOOZE_KEY = 'ginjiro_previous_tickets_snooze_until'
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000

function isSnoozed(): boolean {
  try { return Number(localStorage.getItem(SNOOZE_KEY) ?? 0) > Date.now() } catch { return false }
}
function snooze(): void {
  try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)) } catch { /* ignore */ }
}

/** サーバーに引き継ぎの仕組み（ステップA）があるか。1回だけ確認してキャッシュ */
let customerApiAvailable: Promise<boolean> | null = null
function checkCustomerApi(): Promise<boolean> {
  if (!customerApiAvailable) {
    customerApiAvailable = callRpc('customer_get_tickets', { p_session: '' })
      .then(() => true)
      .catch(err => !isMissingRpc(err) && err instanceof RpcError)
  }
  return customerApiAvailable
}

/** 顧客セッションが無く、引き継ぎが使える端末か */
function useNeedsPreviousTickets(): boolean {
  const [needed, setNeeded] = useState(false)
  useEffect(() => {
    let alive = true
    const evaluate = () => {
      if (hasCustomerSession()) { setNeeded(false); return }
      void checkCustomerApi().then(ok => { if (alive) setNeeded(ok && !hasCustomerSession()) })
    }
    evaluate()
    window.addEventListener('ginjiro:customer-session-changed', evaluate)
    window.addEventListener(CUSTOMER_AUTH_REQUIRED_EVENT, evaluate)
    return () => {
      alive = false
      window.removeEventListener('ginjiro:customer-session-changed', evaluate)
      window.removeEventListener(CUSTOMER_AUTH_REQUIRED_EVENT, evaluate)
    }
  }, [])
  return needed
}

/**
 * Wallet 用：必要なときだけ小さなモーダルで案内する（常設の表示はしない）。
 *   - チケットの利用・譲渡・クーポンQRなど、引き継ぎが必要な操作をしたとき
 *   - 以前のチケットを読み込めなかったとき（「あとで」を選んだ後7日間は出さない）
 */
export function PreviousTicketsPrompt({ onBound }: { onBound?: () => void }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onRequired = (e: Event) => {
      if (hasCustomerSession()) return
      const source = (e as CustomEvent<CustomerAuthRequiredDetail>).detail?.source ?? 'action'
      if (source === 'read' && isSnoozed()) return
      void checkCustomerApi().then(ok => { if (ok && !hasCustomerSession()) setOpen(true) })
    }
    window.addEventListener(CUSTOMER_AUTH_REQUIRED_EVENT, onRequired)
    return () => window.removeEventListener(CUSTOMER_AUTH_REQUIRED_EVENT, onRequired)
  }, [])

  return (
    <AnimatePresence>
      {open && (
        <PreviousTicketsDialog
          onLater={() => { snooze(); setOpen(false) }}
          onClose={() => setOpen(false)}
          onBound={onBound}
        />
      )}
    </AnimatePresence>
  )
}

/** My画面用：顧客セッションが無い端末にだけ「以前のチケットを引き継ぐ」を出す */
export function PreviousTicketsEntry({ onBound }: { onBound?: () => void }) {
  const needed = useNeedsPreviousTickets()
  const [open, setOpen] = useState(false)
  if (!needed && !open) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          padding: '15px 18px', borderRadius: 16, cursor: 'pointer', textAlign: 'left',
          background: 'linear-gradient(155deg, #0D0805 0%, #080403 100%)', border: '1px solid rgba(201,162,74,0.2)',
        }}
      >
        <span>
          <span style={{ display: 'block', fontFamily: SERIF, fontSize: 14, fontWeight: 700, color: IVORY }}>以前のチケットを引き継ぐ</span>
          <span style={{ display: 'block', marginTop: 3, fontSize: 11, color: 'rgba(242,230,200,0.45)', lineHeight: 1.6 }}>
            以前からお使いのチケットをこの端末で使えるようにします
          </span>
        </span>
        <span aria-hidden="true" style={{ color: 'rgba(201,162,74,0.7)', fontSize: 18 }}>›</span>
      </button>
      <AnimatePresence>
        {open && (
          <PreviousTicketsDialog
            startWithCode
            onLater={() => setOpen(false)}
            onClose={() => setOpen(false)}
            onBound={onBound}
          />
        )}
      </AnimatePresence>
    </>
  )
}

type Step = 'ask' | 'code' | 'done'

function PreviousTicketsDialog({ startWithCode = false, onLater, onClose, onBound }: {
  startWithCode?: boolean
  onLater: () => void
  onClose: () => void
  onBound?: () => void
}) {
  const reduced = useReducedMotion() ?? false
  const [step, setStep] = useState<Step>(startWithCode ? 'code' : 'ask')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(async () => {
    if (busy || !/^[0-9]{6}$/.test(code)) return
    setBusy(true)
    setError(null)
    const r = await bindWithCode(getUserId(), code)
    setBusy(false)
    if (r.ok) {
      setStep('done')
      setCode('')
      onBound?.()
    } else {
      setError(r.message)
    }
  }, [busy, code, onBound])

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 320, background: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 20px' }}
      onClick={step === 'done' ? onClose : onLater}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="以前のチケットを引き継ぐ"
        initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: reduced ? 0 : 0.2 }}
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 320, borderRadius: 20, padding: '22px 20px 18px', textAlign: 'center',
          background: 'linear-gradient(160deg, #160A07 0%, #0A0504 100%)', border: '1px solid rgba(201,162,74,0.3)',
          boxShadow: '0 20px 56px rgba(0,0,0,0.8)',
        }}
      >
        {step === 'done' ? (
          <>
            <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: IVORY, marginBottom: 16 }}>引き継ぎが完了しました</p>
            <DialogButton primary onClick={onClose}>閉じる</DialogButton>
          </>
        ) : (
          <>
            <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: IVORY, marginBottom: 8 }}>以前のチケットを引き継ぐ</p>
            {step === 'ask' ? (
              <>
                <p style={{ fontSize: 12.5, color: 'rgba(242,230,200,0.7)', lineHeight: 1.75, marginBottom: 18 }}>
                  以前からお持ちのチケットをこの端末で使うには、引き継ぎが必要です。
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <DialogButton onClick={onLater}>あとで</DialogButton>
                  <DialogButton primary onClick={() => setStep('code')}>引き継ぐ</DialogButton>
                </div>
              </>
            ) : (
              <>
                <p style={{ fontSize: 12.5, color: 'rgba(242,230,200,0.7)', lineHeight: 1.75, marginBottom: 14 }}>
                  店頭でスタッフに男前パスポートを見せ、引き継ぎコード（6桁）を受け取って入力してください。
                </p>
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={e => { setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6)); setError(null) }}
                  onKeyDown={e => { if (e.key === 'Enter') void submit() }}
                  placeholder="6桁のコード"
                  aria-label="引き継ぎコード（6桁）"
                  style={{
                    width: '100%', height: 48, borderRadius: 12, padding: '0 14px', textAlign: 'center',
                    background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(201,162,74,0.35)', color: IVORY,
                    fontFamily: 'ui-monospace, monospace', fontSize: 20, letterSpacing: '0.24em', outline: 'none',
                  }}
                />
                {error && <p style={{ fontSize: 12, color: '#F0A8A0', marginTop: 8, lineHeight: 1.6 }}>{error}</p>}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
                  <DialogButton onClick={onLater}>あとで</DialogButton>
                  <DialogButton primary disabled={busy || code.length !== 6} onClick={() => { void submit() }}>
                    {busy ? '確認中…' : '引き継ぐ'}
                  </DialogButton>
                </div>
              </>
            )}
          </>
        )}
      </motion.div>
    </div>
  )
}

function DialogButton({ children, primary, disabled, onClick }: {
  children: React.ReactNode
  primary?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        width: '100%', minHeight: 46, borderRadius: 12,
        background: primary && !disabled ? 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)' : 'rgba(255,255,255,0.04)',
        border: primary ? '1px solid rgba(201,162,74,0.45)' : '1px solid rgba(255,255,255,0.1)',
        color: primary ? IVORY : 'rgba(242,230,200,0.6)',
        fontFamily: SERIF, fontSize: 14, fontWeight: 700, letterSpacing: '0.08em',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  )
}
