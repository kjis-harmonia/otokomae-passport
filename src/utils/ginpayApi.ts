import { callCustomerRpc } from './customerSession'
import { callStaffRpc, RpcError } from './staffSession'
import { callHqRpc } from '../hq/hqSession'

export type GinpayTransactionType = 'charge_store' | 'charge_stripe' | 'payment' | 'refund' | 'adjustment' | 'void'
export type GinpayTransactionStatus = 'posted' | 'failed' | 'cancelled'

export interface GinpayAccount {
  id: string
  client_id: string
  client_name: string | null
  is_current_client: boolean
  status: 'active' | 'suspended' | 'closed'
  currency: 'JPY'
  balance: number
  ledger_balance: number
  consistent: boolean
  created_at: string
  updated_at: string
}

export interface GinpayTransaction {
  id: string
  account_id: string
  client_id: string
  client_name: string | null
  root_client_id: string | null
  amount: number
  type: GinpayTransactionType
  status: GinpayTransactionStatus
  accounting_session_id: string | null
  stripe_event_id: string | null
  stripe_payment_intent_id: string | null
  stripe_checkout_session_id: string | null
  stripe_charge_id: string | null
  operator_type: 'customer' | 'staff' | 'hq' | 'system' | 'stripe'
  operator_name: string | null
  reason: string | null
  memo: string | null
  idempotency_key: string
  original_transaction_id: string | null
  created_at: string
  balance?: number
  idempotent?: boolean
}

export interface GinpayLedger {
  client_id: string
  client_name: string | null
  app_linked: boolean
  balance: number
  ledger_balance: number
  consistent: boolean
  multiple_accounts: boolean
  accounts: GinpayAccount[]
  transactions: GinpayTransaction[]
}

export type GinpayAuditEntry = GinpayTransaction

export interface GinpayReconcileResult {
  checked_at: string
  total_cached_balance: number
  total_ledger_balance: number
  consistent: boolean
  accounts: GinpayAccount[]
}

export type GinpayResult<T = GinpayTransaction> = { ok: true; value: T } | { ok: false; error: string }

export interface GinpayClientApi {
  ledger(clientId: string, limit?: number): Promise<GinpayLedger>
  openAccount?(clientId: string): Promise<GinpayLedger>
  /** idempotencyKey はチャージの確認ごとに1つ（再送しても二重にチャージしない）。口座が複数あるときは accountId が必要 */
  chargeStore?(input: { clientId: string; amount: number; paymentMethod: 'cash' | 'credit' | 'qr' | 'other'; memo?: string; accountId?: string; idempotencyKey?: string }): Promise<GinpayResult>
  refund?(input: { transactionId: string; amount: number; reason: string }): Promise<GinpayResult>
  void?(input: { transactionId: string; reason: string }): Promise<GinpayResult>
  adjustment?(input: { clientId: string; amount: number; reason: string; accountId?: string }): Promise<GinpayResult>
}

export const GINPAY_ERROR_MESSAGE: Record<string, string> = {
  account_not_active: 'GINPay口座が停止中です。',
  account_not_found: 'GINPay口座が見つかりません。',
  account_selection_required: 'チャージする口座を選んでください。',
  accounting_session_required: '会計IDが必要です。',
  already_reversed: 'すでに全額取り消されています。',
  amount_exceeds_refundable: '返金できる金額を超えています。',
  client_not_found: '顧客が見つかりません。',
  created_by_required: '操作者を選んでください。',
  idempotency_key_required: '二重送信防止キーがありません。',
  idempotency_conflict: '同じ操作が別の内容で記録済みです。画面を開き直してください。',
  insufficient_balance: '残高が不足しています。',
  invalid_amount: '金額が正しくありません。',
  invalid_payment_method: '支払方法が正しくありません。',
  invalid_transaction: 'この取引は対象外です。',
  invalid_value: '入力内容が正しくありません。',
  reason_required: '理由を入力してください。',
  transaction_not_found: '取引が見つかりません。',
  use_sale_void: '会計の支払いは、会計の取消から戻してください。',
}

export const GINPAY_TYPE_LABEL: Record<GinpayTransactionType, string> = {
  charge_store: '店舗チャージ',
  charge_stripe: 'Stripeチャージ',
  payment: '支払い',
  refund: '返金',
  adjustment: '調整',
  void: '取消',
}

export function ginpayErrorMessage(code: string): string {
  return GINPAY_ERROR_MESSAGE[code] ?? 'GINPayの処理に失敗しました。通信環境を確認してください。'
}

