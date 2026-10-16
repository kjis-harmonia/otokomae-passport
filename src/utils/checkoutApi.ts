// 会計のクライアント。売上は「会計を確定」でだけ発生する（予約の金額は予定売上）。
// 確定は DB の1トランザクション（会計・明細・値引き・支払・GINPay 支払い・クーポン消費・予約の完了）。テーブルへは直接アクセスしない。
import { callStaffRpc } from './staffSession'
import { callHqRpc } from '../hq/hqSession'
import type { Reservation } from './bookingApi'

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
  ginpay_accounts: { id: string; client_name: string; balance: number; is_current_client: boolean }[]
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
  /** 会計画面ごとの一意キー。同じキーの再送は同じ会計を返す（二重タップで二重会計・二重決済しない） */
  idempotency_key: string
  /** GINPay 払いで支払う口座 */
  ginpay_account_id?: string
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

export type CheckoutResult<T> = T | { error: string }

export interface CheckoutApi {
  context(reservationId: string | null, clientId: string | null): Promise<CheckoutContext>
  catalog(): Promise<Catalog>
  finalize(input: SaleInput): Promise<CheckoutResult<Sale>>
}
export interface SalesApi {
  day(date: string): Promise<SalesDay>
  detail(id: string): Promise<Sale>
  void(id: string, reason: string): Promise<CheckoutResult<Sale>>
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
  client_not_found: '顧客が見つかりません。',
  not_found: '見つかりません。',
  reason_required: '取消の理由を入力してください。',
  insufficient_balance: 'GINPayの残高が不足しています。',
  ginpay_requires_client: 'GINPayは顧客を選んだ会計でのみ使えます。',
  ginpay_account_not_found: 'GINPay口座がありません。顧客台帳のGINPayで口座を開設・チャージしてください。',
  account_selection_required: '支払うGINPay口座を選んでください。',
  ginpay_account_suspended: 'GINPay口座が停止中のため支払えません。',
  invalid_amount: '0円の会計はGINPayで支払えません。',
  ginpay_account_not_active: 'GINPay口座が停止中のため取消できません。本部で口座の状態を確認してください。',
  ginpay_already_reversed: 'GINPayの支払いはすでに取り消されています。',
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

async function asResult<T>(fn: () => Promise<T>): Promise<CheckoutResult<T>> {
  try {
    return await fn()
  } catch (err) {
    // 業務エラー（{error}）は code、確定・取消の途中で DB が取り消した場合は message に理由が入る
    const code = (err as { code?: string }).code
    if (code && CHECKOUT_ERROR_MESSAGE[code]) return { error: code }
    const message = (err as { message?: string }).message
    if (message && CHECKOUT_ERROR_MESSAGE[message]) return { error: message }
    throw err
  }
}

/** 店舗端末用。会計の記録に残る操作者名を都度渡す */
export function createStaffCheckoutApi(actor: () => string): CheckoutApi {
  return {
    context: (reservationId, clientId) => callStaffRpc<CheckoutContext>('staff_checkout_context', { p_reservation_id: reservationId, p_client_id: clientId }),
    catalog: () => callStaffRpc<Catalog>('staff_checkout_catalog'),
    finalize: input => asResult(() => callStaffRpc<Sale>('staff_finalize_sale', { p: input, p_staff_name: actor() })),
  }
}

/** 本部用：確定した会計の閲覧・取消（記録上の操作者は「本部」） */
export const hqSalesApi: SalesApi = {
  day: date => callHqRpc<SalesDay>('hq_sales', { p_date: date }),
  detail: id => callHqRpc<Sale>('hq_sale_detail', { p_id: id }),
  void: (id, reason) => asResult(() => callHqRpc<Sale>('hq_void_sale', { p_id: id, p_reason: reason })),
}
