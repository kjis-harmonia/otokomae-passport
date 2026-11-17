// 空き時刻の間引き（ほかを読み込まない小さな部品。node の試験からそのまま読める）
import type { Slot } from './slotPlanner'

/** 1時間以上あけて、早い順に n 個まで選ぶ */
export function spreadSlots(slots: Slot[], n = 3): Slot[] {
  const out: Slot[] = []
  for (const s of [...slots].sort((a, b) => a.starts_at.localeCompare(b.starts_at))) {
    const t = new Date(s.starts_at).getTime()
    if (out.every(o => Math.abs(new Date(o.starts_at).getTime() - t) >= 60 * 60 * 1000)) out.push(s)
    if (out.length >= n) break
  }
  return out
}

/**
 * 予約の「日時を変更」で出す時刻の候補（SR-08）。
 * 前は間引いてから元の時刻を外していたので、元が 10:00・空きが 10:00 と 10:20 だと
 * 10:20 が間引かれたあとに 10:00 も外れて「空きなし」になっていた。元の時刻を先に外してから間引く。
 * メニューも変える時（excludeOriginal=false）は、元の時刻もそのまま選べる。
 */
export function changeTimes(free: string[], original: string, excludeOriginal: boolean, n: number): string[] {
  const at = Date.parse(original)
  const usable = excludeOriginal ? free.filter(t => Date.parse(t) !== at) : free
  return spreadSlots(usable.map(starts_at => ({ starts_at })), n).map(s => s.starts_at)
}
