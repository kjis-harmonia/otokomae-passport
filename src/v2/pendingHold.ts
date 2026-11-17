// キャンセル待ちのお知らせ（?hold=…）を、ログインが済むまで預かる（SR-06）
//   ログインしていない時に開くと、URL から消したあと行き先が無くなっていた。
//   ログインできたら1回だけ銀ちゃんが枠を聞く。期限切れ・別の会員の枠は、サーバーが断る（銀ちゃんが「お時間が過ぎました」）
const KEY = 'ginjiro_pending_hold'
/** 枠の押さえは長くても数十分。これより古い預かりは捨てる */
const KEEP_MS = 2 * 3600e3

export function savePendingHold(holdId: string): void {
  try { localStorage.setItem(KEY, JSON.stringify({ holdId, at: Date.now() })) } catch { /* 保存できない端末 */ }
}

/** 預かった枠の ID を取り出して消す（1回だけ） */
export function takePendingHold(): string | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    localStorage.removeItem(KEY)
    const v = JSON.parse(raw) as { holdId?: unknown; at?: unknown }
    return typeof v.holdId === 'string' && typeof v.at === 'number' && Date.now() - v.at < KEEP_MS && Date.now() >= v.at ? v.holdId : null
  } catch { return null }
}
