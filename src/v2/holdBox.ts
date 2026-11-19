// キャンセル待ちの枠の受け箱（public/sw.js の keepHold が置く）。
//   iPhone では、裏で開いたアプリへお知らせの係から直接渡しても届かなかった（11/19 Staging・本番の実機）。
//   アプリが前に出た時・画面に出ている間に、自分で見に来て受け取る（受け取ったら箱から消す）
const BOX = 'ginjiro-hold-box'
const KEY = '/__gin-hold'
/** 押さえは10分。これより古いものは捨てる */
const KEEP_MS = 15 * 60e3

/** 受け箱の枠のリンク（無い・古い・読めない時は null）。読んだら消す */
export async function takeHoldBox(): Promise<string | null> {
  try {
    if (typeof caches === 'undefined') return null
    const box = await caches.open(BOX)
    const res = await box.match(KEY)
    if (!res) return null
    await box.delete(KEY)
    const v = await res.json() as { url?: unknown; at?: unknown }
    if (typeof v.url !== 'string' || typeof v.at !== 'number' || Date.now() < v.at || Date.now() - v.at > KEEP_MS) return null
    return v.url
  } catch { return null }
}
