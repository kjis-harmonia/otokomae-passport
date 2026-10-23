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

let speechReady = false
export function unlockChime(): void {
  const a = audio()
  if (a && a.state === 'suspended') void a.resume().catch(() => {})
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
  playChime()
  void voiceBuffer(v.file).then(buf => {
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
  if (a.state === 'suspended') void a.resume().then(go, () => {})
  else go()
}
