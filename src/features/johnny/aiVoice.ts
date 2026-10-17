// JOHNNY の声（AI の音声）。サーバー（johnny-agent の speak）が作った音声を、届いた分から順に鳴らす。
// 音声は PCM（16bit・24kHz・モノラル）。全部そろうのを待たないので、話し始めが早い（約 0.5 秒）。
// 使えない（未ログイン・通信できない・音を鳴らせない）ときは 'failed' → 呼び出し側が端末の読み上げに切り替える。
import { getCustomerSession } from '../../utils/customerSession'

const URL_BASE = import.meta.env.VITE_SUPABASE_URL as string | undefined
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const RATE = 24000
/** これだけたまったら鳴らす（細かく鳴らすとプツプツ切れる） */
const MIN_SAMPLES = RATE / 5

export type AiVoiceResult = 'done' | 'failed' | 'aborted'

export async function playAiVoice(text: string, ctx: AudioContext, signal: AbortSignal): Promise<AiVoiceResult> {
  const session = getCustomerSession()
  if (!URL_BASE || !ANON || !session || ctx.state !== 'running') return 'failed'
  const sources: AudioBufferSourceNode[] = []
  const stopAll = () => sources.forEach(s => { try { s.stop() } catch { /* ignore */ } })
  signal.addEventListener('abort', stopAll)
  let started = false
  try {
    const res = await fetch(`${URL_BASE}/functions/v1/johnny-agent`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, speak: text }),
      signal,
    })
    if (!res.ok || !res.body) return 'failed'
    const reader = res.body.getReader()
    let pending: number[] = []
    let odd: number | null = null
    let at = 0
    const flush = () => {
      if (pending.length === 0) return
      const buf = ctx.createBuffer(1, pending.length, RATE)
      buf.getChannelData(0).set(pending)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      at = Math.max(at, ctx.currentTime + 0.05)
      src.start(at)
      at += buf.duration
      sources.push(src)
      started = true
      pending = []
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal.aborted) return 'aborted'
      let bytes = value
      if (odd !== null) { const b = new Uint8Array(bytes.length + 1); b[0] = odd; b.set(bytes, 1); bytes = b; odd = null }
      if (bytes.length % 2) { odd = bytes[bytes.length - 1]; bytes = bytes.subarray(0, bytes.length - 1) }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let i = 0; i < bytes.length; i += 2) pending.push(view.getInt16(i, true) / 32768)
      if (pending.length >= MIN_SAMPLES) flush()
    }
    flush()
    if (!started) return 'failed'
    // 鳴り終わるまで待つ
    await new Promise<void>(resolve => {
      const left = Math.max(0, at - ctx.currentTime)
      const t = window.setTimeout(resolve, left * 1000 + 80)
      signal.addEventListener('abort', () => { window.clearTimeout(t); resolve() })
    })
    return signal.aborted ? 'aborted' : 'done'
  } catch {
    if (signal.aborted) return 'aborted'
    stopAll()
    return started ? 'done' : 'failed'
  } finally {
    signal.removeEventListener('abort', stopAll)
  }
}
