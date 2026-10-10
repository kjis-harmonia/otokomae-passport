// 会計のクライアント。売上は「会計を確定」でだけ発生する（予約の金額は予定売上）。
// 確定は DB の1トランザクション（会計・明細・値引き・支払・GINPay 支払い・クーポン消費・予約の完了）。テーブルへは直接アクセスしない。
import { callStaffRpc, expectRpcResult, RpcError } from './staffSession'
import { callHqRpc } from '../hq/hqSession'
import type { Reservation } from './bookingApi'
import type { OperatorSession } from './posOperatorSession'
import { resolveSaleIdentity } from './saleIdentity'


export type ItemCategory = 'menu' | 'option' | 'retail'
export type ItemSource = 'reservation' | 'service_menu' | 'accounting_item' | 'product' | 'manual'
/** GINPay は顧客を選んだ会計だけ（匿名は不可）。残高の確認と支払いは確定の中で DB が行う */
export type PaymentMethod = 'cash' | 'card' | 'qr' | 'ginpay' | 'other'

export interface CheckoutTicket {
  id: string
  type: string
  title: string
  amount: number
  expires_at: string | null
  /** 今日使えない理由（使えるなら null） */
  blocked: 'transfer_pending' | 'welcome_weekend' | 'daily_rule' | null
}
export interface CheckoutContext {
  reservation: Reservation | null
  /** すでに確定済みの会計（同じ予約は2回会計できない） */
  paid_sale_id: string | null
  client: { id: string; name: string; app_linked: boolean } | null
  tickets: CheckoutTicket[]
  /** 顧客（統合された顧客を含む）の有効な GINPay 口座。口座は合算しない */
  /** balance は台帳合計。consistent=false（台帳と照合が取れない）の口座では支払えない */
  ginpay_accounts: { id: string; client_name: string; balance: number; consistent: boolean; is_current_client: boolean }[]
  /** 停止中の口座がある（新規の支払いには使えない） */
  ginpay_suspended: boolean
  staff: { id: string; name: string }[]
  tax: { mode: 'inclusive' | 'exclusive' | null; rate: number | null }
}
/** 会計で選べる品目。正規サービスは kind（service|option|set）と group（カット・カラーなどのカテゴリ）、price_from（「〜」付き価格）を持つ */
export interface CatalogItem { id: string; name: string; category: ItemCategory; price: number; kind?: 'service' | 'option' | 'set'; group?: string | null; price_from?: boolean }
/** service_menus = 正規サービスマスター、menus = 正規サービスにつながっていない旧会計メニュー、products = 店販 */
export interface Catalog { service_menus: CatalogItem[]; menus: CatalogItem[]; products: CatalogItem[] }

export interface SaleLine {
  source: ItemSource
  ref_id?: string
  name: string
  category: ItemCategory
  unit_price: number
  quantity: number
  discount: number
}
export interface SaleInput {
  reservation_id?: string
  client_id?: string
  stylist_id: string
  items: SaleLine[]
  ticket_ids: string[]
  manual_discount?: { amount: number; label: string }
  payment_method: PaymentMethod
  expected_total: number
  /** サーバー生成の見積もりハッシュ（改ざん防止・価格変更検知） */
  quote_hash?: string
  /** 会計画面ごとの一意キー。同じキーの再送は同じ会計を返す（二重タップで二重会計・二重決済しない） */
  idempotency_key: string
  /** GINPay 払いで支払う口座 */
  ginpay_account_id?: string
}

export interface QuoteInput {
  reservation_id?: string
  client_id?: string
  scan_session_id?: string
  items: {
    source: ItemSource
    ref_id?: string
    name?: string
    category?: ItemCategory
    quantity?: number
    unit_price?: number
    price_override?: { price: number; reason: string }
  }[]
  ticket_ids?: string[]
  maintenance?: { use: boolean }
  manual_discount?: { amount: number; label: string }
}

