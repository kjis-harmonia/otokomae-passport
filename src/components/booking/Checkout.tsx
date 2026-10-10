import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { isResultUnknown, rpcErrorMessage } from '../../utils/staffSession'
import { yen } from '../../utils/bookingApi'
import { idempotencyKey } from '../../utils/ginpayApi'
import type { ClientCandidate, CustomerApi } from '../../utils/customerApi'
import {
  checkoutErrorMessage, saleExpectation, saleTotals, TICKET_BLOCK_LABEL,
  type Catalog, type CatalogItem, type CheckoutApi, type CheckoutContext, type PaymentMethod, type Sale, type SaleInput, type SaleLine, type QuoteResult, type QuoteInput,
} from '../../utils/checkoutApi'
import { PrimaryButton } from './ledgerUi'
import { C, SANS, inputStyle, linkStyle } from './ledgerTheme'
import {
  getCurrentOperator,
  isCurrentOperatorValid,
  type OperatorSession,
} from '../../utils/posOperatorSession'
import { OperatorAuthModal } from '../pos/PosAuthModals'
import { ManagerApprovalModal } from '../pos/ManagerApprovalModal'
import { usePendingView } from '../pos/usePendingView'
import {
  beginPendingOp, checkoutTargets, findBlockingOp, isPendingInFlight, markPendingUnknown, pendingBlockMessage, pendingErrorMessage,
  pendingStoreMessage, settlePendingOp, type PendingOp,
} from '../../utils/pendingOps'
import { confirmPendingOp, draftCheckout, unresolvedMessage } from '../../utils/pendingConfirm'


// 会計。予約から開く（顧客・担当・予約メニュー・予約時価格を引き継ぎ、実際の内容に合わせて直せる）／予約なしの店頭会計。
// 「会計を確定」で初めて売上になる（確定は DB の1トランザクション。予約は完了になる）。毎日何十回も使うので、文字と金額だけで構成する。
// GINPay は顧客を選んだ会計だけ。残高は表示用で、足りるかどうかは確定の中で DB が口座をロックして決める。

const METHODS: { id: PaymentMethod; label: string }[] = [
  { id: 'cash', label: '現金' }, { id: 'card', label: 'カード' }, { id: 'qr', label: 'QR等' }, { id: 'ginpay', label: 'GINPay' }, { id: 'other', label: 'その他' },
]
type Line = SaleLine & { key: number }
let keySeq = 0

