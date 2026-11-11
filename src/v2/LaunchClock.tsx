// 新しい銀二郎の公開（11/11）：カウントダウン・全画面の時計・公開後の告知
//   - 3時間前〜60秒前：ホーム上部と告知に「新しい銀二郎まで HH:MM:SS」（1秒ごと）
//   - 60秒前から：画面いっぱいのデジタル時計（00:59 → 00:00、1秒ごとにカチッ）
//   - 00:00：開いている画面も読み込み直して新画面へ。読み込み後に新しい告知 →【見てみる】で銀ちゃんの案内
//   時刻・公開時刻は utils/launch.ts（定数は公開時刻ひとつ）
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { hms, launchAt, launched, launchHm, syncServerClock } from '../utils/launch'
import { KAIKIN_DONE_EVENT, KAIKIN_FADE_KEY, kaikinSeen, markKaikinSeen, phaseAt, useServerSecond } from './launchTime'
const RELOADS_KEY = 'ginjiro_launch_reloads'
import { ginFlow, ginFlowConfigured } from '../utils/env'
import { BOOKING_IDLE_EVENT, bookingInFlight } from '../utils/bookingInFlight'

const NOTICE_KEY = 'ginjiro_launch_notice_seen'
const PRE_NOTICE_SESSION = 'ginjiro_launch_pre_seen'
export const LAUNCH_NOTICE_EVENT = 'ginjiro:launch-notice'

// ── 音（すべてこのアプリのために作ったもの。ほかの作品の音は使わない） ──
let audio: AudioContext | null = null
function unlockAudio() {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!audio && AC) audio = new AC()
    void audio?.resume()
  } catch { /* 音が出せない端末 */ }
}
const ready = () => !!audio && audio.state === 'running'
/** 低い一打（周波数が沈んでいく正弦波） */
function thump(at: number, vol: number, from: number, to: number, len: number) {
  const a = audio!, o = a.createOscillator(), g = a.createGain()
  o.type = 'sine'; o.frequency.setValueAtTime(from, at); o.frequency.exponentialRampToValueAtTime(to, at + len)
  g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(vol, at + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, at + len)
  o.connect(g).connect(a.destination); o.start(at); o.stop(at + len + 0.02)
}
/** 1秒ごとの音：ふだんは小さく静かなカチッ。残り10秒からは鼓動のような重い「ドクン」 */
function tick(heart: boolean) {
  if (!ready()) return
  const t = audio!.currentTime
  if (heart) { thump(t, 0.9, 78, 42, 0.28); thump(t + 0.2, 0.55, 66, 40, 0.24); return }
  const a = audio!, o = a.createOscillator(), g = a.createGain()
  o.type = 'triangle'; o.frequency.value = 1600
  g.gain.setValueAtTime(0.16, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03)
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + 0.05)
}
/** 0 の「ドン」：低い音が沈んでいく太鼓のような一打 */
function don() {
  if (!ready()) return
  const a = audio!, t = a.currentTime
  const o = a.createOscillator(), g = a.createGain()
  o.type = 'sine'; o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.6)
  g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6)
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + 1.7)
  // 叩いた瞬間の「ザッ」
  const n = a.createBuffer(1, Math.floor(a.sampleRate * 0.12), a.sampleRate), d = n.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length)
  const src = a.createBufferSource(), f = a.createBiquadFilter(), ng = a.createGain()
  src.buffer = n; f.type = 'lowpass'; f.frequency.value = 900; ng.gain.value = 0.5
  src.connect(f).connect(ng).connect(a.destination); src.start(t)
}

/** 公開の60秒間・解禁のあいだ、アプリのほかの操作を一切受け付けない層（いちばん上に開く dialog） */
function BlockLayer({ children, tone }: { children: React.ReactNode; tone: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // ほかに開いている dialog（Face ID の案内など）より上に出すため、いったん閉じて開き直す
    if (!el.open) { try { el.showModal() } catch { el.setAttribute('open', '') } }
    const cancel = (e: Event) => e.preventDefault() // Esc で閉じない
    const key = (e: KeyboardEvent) => { e.preventDefault(); e.stopPropagation() }
    // 戻る（ブラウザの戻る・Android の戻る）も効かないように
    history.pushState({ launchLock: true }, '')
    const pop = () => history.pushState({ launchLock: true }, '')
    el.addEventListener('cancel', cancel)
    window.addEventListener('keydown', key, true)
    window.addEventListener('popstate', pop)
    return () => {
      el.removeEventListener('cancel', cancel)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('popstate', pop)
      if (el.open) el.close()
    }
  }, [])
  return <dialog ref={ref} className={`launch-layer ${tone}`} aria-label="新しい銀二郎" onPointerDown={unlockAudio}>{children}</dialog>
}

