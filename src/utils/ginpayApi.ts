import { callCustomerRpc } from './customerSession'
import { callStaffRpc, expectRpcObject, expectRpcResult, RpcError } from './staffSession'
import { callHqRpc } from '../hq/hqSession'
import type { OperatorSession } from './posOperatorSession'
import type { PosActionError } from './checkoutApi'


export type GinpayTransactionType = 'charge_store' | 'charge_stripe' | 'payment' | 'refund' | 'adjustment' | 'void'
export type GinpayTransactionStatus = 'posted' | 'failed' | 'cancelled'

export interface GinpayAccount {
  id: string
  client_id: string
  client_name: string | null
  is_current_client: boolean
  status: 'active' | 'suspended' | 'closed'
  currency: 'JPY'
  /** 台帳合計（正本） */
  balance: number
  /** 照合用のキャッシュ */
  cached_balance: number
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
  /** 台帳合計（正本） */
  balance: number
  cached_balance: number
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

export type GinpayResult<T = GinpayTransaction> =
  | { ok: true; value: T }
  | ({ ok: false } & PosActionError)

export interface GinpayClientApi {
  /** staff: 店舗端末／hq: 本部（返金の確認方法が違う） */
  scope?: 'staff' | 'hq'
  ledger(clientId: string, limit?: number): Promise<GinpayLedger>
  openAccount?(clientId: string): Promise<GinpayLedger>
  /** idempotencyKey は必須。検証済み OperatorSession が必須 */
  chargeStore?(
    input: { clientId: string; amount: number; paymentMethod: 'cash' | 'credit' | 'qr' | 'other'; memo?: string; accountId?: string; idempotencyKey: string },
    operator: OperatorSession,
    approvalToken?: string | null
  ): Promise<GinpayResult>
  /** accountId・clientId は元取引の口座と操作した顧客（送信はしない。成功応答の照合に使う） */
  refund?(
    input: { transactionId: string; accountId: string; clientId: string; amount: number; reason: string; idempotencyKey: string },
    operator: OperatorSession,
    approvalToken?: string | null
  ): Promise<GinpayResult>
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
  ledger_mismatch_blocked: '残高の照合が取れていないため処理を止めました。本部に連絡してください。',
  invalid_amount: '金額が正しくありません。',
  invalid_payment_method: '支払方法が正しくありません。',
  invalid_transaction: 'この取引は対象外です。',
  invalid_value: '入力内容が正しくありません。',
  reason_required: '理由を入力してください。',
  transaction_not_found: '取引が見つかりません。',
  use_sale_void: '会計の支払いは、会計の取消から戻してください。',
  operator_auth_required: '操作者の認証が必要です。',
  operator_session_invalid: '操作者セッションが無効です。',
  approval_required: '店長または本部の承認が必要です。',
  hq_only: 'この操作は本部専用です。',
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

const isId = (v: unknown) => typeof v === 'string' && v !== ''

/**
 * 取引の顧客が、操作した顧客と同じか。ginpay_tx_json の client_id は口座の持ち主、root_client_id はその統合先。
 * 画面の顧客（台帳の client_id は統合先）はどちらかと一致する。
 */
function isClientOf(tx: Record<string, unknown>, clientId: string): boolean {
  return tx.client_id === clientId || tx.root_client_id === clientId
}

/** 店舗チャージの成功応答：送った顧客・口座（指定時）・キー・金額で記録された charge_store 取引（ginpay_tx_json） */
export function isCompleteCharge(tx: Record<string, unknown>, input: { clientId: string; accountId?: string | null; amount: number; idempotencyKey: string }): boolean {
  return isId(tx.id) && isId(tx.account_id) && tx.type === 'charge_store' && tx.status === 'posted'
    && (input.accountId == null || tx.account_id === input.accountId)
    && isClientOf(tx, input.clientId)
    && tx.amount === input.amount && tx.idempotency_key === input.idempotencyKey
}

/**
 * 返金の成功応答：送ったキーで、指定した元取引を指定額だけ戻した refund 取引。
 * 返金は元取引と同じ口座に記録される（ginpay_reverse_transaction）ので、元取引の口座 accountId と照合する。
 */
export function isCompleteRefund(tx: Record<string, unknown>, input: { transactionId: string; accountId: string; clientId: string; amount: number; idempotencyKey: string }): boolean {
  return isId(tx.id) && isId(input.accountId) && tx.account_id === input.accountId && isClientOf(tx, input.clientId)
    && tx.type === 'refund' && tx.status === 'posted'
    && typeof tx.amount === 'number' && Math.abs(tx.amount) === input.amount
    && tx.original_transaction_id === input.transactionId && tx.idempotency_key === input.idempotencyKey
}

async function asGinpayResult(fn: () => Promise<GinpayTransaction>, isComplete?: (tx: Record<string, unknown>) => boolean): Promise<GinpayResult> {
  try {
    const tx = await fn()
    return { ok: true, value: isComplete ? expectRpcResult(tx, 'ginpay', isComplete) : expectRpcObject(tx, 'ginpay') }
  } catch (err) {
    if (err instanceof RpcError && err.source === 'rpc_result') {
      const detail = (typeof err.detail === 'object' && err.detail !== null) ? err.detail : {}
      return { ok: false, error: err.code, ...(detail as object) }
    }
    if (err instanceof RpcError && err.source === 'local_precondition') {
      return { ok: false, error: err.code }
    }
    throw err
  }
}

export async function getCustomerGinpayLedger(limit = 50): Promise<GinpayLedger> {
  return callCustomerRpc<GinpayLedger>('customer_ginpay_ledger', { p_limit: limit })
}

export function createStaffGinpayApi(_actor?: () => string): GinpayClientApi {
  return {
    scope: 'staff',
    ledger: (clientId, limit = 50) => callStaffRpc<GinpayLedger>('staff_ginpay_ledger', { p_client_id: clientId, p_limit: limit }),
    openAccount: (clientId) => callStaffRpc<GinpayLedger>('staff_ginpay_open_account', { p_client_id: clientId, p_staff_name: _actor ? _actor() : '' }),
    chargeStore: (input, operator, approvalToken) => asGinpayResult(() => callStaffRpc<GinpayTransaction>('staff_ginpay_charge_store', {
      p_operator_token: operator.operatorToken,
      p_client_id: input.clientId,
      p_amount: input.amount,
      p_payment_method: input.paymentMethod,
      p_staff_name: operator.memberName,
      p_memo: input.memo ?? null,
      p_idempotency_key: input.idempotencyKey,
      p_approval_token: approvalToken ?? null,
      p_account_id: input.accountId ?? null,
    }), tx => isCompleteCharge(tx, input)),
    refund: (input, operator, approvalToken) => asGinpayResult(() => callStaffRpc<GinpayTransaction>('staff_ginpay_refund', {
      p_operator_token: operator.operatorToken,
      p_transaction_id: input.transactionId,
      p_amount: input.amount,
      p_staff_name: operator.memberName,
      p_reason: input.reason,
      p_idempotency_key: input.idempotencyKey,
      p_approval_token: approvalToken ?? null,
    }), tx => isCompleteRefund(tx, input)),
  }
}


export const hqGinpayApi: GinpayClientApi = {
  scope: 'hq',
  ledger: (clientId, limit = 100) => callHqRpc<GinpayLedger>('hq_ginpay_ledger', { p_client_id: clientId, p_limit: limit }),
  // 呼び出し元のキーをそのまま送る（確認のたびに新しいキーを作らない）。
  // hq_ginpay_refund は返金可能額の判定を冪等キーの照合より先に行うため、同じキーでも完全な再現は保証されない。
  // 結果不明のときに再送して確かめることはせず、台帳の読み取りで確認する（pendingConfirm）。
  refund: (input) => asGinpayResult(() => callHqRpc<GinpayTransaction>('hq_ginpay_refund', {
    p_transaction_id: input.transactionId,
    p_amount: input.amount,
    p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey,
  }), tx => isCompleteRefund(tx, input)),
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
