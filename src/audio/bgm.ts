// All app BGM, including onboarding, shares one suspension boundary.
const REGISTRY_KEY = '__ginjiroBgmAudioRegistry'
type BgmWindow = Window & { [REGISTRY_KEY]?: Set<HTMLAudioElement> }
const fallbackRegistry = new Set<HTMLAudioElement>()
const suspensions = new Set<symbol>()
const heldAudio = new Map<HTMLAudioElement, { muted: boolean; resume: boolean }>()
const guardedAudio = new WeakSet<HTMLAudioElement>()

function registry(): Set<HTMLAudioElement> {
  if (typeof window === 'undefined') return fallbackRegistry
  return ((window as BgmWindow)[REGISTRY_KEY] ??= new Set<HTMLAudioElement>())
}

export function isBgmSuspended(): boolean { return suspensions.size > 0 }

function hold(audio: HTMLAudioElement): void {
  if (!heldAudio.has(audio)) heldAudio.set(audio, { muted: audio.muted, resume: !audio.paused && !audio.ended })
  // Mute first: a previously requested play() can finish after pause().
  audio.muted = true
  audio.pause()
}

export function registerBgmAudio(audio: HTMLAudioElement): HTMLAudioElement {
  registry().add(audio)
  if (!guardedAudio.has(audio)) {
    guardedAudio.add(audio)
    const preventPlayback = () => { if (isBgmSuspended()) hold(audio) }
    audio.addEventListener('play', preventPlayback)
    audio.addEventListener('playing', preventPlayback)
  }
  if (isBgmSuspended()) hold(audio)
  return audio
}

export function stopAllBgmAudio(except?: HTMLAudioElement | null): void {
  const audioRegistry = registry()
  for (const audio of audioRegistry) {
    if (audio === except) continue
    audio.pause()
    try { audio.currentTime = 0 } catch { /* Metadata may not be available yet. */ }
    audioRegistry.delete(audio)
  }
}

/** Returns an idempotent release; overlapping owners must all close before resuming. */
export function suspendBgm(): () => void {
  const token = Symbol('bgm-suspension')
  suspensions.add(token)
  registry().forEach(hold)
  return () => {
    if (!suspensions.delete(token) || isBgmSuspended()) return
    const held = [...heldAudio]
    heldAudio.clear()
    for (const [audio, before] of held) {
      audio.muted = before.muted
      // Do not restart stopped/replaced tracks or BGM that was already off.
      if (before.resume && registry().has(audio)) void audio.play().catch(() => {})
    }
  }
}