// 12:00:00 の流れ：00:00:00（0.4秒）→ 真っ暗（0.25秒）→ 白い筆文字「解禁」をドンと押す＋ドン（1.7秒）→ ふわっと新しい画面（0.7秒）→ 銀ちゃんの案内
//   旧画面だった人は、読み込み直すと音が出せないので「解禁」とドンを読み込み直す前に見せ、新しい画面で「解禁」からふわっと明ける
type Seq = 'none' | 'zero' | 'black' | 'stamp' | 'reveal' | 'out'
const T_ZERO = 400, T_BLACK = 250, T_STAMP = 1700, T_OUT = 700

/** 案内を始める：銀ちゃんとAI予約する（既存のガイド） */
function startGuide() {
  try { sessionStorage.setItem('ginjiro_launch_guided', '1') } catch { /* なし */ }
  try { localStorage.setItem('ginjiro_launch_notice_seen', String(launchAt())) } catch { /* なし */ } // 公開後の告知の代わりに案内へ
  window.setTimeout(() => window.dispatchEvent(new CustomEvent('ginjiro-guide:run', { detail: { ns: 'customer', task: 'c-launch' } })), 300)
}

/** アプリのいちばん上に置く（お客様アプリだけ）：時刻合わせ・最後の60秒・00:00:00・解禁・切り替え */
export function LaunchClock() {
  const now = useServerSecond()
  const phase = phaseAt(now)
  const on = ginFlowConfigured() // 新しい流れが入る環境だけ（本番で VITE_GIN_FLOW が無ければ何もしない）
  const [startedNew] = useState(ginFlow) // 開いたときに旧画面だった画面だけ、00:00 で読み込み直す
  const [, setIdleTick] = useState(0)
  const [clockOn, setClockOn] = useState(false)
  const [finished, setFinished] = useState(false)
  const [seq, setSeq] = useState<Seq>(() => {
    // 読み込み直した直後：「解禁」からふわっと明ける
    try { return sessionStorage.getItem(KAIKIN_FADE_KEY) === String(launchAt()) ? 'reveal' : 'none' } catch { return 'none' }
  })
  const lastSec = useRef<number | null>(null)
  const seqStarted = useRef(false)

  useEffect(() => {
    void syncServerClock()
    const onShow = () => { if (document.visibilityState === 'visible') void syncServerClock() }
    const idle = () => setIdleTick(n => n + 1)
    document.addEventListener('visibilitychange', onShow)
    window.addEventListener(BOOKING_IDLE_EVENT, idle)
    // 音は最初に触ったときに出せるようにする（iPhone は触るまで音を出せない）
    window.addEventListener('pointerdown', unlockAudio, { once: true })
    return () => {
      document.removeEventListener('visibilitychange', onShow)
      window.removeEventListener(BOOKING_IDLE_EVENT, idle)
      window.removeEventListener('pointerdown', unlockAudio)
    }
  }, [])

  // 予約の確定・変更・取消の通信中は、終わるまで暗転しない（公開を20秒過ぎたら待たない）
  const waiting = bookingInFlight() && now < launchAt() + 20_000
  const sec = Math.max(0, Math.ceil((launchAt() - now) / 1000))

  // 最後の60秒：通信が終わっていれば時計を出す（いったん出したら公開まで消さない）
  useEffect(() => {
    if (on && phase === 'full' && !waiting && !clockOn) setClockOn(true) // eslint-disable-line react-hooks/set-state-in-effect -- 60秒前に1回だけ
  }, [on, phase, waiting, clockOn])

  // 1秒ごとのカチッ（残り10秒から少し強く）
  useEffect(() => {
    if (!clockOn || phase !== 'full' || lastSec.current === sec) return
    if (lastSec.current !== null && sec > 0) tick(sec <= 10)
    lastSec.current = sec
  }, [clockOn, phase, sec])

  // 読み込み直した直後：「解禁」から新しい画面へふわっと
  useEffect(() => {
    if (seq !== 'reveal' || seqStarted.current) return
    seqStarted.current = true
    try { sessionStorage.removeItem(KAIKIN_FADE_KEY) } catch { /* なし */ }
    window.setTimeout(() => setSeq('out'), 350)
    window.setTimeout(() => { setSeq('none'); window.dispatchEvent(new Event(KAIKIN_DONE_EVENT)); startGuide() }, 350 + T_OUT)
  }, [seq])

  // 公開の瞬間
  useEffect(() => {
    if (!on || phase !== 'after' || seqStarted.current || waiting) return
    const needReload = !startedNew && ginFlow()
    if (!clockOn && !needReload && (!ginFlow() || kaikinSeen())) return
    seqStarted.current = true
    let t = 0
    const at = (ms: number, f: () => void) => { t += ms; window.setTimeout(f, t) }
    // 公開の瞬間に1回だけ流れを始める
    if (clockOn) { setSeq('zero'); at(T_ZERO, () => setSeq('black')) } else setSeq('black') // eslint-disable-line react-hooks/set-state-in-effect -- 公開の瞬間に1回だけ
    at(T_BLACK, () => { setSeq('stamp'); don() })
    markKaikinSeen()
    try { sessionStorage.setItem('ginjiro_launch_guided', '1') } catch { /* なし */ } // この起動ではキャンペーンのお知らせを出さず案内へ
    if (needReload) {
      at(T_STAMP, () => {
        let n = 0
        try { n = Number(sessionStorage.getItem(RELOADS_KEY) || 0); sessionStorage.setItem(RELOADS_KEY, String(n + 1)) } catch { /* なし */ }
        if (n < 2) {
          try { sessionStorage.setItem(KAIKIN_FADE_KEY, String(launchAt())) } catch { /* なし */ }
          window.location.reload()
        } else { setFinished(true); setSeq('none'); startGuide() } // 読み込み直しを繰り返さない（端末の時計が大きくずれているときなど）
      })
    } else {
      at(T_STAMP, () => setSeq('out'))
      at(T_OUT, () => { setFinished(true); setSeq('none'); window.dispatchEvent(new Event(KAIKIN_DONE_EVENT)); startGuide() })
    }
    // タイマーは片付けない（1回だけ・数秒で終わる。途中で消すと真っ暗のまま止まるため）
  }, [on, phase, waiting, clockOn, startedNew])

  // 0 になった瞬間も時計の層を出したまま（消して出し直すと暗転がもう一度かかる）。流れが終わったら出さない
  const showClock = clockOn && !finished && (phase === 'full' || phase === 'after')
  if (seq === 'none' && !showClock) return null
  if (seq === 'black') return <BlockLayer tone="is-black"><span /></BlockLayer>
  if (seq === 'stamp' || seq === 'reveal' || seq === 'out') {
    return (
      <BlockLayer tone={`is-kaikin${seq === 'stamp' ? ' is-stamp' : ''}${seq === 'out' ? ' is-out' : ''}`}>
        <img className="launch-kaikin" src="/gacha/kaikin-brush.png" alt="解禁" />
      </BlockLayer>
    )
  }
  // 発表会のような静かな時計：秒の数字だけを中央に。周りの金の細い輪が60秒かけて減る（11/11 慶一郎さん）
  const shown = seq === 'zero' || phase === 'after' ? 0 : Math.min(59, sec)
  const R = 92, C = 2 * Math.PI * R
  const rest = seq === 'zero' || phase === 'after' ? 0 : Math.max(0, Math.min(1, (launchAt() - now) / 60_000))
  return (
    <BlockLayer tone={`is-clock${shown <= 10 ? ' is-gold' : ''}${shown === 0 ? ' is-zero' : ''}`}>
      <div className="launch-clock" role="timer" aria-label={`新しい銀二郎まで ${shown} 秒`}>
        <p className="launch-clock-kicker">新しい銀二郎まで</p>
        <div className="launch-dial">
          <svg className="launch-ring" viewBox="0 0 200 200" aria-hidden="true">
            <circle className="launch-ring-track" cx="100" cy="100" r={R} />
            <circle className="launch-ring-arc" cx="100" cy="100" r={R} strokeDasharray={C} strokeDashoffset={C * (1 - rest)} />
          </svg>
          {/* key を変えて、1秒ごとにふわっと入れ替える */}
          <span key={shown} className="launch-sec">{shown}</span>
        </div>
      </div>
    </BlockLayer>
  )
}

