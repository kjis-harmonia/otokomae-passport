// 会計のクライアント。売上は「会計を確定」でだけ発生する（予約の金額は予定売上）。
// 確定は DB の1トランザクション（会計・明細・値引き・支払・GINPay 支払い・クーポン消費・予約の完了）。テーブルへは直接アクセスしない。
import { callStaffRpc, RpcBusinessError } from './staffSession'
import { callHqRpc } from '../hq/hqSession'
import type { Reservation } from './bookingApi'
import { priceServiceCatalog } from './checkoutPricing'

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
  blocked: 'transfer_pending' | 'welcome_weekend' | 'daily_rule' | 'gacha_menu' | 'ginoku_weekday' | 'free_menu' | null
  /** 銀オクの無料券（Staging だけ）：メニューの名前と使えるメニュー。値引きはその明細1つ分（画面と DB が同じ計算）。ほかの券・本番には無い */
  free_menu?: string | null
  menu_codes?: string[] | null
}
/** 予約に付いたガチャ券（お客様が AI 予約で付けた券。11/4） */
export interface CheckoutGacha {
  title: string
  /** 値引き額（無料券は null＝対象メニューの料金） */
  amount: number | null
  free_menu: string | null
  /** 使えるメニュー（null＝どれでも） */
  menu_codes: string[] | null
  weekday_only: boolean
}
export interface CheckoutContext {
  reservation: Reservation | null
  /** 予約に付いたガチャ券（無ければ null。DB が古いと無い） */
  gacha?: CheckoutGacha | null
  /** すでに確定済みの会計（同じ予約は2回会計できない） */
  paid_sale_id: string | null
  client: { id: string; name: string; app_linked: boolean } | null
  tickets: CheckoutTicket[]
  /** 顧客（統合された顧客を含む）の有効な GINPay 口座。口座は合算しない */
  ginpay_accounts: { id: string; client_name: string; balance: number; is_current_client: boolean; /** 銀オクの入札で押さえている額（Staging だけ） */ auction_held?: number }[]
  /** 停止中の口座がある（新規の支払いには使えない） */
  ginpay_suspended: boolean
  staff: { id: string; name: string }[]
  tax: { mode: 'inclusive' | 'exclusive' | null; rate: number | null }
}
/** 会計で選べる品目。正規サービスは kind（service|option|set）と group（カット・カラーなどのカテゴリ）、price_from（「〜」付き価格）を持つ */
export interface CatalogItem { id: string; name: string; category: ItemCategory; price: number; normal_price?: number | null; kind?: 'service' | 'option' | 'set'; group?: string | null; price_from?: boolean }
/** service_menus = 正規サービスマスター、menus = 正規サービスにつながっていない旧会計メニュー、products = 店販 */
export interface Catalog { service_menus: CatalogItem[]; menus: CatalogItem[]; products: CatalogItem[] }

export interface PriceQuoteItem {
  code: string
  name: string
  charge: number
  normal_price: number | null
  member_price: number | null
  member_label: string | null
  eligible: boolean | null
  price_from: boolean
}
export interface PriceQuote { starts_at: string; items: PriceQuoteItem[]; total: number; normal_total: number }

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
  /** 予約に付いたガチャ券を使う */
  use_gacha?: boolean
  manual_discount?: { amount: number; label: string }
  payment_method: PaymentMethod
  expected_total: number
  /** 初回送信前に端末へ保存する取引キー。再読み込み後も同じキーで照合する。 */
  idempotency_key: string
  /** GINPay 払いで支払う口座 */
  ginpay_account_id?: string
  /** 予約のない方の会計（会員ご本人の施術ではない）。来店・施術の記録・Welcome 券・お客様ごとの料金に入れない（11/11） */
  not_owner?: boolean
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
  /** 確定した会計の支払方法ごと（DB が古いと無い） */
  by_method?: { method: string; count: number; total: number }[]
  /** 銀Pay：会計で払われた額（うち特典分）と、その日の店頭チャージ（受け取った現金・付けた特典） */
  ginpay?: { paid: number; paid_bonus: number; charge_cash: number; charge_bonus: number; charge_count: number }
  /** その日にレジに入った現金（現金の会計＋店頭チャージの現金） */
  cash_in?: number
  rows: { id: string; status: 'completed' | 'voided'; completed_at: string; customer_name: string | null; stylist_name: string | null; payment_method: string | null; total: number; items: string | null; has_reservation: boolean }[]
}

export type CheckoutResult<T> = T | { error: string }

export interface CheckoutApi {
  backend: string
  operator(): string
  context(reservationId: string | null, clientId: string | null): Promise<CheckoutContext>
  catalog(startsAt?: string | null): Promise<Catalog>
  quote(menuCodes: string[], startsAt: string | null): Promise<PriceQuote>
  lookup(idempotencyKey: string): Promise<Sale | null>
  finalize(input: SaleInput, operator?: string): Promise<CheckoutResult<Sale>>
  /** 予約に付いた銀Pay の仮支払い（お客様が予約のときに押さえた額）。店舗端末だけ */
  ginpayHold?(reservationId: string): Promise<{ amount: number; account_id: string } | null>
  /** そのお客様の「いつもの」料金（店で最後に払った、券を引く前のメニューの金額）。メニューの code ごと */
  clientMenuPrices?(clientId: string): Promise<{ menu_code: string; price: number }[]>
}
export interface SalesApi {
  day(date: string): Promise<SalesDay>
  detail(id: string): Promise<Sale>
  void(id: string, reason: string): Promise<CheckoutResult<Sale>>
}