export interface QuoteResult {
  ok: boolean
  quote_hash: string
  subtotal: number
  discount_total: number
  total: number
  items: {
    source: ItemSource
    ref_id: string | null
    name: string
    category: ItemCategory
    quantity: number
    unit_price: number
    list_price: number | null
    line_discount: number
    line_total: number
    price_source: string
  }[]
  discounts: {
    ticket_discount: number
    maintenance_discount: number
    manual_discount: number
    manual_discount_label: string
    ticket_ids: string[]
  }
}

export interface Sale {
  id: string
  status: 'completed' | 'voided'
  completed_at: string
  client: { id: string; name: string } | null
  customer_name: string | null
  reservation: { id: string; starts_at: string; customer_name: string } | null
  stylist_name: string | null
  operator: string | null
  subtotal: number
  discount_total: number
  total: number
  payment_method: string | null
  tax_mode: string | null
  tax_rate: number | null
  items: { name: string; category: string; unit_price: number; quantity: number; line_discount: number; line_total: number; list_price: number | null; source: string | null; tax_mode: string | null; tax_rate: number | null }[]
  discounts: { kind: 'ticket' | 'manual'; label: string; amount: number; ticket_type: string | null }[]
  payments: { method: string; amount: number }[]
  /** この会計の GINPay 取引（支払い・取消時の戻し） */
  ginpay?: { id: string; type: 'payment' | 'void' | 'refund'; amount: number; account_id: string; original_transaction_id: string | null; created_at: string }[]
  idempotent?: boolean
  /** 確定に使った冪等キー（成功応答の照合に使う） */
  idempotency_key?: string | null
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
  events: { type: 'completed' | 'voided'; actor_name: string | null; reason: string | null; created_at: string }[]
}
export interface SalesDay {
  date: string
  count: number
  total: number
  voided: number
  rows: { id: string; status: 'completed' | 'voided'; completed_at: string; customer_name: string | null; stylist_name: string | null; payment_method: string | null; total: number; items: string | null; has_reservation: boolean }[]
}

export interface PosActionError {
  error: string
  action?: string
  request_hash?: string
  [key: string]: unknown
}

export type CheckoutResult<T> = T | PosActionError

export interface CheckoutApi {
  context(reservationId: string | null, clientId: string | null): Promise<CheckoutContext>
  catalog(): Promise<Catalog>
  quote(input: QuoteInput, operator: OperatorSession, approvalToken?: string | null): Promise<CheckoutResult<QuoteResult>>
  /** expect は成功応答の照合内容（記録した会計から作る）。合わない応答は結果不明として扱う */
  finalize(input: SaleInput, operator: OperatorSession, approvalToken: string | null | undefined, expect: SaleExpectation): Promise<CheckoutResult<Sale>>
}
export interface SalesApi {
  day(date: string): Promise<SalesDay>
  detail(id: string): Promise<Sale>
  /** expectedTotal は取消する会計の合計（成功応答の照合に使う） */
  void(id: string, reason: string, expectedTotal: number): Promise<CheckoutResult<Sale>>
}

export const PAYMENT_LABEL: Record<string, string> = { cash: '現金', card: 'カード', credit: 'カード', qr: 'QR等', other: 'その他', ginpay: 'GINPay' }
export const TICKET_BLOCK_LABEL: Record<string, string> = {
  transfer_pending: '譲渡中', welcome_weekend: '土日は使えません', daily_rule: '本日は別の割引を利用済み',
}

