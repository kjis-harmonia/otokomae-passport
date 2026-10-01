import { useEffect, useState } from 'react'
import { getUserId } from '../utils/userId'
import { bindWithCode, hasCustomerSession, CUSTOMER_AUTH_REQUIRED_EVENT } from '../utils/customerSession'
import { callRpc, isMissingRpc, RpcError } from '../utils/staffSession'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

/** サーバーに顧客セッション方式（ステップA）があるか。1回だけ確認してキャッシュ */
let customerApiAvailable: Promise<boolean> | null = null
function checkCustomerApi(): Promise<boolean> {
  if (!customerApiAvailable) {
    customerApiAvailable = callRpc('customer_get_tickets', { p_session: '' })
      .then(() => true)
      .catch(err => !isMissingRpc(err) && err instanceof RpcError)
  }
  return customerApiAvailable
}

/**
 * 既存会員のアプリ紐付け（顧客セッション未取得の端末だけに表示）。
 * 店頭でスタッフが発行した6桁コード（10分有効・1回限り）を入力すると、この端末にセッションが発行される。
 */
export function CustomerBindCard({ onBound }: { onBound?: () => void }) {
  const [needed, setNeeded] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let alive = true
    const evaluate = () => {
      if (hasCustomerSession()) { setNeeded(false); return }
      void checkCustomerApi().then(ok => { if (alive) setNeeded(ok) })
    }
    evaluate()
    window.addEventListener(CUSTOMER_AUTH_REQUIRED_EVENT, evaluate)
    return () => { alive = false; window.removeEventListener(CUSTOMER_AUTH_REQUIRED_EVENT, evaluate) }
  }, [])

  if (done) {
    return (
      <div style={cardStyle}>
        <p style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: '#F2E6C8' }}>アプリの紐付けが完了しました</p>
      </div>
    )
  }
  if (!needed) return null

  async function submit() {
    if (busy || !/^[0-9]{6}$/.test(code)) return
    setBusy(true)
    setError(null)
    const r = await bindWithCode(getUserId(), code)
    setBusy(false)
    if (r.ok) {
      setDone(true)
      setCode('')
      onBound?.()
    } else {
      setError(r.message)
    }
  }

  return (
    <div style={cardStyle}>
      <p style={{ fontSize: 11, letterSpacing: '0.2em', color: 'rgba(201,162,74,0.8)', marginBottom: 6 }}>APP LINK</p>
      <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: '#F2E6C8', marginBottom: 6 }}>アプリの紐付けが必要です</p>
      <p style={{ fontSize: 13, color: 'rgba(242,230,200,0.72)', lineHeight: 1.7, marginBottom: 12 }}>
        ご来店時にスタッフへ男前パスポートを提示し、「アプリ紐付けコード」を発行してもらってください。
        表示された6桁のコードを入力すると、チケットやクーポンをお使いいただけます。
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={e => { setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6)); setError(null) }}
          placeholder="6桁のコード"
          aria-label="アプリ紐付けコード（6桁）"
          style={{
            flex: 1, minWidth: 0, height: 48, borderRadius: 12, padding: '0 14px',
            background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(201,162,74,0.35)', color: '#F2E6C8',
            fontFamily: 'ui-monospace, monospace', fontSize: 20, letterSpacing: '0.2em', outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={() => { void submit() }}
          disabled={busy || code.length !== 6}
          style={{
            flexShrink: 0, minWidth: 88, height: 48, borderRadius: 12,
            background: code.length === 6 ? 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)' : 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(201,162,74,0.45)', color: '#F2E6C8',
            fontFamily: SERIF, fontSize: 14, fontWeight: 700, letterSpacing: '0.1em',
            cursor: busy || code.length !== 6 ? 'default' : 'pointer',
          }}
        >
          {busy ? '確認中…' : '紐付ける'}
        </button>
      </div>
      {error && <p style={{ fontSize: 13, color: '#F0A8A0', marginTop: 8, lineHeight: 1.6 }}>{error}</p>}
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  margin: '0 16px 14px',
  padding: '16px 18px',
  borderRadius: 18,
  background: 'linear-gradient(160deg, rgba(40,10,12,0.75) 0%, rgba(12,6,5,0.9) 100%)',
  border: '1px solid rgba(201,162,74,0.32)',
}
