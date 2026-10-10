// 未解決の金銭操作の「結果を確認」（B-2A）。確認方法は操作の種類ごとにここだけで決める。
// B-2C で読み取り専用の status RPC を入れるときは、この関数の中身を差し替える。
//
// 確認方法と限界：
//   会計              同じ内容・同じキーで staff_finalize_sale を再送する（メモリに内容がある間だけ）。
//                     確定済みなら同じ会計が返る。未確定なら、この再送が新しい会計として確定し得る（限界）。
//   GINPay チャージ    台帳を読んで同じキーの取引を探す。無ければ、メモリの内容で同じキーを再送する。
//                     再送は 50,000 円以下なら新しいチャージとして確定し得る（限界）。
//   GINPay 返金        台帳を読む。無ければメモリの内容で承認なしに再送する（承認なしでは新しい返金にならない）。
//   チケット発行       承認なしで同じキーを再送する（承認なしでは新しい発行にならない）。再読み込み後も可能。
//   本部の GINPay 返金  台帳の読み取りだけ。hq_ginpay_refund は同じキーでも完全な再現を保証しないため再送しない。
//   本部の会計取消     会計の詳細を読む。同じ合計で voided のときだけ確定。completed は未解決のまま。
//
// どの方法でも、業務エラー・見つからない・通信できないは「実行されなかった」証明にしない。記録はそのまま残る。
// 成功応答は記録した内容（金額・キー・顧客・口座・予約など）と照合し、1つでも合わなければ確定にしない。

import type { CheckoutApi, SaleExpectation, SaleInput, SalesApi, Sale } from './checkoutApi'
import type { GinpayClientApi, GinpayTransaction } from './ginpayApi'
import { isCompleteCharge, isCompleteRefund } from './ginpayApi'
import type { IssueTicketsInput, TicketIssueResult } from './ticketStore'
import type { OperatorSession } from './posOperatorSession'
import { checkoutContextOf, getPendingInput, settlePendingOp, target, type PendingDraft, type PendingOp, type PendingOpOf } from './pendingOps'
import { resolveSaleIdentity } from './saleIdentity'

export interface ChargePendingInput {
  clientId: string
  amount: number
  paymentMethod: 'cash' | 'credit' | 'qr' | 'other'
  memo?: string
  accountId?: string
  idempotencyKey: string
}
/** accountId は元取引の口座、clientId は操作した顧客（送信はせず、成功応答の照合に使う） */
export interface RefundPendingInput { transactionId: string; accountId: string; clientId: string; amount: number; reason: string; idempotencyKey: string }

export interface ConfirmDeps {
  operator: OperatorSession | null
  checkout?: CheckoutApi
  ginpay?: GinpayClientApi
  sales?: SalesApi
  issueTickets?: (input: IssueTicketsInput, operator: OperatorSession, approvalToken?: string | null) => Promise<TicketIssueResult>
}

// ── 保存する記録の組み立て（項目を1つずつ選ぶ。送信内容を丸ごと保存しない） ────────────

function who(operator: OperatorSession) {
  return { operatorId: operator.staffMemberId || null, operatorName: operator.memberName || null }
}

/**
 * 会計の記録。対象・顧客はサーバーが決める顧客（saleIdentity）で記録する。
 * reservationClientId は予約の会計で、会計画面が読んだ予約の顧客（client_root。顧客の無い予約は null）。
 */
export function draftCheckout(input: SaleInput, operator: OperatorSession, reservationClientId?: string | null): PendingDraft {
  const identity = resolveSaleIdentity(input, reservationClientId)
  return {
    kind: 'checkout',
    key: input.idempotency_key,
    targets: identity.targets,
    amount: input.expected_total,
    snapshot: {
      context: identity.context,
      reservationId: identity.reservationId,
      clientId: identity.clientId,
      stylistId: input.stylist_id,
      paymentMethod: input.payment_method,
      expectedTotal: input.expected_total,
      ginpayAccountId: input.ginpay_account_id ?? null,
      ticketIds: [...input.ticket_ids],
      items: input.items.map(i => ({ source: i.source, refId: i.ref_id ?? null, category: i.category, unitPrice: i.unit_price, quantity: i.quantity, discount: i.discount })),
      manualDiscount: input.manual_discount?.amount ?? 0,
    },
    ...who(operator),
  }
}

/** チャージの記録。口座（accountId）が無いチャージは記録できない（beginPendingOp が account_unknown で止める） */
export function draftCharge(input: ChargePendingInput, operator: OperatorSession): PendingDraft {
  return {
    kind: 'ginpay_charge',
    key: input.idempotencyKey,
    targets: [target.client(input.clientId), ...(input.accountId ? [target.account(input.accountId)] : [])],
    amount: input.amount,
    snapshot: { clientId: input.clientId, accountId: input.accountId ?? null, amount: input.amount, paymentMethod: input.paymentMethod },
    ...who(operator),
  }
}

