/**
 * お客様端末の顧客セッション（長期トークン）。
 *
 * - お客様用 RPC（customer_*）は p_session を受け取り、user_id はサーバー側で特定する。
 *   p_user_id を本人確認に使う RPC は無い。
 * - 新規会員：customer_register がサーバー側で user_id を採番し、セッションを同時に発行する。
 * - 既存会員：店頭でスタッフが発行する紐付けコード（10分有効・1回限り）でのみセッションを発行する。
 * - トークンは端末内（localStorage）に保存。DB 側はハッシュのみ。
 */

import { callRpc, isMissingRpc, RpcError } from './staffSession'
import { getStoredValue, loadMemberStatus, saveMemberStatus, setStoredValue, ONBOARDING_NAME_KEY } from './storage'
import { USER_ID_KEY } from './userId'

const CUSTOMER_SESSION_KEY = 'ginjiro_customer_session'
export const CUSTOMER_AUTH_REQUIRED_EVENT = 'ginjiro:customer-auth-required'

/** 引き継ぎが必要になった理由：action = 操作に必要 / read = 以前のチケットを読み込めなかった */
export interface CustomerAuthRequiredDetail { source: 'action' | 'read' }

function notifyAuthRequired(source: CustomerAuthRequiredDetail['source']): void {
  window.dispatchEvent(new CustomEvent<CustomerAuthRequiredDetail>(CUSTOMER_AUTH_REQUIRED_EVENT, { detail: { source } }))
}

const AUTH_REQUIRED_MESSAGE = '以前のチケットの引き継ぎが必要です。'

export function getCustomerSession(): string | null {
  try {
    const v = localStorage.getItem(CUSTOMER_SESSION_KEY)
    return v && v.length >= 32 ? v : null
  } catch {
    return null
  }
}

export function hasCustomerSession(): boolean {
  return getCustomerSession() !== null
}

/** 会員ごとに端末に残すもの。端末の会員が別の人に変わったら消す（前の人の「いつもの」・お連れ様の名前・最初の案内を持ち越さない・11/7）
 *  同じ会員のログインし直しでは消さない（案内をくり返さない） */
export const MEMBER_LOCAL_KEYS = [
  'otokomae_coupons', 'otokomae_gacha_date', 'otokomae_gacha_result', 'ginjiro_active_ticket', 'ginjiro_pending_contact', 'ginjiro_current_reservation',
  'ginjiro_companion_reservations', 'ginjiro_member_issued_at', 'ginjiro_next_reservation', 'ginjiro_companion_names',
  'ginjiro_usual_menu', 'ginjiro_usual_staff', 'ginjiro_usual_members', 'ginjiro_guide_seen_customer', 'ginjiro_first_guide', 'ginjiro_johnny_ai_count',
]
export function clearMemberLocal(): void {
  for (const key of MEMBER_LOCAL_KEYS) { try { localStorage.removeItem(key) } catch { /* 保存できない端末 */ } }
}

/** サーバーが返した user_id とセッションを端末に保存する */
export function saveCustomerSession(userId: string, session: string): void {
  const previous = getStoredValue<string | null>(USER_ID_KEY, null)
  // 前の会員がログインしていたときだけ（登録の途中の仮の番号から本番の番号に変わるときは消さない）
  if (previous && previous !== userId && getCustomerSession()) clearMemberLocal()
  setStoredValue(USER_ID_KEY, userId)
  try { localStorage.setItem(CUSTOMER_SESSION_KEY, session) } catch { /* ignore */ }
  window.dispatchEvent(new Event('ginjiro:customer-session-changed'))
}

export function clearCustomerSession(): void {
  try { localStorage.removeItem(CUSTOMER_SESSION_KEY) } catch { /* ignore */ }
}

