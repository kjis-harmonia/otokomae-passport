import type { IssueTicketsInput } from '../utils/ticketStore'
import { issueTickets } from '../utils/ticketStore'
import { RpcError } from '../utils/staffSession'

export interface PendingIssuance extends IssueTicketsInput { requestId: string }
const KEY = 'ginjiro_pending_ticket_issue_v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function pendingIssuance(): PendingIssuance | null {
  const raw = localStorage.getItem(KEY)
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as PendingIssuance
    if (UUID.test(p.requestId) && typeof p.userId === 'string' && p.userId &&
        ['otoku', 'discount'].includes(p.type) && Number.isInteger(p.amount) && p.amount > 0 && p.amount <= 100000 &&
        Number.isInteger(p.quantity) && p.quantity >= 1 && p.quantity <= 30 &&
        typeof p.staffName === 'string' && p.staffName.trim() && typeof p.customerName === 'string') return p
  } catch { /* A damaged pending record must never silently become a new issuance. */ }
  throw new RpcError('pending_issue_invalid', '確認待ちの発行情報を読み込めません。新しく発行せず、管理者に確認してください。')
}

/** Persist before sending. Keep the exact request through errors, reloads and PIN renewal. */
export function prepareIssuance(input: IssueTicketsInput): PendingIssuance {
  const pending = pendingIssuance()
  if (pending) return pending
  if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > 100000) throw new RpcError('invalid_amount', '金額は1〜100,000円で入力してください。')
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 30) throw new RpcError('invalid_quantity', '枚数は1〜30枚で入力してください。')
  const next = { ...input, requestId: crypto.randomUUID() }
  localStorage.setItem(KEY, JSON.stringify(next)) // Storage failure: do not send.
  return next
}

export async function resolveIssuance(pending: PendingIssuance) {
  const tickets = await issueTickets(pending)
  // Preserve a different pending request if another tab has changed it.
  if (pendingIssuance()?.requestId === pending.requestId) localStorage.removeItem(KEY)
  return tickets
}
