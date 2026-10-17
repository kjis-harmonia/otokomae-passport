// 2回目以降のお客様への最初のひとこと（「おかえりなさい！前回のパンチパーマから13日。明日までメンテナンスカットが使えます」）。
//   最後の来店日：QR で来店登録した日（customer_get_last_visit）と、過去の予約の日の新しい方
//   前回のメニュー：その日の予約のメニュー（分かるときだけ）
//   いつものメニュー：過去の予約（最大5回）でいちばん多いもの（同じ回数なら新しい方）
//   メンテナンスカット：前回来店日から14日以内（来店日を DAY 14 として毎日 0:00 に減る）
import type { CustomerReservation } from './bookingAssistantApi'
import type { MenuOption } from './menuMatcher'

export const MAINTENANCE_DAYS = 14
const DONE: CustomerReservation['status'][] = ['completed', 'checked_in', 'in_service', 'awaiting_payment', 'confirmed']

export interface Welcome {
  /** 前回の来店から何日 */
  days: number
  lastMenu: MenuOption | null
  /** メンテナンスカットのあと何日（0 なら今日まで）。期限切れなら null */
  maintenanceLeft: number | null
  /** いつものメニュー（多い順、最大2つ） */
  usual: MenuOption[]
}

const jstDay = (iso: string) => new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 10)
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)

export function buildWelcome(lastVisit: string | null, reservations: readonly CustomerReservation[], menus: readonly MenuOption[], now = Date.now()): Welcome | null {
  const today = new Date(now + 9 * 3600000).toISOString().slice(0, 10)
  const past = reservations
    .filter(r => DONE.includes(r.status) && Date.parse(r.starts_at) <= now && r.items[0])
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
    .slice(0, 5)
  const dates = [lastVisit?.slice(0, 10), past[0] ? jstDay(past[0].starts_at) : undefined].filter((d): d is string => !!d && d <= today).sort()
  const last = dates[dates.length - 1]
  if (!last) return null
  const days = dayDiff(last, today)
  const menuOf = (code: string) => menus.find(m => m.code === code) ?? null
  const lastRes = past.find(r => jstDay(r.starts_at) === last)
  const count = new Map<string, number>()
  past.forEach(r => count.set(r.items[0].menu_code, (count.get(r.items[0].menu_code) ?? 0) + 1))
  const order = [...count.keys()].sort((a, b) => (count.get(b)! - count.get(a)!) || past.findIndex(r => r.items[0].menu_code === a) - past.findIndex(r => r.items[0].menu_code === b))
  return {
    days,
    lastMenu: lastRes ? menuOf(lastRes.items[0].menu_code) : null,
    maintenanceLeft: days <= MAINTENANCE_DAYS ? MAINTENANCE_DAYS - days : null,
    usual: order.map(menuOf).filter((m): m is MenuOption => !!m).slice(0, 2),
  }
}

/** 「今日まで」「明日まで」「あと3日（10月20日まで）」 */
export function maintenanceDeadline(left: number, now = Date.now()): string {
  if (left === 0) return '今日まで'
  if (left === 1) return '明日まで'
  const d = new Date(now + 9 * 3600000 + left * 86400000)
  return `あと${left}日（${d.getUTCMonth() + 1}月${d.getUTCDate()}日まで）`
}

/** 画面と読み上げの言葉 */
export function welcomeText(w: Welcome): { lines: string[]; speech: string } {
  const since = w.days === 0 ? '前回のご来店は今日です。'
    : `前回の${w.lastMenu ? w.lastMenu.name : 'ご来店'}から${w.days}日経ちました。`
  const lines = [since]
  if (w.maintenanceLeft != null) lines.push(`${maintenanceDeadline(w.maintenanceLeft)}、メンテナンスカットが使えます！`)
  else if (w.usual[0]) lines.push(`いつもの${w.usual[0].name}はいかがですか？`)
  const ask = 'ご予約はどうしますか？'
  return { lines, speech: `おかえりなさい！${lines.join('')}${ask}` }
}
