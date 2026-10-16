// Contact details are queued before sending, scoped to this member, and retried on startup/online.
import { callCustomerRpc, hasCustomerSession } from './customerSession'
import { RpcError } from './staffSession'
import { normalizePhone } from './phone'
import { getUserId } from './userId'

export interface CustomerContact { name: string; phone: string | null; registered: boolean }
interface PendingContact { userId: string; name: string; phone: string }
const PENDING_KEY = 'ginjiro_pending_contact'
export { formatPhone, normalizePhone } from './phone'

export async function fetchContact(): Promise<CustomerContact | null> {
  try { return await callCustomerRpc<CustomerContact>('customer_get_contact') }
  catch (err) {
    if (err instanceof RpcError && ['PGRST202', '42883'].includes(err.code)) return null
    throw err
  }
}

function readPending(): PendingContact | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    const p = raw ? JSON.parse(raw) : null
    // Unowned legacy records cannot safely be sent after a member rebind.
    return p && p.userId === getUserId() && typeof p.name === 'string' && typeof p.phone === 'string' ? p : null
  } catch { return null }
}
export function pendingContact(): { name: string; phone: string } | null {
  const p = readPending()
  return p ? { name: p.name, phone: p.phone } : null
}
function clearIfCurrent(p: PendingContact) {
  if (localStorage.getItem(PENDING_KEY) === JSON.stringify(p)) localStorage.removeItem(PENDING_KEY)
}
function invalidContact(err: unknown) {
  return err instanceof RpcError && /invalid_(name|phone)/.test(`${err.code} ${err.message}`)
}
export async function saveContact(name: string, phoneRaw: string): Promise<'saved' | 'pending'> {
  const phone = normalizePhone(phoneRaw)
  if (!phone) throw new RpcError('invalid_phone', '電話番号を確認してください。')
  if (!name.trim()) throw new RpcError('invalid_name', 'お名前を入力してください。')
  const p: PendingContact = { userId: getUserId(), name: name.trim(), phone }
  localStorage.setItem(PENDING_KEY, JSON.stringify(p))
  if (!hasCustomerSession()) return 'pending'
  try {
    await callCustomerRpc('customer_set_contact', { p_name: p.name, p_phone: p.phone })
    clearIfCurrent(p)
    return 'saved'
  } catch (err) {
    if (invalidContact(err)) { clearIfCurrent(p); throw err }
    return 'pending'
  }
}
let flushing: Promise<void> | null = null
export function flushPendingContact(): Promise<void> {
  if (flushing) return flushing
  flushing = (async () => {
    const p = readPending()
    if (!p || !hasCustomerSession()) return
    try {
      await callCustomerRpc('customer_set_contact', { p_name: p.name, p_phone: p.phone })
      clearIfCurrent(p)
    } catch { /* Keep pending. Do not turn a network failure into lost contact details. */ }
  })().finally(() => { flushing = null })
  return flushing
}