export const PAYMENT_LABEL: Record<string, string> = { cash: '現金', card: 'カード', credit: 'カード', qr: 'QR等', other: 'その他', ginpay: '銀Pay' }
export const TICKET_BLOCK_LABEL: Record<string, string> = {
  transfer_pending: '譲渡中', welcome_weekend: '土日は使えません', daily_rule: '本日は別の割引を利用済み', gacha_menu: '対象のメニューがありません',
  ginoku_weekday: '平日のみ使えます', free_menu: '対象のメニューがありません',
}

export const CHECKOUT_ERROR_MESSAGE: Record<string, string> = {
  already_paid: 'この予約はすでに会計済みです。',
  invalid_status: 'この予約は会計できない状態です（キャンセル・無断キャンセル）。',
  total_mismatch: '金額が更新されました。内容を確認してもう一度確定してください。',
  discount_exceeds: '値引きが合計を超えています。',
  invalid_items: 'メニュー・商品の内容を確認してください（単価0円以上・数量1〜99・値引きは小計まで）。',
  invalid_discount: '値引きの金額と理由を入力してください。',
  invalid_tickets: '使えないクーポンが含まれています（使用済み・期限切れ・他の方の券）。',
  mixed_types: 'メンテナンスクーポンは、ほかの券と一緒に使えません。',
  transfer_pending: '譲渡中のクーポンは使えません。',
  welcome_weekend: 'パーマのクーポン（Welcome・再来店）は平日のみ使えます。',
  welcome_perm_only: 'パーマのクーポン（Welcome・再来店）はパーマのメニューのときだけ使えます。',
  daily_rule: '本日はすでに別の割引を利用済みです。',
  gacha_invalid: 'ガチャ券が使えませんでした（使用済み・予約から外れています）。画面を開き直してください。',
  gacha_weekday: 'このガチャ券は平日のみ使えます。',
  gacha_menu: 'ガチャ券の対象のメニューが会計にありません。',
  // 銀オクの券（Staging だけ・11/12）
  ginoku_weekday: '銀オクの券は平日のみ使えます（土日・祝日は使えません）。',
  free_menu: '無料券の対象のメニューが会計にありません（1つのメニューに使えるのは1枚です）。',
  // 11/11 店舗端末点検：サーバーが断る理由で、案内が無かったもの
  gacha_companion: 'このガチャ券は、お連れ様の会計では使えません（無料の券だけ使えます）。',
  welcome_owner_only: 'Welcomeクーポンは、発行された会員ご本人の施術だけに使えます（お連れ様・予約のない方の会計では使えません）。',
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
  return CHECKOUT_ERROR_MESSAGE[code] ?? '会計を確定できませんでした。内容と通信を確かめて、もう一度お試しください。'
}

/** ガチャ券の値引き額（DB の finalize_sale と同じ計算）。対象メニューが会計に無ければ null */
export function gachaAmount(g: CheckoutGacha, lines: SaleLine[]): number | null {
  const line = g.menu_codes ? lines.find(l => (l.source === 'reservation' || l.source === 'service_menu') && !!l.ref_id && g.menu_codes!.includes(l.ref_id)) : undefined
  if (g.menu_codes && !line) return null
  return g.amount ?? Math.min(line!.unit_price, line!.unit_price * line!.quantity - line!.discount)
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
    // サーバーが {error} で断った（会計は入っていない）：一覧に無い理由でも断りとして返し、端末の未確認の会計を消せるように（11/11 店舗端末点検）
    if (err instanceof RpcBusinessError && code) return { error: code }
    const message = (err as { message?: string }).message
    if (message && CHECKOUT_ERROR_MESSAGE[message]) return { error: message }
    throw err
  }
}

/** 店舗端末用。会計の記録に残る操作者名を都度渡す */
export function createStaffCheckoutApi(actor: () => string): CheckoutApi {
  const quote = (codes: string[], startsAt: string | null) => callStaffRpc<PriceQuote>('staff_price_quote', { p_menu_codes: codes, p_starts_at: startsAt })
  return {
    backend: import.meta.env.VITE_SUPABASE_URL ?? '',
    operator: actor,
    context: (reservationId, clientId) => callStaffRpc<CheckoutContext>('staff_checkout_context', { p_reservation_id: reservationId, p_client_id: clientId }),
    catalog: async (startsAt = null) => {
      const catalog = await callStaffRpc<Catalog>('staff_checkout_catalog')
      return { ...catalog, service_menus: await priceServiceCatalog(catalog.service_menus, quote, startsAt) }
    },
    quote,
    lookup: key => callStaffRpc<Sale | null>('staff_checkout_result', { p_idempotency_key: key }),
    finalize: (input, operator) => asResult(() => callStaffRpc<Sale>('staff_finalize_sale', { p: input, p_staff_name: operator ?? actor() })),
    ginpayHold: async id => (await callStaffRpc<{ hold: { amount: number; account_id: string } | null }>('staff_ginpay_hold', { p_reservation_id: id })).hold,
    clientMenuPrices: id => callStaffRpc<{ menu_code: string; price: number }[]>('staff_client_menu_prices', { p_client_id: id }),
  }
}

/** 本部用：確定した会計の閲覧・取消（記録上の操作者は「本部」） */
export const hqSalesApi: SalesApi = {
  day: date => callHqRpc<SalesDay>('hq_sales', { p_date: date }),
  detail: id => callHqRpc<Sale>('hq_sale_detail', { p_id: id }),
  void: (id, reason) => asResult(() => callHqRpc<Sale>('hq_void_sale', { p_id: id, p_reason: reason })),
}
