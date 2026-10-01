import type { TicketRow } from '../data/ticket'

export const WELCOME_COUPON_TITLE = '特殊パーマ Welcomeクーポン'
export const WELCOME_COUPON_AMOUNT = 2000
export const WELCOME_COUPON_ISSUED_BY = 'system-welcome'
export const WELCOME_COUPON_MEMO = '対象: 特殊パーマ / 平日のみ（土日利用不可） / 新規のお客様限定'
export const WELCOME_COUPON_WEEKEND_MESSAGE =
  'Welcomeクーポンは平日のみ利用できます。土日は利用できません。'

export function isWelcomeCouponTicket(
  ticket: Pick<TicketRow, 'title' | 'issued_by' | 'amount'>,
): boolean {
  return (
    ticket.issued_by === WELCOME_COUPON_ISSUED_BY ||
    (ticket.title === WELCOME_COUPON_TITLE && ticket.amount === WELCOME_COUPON_AMOUNT)
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
  return isWelcomeCouponTicket(ticket) && isWeekendInJapan(now)
}