export function draftRefund(kind: 'ginpay_refund' | 'hq_ginpay_refund', clientId: string, input: RefundPendingInput, operator: OperatorSession | null): PendingDraft {
  return {
    kind,
    key: input.idempotencyKey,
    targets: [target.client(clientId), target.transaction(input.transactionId), ...(input.accountId ? [target.account(input.accountId)] : [])],
    amount: input.amount,
    snapshot: { clientId, transactionId: input.transactionId, accountId: input.accountId, amount: input.amount },
    ...(operator ? who(operator) : { operatorId: null, operatorName: null }),
  }
}

export function draftTicketIssue(input: IssueTicketsInput, operator: OperatorSession): PendingDraft {
  return {
    kind: 'ticket_issue',
    key: input.idempotencyKey,
    targets: [target.user(input.userId)],
    amount: input.amount * input.quantity,
    snapshot: { userId: input.userId, ticketType: input.type, amount: input.amount, quantity: input.quantity },
    ...who(operator),
  }
}

export function draftHqVoid(sale: { id: string; total: number }): PendingDraft {
  return {
    kind: 'hq_void',
    key: sale.id,
    targets: [target.sale(sale.id)],
    amount: sale.total,
    snapshot: { saleId: sale.id },
    operatorId: null,
    operatorName: null,
  }
}

/**
 * 記録した会計から、成功応答の照合内容を作る。旧形式の予約の会計は予約の顧客が記録に無いので照合できない（null）。
 * 旧形式の予約なしの会計は、サーバーでは匿名なので匿名として照合する。
 */
export function checkoutExpectation(op: PendingOpOf<'checkout'>): SaleExpectation | null {
  const s = op.snapshot
  const context = checkoutContextOf(s)
  if (s.context === undefined && context === 'reservation') return null
  return {
    idempotencyKey: op.key,
    total: s.expectedTotal,
    reservationId: context === 'anonymous' ? null : s.reservationId,
    clientId: context === 'anonymous' ? null : s.clientId,
    paymentMethod: s.paymentMethod,
    ginpayAccountId: s.ginpayAccountId,
    ticketCount: s.ticketIds.length,
  }
}

export type UnresolvedReason =
  | 'transport'     // 通信できない・応答が読めない
  | 'response_mismatch'   // 成功の形の応答が、記録した内容（金額・キー・顧客など）と合わない
  | 'identity_unverified' // 記録から照合する内容が作れない（旧形式の記録・元取引が見つからない）
  | 'business'      // 業務エラーが返った（先の要求が実行されなかった証明ではない）
  | 'not_found'     // 読み取りで見つからない（まだ確定していない、または後で確定し得る）
  | 'no_snapshot'   // 再読み込み等で、同じ内容で確認するための送信内容が残っていない
  | 'other_screen'  // この画面では確認できない種類の操作
  | 'not_voided'    // 会計はまだ確定（completed）のまま

export type ConfirmOutcome =
  | { status: 'confirmed'; value: unknown }
  | { status: 'approval_required'; action: string; requestHash: string; input: unknown }
  | { status: 'operator_required'; operatorName: string | null }
  | { status: 'unresolved'; reason: UnresolvedReason; code?: string }

const OPERATOR_AUTH_CODES = new Set(['operator_auth_required', 'operator_session_invalid', 'invalid_operator_session', 'operator_session_expired', 'staff_auth_required'])

async function confirmed(op: PendingOp, value: unknown): Promise<ConfirmOutcome> {
  try {
    await settlePendingOp(op.id, 'server_confirmed')
  } catch {
    // 記録を消せなくても確定は確定。記録は残り、次の確認でもう一度消す
  }
  return { status: 'confirmed', value }
}

/** 再送には、最初に送った操作者が必要（サーバーは操作者を含めて同じ依頼かを照合する） */
function operatorFor(op: PendingOp, operator: OperatorSession | null): OperatorSession | ConfirmOutcome {
  if (!operator || (op.operatorId !== null && operator.staffMemberId !== op.operatorId)) {
    return { status: 'operator_required', operatorName: op.operatorName }
  }
  return operator
}

function fromBusiness(code: string, op: PendingOp, input: unknown, res: { action?: unknown; request_hash?: unknown }): ConfirmOutcome {
  if (OPERATOR_AUTH_CODES.has(code)) return { status: 'operator_required', operatorName: op.operatorName }
  if (code === 'approval_required' && typeof res.action === 'string' && typeof res.request_hash === 'string') {
    return { status: 'approval_required', action: res.action, requestHash: res.request_hash, input }
  }
  return { status: 'unresolved', reason: 'business', code }
}

