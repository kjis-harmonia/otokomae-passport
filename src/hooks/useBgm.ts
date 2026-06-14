import { useState, useRef, useEffect } from 'react'

const BGM_KEY = 'ginjiro_bgm_on'
const BGM_SRC = '/assets/audio/ginjiro-theme.mp4'

export function useBgm() {
  // Restore user preference visually, but audio is always paused on load
  // (browser autoplay policy — actual play only happens on user gesture)
  const [isOn, setIsOn] = useState(() => localStorage.getItem(BGM_KEY) === 'true')
  const audioRef = useRef<HTMLAudioElement | null>(null)

  function getAudio(): HTMLAudioElement {
    if (!audioRef.current) {
      const a = new Audio(BGM_SRC)
      a.volume = 0.22
      a.loop = true
      audioRef.current = a
    }
    return audioRef.current
  }

  function toggle() {
    const audio = getAudio()
    const playing = !audio.paused

    if (isOn && playing) {
      // ON and actually playing → turn OFF
      audio.pause()
      setIsOn(false)
      localStorage.setItem(BGM_KEY, 'false')
    } else {
      // OFF, or ON but paused after page reload → play
      setIsOn(true)
      localStorage.setItem(BGM_KEY, 'true')
      void audio.play().catch(() => {
        // Autoplay blocked (e.g. iOS before gesture) — silent fail
      })
    }
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      audioRef.current?.pause()
    }
  }, [])

  return { isOn, toggle }
}