/** 顧客セッション付き RPC。セッションが無い・失効している場合は RpcError('customer_auth_required') */
export async function callCustomerRpc<T>(fn: string, params: Record<string, unknown> = {}): Promise<T> {
  const session = getCustomerSession()
  if (!session) {
    notifyAuthRequired('action')
    throw new RpcError('customer_auth_required', AUTH_REQUIRED_MESSAGE)
  }
  try {
    return await callRpc<T>(fn, { p_session: session, ...params })
  } catch (err) {
    if (err instanceof RpcError && err.message.includes('customer_auth_required')) {
      // 送信後にFace IDや店頭確認で取得した新しいセッションは消さない。
      if (getCustomerSession() === session) {
        clearCustomerSession()
        notifyAuthRequired('action')
      }
      throw new RpcError('customer_auth_required', AUTH_REQUIRED_MESSAGE, err)
    }
    throw err
  }
}

/**
 * 顧客の読み取り。セッションがあれば customer_* RPC。
 * 移行期間（ステップB 適用前）に限り、セッションが無い既存会員・RPC 未作成の環境では
 * 従来の直接読み取り（legacyRead）で表示する。ステップB 後は直接読み取りは失敗し、紐付けが必要になる。
 */
export async function readAsCustomer<T>(fn: string, legacyRead: () => Promise<T>): Promise<T> {
  if (!hasCustomerSession()) {
    try {
      return await legacyRead()
    } catch (err) {
      // ステップB 後：セッションの無い既存会員は以前のデータを読めない → 引き継ぎの案内（必要時のみ）
      notifyAuthRequired('read')
      throw err
    }
  }
  try {
    return await callCustomerRpc<T>(fn)
  } catch (err) {
    if (isMissingRpc(err)) return legacyRead()
    throw err
  }
}

// ── 既存会員の紐付け ─────────────────────────────────────────────────────────

const BIND_MESSAGES: Record<string, string> = {
  bind_code_invalid: 'コードが正しくないか、有効期限（10分）が切れています。スタッフに再発行を依頼してください。',
  bind_code_locked:  '入力ミスが続いたため、このコードは無効になりました。スタッフに再発行を依頼してください。',
}

/** 店頭で受け取った6桁コードで、この端末を会員に紐付ける */
export async function bindWithCode(userId: string, code: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const r = await callRpc<{ user_id: string; session: string }>('customer_bind_with_code', {
      p_user_id: userId, p_code: code.trim(),
    })
    saveCustomerSession(r.user_id, r.session)
    return { ok: true }
  } catch (err) {
    if (err instanceof RpcError && BIND_MESSAGES[err.code]) return { ok: false, message: BIND_MESSAGES[err.code] }
    return { ok: false, message: '通信できませんでした。電波の良い場所でもう一度お試しください。' }
  }
}

/** 端末の会員番号が、ログインの鍵（セッション）の会員とずれていたら、鍵の会員に合わせる（11/6：PC の古い状態で QR に別の番号が出て「ゲスト」ができた）。
 *  合わせたら true（名前だけ入れ直したときも true＝会員証を描き直す）。鍵が無い・読めないときは何もしない */
export async function repairUserIdFromSession(): Promise<boolean> {
  if (!hasCustomerSession()) return false
  try {
    const r = await callCustomerRpc<{ user_id?: string; name?: string } | null>('customer_get_profile')
    const owner = r?.user_id
    const previous = getStoredValue<string | null>(USER_ID_KEY, null)
    // 同じ会員で、端末に名前だけ無い（古い版から使っている等）：会員証が「ゲスト様」にならんよう名前を入れる（11/9 点検）
    if (owner && previous === owner && typeof r?.name === 'string' && r.name.trim() && !getStoredValue<string | null>(ONBOARDING_NAME_KEY, null)) {
      setStoredValue(ONBOARDING_NAME_KEY, r.name.trim())
      saveMemberStatus({ ...loadMemberStatus(), memberName: r.name.trim() })
      return true // 会員証を描き直す
    }
    if (!owner || previous === owner) return false
    if (previous) clearMemberLocal()
    setStoredValue(USER_ID_KEY, owner)
    window.dispatchEvent(new Event('ginjiro:customer-session-changed'))
    return true
  } catch { return false }
}
