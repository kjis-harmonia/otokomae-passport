import { supabase } from '../lib/supabase'
import { clearCurrentOperator } from './posOperatorSession'

const STAFF_TOKEN_KEY = 'ginjiro_staff_session'
export const STAFF_AUTH_REQUIRED_EVENT = 'ginjiro:staff-auth-required'

interface StoredSession {
  token: string
  expiresAt: string
}

export type RpcErrorSource =
  | 'rpc_result'
  | 'local_precondition'
  | 'supabase_error'

export class RpcError extends Error {
  readonly code: string
  readonly detail?: unknown
  readonly source: RpcErrorSource
  constructor(
    code: string,
    message?: string,
    detail?: unknown,
    source: RpcErrorSource = 'supabase_error',
  ) {
    super(message ?? code)
    this.name = 'RpcError'
    this.code = code
    this.detail = detail
    this.source = source
  }
}

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

export function notifyStaffAuthRequired(): void {
  clearCurrentOperator()
  try {
    localStorage.removeItem(STAFF_TOKEN_KEY)
  } catch {
    /* ignore */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(STAFF_AUTH_REQUIRED_EVENT))
  }
}

export async function callRpc<T>(fn: string, params: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, params)
  if (error) {
    if ((error.message ?? '').includes('staff_auth_required')) {
      notifyStaffAuthRequired()
      throw new RpcError('staff_auth_required', 'スタッフ認証の有効期限が切れました。PINを入力し直してください。', error, 'supabase_error')
    }
    throw new RpcError(error.code ?? 'rpc_failed', error.message || '通信に失敗しました。', error, 'supabase_error')
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && typeof (data as { error?: unknown }).error === 'string') {
    const code = (data as { error: string }).error
    if (
      code === 'operator_session_invalid' ||
      code === 'invalid_operator_session' ||
      code === 'operator_session_expired'
    ) {
      clearCurrentOperator()
    } else if (code === 'staff_auth_required') {
      notifyStaffAuthRequired()
    }
    throw new RpcError(code, code, data, 'rpc_result')
  }
  return data as T
}

export async function callStaffRpc<T>(fn: string, params: Record<string, unknown> = {}): Promise<T> {
  const token = getStaffToken()
  if (!token) {
    notifyStaffAuthRequired()
    throw new RpcError('staff_auth_required', 'スタッフ認証が必要です。PINを入力してください。', undefined, 'local_precondition')
  }
  return callRpc<T>(fn, { p_staff: token, ...params })
}
