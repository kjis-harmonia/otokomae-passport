// キャンセル待ちのお知らせ（?hold=…）を、ログインが済むまで預かる（SR-06）
//   ログインしていない時に開くと、URL から消したあと行き先が無くなっていた。
//   ログインできたら1回だけ銀ちゃんが枠を聞く。期限切れ・別の会員の枠は、サーバーが断る（銀ちゃんが「お時間が過ぎました」）
//   Face ID のログインは成功のあと画面を読み込み直すので、預かりは「銀ちゃんが枠を聞き始めた時」に消す（読み込み直しで失わない）。
//   会員が変わった時に消すもの（MEMBER_LOCAL_KEYS）には入れない（会員情報のない端末のログインで消えていた）
const KEY = 'ginjiro_pending_hold'
/** 枠の押さえは長くても数十分。これより古い預かりは捨てる */
const KEEP_MS = 2 * 3600e3

export function savePendingHold(holdId: string): void {
  try { localStorage.setItem(KEY, JSON.stringify({ holdId, at: Date.now() })) } catch { /* 保存できない端末 */ }
}

/** 預かった枠の ID（消さない）。古い・壊れた預かりは捨てて null */
export function peekPendingHold(): string | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as { holdId?: unknown; at?: unknown }
    if (typeof v.holdId === 'string' && typeof v.at === 'number' && Date.now() >= v.at && Date.now() - v.at < KEEP_MS) return v.holdId
    localStorage.removeItem(KEY)
    return null
  } catch { return null }
}

/** 銀ちゃんがその枠を聞き始めた：預かりを消す（同じ枠の時だけ） */
export function clearPendingHold(holdId: string): void {
  try { if (peekPendingHold() === holdId) localStorage.removeItem(KEY) } catch { /* 保存できない端末 */ }
}
