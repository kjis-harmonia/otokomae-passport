// 本日のガチャ（10/29 慶一郎さん、10/30 動画を3部構成に）：下タブ「ガチャ」→「本日のガチャを回す」で演出の動画を画面いっぱいに流す。
// 1部〜3部（INTRO、深海の秘宝：海に沈む神殿→光る球）→ タップ待ち（WAIT、くり返し）→ お客様が球をタップ → 3部 開放 → 真っ白 → 4部 銀ちゃん（OPEN、1本につないである）→ 結果。
// 景品（11/3）：回し始めたらサーバーで抽選（1日1回・同じ日は同じ結果）。演出のあいだに結果が届き、最後にガチャ券を見せる。券を持っていれば、どちらを残すか選んでもらう。
// 動画は public/gacha（Gemini で作ったもの・縦 9:16）。INTRO の終わりは WAIT の始まりと同じコマ、WAIT は終わりと始まりを 0.5 秒重ねてくり返し。OPEN は開放→真っ白（0.75 秒で白へ）→スキューバの銀ちゃんが黄金チケットを掲げる（白から 0.5 秒で溶かす・10/30）。
// 3本は別の video を重ねる。次の動画が実際に動き出してから前の動画を隠す（切り替えで黒や下絵が挟まらない）。開放はタップのあと待ちを早送りで終わりまで進め、待ちの最後のコマ＝開放の最初のコマでつなぐ（11/1）。
// iPhone は preload を守らず流しながら読むので、電波しだいでカクカクする（10/30「球体もカクカク」）。タブを開いたら3本とも先に全部読み、読み終わってからボタンを押せる。
// 音は独立したWeb Audioのクロックでつなぐ。videoは常にミュートし、待機のループでAACの再始動やended待ちの無音を挟まない。
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, Pointer, Sparkles, Volume2, X } from 'lucide-react'
import { canUseGacha, drawGacha, gachaDays, gachaReservedLabel, gachaUntil, keepGacha, loadGacha, type GachaPrize, type GachaState } from '../features/gacha/gachaApi'
import { GACHA_AUDIO_FILES, GachaSoundtrack, gachaAudioContext, loadGachaAudio, type GachaAudioBuffers, type GachaAudioFiles } from '../audio/gachaSoundtrack'
import { GachaAudioPlayback } from '../audio/gachaAudioPlayback'
import { isStaging } from '../utils/env'
import { afterPresentedFrame } from '../features/gacha/presentedFrame'
import { GachaShowcase } from './GachaShowcase'
import { GachaGauge, GaugeMonth } from './GachaGauge'

