// 「ピコーン」：予約が入ったとき、開いている SB で鳴らす音。ファイルは使わず、その場で作る（澄んだ2音のベル）。
// iPad は一度画面に触れるまで音を出せないので、最初のタップで準備しておく（unlockChime）。
let ctx: AudioContext | null = null

function audio(): AudioContext | null {
  if (ctx) return ctx
  const AC = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  try { ctx = new AC() } catch { ctx = null }
  return ctx
}

// 音が出せない状態か（11/12：SB を開いたまま画面がついていても、予約の音が鳴らない時があった）。
//   iPad は、画面が消えてついた後・ほかの音が鳴った後・長く触っていない時に、音の仕組みが止まる（suspended / interrupted）。
//   止まっていたら鳴らす前に起こし直し、起きなければ画面に「一度タップしてください」を出す
let blocked = false
const listeners = new Set<(b: boolean) => void>()
function setBlocked(b: boolean) { if (blocked === b) return; blocked = b; listeners.forEach(f => f(b)) }
export function soundBlocked(): boolean { return blocked }
export function onSoundBlocked(f: (b: boolean) => void): () => void { listeners.add(f); return () => { listeners.delete(f) } }

/** 音の仕組みを起こす。止まっていたら resume。0.6 秒で起きなければ false */
async function ensureRunning(a: AudioContext): Promise<boolean> {
  if (a.state === 'running') { setBlocked(false); return true }
  const ok = await Promise.race([
    a.resume().then(() => (a.state as string) === 'running', () => false),
    new Promise<boolean>(r => window.setTimeout(() => r(false), 600)),
  ])
  setBlocked(!ok)
  return ok
}
/** 画面が見えている間、音が止まっていないか見回る（止まっていたら起こす・起きなければ知らせる） */
export function checkSound(): void {
  const a = audio()
  if (a && document.visibilityState === 'visible') void ensureRunning(a)
}

// 予備の鳴らし方：音のファイルを <audio> で鳴らす。最初のタップで一度鳴らしておく（iPad は触った時に鳴らした音しか、後で鳴らせない）
let fallback: HTMLAudioElement | null = null
function fallbackEl(): HTMLAudioElement | null {
  if (fallback) return fallback
  try { fallback = new Audio(); fallback.preload = 'auto' } catch { fallback = null }
  return fallback
}
async function playFallback(file: string): Promise<boolean> {
  const el = fallbackEl()
  if (!el) return false
  try { el.muted = false; el.volume = 1; el.src = file; el.currentTime = 0; await el.play(); return true } catch { return false }
}

let speechReady = false
let fallbackReady = false
export function unlockChime(): void {
  const a = audio()
  if (a && a.state !== 'running') void ensureRunning(a)
  else if (a) setBlocked(false)
  if (!fallbackReady) {
    const el = fallbackEl()
    if (el) { fallbackReady = true; el.muted = true; el.src = SB_VOICES.new.file; void el.play().then(() => { el.pause(); el.currentTime = 0 }, () => { fallbackReady = false }) }
  }
  // iPad は一度タップの中で話させないと、あとから声が出ない：最初のタップで無音の一言を話しておく
  if (!speechReady && 'speechSynthesis' in window) {
    speechReady = true
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u) } catch { /* 声が使えない端末 */ }
  }
}

// 声のファイル（public/sounds/sb-*.mp3）。置いてあればそれを鳴らし、無ければ端末の声で同じ文を読む
export const SB_VOICES = {
  new: { file: '/sounds/sb-new.mp3', text: '予約が入りました' },
  remind: { file: '/sounds/sb-remind.mp3', text: '予約が入ってます。スタッフの方は確認してください' },
  cancel: { file: '/sounds/sb-cancel.mp3', text: 'キャンセルが入りました。サロンボードから消してください' },
  final: { file: '/sounds/sb-final.mp3', text: 'テイテイさん、ギンジロウさん、従業員の皆様へ、ご予約の確認をお願いいたします' },
} as const
const buffers = new Map<string, AudioBuffer | null>()

async function voiceBuffer(file: string): Promise<AudioBuffer | null> {
  if (buffers.has(file)) return buffers.get(file) ?? null
  const a = audio()
  let buf: AudioBuffer | null = null
  try {
    const r = await fetch(file, { cache: 'force-cache' })
    if (r.ok && (r.headers.get('content-type') ?? '').startsWith('audio')) buf = await a!.decodeAudioData(await r.arrayBuffer())
  } catch { buf = null }
  buffers.set(file, buf)
  return buf
}

/** ピコーンのあとに声（ファイル、無ければ端末の声） */
export function announceVoice(kind: keyof typeof SB_VOICES): void {
  const v = SB_VOICES[kind]
  const a0 = audio()
  // 音の仕組みが止まっていて起きないときは、予備の鳴らし方で声のファイルを鳴らす（それも駄目なら画面で知らせる）
  void (a0 ? ensureRunning(a0) : Promise.resolve(false)).then(async running => {
    if (!running) { if (!(await playFallback(v.file))) setBlocked(true); return }
    playChime()
    const buf = await voiceBuffer(v.file)
    const a = audio()
    if (buf && a) {
      // 3つの声の大きさをそろえる：一番大きい所が 0.9 になるように持ち上げる（上げすぎない）
      const d = buf.getChannelData(0); let peak = 0
      for (let i = 0; i < d.length; i += 4) { const x = Math.abs(d[i]); if (x > peak) peak = x }
      const g = a.createGain(); g.gain.value = peak > 0 ? Math.min(0.9 / peak, 3) : 1
      const src = a.createBufferSource(); src.buffer = buf; src.connect(g).connect(a.destination); src.start(a.currentTime + 0.9)
    } else speak(v.text, 900)
  })
}

/** 端末の声（日本語）で読み上げる。ピコーンのあとに続けたいときは delayMs で少し待つ */
export function speak(text: string, delayMs = 0): void {
  if (!('speechSynthesis' in window)) return
  window.setTimeout(() => {
    try {
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'ja-JP'; u.rate = 1; u.pitch = 1; u.volume = 1
      const ja = window.speechSynthesis.getVoices().find(v => v.lang.startsWith('ja'))
      if (ja) u.voice = ja
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(u)
    } catch { /* 声が使えない端末 */ }
  }, delayMs)
}

/** ベルの1音：基音＋少し高い倍音を重ね、すっと立ち上がってゆっくり消える */
function bell(a: AudioContext, freq: number, at: number, length: number, gain: number) {
  for (const [ratio, level] of [[1, 1], [2.76, 0.22], [5.4, 0.06]] as const) {
    const o = a.createOscillator()
    const g = a.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(freq * ratio, at)
    g.gain.setValueAtTime(0, at)
    g.gain.linearRampToValueAtTime(gain * level, at + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, at + length / ratio ** 0.4)
    o.connect(g).connect(a.destination)
    o.start(at)
    o.stop(at + length + 0.05)
  }
}

export function playChime(): void {
  const a = audio()
  if (!a) return
  const go = () => {
    const t = a.currentTime + 0.02
    bell(a, 1318.5, t, 0.5, 0.22)        // ピ（E6）
    bell(a, 1975.5, t + 0.13, 1.6, 0.26) // コーン（B6）
  }
  if (a.state === 'running') go()
  else void ensureRunning(a).then(ok => { if (ok) go() })
}
