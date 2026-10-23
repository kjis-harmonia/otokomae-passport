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
