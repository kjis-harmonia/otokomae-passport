// アシスタントの状態を示す球（白黒だけ）。待機はゆっくり呼吸、聞き取り中は大きく揺れ、話す・考える中は一定のリズム。
// 動きを減らす設定の端末では止まった円だけを描く。
import { useEffect, useRef } from 'react'

export type OrbState = 'idle' | 'listening' | 'speaking' | 'thinking'

const PARAMS: Record<OrbState, { amp: number; speed: number }> = {
  idle: { amp: 0.018, speed: 0.6 },
  thinking: { amp: 0.03, speed: 1.6 },
  speaking: { amp: 0.055, speed: 2.2 },
  listening: { amp: 0.09, speed: 3.0 },
}

export function VoiceOrb({ state, size = 168 }: { state: OrbState; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    canvas.width = size * dpr
    canvas.height = size * dpr
    ctx.scale(dpr, dpr)
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const c = size / 2
    const base = size * 0.34
    let amp = PARAMS.idle.amp
    let raf = 0
    let t = 0
    let last = performance.now()

    const draw = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      const p = PARAMS[stateRef.current]
      amp += (p.amp - amp) * Math.min(dt * 4, 1)
      t += dt * p.speed
      ctx.clearRect(0, 0, size, size)

      // 内側のごく弱い光（面ではなく奥行きだけ）
      const glow = ctx.createRadialGradient(c, c, base * 0.2, c, c, base * 1.25)
      glow.addColorStop(0, 'rgba(255,255,255,0.07)')
      glow.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(c, c, base * 1.25, 0, Math.PI * 2)
      ctx.fill()

      const rings = [
        { alpha: 0.85, phase: 0, k: 3, w: 1.4 },
        { alpha: 0.42, phase: 2.1, k: 4, w: 1.1 },
        { alpha: 0.22, phase: 4.2, k: 5, w: 1 },
      ]
      for (const ring of rings) {
        ctx.beginPath()
        for (let i = 0; i <= 120; i++) {
          const a = (i / 120) * Math.PI * 2
          const wobble = reduce ? 0
            : Math.sin(a * ring.k + t * 2 + ring.phase) * 0.6 + Math.sin(a * (ring.k + 2) - t * 1.3 + ring.phase) * 0.4
          const r = base * (1 + amp * wobble)
          const x = c + Math.cos(a) * r
          const y = c + Math.sin(a) * r
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.closePath()
        ctx.strokeStyle = `rgba(255,255,255,${ring.alpha})`
        ctx.lineWidth = ring.w
        ctx.stroke()
      }

      // 考え中：細い弧が一周する
      if (stateRef.current === 'thinking' && !reduce) {
        ctx.beginPath()
        ctx.arc(c, c, base * 1.16, t * 1.8, t * 1.8 + Math.PI * 0.45)
        ctx.strokeStyle = 'rgba(255,255,255,0.55)'
        ctx.lineWidth = 1.2
        ctx.lineCap = 'round'
        ctx.stroke()
      }
      if (!reduce) raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [size])

  return <canvas ref={canvasRef} aria-hidden="true" style={{ width: size, height: size, display: 'block' }} />
}
