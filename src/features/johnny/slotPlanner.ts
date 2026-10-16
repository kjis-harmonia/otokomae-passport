// 空き枠（DB の予約エンジンが返した開始時刻）から、お客様の希望に合う提案を決める。
// 空いているかどうかは DB だけが決める。ここは並べ替えと絞り込みだけ。
import type { VisitRequest } from './visitParser'

export interface Slot { starts_at: string }

export type Offer =
  /** 希望の時刻がそのまま空いている（1件） */
  | { kind: 'exact'; slots: Slot[] }
  /** 希望の時刻は埋まっている。近い時刻（最大3件） */
  | { kind: 'nearby'; slots: Slot[] }
  /** 時刻の指定なし（日付・時間帯・最短）。早い順（最大3件） */
  | { kind: 'choices'; slots: Slot[] }
  /** 候補日に空きがない */
  | { kind: 'none'; slots: [] }

const MAX = 3

/** 日本時間の HH:MM（分の通し番号） */
export function jstMinutes(iso: string): number {
  const t = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000)
  return t.getUTCHours() * 60 + t.getUTCMinutes()
}

function minutesOf(hm: string): number {
  const [h, m] = hm.split(':').map(Number)
  return h * 60 + m
}

export function planOffer(req: VisitRequest, slotsByDate: Record<string, Slot[]>): Offer {
  const dates = req.dates.filter(d => d in slotsByDate)
  const all = dates.flatMap(d => (slotsByDate[d] ?? []).map(s => ({ ...s, date: d })))
  if (all.length === 0) return { kind: 'none', slots: [] }
  const strip = (xs: (Slot & { date: string })[]): Slot[] => xs.map(({ starts_at }) => ({ starts_at }))

  if (req.time) {
    const want = minutesOf(req.time)
    for (const d of dates) {
      const hit = (slotsByDate[d] ?? []).find(s => jstMinutes(s.starts_at) === want)
      if (hit) return { kind: 'exact', slots: [{ starts_at: hit.starts_at }] }
    }
    // 最初の候補日で近い順（同じ差なら後ろの時刻を先に。店に来やすいのは遅めの方）。無ければ次の候補日
    for (const d of dates) {
      const day = (slotsByDate[d] ?? []).map(s => ({ ...s, date: d }))
      if (day.length === 0) continue
      const sorted = day
        .map(s => ({ s, diff: jstMinutes(s.starts_at) - want }))
        .sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff) || b.diff - a.diff)
        .slice(0, MAX)
        .map(x => x.s)
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
      return { kind: 'nearby', slots: strip(sorted) }
    }
  }

  const inRange = req.range
    ? all.filter(s => { const m = jstMinutes(s.starts_at); return m >= minutesOf(req.range!.from) && m <= minutesOf(req.range!.to) })
    : all
  const pool = inRange.length > 0 ? inRange : all
  return { kind: 'choices', slots: strip(pool.sort((a, b) => a.starts_at.localeCompare(b.starts_at)).slice(0, MAX)) }
}
