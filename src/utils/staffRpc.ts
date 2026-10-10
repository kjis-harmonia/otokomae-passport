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

export interface RpcErrorOptions {
  /** HTTP ステータス（応答を受け取れなかった場合は 0、不明は null） */
  httpStatus?: number | null
  /** RPC がサーバーで確定した可能性を否定できない（結果不明） */
  resultUnknown?: boolean
}

export class RpcError extends Error {
  readonly code: string
  readonly detail?: unknown
  readonly source: RpcErrorSource
  readonly httpStatus: number | null
  /**
   * true: 通信断・ゲートウェイ応答・壊れた応答など、サーバーで確定した可能性がある。
   * false: 業務エラー（rpc_result）、呼出前の失敗（local_precondition）、
   *        または RPC が実行されなかった／rollback されたと証明できる supabase_error。
   */
  readonly resultUnknown: boolean
  constructor(
    code: string,
    message?: string,
    detail?: unknown,
    source: RpcErrorSource = 'supabase_error',
    options: RpcErrorOptions = {},
  ) {
    super(message ?? code)
    this.name = 'RpcError'
    this.code = code
    this.detail = detail
    this.source = source
    this.httpStatus = options.httpStatus ?? null
    this.resultUnknown = source === 'supabase_error' ? options.resultUnknown ?? false : false
  }
}

/** RPC の結果が不明か。RpcError 以外の例外も、確定と証明できないので結果不明として扱う */
export function isResultUnknown(err: unknown): boolean {
  if (err instanceof RpcError) return err.resultUnknown
  return true
}

// PostgREST がエラー応答を返したとき、RPC のトランザクションは rollback 済み。
// ただし確定と言えるのは、PostgREST 自身の JSON 応答（4xx）で、次のどちらかの場合だけ：
//   - 関数本体の raise・入力・制約・権限・未定義関数・直列化失敗（必ず rollback される SQLSTATE クラス）
//   - PostgREST がリクエスト解析・スキーマ・JWT の段階で拒否した（RPC は実行されていない）
// 接続断（08）・資源不足（53）・停止/取消（57）・内部エラー（XX）・接続系 PGRST0xx・5xx・
// 本文がない／JSON でない応答は、COMMIT 後に失敗した可能性を否定できないので結果不明とする。
const ROLLED_BACK_SQLSTATE_CLASSES = new Set(['P0', '22', '23', '28', '40', '42'])

function isProvenNotCommitted(error: { code?: unknown; message?: unknown }, status: number): boolean {
  if (!(status >= 400 && status < 500)) return false
  if (typeof error.message !== 'string') return false
  const code = typeof error.code === 'string' ? error.code : ''
  if (/^PGRST[123]\d\d$/.test(code)) return true
  return /^[0-9A-Z]{5}$/.test(code) && ROLLED_BACK_SQLSTATE_CLASSES.has(code.slice(0, 2))
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
  let response: { data: unknown; error: { code?: string; message?: string } | null; status?: number }
  try {
    response = (await supabase.rpc(fn, params)) as unknown as typeof response
  } catch (err) {
    // supabase-js は通常 fetch の失敗を例外にしないが、例外になった場合も送信済みの可能性がある
    throw new RpcError('result_unknown', '通信結果を確認できませんでした。', err, 'supabase_error', { httpStatus: 0, resultUnknown: true })
  }
  const { data, error } = response
  if (error) {
    const httpStatus = typeof response.status === 'number' ? response.status : 0
    const resultUnknown = !isProvenNotCommitted(error, httpStatus)
    const options = { httpStatus, resultUnknown }
    if ((error.message ?? '').includes('staff_auth_required')) {
      notifyStaffAuthRequired()
      throw new RpcError('staff_auth_required', 'スタッフ認証の有効期限が切れました。PINを入力し直してください。', error, 'supabase_error', options)
    }
    // 通信断では code が空文字になる（?? では拾えない）
    const code = typeof error.code === 'string' && error.code !== '' ? error.code : resultUnknown ? 'result_unknown' : 'rpc_failed'
    throw new RpcError(code, error.message || '通信に失敗しました。', error, 'supabase_error', options)
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
    throw new RpcError(code, code, data, 'rpc_result', { httpStatus: response.status ?? null })
  }
  return data as T
}

/**
 * 金銭処理の応答がオブジェクトであることを確かめる。
 * 成功ステータスでも中身が読めない応答は、確定した可能性があるので結果不明とする。
 */
export function expectRpcObject<T>(data: T, fn: string): T {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new RpcError('result_unknown', '通信結果を確認できませんでした。', { fn, data }, 'supabase_error', { resultUnknown: true })
  }
  return data
}

/**
 * 金銭処理の成功応答に、確定を示す項目（取引 ID・冪等キー・金額など）がそろい、送った内容と一致することを確かめる。
 * 欠けている・一致しないときは成功とは扱わず結果不明にする（空配列や null で補わない）。code は response_mismatch。
 */
export function expectRpcResult<T>(data: T, fn: string, isComplete: (value: Record<string, unknown>) => boolean): T {
  const value = expectRpcObject(data, fn) as unknown as Record<string, unknown>
  if (!isComplete(value)) {
    throw new RpcError('response_mismatch', '通信結果を確認できませんでした。', { fn, data }, 'supabase_error', { resultUnknown: true })
  }
  return data
}

export async function callStaffRpc<T>(fn: string, params: Record<string, unknown> = {}): Promise<T> {
  const token = getStaffToken()
  if (!token) {
    notifyStaffAuthRequired()
    throw new RpcError('staff_auth_required', 'スタッフ認証が必要です。PINを入力してください。', undefined, 'local_precondition')
  }
  return callRpc<T>(fn, { p_staff: token, ...params })
}
