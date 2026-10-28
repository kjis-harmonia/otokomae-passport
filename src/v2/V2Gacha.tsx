// 本日のガチャ（10/29 慶一郎さん）：下タブ「ガチャ」→「本日のガチャを回す」で演出の動画を画面いっぱいに流す。
// 動画の最後（光る球）で止めずにくり返し、お客様が球をタップしたら開く。景品・1日1回はまだ決まっていないので、結果は「準備中」。
// 動画は public/gacha（Gemini で作ったもの）。音を出すので、再生はボタンを押したその場で始める（iPhone の決まり）
import { useEffect, useRef, useState } from 'react'
import { Sparkles, X } from 'lucide-react'

const VIDEO = '/gacha/gacha-01.mp4'
const POSTER = '/gacha/gacha-01.jpg'
const TAP_AT = 17.5 // 手が球から離れて「どうぞ」になるところ
const LOOP_FROM = 18 // 最後の光る球だけをくり返す

type Phase = 'idle' | 'playing' | 'tap' | 'open'

export function V2Gacha() {
  const video = useRef<HTMLVideoElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')

  const start = () => {
    const v = video.current
    if (!v) return
    v.currentTime = 0
    v.muted = false
    setPhase('playing')
    void v.play().catch(() => { v.muted = true; void v.play().catch(() => setPhase('tap')) })
  }
  const close = () => { video.current?.pause(); setPhase('idle') }

  useEffect(() => {
    const v = video.current
    if (!v) return
    const tick = () => { if (v.currentTime >= TAP_AT) setPhase(p => (p === 'playing' ? 'tap' : p)) }
    const ended = () => { v.currentTime = LOOP_FROM; void v.play().catch(() => {}) }
    v.addEventListener('timeupdate', tick)
    v.addEventListener('ended', ended)
    return () => { v.removeEventListener('timeupdate', tick); v.removeEventListener('ended', ended) }
  }, [])

  const open = () => {
    if (phase !== 'tap') return
    setPhase('open')
    setTimeout(() => video.current?.pause(), 700)
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

      <div className={`v2-gacha-stage${showing ? ' is-on' : ''}${phase === 'open' ? ' is-open' : ''}`} aria-hidden={!showing} onClick={open}>
        <video ref={video} src={VIDEO} poster={POSTER} playsInline preload="auto" />
        {phase === 'tap' && <p className="v2-gacha-tap">光る球をタップ</p>}
        {phase === 'open' && <div className="v2-gacha-flash" />}
        {phase === 'open' && (
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
