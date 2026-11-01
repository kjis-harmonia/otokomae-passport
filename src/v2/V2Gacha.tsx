// 本日のガチャ（10/29 慶一郎さん、10/30 動画を3部構成に）：下タブ「ガチャ」→「本日のガチャを回す」で演出の動画を画面いっぱいに流す。
// 1部〜3部（INTRO、深海の秘宝：海に沈む神殿→光る球）→ タップ待ち（WAIT、くり返し）→ お客様が球をタップ → 3部 開放 → 真っ白 → 4部 銀ちゃん（OPEN、1本につないである）→ 結果。景品・1日1回はまだ決まっていないので、結果は「準備中」。
// 動画は public/gacha（Gemini で作ったもの・縦 9:16）。INTRO の終わりは WAIT の始まりと同じコマ、WAIT は終わりと始まりを 0.5 秒重ねてくり返し。OPEN は開放→真っ白（0.75 秒で白へ）→スキューバの銀ちゃんが黄金チケットを掲げる（白から 0.5 秒で溶かす・10/30）。
// 3本は別の video を重ねる。次の動画が実際に動き出してから前の動画を隠す（切り替えで黒や下絵が挟まらない）。開放はタップの位置がどこでも 0.5 秒で溶かして出す。
// iPhone は preload を守らず流しながら読むので、電波しだいでカクカクする（10/30「球体もカクカク」）。タブを開いたら3本とも先に全部読み、読み終わってからボタンを押せる。
// 音は独立したWeb Audioのクロックでつなぐ。videoは常にミュートし、待機のループでAACの再始動やended待ちの無音を挟まない。
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pointer, Sparkles, X } from 'lucide-react'
import { GachaSoundtrack, gachaAudioContext, loadGachaAudio, type GachaAudioBuffers } from '../audio/gachaSoundtrack'

const INTRO = '/gacha/gacha-intro.mp4'
const INTRO_POSTER = '/gacha/gacha-intro.jpg'
const WAIT = '/gacha/gacha-wait.mp4'
const OPEN = '/gacha/gacha-open.mp4'
const POSTER = '/gacha/gacha-wait.jpg'

type Phase = 'idle' | 'intro' | 'tap' | 'open' | 'result'

const FILES = [INTRO, WAIT, OPEN]
let cache: { urls: Record<string, string>; audio: GachaAudioBuffers } | null = null
async function loadAll(onProgress: (pct: number) => void, outerSignal: AbortSignal) {
  if (cache) return cache
  const controller = new AbortController()
  const abort = () => controller.abort()
  outerSignal.addEventListener('abort', abort)
  if (outerSignal.aborted) abort()
  const signal = controller.signal
  const got = FILES.map(() => 0)
  const sizes = FILES.map(() => 0)
  const created: string[] = []
  try {
  const [urls, audio] = await Promise.all([Promise.all(FILES.map(async (url, k) => {
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
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const objectUrl = URL.createObjectURL(new Blob(parts as BlobPart[], { type: 'video/mp4' }))
    created.push(objectUrl)
    return objectUrl
  })), loadGachaAudio(signal)])
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  cache = { urls: Object.fromEntries(FILES.map((u, k) => [u, urls[k]])), audio }
  return cache
  } catch (error) {
    controller.abort()
    created.forEach(url => URL.revokeObjectURL(url))
    throw error
  } finally {
    outerSignal.removeEventListener('abort', abort)
  }
}

const play = (v: HTMLVideoElement) => {
  v.muted = true
  return v.play()
}
const rewind = (v: HTMLVideoElement) => { v.pause(); v.currentTime = 0 }

