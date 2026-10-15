// お客様の連絡先（本名・電話番号）。予約とお店からの連絡に使う（本人確認には使わない）。
// サーバーの連絡先の仕組み（customer_set_contact）がまだ無い環境では、端末に一時保存して、使えるようになったら送る。
import { callCustomerRpc, hasCustomerSession } from './customerSession'
import { isMissingRpc, RpcError } from './staffSession'
import { normalizePhone } from './phone'

export interface CustomerContact { name: string; phone: string | null; registered: boolean }

const PENDING_KEY = 'ginjiro_pending_contact'

export { formatPhone, normalizePhone } from './phone'

/** 自分の連絡先。サーバーに仕組みが無い環境では null（分からない） */
export async function fetchContact(): Promise<CustomerContact | null> {
  try {
    return await callCustomerRpc<CustomerContact>('customer_get_contact')
  } catch (err) {
    if (isMissingRpc(err)) return null
    throw err
  }
}

/**
 * 連絡先を保存する。saved = サーバーに保存済み / pending = サーバーの仕組みがまだ無いので端末に一時保存
 * 形式の誤り（invalid_name / invalid_phone）は RpcError のまま投げる
 */
export async function saveContact(name: string, phoneRaw: string): Promise<'saved' | 'pending'> {
  const phone = normalizePhone(phoneRaw)
  if (!phone) throw new RpcError('invalid_phone', '電話番号を確認してください。')
  const trimmed = name.trim()
  if (!trimmed) throw new RpcError('invalid_name', 'お名前を入力してください。')
  const keep = () => {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify({ name: trimmed, phone })) } catch { /* ignore */ }
    return 'pending' as const
  }
  // 顧客セッションの無い端末（移行期間の旧登録など）は送らずに端末へ（引き継ぎの案内を出さない）
  if (!hasCustomerSession()) return keep()
  try {
    await callCustomerRpc('customer_set_contact', { p_name: trimmed, p_phone: phone })
    clearPending()
    return 'saved'
  } catch (err) {
    if (!isMissingRpc(err)) throw err
    return keep()
  }
}

function clearPending(): void {
  try { localStorage.removeItem(PENDING_KEY) } catch { /* ignore */ }
}

/** 端末に一時保存した連絡先 */
export function pendingContact(): { name: string; phone: string } | null {
  try {
    const v = localStorage.getItem(PENDING_KEY)
    const p = v ? (JSON.parse(v) as { name?: unknown; phone?: unknown }) : null
    return p && typeof p.name === 'string' && typeof p.phone === 'string' ? { name: p.name, phone: p.phone } : null
  } catch { return null }
}

/** 一時保存した連絡先をサーバーへ送る（アプリ起動時。仕組みがまだ無ければそのまま残す） */
export async function flushPendingContact(): Promise<void> {
  const p = pendingContact()
  if (!p || !hasCustomerSession()) return
  try {
    await callCustomerRpc('customer_set_contact', { p_name: p.name, p_phone: p.phone })
    clearPending()
  } catch {
    // 仕組みが無い・通信できない：次の起動でもう一度
  }
}
