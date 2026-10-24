import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import {
  GINPAY_TYPE_LABEL,
  getCustomerGinpayLedger,
  type GinpayLedger,
  type GinpayTransaction,
  yen,
} from '../../utils/ginpayApi'
import { GOLD, IVORY, SERIF } from '../wallet/walletTheme'
import { RpcError } from '../../utils/staffSession'

// ウォレットの券と同じ黒×深紅の面に、明朝のアイボリー。金は入金の「＋」だけ（飾りには使わない）
const MUTED = 'rgba(242,230,200,0.56)'
const LINE = '1px solid rgba(242,230,200,0.10)'
const WARN = '#F2B2AA'

export function CustomerGinpayCard() {
  const [ledger, setLedger] = useState<GinpayLedger | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [chargeNotice, setChargeNotice] = useState(false)
  // まだログインしていない（店頭の本人確認の前）：カードは出さない（上のログインの案内に任せる。赤い「表示できません」を出さない）
  const [signedOut, setSignedOut] = useState(false)

  const load = useCallback(() => {
    getCustomerGinpayLedger(20)
      .then((next) => { setLedger(next); setError(null); setSignedOut(false) })
      .catch((err: unknown) => {
        setLedger(null)
        if (err instanceof RpcError && (err.code === 'customer_auth_required' || err.message.includes('customer_auth_required'))) { setSignedOut(true); setError(null) }
        else setError('銀Payを表示できません')
      })
  }, [])

  useEffect(() => {
    load()
    const reload = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', reload)
    window.addEventListener('focus', reload)
    return () => {
      document.removeEventListener('visibilitychange', reload)
      window.removeEventListener('focus', reload)
    }
  }, [load])

  if (signedOut) return null
  return (
    <section aria-label="銀Pay" style={{
      margin: '16px 16px 0',
      borderRadius: 16,
      background: 'linear-gradient(160deg, #1B0C0A 0%, #0D0605 100%)',
      color: IVORY,
      border: '1px solid rgba(201,162,74,0.22)',
      fontFamily: SERIF,
      overflow: 'hidden',
    }}>
      <div style={{ padding: '18px 20px 16px' }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: '0.16em', color: MUTED }}>銀Pay 残高</h2>
        <p style={{ margin: '6px 0 0', fontSize: 36, fontWeight: 700, lineHeight: 1.15, letterSpacing: '0.02em', fontVariantNumeric: 'tabular-nums' }}>
          {ledger ? yen(ledger.balance) : '—'}
        </p>
        {ledger?.multiple_accounts && (
          <p style={{ margin: '8px 0 0', fontSize: 12, color: MUTED }}>統合元口座を含む残高です。</p>
        )}
        {ledger && !ledger.consistent && (
          <p style={{ margin: '8px 0 0', fontSize: 12, color: WARN }}>残高確認が必要です。店舗へお声がけください。</p>
        )}
        {error && <p style={{ margin: '8px 0 0', fontSize: 12, color: WARN }}>{error}</p>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderTop: LINE }}>
        <button type="button" aria-expanded={chargeNotice} onClick={() => setChargeNotice(v => !v)} style={actionStyle}>チャージ</button>
        <button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen(v => !v)} style={{ ...actionStyle, borderLeft: LINE }}>
          利用履歴
        </button>
      </div>

      {chargeNotice && (
        <p style={{ margin: 0, padding: '12px 20px', fontSize: 13, color: MUTED, lineHeight: 1.7, borderTop: LINE }}>
          チャージは店舗スタッフへお声がけください。
        </p>
      )}

      {historyOpen && (
        <div style={{ padding: '2px 20px 10px', borderTop: LINE }}>
          {!ledger ? (
            <p style={emptyStyle}>読み込み中…</p>
          ) : ledger.transactions.length === 0 ? (
            <p style={emptyStyle}>履歴はありません</p>
          ) : ledger.transactions.slice(0, 8).map(tx => <HistoryRow key={tx.id} tx={tx} />)}
        </div>
      )}
    </section>
  )
}

function HistoryRow({ tx }: { tx: GinpayTransaction }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, padding: '11px 0', borderBottom: LINE }}>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 14 }}>{GINPAY_TYPE_LABEL[tx.type]}</span>
        <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: MUTED }}>{formatDateTime(tx.created_at)}</span>
      </span>
      <span style={{ fontSize: 14, fontVariantNumeric: 'tabular-nums', color: tx.amount > 0 ? GOLD : IVORY }}>
        {tx.amount > 0 ? '+' : ''}{yen(tx.amount)}
      </span>
    </div>
  )
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso))
}

const actionStyle: CSSProperties = {
  minHeight: 50,
  border: 'none',
  background: 'transparent',
  color: IVORY,
  fontFamily: SERIF,
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: '0.14em',
  cursor: 'pointer',
}

const emptyStyle: CSSProperties = { margin: 0, padding: '12px 0', fontSize: 13, color: MUTED }
