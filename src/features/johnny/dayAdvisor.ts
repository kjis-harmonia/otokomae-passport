// 「今日空いてる？」に、その日の空き状況を先に見て答える（JOHNNY）。
// 空いているかどうかは DB（customer_day_overview / customer_next_slots）だけが決める。
// ここは「どのメニューが・何時から入れられるか」を並べて、短い言葉にまとめるだけ。
import type { MenuOption } from './menuMatcher'
import { jstMinutes, type Slot } from './slotPlanner'
import type { VisitRequest } from './visitParser'

/** DB が返すその日の空き状況。同じ空き方のメニューは groups にまとまっている */
export interface DayOverview {
  date: string
  open: boolean
  hours: { start: string; end: string } | null
  groups: { codes: string[]; slots: string[] }[]
}

export interface AdvisedMenu { menu: MenuOption; slots: Slot[] }

export interface DayAdvice {
  date: string
  hours: { start: string; end: string }
  /** 入れられるメニュー（並びは呼び出し側のメニュー順＝前回のメニューが先頭）。時刻の指定があれば、その時刻に入れられるものだけ */
  available: AdvisedMenu[]
  /** この日は入れられないメニュー */
  unavailable: MenuOption[]
}

const minutesOf = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m }

/** 時刻の指定（「15時」）・時間帯（「夕方」）に合う枠だけ。指定が無ければそのまま */
export function slotsForRequest(slots: Slot[], req: Pick<VisitRequest, 'time' | 'range'>): Slot[] {
  if (req.time) return slots.filter(s => jstMinutes(s.starts_at) === minutesOf(req.time!))
  if (req.range) {
    const from = minutesOf(req.range.from), to = minutesOf(req.range.to)
    return slots.filter(s => { const m = jstMinutes(s.starts_at); return m >= from && m <= to })
  }
  return slots
}

/** DB の空き状況を、メニューごとに並べ直す */
export function adviseDay(overview: DayOverview, menus: readonly MenuOption[], req: Pick<VisitRequest, 'time' | 'range'>): DayAdvice | null {
  if (!overview.open || !overview.hours) return null
  const byCode = new Map<string, Slot[]>()
  for (const g of overview.groups) for (const code of g.codes) byCode.set(code, g.slots.map(starts_at => ({ starts_at })))
  const available: AdvisedMenu[] = []
  const unavailable: MenuOption[] = []
  for (const menu of menus) {
    const slots = slotsForRequest(byCode.get(menu.code) ?? [], req)
    if (slots.length > 0) available.push({ menu, slots })
    else unavailable.push(menu)
  }
  return { date: overview.date, hours: overview.hours, available, unavailable }
}

/** 時刻の読み方（18:30 → 18時半） */
export function spokenClock(iso: string): string {
  const m = jstMinutes(iso)
  const h = Math.floor(m / 60), mi = m % 60
  return mi === 0 ? `${h}時` : mi === 30 ? `${h}時半` : `${h}時${mi}分`
}

function spokenHour(hm: string): string {
  const m = minutesOf(hm)
  const h = Math.floor(m / 60), mi = m % 60
  return mi === 0 ? `${h}時` : mi === 30 ? `${h}時半` : `${h}時${mi}分`
}

/** 長さの読み方（150 → 2時間半） */
function spokenDuration(min: number): string {
  if (min < 60) return `${min}分`
  const h = Math.floor(min / 60), r = min % 60
  return r === 0 ? `${h}時間` : r === 30 ? `${h}時間半` : `${h}時間${r}分`
}

/**
 * その日のご案内の言葉。
 *   「本日は20時まで受け付けています。今からだと、通常カットなら18時半から、スキンフェードなら18時15分から入れます。
 *     2時間以上かかるメニューは、本日はもう空きがありません。どれにしますか？」
 */
export function adviceSpeech(a: DayAdvice, dayWord: string, opts: { isToday: boolean; time: string | null; mention?: number }): { title: string; sub: string; speech: string } {
  const mention = opts.mention ?? 3
  const top = a.available.slice(0, mention)
  const hours = opts.isToday ? `${dayWord}は${spokenHour(a.hours.end)}まで受け付けています。` : `${dayWord}は${spokenHour(a.hours.start)}から${spokenHour(a.hours.end)}まで受け付けています。`
  const lead = opts.time ? `${spokenHour(opts.time)}なら、` : opts.isToday ? '今からだと、' : ''
  const list = top.map(x => opts.time ? x.menu.name : `${x.menu.name}なら${spokenClock(x.slots[0].starts_at)}から`).join('、')
  const tail = opts.time ? 'が入れます。' : '入れます。'
  // 入れられないメニューのうち、入れられるどのメニューよりも長いもの＝この日は時間が足りない
  const longest = Math.max(0, ...a.available.map(x => x.menu.duration_min))
  const tooLong = a.unavailable.filter(m => m.duration_min > longest)
  const shortestTooLong = tooLong.length ? Math.min(...tooLong.map(m => m.duration_min)) : null
  const none = shortestTooLong !== null ? `${spokenDuration(shortestTooLong)}以上かかるメニューは、${dayWord}${opts.isToday ? 'はもう' : 'は'}空きがありません。` : ''
  const more = a.available.length > mention ? 'ほかのメニューも下に出しています。' : ''
  return {
    title: opts.time ? `${dayWord} ${opts.time.replace(/^0/, '')} に入れるメニュー` : `${dayWord}の空き`,
    sub: `受付 ${a.hours.start.replace(/^0/, '')}〜${a.hours.end.replace(/^0/, '')}`,
    speech: `${hours}${lead}${list}${tail}${none}${more}どれにしますか？`,
  }
}

/** 近い日の候補から、間をあけて n 件（同じ日なら1時間以上あける。違う日は1件ずつ） */
export function spreadSlots(slots: Slot[], n = 3): Slot[] {
  const out: Slot[] = []
  for (const s of [...slots].sort((a, b) => a.starts_at.localeCompare(b.starts_at))) {
    const t = new Date(s.starts_at).getTime()
    if (out.every(o => Math.abs(new Date(o.starts_at).getTime() - t) >= 60 * 60 * 1000)) out.push(s)
    if (out.length >= n) break
  }
  return out
}
