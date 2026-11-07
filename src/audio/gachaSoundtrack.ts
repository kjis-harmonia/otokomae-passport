// Video elements stay muted. One decoded audio clock owns the soundtrack, including the loop.
export const GACHA_AUDIO_FILES = {
  intro: '/gacha/gacha-intro-audio.m4a?v=deep2',
  wait: '/gacha/gacha-wait-audio.wav?v=deep2',
  open: '/gacha/gacha-open-audio.m4a?v=deep2',
  result: '/gacha/gacha-result-audio.m4a?v=deep3',
} as const
export type GachaAudioFiles = Record<'intro' | 'wait' | 'open', string> & { result?: string }
export type GachaAudioBuffers = Record<'intro' | 'wait' | 'open', AudioBuffer> & { result?: AudioBuffer }

let context: AudioContext | null = null
export function gachaAudioContext(): AudioContext {
  if (!context || context.state === 'closed') context = new AudioContext()
  return context
}

export async function loadGachaAudio(signal: AbortSignal, files: GachaAudioFiles = GACHA_AUDIO_FILES): Promise<GachaAudioBuffers> {
  const ctx = gachaAudioContext()
  const entries = await Promise.all(Object.entries(files).map(async ([key, url]) => {
    try {
      const res = await fetch(url, { signal })
      if (!res.ok) throw new Error(`gacha audio: ${res.status}`)
      const buffer = await ctx.decodeAudioData(await res.arrayBuffer())
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      return [key, buffer] as const
    } catch (error) {
      // 決定音（result）は無くても演出は続ける（読めないとガチャそのものが開けなくなるので・11/6 Claude レビュー）
      if (key === 'result' && !signal.aborted) return null
      throw error
    }
  }))
  return Object.fromEntries(entries.filter((e): e is readonly [string, AudioBuffer] => e !== null)) as GachaAudioBuffers
}

export const INTRO_CROSSFADE = 1.2
export const OPEN_CROSSFADE = 2
export const RESULT_CUE_MAX = 0.2
export const AUDIO_UNLOCK_TIMEOUT_MS = 2000
const RELEASE = 0.08

/** Use the supported iPhone media channel only while the gacha owns playback. */
export function requestGachaPlaybackSession(host: unknown = globalThis.navigator): () => void {
  try {
    const session = (host as { audioSession?: { type: string } } | undefined)?.audioSession
    if (!session) return () => {}
    const previous = session.type
    session.type = 'playback'
    return () => {
      try { if (session.type === 'playback') session.type = previous } catch { /* Optional platform API. */ }
    }
  } catch { return () => {} } // Unsupported/read-only AudioSession must not disable Web Audio.
}

interface Envelope { at: number; duration: number; values: Float32Array }
interface Voice { source: AudioBufferSourceNode; gain: GainNode; initial: number; envelope: Envelope | null }
const curve = (fadeIn: boolean) => Float32Array.from({ length: 129 }, (_, i) => {
  const a = i / 128 * Math.PI / 2
  return fadeIn ? Math.sin(a) : Math.cos(a)
})

export class GachaSoundtrack {
  private readonly ctx: BaseAudioContext
  private readonly buffers: GachaAudioBuffers
  private readonly master: GainNode
  private voices = new Set<Voice>()
  private waiting: Voice | null = null
  private readonly introFade: number
  private resultPlayed = false
  private restoreSession: (() => void) | null = null

  // introFade: a theme whose intro already runs into the first bar of the wait loop needs only a short overlap.
  constructor(ctx: BaseAudioContext, buffers: GachaAudioBuffers, introFade = INTRO_CROSSFADE) {
    this.ctx = ctx
    this.buffers = buffers
    this.introFade = introFade
    this.master = ctx.createGain()
    this.master.gain.value = 0.8 // Headroom for two equal-power voices and AAC reconstruction peaks.
    this.master.connect(ctx.destination)
  }

