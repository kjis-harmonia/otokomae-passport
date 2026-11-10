// 新しい銀二郎の公開（11/11 慶一郎さん）。定数は公開時刻ひとつだけ。カウントダウン（3時間前）・全画面の時計（60秒前）はここから計算する。
//   時刻はサーバー（このアプリを配っている Vercel）の Date ヘッダーで合わせる。端末の時計がずれていても同じ瞬間に切り替わる。
//   慶一郎さんの端末（会員番号で判定）だけは、公開前から新画面が見える（裏口）。
//   Staging だけ：?launch=5 で「5分後に公開」、?launch=off で元に戻す、?backdoor=0 で裏口を外す（通しの確認用）
// env.ts から ginFlow がこのファイルを読むので、ここでは env.ts を読まない（読み合いを避ける）
const isStaging = () => import.meta.env.VITE_APP_ENV === 'staging'

/** 公開時刻（日本時間）。ここだけを書き換える */
export const GIN_LAUNCH_AT = '2026-11-11T12:00:00+09:00'

const COUNTDOWN_MS = 3 * 3600_000 // 3時間前から「新しい銀二郎まで HH:MM:SS」
const FULLSCREEN_MS = 60_000 // 60秒前から画面いっぱいの時計
const BACKDOOR_USER_IDS = ['u-8ecabf88182ba1f9351805f1', 'u-4aa4b95cf293253a2915bbc0'] // 平田慶一郎（Staging の会員・本番 iPhone の会員 U-4AA4B9）

const OVERRIDE_KEY = 'ginjiro_launch_override'
const NO_BACKDOOR_KEY = 'ginjiro_launch_no_backdoor'
export const CLOCK_SYNCED_EVENT = 'ginjiro:clock-synced'

// Staging の確認用の上書き（URL で付けたら、そのタブのあいだ覚える）
if (typeof window !== 'undefined' && isStaging()) {
  try {
    const q = new URLSearchParams(location.search)
    const l = q.get('launch')
    if (l === 'off') sessionStorage.removeItem(OVERRIDE_KEY)
    else if (l && Number.isFinite(Number(l))) sessionStorage.setItem(OVERRIDE_KEY, String(Date.now() + Number(l) * 60_000))
    if (q.get('backdoor') === '0') sessionStorage.setItem(NO_BACKDOOR_KEY, '1')
    if (q.get('backdoor') === '1') sessionStorage.removeItem(NO_BACKDOOR_KEY)
    // 読んだら URL から消す（00:00 で読み込み直したとき、もう一度「〇分後」にならないように）
    if (q.has('launch') || q.has('backdoor')) {
      q.delete('launch'); q.delete('backdoor')
      history.replaceState(history.state, '', `${location.pathname}${q.size ? `?${q}` : ''}${location.hash}`)
    }
  } catch { /* 保存できない端末 */ }
}

const OFFSET_KEY = 'ginjiro_clock_offset'
// サーバー時刻 − 端末時刻（ミリ秒）。読み込み直したあとも使えるよう、タブの間は覚えておく
//   （端末の時計が遅いと、読み込み直した直後に旧画面になり、また読み込み直す…を繰り返すため）
let offset = (() => { try { const v = Number(sessionStorage.getItem(OFFSET_KEY)); return Number.isFinite(v) ? v : 0 } catch { return 0 } })()
let synced = false

export function serverNow(): number { return Date.now() + offset }
export function clockSynced(): boolean { return synced }

/** 公開時刻（ミリ秒）。Staging は上書きがあればそれ */
export function launchAt(): number {
  if (isStaging()) {
    try { const o = Number(sessionStorage.getItem(OVERRIDE_KEY)); if (o > 0) return o } catch { /* なし */ }
  }
  return Date.parse(GIN_LAUNCH_AT)
}

export const countdownFrom = () => launchAt() - COUNTDOWN_MS
export const fullscreenFrom = () => launchAt() - FULLSCREEN_MS
export function launched(): boolean { return serverNow() >= launchAt() }

/** 慶一郎さんの端末：公開前から新画面 */
export function launchBackdoor(): boolean {
  try {
    if (isStaging() && sessionStorage.getItem(NO_BACKDOOR_KEY)) return false
    const raw = localStorage.getItem('ginjiro_user_id')
    const id = raw ? JSON.parse(raw) : null
    return typeof id === 'string' && BACKDOOR_USER_IDS.includes(id)
  } catch { return false }
}

/** サーバーの時刻に合わせる。アプリを開いたとき・画面に戻ったときに呼ぶ */
export async function syncServerClock(): Promise<void> {
  try {
    const t0 = Date.now()
    const res = await fetch(`/?clock=${t0}`, { method: 'HEAD', cache: 'no-store' })
    const t1 = Date.now()
    const date = Date.parse(res.headers.get('date') ?? '')
    if (!Number.isFinite(date)) return
    // Date ヘッダーは秒まで。行き来の半分と 0.5 秒を足して真ん中に合わせる
    offset = date + 500 - (t0 + t1) / 2
    synced = true
    try { sessionStorage.setItem(OFFSET_KEY, String(Math.round(offset))) } catch { /* なし */ }
    window.dispatchEvent(new Event(CLOCK_SYNCED_EVENT))
  } catch { /* 通信できなければ端末の時計のまま */ }
}

/** 残りの時間「HH:MM:SS」 */
export function hms(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`
}

/** 公開時刻の「12:00」（日本時間） */
export function launchHm(): string { return new Date(launchAt() + 9 * 3600_000).toISOString().slice(11, 16) }
