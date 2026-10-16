import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  GINPAY_TYPE_LABEL,
  type GinpayClientApi,
  type GinpayLedger,
  type GinpayTransaction,
  ginpayErrorMessage,
  idempotencyKey,
  yen,
} from '../../utils/ginpayApi'
import { rpcErrorMessage } from '../../utils/staffSession'
import { C, SANS, inputStyle, linkStyle } from '../booking/ledgerTheme'
import { Field, PrimaryButton, SecondaryButton } from '../booking/ledgerUi'

const STORE_PAYMENT_METHODS = [
  { id: 'cash', label: '現金' },
  { id: 'credit', label: 'カード' },
  { id: 'qr', label: 'QR' },
  { id: 'other', label: 'その他' },
] as const

type StorePaymentMethod = (typeof STORE_PAYMENT_METHODS)[number]['id']

export function GinpayPanel({ clientId, api, ensureActor, showAccountDetail = true }: {
  clientId: string
  api: GinpayClientApi
  ensureActor: () => boolean
  showAccountDetail?: boolean
}) {
  const [ledger, setLedger] = useState<GinpayLedger | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [chargeOpen, setChargeOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<StorePaymentMethod>('cash')
  const [memo, setMemo] = useState('')
  const [confirmingCharge, setConfirmingCharge] = useState(false)
  // チャージの確認ごとに1つのキー（通信の再試行で二重にチャージしない）
  const [chargeKey, setChargeKey] = useState<string | null>(null)
  const [chargeAccountId, setChargeAccountId] = useState<string | null>(null)
  const [reverse, setReverse] = useState<ReverseState | null>(null)

  const load = useCallback(async () => {
    try {
      setLedger(await api.ledger(clientId, 80))
      setError(null)
    } catch (err) {
      setError(rpcErrorMessage(err, 'GINPayを読み込めませんでした。'))
    }
  }, [api, clientId])

  useEffect(() => { void load() }, [load]) // eslint-disable-line react-hooks/set-state-in-effect

  const parsedAmount = useMemo(() => parseYenInput(amount), [amount])
  const canCharge = !!api.chargeStore
  // 統合された顧客で口座が複数あるときは、チャージ先を選ぶ（自動で決めない）
  const activeAccounts = ledger?.accounts.filter(a => a.status === 'active') ?? []
  const needsAccountChoice = activeAccounts.length > 1
  const chargeAccount = activeAccounts.find(a => a.id === chargeAccountId) ?? null

  async function submitCharge() {
    if (!api.chargeStore || !parsedAmount || (needsAccountChoice && !chargeAccount)) return
    if (!confirmingCharge) {
      setConfirmingCharge(true)
      setChargeKey(idempotencyKey('staff-store-charge'))
      setMessage(null)
      return
    }
    if (!ensureActor()) return
    setLoading(true)
    setMessage(null)
    try {
      const res = await api.chargeStore({
        clientId, amount: parsedAmount, paymentMethod: method, memo: memo.trim() || undefined,
        accountId: needsAccountChoice ? chargeAccount?.id : undefined, idempotencyKey: chargeKey ?? undefined,
      })
      if (!res.ok) {
        setMessage(ginpayErrorMessage(res.error))
        return
      }
      setAmount('')
      setMemo('')
      setConfirmingCharge(false)
      setChargeKey(null)
      setChargeAccountId(null)
      setChargeOpen(false)
      setMessage('チャージしました。')
      await load()
    } catch (err) {
      setMessage(rpcErrorMessage(err, 'チャージに失敗しました。'))
    } finally {
      setLoading(false)
    }
  }

  async function submitReverse() {
    if (!reverse) return
    if (!reverse.reason.trim()) {
      setReverse({ ...reverse, error: '理由を入力してください。' })
      return
    }
    if (!ensureActor()) return
    setLoading(true)
    try {
      const res = reverse.kind === 'refund'
        ? await api.refund?.({ transactionId: reverse.transaction.id, amount: parseYenInput(reverse.amount) ?? 0, reason: reverse.reason.trim() })
        : await api.void?.({ transactionId: reverse.transaction.id, reason: reverse.reason.trim() })
      if (!res) return
      if (!res.ok) {
        setReverse({ ...reverse, error: ginpayErrorMessage(res.error) })
        return
      }
      setReverse(null)
      setMessage(reverse.kind === 'refund' ? '返金を記録しました。' : '取消を記録しました。')
      await load()
    } catch (err) {
      setReverse({ ...reverse, error: rpcErrorMessage(err, '処理に失敗しました。') })
    } finally {
      setLoading(false)
    }
  }

  return (
    <section style={{ marginTop: 28, marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, borderBottom: `1px solid ${C.text}`, paddingBottom: 8 }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, color: C.sub }}>GINPay</h2>
        {ledger && <strong style={{ marginLeft: 'auto', fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{yen(ledger.balance)}</strong>}
      </div>

      {error ? <p style={msgStyle(C.danger)}>{error}</p> : !ledger ? <p style={msgStyle(C.sub)}>読み込み中…</p> : (
        <>
          {/* 口座が1つで台帳と一致していれば、見出しの残高だけで足りる（台帳合計・口座の内訳は出さない） */}
          {(!ledger.consistent || ledger.multiple_accounts) && (
          <div style={{ padding: '12px 0', borderBottom: `1px solid ${C.line}` }}>
              <p style={{ fontSize: 13, color: C.sub }}>
                {!ledger.consistent && <span style={{ color: C.danger }}>残高不一致（台帳合計 {yen(ledger.ledger_balance)}）</span>}
                {!ledger.consistent && ledger.multiple_accounts && ' / '}
                {ledger.multiple_accounts && '統合元口座あり'}
              </p>
            {showAccountDetail && ledger.multiple_accounts && (
              <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
                {ledger.accounts.map((a) => (
                  <p key={a.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, color: a.is_current_client ? C.text : C.sub }}>
                    <span>{a.is_current_client ? '現在の顧客口座' : `${a.client_name ?? '統合元'} の口座`}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{yen(a.balance)}</span>
                  </p>
                ))}
              </div>
            )}
          </div>
          )}

          {canCharge && (
            <div style={{ padding: '12px 0', borderBottom: `1px solid ${C.line}` }}>
              {!chargeOpen ? (
                <button type="button" onClick={() => { setChargeOpen(true); setMessage(null) }} style={linkStyle}>チャージ</button>
              ) : (
                <div style={{ maxWidth: 520 }}>
                  {needsAccountChoice && (
                    <Field label="チャージ先">
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {activeAccounts.map((a) => (
                          <button key={a.id} type="button" onClick={() => { setChargeAccountId(a.id); setConfirmingCharge(false) }} style={{
                            minHeight: 42, padding: '0 14px', borderRadius: 8, border: `1px solid ${chargeAccountId === a.id ? C.text : C.lineStrong}`,
                            background: chargeAccountId === a.id ? C.text : C.bg, color: chargeAccountId === a.id ? C.bg : C.text,
                            fontFamily: SANS, fontSize: 13, cursor: 'pointer',
                          }}>{a.is_current_client ? '現在の顧客口座' : `${a.client_name ?? '統合元'} の口座`}</button>
                        ))}
                      </div>
                    </Field>
                  )}
                  <Field label="金額">
                    <input value={amount} onChange={e => { setAmount(e.target.value.replace(/[^\d]/g, '')); setConfirmingCharge(false) }}
                      inputMode="numeric" placeholder="0" style={inputStyle} />
                  </Field>
                  <Field label="支払方法">
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                      {STORE_PAYMENT_METHODS.map((m) => (
                        <button key={m.id} type="button" onClick={() => { setMethod(m.id); setConfirmingCharge(false) }} style={{
                          minHeight: 42, borderRadius: 8, border: `1px solid ${method === m.id ? C.text : C.lineStrong}`,
                          background: method === m.id ? C.text : C.bg, color: method === m.id ? C.bg : C.text,
                          fontFamily: SANS, fontSize: 13, cursor: 'pointer',
                        }}>{m.label}</button>
                      ))}
                    </div>
                  </Field>
                  <Field label="メモ">
                    <input value={memo} onChange={e => setMemo(e.target.value)} maxLength={200} style={inputStyle} />
                  </Field>
                  {confirmingCharge && (
                    <p style={{ marginTop: 10, fontSize: 14, lineHeight: 1.7 }}>
                      {needsAccountChoice && chargeAccount && !chargeAccount.is_current_client ? `${chargeAccount.client_name ?? '統合元'} の口座` : ledger.client_name ?? 'この顧客'}に {yen(parsedAmount)} をチャージします。内容を確認してください。
                    </p>
                  )}
                  <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                    <SecondaryButton onClick={() => { setChargeOpen(false); setConfirmingCharge(false); setMessage(null) }} disabled={loading}>やめる</SecondaryButton>
                    <PrimaryButton onClick={() => void submitCharge()} disabled={loading || !parsedAmount || (needsAccountChoice && !chargeAccount)} style={{ flex: 2 }}>
                      {loading ? '処理中…' : confirmingCharge ? 'チャージ確定' : '確認へ'}
                    </PrimaryButton>
                  </div>
                </div>
              )}
            </div>
          )}

          <div style={{ paddingTop: 12 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: C.sub, marginBottom: 6 }}>履歴</h3>
            {ledger.transactions.length === 0 ? <p style={msgStyle(C.mute)}>履歴はありません</p> : ledger.transactions.map((tx) => (
              <TransactionRow key={tx.id} tx={tx} canReverse={!!api.void || !!api.refund} onReverse={setReverse} />
            ))}
          </div>
        </>
      )}

      {message && <p style={msgStyle(message.includes('失敗') || message.includes('不足') ? C.danger : C.sub)}>{message}</p>}

      {reverse && (
        <div role="dialog" aria-modal="true" aria-label={reverse.kind === 'refund' ? '返金' : '取消'} style={modalBackdrop}>
          <div style={modalBody}>
            <p style={{ fontSize: 15, fontWeight: 600 }}>{reverse.kind === 'refund' ? '返金を記録' : '取引を取消'}</p>
            <p style={{ marginTop: 6, fontSize: 13, color: C.sub, lineHeight: 1.6 }}>
              元取引：{GINPAY_TYPE_LABEL[reverse.transaction.type]} {yen(reverse.transaction.amount)}
            </p>
            {reverse.kind === 'refund' && (
              <Field label="返金額">
                <input value={reverse.amount} onChange={e => setReverse({ ...reverse, amount: e.target.value.replace(/[^\d]/g, ''), error: null })}
                  inputMode="numeric" style={inputStyle} />
              </Field>
            )}
            <Field label="理由">
              <input value={reverse.reason} onChange={e => setReverse({ ...reverse, reason: e.target.value, error: null })}
                maxLength={200} style={inputStyle} autoFocus />
            </Field>
            {reverse.error && <p style={msgStyle(C.danger)}>{reverse.error}</p>}
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <SecondaryButton onClick={() => setReverse(null)} disabled={loading}>やめる</SecondaryButton>
              <PrimaryButton danger onClick={() => void submitReverse()} disabled={loading || !reverse.reason.trim() || (reverse.kind === 'refund' && !parseYenInput(reverse.amount))} style={{ flex: 2 }}>
                {loading ? '処理中…' : reverse.kind === 'refund' ? '返金する' : '取消する'}
              </PrimaryButton>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

interface ReverseState {
  kind: 'refund' | 'void'
  transaction: GinpayTransaction
  amount: string
  reason: string
  error: string | null
}

function TransactionRow({ tx, canReverse, onReverse }: {
  tx: GinpayTransaction
  canReverse: boolean
  onReverse: (state: ReverseState) => void
}) {
  const amountColor = tx.amount < 0 ? C.text : C.sub
  // 会計に紐付いた取引（会計の支払いと、その取消の戻し）は、会計の取消で会計と一緒に戻す（GINPay 側だけでは戻さない）
  const saleLinked = !!tx.accounting_session_id
  const canRefund = canReverse && !saleLinked && tx.status === 'posted' && tx.type === 'payment' && tx.amount < 0
  const canVoid = canReverse && !saleLinked && tx.status === 'posted' && tx.type !== 'void'
  return (
    <div style={txRowStyle}>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 14, lineHeight: 1.5 }}>{GINPAY_TYPE_LABEL[tx.type]}</span>
        <span style={{ display: 'block', fontSize: 12, color: C.mute, lineHeight: 1.5 }}>
          {formatDateTime(tx.created_at)}
          {tx.operator_name ? ` / ${tx.operator_name}` : ''}
          {saleLinked ? '　会計' : ''}
          {tx.stripe_payment_intent_id ? '　Stripe' : ''}
        </span>
      </span>
      <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: amountColor }}>
        {tx.amount > 0 ? '+' : ''}{yen(tx.amount)}
        {(canRefund || canVoid) && (
          <span style={{ display: 'block', marginTop: 4 }}>
            {canRefund && <button type="button" onClick={() => onReverse({ kind: 'refund', transaction: tx, amount: String(Math.abs(tx.amount)), reason: '', error: null })} style={smallLink}>返金</button>}
            {canVoid && <button type="button" onClick={() => onReverse({ kind: 'void', transaction: tx, amount: '', reason: '', error: null })} style={smallLink}>取消</button>}
          </span>
        )}
      </span>
    </div>
  )
}

function parseYenInput(value: string): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
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

const txRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: 12,
  alignItems: 'start',
  padding: '10px 0',
  borderBottom: `1px solid ${C.line}`,
}

const smallLink: CSSProperties = {
  marginLeft: 6,
  minHeight: 36,
  padding: '0 4px',
  border: 'none',
  background: 'transparent',
  color: C.sub,
  fontFamily: SANS,
  fontSize: 12,
  textDecoration: 'underline',
  textUnderlineOffset: 3,
  cursor: 'pointer',
}

function msgStyle(color: string): CSSProperties {
  return { marginTop: 10, fontSize: 13, color, lineHeight: 1.6 }
}

const modalBackdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 950,
  background: 'rgba(20,20,18,0.28)',
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'center',
  padding: 0,
}

const modalBody: CSSProperties = {
  width: '100%',
  maxWidth: 520,
  background: C.bg,
  color: C.text,
  fontFamily: SANS,
  borderTop: `1px solid ${C.line}`,
  borderRadius: '14px 14px 0 0',
  padding: '18px 16px calc(18px + env(safe-area-inset-bottom, 0px))',
  boxSizing: 'border-box',
}
