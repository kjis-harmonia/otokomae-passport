// 本日のガチャ（10/29 慶一郎さん、10/30 動画を3部構成に）：下タブ「ガチャ」→「本日のガチャを回す」で演出の動画を画面いっぱいに流す。
// 1部〜3部（INTRO、深海の秘宝：海に沈む神殿→光る球）→ タップ待ち（WAIT、くり返し）→ お客様が球をタップ → 3部 開放 → 真っ白 → 4部 銀ちゃん（OPEN、1本につないである）→ 結果。
// 景品（11/3）：回し始めたらサーバーで抽選（1日1回・同じ日は同じ結果）。演出のあいだに結果が届き、最後にガチャ券を見せる。券を持っていれば、どちらを残すか選んでもらう。
// 動画は public/gacha（Gemini で作ったもの・縦 9:16）。INTRO の終わりは WAIT の始まりと同じコマ、WAIT は終わりと始まりを 0.5 秒重ねてくり返し。OPEN は開放→真っ白（0.75 秒で白へ）→スキューバの銀ちゃんが黄金チケットを掲げる（白から 0.5 秒で溶かす・10/30）。
// 3本は別の video を重ねる。次の動画が実際に動き出してから前の動画を隠す（切り替えで黒や下絵が挟まらない）。開放はタップのあと待ちを早送りで終わりまで進め、待ちの最後のコマ＝開放の最初のコマでつなぐ（11/1）。
// iPhone は preload を守らず流しながら読むので、電波しだいでカクカクする（10/30「球体もカクカク」）。タブを開いたら3本とも先に全部読み、読み終わってからボタンを押せる。
// 音は独立したWeb Audioのクロックでつなぐ。videoは常にミュートし、待機のループでAACの再始動やended待ちの無音を挟まない。
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, Pointer, Sparkles, X } from 'lucide-react'
import { canUseGacha, drawGacha, gachaDays, gachaUntil, keepGacha, loadGacha, type GachaPrize, type GachaState } from '../features/gacha/gachaApi'
import { GACHA_AUDIO_FILES, GachaSoundtrack, gachaAudioContext, loadGachaAudio, type GachaAudioBuffers, type GachaAudioFiles } from '../audio/gachaSoundtrack'

