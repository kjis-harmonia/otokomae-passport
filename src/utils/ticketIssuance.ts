import type { IssueTicketsInput } from './ticketStore'
import { issueTickets } from './ticketStore'
import { RpcError } from './staffSession'

export interface PendingIssuance extends IssueTicketsInput { requestId: string; backend: string }
const KEY = 'ginjiro_pending_ticket_issue_v1'
const LOCK = 'ginjiro:ticket-issuance'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function backend(): string {
  const value = import.meta.env.VITE_SUPABASE_URL
  if (!value) throw new RpcError('issue_backend_missing', '発行先の設定を確認できません。新しく発行せず、管理者に確認してください。')
  return value
}

export function pendingIssuance(): PendingIssuance | null {
  const raw = localStorage.getItem(KEY)
  if (!raw) return null
  let value: PendingIssuance
  try { value = JSON.parse(raw) as PendingIssuance }
  catch { throw new RpcError('pending_issue_invalid', '確認待ちの発行情報を読み込めません。新しく発行せず、管理者に確認してください。') }
  if (!value || typeof value !== 'object' || !UUID.test(value.requestId) ||
      typeof value.userId !== 'string' || !value.userId ||
      !['otoku', 'discount'].includes(value.type) || !Number.isInteger(value.amount) || value.amount < 1 || value.amount > 100000 ||
      !Number.isInteger(value.quantity) || value.quantity < 1 || value.quantity > 30 ||
      typeof value.staffName !== 'string' || !value.staffName.trim() || typeof value.customerName !== 'string') {
    throw new RpcError('pending_issue_invalid', '確認待ちの発行情報を読み込めません。新しく発行せず、管理者に確認してください。')
  }
  if (value.backend !== backend()) {
    throw new RpcError('issue_backend_mismatch', '別の発行先の確認待ち情報があります。新しく発行せず、管理者に確認してください。')
  }
  return value
}

/** Hold this lock across preparation, sending and receipt handling; never queue a second issue. */
export async function withIssuanceLock<T>(work: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new RpcError('issue_lock_unavailable', '安全に発行するための機能を利用できません。店舗端末のブラウザーを更新してください。')
  return navigator.locks.request(LOCK, { ifAvailable: true }, async lock => {
    if (!lock) throw new RpcError('issue_busy', '別の画面で発行を確認しています。完了してからもう一度お試しください。')
    return work()
  })
}

/** Persist the immutable request before sending. A prior request needs explicit recovery. */
export function prepareIssuance(input: IssueTicketsInput): PendingIssuance {
  if (pendingIssuance()) throw new RpcError('pending_issue_exists', '確認待ちの発行があります。先に同じ発行を確認してください。')
  if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > 100000) throw new RpcError('invalid_amount', '金額は1〜100,000円で入力してください。')
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 30) throw new RpcError('invalid_quantity', '枚数は1〜30枚で入力してください。')
  const next = { ...input, requestId: crypto.randomUUID(), backend: backend() }
  const raw = JSON.stringify(next)
  localStorage.setItem(KEY, raw)
  if (localStorage.getItem(KEY) !== raw) throw new RpcError('issue_storage_failed', '発行情報を保存できません。新しく発行せず、管理者に確認してください。')
  return next
}

export async function resolveIssuance(pending: PendingIssuance) {
  const stored = pendingIssuance()
  if (!stored || JSON.stringify(stored) !== JSON.stringify(pending)) {
    throw new RpcError('pending_issue_changed', '確認待ちの発行情報が変わりました。画面を開き直してください。')
  }
  const tickets = await issueTickets(stored)
  // Never discard another tab's request, or discard this one before a valid receipt is obtained.
  const current = pendingIssuance()
  if (!current || current.requestId !== stored.requestId) throw new RpcError('pending_issue_changed', '発行結果を受け取りましたが、確認待ち情報が変わりました。管理者に確認してください。')
  localStorage.removeItem(KEY)
  if (localStorage.getItem(KEY) !== null) throw new RpcError('issue_storage_failed', '発行結果を保存できません。同じ発行を再確認してください。')
  return tickets
}
