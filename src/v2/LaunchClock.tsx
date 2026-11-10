// 新しい銀二郎の公開（11/11）：カウントダウン・全画面の時計・公開後の告知
//   - 3時間前〜60秒前：ホーム上部と告知に「新しい銀二郎まで HH:MM:SS」（1秒ごと）
//   - 60秒前から：画面いっぱいのデジタル時計（00:59 → 00:00、1秒ごとにカチッ）
//   - 00:00：開いている画面も読み込み直して新画面へ。読み込み後に新しい告知 →【見てみる】で銀ちゃんの案内
//   時刻・公開時刻は utils/launch.ts（定数は公開時刻ひとつ）
import { useEffect, useRef, useState } from 'react'
import { hms, launchAt, launched, syncServerClock } from '../utils/launch'
import { phaseAt, useServerSecond } from './launchTime'
import { ginFlow } from '../utils/env'

const NOTICE_KEY = 'ginjiro_launch_notice_seen'
const PRE_NOTICE_SESSION = 'ginjiro_launch_pre_seen'
export const LAUNCH_NOTICE_EVENT = 'ginjiro:launch-notice'
/** 公開時刻の「12:00」（日本時間） */
const launchHm = () => new Date(launchAt() + 9 * 3600_000).toISOString().slice(11, 16)

/** カチッ（オリジナル：短いクリック音を2つ重ねて作る） */
let audio: AudioContext | null = null
function unlockAudio() {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!audio && AC) audio = new AC()
    void audio?.resume()
  } catch { /* 音が出せない端末 */ }
}
function click(last: boolean) {
  if (!audio || audio.state !== 'running') return
  const t = audio.currentTime
  for (const [freq, at, len, vol] of [[last ? 880 : 2400, 0, 0.012, 0.35], [last ? 440 : 1200, 0.018, 0.03, 0.18]] as const) {
    const o = audio.createOscillator(), g = audio.createGain()
    o.type = 'square'; o.frequency.value = freq
    g.gain.setValueAtTime(vol, t + at); g.gain.exponentialRampToValueAtTime(0.0001, t + at + len + (last ? 0.25 : 0))
    o.connect(g).connect(audio.destination); o.start(t + at); o.stop(t + at + len + (last ? 0.3 : 0.02))
  }
}

/** アプリのいちばん上に置く：サーバー時刻合わせ・全画面の時計・00:00 の切り替え */
export function LaunchClock() {
  const now = useServerSecond()
  const phase = phaseAt(now)
  // 開いたときに公開前だった画面だけ、00:00 で読み込み直す（もう新画面の画面は読み込み直さない）
  const startedNew = useRef(ginFlow())
  const lastSec = useRef<number | null>(null)

  useEffect(() => {
    void syncServerClock()
    const onShow = () => { if (document.visibilityState === 'visible') void syncServerClock() }
    document.addEventListener('visibilitychange', onShow)
    // 音は最初に触ったときに出せるようにする（iPhone は触るまで音を出せない）
    window.addEventListener('pointerdown', unlockAudio, { once: true })
    return () => { document.removeEventListener('visibilitychange', onShow); window.removeEventListener('pointerdown', unlockAudio) }
  }, [])

  // 時刻を合わせた結果、もう公開時刻を過ぎていて旧画面のまま → 読み込み直す
  useEffect(() => {
    if (phase === 'after' && !startedNew.current && ginFlow()) {
      startedNew.current = true
      window.location.reload()
    }
  }, [phase])

  const left = launchAt() - now
  const sec = Math.max(0, Math.ceil(left / 1000))
  useEffect(() => {
    if (phase !== 'full' && !(phase === 'after' && lastSec.current !== null && lastSec.current > 0)) return
    if (lastSec.current !== sec) click(sec === 0)
    lastSec.current = sec
  }, [phase, sec])

  if (phase !== 'full') return null
  const mm = String(Math.floor(sec / 60)).padStart(2, '0'), ss = String(sec % 60).padStart(2, '0')
  return (
    <div className="launch-full" role="timer" aria-live="off" aria-label={`新しい銀二郎まで ${sec} 秒`} onPointerDown={unlockAudio}>
      <p className="launch-full-kicker">新しい銀二郎まで</p>
      <p className="launch-full-time"><span>{mm}</span><i>:</i><span>{ss}</span></p>
    </div>
  )
}

/** ホーム上部：「新しい銀二郎まで HH:MM:SS」（3時間前〜） */
export function LaunchStrip() {
  const now = useServerSecond()
  if (phaseAt(now) !== 'countdown' || ginFlow()) return null
  return (
    <button type="button" className="launch-strip" onClick={() => window.dispatchEvent(new Event(LAUNCH_NOTICE_EVENT))}>
      <span>新しい銀二郎まで</span><b>{hms(launchAt() - now)}</b>
    </button>
  )
}

/** 告知：公開前（カウントダウン中・アプリを開くたびに1回）と、公開後（1回だけ）。出ている間は true を返す */
export function LaunchNotice({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const now = useServerSecond()
  const phase = phaseAt(now)
  const after = phase === 'after' && launched() && ginFlow()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let want = false
    try {
      if (after) want = localStorage.getItem(NOTICE_KEY) !== String(launchAt())
      else if (phase === 'countdown' && !ginFlow()) want = !sessionStorage.getItem(PRE_NOTICE_SESSION)
    } catch { /* 保存できない端末 */ }
    if (want) setOpen(true) // eslint-disable-line react-hooks/set-state-in-effect -- 公開の前後で1回だけ開く
  }, [after, phase])
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(LAUNCH_NOTICE_EVENT, show)
    return () => window.removeEventListener(LAUNCH_NOTICE_EVENT, show)
  }, [])
  useEffect(() => { onOpenChange?.(open) }, [open, onOpenChange])
  if (phase === 'full') return null // 全画面の時計のあいだは出さない

  const close = () => {
    try { if (after) localStorage.setItem(NOTICE_KEY, String(launchAt())); else sessionStorage.setItem(PRE_NOTICE_SESSION, '1') } catch { /* なし */ }
    setOpen(false)
  }
  const look = () => {
    close()
    // 既存の使い方ガイド「銀ちゃんとAI予約する」を始める
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('ginjiro-guide:run', { detail: { ns: 'customer', task: 'c-book' } })), 350)
  }
  if (!open) return null
  return (
    <div className="launch-notice-back" onClick={close}>
      <section className="launch-notice" role="dialog" aria-modal="true" aria-label="新しい銀二郎" onClick={e => e.stopPropagation()}>
        {after ? (
          <>
            <p className="launch-notice-kicker">お知らせ</p>
            <h2>新しい銀二郎になりました</h2>
            <ul>
              <li>銀ちゃんに話しかけるか、ボタンを押すだけで予約できます</li>
              <li>予約の変更・キャンセルも、銀ちゃんにお任せください</li>
              <li>ご家族・ご友人の分も、まとめて予約できます</li>
            </ul>
            <button type="button" className="launch-notice-main" onClick={look}>見てみる</button>
            <button type="button" className="launch-notice-sub" onClick={close}>あとで</button>
          </>
        ) : (
          <>
            <p className="launch-notice-kicker">お知らせ</p>
            <h2>本日 {launchHm()}、<br />新しい銀二郎になります</h2>
            <p className="launch-notice-count"><span>あと</span><b>{hms(launchAt() - now)}</b></p>
            <p className="launch-notice-note">切り替わる瞬間は、この画面のままでお待ちください。</p>
            <button type="button" className="launch-notice-main" onClick={close}>閉じる</button>
          </>
        )}
      </section>
    </div>
  )
}