// 演出はガチャ画面を開くたびにランダム（11/1、11/3 アプリを開き直さなくても画面ごとに選び直す）。読むのは選ばれたテーマの3本と音だけ（スマホで全テーマを読むと重い）。
// 深海の秘宝は最後に銀ちゃん（動画）、銀河の秘宝は真っ白の中から黄金チケットがこちらへ飛んでくる（アプリで描く・11/1 慶一郎さん「銀ちゃんは難しい！」）
type Theme = { short: string; id: 'deep' | 'galaxy' | 'dino'; name: string; tap?: string; intro: string; introPoster: string; wait: string; open: string; poster: string; audio: GachaAudioFiles; introFade?: number; ticketAt?: number; ticket?: string; hold?: boolean }
const THEMES: Theme[] = [
  { id: 'deep', short: '深海編', name: '深海の秘宝', intro: '/gacha/gacha-intro.mp4?v=deep3', introPoster: '/gacha/gacha-intro.jpg', wait: '/gacha/gacha-wait.mp4', open: '/gacha/gacha-open.mp4?v=deep2', poster: '/gacha/gacha-wait.jpg', audio: GACHA_AUDIO_FILES },
  // 銀河の音は1部の終わりがそのまま待ちの頭へ続く曲なので、重ねるのは短く。開放は 7.9 秒で真っ白になりきる。そこからチケットを飛ばす
  { id: 'galaxy', short: '銀河編', name: '銀河の秘宝', intro: '/gacha/galaxy/intro.mp4', introPoster: '/gacha/galaxy/intro.jpg', wait: '/gacha/galaxy/wait.mp4', open: '/gacha/galaxy/open.mp4', poster: '/gacha/galaxy/wait.jpg',
    audio: { intro: '/gacha/galaxy/intro-audio.m4a', wait: '/gacha/galaxy/wait-audio.wav', open: '/gacha/galaxy/open-audio.m4a' }, introFade: 0.15, ticketAt: 7.9, ticket: '/gacha/galaxy/ticket.jpg', hold: true }, // 保留中（11/1「宇宙編微妙やな」）。ランダムには出さない
  // 恐竜編：レックスの咆哮→大草原→洞窟→光る足跡。開放は足跡から光の柱→真っ白→鳳凰編の走る銀ちゃん（1本につないである・11/2）
  { id: 'dino', short: '恐竜編', name: '太古の覇王', tap: '光る足跡をタップ', intro: '/gacha/dino/intro.mp4?v=cut8', introPoster: '/gacha/dino/intro.jpg?v=cut8', wait: '/gacha/dino/wait.mp4?v=seam2', open: '/gacha/dino/open.mp4?v=cut8', poster: '/gacha/dino/wait.jpg?v=seam2',
    audio: { intro: '/gacha/dino/intro-audio.m4a?v=cut8', wait: '/gacha/dino/wait-audio.wav', open: '/gacha/dino/open-audio.m4a?v=cut8' } },
]
// ?gacha=galaxy で決めうち（見比べる用・保留中のテーマも出せる）
const pick = new URLSearchParams(location.search).get('gacha')
const LIVE = THEMES.filter(t => !t.hold)
// 前回と同じ演出は続けない（11/3 慶一郎さん「海底編しか流れん」：半々のくじだと同じものが何回も続くことがある）
const LAST_KEY = "ginjiro-gacha-last-theme"
const readLast = () => { try { return localStorage.getItem(LAST_KEY) } catch { return null } }
const saveLast = (id: string) => { try { localStorage.setItem(LAST_KEY, id) } catch { /* 覚えられなくても回せる */ } }
const pickTheme = (chosen: Theme["id"] | null) => {
  const fixed = THEMES.find(t => t.id === (chosen ?? pick))
  if (fixed) return fixed
  const last = readLast()
  const pool = LIVE.filter(t => t.id !== last)
  const from = pool.length ? pool : LIVE
  return from[Math.floor(Math.random() * from.length)]
}

type Phase = 'idle' | 'intro' | 'tap' | 'open' | 'result'

type Loaded = { urls: Record<string, string>; audio: GachaAudioBuffers }
const caches: Partial<Record<Theme["id"], Loaded>> = {} // 一度読んだテーマはアプリを閉じるまで持っておく
async function loadAll(THEME: Theme, onProgress: (pct: number) => void, outerSignal: AbortSignal) {
  const FILES = [THEME.intro, THEME.wait, THEME.open]
  const had = caches[THEME.id]
  if (had) return had
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
  })), loadGachaAudio(signal, THEME.audio)])
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const loaded = { urls: Object.fromEntries(FILES.map((u, k) => [u, urls[k]])), audio }
  caches[THEME.id] = loaded
  return loaded
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

// Staging だけ：演出を選んで見られる（11/3 慶一郎さん「海底編、恐竜編で見たいけん、ボタン設置して」）。選び直すと画面ごと作り直す
// 解禁日（11/5 慶一郎さん「ガチャ解禁は11/11って決まってる」）。それまで本番はタブを開くと「準備中」だけ出す（動画も読まない）。Staging は試すのでいつでも開く
// サーバーも app_private.gacha_settings.opens_on より前は抽選しない（customer_gacha_draw → not_open）
const GACHA_OPENS = '2026-11-11'
const gachaOpen = () => isStaging() || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10) >= GACHA_OPENS

// 今月のラインナップも解禁日まで見せない（11/6 慶一郎さん「今月のラインナップも見れないようにして」）
function GachaSoon() {
  return (
    <div className="v2-page">
      <section className="v2-gacha-card">
        <img src="/gacha/gacha-top.jpg" alt="ガチャマシンと銀ちゃん" className="v2-gacha-poster" />
        <div className="v2-gacha-body">
          <p className="v2-big" style={{ fontSize: 20, textAlign: 'center' }}>ただいま準備中です</p>
          <p className="v2-note" style={{ textAlign: 'center', margin: '6px 0 0' }}>11月11日（水）からお楽しみいただけます。</p>
        </div>
      </section>
    </div>
  )
}

