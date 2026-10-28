import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { rpcErrorMessage } from '../../utils/staffSession'
import { yen } from '../../utils/bookingApi'
import { reservationSaleLines } from '../../utils/checkoutPricing'
import { idempotencyKey } from '../../utils/ginpayApi'
import { checkoutAttemptSnapshot, subscribeCheckoutAttempt, readCheckoutAttempt, sameCheckout, settleCheckout, startNextCheckout, withCheckoutLock, type CheckoutAttempt } from '../../utils/checkoutAttempt'
import type { ClientCandidate, CustomerApi } from '../../utils/customerApi'
import {
  checkoutErrorMessage, saleTotals, TICKET_BLOCK_LABEL,
  type Catalog, type CatalogItem, type CheckoutApi, type CheckoutContext, type PaymentMethod, type Sale, type SaleLine,
} from '../../utils/checkoutApi'
import { PrimaryButton } from './ledgerUi'
import { C, SANS, inputStyle, linkStyle } from './ledgerTheme'
import { playCue } from '../../audio/cue'
import { Banknote, Wallet } from 'lucide-react'
import { isWelcomeCouponTicket } from '../../utils/welcomeCoupon'

// 会計。予約から開く（顧客・担当・予約メニュー・予約時価格を引き継ぎ、実際の内容に合わせて直せる）／予約なしの店頭会計。
// 「会計を確定」で初めて売上になる（確定は DB の1トランザクション。予約は完了になる）。毎日何十回も使うので、文字と金額だけで構成する。
// GINPay は顧客を選んだ会計だけ。残高は表示用で、足りるかどうかは確定の中で DB が口座をロックして決める。

const METHODS: { id: PaymentMethod; label: string }[] = [
  { id: 'cash', label: '現金' }, { id: 'card', label: 'カード' }, { id: 'qr', label: 'QR等' }, { id: 'ginpay', label: 'GINPay' }, { id: 'other', label: 'その他' },
]
type Line = SaleLine & { key: number }
let keySeq = 0

