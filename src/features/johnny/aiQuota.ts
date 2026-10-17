// AI の JOHNNY を1台のスマホで1日に使える回数（使いすぎ・雑談で料金がかさまないように）。超えたら、その日は決まった規則の JOHNNY。
// ふつうの予約は5〜10回で終わる。端末に覚えるだけ（消せば戻るが、ふだんのお客様には十分）。
const KEY = 'ginjiro_johnny_ai_count'
export const AI_DAILY_LIMIT = 60

const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)

/** 1回使う。上限を超えていれば false（使わない） */
export function takeAiTurn(): boolean {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { date?: string; n?: number } | null
    const n = v?.date === today() ? Number(v.n) || 0 : 0
    if (n >= AI_DAILY_LIMIT) return false
    localStorage.setItem(KEY, JSON.stringify({ date: today(), n: n + 1 }))
    return true
  } catch {
    return true
  }
}
