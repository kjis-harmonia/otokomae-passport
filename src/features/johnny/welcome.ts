// 2回目以降のお客様への最初のひとこと（「おかえりなさい！前回のパンチパーマから13日。明日までメンテナンスカットが使えます」）。
//   来店の履歴：来店の記録（QR の来店登録ごと・メニューつき、customer_recent_visits）＋記録の無い日の過去の予約。新しい方から5回
//   最後の来店日：QR で来店登録した日（customer_get_last_visit）と、履歴のいちばん新しい日の新しい方
//   前回のメニュー：その日のメニュー（分かるときだけ）
//   いつものメニュー：履歴（最大5回）でいちばん多いもの（同じ回数なら新しい方）
//   メンテナンスカット：前回来店日から14日以内（来店日を DAY 14 として毎日 0:00 に減る）
import type { CustomerReservation } from './bookingAssistantApi'
import type { MenuOption } from './menuMatcher'

/** 来店の記録（customer_recent_visits） */
export interface VisitRecord { visit_date: string; menu_code: string | null; menu_name: string | null }

export const MAINTENANCE_DAYS = 14
/** 来店の記録でのメンテナンスカット（アプリのメニューには無い。予約はホットペッパーのクーポン） */
export const MAINTENANCE_MENU: MenuOption = { code: 'maintenance', name: 'メンテナンスカット', duration_min: 30, price: null }
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

export function buildWelcome(lastVisit: string | null, reservations: readonly CustomerReservation[], menus: readonly MenuOption[], now = Date.now(), visits: readonly VisitRecord[] = []): Welcome | null {
  const today = new Date(now + 9 * 3600000).toISOString().slice(0, 10)
  // 履歴：日ごとに1つ（来店の記録を優先、記録の無い日は予約）、新しい順に5回
  const byDay = new Map<string, string | null>()
  visits.forEach(v => { const d = v.visit_date.slice(0, 10); if (d <= today && (!byDay.has(d) || (v.menu_code && !byDay.get(d)))) byDay.set(d, v.menu_code) })
  reservations
    .filter(r => DONE.includes(r.status) && Date.parse(r.starts_at) <= now && r.items[0])
    .forEach(r => { const d = jstDay(r.starts_at); if (!byDay.get(d)) byDay.set(d, r.items[0].menu_code) })
  const history = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 5)
  const dates = [lastVisit?.slice(0, 10), history[0]?.[0]].filter((d): d is string => !!d && d <= today).sort()
  const last = dates[dates.length - 1]
  if (!last) return null
  const days = dayDiff(last, today)
  const menuOf = (code: string | null) => (code === 'maintenance' ? MAINTENANCE_MENU : code ? menus.find(m => m.code === code) ?? null : null)
  const count = new Map<string, number>()
  history.forEach(([, c]) => { if (menuOf(c)) count.set(c!, (count.get(c!) ?? 0) + 1) })
  const order = [...count.keys()].sort((a, b) => (count.get(b)! - count.get(a)!) || history.findIndex(h => h[1] === a) - history.findIndex(h => h[1] === b))
  return {
    days,
    lastMenu: menuOf(byDay.get(last) ?? null),
    maintenanceLeft: days <= MAINTENANCE_DAYS ? MAINTENANCE_DAYS - days : null,
    usual: order.map(menuOf).filter((m): m is MenuOption => !!m && !(m.code === 'maintenance' && days <= MAINTENANCE_DAYS)).slice(0, 2),
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
