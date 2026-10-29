// 本日のガチャ（10/29 慶一郎さん、10/30 動画を3部構成に）：下タブ「ガチャ」→「本日のガチャを回す」で演出の動画を画面いっぱいに流す。
// 1部・2部（INTRO）→ タップ待ち（WAIT、くり返し・最初と最後のコマが同じなので継ぎ目なし）→ お客様が球をタップ → 3部 開放（OPEN）→ 結果。
// 1部・2部の動画はまだないので、今は待ちから始まる。景品・1日1回はまだ決まっていないので、結果は「準備中」。
// 動画は public/gacha（Gemini で作ったもの・縦 9:16）。音を出すので、再生はボタン・タップのその場で始める（iPhone の決まり）。
// 待ちと開放は別の video を重ね、開放が実際に動き出してから待ちを隠す（切り替えで黒が挟まらないように）
import { useEffect, useRef, useState } from 'react'
import { Sparkles, X } from 'lucide-react'

const INTRO: string[] = [] // 1部・2部ができたら '/gacha/gacha-1.mp4', '/gacha/gacha-2.mp4' の順に入れる
const WAIT = '/gacha/gacha-wait.mp4'
const OPEN = '/gacha/gacha-open.mp4'
const POSTER = '/gacha/gacha-wait.jpg'

type Phase = 'idle' | 'intro' | 'tap' | 'open' | 'result'

const play = (v: HTMLVideoElement) => {
  v.muted = false
  void v.play().catch(() => { v.muted = true; void v.play().catch(() => {}) })
}
const playWait = (v: HTMLVideoElement) => {
  v.src = WAIT
  v.loop = true
  play(v)
}

export function V2Gacha() {
  const main = useRef<HTMLVideoElement>(null)
  const burst = useRef<HTMLVideoElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [clip, setClip] = useState(0)
  const [opened, setOpened] = useState(false) // 開放の動画が動き出した（待ちを隠してよい）


  const start = () => {
    const v = main.current
    const b = burst.current
    if (!v || !b) return
    setOpened(false)
    b.pause()
    b.currentTime = 0
    if (INTRO.length) {
      setClip(0)
      v.loop = false
      v.src = INTRO[0]
      play(v)
      setPhase('intro')
    } else {
      playWait(v)
      setPhase('tap')
    }
  }
  const close = () => { main.current?.pause(); burst.current?.pause(); setOpened(false); setPhase('idle') }

  // 1部が終わったら2部、最後まで行ったら待ちへ
  useEffect(() => {
    const v = main.current
    if (!v) return
    const ended = () => {
      if (phase !== 'intro') return
      const next = clip + 1
      if (next < INTRO.length) { setClip(next); v.src = INTRO[next]; play(v) } else { playWait(v); setPhase('tap') }
    }
    v.addEventListener('ended', ended)
    return () => v.removeEventListener('ended', ended)
  }, [phase, clip])

  useEffect(() => {
    const b = burst.current
    if (!b) return
    const playing = () => { setOpened(true); main.current?.pause() }
    const ended = () => setPhase(p => (p === 'open' ? 'result' : p))
    b.addEventListener('playing', playing)
    b.addEventListener('ended', ended)
    return () => { b.removeEventListener('playing', playing); b.removeEventListener('ended', ended) }
  }, [])

  const open = () => {
    const b = burst.current
    if (phase !== 'tap' || !b) return
    setPhase('open')
    play(b)
  }

  const showing = phase !== 'idle'
  return (
    <div className="v2-page">
      <h1 className="v2-title">本日のガチャ</h1>
      <section className="v2-gacha-card">
        <img src={POSTER} alt="" className="v2-gacha-poster" />
        <div className="v2-gacha-body">
          <p className="v2-gacha-lead">今日の運だめし。</p>
          <button type="button" className="v2-gacha-start" onClick={start}><Sparkles size={20} />本日のガチャを回す</button>
        </div>
      </section>
      <p className="v2-gacha-note">音が出ます。音量にご注意ください。</p>

      <div className={`v2-gacha-stage${showing ? ' is-on' : ''}`} aria-hidden={!showing} onClick={open}>
        <video ref={main} poster={POSTER} playsInline preload="auto" src={WAIT} />
        <video ref={burst} className={`v2-gacha-burst${opened ? ' is-on' : ''}`} src={OPEN} playsInline preload="auto" />
        {phase === 'tap' && <p className="v2-gacha-tap">光る球をタップ</p>}
        {phase === 'result' && <div className="v2-gacha-flash" />}
        {phase === 'result' && (
          <div className="v2-gacha-result" onClick={e => e.stopPropagation()}>
            <Sparkles size={28} />
            <b>景品は準備中です</b>
            <span>もうすぐ始まります。お楽しみに。</span>
            <button type="button" onClick={close}>閉じる</button>
          </div>
        )}
        {showing && <button type="button" className="v2-gacha-close" aria-label="閉じる" onClick={e => { e.stopPropagation(); close() }}><X size={22} /></button>}
      </div>
    </div>
  )
}
