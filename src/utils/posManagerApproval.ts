/**
 * POS 管理者承認（L2）API & ヘルパー。
 *
 * セキュリティ規約:
 *   - 平文 Manager PIN および発行された Approval Token (APR1) は
 *     localStorage / sessionStorage / IndexedDB / URL / console / analytics へ保存・出力しない。
 *   - メモリ内でのみ最小限の時間保持し、処理完了・失敗・キャンセル時に直ちに破棄する。
 *   - 循環参照を避けるため、staffSession.ts は import せず staffRpc.ts を直接使用する。
 */

import { callStaffRpc, isResultUnknown, RpcError } from './staffRpc'

export interface ManagerCandidate {
  id: string
  name: string
}

export type ManagerCandidateResult =
  | {
      ok: true
      candidates: ManagerCandidate[]
    }
  | {
      ok: false
      error: string
    }

export interface ManagerApprovalSuccess {
  ok: true
  approvalToken: string
  action: string
  requestHash: string
  expiresAt?: string
}

export interface ManagerApprovalError {
  ok: false
  error: string
  remaining_attempts?: number
  locked_until?: string
}

export type ManagerApprovalResult = ManagerApprovalSuccess | ManagerApprovalError

/**
 * 承認可能なマネージャー候補一覧を取得する（L1 操作者本人・非アクティブ・スタッフ役職は除外）。
 */
export async function getStaffManagerCandidates(operatorToken: string): Promise<ManagerCandidateResult> {
  try {
    const r = await callStaffRpc<{ candidates?: ManagerCandidate[]; error?: string }>('staff_pos_manager_candidates', {
      p_operator_token: operatorToken,
    })
    if (r.error) {
      return { ok: false, error: r.error }
    }
    return { ok: true, candidates: r.candidates ?? [] }
  } catch (err) {
    // 通信断・結果不明は業務エラーにしない（呼び出し元で通信エラーとして表示する）
    if (err instanceof RpcError && !isResultUnknown(err)) {
      return { ok: false, error: err.code }
    }
    throw err
  }
}

/**
 * マネージャー個別 PIN を検証し、1回限り有効な承認トークン (APR1) を発行する。
 */
export async function approvePosOperation(
  params: {
    managerStaffId: string
    managerPin: string
    action: string
    requestHash: string
  },
  operatorToken: string
): Promise<ManagerApprovalResult> {
  try {
    const r = await callStaffRpc<{
      approval_token?: string
      action?: string
      request_hash?: string
      expires_at?: string
      error?: string
      remaining_attempts?: number
      locked_until?: string
    }>('staff_pos_approve', {
      p_operator_token: operatorToken,
      p_manager_staff_id: params.managerStaffId,
      p_manager_pin: params.managerPin,
      p_action: params.action,
      p_request_hash: params.requestHash,
    })

    if (r.error) {
      return {
        ok: false,
        error: r.error,
        remaining_attempts: r.remaining_attempts,
        locked_until: r.locked_until,
      }
    }

    if (!r.approval_token || !r.action || !r.request_hash) {
      return { ok: false, error: 'approval_failed' }
    }

    return {
      ok: true,
      approvalToken: r.approval_token,
      action: r.action,
      requestHash: r.request_hash,
      expiresAt: r.expires_at,
    }
  } catch (err) {
    // 通信断・結果不明は業務エラーにしない。APR1 が発行されていても使われずに期限切れになる
    if (err instanceof RpcError && !isResultUnknown(err)) {
      const detail = (typeof err.detail === 'object' && err.detail !== null) ? (err.detail as Record<string, unknown>) : {}
      return {
        ok: false,
        error: err.code,
        remaining_attempts: typeof detail.remaining_attempts === 'number' ? detail.remaining_attempts : undefined,
        locked_until: typeof detail.locked_until === 'string' ? detail.locked_until : undefined,
      }
    }
    throw err
  }
}