export function Checkout({ api, customers, reservationId, ensureActor, onClose, onDone }: {
  api: CheckoutApi
  /** 予約なしの会計で顧客を探す */
  customers?: CustomerApi
  /** 予約から開くとき。null は予約なしの店頭会計 */
  reservationId: string | null
  ensureActor: () => boolean
  onClose: () => void
  onDone: (sale: Sale) => void
}) {
  const [ctx, setCtx] = useState<CheckoutContext | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [client, setClient] = useState<{ id: string; name: string } | null | undefined>(undefined)
  const [anonymous, setAnonymous] = useState(false)
  const [stylistId, setStylistId] = useState<string | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [editing, setEditing] = useState<number | null>(null)
  const [ticketIds, setTicketIds] = useState<string[]>([])
  const [manual, setManual] = useState<{ amount: string; label: string } | null>(null)
  const [method, setMethod] = useState<PaymentMethod | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  // 同時クリック対策（state の更新を待たずに2回目の送信・確認を止める）
  const sendingRef = useRef(false)
  const [ginpayAccountId, setGinpayAccountId] = useState<string | null>(null)
  // 会計画面ごとの一意キー（二重タップ・再送で二重会計・二重決済しない）
  const [saleKey] = useState(() => idempotencyKey('checkout'))
  // 未解決の会計は端末の記録（pendingOps）で管理する。画面を閉じても・再読み込みしても残り、
  // 同じ予約・顧客（匿名なら端末のすべて）の新しい会計を止める
  const pendingView = usePendingView()
  const [lockMessage, setLockMessage] = useState<string | null>(null)

  // POS Operator 認証セッション (メモリのみ、画面開始時に未認証なら要求)
  const [operator, setOperator] = useState<OperatorSession | null>(() => getCurrentOperator())
  const [showAuthModal, setShowAuthModal] = useState<boolean>(() => !isCurrentOperatorValid())

  // 予約から：予約の顧客・担当・メニュー・予約時価格を引き継ぐ
  useEffect(() => {
    let alive = true
    api.context(reservationId, null).then(c => {
      if (!alive) return
      setCtx(c)
      if (c.reservation) {
        setStylistId(c.reservation.staff_id)
        setLines(c.reservation.items.map(i => ({ key: ++keySeq, source: 'reservation', ref_id: i.menu_code, name: i.name, category: 'menu', unit_price: i.price ?? 0, quantity: 1, discount: 0 })))
      }
    }).catch(err => { if (alive) setError(rpcErrorMessage(err, '会計の準備ができませんでした。')) })
    return () => { alive = false }
  }, [api, reservationId])

  // 予約なし：選んだ顧客（App 会員ならクーポン）を読み直す
  async function chooseClient(c: ClientCandidate | null) {
    setTicketIds([]); setGinpayAccountId(null)
    if (!c) { setClient(null); setAnonymous(true); setMethod(m => m === 'ginpay' ? null : m); return }
    setAnonymous(false)
    try {
      const x = await api.context(null, c.id)
      setCtx(prev => prev ? { ...prev, client: x.client, tickets: x.tickets, ginpay_accounts: x.ginpay_accounts, ginpay_suspended: x.ginpay_suspended } : x)
      setClient(x.client)
    } catch (err) { setError(rpcErrorMessage(err)) }
  }

  const clientInfo = ctx?.reservation ? ctx.client : client ?? null
  // 止める対象はサーバーが決める顧客で決める。予約の会計は予約の顧客、予約が無い会計は顧客を選んでいても匿名
  const saleTargets = ctx?.reservation ? checkoutTargets({ reservation_id: ctx.reservation.id }, ctx.client?.id ?? null)
    : client || anonymous ? checkoutTargets({ client_id: client?.id }) : []
  const blockingOp = findBlockingOp(pendingView.ops, 'checkout', saleTargets)
  // この画面から送信中の記録は「処理中」。それ以外（結果不明・別タブ・再読み込み前）は確認が済むまで止める
  const lockOp: PendingOp | null = blockingOp && !isPendingInFlight(blockingOp.id) ? blockingOp : null
  const storeFailure = pendingView.failure
  const locked = lockOp !== null || storeFailure !== null
  const tickets = clientInfo ? ctx?.tickets ?? [] : []
  const chosenTickets = tickets.filter(t => ticketIds.includes(t.id))
  const manualAmount = manual ? Math.max(0, parseInt(manual.amount || '0', 10) || 0) : 0
  const localTotals = useMemo(() => saleTotals(lines, chosenTickets, manualAmount), [lines, chosenTickets, manualAmount])
  const [quote, setQuote] = useState<QuoteResult | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)

  // GINPay：顧客の口座
  const ginpayAccounts = clientInfo ? ctx?.ginpay_accounts ?? [] : []
  const ginpayAccount = ginpayAccounts.length === 1 ? ginpayAccounts[0] : ginpayAccounts.find(a => a.id === ginpayAccountId) ?? null

  interface PendingQuoteApproval {
    kind: 'checkout_quote'
    action: string
    requestHash: string
    quoteInput: QuoteInput
    intentGen: number
  }
  interface ApprovedCheckoutSnapshot {
    quoteInput: QuoteInput
    items: SaleLine[]
    ticketIds: string[]
    manualDiscount?: { amount: number; label: string }
    reservationId?: string
    clientId?: string
    stylistId: string
    paymentMethod: PaymentMethod
    ginpayAccountId?: string | null
    expectedTotal: number
    quoteHash?: string
    saleKey: string
    businessIntentKey: string
  }
  const [pendingApproval, setPendingApproval] = useState<PendingQuoteApproval | null>(null)
  const [showManagerModal, setShowManagerModal] = useState(false)
  const [approvedToken, setApprovedToken] = useState<string | null>(null)
  const [approvedSnapshot, setApprovedSnapshot] = useState<ApprovedCheckoutSnapshot | null>(null)
  const [needsFreshQuote, setNeedsFreshQuote] = useState(false)

  const businessIntentKey = useMemo(() => JSON.stringify({
    reservation_id: ctx?.reservation?.id,
    client_id: ctx?.reservation ? undefined : client?.id,
    stylist_id: stylistId,
    items: lines.map(l => ({ source: l.source, ref_id: l.ref_id, name: l.name, category: l.category, quantity: l.quantity, unit_price: l.unit_price, discount: l.discount })),
    ticket_ids: ticketIds,
    manual_discount: manualAmount > 0 && manual ? { amount: manualAmount, label: manual.label.trim() } : undefined,
    payment_method: method,
    ginpay_account_id: method === 'ginpay' ? (ginpayAccountId ?? ginpayAccount?.id) : undefined,
  }), [ctx?.reservation?.id, ctx?.reservation, client?.id, stylistId, lines, ticketIds, manualAmount, manual, method, ginpayAccountId, ginpayAccount?.id])

  const needsFreshQuoteRef = useRef(needsFreshQuote)
  needsFreshQuoteRef.current = needsFreshQuote

  const quoteIntentGenRef = useRef(0)
  const lastBusinessIntentKeyRef = useRef(businessIntentKey)

  useEffect(() => {
    const current = getCurrentOperator()
    const isIntentChange = lastBusinessIntentKeyRef.current !== businessIntentKey
    if (isIntentChange) {
      lastBusinessIntentKeyRef.current = businessIntentKey
      quoteIntentGenRef.current += 1
    }
    const gen = quoteIntentGenRef.current

    if (isIntentChange) {
      setApprovedToken(null)
      setApprovedSnapshot(null)
      setPendingApproval(null)
      setQuote(null)
      setQuoteError(null)
      setQuoteLoading(false)

      if (needsFreshQuoteRef.current) {
        // 追加条件1: needsFreshQuote === true の場合、自動quoteを開始せず手動再取得を待つ
        return
      }
    }

    if (!ctx || lines.length === 0 || !current) {
      if (!current && operator) setOperator(null)
      setQuote(null)
      setQuoteError(null)
      setQuoteLoading(false)
      setApprovedToken(null)
      setApprovedSnapshot(null)
      setPendingApproval(null)
      setNeedsFreshQuote(false)
      return
    }

    if (needsFreshQuoteRef.current) {
      setQuoteLoading(false)
      return
    }

    let alive = true
    setQuoteLoading(true)
    setQuoteError(null)
    const quoteInput: QuoteInput = {
      reservation_id: ctx.reservation?.id,
      client_id: ctx.reservation ? undefined : client?.id,
      items: lines.map(l => ({ source: l.source, ref_id: l.ref_id, name: l.name, category: l.category, quantity: l.quantity, unit_price: l.unit_price })),
      ticket_ids: ticketIds,
      manual_discount: manualAmount > 0 && manual ? { amount: manualAmount, label: manual.label.trim() } : undefined,
    }
    api.quote(quoteInput, current).then(res => {
      if (!alive || gen !== quoteIntentGenRef.current) return
      setQuoteLoading(false)
      if ('error' in res) {
        setQuote(null)
        setApprovedSnapshot(null)
        if (
          res.error === 'operator_session_invalid' ||
          res.error === 'invalid_operator_session' ||
          res.error === 'operator_session_expired' ||
          res.error === 'staff_auth_required'
        ) {
          setOperator(null)
          setShowAuthModal(true)
        }
        if (res.error === 'approval_required') {
          if (!res.action || !res.request_hash) {
            setPendingApproval(null)
            setQuoteError('管理者承認情報を取得できませんでした。最初からやり直してください。')
            setNeedsFreshQuote(true)
            return
          }
          setPendingApproval({
            kind: 'checkout_quote',
            action: res.action,
            requestHash: res.request_hash,
            quoteInput,
            intentGen: gen,
          })
          setNeedsFreshQuote(false)
          setQuoteError('この操作には管理者承認が必要です。')
        } else {
          setPendingApproval(null)
          setNeedsFreshQuote(true)
          setQuoteError(checkoutErrorMessage(res.error))
        }
      } else {
        setQuote(res)
        setQuoteError(null)
        setPendingApproval(null)
        setApprovedSnapshot(null)
        setNeedsFreshQuote(false)
      }
    }).catch(() => {
      if (!alive || gen !== quoteIntentGenRef.current) return
      setQuoteLoading(false)
      setQuote(null)
      setPendingApproval(null)
      setApprovedSnapshot(null)
      setNeedsFreshQuote(true)
      setQuoteError('最新の見積もり計算に失敗しました')
    })
    return () => { alive = false }
  }, [api, businessIntentKey, operator])

  async function handleManagerApproved(token: string) {
    setShowManagerModal(false)
    if (!pendingApproval) return
    const current = getCurrentOperator()
    if (!current || !isCurrentOperatorValid()) {
      setOperator(null)
      setShowAuthModal(true)
      setPendingApproval(null)
      return
    }

    if (pendingApproval.intentGen !== quoteIntentGenRef.current) {
      setQuoteError('承認待ちの間に入力内容が変更されました。見積もりを再取得してください。')
      setPendingApproval(null)
      return
    }

    const snapshot = pendingApproval
    setPendingApproval(null)
    setQuoteLoading(true)
    setQuoteError(null)
    const gen = quoteIntentGenRef.current
    try {
      const replayQuoteRes = await api.quote(snapshot.quoteInput, current, token)
      if (gen !== quoteIntentGenRef.current) return

      if ('error' in replayQuoteRes) {
        if (gen !== quoteIntentGenRef.current) return
        setQuote(null)
        setApprovedToken(null)
        setApprovedSnapshot(null)
        setPendingApproval(null)
        setNeedsFreshQuote(true)
        if (
          replayQuoteRes.error === 'operator_session_invalid' ||
          replayQuoteRes.error === 'invalid_operator_session' ||
          replayQuoteRes.error === 'operator_session_expired' ||
          replayQuoteRes.error === 'staff_auth_required'
        ) {
          setOperator(null)
          setShowAuthModal(true)
        }
        if (replayQuoteRes.error === 'approval_expired') {
          setQuoteError('承認の有効期限が切れました。見積もりを再取得してください。')
        } else if (replayQuoteRes.error === 'approval_required') {
          setQuoteError('管理者承認の検証に失敗しました。見積もりを再取得してください。')
        } else if (replayQuoteRes.error === 'quote_mismatch') {
          setQuoteError('価格または条件が更新されました。見積もりを再取得してください。')
        } else {
          setQuoteError(checkoutErrorMessage(replayQuoteRes.error))
        }
        return
      }

      setQuote(replayQuoteRes)
      setApprovedToken(token)
      setApprovedSnapshot({
        quoteInput: snapshot.quoteInput,
        items: lines.map(l => ({
          source: l.source,
          ref_id: l.ref_id,
          name: l.name,
          category: l.category,
          unit_price: l.unit_price,
          quantity: l.quantity,
          discount: l.discount,
        })),
        ticketIds: [...ticketIds],
        manualDiscount: manualAmount > 0 && manual ? { amount: manualAmount, label: manual.label.trim() } : undefined,
        reservationId: ctx?.reservation?.id,
        clientId: ctx?.reservation ? undefined : client?.id,
        stylistId: stylistId ?? '',
        paymentMethod: method ?? 'cash',
        ginpayAccountId: method === 'ginpay' ? (ginpayAccountId ?? ginpayAccount?.id) : undefined,
        expectedTotal: replayQuoteRes.total,
        quoteHash: replayQuoteRes.quote_hash,
        saleKey,
        businessIntentKey,
      })
      setNeedsFreshQuote(false)
      setQuoteError(null)
    } catch {
      if (gen !== quoteIntentGenRef.current) return
      setQuote(null)
      setApprovedToken(null)
      setApprovedSnapshot(null)
      setPendingApproval(null)
      setNeedsFreshQuote(true)
      setQuoteError('最新の見積もり計算に失敗しました。見積もりを再取得してください。')
    } finally {
      if (gen === quoteIntentGenRef.current) {
        setQuoteLoading(false)
      }
    }
  }

  async function fetchFreshQuote() {
    const current = getCurrentOperator()
    if (!current || !isCurrentOperatorValid()) {
      setOperator(null)
      setShowAuthModal(true)
      return
    }
    if (!ctx || lines.length === 0 || quoteLoading) return

    setApprovedToken(null)
    setApprovedSnapshot(null)
    setPendingApproval(null)
    setQuoteLoading(true)
    setQuoteError(null)
    setError(null)
    const gen = quoteIntentGenRef.current
    const quoteInput: QuoteInput = {
      reservation_id: ctx.reservation?.id,
      client_id: ctx.reservation ? undefined : client?.id,
      items: lines.map(l => ({ source: l.source, ref_id: l.ref_id, name: l.name, category: l.category, quantity: l.quantity, unit_price: l.unit_price })),
      ticket_ids: ticketIds,
      manual_discount: manualAmount > 0 && manual ? { amount: manualAmount, label: manual.label.trim() } : undefined,
    }
    try {
      const res = await api.quote(quoteInput, current)
      if (gen !== quoteIntentGenRef.current) return
      if ('error' in res) {
        setQuote(null)
        setApprovedSnapshot(null)
        if (
          res.error === 'operator_session_invalid' ||
          res.error === 'invalid_operator_session' ||
          res.error === 'operator_session_expired' ||
          res.error === 'staff_auth_required'
        ) {
          setOperator(null)
          setShowAuthModal(true)
        }
        if (res.error === 'approval_required') {
          if (!res.action || !res.request_hash) {
            setPendingApproval(null)
            setQuoteError('管理者承認情報を取得できませんでした。最初からやり直してください。')
            return
          }
          setPendingApproval({
            kind: 'checkout_quote',
            action: res.action,
            requestHash: res.request_hash,
            quoteInput,
            intentGen: gen,
          })
          setNeedsFreshQuote(false)
          setQuoteError('この操作には管理者承認が必要です。')
        } else {
          setPendingApproval(null)
          setQuoteError(checkoutErrorMessage(res.error))
        }
      } else {
        setQuote(res)
        setQuoteError(null)
        setPendingApproval(null)
        setApprovedSnapshot(null)
        setNeedsFreshQuote(false)
      }
    } catch {
      if (gen !== quoteIntentGenRef.current) return
      setQuote(null)
      setPendingApproval(null)
      setApprovedSnapshot(null)
      setQuoteError('最新の見積もり計算に失敗しました。再度お試しください。')
    } finally {
      if (gen === quoteIntentGenRef.current) {
        setQuoteLoading(false)
      }
    }
  }

  const totals = useMemo(() => {
    if (quote) return { subtotal: quote.subtotal, discount: quote.discount_total, total: quote.total }
    return localTotals
  }, [quote, localTotals])

  const paid = !!ctx?.paid_sale_id
  const customerReady = !!ctx?.reservation || anonymous || !!client
  // 残高は台帳合計。台帳と一致しない口座では支払えない（DB 側でも止める）
  const ginpayMismatch = method === 'ginpay' && !!ginpayAccount && !ginpayAccount.consistent
  const ginpayShort = method === 'ginpay' && !!ginpayAccount && ginpayAccount.balance < totals.total
  const ginpayOk = method !== 'ginpay' || (!!ginpayAccount && totals.total > 0 && !ginpayShort && !ginpayMismatch)
  const canConfirm = !!ctx && !paid && customerReady && !!stylistId && lines.length > 0 && !!method && totals.total >= 0
    && (!manual || manualAmount === 0 || manual.label.trim() !== '') && ginpayOk && !busy && !!quote && !quoteLoading && !quoteError && !needsFreshQuote && !locked

  function update(key: number, patch: Partial<SaleLine>) { setLines(ls => ls.map(l => l.key === key ? { ...l, ...patch } : l)) }
  function addItem(src: SaleLine['source'], item: CatalogItem) {
    setLines(ls => [...ls, { key: ++keySeq, source: src, ref_id: item.id, name: item.name, category: item.category, unit_price: item.price, quantity: 1, discount: 0 }])
    setAdding(false)
  }
  function toggleTicket(id: string, type: string) {
    // 違う種類は一緒に使えない（同じ種類は複数枚可）
    setTicketIds(ids => ids.includes(id) ? ids.filter(x => x !== id)
      : [...ids.filter(x => tickets.find(t => t.id === x)?.type === type), id])
  }

  async function confirm() {
    if (!ctx || !stylistId || !method || locked || busy || sendingRef.current || !ensureActor()) return
    const current = getCurrentOperator()
    if (!current) {
      setOperator(null)
      setShowAuthModal(true)
      return
    }

    // 追加条件3: approvedToken / approvedSnapshot pair integrity guard
    const hasApprovedToken = approvedToken != null
    const hasApprovedSnapshot = approvedSnapshot != null
    if (hasApprovedToken !== hasApprovedSnapshot) {
      setApprovedToken(null)
      setApprovedSnapshot(null)
      setPendingApproval(null)
      setQuote(null)
      setQuoteLoading(false)
      setNeedsFreshQuote(true)
      setError('承認情報に不整合があるため、見積もりを再取得してください。')
      return
    }

    // 承認済みflow: businessIntentKey 完全一致guard
    if (hasApprovedToken && hasApprovedSnapshot) {
      if (approvedSnapshot.businessIntentKey !== businessIntentKey) {
        setApprovedToken(null)
        setApprovedSnapshot(null)
        setPendingApproval(null)
        setQuote(null)
        setQuoteLoading(false)
        setNeedsFreshQuote(true)
        setError('会計内容が変更されたため、見積もりを再取得してください。')
        return
      }
    }

    sendingRef.current = true
    setBusy(true); setError(null)
    const isApprovedFlow = Boolean(approvedToken && approvedSnapshot)
    const itemsToFinalize: SaleLine[] = (isApprovedFlow && approvedSnapshot)
      ? approvedSnapshot.items
      : lines.map(l => ({ source: l.source, ref_id: l.ref_id, name: l.name, category: l.category, unit_price: l.unit_price, quantity: l.quantity, discount: l.discount }))
    // 送る内容をそのまま固定する（結果不明のときは、この内容と同じキーでだけ確認する）
    const input: SaleInput = {
      reservation_id: (approvedToken && approvedSnapshot) ? approvedSnapshot.reservationId : ctx.reservation?.id,
      client_id: (approvedToken && approvedSnapshot) ? approvedSnapshot.clientId : (ctx.reservation ? undefined : client?.id),
      stylist_id: (approvedToken && approvedSnapshot) ? approvedSnapshot.stylistId : stylistId,
      items: itemsToFinalize,
      ticket_ids: (approvedToken && approvedSnapshot) ? approvedSnapshot.ticketIds : ticketIds,
      manual_discount: (approvedToken && approvedSnapshot) ? approvedSnapshot.manualDiscount : (manualAmount > 0 && manual ? { amount: manualAmount, label: manual.label.trim() } : undefined),
      payment_method: (approvedToken && approvedSnapshot) ? approvedSnapshot.paymentMethod : method,
      expected_total: (approvedToken && approvedSnapshot) ? approvedSnapshot.expectedTotal : totals.total,
      idempotency_key: (approvedToken && approvedSnapshot) ? approvedSnapshot.saleKey : saleKey,
      quote_hash: (approvedToken && approvedSnapshot) ? approvedSnapshot.quoteHash : quote?.quote_hash,
      ginpay_account_id: (approvedToken && approvedSnapshot) ? (approvedSnapshot.ginpayAccountId ?? undefined) : (method === 'ginpay' ? ginpayAccount?.id : undefined),
    }
    // 予約の会計は、この画面が読んだ予約の顧客（client_root）で記録・照合する。予約が画面と食い違えば顧客不明（匿名として止める）
    const reservationClientId = input.reservation_id && input.reservation_id === ctx.reservation?.id ? (ctx.client?.id ?? null) : undefined
    const expect = saleExpectation(input, reservationClientId)
    // 送信の前に端末へ記録する（承認・操作者トークンと見積もりハッシュは保存しない）。記録できなければ送信しない
    let op: PendingOp
    try {
      op = await beginPendingOp(draftCheckout(input, current, reservationClientId), input, [input.quote_hash, approvedToken, current.operatorToken])
    } catch (err) {
      setError(pendingErrorMessage(err))
      sendingRef.current = false
      setBusy(false)
      return
    }
    try {
      const res = await api.finalize(input, current, approvedToken, expect)
      if ('error' in res) {
        // この送信が業務エラーで返った＝この会計は実行されていない
        await settlePendingOp(op.id, 'not_executed').catch(() => undefined)
        if (
          res.error === 'operator_session_invalid' ||
          res.error === 'invalid_operator_session' ||
          res.error === 'operator_session_expired' ||
          res.error === 'staff_auth_required'
        ) {
          setOperator(null)
          setShowAuthModal(true)
        }
        if (
          res.error === 'approval_required' ||
          res.error === 'approval_expired' ||
          res.error === 'already_consumed' ||
          res.error === 'request_hash_mismatch' ||
          res.error === 'action_mismatch' ||
          res.error === 'quote_mismatch' ||
          res.error === 'idempotency_conflict'
        ) {
          setApprovedToken(null)
          setApprovedSnapshot(null)
          setQuote(null)
          setPendingApproval(null)
          setNeedsFreshQuote(true)
        }
        if (res.error === 'approval_required') {
          setError('管理者承認が必要です。見積もりを再取得してください。')
        } else if (res.error === 'approval_expired') {
          setError('承認の有効期限が切れました。見積もりを再取得してください。')
        } else if (res.error === 'quote_mismatch') {
          setError('価格または条件が更新されました。見積もりを再取得してください。')
        } else {
          setError(checkoutErrorMessage(res.error))
        }
      } else {
        await settlePendingOp(op.id, 'server_confirmed').catch(() => undefined)
        setApprovedToken(null)
        setApprovedSnapshot(null)
        onDone(res)
      }
    } catch (err) {
      if (isResultUnknown(err)) {
        // 会計が確定した可能性がある。記録を「結果不明」にして残し、承認トークンは破棄する（確認は承認なしで行う）
        await markPendingUnknown(op.id)
        setApprovedToken(null)
        setApprovedSnapshot(null)
        setPendingApproval(null)
        setLockMessage(null)
      } else {
        // サーバーが処理せずに拒否した（rollback 済み）。会計は確定していない
        await settlePendingOp(op.id, 'not_executed').catch(() => undefined)
        setError(rpcErrorMessage(err, '会計は確定していません。内容を確認してください。'))
      }
    } finally {
      sendingRef.current = false
      setBusy(false)
    }
  }

  /**
   * 未解決の会計を確かめる（同じ内容・同じキーの再送。確定済みなら同じ会計が返る）。
   * 業務エラー・通信不明では解除しない（先に送った要求が後で確定し得るため）。
   */
  async function checkLock() {
    if (!lockOp || busy || sendingRef.current) return
    sendingRef.current = true
    setBusy(true); setError(null); setLockMessage(null)
    try {
      const out = await confirmPendingOp(lockOp, { operator: getCurrentOperator(), checkout: api })
      if (out.status === 'confirmed') {
        // この画面が送った会計（同じキー）なら、その会計で完了する。別の会計（前の匿名会計など）なら、この会計を続けられる
        if (lockOp.key === saleKey) onDone(out.value as Sale)
        else setLockMessage('前の会計は確定していました。この会計を続けられます。')
        return
      }
      if (out.status === 'operator_required' && !getCurrentOperator()) {
        setOperator(null)
        setShowAuthModal(true)
      }
      setLockMessage(unresolvedMessage(out))
    } finally {
      sendingRef.current = false
      setBusy(false)
    }
  }

  function requestClose() {
    // 送信中は閉じない。結果不明の会計は端末に記録されているので、閉じても新しい会計にはならない
    if (busy) return
    onClose()
  }


  return (
    <div role="dialog" aria-modal="true" aria-label="会計" style={{ position: 'fixed', inset: 0, zIndex: 950, background: C.bg, color: C.text, fontFamily: SANS, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 16px', borderBottom: `1px solid ${C.line}` }}>
        <button type="button" onClick={requestClose} disabled={busy} style={{ ...linkStyle, textDecoration: 'none', color: busy ? C.mute : C.text, fontSize: 15 }}>‹ 戻る</button>
        <span style={{ fontSize: 13, color: C.mute }}>{ctx?.reservation ? '会計' : '店頭会計'}</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: 640, margin: '0 auto', padding: '20px 20px 24px' }}>
          {!ctx ? <p style={{ fontSize: 14, color: error ? C.danger : C.sub }}>{error ?? '読み込み中…'}</p> : (
            // 結果不明のあいだは内容を変えられない（保持した内容と同じもので確認するため）
            <fieldset disabled={locked} style={{ border: 'none', margin: 0, padding: 0, minWidth: 0, opacity: locked ? 0.6 : 1 }}>
              {/* お客様・担当 */}
              {ctx.reservation || clientInfo || anonymous ? (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                  <h1 style={{ fontSize: 22, fontWeight: 600 }}>{clientInfo?.name ?? ctx.reservation?.customer_name ?? '匿名'}</h1>
                  {!ctx.reservation && <button type="button" onClick={() => { setClient(undefined); setAnonymous(false); setTicketIds([]); setGinpayAccountId(null); setMethod(m => m === 'ginpay' ? null : m) }} style={{ ...linkStyle, minHeight: 32, marginLeft: 'auto' }}>変更</button>}
                </div>
              ) : customers ? <ClientPicker customers={customers} onPick={c => void chooseClient(c)} /> : null}
              {paid && <p style={{ marginTop: 8, fontSize: 14, color: C.danger }}>この予約はすでに会計済みです。</p>}

              <Row label="担当">
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {ctx.staff.map(s => <Choice key={s.id} on={stylistId === s.id} onClick={() => setStylistId(s.id)}>{s.name}</Choice>)}
                </span>
              </Row>

              {/* 明細 */}
              <div style={{ marginTop: 16, borderTop: `1px solid ${C.text}` }}>
                {lines.length === 0 && <p style={{ padding: '14px 0', fontSize: 14, color: C.mute }}>メニュー・商品を追加してください</p>}
                {lines.map(l => (
                  <div key={l.key} style={{ borderBottom: `1px solid ${C.line}` }}>
                    <button type="button" onClick={() => setEditing(editing === l.key ? null : l.key)} aria-expanded={editing === l.key}
                      style={{ ...lineBtn, borderBottom: 'none' }}>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 15 }}>{l.name}{l.quantity > 1 ? <span style={{ color: C.sub }}>{` ×${l.quantity}`}</span> : null}</span>
                        {(l.quantity > 1 || l.discount > 0) && (
                          <span style={{ display: 'block', fontSize: 12, color: C.mute, marginTop: 2 }}>
                            {l.quantity > 1 ? `単価 ${yen(l.unit_price)}` : ''}{l.discount > 0 ? `${l.quantity > 1 ? '・' : ''}値引き −${yen(l.discount)}` : ''}
                          </span>
                        )}
                      </span>
                      <span style={{ fontSize: 15, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{yen(l.unit_price * l.quantity - l.discount)}</span>
                    </button>
                    {editing === l.key && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, padding: '0 0 14px' }}>
                        <Num label="単価" value={l.unit_price} onChange={v => update(l.key, { unit_price: v })} />
                        <label style={{ display: 'block' }}>
                          <span style={smallLabel}>数量</span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Step onClick={() => update(l.key, { quantity: Math.max(1, l.quantity - 1), discount: Math.min(l.discount, l.unit_price * Math.max(1, l.quantity - 1)) })}>−</Step>
                            <span style={{ minWidth: 28, textAlign: 'center', fontSize: 16, fontVariantNumeric: 'tabular-nums' }}>{l.quantity}</span>
                            <Step onClick={() => update(l.key, { quantity: Math.min(99, l.quantity + 1) })}>＋</Step>
                          </span>
                        </label>
                        <Num label="値引き" value={l.discount} onChange={v => update(l.key, { discount: Math.min(v, l.unit_price * l.quantity) })} />
                        <span style={{ display: 'flex', alignItems: 'flex-end' }}>
                          <button type="button" onClick={() => { setLines(ls => ls.filter(x => x.key !== l.key)); setEditing(null) }} style={{ ...linkStyle, color: C.danger }}>削除</button>
                        </span>
                      </div>
                    )}
                  </div>
                ))}
                {adding ? <ItemPicker api={api} onPick={addItem} onClose={() => setAdding(false)} />
                  : <button type="button" onClick={() => setAdding(true)} style={{ ...linkStyle, color: C.text }}>＋ メニュー・商品を追加</button>}
              </div>

              {/* クーポン（App 会員）・値引き */}
              {tickets.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {tickets.map(t => {
                    const on = ticketIds.includes(t.id)
                    return (
                      <button key={t.id} type="button" disabled={!!t.blocked} onClick={() => toggleTicket(t.id, t.type)} aria-pressed={on} style={{ ...lineBtn, opacity: t.blocked ? 0.55 : 1, cursor: t.blocked ? 'default' : 'pointer' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                          <span aria-hidden="true" style={{ width: 18, height: 18, flexShrink: 0, boxSizing: 'border-box', borderRadius: 4, border: `1.5px solid ${on ? C.text : C.lineStrong}`, background: on ? C.text : 'transparent', color: C.bg, fontSize: 13, lineHeight: '15px', textAlign: 'center', fontWeight: 700 }}>{on ? '✓' : ''}</span>
                          <span style={{ fontSize: 14 }}>{t.title}{t.blocked && <span style={{ fontSize: 12, color: C.mute }}>{` ${TICKET_BLOCK_LABEL[t.blocked]}`}</span>}</span>
                        </span>
                        <span style={{ fontSize: 14, color: C.sub, fontVariantNumeric: 'tabular-nums' }}>{t.amount ? `−${yen(t.amount)}` : ''}</span>
                      </button>
                    )
                  })}
                </div>
              )}
              {manual ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px auto', gap: 10, alignItems: 'end', padding: '10px 0', borderBottom: `1px solid ${C.line}` }}>
                  <label><span style={smallLabel}>値引きの理由</span><input value={manual.label} onChange={e => setManual({ ...manual, label: e.target.value })} maxLength={40} style={inputStyle} /></label>
                  <label><span style={smallLabel}>金額</span><input value={manual.amount} onChange={e => setManual({ ...manual, amount: e.target.value.replace(/\D/g, '') })} inputMode="numeric" style={inputStyle} /></label>
                  <button type="button" onClick={() => setManual(null)} style={linkStyle}>外す</button>
                </div>
              ) : <button type="button" onClick={() => setManual({ amount: '', label: '' })} style={{ ...linkStyle, display: 'flex' }}>値引きを入力</button>}

              {/* 合計 */}
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.text}` }}>
                {totals.discount > 0 && (
                  <>
                    <Sum label="小計" value={yen(totals.subtotal)} />
                    <Sum label="値引き" value={`−${yen(totals.discount)}`} />
                  </>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 }}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>お支払い</span>
                  <span style={{ fontSize: 24, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: totals.total < 0 ? C.danger : C.text }}>{yen(totals.total)}</span>
                </div>
              </div>

              <Row label="支払方法">
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {METHODS.filter(m => m.id !== 'ginpay' || !!clientInfo).map(m => <Choice key={m.id} on={method === m.id} onClick={() => setMethod(m.id)}>{m.label}</Choice>)}
                </span>
              </Row>
              {method === 'ginpay' && (
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
                  {ginpayAccounts.length === 0 ? (
                    <p style={{ fontSize: 14, color: C.sub, lineHeight: 1.7 }}>{ctx.ginpay_suspended ? 'GINPay口座が停止中のため支払えません。' : 'GINPay口座がありません。顧客台帳のGINPayで口座を開設・チャージしてから会計してください。'}</p>
                  ) : (
                    <>
                      {ginpayAccounts.length > 1 && (
                        <div style={{ marginBottom: 8 }}>
                          <p style={smallLabel}>支払う口座</p>
                          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {ginpayAccounts.map(a => (
                              <Choice key={a.id} on={ginpayAccountId === a.id} onClick={() => setGinpayAccountId(a.id)}>{`${a.is_current_client ? '本人の口座' : `統合元 ${a.client_name}`} ${yen(a.balance)}`}</Choice>
                            ))}
                          </span>
                        </div>
                      )}
                      {ginpayAccount && !ginpayAccount.consistent && (
                        <p style={{ fontSize: 14, color: C.danger, lineHeight: 1.7 }}>この口座は残高の照合が取れていないため支払えません。本部に連絡してください。</p>
                      )}
                      {ginpayAccount && ginpayAccount.consistent && (
                        <>
                          <Sum label="現在の残高" value={yen(ginpayAccount.balance)} />
                          <Sum label="今回のお支払い" value={`−${yen(Math.max(0, totals.total))}`} />
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, lineHeight: 1.9, color: ginpayAccount.balance < totals.total ? C.danger : C.text }}>
                            <span>支払後の残高</span>
                            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{ginpayAccount.balance < totals.total ? '残高が不足しています' : yen(ginpayAccount.balance - totals.total)}</span>
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
              {error && <p style={{ marginTop: 12, fontSize: 14, color: C.danger }}>{error}</p>}
            </fieldset>
          )}
        </div>
      </div>
      {ctx && (
        <div style={{ flexShrink: 0, padding: '12px 20px calc(12px + env(safe-area-inset-bottom, 0px))', borderTop: `1px solid ${C.line}` }}>
          <div style={{ maxWidth: 640, margin: '0 auto' }}>
            {storeFailure ? (
              <p role="status" style={{ margin: 0, fontSize: 14, lineHeight: 1.7, color: C.danger }}>{pendingStoreMessage(storeFailure)}</p>
            ) : lockOp ? (
              <>
                <p role="status" style={{ margin: '0 0 10px', fontSize: 14, lineHeight: 1.7, color: C.text }}>
                  {pendingBlockMessage(lockOp)}
                  {lockMessage && <span style={{ display: 'block', marginTop: 4, color: C.danger }}>{lockMessage}</span>}
                </p>
                <PrimaryButton onClick={() => void checkLock()} disabled={busy}>{busy ? '確認中…' : '結果を確認'}</PrimaryButton>
              </>
            ) : (<>
            {lockMessage && <p role="status" style={{ margin: '0 0 8px', fontSize: 13, color: C.sub }}>{lockMessage}</p>}
            {quoteError && <p style={{ margin: '0 0 8px', fontSize: 13, color: C.danger }}>{quoteError}</p>}
            {needsFreshQuote && !quoteLoading && (
              <button
                type="button"
                onClick={() => void fetchFreshQuote()}
                style={{
                  width: '100%',
                  minHeight: 44,
                  marginBottom: 8,
                  padding: '10px 16px',
                  borderRadius: 10,
                  background: 'rgba(255,255,255,0.08)',
                  border: `1.5px solid ${C.lineStrong}`,
                  color: C.text,
                  fontWeight: 600,
                  fontSize: 14,
                  cursor: 'pointer',
                }}
              >
                見積もりを再取得
              </button>
            )}
            {pendingApproval && !quoteLoading && (
              <button
                type="button"
                onClick={() => setShowManagerModal(true)}
                style={{
                  width: '100%',
                  minHeight: 44,
                  marginBottom: 8,
                  padding: '10px 16px',
                  borderRadius: 10,
                  background: 'linear-gradient(135deg, #C9A24A 0%, #9E7D2B 100%)',
                  border: 'none',
                  color: '#0B0403',
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: 'pointer',
                }}
              >
                管理者承認を入力
              </button>
            )}
            <PrimaryButton onClick={() => void confirm()} disabled={!canConfirm}>{busy ? '確定中…' : quoteLoading ? '計算中…' : needsFreshQuote ? '見積もりの再取得が必要です' : quoteError ? '見積もりエラー' : !quote && lines.length > 0 ? '見積もり未取得' : ginpayMismatch ? 'GINPayは利用できません' : ginpayShort ? 'GINPayの残高が不足しています' : `会計を確定 ${yen(Math.max(0, totals.total))}`}</PrimaryButton>
            </>)}
          </div>
        </div>
      )}
      {showAuthModal && (
        <OperatorAuthModal
          onSuccess={op => {
            setOperator(op)
            setShowAuthModal(false)
          }}
          onCancel={() => {
            // 結果確認中に認証を取りやめても、会計画面は閉じない
            if (lockOp) setShowAuthModal(false)
            else onClose()
          }}
        />
      )}
      {showManagerModal && pendingApproval && (
        <ManagerApprovalModal
          action={pendingApproval.action}
          requestHash={pendingApproval.requestHash}
          onApproved={handleManagerApproved}
          onCancel={() => {
            setShowManagerModal(false)
            setPendingApproval(null)
          }}
          onOperatorAuthRequired={() => {
            setShowManagerModal(false)
            setPendingApproval(null)
            setOperator(null)
            setShowAuthModal(true)
          }}
        />
      )}
    </div>
  )
}

/** 予約なしの会計：顧客を探して選ぶ／匿名（名前だけで既存の顧客に紐付けない） */
function ClientPicker({ customers, onPick }: { customers: CustomerApi; onPick: (c: ClientCandidate | null) => void }) {
  const [q, setQ] = useState('')
  const [found, setFound] = useState<ClientCandidate[]>([])
  useEffect(() => {
    let alive = true
    const t = window.setTimeout(() => {
      if (q.trim().length < 2) { setFound([]); return }
      customers.candidates(null, q.trim()).then(x => { if (alive) setFound(x.slice(0, 6)) }).catch(() => { if (alive) setFound([]) })
    }, 250)
    return () => { alive = false; window.clearTimeout(t) }
  }, [customers, q])
  return (
    <div>
      <p style={{ fontSize: 13, color: C.sub }}>お客様</p>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="氏名・電話番号で探す" aria-label="顧客を探す" style={{ ...inputStyle, marginTop: 6 }} autoComplete="off" />
      {found.map(k => (
        <button key={k.id} type="button" onClick={() => onPick(k)} style={lineBtn}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{k.name}</span>
          <span style={{ fontSize: 12, color: C.mute }}>{[k.phone, `来店${k.visit_count}回`, k.app_linked ? 'App連携' : null].filter(Boolean).join('・')}</span>
        </button>
      ))}
      <button type="button" onClick={() => onPick(null)} style={{ ...linkStyle, marginTop: 4 }}>顧客を選ばずに会計（匿名）</button>
    </div>
  )
}

/** メニュー・商品の追加（予約メニュー・会計メニュー／オプション・店販・手入力） */
function ItemPicker({ api, onPick, onClose }: { api: CheckoutApi; onPick: (src: SaleLine['source'], item: CatalogItem) => void; onClose: () => void }) {
  const [cat, setCat] = useState<Catalog | null>(null)
  const [q, setQ] = useState('')
  const [manual, setManual] = useState({ name: '', price: '', category: 'menu' as CatalogItem['category'] })
  useEffect(() => { api.catalog().then(setCat).catch(() => setCat({ service_menus: [], menus: [], products: [] })) }, [api])
  const match = (i: CatalogItem) => !q.trim() || i.name.includes(q.trim())
  // 正規サービスはカテゴリ（カット・カラー・パーマ・オプション・セット…）ごと、その後に旧会計メニューと店販
  const serviceGroups = cat ? [...new Set(cat.service_menus.map(i => i.group ?? 'メニュー'))] : []
  const groups: [string, SaleLine['source'], CatalogItem[]][] = cat ? [
    ...serviceGroups.map(g => [g, 'service_menu', cat.service_menus.filter(i => (i.group ?? 'メニュー') === g && match(i))] as [string, SaleLine['source'], CatalogItem[]]),
    ['旧会計メニュー', 'accounting_item', cat.menus.filter(match)],
    ['店販', 'product', cat.products.filter(match)],
  ] : []
  return (
    <div style={{ padding: '12px 0', borderBottom: `1px solid ${C.line}` }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="メニュー・商品を探す" aria-label="メニュー・商品を探す" style={inputStyle} autoComplete="off" />
        <button type="button" onClick={onClose} style={{ ...linkStyle, flexShrink: 0 }}>閉じる</button>
      </div>
      {!cat ? <p style={{ fontSize: 14, color: C.sub, marginTop: 8 }}>読み込み中…</p> : groups.map(([label, src, items]) => items.length === 0 ? null : (
        <div key={label} style={{ marginTop: 10 }}>
          <p style={{ fontSize: 12, color: C.mute }}>{label}</p>
          {items.map(i => (
            <button key={`${src}-${i.id}`} type="button" onClick={() => onPick(src, i)} style={{ ...lineBtn, minHeight: 44 }}>
              <span style={{ fontSize: 14 }}>{i.name}</span><span style={{ fontSize: 14, color: C.sub, fontVariantNumeric: 'tabular-nums' }}>{yen(i.price)}{i.price_from ? '〜' : ''}</span>
            </button>
          ))}
        </div>
      ))}
      <p style={{ ...smallLabel, marginTop: 14 }}>手入力</p>
      <span style={{ display: 'flex', gap: 6 }}>
        {([['menu', 'メニュー'], ['option', 'オプション'], ['retail', '店販']] as const).map(([id, label]) => (
          <Choice key={id} on={manual.category === id} onClick={() => setManual({ ...manual, category: id })}>{label}</Choice>
        ))}
      </span>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 110px auto', gap: 8, alignItems: 'end' }}>
        <label><span style={smallLabel}>名称</span><input value={manual.name} onChange={e => setManual({ ...manual, name: e.target.value })} maxLength={80} style={inputStyle} /></label>
        <label><span style={smallLabel}>単価</span><input value={manual.price} onChange={e => setManual({ ...manual, price: e.target.value.replace(/\D/g, '') })} inputMode="numeric" style={inputStyle} /></label>
        <button type="button" disabled={!manual.name.trim() || manual.price === ''} onClick={() => onPick('manual', { id: '', name: manual.name.trim(), category: manual.category, price: parseInt(manual.price, 10) })}
          style={{ ...linkStyle, color: !manual.name.trim() || manual.price === '' ? C.mute : C.text }}>追加</button>
      </div>
    </div>
  )
}

// ── 部品 ──────────────────────────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '72px 1fr', alignItems: 'center', gap: 12, marginTop: 14 }}>
      <span style={{ fontSize: 13, color: C.sub }}>{label}</span>{children}
    </div>
  )
}
function Choice({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} style={{
      minHeight: 40, padding: '0 14px', borderRadius: 8, fontSize: 14, fontFamily: SANS, cursor: 'pointer',
      background: on ? C.text : C.bg, color: on ? C.bg : C.text, border: `1px solid ${on ? C.text : C.lineStrong}`,
    }}>{children}</button>
  )
}
function Num({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={smallLabel}>{label}</span>
      <input value={String(value)} onChange={e => onChange(parseInt(e.target.value.replace(/\D/g, '') || '0', 10))} inputMode="numeric" aria-label={label} style={{ ...inputStyle, fontVariantNumeric: 'tabular-nums' }} />
    </label>
  )
}
function Step({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} style={{ width: 44, height: 44, borderRadius: 8, border: `1px solid ${C.lineStrong}`, background: C.bg, color: C.text, fontSize: 18, fontFamily: SANS, cursor: 'pointer' }}>{children}</button>
}
function Sum({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: C.sub, lineHeight: 1.9 }}>
      <span>{label}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}

const lineBtn: CSSProperties = {
  display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', gap: 12, minHeight: 52, padding: '10px 0',
  background: 'none', border: 'none', borderBottom: `1px solid ${C.line}`, color: C.text, fontFamily: SANS, textAlign: 'left', cursor: 'pointer',
}
const smallLabel: CSSProperties = { display: 'block', fontSize: 12, color: C.sub, marginBottom: 4 }