async function readLedger(ginpay: GinpayClientApi, clientId: string): Promise<GinpayTransaction[] | 'transport'> {
  try {
    const ledger = await ginpay.ledger(clientId, 200)
    return Array.isArray(ledger?.transactions) ? ledger.transactions : 'transport'
  } catch {
    return 'transport'
  }
}

/** 再送する内容の口座が、記録した口座と同じ（口座の分からない旧形式の記録は再送しない） */
function sameAccount(op: PendingOp, input: unknown): boolean {
  if (op.kind !== 'ginpay_charge' && op.kind !== 'ginpay_refund' && op.kind !== 'hq_ginpay_refund') return false
  const recorded = op.snapshot.accountId ?? null
  return recorded !== null && (input as { accountId?: unknown } | null)?.accountId === recorded
}

/** 成功の形の応答が記録した内容と合わなかった（expectRpcResult）。結果不明として記録を残す */
function isResponseMismatch(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 'response_mismatch'
}

export async function confirmPendingOp(op: PendingOp, deps: ConfirmDeps): Promise<ConfirmOutcome> {
  try {
    switch (op.kind) {
      case 'checkout': {
        if (!deps.checkout) return { status: 'unresolved', reason: 'other_screen' }
        const input = getPendingInput<SaleInput>(op.id)
        if (!input) return { status: 'unresolved', reason: 'no_snapshot' }
        const expect = checkoutExpectation(op)
        if (!expect) return { status: 'unresolved', reason: 'identity_unverified' }
        const operator = operatorFor(op, deps.operator)
        if ('status' in operator) return operator
        const res = await deps.checkout.finalize(input, operator, null, expect)
        if ('error' in res) return fromBusiness(res.error, op, input, {}) // 会計の承認は見積もりで取るため、ここでは承認に進まない
        return confirmed(op, res)
      }
      case 'ginpay_charge':
      case 'ginpay_refund':
      case 'hq_ginpay_refund': {
        if (!deps.ginpay) return { status: 'unresolved', reason: 'other_screen' }
        const ledger = await readLedger(deps.ginpay, op.snapshot.clientId)
        if (ledger === 'transport') return { status: 'unresolved', reason: 'transport' }
        const found = ledger.find(t => t.idempotency_key === op.key) ?? null
        if (found) {
          const tx = found as unknown as Record<string, unknown>
          if (op.kind === 'ginpay_charge') {
            const ok = isCompleteCharge(tx, { clientId: op.snapshot.clientId, accountId: op.snapshot.accountId, amount: op.amount, idempotencyKey: op.key })
            return ok ? confirmed(op, found) : { status: 'unresolved', reason: 'response_mismatch' }
          }
          // 返金は元取引の口座と照合する（送った内容がメモリに無ければ、台帳の元取引から口座を知る）
          const accountId = op.snapshot.accountId ?? getPendingInput<RefundPendingInput>(op.id)?.accountId
            ?? ledger.find(t => t.id === op.snapshot.transactionId)?.account_id
          if (!accountId) return { status: 'unresolved', reason: 'identity_unverified' }
          const ok = isCompleteRefund(tx, { transactionId: op.snapshot.transactionId, accountId, clientId: op.snapshot.clientId, amount: op.amount, idempotencyKey: op.key })
          return ok ? confirmed(op, found) : { status: 'unresolved', reason: 'response_mismatch' }
        }
        // 本部の返金は再送しない（返金可能額の判定がキーの照合より先のため、同じキーでも再現されない）
        if (op.kind === 'hq_ginpay_refund') return { status: 'unresolved', reason: 'not_found' }
        const input = getPendingInput<ChargePendingInput | RefundPendingInput>(op.id)
        if (!input) return { status: 'unresolved', reason: 'not_found' }
        if (!sameAccount(op, input)) return { status: 'unresolved', reason: 'identity_unverified' }
        const operator = operatorFor(op, deps.operator)
        if ('status' in operator) return operator
        const call = op.kind === 'ginpay_charge' ? deps.ginpay.chargeStore : deps.ginpay.refund
        if (!call) return { status: 'unresolved', reason: 'other_screen' }
        const res = await (call as (i: unknown, o: OperatorSession, a?: string | null) => ReturnType<NonNullable<GinpayClientApi['refund']>>)(input, operator, null)
        if (!res.ok) return fromBusiness(res.error, op, input, res)
        return confirmed(op, res.value)
      }
      case 'ticket_issue': {
        if (!deps.issueTickets) return { status: 'unresolved', reason: 'other_screen' }
        const operator = operatorFor(op, deps.operator)
        if ('status' in operator) return operator
        // 承認なしの再送では新しい発行にならない（同じキーの発行があればそれが返り、無ければ approval_required）
        const input: IssueTicketsInput = getPendingInput<IssueTicketsInput>(op.id) ?? {
          userId: op.snapshot.userId,
          type: op.snapshot.ticketType as IssueTicketsInput['type'],
          amount: op.snapshot.amount,
          quantity: op.snapshot.quantity,
          customerName: '',
          idempotencyKey: op.key,
        }
        const res = await deps.issueTickets(input, operator, null)
        if ('error' in res) return fromBusiness(res.error, op, input, res)
        return confirmed(op, res)
      }
      case 'hq_void': {
        if (!deps.sales) return { status: 'unresolved', reason: 'other_screen' }
        const sale: Sale = await deps.sales.detail(op.snapshot.saleId)
        if (!sale || sale.id !== op.snapshot.saleId) return { status: 'unresolved', reason: 'transport' }
        if (sale.status !== 'voided') return { status: 'unresolved', reason: 'not_voided' }
        // 取消の対象として記録した会計の合計と一致するときだけ確定
        return sale.total === op.amount ? confirmed(op, sale) : { status: 'unresolved', reason: 'response_mismatch' }
      }
    }
  } catch (err) {
    return { status: 'unresolved', reason: isResponseMismatch(err) ? 'response_mismatch' : 'transport' }
  }
}