export function yen(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : `¥${n.toLocaleString()}`
}

export function idempotencyKey(prefix: string): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}:${random}`
}

async function asGinpayResult(fn: () => Promise<GinpayTransaction>): Promise<GinpayResult> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    if (err instanceof RpcError && GINPAY_ERROR_MESSAGE[err.code]) return { ok: false, error: err.code }
    throw err
  }
}

export async function getCustomerGinpayLedger(limit = 50): Promise<GinpayLedger> {
  return callCustomerRpc<GinpayLedger>('customer_ginpay_ledger', { p_limit: limit })
}

export function createStaffGinpayApi(actor: () => string): GinpayClientApi {
  return {
    ledger: (clientId, limit = 50) => callStaffRpc<GinpayLedger>('staff_ginpay_ledger', { p_client_id: clientId, p_limit: limit }),
    openAccount: (clientId) => callStaffRpc<GinpayLedger>('staff_ginpay_open_account', { p_client_id: clientId, p_staff_name: actor() }),
    chargeStore: (input) => asGinpayResult(() => callStaffRpc<GinpayTransaction>('staff_ginpay_charge_store', {
      p_client_id: input.clientId,
      p_amount: input.amount,
      p_payment_method: input.paymentMethod,
      p_staff_name: actor(),
      p_memo: input.memo ?? null,
      p_idempotency_key: input.idempotencyKey ?? idempotencyKey('staff-store-charge'),
      p_account_id: input.accountId ?? null,
    })),
    refund: (input) => asGinpayResult(() => callStaffRpc<GinpayTransaction>('staff_ginpay_refund', {
      p_transaction_id: input.transactionId,
      p_amount: input.amount,
      p_staff_name: actor(),
      p_reason: input.reason,
      p_idempotency_key: idempotencyKey('staff-refund'),
    })),
    void: (input) => asGinpayResult(() => callStaffRpc<GinpayTransaction>('staff_ginpay_void', {
      p_transaction_id: input.transactionId,
      p_staff_name: actor(),
      p_reason: input.reason,
      p_idempotency_key: idempotencyKey('staff-void'),
    })),
    adjustment: (input) => asGinpayResult(() => callStaffRpc<GinpayTransaction>('staff_ginpay_adjustment', {
      p_client_id: input.clientId,
      p_amount: input.amount,
      p_staff_name: actor(),
      p_reason: input.reason,
      p_idempotency_key: idempotencyKey('staff-adjustment'),
      p_account_id: input.accountId ?? null,
    })),
  }
}

export const hqGinpayApi: GinpayClientApi = {
  ledger: (clientId, limit = 100) => callHqRpc<GinpayLedger>('hq_ginpay_ledger', { p_client_id: clientId, p_limit: limit }),
  refund: (input) => asGinpayResult(() => callHqRpc<GinpayTransaction>('hq_ginpay_refund', {
    p_transaction_id: input.transactionId,
    p_amount: input.amount,
    p_reason: input.reason,
    p_idempotency_key: idempotencyKey('hq-refund'),
  })),
  void: (input) => asGinpayResult(() => callHqRpc<GinpayTransaction>('hq_ginpay_void', {
    p_transaction_id: input.transactionId,
    p_reason: input.reason,
    p_idempotency_key: idempotencyKey('hq-void'),
  })),
  adjustment: (input) => asGinpayResult(() => callHqRpc<GinpayTransaction>('hq_ginpay_adjustment', {
    p_client_id: input.clientId,
    p_amount: input.amount,
    p_reason: input.reason,
    p_idempotency_key: idempotencyKey('hq-adjustment'),
    p_account_id: input.accountId ?? null,
  })),
}

export async function hqGinpayAudit(input: {
  from?: string | null
  to?: string | null
  clientId?: string | null
  type?: GinpayTransactionType | null
  limit?: number
  offset?: number
} = {}): Promise<GinpayAuditEntry[]> {
  return (await callHqRpc<GinpayAuditEntry[] | null>('hq_ginpay_audit', {
    p_from: input.from ?? null,
    p_to: input.to ?? null,
    p_client_id: input.clientId ?? null,
    p_type: input.type ?? null,
    p_limit: input.limit ?? 100,
    p_offset: input.offset ?? 0,
  })) ?? []
}

export async function hqGinpayReconcile(): Promise<GinpayReconcileResult> {
  return callHqRpc<GinpayReconcileResult>('hq_ginpay_reconcile')
}
