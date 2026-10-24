// アシスタントの顔：バイクに乗った JOHNNY の動画（約10秒、音なし、無限ループ）。
// 動画の背景は白とうすい灰色の市松模様（透明の印が絵として入っている）。コマごとに「画面の端からつながった、白っぽく色の無いところ」
// だけを透明にして描く（JOHNNY の顔・金のツヤの白は絵の線で囲まれていて端とつながらないので残る）。描けない端末は動画をそのまま出す。
// 状態は動画の下の細い線で示す（聞き取り中は白く脈打つ、考え中・話し中はゆっくり光る）。
// 動画が再生できない端末（省電力モードなど）では最初のコマの画像が出る。
import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'

export type OrbState = 'idle' | 'listening' | 'speaking' | 'thinking'

const SRC = '/johnny/johnny-rider-v2.mp4'
const POSTER = '/johnny/johnny-rider-v2.jpg'

const W = 384, H = 216
const LIGHT = 214  // RGBの最小がこれ以上で、色みが少ない（最大−最小 ≤ GRAY）ところが背景（市松模様は 235〜254）
const SOFT = 188   // ここまでは少し透かす（縁のギザギザ・白いにじみを和らげる）
const GRAY = 22

/** 画面の端からつながった白っぽいところを透明にする（4方向の塗りつぶし） */
function keyOut(img: ImageData, seen: Uint8Array, stack: Int32Array) {
  const d = img.data
  seen.fill(0)
  let top = 0
  const push = (i: number) => { if (!seen[i]) { seen[i] = 1; stack[top++] = i } }
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x) }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1) }
  while (top > 0) {
    const i = stack[--top]
    const p = i * 4
    const lo = Math.min(d[p], d[p + 1], d[p + 2]), hi = Math.max(d[p], d[p + 1], d[p + 2])
    if (lo <= SOFT || hi - lo > GRAY) continue
    d[p + 3] = lo >= LIGHT ? 0 : Math.round(255 * (LIGHT - lo) / (LIGHT - SOFT))
    if (lo < LIGHT) continue
    const x = i % W
    if (x > 0) push(i - 1)
    if (x < W - 1) push(i + 1)
    if (i >= W) push(i - W)
    if (i < (H - 1) * W) push(i + W)
  }
}

export function JohnnyRider({ state, width = 320 }: { state: OrbState; width?: number }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [keyed, setKeyed] = useState(true)
  // コマごとに黒を抜いて canvas に描く
  useEffect(() => {
    const v = videoRef.current, c = canvasRef.current
    const ctx = c?.getContext('2d', { willReadFrequently: true })
    if (!v || !c || !ctx) { setKeyed(false); return }
    const seen = new Uint8Array(W * H), stack = new Int32Array(W * H * 2)
    let raf = 0, last = -1
    const draw = () => {
      raf = requestAnimationFrame(draw)
      if (v.readyState < 2 || v.currentTime === last) return
      last = v.currentTime
      try {
        ctx.drawImage(v, 0, 0, W, H)
        const img = ctx.getImageData(0, 0, W, H)
        keyOut(img, seen, stack)
        ctx.putImageData(img, 0, 0)
      } catch { cancelAnimationFrame(raf); setKeyed(false) }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])
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
        style={keyed
          ? { position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }
          : { width: '100%', aspectRatio: '16 / 9', height: 'auto', objectFit: 'cover', display: 'block', mixBlendMode: 'multiply', pointerEvents: 'none' }}
      />
      {keyed && <canvas ref={canvasRef} width={W} height={H} aria-hidden="true" style={{ width: '100%', aspectRatio: '16 / 9', height: 'auto', display: 'block', pointerEvents: 'none' }} />}
      <motion.span
        aria-hidden="true"
        animate={line}
        style={{ width: 56, height: 2, borderRadius: 1, background: state === 'listening' ? '#8A6A2F' : '#C9A24B', display: 'block' }}
      />
    </div>
  )
}