export function V2Gacha() {
  const [chosen, setChosen] = useState<Theme["id"] | null>(null)
  if (!gachaOpen()) return <GachaSoon />
  return <GachaScreen key={chosen ?? "auto"} chosen={chosen} onChoose={isStaging() ? setChosen : undefined} />
}

function GachaScreen({ chosen, onChoose }: { chosen: Theme["id"] | null; onChoose?: (id: Theme["id"]) => void }) {
  const [THEME] = useState(() => pickTheme(chosen))
  useEffect(() => { if (!pick && !chosen) saveLast(THEME.id) }, [THEME, chosen])
  const { intro: INTRO, introPoster: INTRO_POSTER, wait: WAIT, open: OPEN, poster: POSTER } = THEME
  const cache = caches[THEME.id] ?? null
  const intro = useRef<HTMLVideoElement>(null)
  const wait = useRef<HTMLVideoElement>(null)
  const burst = useRef<HTMLVideoElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [ticket, setTicket] = useState(false) // 銀河：黄金チケットが飛んできた
  const phaseRef = useRef<Phase>('idle')
  const sound = useRef<GachaAudioPlayback | null>(null)
  const introPresented = useRef(false)
  const openPresented = useRef(false)
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [audioChecking, setAudioChecking] = useState(false)
  const resultCuePending = useRef(false)
  const waitStop = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reveals = useRef(new Set<() => void>())
  const [top, setTop] = useState<'intro' | 'wait' | 'burst'>('intro') // いま前に出ている動画
  const [src, setSrc] = useState<Record<string, string> | null>(cache?.urls ?? null)
  const [pct, setPct] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const move = useCallback((next: Phase) => { phaseRef.current = next; setPhase(next) }, [])
  const [gacha, setGacha] = useState<GachaState | null>(null) // 今日の結果と持ち券
  const [drawn, setDrawn] = useState<GachaState | 'error' | null>(null) // 今回回した結果（演出のあいだに届く）
  const [keeping, setKeeping] = useState(false)
  const [lineup, setLineup] = useState(false) // 今月のラインナップ（3D ショーケース）

  useEffect(() => {
    // Do not celebrate loading, a failed draw, or merely reopening a saved result.
    if (THEME.id === 'deep' && resultCuePending.current && phase === 'result' && drawn && drawn !== 'error' && drawn.today) {
      if (sound.current?.result()) resultCuePending.current = false
    }
  }, [THEME.id, phase, drawn, audioBlocked])

  useEffect(() => {
    if (!canUseGacha()) return
    let live = true
    loadGacha().then(s => { if (live) setGacha(s) }).catch(() => {})
    return () => { live = false }
  }, [])

  const choose = async (choice: 'new' | 'old') => {
    if (keeping) return
    setKeeping(true)
    try { const s = await keepGacha(choice); setGacha(s); setDrawn(s) } catch { /* 選べなければそのまま。もう一度押せる */ }
    finally { setKeeping(false) }
  }

  useEffect(() => {
    if (src) return
    const ac = new AbortController()
    loadAll(THEME, setPct, ac.signal).then(ready => { if (!ac.signal.aborted) setSrc(ready.urls) }).catch(() => { if (!ac.signal.aborted) setLoadFailed(true) })
    return () => ac.abort()
  }, [src, attempt, THEME])

  const close = useCallback(() => {
    resultCuePending.current = false
    reveals.current.forEach(cancel => cancel())
    reveals.current.clear()
    if (waitStop.current) clearTimeout(waitStop.current)
    waitStop.current = null
    setTicket(false)
    for (const v of [intro.current, wait.current, burst.current]) v?.pause()
    sound.current?.dispose()
    sound.current = null
    setAudioBlocked(false)
    setAudioChecking(false)
    move('idle')
  }, [move])

  // 選ばずに閉じた当選（日付が変わっても残る・11/3）：演出はもう見せず、最後の場面（券を差し出す銀ちゃん）から選ぶ画面を開き直す（11/3）
  const pending = !!gacha?.today && gacha.today.choice === null && !!gacha.held
  const resume = () => {
    const b = burst.current
    if (phaseRef.current !== 'idle' || !b || !gacha) return
    const show = () => { b.pause(); if (Number.isFinite(b.duration)) b.currentTime = Math.max(0, b.duration - 0.05) }
    if (b.readyState >= 1) show(); else b.addEventListener('loadedmetadata', show, { once: true })
    setTicket(false)
    setDrawn(gacha)
    setTop('burst')
    move('result')
  }

  const start = () => {
    if (loadFailed) { setLoadFailed(false); setPct(0); setAttempt(n => n + 1); return }
    if (phaseRef.current !== 'idle' || !cache) return
    const i = intro.current
    const w = wait.current
    const b = burst.current
    if (!i || !w || !b) return
    sound.current?.dispose()
    sound.current = new GachaAudioPlayback(
      () => new GachaSoundtrack(gachaAudioContext(), cache.audio, THEME.introFade),
      () => {
        const current = phaseRef.current
        const video = current === 'intro' ? intro.current : current === 'tap' ? wait.current : burst.current
        return { phase: current, offset: video?.currentTime ?? 0,
          presented: current === 'intro' ? introPresented.current : current === 'open' ? openPresented.current : true }
      },
      status => {
        setAudioChecking(status === 'checking')
        if (status !== 'checking') setAudioBlocked(status === 'blocked')
      },
    )
    introPresented.current = false
    openPresented.current = false
    setAudioBlocked(false)
    rewind(b)
    rewind(i)
    rewind(w)
    w.loop = true
    w.playbackRate = 1
    setTicket(false)
    setDrawn(null)
    drawGacha().then(s => { setDrawn(s); setGacha(s) }).catch(() => setDrawn('error'))
    setTop('intro')
    move('intro')
    void sound.current.unlock() // Resume is invoked synchronously in the user's gesture.
    void play(i).catch(close)
  }

  useEffect(() => {
    const i = intro.current
    const w = wait.current
    const b = burst.current
    if (!i || !w || !b) return
    const pendingReveals = reveals.current
    const presented = (v: HTMLVideoElement, reveal: () => void) => {
      const cancel = afterPresentedFrame(v, () => { pendingReveals.delete(cancel); reveal() })
      pendingReveals.add(cancel)
    }
    // 1部・2部の最後のコマを出したまま待ちを流し、動き出したら入れ替える
    const introPlaying = () => {
      if (phaseRef.current !== 'intro' || introPresented.current) return
      presented(i, () => { if (phaseRef.current === 'intro') { introPresented.current = true; sound.current?.sync() } })
    }
    const introEnded = () => { if (phaseRef.current === 'intro') { move('tap'); void play(w).catch(close) } }
    const waitPlaying = () => { if (phaseRef.current === 'tap') presented(w, () => {
      if (phaseRef.current === 'tap') { setTop('wait'); sound.current?.sync() }
    }) }
    const burstPlaying = () => {
      if (phaseRef.current !== 'open' || openPresented.current) return
      presented(b, () => {
        if (phaseRef.current !== 'open') return
        openPresented.current = true
        sound.current?.sync()
        setTop('burst')
        waitStop.current = setTimeout(() => w.pause(), 600) // Only the visual fade; audio has its own scheduled crossfade.
      })
    }
    const waitEnded = () => { if (phaseRef.current === 'open') void play(b).catch(close) } // 早送りで終わりまで来たら開放へ
    const burstEnded = () => { if (phaseRef.current === 'open') { resultCuePending.current = true; move('result') } }
    const burstTime = () => { if (phaseRef.current !== 'idle' && THEME.ticketAt != null && b.currentTime >= THEME.ticketAt) setTicket(true) }
    const hide = () => { if (document.hidden) close() }
    i.addEventListener('playing', introPlaying)
    i.addEventListener('ended', introEnded)
    w.addEventListener('playing', waitPlaying)
    w.addEventListener('ended', waitEnded)
    b.addEventListener('playing', burstPlaying)
    b.addEventListener('ended', burstEnded)
    b.addEventListener('timeupdate', burstTime)
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', close)
    return () => {
      i.removeEventListener('playing', introPlaying)
      i.removeEventListener('ended', introEnded)
      w.removeEventListener('playing', waitPlaying)
      w.removeEventListener('ended', waitEnded)
      b.removeEventListener('playing', burstPlaying)
      b.removeEventListener('ended', burstEnded)
      b.removeEventListener('timeupdate', burstTime)
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', close)
      if (waitStop.current) clearTimeout(waitStop.current)
      pendingReveals.forEach(cancel => cancel())
      pendingReveals.clear()
      sound.current?.dispose()
      sound.current = null
      for (const v of [i, w, b]) v.pause()
    }
  }, [close, move, THEME])

  // 開放の動画は待ちの最後のコマから始まる。待ちの途中から切り替えると球の中の模様や光の輪が違い、別の球に見える（11/1 慶一郎さん「宝珠別物やね?」）。
  // タップしたら待ちを早送り（最大4倍・だいたい0.6秒）で終わりまで進め、最後のコマから開放へそのままつなぐ。音は開放が動き出したところで交差させる
  const open = () => {
    const w = wait.current
    const b = burst.current
    if (phaseRef.current !== 'tap' || !w || !b) return
    move('open')
    void sound.current?.unlock()
    // This edit opens from the same stone, with a short lit transition. Keep
    // the live loop at normal speed underneath the reveal, even on an early tap.
    if (THEME.id === 'dino') { void play(b).catch(close); return }
    const left = w.duration - w.currentTime
    if (!Number.isFinite(left) || left < 0.1) { w.pause(); void play(b).catch(close); return }
    w.loop = false
    w.playbackRate = Math.min(4, Math.max(1, left / 0.6))
  }

  const showing = phase !== 'idle'
  return (
    <div className="v2-page">
      <section className="v2-gacha-card">
        <img src="/gacha/gacha-top.jpg" alt="ガチャマシンと銀ちゃん" className="v2-gacha-poster" />
        <div className="v2-gacha-body">
          <button type="button" className="v2-gacha-start" data-guide="gacha-start" onClick={pending ? resume : start} disabled={!src && !loadFailed}>{loadFailed ? '読み込み直す' : src ? <><Sparkles size={20} />{pending ? (gacha?.held?.reserved ? '当選した券を見る' : '当選した券を選ぶ') : gacha?.today?.choice && !gacha.repeat ? '本日の結果をもう一度見る' : '本日のガチャを回す'}</> : `準備しています ${pct}%`}</button>
          {pending && <p className="v2-gacha-again">{gacha?.held?.reserved ? '新しい券は、ご来店のあとに受け取れます' : '当選した券がまだ選ばれていません'}</p>}
          {gacha?.today?.choice && !gacha.repeat && <p className="v2-gacha-again">次のガチャは明日 0:00 から回せます</p>}
          {onChoose && (
            <div className="v2-gacha-themes" role="group" aria-label="演出を選ぶ（Staging）">
              <span>Staging：演出を選ぶ</span>
              {LIVE.map(t => <button key={t.id} type="button" aria-pressed={t.id === THEME.id} onClick={() => onChoose(t.id)}>{t.short}</button>)}
            </div>
          )}
        </div>
      </section>
      <button type="button" className="v2-gacha-lineup-btn" onClick={() => setLineup(true)}>今月のラインナップ</button>
      {lineup && <GachaShowcase onClose={() => setLineup(false)} />}
      {(gacha?.held || (gacha?.gauge?.open && gacha.gauge.month)) && (
        <section className="v2-gacha-held" aria-label="お持ちのガチャ券">
          {gacha.held && (
            <>
              <span>お持ちのガチャ券</span>
              <b>{gacha.held.title}</b>
              <small>{gachaDays(gacha.held)}・{gachaUntil(gacha.held.expires_at)}・{gacha.held.reserved ? `${gachaReservedLabel(gacha.held.reserved.starts_at)}で使います` : 'AI予約でご利用いただけます'}</small>
            </>
          )}
          <GaugeMonth state={gacha} />
        </section>
      )}
      {gacha && <GachaGauge state={gacha} onChange={setGacha} />}
      <p className="v2-gacha-note">音が出ます。音量にご注意ください。<br />ガチャは1日1回、ガチャ券は1枚までお持ちいただけます。</p>

      <div className={`v2-gacha-stage v2-gacha-${THEME.id}${showing ? ' is-on' : ''}`} aria-hidden={!showing} onClick={open}>
        <video ref={wait} src={src?.[WAIT]} poster={POSTER} loop muted playsInline preload="auto" />
        <video ref={intro} src={src?.[INTRO]} poster={INTRO_POSTER} className={top === 'intro' ? '' : 'is-off'} muted playsInline preload="auto" />
        <video ref={burst} src={src?.[OPEN]} className={`v2-gacha-burst${top === 'burst' ? ' is-on' : ''}`} muted playsInline preload="auto" />
        {ticket && (
          <div className="v2-ticket-scene" aria-hidden>
            <img src={POSTER} alt="" className="v2-ticket-sky" />
            <div className="v2-ticket-fly">
              <div className="v2-ticket-face">
                {/* 柄は割引券と同じ大理石（銀河は黒×金・11/1 慶一郎さん） */}
                <div className="v2-ticket" style={THEME.ticket ? { backgroundImage: `url(${THEME.ticket})` } : undefined}>
                  <div className="v2-ticket-main"><b>{THEME.name}</b><span>銀二郎</span></div>
                  <div className="v2-ticket-stub"><span>No.</span><b>{String(new Date().getDate()).padStart(2, '0')}</b></div>
                </div>
              </div>
              {/* 回るあいだに見える裏側（表の文字が左右反対に透けないように） */}
              <div className="v2-ticket-face is-back"><div className="v2-ticket v2-ticket-back" style={THEME.ticket ? { backgroundImage: `url(${THEME.ticket})` } : undefined}><b>銀二郎</b></div></div>
            </div>
            {Array.from({ length: 14 }, (_, k) => <i key={k} className="v2-ticket-spark" style={{ ['--k' as string]: k }} />)}
          </div>
        )}
        {phase === 'tap' && <p className="v2-gacha-tap"><Pointer size={30} strokeWidth={1.6} aria-hidden />{THEME.tap ?? '光る球をタップ'}</p>}
        {showing && audioBlocked && (
          <button type="button" className="v2-gacha-audio" disabled={audioChecking}
            onClick={e => { e.stopPropagation(); void sound.current?.unlock() }}>
            <Volume2 size={20} aria-hidden />{audioChecking ? '音を確認中…' : '音を出す'}
          </button>
        )}
        {phase === 'result' && (
          // 結果のポップ（11/3 慶一郎さんの見本：黒×金のパネル）。上の銀ちゃんと金のチケットは動画のまま
          <div className={`v2-gacha-result${ticket ? ' is-ticket' : ''}`} onClick={e => e.stopPropagation()}>
            <GachaResult drawn={drawn} keeping={keeping} onChoose={choose} onClose={close} />
          </div>
        )}
        {showing && <button type="button" className="v2-gacha-close" aria-label="閉じる" onClick={e => { e.stopPropagation(); close() }}><X size={22} /></button>}
      </div>
    </div>
  )
}