  // Invoke synchronously in the user's tap, before awaiting video.play().
  async unlock(): Promise<void> {
    this.restoreSession ??= requestGachaPlaybackSession()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        (this.ctx as AudioContext).resume(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('audio_resume_timeout')), AUDIO_UNLOCK_TIMEOUT_MS) }),
      ])
      if (this.ctx.state !== 'running') throw new Error('audio_not_running')
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  get state(): AudioContextState { return this.ctx.state }

  observeState(listener: () => void): () => void {
    this.ctx.addEventListener('statechange', listener)
    return () => this.ctx.removeEventListener('statechange', listener)
  }

  private voice(buffer: AudioBuffer, at: number, offset = 0, loop = false, initial = 1): Voice {
    const source = this.ctx.createBufferSource()
    const gain = this.ctx.createGain()
    source.buffer = buffer
    source.loop = loop
    source.connect(gain)
    gain.connect(this.master)
    gain.gain.setValueAtTime(initial, this.ctx.currentTime)
    const voice: Voice = { source, gain, initial, envelope: null }
    this.voices.add(voice)
    source.onended = () => { source.disconnect(); gain.disconnect(); this.voices.delete(voice) }
    source.start(at, Math.min(offset, Math.max(0, buffer.duration - 0.001)))
    return voice
  }

  private valueAt(voice: Voice, at: number): number {
    const e = voice.envelope
    if (!e || at < e.at) return voice.initial
    const index = Math.min(e.values.length - 1, (at - e.at) / e.duration * (e.values.length - 1))
    const i = Math.floor(index)
    return e.values[i] + ((e.values[i + 1] ?? e.values[i]) - e.values[i]) * (index - i)
  }

  private hold(voice: Voice, at: number): number {
    const value = this.valueAt(voice, at)
    voice.gain.gain.cancelScheduledValues(at)
    voice.gain.gain.linearRampToValueAtTime(value, at)
    return value
  }

  private fade(voice: Voice, values: Float32Array, at: number, duration: number): void {
    // Short linear segments approximate the power curve without cancelAndHoldAtTime,
    // which is unavailable in Firefox (including Android).
    voice.gain.gain.setValueAtTime(values[0], at)
    for (let i = 1; i < values.length; i++) voice.gain.gain.linearRampToValueAtTime(values[i], at + duration * i / (values.length - 1))
    voice.envelope = { at, duration, values }
  }

  startIntro(at = this.ctx.currentTime, offset = 0): void {
    this.stop(at)
    this.resultPlayed = false
    const remaining = Math.max(0.01, this.buffers.intro.duration - offset)
    const fade = Math.min(this.introFade, remaining)
    const join = at + remaining - fade
    const intro = this.voice(this.buffers.intro, at, offset)
    this.fade(intro, curve(false), join, fade)
    const wait = this.voice(this.buffers.wait, join, 0, true, 0)
    this.fade(wait, curve(true), join, fade)
    this.waiting = wait
  }

  startWait(at = this.ctx.currentTime, offset = 0): void {
    this.stop(at)
    const wait = this.voice(this.buffers.wait, at, offset % this.buffers.wait.duration, true, 0)
    this.fade(wait, curve(true), at, RELEASE)
    this.waiting = wait
  }

  open(at = this.ctx.currentTime, offset = 0): void {
    const fade = Math.min(OPEN_CROSSFADE, Math.max(0.01, this.buffers.open.duration - offset))
    const wait = this.waiting
    if (wait) {
      // A very quick tap can interrupt the last few milliseconds of the INTRO fade.
      const held = this.hold(wait, at)
      this.fade(wait, curve(false).map(value => value * held), at, fade)
      wait.source.stop(at + fade)
      this.waiting = null
    }
    const open = this.voice(this.buffers.open, at, offset, false, 0)
    this.fade(open, curve(true), at, fade)
  }

  // Only a rendered, successful result calls this. Re-renders cannot stack the cue.
  result(at = this.ctx.currentTime): boolean {
    if (this.resultPlayed || !this.buffers.result) return true
    if (this.ctx.state !== 'running') return false
    this.resultPlayed = true
    this.stop(at)
    const cue = this.voice(this.buffers.result, at)
    const duration = Math.min(this.buffers.result.duration, RESULT_CUE_MAX)
    const release = Math.min(.02, duration)
    this.fade(cue, new Float32Array([1, 0]), at + duration - release, release)
    cue.source.stop(at + duration)
    return true
  }

  stop(at = this.ctx.currentTime): void {
    for (const voice of this.voices) {
      // A suspended clock cannot finish a release. Cancel it now, so recovery
      // cannot briefly replay the old scene underneath the newly aligned sound.
      if (this.ctx.state !== 'running') {
        voice.gain.gain.cancelScheduledValues(at)
        voice.gain.gain.setValueAtTime(0, at)
        voice.source.stop(at)
        voice.source.onended = null
        voice.source.disconnect()
        voice.gain.disconnect()
        this.voices.delete(voice)
        continue
      }
      const held = this.hold(voice, at)
      this.fade(voice, new Float32Array([held, 0]), at, RELEASE)
      voice.source.stop(at + RELEASE)
    }
    this.waiting = null
  }

  dispose(): void {
    this.stop()
    this.restoreSession?.()
    this.restoreSession = null
    // Preserve the short release rather than disconnecting at a non-zero sample.
    setTimeout(() => this.master.disconnect(), (RELEASE + 0.02) * 1000)
  }
}
