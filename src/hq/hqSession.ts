/**
 * 本部画面（/headquarters）専用のセッション。店舗スタッフのセッションとは別物。
 *
 * - 本部専用 PIN（6桁）はサーバー側（hq_login RPC）で照合する。フロントは正しい PIN を持たない。
 * - 照合に成功すると 14 時間有効の本部セッショントークンを受け取り、hq_* RPC の p_hq に付ける。
 * - 店舗スタッフのセッションでは hq_* RPC は通らない（サーバーが別表で検証）。
 */

import { supabase } from '../lib/supabase'
import { RpcError, callRpc } from '../utils/staffSession'

const HQ_TOKEN_KEY  = 'ginjiro_hq_session'
/** 本部 PIN 成功時にサーバーが発行する端末キー（ロック判定を端末ごとに分けるため。単体では認証にならない） */
const HQ_DEVICE_KEY = 'ginjiro_hq_device_key'
export const HQ_PIN_LENGTH = 6
export const HQ_AUTH_REQUIRED_EVENT = 'ginjiro:hq-auth-required'

interface StoredSession { token: string; expiresAt: string }

function readSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(HQ_TOKEN_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as StoredSession
    if (!s.token || !s.expiresAt || new Date(s.expiresAt) <= new Date()) return null
    return s
  } catch {
    return null
  }
}

export function getHqToken(): string | null {
  return readSession()?.token ?? null
}

export function clearHqSession(): void {
  try { localStorage.removeItem(HQ_TOKEN_KEY) } catch { /* ignore */ }
}

function notifyAuthRequired(): void {
  clearHqSession()
  window.dispatchEvent(new Event(HQ_AUTH_REQUIRED_EVENT))
}

/** 本部セッション必須の RPC（p_hq を付与）。認証切れは PIN 画面へ戻す。 */
export async function callHqRpc<T>(fn: string, params: Record<string, unknown> = {}): Promise<T> {
  const token = getHqToken()
  if (!token) {
    notifyAuthRequired()
    throw new RpcError('hq_auth_required', '本部PINを入力してください。')
  }
  try {
    return await callRpc<T>(fn, { p_hq: token, ...params })
  } catch (err) {
    if (err instanceof RpcError && err.message.includes('hq_auth_required')) {
      notifyAuthRequired()
      throw new RpcError('hq_auth_required', '本部セッションの有効期限が切れました。本部PINを入力し直してください。', err)
    }
    throw err
  }
}

export type HqLoginResult = { ok: true } | { ok: false; reason: 'invalid_pin' | 'locked' | 'not_configured' | 'network' }

export async function hqLogin(pin: string): Promise<HqLoginResult> {
  try {
    let deviceKey: string | null = null
    try { deviceKey = localStorage.getItem(HQ_DEVICE_KEY) } catch { /* ignore */ }
    const { data, error } = await supabase.rpc('hq_login', { p_pin: pin, p_device_key: deviceKey })
    // RPC 自体が無い（ステップA 未適用）場合は「未設定」と表示する
    if (error) return { ok: false, reason: error.code === 'PGRST202' ? 'not_configured' : 'network' }
    const r = data as { token?: string; expires_at?: string; device_key?: string | null; error?: string }
    if (r.token && r.expires_at) {
      localStorage.setItem(HQ_TOKEN_KEY, JSON.stringify({ token: r.token, expiresAt: r.expires_at }))
      if (r.device_key) localStorage.setItem(HQ_DEVICE_KEY, r.device_key)
      return { ok: true }
    }
    const reason = r.error === 'locked' || r.error === 'not_configured' ? r.error : 'invalid_pin'
    return { ok: false, reason }
  } catch {
    return { ok: false, reason: 'network' }
  }
}

/** 保存済みトークンがサーバー上でも有効か確認（無効なら削除） */
export async function verifyHqSession(): Promise<boolean> {
  const token = getHqToken()
  if (!token) return false
  try {
    const { data, error } = await supabase.rpc('hq_session_valid', { p_token: token })
    if (error) return true // 通信不調時は保存済みトークンを信頼し、実際の取得時にサーバーが再検証する
    if (data !== true) clearHqSession()
    return data === true
  } catch {
    return true
  }
}

export async function hqLogout(): Promise<void> {
  const token = getHqToken()
  clearHqSession()
  if (token) {
    try { await supabase.rpc('hq_logout', { p_token: token }) } catch { /* ignore */ }
  }
}