/** ホーム上部：「新しい銀二郎まで HH:MM:SS」（3時間前〜） */
export function LaunchStrip() {
  const now = useServerSecond()
  if (!ginFlowConfigured() || phaseAt(now) !== 'countdown' || ginFlow()) return null
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
  // 公開後の告知は「解禁」を見終わってから
  const [kaikinDone, setKaikinDone] = useState(kaikinSeen)
  useEffect(() => {
    const done = () => setKaikinDone(true)
    window.addEventListener(KAIKIN_DONE_EVENT, done)
    return () => window.removeEventListener(KAIKIN_DONE_EVENT, done)
  }, [])

  useEffect(() => {
    let want = false
    try {
      if (!ginFlowConfigured()) want = false
      else if (after) want = kaikinDone && localStorage.getItem(NOTICE_KEY) !== String(launchAt())
      else if (phase === 'countdown' && !ginFlow()) want = !sessionStorage.getItem(PRE_NOTICE_SESSION)
    } catch { /* 保存できない端末 */ }
    if (want) setOpen(true) // eslint-disable-line react-hooks/set-state-in-effect -- 公開の前後で1回だけ開く
  }, [after, phase, kaikinDone])
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
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('ginjiro-guide:run', { detail: { ns: 'customer', task: 'c-launch' } })), 350)
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
