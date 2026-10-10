// 未解決の金銭操作の通知（B-2B-2）。表示専用。
//   - 状態は端末の記録（pendingOps）の実際の状態と、「結果を確認」の結果だけから決める。時間の経過では状態を変えない。
//   - 記録を消す・状態を変える・送信を許すことはしない（止める判定は pendingOps と各画面の送信ガードのまま）。
//   - 表示する項目は記録に保存した値だけ（操作の種類・金額・開始時刻・操作担当）。無い項目は出さない。
//     トークン・PIN は記録に保存されないので、ここにも出ない。

import {
  accountlessBlockMessage, isAccountlessGinpay, pendingKindLabel, pendingStoreMessage,
  type PendingOp, type PendingStoreFailure,
} from './pendingOps'
import { unresolvedMessage, type ConfirmOutcome, type UnresolvedReason } from './pendingConfirm'

export type PendingNoticeStatus = 'processing' | 'result_unknown' | 'needs_operator' | 'unverifiable' | 'storage_error'

export interface PendingNotice {
  status: PendingNoticeStatus
  /** B. 現在の状態 */
  title: string
  /** A. 処理内容（記録にある項目だけ） */
  details: { label: string; value: string }[]
  /** 状態の理由（確認の結果など） */
  reason: string | null
  /** C. 次に必要な行動 */
  next: string
  /** 「結果を確認」を出してよいか（処理中・保存できないときは出さない） */
  canConfirm: boolean
}

/** 「結果を確認」の結果。どの記録に対する結果かを持つ（別の記録の結果を表示しない） */
export interface PendingCheck { opId: string; outcome: ConfirmOutcome }

/** この端末では確かめようがない理由（何度確認しても変わらない） */
const UNVERIFIABLE: readonly UnresolvedReason[] = ['identity_unverified', 'no_snapshot', 'other_screen', 'response_mismatch', 'business']

const pad = (n: number) => String(n).padStart(2, '0')
function startedAt(iso: string): string | null {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function pendingNoticeDetails(op: PendingOp): { label: string; value: string }[] {
  const at = startedAt(op.createdAt)
  return [
    { label: '処理', value: pendingKindLabel(op.kind) },
    { label: '金額', value: `¥${op.amount.toLocaleString('ja-JP')}` },
    ...(at ? [{ label: '開始', value: at }] : []),
    ...(op.operatorName ? [{ label: '操作担当', value: op.operatorName }] : []),
  ]
}

/**
 * 画面に出す通知。何も止めていなければ null。
 *   failure  端末の記録を読めない・壊れている・排他が使えない
 *   op       この対象を止めている未解決の記録
 *   inFlight op がこの画面のプロセスから送信中（isPendingInFlight）
 *   check    最後の「結果を確認」の結果（op と同じ記録のものだけ使う）
 */
export function pendingNotice(args: {
  failure: PendingStoreFailure | null
  op: PendingOp | null
  inFlight: boolean
  check?: PendingCheck | null
  confirmLabel?: string
}): PendingNotice | null {
  const { failure, op, inFlight } = args
  const confirmLabel = args.confirmLabel ?? '結果を確認'
  const details = op ? pendingNoticeDetails(op) : []
  if (failure) {
    return {
      status: 'storage_error', title: '操作状態を保存できません', details,
      reason: pendingStoreMessage(failure), next: '新しい処理を開始しないでください。', canConfirm: false,
    }
  }
  if (!op) return null
  if (inFlight) {
    return {
      status: 'processing', title: '処理中です', details, reason: null,
      next: '結果が返るまでお待ちください。この対象の新しい操作はできません。', canConfirm: false,
    }
  }
  const outcome = args.check && args.check.opId === op.id ? args.check.outcome : null
  if (outcome?.status === 'operator_required') {
    return {
      status: 'needs_operator', title: '操作した担当者の認証が必要です', details, reason: null,
      next: `${outcome.operatorName ? `${outcome.operatorName} さん` : '操作した担当者'}が認証してから「${confirmLabel}」を押してください。`,
      canConfirm: true,
    }
  }
  const unverifiable = isAccountlessGinpay(op)
    ? accountlessBlockMessage(op)
    : outcome?.status === 'unresolved' && UNVERIFIABLE.includes(outcome.reason) ? unresolvedMessage(outcome) : null
  if (unverifiable) {
    return {
      status: 'unverifiable', title: 'この端末では結果を確認できません', details, reason: unverifiable,
      next: '本部へ連絡してください。同じ操作をやり直さないでください。', canConfirm: true,
    }
  }
  return {
    status: 'result_unknown', title: '処理結果を確認できません', details,
    reason: outcome ? unresolvedMessage(outcome) || null : null,
    next: `同じ操作をやり直さないでください（二重処理になるおそれがあります）。「${confirmLabel}」で確かめてください。`,
    canConfirm: true,
  }
}
