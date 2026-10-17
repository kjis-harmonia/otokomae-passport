// アシスタントの顔：バイクに乗った JOHNNY の動画（約10秒、音なし、無限ループ）。背景は黒なので画面になじむ。
// 状態は動画の下の細い線で示す（聞き取り中は白く脈打つ、考え中・話し中はゆっくり光る）。
// 動画が再生できない端末（省電力モードなど）では最初のコマの画像が出る。
import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'

export type OrbState = 'idle' | 'listening' | 'speaking' | 'thinking'

const SRC = '/johnny/johnny-rider.mp4'
const POSTER = '/johnny/johnny-rider.jpg'

export function JohnnyRider({ state, width = 320 }: { state: OrbState; width?: number }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  // 自動再生が止められても、画面に戻ったとき・触れたときにもう一度再生する
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const play = () => { if (v.paused) void v.play().catch(() => {}) }
    play()
    document.addEventListener('visibilitychange', play)
    window.addEventListener('pointerdown', play, true)
    return () => {
      document.removeEventListener('visibilitychange', play)
      window.removeEventListener('pointerdown', play, true)
    }
  }, [])
  const line = state === 'listening'
    ? { opacity: [0.35, 1, 0.35], scaleX: [0.6, 1, 0.6], transition: { duration: 1.1, repeat: Infinity, ease: 'easeInOut' as const } }
    : state === 'idle'
      ? { opacity: 0.18, scaleX: 0.5 }
      : { opacity: [0.25, 0.6, 0.25], scaleX: 0.8, transition: { duration: 1.8, repeat: Infinity, ease: 'easeInOut' as const } }
  return (
    <div style={{ width, maxWidth: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, transition: 'width 0.25s ease' }}>
      <video
        ref={videoRef}
        src={SRC}
        poster={POSTER}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden="true"
        disablePictureInPicture
        style={{ width: '100%', aspectRatio: '16 / 9', height: 'auto', objectFit: 'cover', display: 'block', background: '#000', pointerEvents: 'none' }}
      />
      <motion.span
        aria-hidden="true"
        animate={line}
        style={{ width: 56, height: 2, borderRadius: 1, background: state === 'listening' ? '#FFFFFF' : '#C9A24B', display: 'block' }}
      />
    </div>
  )
}
