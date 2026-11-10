// 公開の時計：1秒ごとのサーバー時刻と、いまの段階（LaunchClock.tsx から分けた：画面の部品だけのファイルにするため）
import { useEffect, useState } from 'react'
import { CLOCK_SYNCED_EVENT, countdownFrom, fullscreenFrom, launchAt, serverNow } from '../utils/launch'

/** 1秒ごとにサーバー時刻を返す（秒の変わり目に合わせる） */
export function useServerSecond(): number {
  const [now, setNow] = useState(serverNow)
  useEffect(() => {
    let t = 0
    const tick = () => { setNow(serverNow()); t = window.setTimeout(tick, 1000 - (serverNow() % 1000) + 5) }
    tick()
    const re = () => setNow(serverNow())
    window.addEventListener(CLOCK_SYNCED_EVENT, re)
    return () => { window.clearTimeout(t); window.removeEventListener(CLOCK_SYNCED_EVENT, re) }
  }, [])
  return now
}

export type LaunchPhase = 'before' | 'countdown' | 'full' | 'after'
export function phaseAt(now: number): LaunchPhase {
  if (now >= launchAt()) return 'after'
  if (now >= fullscreenFrom()) return 'full'
  if (now >= countdownFrom()) return 'countdown'
  return 'before'
}


// ── 「解禁」（公開時刻ごと・端末に1回） ──
const KAIKIN_KEY = 'ginjiro_launch_kaikin_seen'
/** 読み込み直したあとの新しい画面で、「解禁」からふわっと明ける印（タブの間だけ） */
export const KAIKIN_FADE_KEY = 'ginjiro_launch_kaikin_fade'
export const KAIKIN_DONE_EVENT = 'ginjiro:kaikin-done'
export function kaikinSeen(): boolean {
  try { return localStorage.getItem(KAIKIN_KEY) === String(launchAt()) } catch { return true }
}
export function markKaikinSeen(): void {
  // 解禁のあとは告知ではなく銀ちゃんの案内へ（11/11 慶一郎さん）→ 公開後の告知も見たことにする
  try { localStorage.setItem(KAIKIN_KEY, String(launchAt())); localStorage.setItem('ginjiro_launch_notice_seen', String(launchAt())) } catch { /* なし */ }
}
