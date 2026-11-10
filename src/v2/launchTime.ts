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

