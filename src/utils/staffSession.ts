/**
 * 店舗端末のスタッフセッションと Supabase RPC 呼び出しの共通処理。
 *
 * - PIN はサーバー側（staff_login RPC）で照合する。フロントは正しい PIN を持たない。
 * - 照合に成功すると 14 時間有効のセッショントークンを受け取り、staff_* RPC の第1引数に付ける。
 * - RPC のエラー（通信失敗・DBエラー・業務エラー {error}）はすべて例外として返す。
 *   保存失敗を localStorage で成功扱いにする処理は行わない。
 */

import { supabase } from '../lib/supabase'

const STAFF_TOKEN_KEY = 'ginjiro_staff_session'
/** PIN 成功時にサーバーが発行する端末キー。ロック判定を端末ごとに分けるために使う（単体では認証にならない） */
const STAFF_DEVICE_KEY = 'ginjiro_staff_device_key'
/** スタッフPINの桁数 */
export const STAFF_PIN_LENGTH = 6
export const STAFF_AUTH_REQUIRED_EVENT = 'ginjiro:staff-auth-required'

interface StoredSession { token: string; expiresAt: string }

/** RPC が返した業務エラー（{ error: code }）または通信・DBエラー */
export class RpcError extends Error {
  readonly code: string
  readonly detail?: unknown
  constructor(code: string, message?: string, detail?: unknown) {
    super(message ?? code)
    this.name = 'RpcError'
    this.code = code
    this.detail = detail
  }
}

// ── セッション保存 ────────────────────────────────────────────────────────────

function readSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STAFF_TOKEN_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as StoredSession
    if (!s.token || !s.expiresAt || new Date(s.expiresAt) <= new Date()) return null
    return s
  } catch {
    return null
  }
}

export function getStaffToken(): string | null {
  return readSession()?.token ?? null
}

export function clearStaffSession(): void {
  try { localStorage.removeItem(STAFF_TOKEN_KEY) } catch { /* ignore */ }
}

function notifyAuthRequired(): void {
  clearStaffSession()
  window.dispatchEvent(new Event(STAFF_AUTH_REQUIRED_EVENT))
}

// ── RPC ───────────────────────────────────────────────────────────────────────

/**
 * Supabase RPC を呼び、結果を返す。
 * 通信・DBエラー、または戻り値が { error } の場合は RpcError を投げる。
 */
export async function callRpc<T>(fn: string, params: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, params)
  if (error) {
    if ((error.message ?? '').includes('staff_auth_required')) {
      notifyAuthRequired()
      throw new RpcError('staff_auth_required', 'スタッフ認証の有効期限が切れました。PINを入力し直してください。', error)
    }
    throw new RpcError(error.code ?? 'rpc_failed', error.message || '通信に失敗しました。', error)
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && typeof (data as { error?: unknown }).error === 'string') {
    const code = (data as { error: string }).error
    throw new RpcError(code, code, data)
  }
  return data as T
}

/** スタッフ専用 RPC（p_staff にセッショントークンを付与） */
export async function callStaffRpc<T>(fn: string, params: Record<string, unknown> = {}): Promise<T> {
  const token = getStaffToken()
  if (!token) {
    notifyAuthRequired()
    throw new RpcError('staff_auth_required', 'スタッフ認証が必要です。PINを入力してください。')
  }
  return callRpc<T>(fn, { p_staff: token, ...params })
}

// ── ログイン / ログアウト ─────────────────────────────────────────────────────

export type StaffLoginResult = { ok: true } | { ok: false; reason: 'invalid_pin' | 'locked' | 'not_configured' | 'network' }