export const CHECKOUT_ERROR_MESSAGE: Record<string, string> = {
  already_paid: 'この予約はすでに会計済みです。',
  invalid_status: 'この予約は会計できない状態です（キャンセル・無断キャンセル）。',
  total_mismatch: '金額が更新されました。内容を確認してもう一度確定してください。',
  discount_exceeds: '値引きが合計を超えています。',
  invalid_items: 'メニュー・商品の内容を確認してください（単価0円以上・数量1〜99・値引きは小計まで）。',
  invalid_discount: '値引きの金額と理由を入力してください。',
  invalid_tickets: '使えないクーポンが含まれています（使用済み・期限切れ・他の方の券）。',
  mixed_types: '種類の違うクーポンは一緒に使えません。',
  transfer_pending: '譲渡中のクーポンは使えません。',
  welcome_weekend: 'Welcomeクーポンは平日のみ使えます。',
  daily_rule: '本日はすでに別の割引を利用済みです。',
  stylist_required: '担当を選んでください。',
  invalid_payment_method: '支払方法を選んでください。',
  operator_required: '操作者を選んでください。',
  operator_auth_required: '操作者の認証が必要です。',
  operator_session_invalid: '操作者セッションが無効です。もう一度PINを入力してください。',
  approval_required: 'この操作には管理者承認が必要です。現在、この端末では管理者承認を利用できません。',
  client_not_found: '顧客が見つかりません。',
  not_found: '見つかりません。',
  reason_required: '取消の理由を入力してください。',
  insufficient_balance: 'GINPayの残高が不足しています。',
  ledger_mismatch_blocked: 'GINPayの残高の照合が取れていないため処理を止めました。本部に連絡してください。',
  ginpay_requires_client: 'GINPayは顧客を選んだ会計でのみ使えます。',
  ginpay_account_not_found: 'GINPay口座がありません。顧客台帳のGINPayで口座を開設・チャージしてください。',
  account_selection_required: '支払うGINPay口座を選んでください。',
  ginpay_account_suspended: 'GINPay口座が停止中のため支払えません。',
  invalid_amount: '0円の会計はGINPayで支払えません。',
  ginpay_account_not_active: 'GINPay口座が停止中のため取消できません。本部で口座の状態を確認してください。',
  ginpay_already_reversed: 'GINPayの支払いはすでに取り消されています。',
  quote_mismatch: '価格または条件が更新されました。最新の計算を確認してください。',
  idempotency_conflict: '同じキーで異なる内容の会計が送信されました。',
  below_base_price: '基準価格未満の金額は設定できません。',
  operator_required_for_override: '価格の変更には担当者の本人確認が必要です。',
  customer_context_mismatch: 'スキャンされた顧客情報と選択された顧客が一致しません。',
  maintenance_offer_unconfigured: 'メンテナンスメニューの設定が確認できません。',
  l2_authorization_not_enabled: '手入力および価格変更機能は現在利用できません。',
  quote_required: '会計の計算結果が取得できていません。再読み込みしてください。',
  reservation_price_missing: '予約時の価格が未設定のため会計できません。',
}

export function checkoutErrorMessage(code: string): string {
  return CHECKOUT_ERROR_MESSAGE[code] ?? '処理に失敗しました。通信環境を確認して再度お試しください。'
}

/** 画面の合計（確定時に DB が同じ計算で照合する） */
export function saleTotals(lines: SaleLine[], tickets: { amount: number }[], manualDiscount: number) {
  const subtotal = lines.reduce((n, l) => n + l.unit_price * l.quantity, 0)
  const lineDiscount = lines.reduce((n, l) => n + l.discount, 0)
  const ticketDiscount = tickets.reduce((n, t) => n + t.amount, 0)
  const discount = lineDiscount + ticketDiscount + manualDiscount
  return { subtotal, discount, total: subtotal - discount }
}

/**
 * 業務エラー（rpc_result）と呼出前の失敗（local_precondition）だけを結果として返す。
 * supabase_error（通信断・結果不明・サーバー側の例外）は例外のまま呼び出し元へ渡し、
 * 呼び出し元が isResultUnknown で結果不明かどうかを判断する。
 */
async function asResult<T>(fn: () => Promise<T>): Promise<CheckoutResult<T>> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof RpcError && err.source === 'rpc_result') {
      const detail = (typeof err.detail === 'object' && err.detail !== null) ? err.detail : {}
      return { error: err.code, ...(detail as object) }
    }
    if (err instanceof RpcError && err.source === 'local_precondition') {
      return { error: err.code }
    }
    throw err
  }
}