/**
 * 結果不明の操作を、管理者承認つきで同じ内容・同じキーのまま送る（チャージ・返金・チケット発行）。
 * 成功応答を確かめたときだけ記録を消す。業務エラー・通信不明では記録を残す。
 */
export async function sendPendingWithApproval(op: PendingOp, input: unknown, approvalToken: string, deps: ConfirmDeps): Promise<ConfirmOutcome> {
  const operator = operatorFor(op, deps.operator)
  if ('status' in operator) return operator
  try {
    if (op.kind === 'ticket_issue' && deps.issueTickets) {
      const res = await deps.issueTickets(input as IssueTicketsInput, operator, approvalToken)
      if ('error' in res) return fromBusiness(res.error, op, input, {})
      return confirmed(op, res)
    }
    if ((op.kind === 'ginpay_charge' || op.kind === 'ginpay_refund') && deps.ginpay) {
      if (!sameAccount(op, input)) return { status: 'unresolved', reason: 'identity_unverified' }
      const res = op.kind === 'ginpay_charge'
        ? await deps.ginpay.chargeStore?.(input as ChargePendingInput, operator, approvalToken)
        : await deps.ginpay.refund?.(input as RefundPendingInput, operator, approvalToken)
      if (!res) return { status: 'unresolved', reason: 'other_screen' }
      if (!res.ok) return fromBusiness(res.error, op, input, {})
      return confirmed(op, res.value)
    }
    return { status: 'unresolved', reason: 'other_screen' }
  } catch (err) {
    return { status: 'unresolved', reason: isResponseMismatch(err) ? 'response_mismatch' : 'transport' }
  }
}

/** 確認しても解決しなかったときの案内（「再度お試しください」とは言わない） */
export function unresolvedMessage(outcome: ConfirmOutcome): string {
  if (outcome.status === 'operator_required') {
    return outcome.operatorName
      ? `確認には最初に操作した ${outcome.operatorName} さんの認証が必要です。`
      : '確認には操作者の認証が必要です。'
  }
  if (outcome.status === 'approval_required') return '同じ内容で続けるには管理者承認が必要です。'
  if (outcome.status !== 'unresolved') return ''
  switch (outcome.reason) {
    case 'transport': return 'まだ結果を確認できません。通信が戻ったら「結果を確認」を押してください。'
    case 'response_mismatch': return 'サーバーの応答が送った内容と一致しないため、確定として扱いません。新しい操作はできません。履歴を確認し、本部に連絡してください。'
    case 'identity_unverified': return 'この記録からは処理の内容を照合できないため、この端末では確認できません。履歴を確認し、本部に連絡してください。'
    case 'business': return `結果を照合できませんでした（${outcome.code ?? '不明'}）。確定している可能性があるため、新しい操作はできません。履歴を確認し、本部に連絡してください。`
    case 'not_found': return '記録はまだ見つかりません。後から確定する可能性があるため、新しい操作はできません。時間をおいて「結果を確認」を押すか、本部に連絡してください。'
    case 'no_snapshot': return '画面の再読み込みで送信内容が残っていないため、この端末では確認できません。会計履歴を確認し、本部に連絡してください。'
    case 'other_screen': return 'この画面では確認できない操作です。元の画面で確認するか、本部に連絡してください。'
    case 'not_voided': return '会計はまだ取消されていません。取消の通信が後から反映される可能性があるため、新しい取消はできません。時間をおいて「状態を確認」を押すか、本部に連絡してください。'
  }
}
