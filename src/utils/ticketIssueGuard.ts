// チケット発行中の顧客切替の競合対策（AdminScreen が使う判定）。
//   - 顧客を切り替える導線（次のお客様・来店完了など）は、すべて canResetCustomer で止める。
//     画面の状態（送信中）だけでなく端末の記録（pendingOps）も見るので、画面を開き直しても
//     表示中の会員の発行が送信中・結果不明のあいだは切り替えない。
//   - 送信が終わったときの応答は、発行した会員と今表示している会員が同じときだけ画面に反映する。
//   - 未解決の記録は画面の外にあるので、画面を離れても・切り替えても残る（ここでは消さない）。
import type { TicketRow } from '../data/ticket'
import { getPendingView, PendingStoreError, target, type PendingOp, type PendingView } from './pendingOps'

export function ticketFormDisabled(resultUnknown: boolean, inFlight: boolean, sending: boolean): boolean {
  return resultUnknown || inFlight || sending
}

export function canConfirmTicketPending(op: PendingOp | null, notice: { canConfirm: boolean } | null, sending: boolean): boolean {
  return op?.kind === 'ticket_issue' && notice?.canConfirm === true && !sending
}

/** 確認も発行 RPC を呼び得るため、render 時ではなく送信直前に保存領域を読み直す。 */
export async function runTicketPendingAction<T>(send: () => Promise<T>): Promise<T> {
  const view = getPendingView()
  if (view.failure !== null) throw new PendingStoreError(view.failure)
  return send()
}

export interface CustomerResetState {
  /** この画面から発行を送信中・確認中 */
  sending: boolean
  /** 今表示している会員（いなければ null） */
  displayedUserId: string | null
  /** 端末の記録（getPendingView / usePendingView） */
  view: PendingView
}

/**
 * 顧客を切り替えてよいか。表示中の会員に発行の記録（送信中・結果不明）がある、
 * または記録を読めないときは切り替えない。会員を表示していなければ、送信中でない限り切り替えてよい。
 */
export function canResetCustomer(s: CustomerResetState): boolean {
  if (s.sending) return false
  if (s.displayedUserId === null) return true
  if (s.view.failure !== null) return false
  const user = target.user(s.displayedUserId)
  return !s.view.ops.some(op => op.kind === 'ticket_issue' && op.targets.includes(user))
}

/**
 * 発行の応答を、今表示している会員のチケットとして返す。発行した会員と表示中の会員が違う（切り替え後の古い応答）、
 * または応答に別の会員のチケットが混ざっているときは null（画面に追加しない）。
 */
export function ticketsForDisplayed(displayedUserId: string | null, issuedFor: string, tickets: readonly TicketRow[]): TicketRow[] | null {
  if (displayedUserId === null || displayedUserId !== issuedFor) return null
  return tickets.every(t => t.user_id === issuedFor) ? [...tickets] : null
}