export function Checkout({ api, customers, reservationId, clientId = null, initialTicketIds, ensureActor, onClose, onDone, quick = false, onMenuPicked }: {
  api: CheckoutApi
  /** 予約なしの会計で顧客を探す */
  customers?: CustomerApi
  /** 予約から開くとき。null は予約なしの店頭会計 */
  reservationId: string | null
  /** 予約なしで、顧客が決まっているとき（店舗端末で会員QRを読んだ）。顧客を探す手順を飛ばす */
  clientId?: string | null
  /** 最初から選んでおくクーポン（会員QRでお客様が選んだ券）。使えない券は外す */
  initialTicketIds?: readonly string[]
  ensureActor: () => boolean
  onClose: () => void
  onDone: (sale: Sale) => void
  /** 店舗端末で会員QRを読んだあと：画面の中に出す短い会計。メニューごとの金額をその場で入れて確定する（担当で料金が変わるため）。
   *  メニューの追加・値引きは「メニューの追加・値引き」から（ふつうの会計と同じ内容に広がる） */
  quick?: boolean
  /** 短い会計でメニューを選んだとき（店舗端末は今日のメニューとして記録する） */
  onMenuPicked?: (code: string) => void
}) {
  const [detail, setDetail] = useState(!quick)
  const [personal, setPersonal] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [ctx, setCtx] = useState<CheckoutContext | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [client, setClient] = useState<{ id: string; name: string } | null | undefined>(undefined)
  const [anonymous, setAnonymous] = useState(false)
  const [stylistId, setStylistId] = useState<string | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [editing, setEditing] = useState<number | null>(null)
  const [ticketIds, setTicketIds] = useState<string[]>([])
  // 店舗端末：会計を開いたあとに下の一覧で選んだ券も、この会計に入れる（10/27：選んでも差し引かれなかった）
  const latestInitial = useRef(initialTicketIds)
  useEffect(() => { latestInitial.current = initialTicketIds }, [initialTicketIds])
  const initialKey = (initialTicketIds ?? []).join(',')
  const [manual, setManual] = useState<{ amount: string; label: string } | null>(null)
  // 短い会計：予約のときに銀Pay で仮支払いしていれば銀Pay、していなければ現金を自動で選ぶ（10/27 慶一郎さん：どちらか分からなかった）
  //   仮支払いを確かめるまでは選ばない。スタッフが選び直したら、そのまま
  const [method, setMethod] = useState<PaymentMethod | null>(null)
  const methodPicked = useRef(false)
  const [holdChecked, setHoldChecked] = useState(false)
  // 仮支払いを確かめられなかった（通信の失敗）。「仮支払いなし」とは分ける（監査 10/28 改善1）
  const [holdError, setHoldError] = useState(false)
  const [holdRetry, setHoldRetry] = useState(0)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ginpayAccountId, setGinpayAccountId] = useState<string | null>(null)
  // お客様が予約のときに銀Pay で仮支払いした額。お会計がその額以内なら GINPay を最初から選ぶ（差額があるときは選ばない＝スタッフが決める）
  const [hold, setHold] = useState<{ amount: number; account_id: string } | null>(null)
  const holdAutoPicked = useRef(false)
  // 初回送信前に内容と一緒に保存し、再読み込み後も同じ取引キーで照合する。
  const [saleKey, setSaleKey] = useState(() => idempotencyKey('checkout'))
  const rawAttempt = useSyncExternalStore(subscribeCheckoutAttempt, checkoutAttemptSnapshot, () => '')
  const { attempt, attemptError } = useMemo(() => {
    try {
      const saved = readCheckoutAttempt({ getItem: () => rawAttempt || null })
      return { attempt: saved?.result && !sameCheckout(saved, reservationId, clientId) ? null : saved, attemptError: null }
    } catch (err) { return { attempt: null, attemptError: err instanceof Error ? err.message : '前の会計記録を確認できません。' } }
  }, [rawAttempt, reservationId, clientId])
  const submitting = useRef(false)
  const mounted = useRef(true)
  const [reload, setReload] = useState(0)
  const matchesAttempt = !!attempt && sameCheckout(attempt, reservationId, clientId)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  // 予約から：予約の顧客・担当・メニュー・予約時価格を引き継ぐ
  useEffect(() => {
    let alive = true
    let saved: CheckoutAttempt | null
    try {
      saved = readCheckoutAttempt()
      if (saved?.result && !sameCheckout(saved, reservationId, clientId)) saved = null
    } catch { return }
    const resume = saved && sameCheckout(saved, reservationId, clientId) ? saved : null
    api.context(resume?.input.reservation_id ?? reservationId, resume ? resume.input.client_id ?? null : reservationId ? null : clientId).then(async c => {
      const codes = c.reservation?.items.flatMap(item => item.menu_code ? [item.menu_code] : []) ?? []
      // お客様ごとの「いつもの」料金（店で最後に払った金額）。払ったことのあるメニューはその金額で始める
      const mine = c.client && api.clientMenuPrices ? await api.clientMenuPrices(c.client.id).catch(() => []) : []
      const personalOf = new Map(mine.map(p => [p.menu_code, p.price]))
      const quoted = c.reservation && !resume
        ? reservationSaleLines(c.reservation.items, codes.length ? await api.quote(codes, c.reservation.starts_at) : null)
            .map(l => l.ref_id && personalOf.has(l.ref_id) ? { ...l, unit_price: personalOf.get(l.ref_id)! } : l)
        : null
      if (!alive) return
      setPersonal(personalOf)
      setCtx(c)
      if (!c.reservation && clientId && c.client) setClient(c.client)
      const wanted = latestInitial.current
      if (wanted?.length) setTicketIds(usableTicketIds(c.tickets, wanted))
      if (c.reservation) {
        const r = c.reservation
        setStylistId(r.staff_id)
        if (quoted) setLines(quoted.map(item => ({ ...item, key: ++keySeq })))
      }
    }).catch(err => { if (alive) setError(rpcErrorMessage(err, '会計の準備ができませんでした。')) })
    return () => { alive = false }
    // 開いたときの顧客だけを使う（券は latestInitial と下の同期で入れる）
  }, [api, reservationId, clientId, reload])

  // 開いたあとに選び直した券（読み込み前なら、読み込んだときに上で入れる）
  const ctxTickets = ctx?.tickets
  useEffect(() => {
    if (!ctxTickets || initialTicketIds === undefined) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTicketIds(usableTicketIds(ctxTickets, initialTicketIds))
    // 選んだ券が変わったときだけ（会計の中で選び直した券は、一覧が変わるまでそのまま）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey])

  useEffect(() => {
    if (!busy) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [busy])

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
  const tickets = clientInfo ? ctx?.tickets ?? [] : []
  const chosenTickets = tickets.filter(t => ticketIds.includes(t.id))
  const manualAmount = manual ? Math.max(0, parseInt(manual.amount || '0', 10) || 0) : 0
  const totals = useMemo(() => saleTotals(lines, chosenTickets, manualAmount), [lines, chosenTickets, manualAmount])
  const paid = !!ctx?.paid_sale_id
  const customerReady = !!ctx?.reservation || anonymous || !!client
  // GINPay：顧客の口座（統合顧客で複数あるときは選ぶ。合算しない）
  const ginpayAccounts = clientInfo ? ctx?.ginpay_accounts ?? [] : []
  const ginpayAccount = ginpayAccounts.length === 1 ? ginpayAccounts[0] : ginpayAccounts.find(a => a.id === ginpayAccountId) ?? null
  const ginpayShort = method === 'ginpay' && !!ginpayAccount && ginpayAccount.balance < totals.total
  const ginpayOk = method !== 'ginpay' || (!!ginpayAccount && totals.total > 0 && !ginpayShort)
  // オプションは金額だけでよい（名前は任意。空なら「オプション」で記録・10/28 慶一郎さん）
  const optionsReady = lines.every(l => l.source !== 'manual' || l.unit_price > 0)
  // 券を引く前の金額（券以外の値引きのあと）。券がこれを超えた分はおつりにしない
  const beforeTickets = totals.subtotal - lines.reduce((n, l) => n + l.discount, 0) - manualAmount
  const canConfirm = !!ctx && !paid && customerReady && !!stylistId && lines.length > 0 && optionsReady && !!method && (totals.total >= 0 || beforeTickets >= 0)
    && (!manual || manualAmount === 0 || manual.label.trim() !== '') && ginpayOk && !busy

  function update(key: number, patch: Partial<SaleLine>) { setLines(ls => ls.map(l => l.key === key ? { ...l, ...patch } : l)) }
  function addItem(src: SaleLine['source'], item: CatalogItem) {
    const price = src === 'service_menu' ? personal.get(item.id) ?? item.price : item.price
    setLines(ls => [...ls, { key: ++keySeq, source: src, ref_id: item.id, name: item.name, category: item.category, unit_price: price, quantity: 1, discount: 0 }])
    setAdding(false)
    if (src === 'service_menu' && item.id) onMenuPicked?.(item.id)
  }
  // 券は料金を超えても使える：お支払いは0円で、超えた分はおつりにしない（10/28 慶一郎さん：これまでも端数はチップとして受け取っていた）
  const ticketSum = chosenTickets.reduce((n, t) => n + t.amount, 0)
  const ticketOver = Math.max(0, ticketSum - Math.max(0, beforeTickets))
  function toggleTicket(id: string, type: string) {
    // 割引券・漢トク券は何枚でも種類をまたいでも使える。メンテナンスクーポンだけはほかの券と一緒に使えない
    setTicketIds(ids => ids.includes(id) ? ids.filter(x => x !== id)
      : type === 'coupon' ? [id]
      : [...ids.filter(x => tickets.find(t => t.id === x)?.type !== 'coupon'), id])
  }

  // 予約の会計：銀Pay の仮支払いを読み込む
  const holdReservationId = ctx?.reservation?.id ?? null
  useEffect(() => {
    if (!holdReservationId || !api.ginpayHold) return
    let alive = true
    api.ginpayHold(holdReservationId).then(h => { if (alive) { setHold(h); setHoldError(false); setHoldChecked(true) } }).catch(() => { if (alive) setHoldError(true) })
    return () => { alive = false }
  }, [holdReservationId, api, holdRetry])
  // 仮支払いがお会計以内なら、最初の1回だけ GINPay とその口座を選んでおく（スタッフが変えたら戻さない）
  const holdCovers = !!hold && !!clientInfo && totals.total > 0 && totals.total <= hold.amount
  useEffect(() => {
    if (!hold || !holdCovers || holdAutoPicked.current) return
    holdAutoPicked.current = true
    setMethod(m => m ?? 'ginpay')
    setGinpayAccountId(id => id ?? hold.account_id)
  }, [hold, holdCovers])

  // 短い会計の自動の支払い方法（仮支払いを確かめ終わってから1回だけ）
  const holdKnown = !!ctx && (!holdReservationId || holdChecked)
  useEffect(() => {
    if (!quick || !holdKnown || holdError || methodPicked.current) return
    methodPicked.current = true
    setMethod(hold && clientInfo ? 'ginpay' : 'cash') // 仮支払いを確かめ終わったときに1回だけ
    if (hold) setGinpayAccountId(id => id ?? hold.account_id) // eslint-disable-line react-hooks/set-state-in-effect
  }, [quick, holdKnown, holdError, hold, clientInfo])
  function pickMethod(m: PaymentMethod) { methodPicked.current = true; setMethod(m) }
  // 券で全額まかなえた（お支払い 0円）：銀Pay は 0円では払えないので現金（0円）で確定する（10/27：漢トク券だけで会計できなかった）
  useEffect(() => {
    if (quick && method === 'ginpay' && totals.total <= 0 && lines.length > 0) setMethod('cash') // eslint-disable-line react-hooks/set-state-in-effect
  }, [quick, method, totals.total, lines.length])

  // Welcomeクーポン（初回パーマ 2,000円引き）はパーマ（セットを含む）のときだけ（10/27 慶一郎さん：カットでも使えていた）
  const hasPerm = lines.some(l => !!l.ref_id && /^(perm|set)-/.test(l.ref_id))
  const welcomeIds = tickets.filter(t => isWelcomeCouponTicket({ title: t.title, amount: t.amount, issued_by: '' })).map(t => t.id)
  const welcomeKey = hasPerm ? '' : welcomeIds.filter(id => ticketIds.includes(id)).join(',')
  useEffect(() => {
    if (!welcomeKey) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTicketIds(ids => ids.filter(id => !welcomeKey.split(',').includes(id)))
  }, [welcomeKey])

  async function confirm() {
    if (submitting.current || attemptError || !ensureActor()) return
    if (attempt && !matchesAttempt) return
    if (!attempt && (!canConfirm || !ctx || !stylistId || !method)) return
    submitting.current = true
    setBusy(true); setError(null)
    try {
      const proposed: CheckoutAttempt = attempt ?? { version: 1, backend: api.backend, customerLabel: clientInfo?.name ?? ctx?.reservation?.customer_name ?? '匿名', operator: api.operator(), createdAt: new Date().toISOString(), input: {
        reservation_id: ctx?.reservation?.id, client_id: ctx?.reservation ? undefined : client?.id,
        stylist_id: stylistId!, items: lines.map(l => ({ source: l.source, ref_id: l.ref_id, name: l.source === 'manual' && !l.name.trim() ? 'オプション' : l.name.trim() || l.name, category: l.category, unit_price: l.unit_price, quantity: l.quantity, discount: l.discount })), ticket_ids: ticketIds,
        manual_discount: manualAmount > 0 ? { amount: manualAmount, label: manual!.label.trim() } : undefined,
        payment_method: method!, expected_total: Math.max(0, totals.total), idempotency_key: saleKey,
        ginpay_account_id: method === 'ginpay' ? ginpayAccount?.id : undefined,
      } }
      const res = await withCheckoutLock(() => settleCheckout(api, proposed))
      if (!mounted.current) return
      if ('error' in res) setError(checkoutErrorMessage(res.error))
      else if (res.status === 'voided') setError('この会計は取り消されています。新しい会計を始める場合は、下のボタンを押してください。')
      else { if (method === 'ginpay') playCue('ginpayPaid'); onDone(res) } // 銀Pay 払いの確定：「銀ペイ」
    } catch (err) {
      if (!mounted.current) return
      setError(err instanceof Error ? err.message : rpcErrorMessage(err))
    } finally { submitting.current = false; if (mounted.current) setBusy(false) }
  }

  async function nextCheckout() {
    if (!attempt?.result || submitting.current) return
    try {
      await startNextCheckout(attempt.input.idempotency_key)
      setError(null); setSaleKey(idempotencyKey('checkout'))
      setLines([]); setManual(null); setMethod(null); methodPicked.current = false; setTicketIds([]); setReload(n => n + 1)
    } catch (err) { setError(err instanceof Error ? err.message : '前の会計を確認できません。') }
  }

  return (
    <div {...(quick ? { 'aria-label': 'お会計' } : { role: 'dialog', 'aria-modal': true, 'aria-label': '会計' })}
      style={quick ? { marginTop: 16, padding: 16, borderRadius: 14, background: C.bg, color: C.text, fontFamily: SANS, textAlign: 'left', border: `1px solid ${C.line}` }
        : { position: 'fixed', inset: 0, zIndex: 950, background: C.bg, color: C.text, fontFamily: SANS, display: 'flex', flexDirection: 'column' }}>
      {!quick && <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 16px', borderBottom: `1px solid ${C.line}` }}>
        <button type="button" disabled={busy} onClick={() => { if (!submitting.current) onClose() }} style={{ ...linkStyle, textDecoration: 'none', color: C.text, fontSize: 15 }}>‹ 戻る</button>
        <span style={{ fontSize: 13, color: C.mute }}>{ctx?.reservation ? '会計' : '店頭会計'}</span>
      </div>}
      <div style={quick ? undefined : { flex: 1, overflowY: 'auto' }}>
        <div style={quick ? undefined : { maxWidth: 640, margin: '0 auto', padding: '20px 20px 24px' }}>
          {attemptError ? <p role="alert" style={{ color: C.danger }}>{attemptError}</p> : attempt ? (
            <section aria-label="前の会計の確認">
              <h1 style={{ fontSize: 22, fontWeight: 600 }}>{attempt.result ? '前回のお会計' : '会計の完了を確認'}</h1>
              <p style={{ marginTop: 12, fontSize: 16 }}>{attempt.customerLabel}</p>
              <p style={{ marginTop: 8, fontSize: 24, fontWeight: 600 }}>{yen(attempt.input.expected_total)}</p>
              <p style={{ marginTop: 8, color: C.sub }}>{METHODS.find(m => m.id === attempt.input.payment_method)?.label}・担当 {attempt.operator}</p>
              {attempt.input.items.map((item, index) => <p key={index} style={{ marginTop: 8, fontSize: 14 }}>{item.name} ×{item.quantity}</p>)}
              <p style={{ marginTop: 20, fontSize: 14, lineHeight: 1.7 }}>{!matchesAttempt ? '別のお客様の会計が未確認です。そのお客様の会計を先に確認してください。' : attempt.result ? 'この会計の結果を確認できます。別の店頭会計を作る場合だけ「新しい会計を始める」を押してください。' : '前回と同じ内容で、会計の完了を確認します。金額や支払方法は変更されません。'}</p>
              {attempt.result && !attempt.input.reservation_id && <button type="button" disabled={busy} onClick={() => void nextCheckout()} style={{ ...linkStyle, marginTop: 16 }}>新しい会計を始める</button>}
              {error && <p role="alert" style={{ marginTop: 12, color: C.danger }}>{error}</p>}
            </section>
          ) : !ctx ? <p style={{ fontSize: 14, color: error ? C.danger : C.sub }}>{error ?? '読み込み中…'}</p> : (
            <fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
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
                {detail && lines.length === 0 && <p style={{ padding: '14px 0', fontSize: 14, color: C.mute }}>メニュー・商品を追加してください</p>}
                {!detail ? lines.map(l => (
                  <div key={l.key} style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 12, alignItems: 'center', padding: '10px 0', borderBottom: `1px solid ${C.line}` }}>
                    {l.source === 'manual' ? (
                      <span style={{ minWidth: 0 }}>
                        <input value={l.name} onChange={e => update(l.key, { name: e.target.value.slice(0, 40) })} placeholder="名前（任意）例：鼻毛抜き" aria-label="オプションの名前"
                          style={{ ...inputStyle, fontSize: 15 }} />
                        <button type="button" onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))} style={{ ...linkStyle, minHeight: 28, fontSize: 13 }}>消す</button>
                      </span>
                    ) : (
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 15 }}>{l.name}{l.quantity > 1 ? <span style={{ color: C.sub }}>{` ×${l.quantity}`}</span> : null}</span>
                        {lines.filter(x => x.source !== 'manual').length === 1 && <button type="button" onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))} style={{ ...linkStyle, minHeight: 28, fontSize: 13 }}>変える</button>}
                      </span>
                    )}
                    <input value={String(l.unit_price)} inputMode="numeric" aria-label={`${l.name}の金額`}
                      onChange={e => { const v = parseInt(e.target.value.replace(/\D/g, '') || '0', 10); update(l.key, { unit_price: v, discount: Math.min(l.discount, v * l.quantity) }) }}
                      style={{ ...inputStyle, fontSize: 20, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} />
                  </div>
                )) : lines.map(l => (
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
                {/* メニュー以外のもの（鼻毛抜きなど）を金額を入れて足す（10/28 慶一郎さん） */}
                {!detail && lines.some(l => l.source !== 'manual') && (
                  <button type="button" onClick={() => setLines(ls => [...ls, { key: ++keySeq, source: 'manual', ref_id: '', name: '', category: 'option', unit_price: 0, quantity: 1, discount: 0 }])}
                    style={{ ...linkStyle, display: 'flex', minHeight: 40 }}>＋ オプション（金額を入れる）</button>
                )}
                {!detail && !lines.some(l => l.source !== 'manual') ? <QuickMenuSelect api={api} startsAt={ctx.reservation?.starts_at ?? null} personal={personal} onPick={item => addItem('service_menu', item)} />
                  : adding ? <ItemPicker api={api} startsAt={ctx.reservation?.starts_at ?? null} onPick={addItem} onClose={() => setAdding(false)} />
                  : detail ? <button type="button" onClick={() => setAdding(true)} style={{ ...linkStyle, color: C.text }}>＋ メニュー・商品を追加</button> : null}
              </div>

              {/* クーポン（App 会員）・値引き */}
              {tickets.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {tickets.map(t => {
                    const on = ticketIds.includes(t.id)
                    const permOnly = !hasPerm && welcomeIds.includes(t.id)
                    const off = !!t.blocked || permOnly
                    return (
                      <button key={t.id} type="button" disabled={off} onClick={() => toggleTicket(t.id, t.type)} aria-pressed={on} style={{ ...lineBtn, opacity: off ? 0.55 : 1, cursor: off ? 'default' : 'pointer' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                          <span aria-hidden="true" style={{ width: 18, height: 18, flexShrink: 0, boxSizing: 'border-box', borderRadius: 4, border: `1.5px solid ${on ? C.text : C.lineStrong}`, background: on ? C.text : 'transparent', color: C.bg, fontSize: 13, lineHeight: '15px', textAlign: 'center', fontWeight: 700 }}>{on ? '✓' : ''}</span>
                          <span style={{ fontSize: 14 }}>{t.title}{t.blocked ? <span style={{ fontSize: 12, color: C.mute }}>{` ${TICKET_BLOCK_LABEL[t.blocked]}`}</span> : permOnly && <span style={{ fontSize: 12, color: C.mute }}> パーマのときだけ使えます</span>}</span>
                        </span>
                        <span style={{ fontSize: 14, color: C.sub, fontVariantNumeric: 'tabular-nums' }}>{t.amount ? `−${yen(t.amount)}` : ''}</span>
                      </button>
                    )
                  })}
                </div>
              )}
              {!detail ? (
                <button type="button" onClick={() => setDetail(true)} style={{ ...linkStyle, display: 'flex' }}>メニューの追加・値引き</button>
              ) : manual ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px auto', gap: 10, alignItems: 'end', padding: '10px 0', borderBottom: `1px solid ${C.line}` }}>
                  <label><span style={smallLabel}>値引きの理由</span><input value={manual.label} onChange={e => setManual({ ...manual, label: e.target.value })} maxLength={40} style={inputStyle} /></label>
                  <label><span style={smallLabel}>金額</span><input value={manual.amount} onChange={e => setManual({ ...manual, amount: e.target.value.replace(/\D/g, '') })} inputMode="numeric" style={inputStyle} /></label>
                  <button type="button" onClick={() => setManual(null)} style={linkStyle}>外す</button>
                </div>
              ) : <button type="button" onClick={() => setManual({ amount: '', label: '' })} style={{ ...linkStyle, display: 'flex' }}>値引きを入力</button>}

              {/* 合計。QR を読んだあとの短い会計は、券を引いたあとの「お受け取り金額」を大きく（現金でいくら受け取るか迷わないように・10/27 慶一郎さん） */}
              {quick ? (() => {
                const otherDiscount = totals.discount - ticketSum
                const viaGinpay = method === 'ginpay'
                const ready = lines.length > 0 && !!method
                const gold = '#c9a45c'
                const accent = viaGinpay ? '#7fc4a4' : gold
                const title = !lines.length ? 'お会計' : !method && holdError ? '仮支払いを確かめられませんでした' : !method ? 'お支払い方法を確かめています…' : viaGinpay ? (hold ? '銀Pay 仮支払い済み' : '銀Pay で支払い') : '現金でのお支払い'
                const note = !lines.length ? 'メニューを選ぶと金額が出ます'
                  : !method && holdError ? '通信を確かめて「もう一度確かめる」を押すか、お客様に聞いて下の支払方法を選んでください。'
                  : !ready ? 'お支払い方法を確かめています…'
                  : viaGinpay
                    ? hold ? `予約のときに ${yen(hold.amount)} を仮支払いしています。現金は受け取りません。${totals.total > hold.amount ? `差額 ${yen(totals.total - hold.amount)} も銀Pay の残高から。` : ''}` : '銀Pay の残高から支払います。現金は受け取りません。'
                    : '銀Pay の仮支払いはありません。現金（PayPay などのときも）で受け取ってから確定してください。'
                const overNote = ticketOver > 0 ? `券が料金を ${yen(ticketOver)} 上回っています（おつりは出ません）。` : ''
                const totalLabel = !ready ? '' : viaGinpay ? '銀Payで支払う金額' : '現金でお受け取り'
                const Icon = viaGinpay ? Wallet : Banknote
                const row = { display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 14, lineHeight: 2, fontVariantNumeric: 'tabular-nums' } as const
                const leader = { flex: 1, borderBottom: '1px dotted rgba(255,255,255,0.22)', transform: 'translateY(-4px)' } as const
                return (
                  <div role="status" aria-label={`${title} ${totalLabel} ${ready ? yen(Math.max(0, totals.total)) : ''}`} style={{
                    marginTop: 16, borderRadius: 18, overflow: 'hidden', color: '#f4efe4',
                    background: 'linear-gradient(160deg, #2b2e2c 0%, #161817 100%)', border: `1px solid ${gold}66`,
                    boxShadow: '0 10px 30px rgba(20,22,21,0.28), inset 0 1px 0 rgba(255,255,255,0.06)',
                  }}>
                    {/* 上：支払い方法（いちばん大事なので色つきで） */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: `1px solid ${gold}33`,
                      background: ready ? `linear-gradient(90deg, ${accent}26, transparent)` : 'transparent' }}>
                      <span style={{ width: 38, height: 38, borderRadius: 19, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: ready ? `${accent}22` : 'rgba(255,255,255,0.06)', border: `1px solid ${ready ? accent : 'rgba(255,255,255,0.18)'}` }}>
                        <Icon size={19} strokeWidth={1.8} color={ready ? accent : 'rgba(255,255,255,0.6)'} />
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontFamily: '"Shippori Mincho","Noto Serif JP",serif', fontSize: 19, fontWeight: 700, letterSpacing: '0.06em', color: ready ? accent : '#f4efe4' }}>{title}</div>
                        <div style={{ fontSize: 12, lineHeight: 1.6, color: 'rgba(244,239,228,0.72)' }}>{note}</div>
                        {ready && overNote && <div style={{ fontSize: 12, lineHeight: 1.6, color: '#e2c27f', marginTop: 2 }}>{overNote}</div>}
                      </div>
                    </div>
                    {!method && holdError && lines.length > 0 && (
                      <div style={{ padding: '12px 18px 16px' }}>
                        <button type="button" onClick={() => { setHoldError(false); setHoldRetry(n => n + 1) }}
                          style={{ width: '100%', minHeight: 44, borderRadius: 12, border: '1px solid rgba(201,164,92,0.6)', background: 'transparent', color: '#f4efe4', fontSize: 15, cursor: 'pointer' }}>もう一度確かめる</button>
                      </div>
                    )}
                    {ready && (
                      <div style={{ padding: '12px 18px 18px' }}>
                        {totals.discount > 0 && (
                          <div style={{ marginBottom: 10 }}>
                            <div style={row}><span>料金</span><span style={leader} /><span>{yen(totals.subtotal)}</span></div>
                            {chosenTickets.map(t => <div key={t.id} style={{ ...row, color: gold }}><span>{t.title}</span><span style={leader} /><span>−{yen(t.amount)}</span></div>)}
                            {otherDiscount > 0 && <div style={{ ...row, color: gold }}><span>値引き</span><span style={leader} /><span>−{yen(otherDiscount)}</span></div>}
                          </div>
                        )}
                        <div style={{ height: 1, background: `linear-gradient(90deg, transparent, ${gold}, transparent)`, margin: '2px 0 12px' }} />
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
                          <span style={{ fontSize: 13, letterSpacing: '0.12em', color: 'rgba(244,239,228,0.78)', whiteSpace: 'nowrap' }}>{totalLabel}</span>
                          <span style={{ fontFamily: '"Shippori Mincho","Noto Serif JP",serif', fontSize: 52, fontWeight: 700, lineHeight: 1.1, letterSpacing: '0.02em', fontVariantNumeric: 'tabular-nums', textAlign: 'right',
                            background: 'linear-gradient(180deg, #fff6df 0%, #e2c27f 100%)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{yen(Math.max(0, totals.total))}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })() : (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.text}` }}>
                {totals.discount > 0 && (
                  <>
                    <Sum label="小計" value={yen(totals.subtotal)} />
                    <Sum label="値引き" value={`−${yen(totals.discount)}`} />
                  </>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 }}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>お支払い</span>
                  {/* 監査2 R5：券が料金を超えたときは0円（超えた分はおつりにしない）。券以外の値引きが超えたときだけ赤 */}
                  <span style={{ fontSize: 24, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: beforeTickets < 0 ? C.danger : C.text }}>{yen(Math.max(0, totals.total))}</span>
                </div>
                {ticketOver > 0 && <p style={{ fontSize: 13, color: C.sub, margin: '4px 0 0', textAlign: 'right' }}>券が料金を {yen(ticketOver)} 上回っています（おつりは出ません）</p>}
              </div>
              )}

              {hold && !quick && (
                <div role="status" style={{ margin: '0 0 10px', padding: '12px 14px', borderRadius: 12, lineHeight: 1.6, fontSize: 14,
                  background: totals.total <= hold.amount ? 'rgba(168,130,63,0.12)' : 'rgba(214,82,82,0.08)',
                  border: totals.total <= hold.amount ? '1px solid rgba(168,130,63,0.5)' : '1px solid rgba(214,82,82,0.45)' }}>
                  <b>銀Pay 仮支払い済み {yen(hold.amount)}</b>
                  {totals.total <= hold.amount
                    ? <><br />支払方法「GINPay」のまま「会計を確定」で、お支払いが完了します。</>
                    : <><br />お会計 {yen(totals.total)}・<b>差額 {yen(totals.total - hold.amount)}</b>。差額も銀Payなら「GINPay」（全額を銀Payで）、ほかの方法なら支払方法を選んでください（仮支払いは確定と同時に戻ります）。</>}
                </div>
              )}
              <Row label="支払方法">
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {METHODS.filter(m => quick ? m.id === 'ginpay' || m.id === 'cash' : m.id !== 'ginpay' || !!clientInfo).map(m => <Choice key={m.id} on={method === m.id} onClick={() => pickMethod(m.id)}>{quick && m.id === 'ginpay' ? '銀Pay' : m.label}</Choice>)}
                </span>
              </Row>
              {/* 店舗端末で QR を読んだあとの会計：PayPay などの支払いも「現金」で確定する（10/28 慶一郎さん） */}
              {quick && <p style={{ fontSize: 13, color: C.sub, lineHeight: 1.6, margin: '-4px 0 8px' }}>PayPay などの支払いの際も「現金」を押してください。</p>}
              {/* 銀Pay は口座の持ち主（お客様）を選んだ会計だけ。選んでいないときに「無い」と迷わないよう一言 */}
              {!clientInfo && <p style={{ fontSize: 13, color: C.sub, lineHeight: 1.6, margin: '-4px 0 8px' }}>GINPay（銀Pay）は、上でお客様を選ぶと使えます。</p>}
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
                      {ginpayAccount && (
                        <>
                          <Sum label="現在の残高" value={yen(ginpayAccount.balance)} />
                          <Sum label="今回のお支払い" value={`−${yen(Math.max(0, totals.total))}`} />
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, lineHeight: 1.9, color: ginpayAccount.balance < Math.max(0, totals.total) ? C.danger : C.text }}>
                            <span>支払後の残高</span>
                            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{ginpayAccount.balance < Math.max(0, totals.total) ? '残高が不足しています' : yen(ginpayAccount.balance - Math.max(0, totals.total))}</span>
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
      {(ctx || attempt) && !attemptError && (
        <div style={quick ? { marginTop: 16 } : { flexShrink: 0, padding: '12px 20px calc(12px + env(safe-area-inset-bottom, 0px))', borderTop: `1px solid ${C.line}` }}>
          <div style={quick ? undefined : { maxWidth: 640, margin: '0 auto' }}>
            <PrimaryButton onClick={() => void confirm()} disabled={busy || (attempt ? !matchesAttempt : !canConfirm)}>{busy ? '確認中…' : attempt ? '前回の会計結果を確認' : ginpayShort ? 'GINPayの残高が不足しています' : quick && method === 'cash' ? `現金 ${yen(Math.max(0, totals.total))} を受け取って会計を確定` : quick && method === 'ginpay' ? `銀Payで会計を確定 ${yen(Math.max(0, totals.total))}` : `会計を確定 ${yen(Math.max(0, totals.total))}`}</PrimaryButton>
          </div>
        </div>
      )}
    </div>
  )
}

/** 選んだ券のうち使えるもの。メンテナンスクーポンはほかの券と一緒に使えないので、混ざっていたらメンテナンスクーポンだけ */
function usableTicketIds(tickets: CheckoutContext['tickets'], wanted: readonly string[]): string[] {
  const usable = tickets.filter(t => !t.blocked && wanted.includes(t.id))
  return (usable.some(t => t.type === 'coupon') ? usable.filter(t => t.type === 'coupon').slice(0, 1) : usable).map(t => t.id)
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

/** 短い会計で予約が無いとき：メニューを1つ選ぶ（長い一覧の代わりに選択欄1つ。旧会計メニュー・店販・手入力は「メニューの追加・値引き」から） */
function QuickMenuSelect({ api, startsAt, personal, onPick }: { api: CheckoutApi; startsAt: string | null; personal: ReadonlyMap<string, number>; onPick: (item: CatalogItem) => void }) {
  const [items, setItems] = useState<CatalogItem[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    api.catalog(startsAt).then(c => { if (alive) setItems(c.service_menus) }).catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [api, startsAt])
  const groups = items ? [...new Set(items.map(i => i.group ?? 'メニュー'))] : []
  return (
    <label style={{ display: 'block', padding: '12px 0', borderBottom: `1px solid ${C.line}` }}>
      <span style={smallLabel}>メニュー</span>
      {failed ? <span role="alert" style={{ fontSize: 14, color: C.danger }}>メニューを読み込めませんでした。「メニューの追加・値引き」から入れてください。</span> : (
        <select value="" disabled={!items} onChange={e => { const item = items?.find(i => i.id === e.target.value); if (item) onPick(item) }}
          style={{ ...inputStyle, fontSize: 16 }}>
          <option value="">{items ? 'メニューを選ぶ' : '読み込み中…'}</option>
          {groups.map(g => (
            <optgroup key={g} label={g}>
              {items!.filter(i => (i.group ?? 'メニュー') === g).map(i => <option key={i.id} value={i.id}>{`${i.name}（${yen(personal.get(i.id) ?? i.price)}${i.price_from ? '〜' : ''}）`}</option>)}
            </optgroup>
          ))}
        </select>
      )}
    </label>
  )
}

/** メニュー・商品の追加（予約メニュー・会計メニュー／オプション・店販・手入力） */
function ItemPicker({ api, startsAt, onPick, onClose }: { api: CheckoutApi; startsAt: string | null; onPick: (src: SaleLine['source'], item: CatalogItem) => void; onClose: () => void }) {
  const [cat, setCat] = useState<Catalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [manual, setManual] = useState({ name: '', price: '', category: 'menu' as CatalogItem['category'] })
  useEffect(() => {
    let alive = true
    api.catalog(startsAt).then(value => { if (alive) setCat(value) }).catch(() => { if (alive) setCatalogError('メニューの料金を確認できませんでした。閉じてもう一度お試しください。') })
    return () => { alive = false }
  }, [api, startsAt])
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
      {!cat ? <p role={catalogError ? 'alert' : undefined} style={{ fontSize: 14, color: catalogError ? C.danger : C.sub, marginTop: 8 }}>{catalogError ?? '読み込み中…'}</p> : groups.map(([label, src, items]) => items.length === 0 ? null : (
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
