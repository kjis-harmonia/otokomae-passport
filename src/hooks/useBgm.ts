import { useState, useRef, useEffect } from 'react'

const BGM_KEY = 'ginjiro_bgm_on'
const BGM_TRACK_KEY = 'ginjiro_bgm_track'

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
    subtitle: '黒金のメインテーマ',
    src: '/assets/audio/ginjiro-theme.mp4',
  },
  {
    id: 'night',
    title: '夜の理髪室',
    subtitle: '静かに整える夜',
    src: '/assets/audio/ginjiro-night.mp4',
  },
  {
    id: 'mode',
    title: '漢前 Mode',
    subtitle: '気分を上げる一曲',
    src: '/assets/audio/ginjiro-mode.mp4',
  },
]

function getInitialTrack(): BgmTrack {
  const savedId = localStorage.getItem(BGM_TRACK_KEY)
  return BGM_TRACKS.find((track) => track.id === savedId) ?? BGM_TRACKS[0]
}

export function useBgm() {
  const [isOn, setIsOn] = useState(() => localStorage.getItem(BGM_KEY) === 'true')
  const [currentTrack, setCurrentTrack] = useState<BgmTrack>(getInitialTrack)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  function createAudio(track: BgmTrack): HTMLAudioElement {
    const audio = new Audio(track.src)
    audio.volume = 0.22
    audio.loop = true
    return audio
  }

  function getAudio(): HTMLAudioElement {
    if (!audioRef.current) {
      audioRef.current = createAudio(currentTrack)
    }
    return audioRef.current
  }

  function toggle() {
    const audio = getAudio()
    const playing = !audio.paused

    if (isOn && playing) {
      audio.pause()
      setIsOn(false)
      localStorage.setItem(BGM_KEY, 'false')
    } else {
      setIsOn(true)
      localStorage.setItem(BGM_KEY, 'true')
      void audio.play().catch(() => {
        // Browser autoplay policy or missing audio file; keep UI non-fatal.
      })
    }
  }

  function selectTrack(trackId: string) {
    const nextTrack = BGM_TRACKS.find((track) => track.id === trackId)
    if (!nextTrack) return

    const wasPlaying = audioRef.current ? !audioRef.current.paused : false
    audioRef.current?.pause()
    audioRef.current = createAudio(nextTrack)

    setCurrentTrack(nextTrack)
    localStorage.setItem(BGM_TRACK_KEY, nextTrack.id)

    if (wasPlaying || isOn) {
      setIsOn(true)
      localStorage.setItem(BGM_KEY, 'true')
      void audioRef.current.play().catch(() => {
        // Browser autoplay policy or missing audio file; keep UI non-fatal.
      })
    }
  }

  useEffect(() => {
    return () => {
      audioRef.current?.pause()
    }
  }, [])

  return { isOn, toggle, tracks: BGM_TRACKS, currentTrack, selectTrack }
}