const RANK: Record<GachaPrize['rank'], string | null> = { normal: null, rare: '当たり', legend: '大当たり' }

/** 月桂樹の枝（左向き。右は CSS で反転） */
function Laurel({ flip }: { flip?: boolean }) {
  return (
    <svg viewBox="0 0 24 40" className={`v2-laurel${flip ? ' is-flip' : ''}`} aria-hidden>
      <path d="M17 38C8 32 6 20 10 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      {[[9.5, 8, -40], [8.3, 14, -30], [7.8, 20, -20], [8.5, 26, -5], [10.5, 31.5, 15]].map(([x, y, r], k) => (
        <g key={k}>
          <ellipse cx={x - 3.2} cy={y} rx="3.6" ry="1.5" transform={`rotate(${r} ${x} ${y})`} fill="currentColor" />
          <ellipse cx={x + 3} cy={y - 1.5} rx="3.2" ry="1.3" transform={`rotate(${(r as number) - 60} ${x} ${y})`} fill="currentColor" />
        </g>
      ))}
    </svg>
  )
}

function Head({ prize }: { prize: GachaPrize }) {
  const rank = RANK[prize.rank]
  return (
    <>
      {rank && <em className="v2-gacha-rank"><Laurel />{rank}<Laurel flip /></em>}
      <b className="v2-gacha-prize">{prize.title}</b>
      <i className="v2-gacha-rule" aria-hidden />
    </>
  )
}

