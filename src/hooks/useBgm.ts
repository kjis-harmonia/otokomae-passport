import { useState, useRef, useEffect } from 'react'

const BGM_KEY = 'ginjiro_bgm_on'
const BGM_TRACK_KEY = 'ginjiro_bgm_track'
const BGM_AUDIO_REGISTRY_KEY = '__ginjiroBgmAudioRegistry'

export interface BgmTrack {
  id: string
  title: string
  subtitle: string
  src: string
}

export const BGM_TRACKS: BgmTrack[] = [
  {
    id: 'theme',
    title: '銀二郎 Theme',
    subtitle: '店内を包むメインBGM',
    src: '/assets/audio/ginjiro-theme.mp4',
  },
  {
    id: 'hiroshima',
    title: '広島',
    subtitle: '広島の熱を乗せた一曲',
    src: '/assets/audio/hiroshima.mov',
  },
]

type GinjiroWindow = Window & {
  [BGM_AUDIO_REGISTRY_KEY]?: Set<HTMLAudioElement>
}

const fallbackAudioRegistry = new Set<HTMLAudioElement>()

function getAudioRegistry(): Set<HTMLAudioElement> {
  if (typeof window === 'undefined') return fallbackAudioRegistry

  const ginjiroWindow = window as GinjiroWindow
  if (!ginjiroWindow[BGM_AUDIO_REGISTRY_KEY]) {
    ginjiroWindow[BGM_AUDIO_REGISTRY_KEY] = new Set<HTMLAudioElement>()
  }
  return ginjiroWindow[BGM_AUDIO_REGISTRY_KEY]!
}

function silenceAudio(audio: HTMLAudioElement): void {
  audio.pause()
  try {
    audio.currentTime = 0
  } catch {
    // Some browsers reject currentTime changes while metadata is unavailable.
  }
}

export function registerBgmAudio(audio: HTMLAudioElement): HTMLAudioElement {
  getAudioRegistry().add(audio)
  return audio
}

export function stopAllBgmAudio(except?: HTMLAudioElement | null): void {
  const registry = getAudioRegistry()

  registry.forEach((audio) => {
    if (audio === except) return
    silenceAudio(audio)
    registry.delete(audio)
  })
}

function getInitialTrack(): BgmTrack {
  const savedId = localStorage.getItem(BGM_TRACK_KEY)
  return BGM_TRACKS.find((track) => track.id === savedId) ?? BGM_TRACKS[0]
}

export function useBgm() {
  const [isOn, setIsOn] = useState(() => localStorage.getItem(BGM_KEY) === 'true')
  const [currentTrack, setCurrentTrack] = useState<BgmTrack>(getInitialTrack)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  function createAudio(track: BgmTrack): HTMLAudioElement {
    const audio = registerBgmAudio(new Audio(track.src))
    audio.volume = 0.22
    audio.loop = true
    return audio
  }

  function getAudio(): HTMLAudioElement {
    if (!audioRef.current) {
      stopAllBgmAudio()
      audioRef.current = createAudio(currentTrack)
    }
    return audioRef.current
  }

  function toggle() {
    const audio = getAudio()
    const playing = !audio.paused

    if (isOn && playing) {
      stop()
    } else {
      playAudio(audio)
    }
  }

  function playAudio(audio: HTMLAudioElement) {
    setIsOn(true)
    localStorage.setItem(BGM_KEY, 'true')
    stopAllBgmAudio(audio)
    void audio.play().catch(() => {
      // Browser autoplay policy or missing audio file; keep UI non-fatal.
    })
  }

  function stop() {
    stopAllBgmAudio()
    audioRef.current = null
    setIsOn(false)
    localStorage.setItem(BGM_KEY, 'false')
  }

  function playTrack(trackId: string) {
    const nextTrack = BGM_TRACKS.find((track) => track.id === trackId)
    if (!nextTrack) return

    if (nextTrack.id !== currentTrack.id || !audioRef.current) {
      stopAllBgmAudio()
      audioRef.current = createAudio(nextTrack)
    }

    setCurrentTrack(nextTrack)
    localStorage.setItem(BGM_TRACK_KEY, nextTrack.id)
    playAudio(audioRef.current)
  }

  function selectTrack(trackId: string) {
    const nextTrack = BGM_TRACKS.find((track) => track.id === trackId)
    if (!nextTrack) return

    const wasPlaying = audioRef.current ? !audioRef.current.paused : false
    if (wasPlaying || isOn) {
      playTrack(trackId)
      return
    }

    stopAllBgmAudio()
    audioRef.current = null

    setCurrentTrack(nextTrack)
    localStorage.setItem(BGM_TRACK_KEY, nextTrack.id)
  }

  useEffect(() => {
    return () => {
      stopAllBgmAudio()
      audioRef.current = null
    }
  }, [])

  return { isOn, toggle, stop, tracks: BGM_TRACKS, currentTrack, selectTrack, playTrack }
}
