// 本部 JOHNNY の声：録音（話し終わったら自動で止める）と、JOHNNY の声（hq-johnny の speak）の再生。
// どちらも音の大きさを level() で読めるようにして、舞台の波形を声に合わせる。
import { getHqToken } from './hqSession'

const URL_BASE = import.meta.env.VITE_SUPABASE_URL as string | undefined
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const RATE = 24000
const MIN_SAMPLES = RATE / 5

let audioCtx: AudioContext | null = null
let analyser: AnalyserNode | null = null
const buf = new Uint8Array(1024)

/** 押したとき（ユーザーの操作の中）に呼ぶ。iPhone は操作の中でないと音が鳴らない */
export function unlockAudio(): AudioContext | null {
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      audioCtx = new Ctx()
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 1024
      analyser.connect(audioCtx.destination)
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    return audioCtx
  } catch { return null }
}

/** いまの音の大きさ（0〜1）。録音中はマイク、話している間は JOHNNY の声 */
let micAnalyser: AnalyserNode | null = null
export function voiceLevel(): number {
  const a = micAnalyser ?? analyser
  if (!a) return 0
  a.getByteTimeDomainData(buf)
  let sum = 0
  for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
  return Math.min(1, Math.sqrt(sum / buf.length) * 4)
}

export interface Recording { b64: string; mime: string }

/** 録音する。話し終わって 1.1 秒静かになったら止める（最長 25 秒）。signal で中止 */
export async function recordUtterance(signal: AbortSignal): Promise<Recording | null> {
  const ctx = unlockAudio()
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(t => window.MediaRecorder?.isTypeSupported?.(t)) ?? ''
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  const chunks: Blob[] = []
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
  let src: MediaStreamAudioSourceNode | null = null
  if (ctx) {
    src = ctx.createMediaStreamSource(stream)
    micAnalyser = ctx.createAnalyser()
    micAnalyser.fftSize = 1024
    src.connect(micAnalyser)
  }
  const stopped = new Promise<void>(resolve => { rec.onstop = () => resolve() })
  rec.start(250)
  const started = performance.now()
  let spoke = false
  let quietSince = performance.now()
  await new Promise<void>(resolve => {
    const tick = window.setInterval(() => {
      const lv = voiceLevel()
      const now = performance.now()
      if (lv > 0.08) { spoke = true; quietSince = now }
      const done = signal.aborted || now - started > 25_000 || (spoke && now - quietSince > 1100) || (!spoke && now - started > 7000)
      if (done) { window.clearInterval(tick); resolve() }
    }, 80)
  })
  if (rec.state !== 'inactive') rec.stop()
  await stopped
  stream.getTracks().forEach(t => t.stop())
  src?.disconnect()
  micAnalyser = null
  if (signal.aborted || !spoke || !chunks.length) return null
  const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' })
  const b64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
  return { b64, mime: blob.type }
}

/** JOHNNY の声で話す（届いた分から鳴らす）。鳴らせなければ false */
export async function speak(text: string, signal: AbortSignal): Promise<boolean> {
  const ctx = unlockAudio()
  const hq = getHqToken()
  if (!URL_BASE || !ANON || !hq || !ctx || !analyser) return false
  const out = analyser
  const sources: AudioBufferSourceNode[] = []
  const stopAll = () => sources.forEach(s => { try { s.stop() } catch { /* ignore */ } })
  signal.addEventListener('abort', stopAll)
  try {
    const res = await fetch(`${URL_BASE}/functions/v1/hq-johnny`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
      // 「BOS」は「ボス」と読ませる
      body: JSON.stringify({ hq, speak: text.replace(/BOSS?/gi, 'ボス') }),
      signal,
    })
    if (!res.ok || !res.body) return false
    const reader = res.body.getReader()
    let pending: number[] = []
    let odd: number | null = null
    let at = 0
    let started = false
    const flush = () => {
      if (!pending.length) return
      const b = ctx.createBuffer(1, pending.length, RATE)
      b.getChannelData(0).set(pending)
      const s = ctx.createBufferSource()
      s.buffer = b
      s.connect(out)
      at = Math.max(at, ctx.currentTime + 0.05)
      s.start(at)
      at += b.duration
      sources.push(s)
      started = true
      pending = []
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal.aborted) return true
      let bytes = value
      if (odd !== null) { const x = new Uint8Array(bytes.length + 1); x[0] = odd; x.set(bytes, 1); bytes = x; odd = null }
      if (bytes.length % 2) { odd = bytes[bytes.length - 1]; bytes = bytes.subarray(0, bytes.length - 1) }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let i = 0; i < bytes.length; i += 2) pending.push(view.getInt16(i, true) / 32768)
      if (pending.length >= MIN_SAMPLES) flush()
    }
    flush()
    if (!started) return false
    await new Promise<void>(resolve => {
      const tm = window.setTimeout(resolve, Math.max(0, at - ctx.currentTime) * 1000 + 80)
      signal.addEventListener('abort', () => { window.clearTimeout(tm); resolve() })
    })
    return true
  } catch {
    stopAll()
    return false
  } finally {
    signal.removeEventListener('abort', stopAll)
  }
}
