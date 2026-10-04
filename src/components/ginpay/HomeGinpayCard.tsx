import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  GINPAY_TYPE_LABEL,
  getCustomerGinpayLedger,
  type GinpayLedger,
  type GinpayTransaction,
  yen,
} from '../../utils/ginpayApi'

const SANS = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", sans-serif'
const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

type GinpayHomeStatus = 'loading' | 'unopened' | 'funded' | 'zero' | 'suspended' | 'unavailable'

function getStatus(ledger: GinpayLedger | null, loading: boolean, error: boolean): GinpayHomeStatus {
  if (loading) return 'loading'
  if (error || !ledger) return 'unavailable'
  if (ledger.accounts.length === 0) return 'unopened'
  if (ledger.accounts.some((account) => account.status === 'suspended')) return 'suspended'
  return ledger.balance > 0 ? 'funded' : 'zero'
}

function statusLabel(status: GinpayHomeStatus): string {
  switch (status) {
    case 'loading':
      return '確認中'
    case 'unopened':
      return '未開設'
    case 'funded':
      return '利用可能'
    case 'zero':
      return '残高0'
    case 'suspended':
      return '利用停止'
    case 'unavailable':
      return '取得不可'
  }
}

export function HomeGinpayCard() {
  const [ledger, setLedger] = useState<GinpayLedger | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [chargeNoticeOpen, setChargeNoticeOpen] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    getCustomerGinpayLedger(12)
      .then((next) => {
        setLedger(next)
        setError(false)
      })
      .catch(() => {
        setLedger(null)
        setError(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(load, 0)
    const reload = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', reload)
    window.addEventListener('focus', reload)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', reload)
      window.removeEventListener('focus', reload)
    }
  }, [load])

  const status = getStatus(ledger, loading, error)
  const balance = ledger ? yen(ledger.balance) : '—'
  const disabledCharge = status === 'suspended' || status === 'loading'
  const statusTone = status === 'suspended' || status === 'unavailable'
    ? '#E9B6A4'
    : status === 'funded'
      ? '#E8C878'
      : '#C9BDA2'

  const activeAccounts = useMemo(
    () => ledger?.accounts.filter((account) => account.status === 'active') ?? [],
    [ledger],
  )

  return (
    <section className="px-4" aria-label="GINPay">
      <div style={cardStyle}>
        <div style={topRowStyle}>
          <div style={{ minWidth: 0 }}>
            <p style={labelStyle}>GINPay</p>
            <p style={subtitleStyle}>銀二郎専用プリペイド</p>
          </div>
          <span style={{ ...statusStyle, color: statusTone }}>{statusLabel(status)}</span>
        </div>

        <div style={balanceRowStyle}>
          <span style={balanceLabelStyle}>実残高</span>
          <strong style={balanceStyle}>{balance}</strong>
        </div>

        {ledger?.multiple_accounts && (
          <p style={noteStyle}>統合元口座を含む残高です。</p>
        )}
        {ledger && !ledger.consistent && (
          <p style={{ ...noteStyle, color: '#E9B6A4' }}>残高確認が必要です。店舗へお声がけください。</p>
        )}
        {status === 'unopened' && (
          <p style={noteStyle}>店舗でチャージするとGINPay口座が開設されます。</p>
        )}
        {status === 'suspended' && (
          <p style={{ ...noteStyle, color: '#E9B6A4' }}>現在このGINPayは利用停止中です。</p>
        )}
        {status === 'unavailable' && (
          <p style={{ ...noteStyle, color: '#E9B6A4' }}>残高を取得できませんでした。</p>
        )}

        <div style={actionsStyle}>
          <button
            type="button"
            disabled={disabledCharge}
            onClick={() => setChargeNoticeOpen((v) => !v)}
            style={{ ...actionButtonStyle, opacity: disabledCharge ? 0.48 : 1, cursor: disabledCharge ? 'default' : 'pointer' }}
          >
            ＋チャージ
          </button>
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            style={actionButtonStyle}
          >
            利用履歴
          </button>
        </div>

        {chargeNoticeOpen && (
          <p style={noticeStyle}>
            テスト運用中です。チャージは店舗スタッフへお声がけください。
          </p>
        )}

        {historyOpen && (
          <div style={historyStyle}>
            {!ledger ? (
              <p style={emptyStyle}>{loading ? '読み込み中…' : '履歴を取得できません。'}</p>
            ) : ledger.transactions.length === 0 ? (
              <p style={emptyStyle}>{activeAccounts.length === 0 ? '履歴はまだありません。' : '利用履歴はありません。'}</p>
            ) : (
              ledger.transactions.slice(0, 5).map((tx) => <HistoryRow key={tx.id} transaction={tx} />)
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function HistoryRow({ transaction }: { transaction: GinpayTransaction }) {
  const amount = transaction.amount > 0 ? `+${yen(transaction.amount)}` : yen(transaction.amount)
  return (
    <div style={historyRowStyle}>
      <span style={{ minWidth: 0 }}>
        <span style={historyTitleStyle}>{GINPAY_TYPE_LABEL[transaction.type]}</span>
        <span style={historyDateStyle}>{formatDateTime(transaction.created_at)}</span>
      </span>
      <span style={historyAmountStyle}>{amount}</span>
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

const cardStyle: CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  borderRadius: 14,
  border: '1px solid rgba(201,162,74,0.42)',
  background: 'linear-gradient(145deg, #090705 0%, #16110A 48%, #050403 100%)',
  boxShadow: '0 18px 38px rgba(0,0,0,0.38), inset 0 1px 0 rgba(242,230,200,0.08)',
  color: '#F3E7CC',
  fontFamily: SANS,
  padding: 'clamp(16px, 4vw, 22px)',
}

const topRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 12,
}

const labelStyle: CSSProperties = {
  margin: 0,
  fontFamily: SERIF,
  fontSize: 'clamp(21px, 5.8vw, 27px)',
  fontWeight: 800,
  lineHeight: 1,
  letterSpacing: 0,
}

const subtitleStyle: CSSProperties = {
  margin: '8px 0 0',
  color: 'rgba(243,231,204,0.64)',
  fontSize: 12,
  lineHeight: 1.5,
}

const statusStyle: CSSProperties = {
  flexShrink: 0,
  minHeight: 28,
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 9px',
  borderRadius: 999,
  border: '1px solid rgba(201,162,74,0.28)',
  background: 'rgba(255,255,255,0.035)',
  fontSize: 11,
  fontWeight: 700,
  whiteSpace: 'nowrap',
}

const balanceRowStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
  marginTop: 24,
}

const balanceLabelStyle: CSSProperties = {
  color: 'rgba(243,231,204,0.56)',
  fontSize: 12,
}

const balanceStyle: CSSProperties = {
  display: 'block',
  minWidth: 0,
  color: '#F5D583',
  fontSize: 'clamp(30px, 9vw, 42px)',
  lineHeight: 1,
  fontWeight: 800,
  fontVariantNumeric: 'tabular-nums',
  overflowWrap: 'anywhere',
}

const noteStyle: CSSProperties = {
  margin: '10px 0 0',
  color: 'rgba(243,231,204,0.62)',
  fontSize: 12,
  lineHeight: 1.65,
}

const actionsStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 8,
  marginTop: 18,
}

const actionButtonStyle: CSSProperties = {
  minWidth: 0,
  minHeight: 44,
  borderRadius: 9,
  border: '1px solid rgba(201,162,74,0.38)',
  background: 'rgba(255,255,255,0.045)',
  color: '#EFD28B',
  fontFamily: SANS,
  fontSize: 13,
  fontWeight: 700,
  whiteSpace: 'nowrap',
}

const noticeStyle: CSSProperties = {
  margin: '12px 0 0',
  padding: '10px 11px',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.045)',
  color: 'rgba(243,231,204,0.72)',
  fontSize: 12,
  lineHeight: 1.65,
}

const historyStyle: CSSProperties = {
  marginTop: 12,
  borderTop: '1px solid rgba(201,162,74,0.20)',
  paddingTop: 4,
}

const historyRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: 12,
  alignItems: 'center',
  padding: '10px 0',
  borderBottom: '1px solid rgba(201,162,74,0.14)',
}

const historyTitleStyle: CSSProperties = {
  display: 'block',
  color: '#F3E7CC',
  fontSize: 13,
  lineHeight: 1.4,
}

const historyDateStyle: CSSProperties = {
  display: 'block',
  marginTop: 2,
  color: 'rgba(243,231,204,0.48)',
  fontSize: 11,
  lineHeight: 1.4,
}

const historyAmountStyle: CSSProperties = {
  color: '#F5D583',
  fontSize: 13,
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

const emptyStyle: CSSProperties = {
  margin: 0,
  padding: '11px 0 7px',
  color: 'rgba(243,231,204,0.56)',
  fontSize: 12,
}