/** 結果：出た券。券を持っていたら、どちらを残すか選んでもらう */
function GachaResult({ drawn, keeping, onChoose, onClose }: { drawn: GachaState | 'error' | null; keeping: boolean; onChoose: (c: 'new' | 'old') => void; onClose: () => void }) {
  // どちらを残すか：カードをタップで選ぶ（金の枠）→「決定する」。押し間違いで高い券を手放さないよう2段にする（11/3）
  const [pick, setPick] = useState<'new' | 'old' | null>(null)
  const [decline, setDecline] = useState(false) // 「新しい券は受け取らない」は2回押しで
  if (drawn === 'error') {
    return <><b>結果を受け取れませんでした</b><span>電波の良いところで、もう一度お試しください。本日の結果は変わりません。</span><button type="button" className="v2-gold-btn" onClick={onClose}>閉じる</button></>
  }
  if (!drawn) return <span>結果を受け取っています…</span>
  // 返事は届いたが当選が入っていない（ふつうは起きない）：止まらずに、持っている券を見せて閉じられるようにする（11/4）
  if (!drawn.today) {
    return (
      <>
        {drawn.held ? <span>お持ちのガチャ券：{drawn.held.title}<br />{gachaDays(drawn.held)}・{gachaUntil(drawn.held.expires_at)}</span> : <span>保存しました。</span>}
        <button type="button" className="v2-gold-btn" onClick={onClose}>閉じる<ChevronRight size={20} strokeWidth={1.8} aria-hidden /></button>
      </>
    )
  }
  const { prize, choice } = drawn.today
  const held = drawn.held
  // 今の券が予約に付いている：交換はできない（銀Pay の仮支払いとずれるため）。来店して使ったあとに新しい券を受け取れる（11/4）
  if (choice === null && held?.reserved) {
    return (
      <>
        <Head prize={prize} />
        <span>現在お持ちのガチャ券（{held.title}）は、<br />{gachaReservedLabel(held.reserved.starts_at)}で使います。<br />新しい券は、ご来店のあとに受け取れます。</span>
        <button type="button" className="v2-gold-btn" onClick={onClose}>閉じる<ChevronRight size={20} strokeWidth={1.8} aria-hidden /></button>
        <button type="button" className="v2-gacha-decline" disabled={keeping} onClick={() => (decline ? onChoose('old') : setDecline(true))}>
          {keeping ? '保存しています…' : decline ? 'もう一度押すと、新しい券は受け取りません' : '新しい券は受け取らない'}
        </button>
      </>
    )
  }
  if (choice === null && held) {
    return (
      <>
        <Head prize={prize} />
        <span>ガチャ券は1枚だけお持ちいただけます。<br />どちらを残しますか？</span>
        <div className="v2-gacha-pick">
          <button type="button" aria-pressed={pick === 'new'} disabled={keeping} onClick={() => setPick('new')}>
            <small className="v2-pick-label"><Sparkles size={14} aria-hidden />新しいガチャ券</small>
            <strong>{prize.title}</strong>
            <small>{gachaDays(prize)}<br />30日間有効</small>
            <em>この券に交換</em>
          </button>
          <button type="button" aria-pressed={pick === 'old'} disabled={keeping} onClick={() => setPick('old')}>
            <small className="v2-pick-label">現在お持ちのガチャ券</small>
            <strong>{held.title}</strong>
            <small>{gachaDays(held)}<br />{gachaUntil(held.expires_at)}</small>
            <em>この券を残す</em>
          </button>
        </div>
        <button type="button" className="v2-gold-btn" disabled={!pick || keeping} onClick={() => pick && onChoose(pick)}>{keeping ? '保存しています…' : '決定する'}</button>
        <small className="v2-gacha-fine">どちらもAI予約でご利用いただけます。<br />閉じても、あとから選べます。</small>
      </>
    )
  }
  return (
    <>
      <Head prize={prize} />
      {choice === 'old' && held
        ? <span>現在お持ちのガチャ券（{held.title}）を残しました。</span>
        : held && <span>ガチャ券をお渡ししました。<br />{gachaDays(held)}・{gachaUntil(held.expires_at)}<br />AI予約でご利用いただけます。</span>}
      <button type="button" className="v2-gold-btn" onClick={onClose}>閉じる<ChevronRight size={20} strokeWidth={1.8} aria-hidden /></button>
    </>
  )
}
