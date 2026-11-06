// お客様の連絡先（本名・電話番号）。予約とお店からの連絡に使う（本人確認には使わない）。
// サーバーの連絡先の仕組み（customer_set_contact）がまだ無い環境では、端末に一時保存して、使えるようになったら送る。
import { callCustomerRpc, hasCustomerSession } from './customerSession'
import { isMissingRpc, RpcError } from './staffSession'
import { normalizePhone } from './phone'
import { getUserId } from './userId'

export interface CustomerContact { name: string; phone: string | null; registered: boolean }

const PENDING_KEY = 'ginjiro_pending_contact'
// 入力の誤りは送り直しても通らないので、端末に残さない
const isInputError = (err: unknown) => err instanceof RpcError && (err.code === 'invalid_name' || err.code === 'invalid_phone')

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
    // どの会員の連絡先かも残し、次の起動で同じ会員のときだけ送る（別の会員に切り替わっていたら送らない）
    try { localStorage.setItem(PENDING_KEY, JSON.stringify({ name: trimmed, phone, user_id: getUserId() })) } catch { /* ignore */ }
    return 'pending' as const
  }
  // 顧客セッションの無い端末（移行期間の旧登録など）は送らずに端末へ（引き継ぎの案内を出さない）
  if (!hasCustomerSession()) return keep()
  try {
    await callCustomerRpc('customer_set_contact', { p_name: trimmed, p_phone: phone })
    clearPending()
    return 'saved'
  } catch (err) {
    if (isMissingRpc(err)) return keep()
    // 通信の失敗・ログインの切れなど：端末に残して次の起動で送り直す。呼んだ画面にはこれまでどおり失敗を伝える
    if (!isInputError(err)) keep()
    throw err
  }
}

function clearPending(): void {
  try { localStorage.removeItem(PENDING_KEY) } catch { /* ignore */ }
}

/** 端末に一時保存した連絡先 */
export function pendingContact(): { name: string; phone: string; user_id?: string } | null {
  try {
    const v = localStorage.getItem(PENDING_KEY)
    const p = v ? (JSON.parse(v) as { name?: unknown; phone?: unknown; user_id?: unknown }) : null
    if (!p || typeof p.name !== 'string' || typeof p.phone !== 'string') return null
    return typeof p.user_id === 'string' ? { name: p.name, phone: p.phone, user_id: p.user_id } : { name: p.name, phone: p.phone }
  } catch { return null }
}

/** 一時保存した連絡先をサーバーへ送る（アプリ起動時。仕組みがまだ無ければそのまま残す） */
export async function flushPendingContact(): Promise<void> {
  const p = pendingContact()
  if (!p || !hasCustomerSession()) return
  // 別の会員の連絡先は送らない（端末で会員が切り替わった時）。残しても使わないので消す
  if (p.user_id && p.user_id !== getUserId()) { clearPending(); return }
  try {
    await callCustomerRpc('customer_set_contact', { p_name: p.name, p_phone: p.phone })
    clearPending()
  } catch (err) {
    // 入力の誤りは消す。仕組みが無い・通信できない：次の起動でもう一度
    if (isInputError(err)) clearPending()
  }
}
