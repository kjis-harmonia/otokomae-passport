import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
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
import { isResultUnknown } from '../../utils/staffRpc'
import { C, SANS, inputStyle, linkStyle } from '../booking/ledgerTheme'
import {
  getCurrentOperator,
  type OperatorSession,
} from '../../utils/posOperatorSession'
import { OperatorAuthModal } from '../pos/PosAuthModals'
import { ManagerApprovalModal } from '../pos/ManagerApprovalModal'
import { chargeApprovalSummary, refundApprovalSummary, type ApprovalSummary } from '../../utils/approvalSummary'
import { Field, PrimaryButton, SecondaryButton } from '../booking/ledgerUi'
import { usePendingView } from '../pos/usePendingView'
import {
  assertPendingSendable, beginPendingOp, findBlockingOp, isPendingInFlight, markPendingUnknown,
  pendingErrorMessage, pendingLabel, pendingStoreMessage, settlePendingOp, target, type PendingOp,
} from '../../utils/pendingOps'
import {
  confirmPendingOp, draftCharge, draftRefund, sendPendingWithApproval,
  type ChargePendingInput, type RefundPendingInput,
} from '../../utils/pendingConfirm'
import { pendingNotice, type PendingCheck } from '../../utils/pendingNotice'
import { runTicketPendingAction as runPendingStorageAction } from '../../utils/ticketIssueGuard'
import { PendingOperationNotice } from '../pos/PendingOperationNotice'

const STORE_PAYMENT_METHODS = [
  { id: 'cash', label: '現金' },
  { id: 'credit', label: 'カード' },
  { id: 'qr', label: 'QR' },
  { id: 'other', label: 'その他' },
] as const

type StorePaymentMethod = (typeof STORE_PAYMENT_METHODS)[number]['id']

