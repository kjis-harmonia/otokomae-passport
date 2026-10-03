import { useEffect, useState, type CSSProperties } from 'react'
import { HqPanel } from '../components/HqPanel'
import { HQ_COLORS, HQ_MONO, HQ_SANS } from '../hqTheme'
import {
  GINPAY_TYPE_LABEL,
  hqGinpayAudit,
  hqGinpayReconcile,
  type GinpayAuditEntry,
  type GinpayReconcileResult,
  type GinpayTransactionType,
  yen,
} from '../../utils/ginpayApi'
import { rpcErrorMessage } from '../../utils/staffSession'

const TYPES: Array<{ id: 'all' | GinpayTransactionType; label: string }> = [
  { id: 'all', label: 'すべて' },
  { id: 'charge_store', label: '店舗チャージ' },
  { id: 'charge_stripe', label: 'Stripe' },
  { id: 'payment', label: '支払い' },
  { id: 'refund', label: '返金' },
  { id: 'void', label: '取消' },
  { id: 'adjustment', label: '調整' },
]

export function HqGinpayScreen() {
  const [rows, setRows] = useState<GinpayAuditEntry[] | null>(null)
  const [reconcile, setReconcile] = useState<GinpayReconcileResult | null>(null)
  const [type, setType] = useState<'all' | GinpayTransactionType>('all')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    Promise.all([
      hqGinpayAudit({ type: type === 'all' ? null : type, limit: 100 }),
      hqGinpayReconcile(),
    ])
      .then(([auditRows, rec]) => {
        if (!alive) return
        setRows(auditRows)
        setReconcile(rec)
        setError(null)
      })
      .catch((err) => {
        if (alive) setError(rpcErrorMessage(err, 'GINPay監査を読み込めませんでした。'))
      })
    return () => { alive = false }
  }, [type])

  return (
    <div style={{ display: 'grid', gap: 16, fontFamily: HQ_SANS }}>
      <HqPanel title="GINPay 整合性" code="RECONCILE">
        {error && <p style={{ color: HQ_COLORS.redHi, fontSize: 13 }}>{error}</p>}
        {!reconcile ? (
          <p style={{ color: HQ_COLORS.textSecondary, fontSize: 13 }}>読み込み中…</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <Stat label="総残高" value={yen(reconcile.total_cached_balance)} />
            <Stat label="台帳合計" value={yen(reconcile.total_ledger_balance)} />
            <Stat label="状態" value={reconcile.consistent ? '一致' : '不一致'} danger={!reconcile.consistent} />
          </div>
        )}
        {reconcile && reconcile.accounts.length > 0 && (
          <div style={{ marginTop: 14, borderTop: `1px solid ${HQ_COLORS.panelBorder}`, paddingTop: 10 }}>
            {reconcile.accounts.map((a) => (
              <p key={a.id} style={{ margin: '4px 0', color: HQ_COLORS.redHi, fontSize: 13 }}>
                {a.client_name ?? a.client_id}：残高 {yen(a.balance)} / 台帳 {yen(a.ledger_balance)}
              </p>
            ))}
          </div>
        )}
      </HqPanel>

      <HqPanel title="GINPay 取引監査" code={rows ? `${rows.length}件` : undefined}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {TYPES.map((t) => (
            <button key={t.id} type="button" onClick={() => setType(t.id)} style={{
              minHeight: 34,
              padding: '0 12px',
              borderRadius: 4,
              border: `1px solid ${type === t.id ? HQ_COLORS.textPrimary : HQ_COLORS.panelBorderStrong}`,
              background: type === t.id ? HQ_COLORS.textPrimary : 'transparent',
              color: type === t.id ? HQ_COLORS.bg : HQ_COLORS.textSecondary,
              fontFamily: HQ_SANS,
              fontSize: 12,
              cursor: 'pointer',
            }}>{t.label}</button>
          ))}
        </div>
        {!rows ? (
          <p style={{ color: HQ_COLORS.textSecondary, fontSize: 13 }}>読み込み中…</p>
        ) : rows.length === 0 ? (
          <p style={{ color: HQ_COLORS.textMute, fontSize: 13 }}>取引はありません</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <div role="table" aria-label="GINPay取引監査" style={{ minWidth: 980 }}>
              <div role="row" style={headRow}>
                <span>日時</span><span>顧客</span><span>種別</span><span>金額</span><span>操作者</span><span>元取引</span><span>会計</span><span>Stripe</span>
              </div>
              {rows.map((r) => (
                <div key={r.id} role="row" style={bodyRow}>
                  <span>{formatDateTime(r.created_at)}</span>
                  <span>{r.client_name ?? r.client_id}</span>
                  <span>{GINPAY_TYPE_LABEL[r.type]}</span>
                  <span style={{ fontFamily: HQ_MONO, color: r.amount < 0 ? HQ_COLORS.textPrimary : HQ_COLORS.textSecondary }}>
                    {r.amount > 0 ? '+' : ''}{yen(r.amount)}
                  </span>
                  <span>{r.operator_name ?? r.operator_type}</span>
                  <span>{shortId(r.original_transaction_id)}</span>
                  <span>{shortId(r.accounting_session_id)}</span>
                  <span>{shortId(r.stripe_payment_intent_id ?? r.stripe_checkout_session_id ?? r.stripe_event_id)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </HqPanel>
    </div>
  )
}

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div style={{ borderTop: `1px solid ${HQ_COLORS.panelBorder}`, paddingTop: 10 }}>
      <p style={{ margin: 0, color: HQ_COLORS.textMute, fontSize: 12 }}>{label}</p>
      <p style={{ margin: '6px 0 0', color: danger ? HQ_COLORS.redHi : HQ_COLORS.textPrimary, fontSize: 20, fontWeight: 700, fontFamily: HQ_MONO }}>{value}</p>
    </div>
  )
}

function shortId(value: string | null | undefined): string {
  if (!value) return '—'
  return value.length > 12 ? `${value.slice(0, 8)}…` : value
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso))
}

const headRow: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '120px 160px 120px 110px 120px 120px 120px 130px',
  gap: 12,
  padding: '8px 0',
  borderBottom: `1px solid ${HQ_COLORS.panelBorderStrong}`,
  color: HQ_COLORS.textMute,
  fontSize: 11,
}

const bodyRow: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '120px 160px 120px 110px 120px 120px 120px 130px',
  gap: 12,
  padding: '10px 0',
  borderBottom: `1px solid ${HQ_COLORS.panelBorder}`,
  color: HQ_COLORS.textSecondary,
  fontSize: 12,
  alignItems: 'center',
}