const isId = (v: unknown) => typeof v === 'string' && v !== ''
const isYen = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v)
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 送った会計で、サーバーが記録するはずの内容（記録した送信内容とサーバーの顧客の決め方から作る） */
export interface SaleExpectation {
  idempotencyKey: string
  total: number
  /** サーバーが記録する予約・顧客（client_root）。匿名なら両方 null */
  reservationId: string | null
  clientId: string | null
  paymentMethod: string
  /** GINPay 払いで指定した口座（指定なしは null。サーバーが顧客の口座を1つに決める） */
  ginpayAccountId: string | null
  ticketCount: number
}

/** 送る内容から照合内容を作る。予約の会計は予約の顧客（reservationClientId）が無いと顧客が分からず、匿名として照合する */
export function saleExpectation(input: SaleInput, reservationClientId?: string | null): SaleExpectation {
  const identity = resolveSaleIdentity(input, reservationClientId)
  return {
    idempotencyKey: input.idempotency_key,
    total: input.expected_total,
    reservationId: identity.reservationId,
    clientId: identity.clientId,
    paymentMethod: input.payment_method,
    ginpayAccountId: input.ginpay_account_id ?? null,
    ticketCount: input.ticket_ids.length,
  }
}

/**
 * 会計確定の成功応答（sale_json）を、送った会計と照合する。どれか1つでも合わなければ成功として扱わない。
 *   会計 ID・completed・合計・冪等キー
 *   予約・顧客（client_root）。匿名なら両方 null
 *   支払方法（card は credit で記録）・支払額の合計・GINPay の支払い（口座・金額）。GINPay 以外に GINPay の支払いが無いこと
 *   使ったクーポンの枚数（sale_json にはクーポン ID が無いので、クーポン値引きの行数で照合する）
 * staff_finalize_sale は取消済みの会計を同じキーで返さない（idempotency_conflict）ので、voided は受け付けない。
 *
 * 顧客：sale_json の client は「今の」統合先（client_root）。送った後に顧客が統合されると、記録した顧客と違う ID が返る。
 *   mergedInto（記録した顧客の今の統合先を読み取りで確かめた ID）が渡され、返った顧客がそれと同じときだけ、統合による変化として認める。
 *   anyClient は1段目（顧客以外の照合）だけに使い、それだけで成功にはしない。
 */
export function isCompleteSale(sale: Record<string, unknown>, expect: SaleExpectation, opts: { mergedInto?: string | null; anyClient?: boolean } = {}): boolean {
  if (!(isId(sale.id) && sale.status === 'completed' && isYen(sale.total) && sale.total === expect.total
    && sale.idempotency_key === expect.idempotencyKey)) return false

  const reservationOk = expect.reservationId === null ? sale.reservation === null
    : isObj(sale.reservation) && sale.reservation.id === expect.reservationId
  const clientOk = expect.clientId === null ? sale.client === null
    : isObj(sale.client) && isId(sale.client.id) && (sale.client.id === expect.clientId || opts.anyClient === true
      || (isId(opts.mergedInto) && opts.mergedInto !== expect.clientId && sale.client.id === opts.mergedInto))
  if (!reservationOk || !clientOk) return false

  const method = expect.paymentMethod === 'card' ? 'credit' : expect.paymentMethod
  const payments = sale.payments
  if (sale.payment_method !== method || !Array.isArray(payments) || payments.length === 0) return false
  if (!payments.every(p => isObj(p) && p.method === method && isYen(p.amount))) return false
  if (payments.reduce((n: number, p) => n + (p as { amount: number }).amount, 0) !== expect.total) return false

  const ginpay = sale.ginpay
  if (!Array.isArray(ginpay) || !ginpay.every(isObj)) return false
  const ginpayPayments = (ginpay as Record<string, unknown>[]).filter(g => g.type === 'payment')
  if (method === 'ginpay') {
    if (ginpayPayments.length !== 1) return false
    const g = ginpayPayments[0]
    if (!isId(g.id) || !isId(g.account_id) || g.amount !== -expect.total) return false
    if (expect.ginpayAccountId !== null && g.account_id !== expect.ginpayAccountId) return false
  } else if (ginpayPayments.length !== 0) {
    return false
  }

  const discounts = sale.discounts
  if (!Array.isArray(discounts) || !discounts.every(isObj)) return false
  return (discounts as Record<string, unknown>[]).filter(d => d.kind === 'ticket').length === expect.ticketCount
}