// 演出はテーマを開くたびにランダム（11/1）。読むのは選ばれたテーマの3本と音だけ（スマホで全テーマを読むと重い）。
// 深海の秘宝は最後に銀ちゃん（動画）、銀河の秘宝は真っ白の中から黄金チケットがこちらへ飛んでくる（アプリで描く・11/1 慶一郎さん「銀ちゃんは難しい！」）
type Theme = { id: 'deep' | 'galaxy' | 'dino'; name: string; tap?: string; intro: string; introPoster: string; wait: string; open: string; poster: string; audio: GachaAudioFiles; introFade?: number; ticketAt?: number; ticket?: string; hold?: boolean }
const THEMES: Theme[] = [
  { id: 'deep', name: '深海の秘宝', intro: '/gacha/gacha-intro.mp4', introPoster: '/gacha/gacha-intro.jpg', wait: '/gacha/gacha-wait.mp4', open: '/gacha/gacha-open.mp4', poster: '/gacha/gacha-wait.jpg', audio: GACHA_AUDIO_FILES },
  // 銀河の音は1部の終わりがそのまま待ちの頭へ続く曲なので、重ねるのは短く。開放は 7.9 秒で真っ白になりきる。そこからチケットを飛ばす
  { id: 'galaxy', name: '銀河の秘宝', intro: '/gacha/galaxy/intro.mp4', introPoster: '/gacha/galaxy/intro.jpg', wait: '/gacha/galaxy/wait.mp4', open: '/gacha/galaxy/open.mp4', poster: '/gacha/galaxy/wait.jpg',
    audio: { intro: '/gacha/galaxy/intro-audio.m4a', wait: '/gacha/galaxy/wait-audio.wav', open: '/gacha/galaxy/open-audio.m4a' }, introFade: 0.15, ticketAt: 7.9, ticket: '/gacha/galaxy/ticket.jpg', hold: true }, // 保留中（11/1「宇宙編微妙やな」）。ランダムには出さない
  // 恐竜編：レックスの咆哮→大草原→洞窟→光る足跡。開放は足跡から光の柱→真っ白→鳳凰編の走る銀ちゃん（1本につないである・11/2）
  { id: 'dino', name: '太古の覇王', tap: '光る足跡をタップ', intro: '/gacha/dino/intro.mp4', introPoster: '/gacha/dino/intro.jpg', wait: '/gacha/dino/wait.mp4', open: '/gacha/dino/open.mp4', poster: '/gacha/dino/wait.jpg',
    audio: { intro: '/gacha/dino/intro-audio.m4a', wait: '/gacha/dino/wait-audio.wav', open: '/gacha/dino/open-audio.m4a' } },
]
// ?gacha=galaxy で決めうち（見比べる用・保留中のテーマも出せる）
const pick = new URLSearchParams(location.search).get('gacha')
const LIVE = THEMES.filter(t => !t.hold)
const THEME = THEMES.find(t => t.id === pick) ?? LIVE[Math.floor(Math.random() * LIVE.length)]
const { intro: INTRO, introPoster: INTRO_POSTER, wait: WAIT, open: OPEN, poster: POSTER } = THEME

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
  })), loadGachaAudio(signal, THEME.audio)])
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
  const [ticket, setTicket] = useState(false) // 銀河：黄金チケットが飛んできた
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
  const [gacha, setGacha] = useState<GachaState | null>(null) // 今日の結果と持ち券
  const [drawn, setDrawn] = useState<GachaState | 'error' | null>(null) // 今回回した結果（演出のあいだに届く）
  const [keeping, setKeeping] = useState(false)

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
    loadAll(setPct, ac.signal).then(ready => { if (!ac.signal.aborted) setSrc(ready.urls) }).catch(() => { if (!ac.signal.aborted) setLoadFailed(true) })
    return () => ac.abort()
  }, [src, attempt])

  const close = useCallback(() => {
    if (waitStop.current) clearTimeout(waitStop.current)
    waitStop.current = null
    setTicket(false)
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
    sound.current ??= new GachaSoundtrack(gachaAudioContext(), cache.audio, THEME.introFade)
    sound.current.unlock() // Keep the iPhone audio unlock inside the user's gesture.
    introSoundStarted.current = false
    openSoundStarted.current = false
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
    const waitEnded = () => { if (phaseRef.current === 'open') void play(b).catch(close) } // 早送りで終わりまで来たら開放へ
    const burstEnded = () => { if (phaseRef.current === 'open') move('result') }
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
      sound.current?.dispose()
      sound.current = null
      for (const v of [i, w, b]) v.pause()
    }
  }, [close, move])

  // 開放の動画は待ちの最後のコマから始まる。待ちの途中から切り替えると球の中の模様や光の輪が違い、別の球に見える（11/1 慶一郎さん「宝珠別物やね?」）。
  // タップしたら待ちを早送り（最大4倍・だいたい0.6秒）で終わりまで進め、最後のコマから開放へそのままつなぐ。音は開放が動き出したところで交差させる
  const open = () => {
    const w = wait.current
    const b = burst.current
    if (phaseRef.current !== 'tap' || !w || !b) return
    move('open')
    sound.current?.unlock()
    const left = w.duration - w.currentTime
    if (!Number.isFinite(left) || left < 0.1) { w.pause(); void play(b).catch(close); return }
    w.loop = false
    w.playbackRate = Math.min(4, Math.max(1, left / 0.6))
  }

  const showing = phase !== 'idle'
  return (
    <div className="v2-page">
      <h1 className="v2-title">本日のガチャ</h1>
      <section className="v2-gacha-card">
        <img src="/gacha/gacha-top.jpg" alt="ガチャマシンと銀ちゃん" className="v2-gacha-poster" />
        <div className="v2-gacha-body">
          <button type="button" className="v2-gacha-start" onClick={start} disabled={!src && !loadFailed}>{loadFailed ? '読み込み直す' : src ? <><Sparkles size={20} />{gacha?.today?.choice ? '本日の結果をもう一度見る' : '本日のガチャを回す'}</> : `準備しています ${pct}%`}</button>
          {gacha?.today?.choice && <p className="v2-gacha-again">次のガチャは明日 0:00 から回せます</p>}
        </div>
      </section>
      {gacha?.held && (
        <section className="v2-gacha-held" aria-label="お持ちのガチャ券">
          <span>お持ちのガチャ券</span>
          <b>{gacha.held.title}</b>
          <small>{gachaDays(gacha.held)}・{gachaUntil(gacha.held.expires_at)}<br />アプリのご予約でお使いいただけます</small>
        </section>
      )}
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
  if (drawn === 'error') {
    return <><b>結果を受け取れませんでした</b><span>電波の良いところで、もう一度お試しください。本日の結果は変わりません。</span><button type="button" className="v2-gold-btn" onClick={onClose}>閉じる</button></>
  }
  if (!drawn?.today) return <span>結果を受け取っています…</span>
  const { prize, choice } = drawn.today
  const held = drawn.held
  if (choice === null && held) {
    return (
      <>
        <Head prize={prize} />
        <span>ガチャ券は1枚だけお持ちいただけます。<br />どちらを残しますか？</span>
        <div className="v2-gacha-pick">
          <button type="button" disabled={keeping} onClick={() => onChoose('new')}><small>新しい券</small><strong>{prize.title}</strong><small>{gachaDays(prize)}・30日間</small></button>
          <button type="button" disabled={keeping} onClick={() => onChoose('old')}><small>今の券</small><strong>{held.title}</strong><small>{gachaDays(held)}・{gachaUntil(held.expires_at)}</small></button>
        </div>
      </>
    )
  }
  return (
    <>
      <Head prize={prize} />
      {choice === 'old' && held
        ? <span>今の券（{held.title}）を残しました。</span>
        : held && <span>ガチャ券をお渡ししました。<br />{gachaDays(held)}・{gachaUntil(held.expires_at)}<br />アプリのご予約でお使いいただけます。</span>}
      <button type="button" className="v2-gold-btn" onClick={onClose}>閉じる<ChevronRight size={20} strokeWidth={1.8} aria-hidden /></button>
    </>
  )
}
