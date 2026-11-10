// 予約の確定・変更・取消などの「書き込み」の通信中かどうか（11/11 公開：通信の途中で画面を止めないため）
const WRITES = /^customer_(create_hold|create_hold_for|confirm_new_reservation|confirm_visit|change_reservation|cancel_reservation|release_hold|set_ticket_plan|join_waitlist|leave_waitlist|link_companion|reservation_mutation_result)/

let count = 0
export const BOOKING_IDLE_EVENT = 'ginjiro:booking-idle'

export function bookingInFlight(): boolean { return count > 0 }

/** callRpc から呼ぶ：書き込みの通信を数える。終わったら呼び出した関数（done）で減らす */
export function trackBookingCall(fn: string): () => void {
  if (!WRITES.test(fn)) return () => {}
  count++
  let ended = false
  return () => {
    if (ended) return
    ended = true
    count = Math.max(0, count - 1)
    if (count === 0 && typeof window !== 'undefined') window.dispatchEvent(new Event(BOOKING_IDLE_EVENT))
  }
}