/** 会計取消の成功応答：同じ会計が、取消前と同じ合計のまま取消済みになっていること */
export function isVoidedSale(sale: Record<string, unknown>, saleId: string, total: number): boolean {
  return sale.id === saleId && sale.status === 'voided' && isYen(sale.total) && sale.total === total
}

/** 店舗端末用。会計操作は検証済み OperatorSession が必須 */
export function createStaffCheckoutApi(_actor?: () => string): CheckoutApi {
  return {
    context: (reservationId, clientId) => callStaffRpc<CheckoutContext>('staff_checkout_context', { p_reservation_id: reservationId, p_client_id: clientId }),
    catalog: () => callStaffRpc<Catalog>('staff_checkout_catalog'),
    quote: (input, operator, approvalToken) => asResult(() => callStaffRpc<QuoteResult>('staff_pos_quote', {
      p_operator_token: operator.operatorToken,
      p_scan_session: null,
      p_request: input,
      p_approval_token: approvalToken ?? null,
    })),
    finalize: (input, operator, approvalToken, expect) => {
      // 照合内容が無い呼び出しは、送る内容だけから作る（予約の顧客が分からないので予約の会計は成功と認めない）
      const expected = expect ?? saleExpectation(input)
      return asResult(async () => {
        const sale = expectRpcResult(await callStaffRpc<Sale>('staff_finalize_sale', {
          p: input,
          p_staff_name: operator.memberName,
          p_operator_token: operator.operatorToken,
          p_approval_token: approvalToken ?? null,
        }), 'staff_finalize_sale', s => isCompleteSale(s, expected, { anyClient: true }))
        const value = sale as unknown as Record<string, unknown>
        if (isCompleteSale(value, expected)) return sale
        // 顧客だけが違う：記録した顧客の今の統合先を読み取りで確かめ、返った顧客と同じときだけ統合として認める
        const mergedInto = expected.clientId ? await currentClientRoot(expected.clientId) : null
        if (isCompleteSale(value, expected, { mergedInto })) return sale
        throw new RpcError('response_mismatch', '通信結果を確認できませんでした。', { fn: 'staff_finalize_sale', data: sale }, 'supabase_error', { resultUnknown: true })
      })
    },
  }
}

/**
 * 顧客の今の統合先（client_root）。読み取り専用の staff_checkout_context が返す client.id を使う。
 * 読めない・見つからないときは null（統合を証明できないので、顧客の違う応答は成功にしない）。
 */
async function currentClientRoot(clientId: string): Promise<string | null> {
  try {
    const ctx = await callStaffRpc<CheckoutContext>('staff_checkout_context', { p_reservation_id: null, p_client_id: clientId })
    const id = (ctx as { client?: { id?: unknown } | null } | null)?.client?.id
    return typeof id === 'string' && id !== '' ? id : null
  } catch {
    return null
  }
}

/** 本部用：確定した会計の閲覧・取消（記録上の操作者は「本部」） */
export const hqSalesApi: SalesApi = {
  day: date => callHqRpc<SalesDay>('hq_sales', { p_date: date }),
  detail: id => callHqRpc<Sale>('hq_sale_detail', { p_id: id }),
  void: (id, reason, expectedTotal) => asResult(async () => expectRpcResult(await callHqRpc<Sale>('hq_void_sale', { p_id: id, p_reason: reason }), 'hq_void_sale', sale => isVoidedSale(sale, id, expectedTotal))),
}