export function V2Gacha() {
  const intro = useRef<HTMLVideoElement>(null)
  const wait = useRef<HTMLVideoElement>(null)
  const burst = useRef<HTMLVideoElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const phaseRef = useRef<Phase>('idle')
  const sound = useRef<GachaSoundtrack | null>(null)
  const introSoundStarted = useRef(false)
  const openSoundStarted = useRef(false)
  const waitStop = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [top, setTop] = useState<'intro' | 'wait' | 'burst'>('intro') // いま前に出ている動画
  const [src, setSrc] = useState<Record<string, string> | null>(cache?.urls ?? null)
  const [pct, setPct] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const move = useCallback((next: Phase) => { phaseRef.current = next; setPhase(next) }, [])

  useEffect(() => {
    if (src) return
    const ac = new AbortController()
    loadAll(setPct, ac.signal).then(ready => { if (!ac.signal.aborted) setSrc(ready.urls) }).catch(() => { if (!ac.signal.aborted) setLoadFailed(true) })
    return () => ac.abort()
  }, [src, attempt])

  const close = useCallback(() => {
    if (waitStop.current) clearTimeout(waitStop.current)
    waitStop.current = null
    for (const v of [intro.current, wait.current, burst.current]) v?.pause()
    sound.current?.stop()
    move('idle')
  }, [move])

  const start = () => {
    if (loadFailed) { setLoadFailed(false); setPct(0); setAttempt(n => n + 1); return }
    if (phaseRef.current !== 'idle' || !cache) return
    const i = intro.current
    const w = wait.current
    const b = burst.current
    if (!i || !w || !b) return
    sound.current ??= new GachaSoundtrack(gachaAudioContext(), cache.audio)
    sound.current.unlock() // Keep the iPhone audio unlock inside the user's gesture.
    introSoundStarted.current = false
    openSoundStarted.current = false
    rewind(b)
    rewind(i)
    rewind(w)
    setTop('intro')
    move('intro')
    void play(i).catch(close)
  }

  useEffect(() => {
    const i = intro.current
    const w = wait.current
    const b = burst.current
    if (!i || !w || !b) return
    // 1部・2部の最後のコマを出したまま待ちを流し、動き出したら入れ替える
    const introPlaying = () => {
      if (phaseRef.current !== 'intro' || introSoundStarted.current) return
      introSoundStarted.current = true
      sound.current?.startIntro(undefined, i.currentTime)
    }
    const introEnded = () => { if (phaseRef.current === 'intro') { move('tap'); void play(w).catch(close) } }
    const waitPlaying = () => { if (phaseRef.current === 'tap') setTop('wait') }
    const burstPlaying = () => {
      if (phaseRef.current !== 'open' || openSoundStarted.current) return
      openSoundStarted.current = true
      sound.current?.open(undefined, b.currentTime)
      setTop('burst')
      waitStop.current = setTimeout(() => w.pause(), 600) // Only the visual fade; audio has its own scheduled crossfade.
    }
    const burstEnded = () => { if (phaseRef.current === 'open') move('result') }
    const hide = () => { if (document.hidden) close() }
    i.addEventListener('playing', introPlaying)
    i.addEventListener('ended', introEnded)
    w.addEventListener('playing', waitPlaying)
    b.addEventListener('playing', burstPlaying)
    b.addEventListener('ended', burstEnded)
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', close)
    return () => {
      i.removeEventListener('playing', introPlaying)
      i.removeEventListener('ended', introEnded)
      w.removeEventListener('playing', waitPlaying)
      b.removeEventListener('playing', burstPlaying)
      b.removeEventListener('ended', burstEnded)
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', close)
      if (waitStop.current) clearTimeout(waitStop.current)
      sound.current?.dispose()
      sound.current = null
      for (const v of [i, w, b]) v.pause()
    }
  }, [close, move])

  const open = () => {
    const b = burst.current
    if (phaseRef.current !== 'tap' || !b) return
    move('open')
    sound.current?.unlock()
    void play(b).catch(close)
  }

  const showing = phase !== 'idle'
  return (
    <div className="v2-page">
      <h1 className="v2-title">本日のガチャ</h1>
      <section className="v2-gacha-card">
        <img src={POSTER} alt="" className="v2-gacha-poster" />
        <div className="v2-gacha-body">
          <p className="v2-gacha-lead">今日の運だめし。</p>
          <button type="button" className="v2-gacha-start" onClick={start} disabled={!src && !loadFailed}>{loadFailed ? '読み込み直す' : src ? <><Sparkles size={20} />本日のガチャを回す</> : `準備しています ${pct}%`}</button>
        </div>
      </section>
      <p className="v2-gacha-note">音が出ます。音量にご注意ください。</p>

      <div className={`v2-gacha-stage${showing ? ' is-on' : ''}`} aria-hidden={!showing} onClick={open}>
        <video ref={wait} src={src?.[WAIT]} poster={POSTER} loop muted playsInline preload="auto" />
        <video ref={intro} src={src?.[INTRO]} poster={INTRO_POSTER} className={top === 'intro' ? '' : 'is-off'} muted playsInline preload="auto" />
        <video ref={burst} src={src?.[OPEN]} className={`v2-gacha-burst${top === 'burst' ? ' is-on' : ''}`} muted playsInline preload="auto" />
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