export async function staffLogin(pin: string): Promise<StaffLoginResult> {
  try {
    let deviceKey: string | null = null
    try { deviceKey = localStorage.getItem(STAFF_DEVICE_KEY) } catch { /* ignore */ }
    const { data, error } = await supabase.rpc('staff_login', { p_pin: pin, p_device_key: deviceKey })
    // RPC 自体が無い（ステップA 未適用）場合は「未設定」と表示する
    if (error) return { ok: false, reason: error.code === 'PGRST202' ? 'not_configured' : 'network' }
    const r = data as { token?: string; expires_at?: string; device_key?: string | null; error?: string }
    if (r.token && r.expires_at) {
      localStorage.setItem(STAFF_TOKEN_KEY, JSON.stringify({ token: r.token, expiresAt: r.expires_at }))
      if (r.device_key) localStorage.setItem(STAFF_DEVICE_KEY, r.device_key)
      return { ok: true }
    }
    const reason = r.error === 'locked' || r.error === 'not_configured' ? r.error : 'invalid_pin'
    return { ok: false, reason }
  } catch {
    return { ok: false, reason: 'network' }
  }
}

/** 保存済みトークンがサーバー上でも有効か確認（無効なら削除） */
export async function verifyStaffSession(): Promise<boolean> {
  const token = getStaffToken()
  if (!token) return false
  try {
    const { data, error } = await supabase.rpc('staff_session_valid', { p_token: token })
    if (error) return true // 通信不調時は保存済みトークンを信頼し、実際の操作時にサーバーが再検証する
    if (data !== true) clearStaffSession()
    return data === true
  } catch {
    return true
  }
}

export async function staffLogout(): Promise<void> {
  const token = getStaffToken()
  clearStaffSession()
  if (token) {
    try { await supabase.rpc('staff_logout', { p_token: token }) } catch { /* ignore */ }
  }
}

// ── 表示用メッセージ ─────────────────────────────────────────────────────────

const MESSAGES: Record<string, string> = {
  staff_auth_required: 'スタッフ認証の有効期限が切れました。PINを入力し直してください。',
  invalid_tickets:     'チケットが見つからないか、すでに使用済み・期限切れです。',
  mixed_types:         '種類の異なるチケットは同時に使用できません。',
  transfer_pending:    '譲渡手続き中のチケットは使用できません。',
  daily_rule:          '本日は別の割引をご利用済みのため使用できません（割引の併用は1日1種類まで）。',
  welcome_weekend:     'Welcomeクーポンは平日のみ利用できます。土日は利用できません。',
  used_today:          '本日はすでに割引・クーポンをご利用済みです（メンテナンスクーポンは1日1回、他の割引との併用不可）。',
  not_found:           'クーポンQRが見つかりません。お客様にQRを再表示してもらってください。',
  already_used:        'このクーポンQRは使用済みです。',
  revoked:             'このクーポンQRは無効です（新しいQRが表示されています）。お客様の画面の最新QRを読み取ってください。',
  qr_expired:          'クーポンQRの有効期限（5分）が切れています。お客様にQRを再表示してもらってください。',
  no_visit:            '来店記録がないため、メンテナンスクーポンは利用できません。',
  cycle_expired:       '前回来店から14日を過ぎているため、メンテナンスクーポンは利用できません。',
  expired:             '前回来店から14日を過ぎているため、メンテナンスクーポンは利用できません。',
  customer_not_found:  '会員が見つかりません。先に会員QRを読み取ってください。',
  invalid_amount:      '金額が正しくありません。',
  invalid_quantity:    '枚数が正しくありません（1〜30枚）。',
  staff_name_required: '担当者を選択してください。',
}

export function rpcErrorMessage(err: unknown, fallback = '処理に失敗しました。通信環境を確認して再度お試しください。'): string {
  if (err instanceof RpcError) {
    if (MESSAGES[err.code]) return MESSAGES[err.code]
    const m = Object.keys(MESSAGES).find(k => err.message.includes(k))
    if (m) return MESSAGES[m]
  }
  return fallback
}

// ── 移行期間の読み取りフォールバック ─────────────────────────────────────────

/** RPC がサーバーにまだ無い（security_hardening ステップA 未適用）か */
export function isMissingRpc(err: unknown): boolean {
  return err instanceof RpcError && (err.code === 'PGRST202' || err.code === '42883')
}
