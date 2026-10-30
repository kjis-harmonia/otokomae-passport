// 本日のガチャ（10/29 慶一郎さん、10/30 動画を3部構成に）：下タブ「ガチャ」→「本日のガチャを回す」で演出の動画を画面いっぱいに流す。
// 1部〜3部（INTRO、深海の秘宝：海に沈む神殿→光る球）→ タップ待ち（WAIT、くり返し）→ お客様が球をタップ → 3部 開放 → 真っ白 → 4部 銀ちゃん（OPEN、1本につないである）→ 結果。景品・1日1回はまだ決まっていないので、結果は「準備中」。
// 動画は public/gacha（Gemini で作ったもの・縦 9:16）。INTRO の終わりは WAIT の始まりと同じコマ、WAIT は終わりと始まりを 0.5 秒重ねてくり返し。OPEN は開放→真っ白（0.75 秒で白へ）→スキューバの銀ちゃんが黄金チケットを掲げる（白から 0.5 秒で溶かす・10/30）。
// 3本は別の video を重ねる。次の動画が実際に動き出してから前の動画を隠す（切り替えで黒や下絵が挟まらない）。開放はタップの位置がどこでも 0.5 秒で溶かして出す。
// iPhone は preload を守らず流しながら読むので、電波しだいでカクカクする（10/30「球体もカクカク」）。タブを開いたら3本とも先に全部読み、読み終わってからボタンを押せる。
// 音を出すので、再生はボタン・タップのその場で始める（iPhone の決まり）。待ちはボタンのときに一度再生して止め、あとから音つきで流せるようにしておく
import { useEffect, useRef, useState } from 'react'
import { Pointer, Sparkles, X } from 'lucide-react'

const INTRO = '/gacha/gacha-intro.mp4'
const INTRO_POSTER = '/gacha/gacha-intro.jpg'
const WAIT = '/gacha/gacha-wait.mp4'
const OPEN = '/gacha/gacha-open.mp4'
const POSTER = '/gacha/gacha-wait.jpg'

type Phase = 'idle' | 'intro' | 'tap' | 'open' | 'result'

const FILES = [INTRO, WAIT, OPEN]
let cache: Record<string, string> | null = null // 一度読んだら、タブを行き来しても読み直さない
async function loadAll(onProgress: (pct: number) => void, signal: AbortSignal) {
  if (cache) return cache
  const got = FILES.map(() => 0)
  const sizes = FILES.map(() => 0)
  const urls = await Promise.all(FILES.map(async (url, k) => {
    const res = await fetch(url, { signal })
    if (!res.ok || !res.body) throw new Error(url)
    sizes[k] = Number(res.headers.get('content-length')) || 0
    const reader = res.body.getReader()
    const parts: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      got[k] += value.length
      const total = sizes.reduce((a, b) => a + b, 0)
      if (total) onProgress(Math.min(99, Math.floor(got.reduce((a, b) => a + b, 0) / total * 100)))
    }
    return URL.createObjectURL(new Blob(parts as BlobPart[], { type: 'video/mp4' }))
  }))
  cache = Object.fromEntries(FILES.map((u, k) => [u, urls[k]]))
  return cache
}

const play = (v: HTMLVideoElement) => {
  v.muted = false
  void v.play().catch(() => { v.muted = true; void v.play().catch(() => {}) })
}
const rewind = (v: HTMLVideoElement) => { v.pause(); v.currentTime = 0 }

export function V2Gacha() {
  const intro = useRef<HTMLVideoElement>(null)
  const wait = useRef<HTMLVideoElement>(null)
  const burst = useRef<HTMLVideoElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [top, setTop] = useState<'intro' | 'wait' | 'burst'>('intro') // いま前に出ている動画
  const [src, setSrc] = useState<Record<string, string> | null>(cache)
  const [pct, setPct] = useState(0)

  useEffect(() => {
    if (src) return
    const ac = new AbortController()
    // 読めなかったときは、そのまま流しながら読む（今までどおり）
    loadAll(setPct, ac.signal).then(setSrc).catch(() => { if (!ac.signal.aborted) setSrc(Object.fromEntries(FILES.map(u => [u, u]))) })
    return () => ac.abort()
  }, [src])

  const start = () => {
    const i = intro.current
    const w = wait.current
    const b = burst.current
    if (!i || !w || !b) return
    rewind(b)
    rewind(i)
    w.muted = false
    void w.play().then(() => rewind(w)).catch(() => {})
    setTop('intro')
    setPhase('intro')
    play(i)
  }
  const close = () => {
    for (const v of [intro.current, wait.current, burst.current]) v?.pause()
    setPhase('idle')
  }

  useEffect(() => {
    const i = intro.current
    const w = wait.current
    const b = burst.current
    if (!i || !w || !b) return
    // 1部・2部の最後のコマを出したまま待ちを流し、動き出したら入れ替える
    const introEnded = () => { setPhase(p => (p === 'intro' ? 'tap' : p)); play(w) }
    const waitPlaying = () => { if (i.ended) setTop(t => (t === 'intro' ? 'wait' : t)) } // ボタンのときの一度きりの再生では入れ替えない
    const burstPlaying = () => { setTop('burst'); setTimeout(() => w.pause(), 600) }
    const burstEnded = () => setPhase(p => (p === 'open' ? 'result' : p))
    i.addEventListener('ended', introEnded)
    w.addEventListener('playing', waitPlaying)
    b.addEventListener('playing', burstPlaying)
    b.addEventListener('ended', burstEnded)
    return () => {
      i.removeEventListener('ended', introEnded)
      w.removeEventListener('playing', waitPlaying)
      b.removeEventListener('playing', burstPlaying)
      b.removeEventListener('ended', burstEnded)
    }
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
          <button type="button" className="v2-gacha-start" onClick={start} disabled={!src}>{src ? <><Sparkles size={20} />本日のガチャを回す</> : `準備しています ${pct}%`}</button>
        </div>
      </section>
      <p className="v2-gacha-note">音が出ます。音量にご注意ください。</p>

      <div className={`v2-gacha-stage${showing ? ' is-on' : ''}`} aria-hidden={!showing} onClick={open}>
        <video ref={wait} src={src?.[WAIT]} poster={POSTER} loop playsInline preload="auto" />
        <video ref={intro} src={src?.[INTRO]} poster={INTRO_POSTER} className={top === 'intro' ? '' : 'is-off'} playsInline preload="auto" />
        <video ref={burst} src={src?.[OPEN]} className={`v2-gacha-burst${top === 'burst' ? ' is-on' : ''}`} playsInline preload="auto" />
        {phase === 'tap' && <p className="v2-gacha-tap"><Pointer size={30} strokeWidth={1.6} aria-hidden />光る球をタップ</p>}
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
