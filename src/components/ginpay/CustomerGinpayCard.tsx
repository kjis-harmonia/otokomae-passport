import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import {
  GINPAY_TYPE_LABEL,
  getCustomerGinpayLedger,
  type GinpayLedger,
  type GinpayTransaction,
  yen,
} from '../../utils/ginpayApi'

const SANS = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", sans-serif'

export function CustomerGinpayCard() {
  const [ledger, setLedger] = useState<GinpayLedger | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [chargeNotice, setChargeNotice] = useState(false)

  const load = useCallback(() => {
    getCustomerGinpayLedger(20)
      .then((next) => { setLedger(next); setError(null) })
      .catch(() => { setLedger(null); setError('GINPayを表示できません') })
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

  return (
    <section style={{
      margin: '16px 16px 0',
      borderRadius: 8,
      background: '#FFFFFF',
      color: '#1B1B1A',
      border: '1px solid rgba(255,255,255,0.18)',
      fontFamily: SANS,
      overflow: 'hidden',
    }}>
      <div style={{ padding: '16px 16px 14px', borderBottom: '1px solid #E7E7E3' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>GINPay</h2>
          <p style={{ margin: 0, fontSize: 24, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
            {ledger ? yen(ledger.balance) : '—'}
          </p>
        </div>
        {ledger?.multiple_accounts && (
          <p style={{ margin: '6px 0 0', fontSize: 12, color: '#5F5F5B' }}>統合元口座を含む残高です。</p>
        )}
        {ledger && !ledger.consistent && (
          <p style={{ margin: '6px 0 0', fontSize: 12, color: '#C2362F' }}>残高確認が必要です。店舗へお声がけください。</p>
        )}
        {error && <p style={{ margin: '6px 0 0', fontSize: 12, color: '#C2362F' }}>{error}</p>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: historyOpen ? '1px solid #E7E7E3' : 'none' }}>
        <button type="button" onClick={() => setChargeNotice(v => !v)} style={actionStyle}>チャージ</button>
        <button type="button" onClick={() => setHistoryOpen(v => !v)} style={{ ...actionStyle, borderLeft: '1px solid #E7E7E3' }}>
          利用履歴
        </button>
      </div>

      {chargeNotice && (
        <p style={{ margin: 0, padding: '10px 16px', fontSize: 13, color: '#5F5F5B', lineHeight: 1.7, borderBottom: '1px solid #E7E7E3' }}>
          チャージは店舗スタッフへお声がけください。
        </p>
      )}

      {historyOpen && (
        <div style={{ padding: '4px 16px 10px' }}>
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
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, padding: '9px 0', borderBottom: '1px solid #F1F1EE' }}>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13 }}>{GINPAY_TYPE_LABEL[tx.type]}</span>
        <span style={{ display: 'block', marginTop: 2, fontSize: 11, color: '#9A9A95' }}>{formatDateTime(tx.created_at)}</span>
      </span>
      <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
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
  minHeight: 46,
  border: 'none',
  background: '#FFFFFF',
  color: '#1B1B1A',
  fontFamily: SANS,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
}

const emptyStyle: CSSProperties = { margin: 0, padding: '10px 0', fontSize: 13, color: '#9A9A95' }