interface PendingGinpayApproval {
  kind: 'charge' | 'refund'
  action: string
  requestHash: string
  input: ChargePendingInput | RefundPendingInput
  /** 結果不明の記録の続き（同じ内容・同じキーで承認つきに送る）。無ければ新しい送信 */
  continuesOpId?: string
}

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
  const [refundKey, setRefundKey] = useState<string | null>(null)
  const [showAuthModal, setShowAuthModal] = useState<boolean>(false)
  const [pendingApproval, setPendingApproval] = useState<PendingGinpayApproval | null>(null)
  // 同時クリック対策（state の更新を待たずに2回目の送信・確認を止める）
  const sendingRef = useRef(false)

  // 未解決の操作は端末の記録（pendingOps）で管理する。この顧客に未解決の記録があれば、チャージ・返金・取消を止める
  const pendingView = usePendingView()
  // 最後の「結果を確認」の結果（どの記録の結果かを持つ。通知の状態に使う）
  const [lockCheck, setLockCheck] = useState<PendingCheck | null>(null)
  // 顧客と、その顧客（統合元を含む）の口座で止める。統合で顧客が変わっても、同じ口座の未解決の操作を見逃さない
  const lockTargets = [target.client(clientId), ...(ledger?.accounts ?? []).map(a => target.account(a.id))]
  const blockingOp = findBlockingOp(pendingView.ops, 'ginpay_charge', lockTargets)
  const lockOp: PendingOp | null = blockingOp && !isPendingInFlight(blockingOp.id) ? blockingOp : null
  const storeFailure = pendingView.failure
  const locked = lockOp !== null || storeFailure !== null
  // 送信中の記録（この画面・開き直す前の画面が送ったもの）。処理中と表示し、新しい操作のボタンを出さない（送信ガードは begin のまま）
  const inFlightOp: PendingOp | null = blockingOp && isPendingInFlight(blockingOp.id) ? blockingOp : null
  const uiLocked = locked || inFlightOp !== null
  const notice = pendingNotice({ failure: storeFailure, op: lockOp ?? inFlightOp, inFlight: inFlightOp !== null && lockOp === null, check: lockCheck })
  const refundKind = api.scope === 'hq' ? 'hq_ginpay_refund' : 'ginpay_refund'

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

  function finishCharge(text = 'チャージしました。') {
    setAmount('')
    setMemo('')
    setConfirmingCharge(false)
    setChargeKey(null)
    setChargeAccountId(null)
    setChargeOpen(false)
    setMessage(text)
  }

  /** 新しいチャージを送る。送信前に端末へ記録し、記録できなければ送らない */
  async function sendCharge(input: ChargePendingInput, operator: OperatorSession, approvalToken: string | null) {
    if (!api.chargeStore) return
    let rec: PendingOp
    try {
      rec = await beginPendingOp(draftCharge(input, operator), input, [operator.operatorToken, approvalToken])
    } catch (err) {
      setMessage(pendingErrorMessage(err))
      return
    }
    try {
      await assertPendingSendable(rec.id, input.accountId)
    } catch (err) {
      // 送っていない。記録を消して理由を出す
      await settlePendingOp(rec.id, 'not_executed').catch(() => undefined)
      setMessage(pendingErrorMessage(err))
      return
    }
    try {
      const res = await api.chargeStore(input, operator, approvalToken)
      if (!res.ok) {
        // この送信が業務エラーで返った＝このチャージは実行されていない
        await settlePendingOp(rec.id, 'not_executed').catch(() => undefined)
        if (res.error === 'approval_required') {
          if (!res.action || !res.request_hash) {
            setMessage('管理者承認情報を取得できませんでした。最初からやり直してください。')
            setChargeKey(null)
            return
          }
          setPendingApproval({ kind: 'charge', action: res.action, requestHash: res.request_hash, input })
          return
        }
        setMessage(res.error === 'approval_expired' ? '承認の有効期限が切れました。最初からやり直してください。' : ginpayErrorMessage(res.error))
        return
      }
      await settlePendingOp(rec.id, 'server_confirmed').catch(() => undefined)
      finishCharge()
      await load()
    } catch (err) {
      if (isResultUnknown(err)) {
        // 確定した可能性がある。記録を残し、同じ内容・同じキーでだけ確認する
        await markPendingUnknown(rec.id)
        setLockCheck(null)
      } else {
        await settlePendingOp(rec.id, 'not_executed').catch(() => undefined)
        setMessage(rpcErrorMessage(err, 'チャージは確定していません。内容を確認してください。'))
      }
    }
  }

  /** 新しい返金を送る。送信前に端末へ記録し、記録できなければ送らない */
  async function sendRefund(input: RefundPendingInput, operator: OperatorSession, approvalToken: string | null, current: ReverseState | null) {
    if (!api.refund) return
    const showError = (text: string) => { if (current) setReverse({ ...current, error: text }); else setMessage(text) }
    let rec: PendingOp
    try {
      rec = await beginPendingOp(draftRefund(refundKind, clientId, input, operator), input, [operator.operatorToken, approvalToken])
    } catch (err) {
      showError(pendingErrorMessage(err))
      return
    }
    try {
      await assertPendingSendable(rec.id, input.accountId)
    } catch (err) {
      await settlePendingOp(rec.id, 'not_executed').catch(() => undefined)
      showError(pendingErrorMessage(err))
      return
    }
    try {
      const res = await api.refund(input, operator, approvalToken)
      if (!res.ok) {
        await settlePendingOp(rec.id, 'not_executed').catch(() => undefined)
        if (res.error === 'approval_required') {
          if (!res.action || !res.request_hash) {
            showError('管理者承認情報を取得できませんでした。最初からやり直してください。')
            setRefundKey(null)
            return
          }
          setPendingApproval({ kind: 'refund', action: res.action, requestHash: res.request_hash, input })
          return
        }
        showError(res.error === 'approval_expired' ? '承認の有効期限が切れました。最初からやり直してください。' : ginpayErrorMessage(res.error))
        return
      }
      await settlePendingOp(rec.id, 'server_confirmed').catch(() => undefined)
      setReverse(null)
      setRefundKey(null)
      setMessage('返金を記録しました。')
      await load()
    } catch (err) {
      if (isResultUnknown(err)) {
        // 確定した可能性がある。記録を残して返金の画面を閉じ、確認は記録から行う
        await markPendingUnknown(rec.id)
        setReverse(null)
        setLockCheck(null)
      } else {
        await settlePendingOp(rec.id, 'not_executed').catch(() => undefined)
        showError(rpcErrorMessage(err, '返金は確定していません。内容を確認してください。'))
      }
    }
  }

  /** 二重送信を止めて実行する */
  async function exclusive(fn: () => Promise<void>) {
    if (sendingRef.current) return
    sendingRef.current = true
    setLoading(true)
    try {
      await fn()
    } finally {
      sendingRef.current = false
      setLoading(false)
    }
  }

  /**
   * 未解決の操作を確かめる。確定を確認できたときだけ解除する。
   * 業務エラー・見つからない・通信不明では解除しない（先に送った要求が後で確定し得るため）。
   */
  async function checkLock() {
    if (!lockOp) return
    const op = lockOp
    await exclusive(async () => {
      setLockCheck(null)
      const out = await confirmPendingOp(op, { operator: getCurrentOperator(), ginpay: api })
      if (out.status === 'confirmed') {
        if (op.kind === 'ginpay_charge') finishCharge(`${pendingLabel(op)}は確定していました。`)
        else setMessage(`${pendingLabel(op)}は確定していました。`)
        await load()
        return
      }
      if (out.status === 'approval_required') {
        // 同じ内容・同じキーのまま承認へ進む（金額や内容は変えない）
        setPendingApproval({ kind: op.kind === 'ginpay_charge' ? 'charge' : 'refund', action: out.action, requestHash: out.requestHash, input: out.input as ChargePendingInput | RefundPendingInput, continuesOpId: op.id })
        return
      }
      if (out.status === 'operator_required' && !getCurrentOperator()) setShowAuthModal(true)
      setLockCheck({ opId: op.id, outcome: out })
    })
  }

  async function submitCharge() {
    if (locked || !api.chargeStore || !parsedAmount || (needsAccountChoice && !chargeAccount)) return
    if (!confirmingCharge) {
      setConfirmingCharge(true)
      setChargeKey(idempotencyKey('staff-store-charge'))
      setMessage(null)
      return
    }
    const op = getCurrentOperator()
    if (!op) {
      setShowAuthModal(true)
      return
    }
    if (!ensureActor()) return
    const effectiveChargeKey = chargeKey ?? idempotencyKey('staff-store-charge')
    if (!chargeKey) setChargeKey(effectiveChargeKey)
    setMessage(null)
    await exclusive(async () => {
      const accountId = needsAccountChoice ? chargeAccount?.id ?? null : await resolveChargeAccount()
      if (!accountId) return
      const chargeInput: ChargePendingInput = {
        clientId,
        amount: parsedAmount,
        paymentMethod: method,
        memo: memo.trim() || undefined,
        accountId,
        idempotencyKey: effectiveChargeKey,
      }
      await sendCharge(chargeInput, op, null)
    })
  }

  /**
   * チャージ先の口座 ID。サーバーに口座を選ばせず、送る前に1つに決めて記録・送信する（統合後も同じ口座で止めるため）。
   * 有効な口座が無いときは開設（既存があればその口座が返る）してから読み直す。1つに決まらなければ送らない。
   */
  async function resolveChargeAccount(): Promise<string | null> {
    if (activeAccounts.length === 1) return activeAccounts[0].id
    if (activeAccounts.length > 1) { setMessage('チャージする口座を選んでください。'); return null }
    if (!api.openAccount) { setMessage(pendingStoreMessage('account_unknown')); return null }
    try {
      const opened = await api.openAccount(clientId)
      setLedger(opened)
      const active = opened.accounts.filter(a => a.status === 'active')
      if (active.length === 1) return active[0].id
      setMessage(active.length > 1 ? 'チャージする口座を選んでください。' : 'GINPay口座が有効ではないため、チャージできません。')
    } catch (err) {
      setMessage(rpcErrorMessage(err, 'GINPay口座を確認できなかったため、チャージしていません。'))
    }
    return null
  }

  async function submitReverse() {
    if (!reverse || locked) return
    if (!reverse.reason.trim()) {
      setReverse({ ...reverse, error: '理由を入力してください。' })
      return
    }
    let op: OperatorSession | null = null
    if (reverse.kind === 'refund') {
      op = getCurrentOperator()
      if (!op) {
        setShowAuthModal(true)
        return
      }
    }
    if (!ensureActor()) return
    if (reverse.kind === 'refund' && op) {
      const effectiveRefundKey = refundKey ?? idempotencyKey(refundKind === 'hq_ginpay_refund' ? 'hq-refund' : 'staff-refund')
      if (!refundKey) setRefundKey(effectiveRefundKey)
      const input: RefundPendingInput = { transactionId: reverse.transaction.id, accountId: reverse.transaction.account_id, clientId, amount: parseYenInput(reverse.amount) ?? 0, reason: reverse.reason.trim(), idempotencyKey: effectiveRefundKey }
      const operator = op
      await exclusive(() => sendRefund(input, operator, null, reverse))
      return
    }
    await exclusive(async () => {
      try {
        const res = await api.void?.({ transactionId: reverse.transaction.id, reason: reverse.reason.trim() })
        if (!res) return
        if (!res.ok) {
          setReverse({ ...reverse, error: ginpayErrorMessage(res.error) })
          return
        }
        setReverse(null)
        setMessage('取消を記録しました。')
        await load()
      } catch (err) {
        if (isResultUnknown(err)) {
          // 取消は元取引の残りをすべて戻す処理で、2回目は already_reversed になる（二重には戻らない）
          setReverse({ ...reverse, error: '取消の処理結果を確認できませんでした。履歴を読み直して、取消が記録されているか確認してください。' })
          await load()
        } else {
          setReverse({ ...reverse, error: rpcErrorMessage(err, '取消は確定していません。内容を確認してください。') })
        }
      }
    })
  }

  async function handleManagerApproved(approvalToken: string) {
    if (!pendingApproval) return
    const snapshot = pendingApproval
    if (snapshot.continuesOpId) {
      // 結果不明の記録の続き。記録は消さずに、同じ内容・同じキーで承認つきに送る
      await exclusive(async () => {
        // チケット確認と同じガード。保存エラー時は承認待ちの snapshot も破棄しない。
        await runPendingStorageAction(async () => {
          const rec = pendingView.ops.find(o => o.id === snapshot.continuesOpId)
          if (!rec) return
          const op = getCurrentOperator()
          if (!op) {
            setPendingApproval(null)
            setShowAuthModal(true)
            return
          }
          setPendingApproval(null)
          const out = await sendPendingWithApproval(rec, snapshot.input, approvalToken, { operator: op, ginpay: api })
          if (out.status === 'confirmed') {
            if (rec.kind === 'ginpay_charge') finishCharge()
            else setMessage('返金を記録しました。')
            await load()
            return
          }
          if (out.status === 'operator_required') setShowAuthModal(true)
          setLockCheck({ opId: rec.id, outcome: out })
        }).catch(err => { setMessage(pendingErrorMessage(err)) })
      })
      return
    }
    setPendingApproval(null)
    const op = getCurrentOperator()
    if (!op) {
      setShowAuthModal(true)
      return
    }
    if (snapshot.kind === 'charge') await exclusive(() => sendCharge(snapshot.input as ChargePendingInput, op, approvalToken))
    else await exclusive(() => sendRefund(snapshot.input as RefundPendingInput, op, approvalToken, reverse))
  }

  /** 承認する内容。承認のあとに送る入力（pendingApproval.input）そのものから作る（表示専用） */
  function approvalSummaryFor(p: PendingGinpayApproval): ApprovalSummary {
    if (p.kind === 'charge') {
      const input = p.input as ChargePendingInput
      const account = (ledger?.accounts ?? []).find(a => a.id === input.accountId)
      const accountLabel = (ledger?.accounts.length ?? 0) > 1 && account
        ? (account.is_current_client ? '現在の顧客口座' : `${account.client_name ?? '統合元'} の口座`)
        : null
      return chargeApprovalSummary(input, { customerName: ledger?.client_name, accountLabel })
    }
    const input = p.input as RefundPendingInput
    const original = ledger?.transactions.find(t => t.id === input.transactionId)
    return refundApprovalSummary(input, {
      customerName: ledger?.client_name,
      originalLabel: original ? `${GINPAY_TYPE_LABEL[original.type]} ${yen(original.amount)}（${formatDateTime(original.created_at)}）` : null,
    })
  }

  return (
    <section style={{ marginTop: 28, marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, borderBottom: `1px solid ${C.text}`, paddingBottom: 8 }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, color: C.sub }}>GINPay</h2>
        {ledger && <strong style={{ marginLeft: 'auto', fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{yen(ledger.balance)}</strong>}
      </div>

      {/* 未解決の操作（結果不明・別タブで送信中・再読み込み前の送信）。確認が済むまでこの顧客の新しい操作を止める */}
      {notice && (
        <div style={{ padding: '12px 0', borderBottom: `1px solid ${C.line}` }}>
          <PendingOperationNotice notice={notice} onConfirm={lockOp ? () => void checkLock() : undefined} confirming={loading} />
        </div>
      )}

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
                <button type="button" onClick={() => { setChargeOpen(true); setMessage(null) }} disabled={uiLocked} style={{ ...linkStyle, color: uiLocked ? C.mute : linkStyle.color }}>チャージ</button>
              ) : (
                <div style={{ maxWidth: 520 }}>
                  {/* 未解決の操作があるあいだは口座・金額・支払方法・メモを変えられない */}
                  <fieldset disabled={uiLocked} style={{ border: 'none', margin: 0, padding: 0, minWidth: 0, opacity: uiLocked ? 0.6 : 1 }}>
                  {needsAccountChoice && (
                    <Field label="チャージ先">
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {activeAccounts.map((a) => (
                          <button key={a.id} type="button" onClick={() => { setChargeAccountId(a.id); setConfirmingCharge(false) }} style={{
                            minHeight: 44, padding: '0 14px', borderRadius: 8, border: `1px solid ${chargeAccountId === a.id ? C.text : C.lineStrong}`,
                            background: chargeAccountId === a.id ? C.text : C.bg, color: chargeAccountId === a.id ? C.bg : C.text,
                            fontFamily: SANS, fontSize: 14, cursor: 'pointer',
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
                          minHeight: 44, borderRadius: 8, border: `1px solid ${method === m.id ? C.text : C.lineStrong}`,
                          background: method === m.id ? C.text : C.bg, color: method === m.id ? C.bg : C.text,
                          fontFamily: SANS, fontSize: 14, cursor: 'pointer',
                        }}>{m.label}</button>
                      ))}
                    </div>
                  </Field>
                  <Field label="メモ">
                    <input value={memo} onChange={e => setMemo(e.target.value)} maxLength={200} style={inputStyle} />
                  </Field>
                  </fieldset>
                  {confirmingCharge && !uiLocked && (
                    <p style={{ marginTop: 10, fontSize: 14, lineHeight: 1.7 }}>
                      {needsAccountChoice && chargeAccount && !chargeAccount.is_current_client ? `${chargeAccount.client_name ?? '統合元'} の口座` : ledger.client_name ?? 'この顧客'}に {yen(parsedAmount)} をチャージします。内容を確認してください。
                    </p>
                  )}
                  <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                    <SecondaryButton onClick={() => { setChargeOpen(false); setConfirmingCharge(false); setMessage(null) }} disabled={loading}>やめる</SecondaryButton>
                    <PrimaryButton onClick={() => void submitCharge()} disabled={loading || uiLocked || !parsedAmount || (needsAccountChoice && !chargeAccount)} style={{ flex: 2 }}>
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
              <TransactionRow key={tx.id} tx={tx} refundAvailable={!!api.refund && !uiLocked} voidAvailable={!!api.void && !uiLocked} onReverse={r => { if (uiLocked) return; setRefundKey(null); setReverse(r) }} />
            ))}
          </div>
        </>
      )}

      {message && <p style={msgStyle(message.includes('失敗') || message.includes('不足') ? C.danger : C.sub)}>{message}</p>}

      {reverse && (
        <div role="dialog" aria-modal="true" aria-label={reverse.kind === 'refund' ? '返金' : '取消'} style={modalBackdrop}>
          <div style={modalBody}>
            <p style={{ fontSize: 15, fontWeight: 600 }}>{reverse.kind === 'refund' ? '返金を記録' : '取引を取消'}</p>
            <p style={{ marginTop: 6, fontSize: 14, color: C.sub, lineHeight: 1.6 }}>
              元取引：{GINPAY_TYPE_LABEL[reverse.transaction.type]} {yen(reverse.transaction.amount)}
            </p>
            {reverse.kind === 'refund' && (
              <Field label="返金額">
                <input value={reverse.amount} onChange={e => { setReverse({ ...reverse, amount: e.target.value.replace(/[^\d]/g, ''), error: null }); setRefundKey(null) }}
                  inputMode="numeric" style={inputStyle} disabled={loading} />
              </Field>
            )}
            <Field label="理由">
              <input value={reverse.reason} onChange={e => { setReverse({ ...reverse, reason: e.target.value, error: null }); setRefundKey(null) }}
                maxLength={200} style={inputStyle} autoFocus disabled={loading} />
            </Field>
            {reverse.error && <p style={msgStyle(C.danger)}>{reverse.error}</p>}
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <SecondaryButton onClick={() => { setReverse(null); setRefundKey(null) }} disabled={loading}>やめる</SecondaryButton>
              <PrimaryButton danger onClick={() => void submitReverse()} disabled={loading || uiLocked || !reverse.reason.trim() || (reverse.kind === 'refund' && !parseYenInput(reverse.amount))} style={{ flex: 2 }}>
                {loading ? '処理中…' : reverse.kind === 'refund' ? '返金する' : '取消する'}
              </PrimaryButton>
            </div>
          </div>
        </div>
      )}
      {showAuthModal && (
        <OperatorAuthModal
          onSuccess={() => setShowAuthModal(false)}
          onCancel={() => setShowAuthModal(false)}
        />
      )}
      {pendingApproval && !storeFailure && (
        <ManagerApprovalModal
          key={pendingApproval.requestHash}
          action={pendingApproval.action}
          requestHash={pendingApproval.requestHash}
          summary={approvalSummaryFor(pendingApproval)}
          onApproved={handleManagerApproved}
          onCancel={() => {
            // 結果不明の記録の続きなら、記録とキーはそのまま（承認をやめても解除しない）
            if (!pendingApproval.continuesOpId) {
              setRefundKey(null)
              setChargeKey(null)
              setConfirmingCharge(false)
            }
            setPendingApproval(null)
          }}
          onOperatorAuthRequired={() => {
            if (!pendingApproval.continuesOpId) {
              setRefundKey(null)
              setChargeKey(null)
              setConfirmingCharge(false)
            }
            setPendingApproval(null)
            setShowAuthModal(true)
          }}
        />
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

function TransactionRow({ tx, refundAvailable, voidAvailable, onReverse }: {
  tx: GinpayTransaction
  refundAvailable: boolean
  voidAvailable: boolean
  onReverse: (state: ReverseState) => void
}) {
  const amountColor = tx.amount < 0 ? C.text : C.sub
  // 会計に紐付いた取引（会計の支払いと、その取消の戻し）は、会計の取消で会計と一緒に戻す（GINPay 側だけでは戻さない）
  const saleLinked = !!tx.accounting_session_id
  const canRefund = refundAvailable && !saleLinked && tx.status === 'posted' && ((tx.type === 'payment' && tx.amount < 0) || tx.type === 'charge_store')
  const canVoid = voidAvailable && !saleLinked && tx.status === 'posted' && tx.type !== 'void'
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
  marginLeft: 4,
  minHeight: 44,
  minWidth: 44,
  padding: '0 8px',
  border: 'none',
  background: 'transparent',
  color: C.sub,
  fontFamily: SANS,
  fontSize: 14,
  textDecoration: 'underline',
  textUnderlineOffset: 3,
  cursor: 'pointer',
}

function msgStyle(color: string): CSSProperties {
  return { marginTop: 10, fontSize: 14, color, lineHeight: 1.6 }
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
