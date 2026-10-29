import type { TicketRow } from '../data/ticket'

export const WELCOME_COUPON_TITLE = 'パーマ Welcomeクーポン'
/** 10/27 までの名前（配ってある券もこの名前のことがある） */
export const WELCOME_COUPON_LEGACY_TITLE = '特殊パーマ Welcomeクーポン'
export const WELCOME_COUPON_AMOUNT = 2000
export const WELCOME_COUPON_ISSUED_BY = 'system-welcome'
export const WELCOME_COUPON_MEMO = '対象: パーマ全種類（パーマのセットを含む） / 平日のみ（土日利用不可） / 新規のお客様限定'
export const WELCOME_COUPON_WEEKEND_MESSAGE =
  'Welcomeクーポンは平日のみ利用できます。土日は利用できません。'

/** 再来店パーマクーポン（10/29 慶一郎さん）：初回パーマの翌日に配る 500円引き。使える条件は Welcome と同じ（パーマだけ・平日のみ） */
export const PERM_RETURN_COUPON_TITLE = '再来店パーマクーポン'
export const PERM_RETURN_COUPON_ISSUED_BY = 'system-perm-return'

/** パーマのときだけ・平日のみ使える券（Welcome と再来店パーマクーポン）。会計の券一覧は issued_by が無いので名前でも見る */
export function isPermOnlyCoupon(ticket: Pick<TicketRow, 'title' | 'issued_by' | 'amount'>): boolean {
  return isWelcomeCouponTicket(ticket) || ticket.issued_by === PERM_RETURN_COUPON_ISSUED_BY || ticket.title === PERM_RETURN_COUPON_TITLE
}

export function isWelcomeCouponTicket(
  ticket: Pick<TicketRow, 'title' | 'issued_by' | 'amount'>,
): boolean {
  return (
    ticket.issued_by === WELCOME_COUPON_ISSUED_BY ||
    ((ticket.title === WELCOME_COUPON_TITLE || ticket.title === WELCOME_COUPON_LEGACY_TITLE) && ticket.amount === WELCOME_COUPON_AMOUNT)
  )
}

export function isWeekendInJapan(now = new Date()): boolean {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    weekday: 'short',
  }).format(now)
  return weekday === 'Sat' || weekday === 'Sun'
}

export function isWelcomeCouponBlockedToday(ticket: TicketRow, now = new Date()): boolean {
  return isPermOnlyCoupon(ticket) && isWeekendInJapan(now) // 再来店パーマクーポンも平日のみ（10/29）
}
