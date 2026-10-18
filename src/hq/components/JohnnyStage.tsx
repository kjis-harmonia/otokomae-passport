// 本部 JOHNNY の舞台（画面いっぱいのキャンバス）。
//   星の流れる宇宙・奥へ続く光の床・二重の点の球（ゆっくり回る＋走査の光の帯）・プラズマの核と光の筋・
//   目盛りのリング・文字の入った外周・声に合わせて揺れる波形のリング・軌道の光点。光は縮小した裏の絵をぼかして重ねる（ブルーム）。
//   mode：idle＝ゆっくり呼吸 / listening＝聞いている（波形）/ thinking＝速く回る / speaking＝話している（波形と核が声に合わせる）
//   level()：いまの音の大きさ（0〜1）。画面が隠れている間は止める。動きを減らす設定なら静止画。
import { useEffect, useRef } from 'react'
import { stageLayout } from './stageLayout'

export type StageMode = 'idle' | 'listening' | 'thinking' | 'speaking'

interface P3 { x: number; y: number; z: number }

const C = '95, 212, 255'
const B = '40, 120, 255'

function fib(n: number): P3[] {
  const out: P3[] = []
  const g = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2
    const r = Math.sqrt(1 - y * y)
    out.push({ x: Math.cos(g * i) * r, y, z: Math.sin(g * i) * r })
  }
  return out
}

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export function JohnnyStage({ mode, level, label, className }: { mode: StageMode; level: () => number; label: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const modeRef = useRef(mode)
  const levelRef = useRef(level)
  const labelRef = useRef(label)
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { levelRef.current = level }, [level])
  useEffect(() => { labelRef.current = label }, [label])

  useEffect(() => {
    const el = ref.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    const glowCanvas = document.createElement('canvas')
    const gctx = glowCanvas.getContext('2d')!
    let W = 0, H = 0, dpr = 1, R = 100, cx = 0, cy = 0
    const small = () => W < 700
    const outer = fib(small() ? 900 : 1500)
    const inner = fib(small() ? 380 : 650)
    const stars = Array.from({ length: 160 }, () => ({ x: Math.random(), y: Math.random(), z: 0.2 + Math.random() * 0.8, tw: Math.random() * 6.28 }))
    const motes = Array.from({ length: 70 }, () => ({ a: Math.random() * 6.28, r: 1.15 + Math.random() * 1.1, y: Math.random() * 2 - 1, s: 0.05 + Math.random() * 0.15 }))
    const bars = new Float32Array(144)
    const rays = Array.from({ length: 64 }, () => ({ a: Math.random() * 6.28, len: 0.3 + Math.random() * 0.7, sp: 0.2 + Math.random() * 0.6, ph: Math.random() * 6.28 }))

    const resize = () => {
      const rect = el.getBoundingClientRect()
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      W = rect.width; H = rect.height
      el.width = Math.round(W * dpr); el.height = Math.round(H * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      glowCanvas.width = Math.max(1, Math.round(W / 3)); glowCanvas.height = Math.max(1, Math.round(H / 3))
      const lay = stageLayout(W, H)
      R = lay.R
      cx = W / 2
      cy = lay.cy
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(el)

    let raf = 0, last = performance.now(), spin = 0, phase = 0, energy = 0, voice = 0, wave = 0, lastMode: StageMode = modeRef.current
    const shocks: { t: number }[] = []
    const tilt = 0.42

    const proj = (p: P3, rot: number, scale: number) => {
      const x1 = p.x * Math.cos(rot) + p.z * Math.sin(rot)
      const z1 = -p.x * Math.sin(rot) + p.z * Math.cos(rot)
      const y2 = p.y * Math.cos(tilt) - z1 * Math.sin(tilt)
      const z2 = p.y * Math.sin(tilt) + z1 * Math.cos(tilt)
      const persp = 1 + z2 * 0.12
      return { x: cx + x1 * R * scale * persp, y: cy + y2 * R * scale * persp, z: z2 }
    }

    /** 球と核（ブルーム用の裏の絵にも同じものを描く） */
    const drawSphere = (g: CanvasRenderingContext2D, k: number, t: number, b: number, crisp: boolean) => {
      g.save()
      g.scale(k, k)
      // 走査の光の帯（緯度に沿って上下する）
      const band = Math.sin(t * 0.7) * 0.9
      for (const p0 of inner) {
        const p = proj(p0, -spin * 1.6, 0.62)
        const f = (p.z + 1) / 2
        g.fillStyle = `rgba(${C}, ${(0.08 + f * 0.4) * (0.7 + 0.3 * b)})`
        const s = 0.6 + f * 0.9
        g.fillRect(p.x - s / 2, p.y - s / 2, s, s)
      }
      for (const p0 of outer) {
        const p = proj(p0, spin, 1)
        const f = (p.z + 1) / 2
        const near = Math.max(0, 1 - Math.abs(p0.y - band) * 6)
        const a = (0.1 + f * 0.7) * (0.75 + 0.25 * b) + near * 0.6 * f
        const s = (0.5 + f * 1.5) * (1 + near * 0.6)
        g.fillStyle = near > 0.3 && f > 0.4 ? `rgba(225, 248, 255, ${Math.min(1, a)})` : `rgba(${C}, ${Math.min(1, a)})`
        g.fillRect(p.x - s / 2, p.y - s / 2, s, s)
      }
      // 核
      const lv = voice
      const coreR = R * (0.2 + 0.07 * b + energy * 0.06 + lv * 0.2)
      const cg = g.createRadialGradient(cx, cy, 0, cx, cy, coreR * 1.6)
      cg.addColorStop(0, 'rgba(255,255,255,1)')
      cg.addColorStop(0.1, 'rgba(210,245,255,0.9)')
      cg.addColorStop(0.3, `rgba(${C}, ${0.4 + 0.2 * b})`)
      cg.addColorStop(0.7, `rgba(${B}, ${0.15 + 0.1 * b})`)
      cg.addColorStop(1, 'rgba(0,0,0,0)')
      g.fillStyle = cg
      g.beginPath(); g.arc(cx, cy, coreR * 1.6, 0, Math.PI * 2); g.fill()
      // 光の筋（コロナ）
      g.lineCap = 'round'
      for (const r of rays) {
        const l = R * (0.25 + r.len * (0.35 + lv * 0.9 + energy * 0.25) * (0.7 + 0.3 * Math.sin(t * r.sp * 3 + r.ph)))
        const a = r.a + t * r.sp * 0.3
        g.strokeStyle = `rgba(200, 240, 255, ${crisp ? 0.12 + lv * 0.25 : 0.3})`
        g.lineWidth = crisp ? 0.8 : 2
        g.beginPath()
        g.moveTo(cx + Math.cos(a) * coreR * 0.3, cy + Math.sin(a) * coreR * 0.3)
        g.lineTo(cx + Math.cos(a) * l, cy + Math.sin(a) * l)
        g.stroke()
      }
      g.restore()
    }

    const draw = (t: number, dt: number) => {
      const m = modeRef.current
      if (m !== lastMode) { shocks.push({ t }); lastMode = m }
      const targetE = m === 'thinking' ? 1 : m === 'idle' ? 0 : 0.5
      energy += (targetE - energy) * Math.min(dt * 2.5, 1)
      const lvRaw = m === 'listening' || m === 'speaking' ? Math.min(1, levelRef.current() * 1.6) : 0
      voice += (lvRaw - voice) * Math.min(dt * (lvRaw > voice ? 18 : 6), 1)
      wave += ((m === 'listening' || m === 'speaking' ? 1 : 0) - wave) * Math.min(dt * 4, 1)
      phase += (dt / (4.2 - energy * 2.6)) * Math.PI * 2
      spin += dt * (0.12 + energy * 0.7)
      const b = 0.5 + 0.5 * Math.sin(phase)

      // 背景：宇宙
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.9)
      bg.addColorStop(0, '#0a1a33')
      bg.addColorStop(0.45, '#040b18')
      bg.addColorStop(1, '#010309')
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, W, H)
      ctx.globalCompositeOperation = 'lighter'
      for (const s of stars) {
        s.x -= dt * 0.004 * s.z * (1 + energy * 3)
        if (s.x < 0) s.x += 1
        const a = (0.25 + 0.5 * Math.sin(t * 1.5 + s.tw) ** 2) * s.z
        ctx.fillStyle = `rgba(190, 225, 255, ${a})`
        const sz = s.z * 1.4
        ctx.fillRect(s.x * W, s.y * H, sz, sz)
      }
      // 星雲のにじみ
      const neb = ctx.createRadialGradient(cx, cy, R * 0.5, cx, cy, R * 4)
      neb.addColorStop(0, `rgba(${B}, ${0.16 + 0.1 * b + energy * 0.08})`)
      neb.addColorStop(0.5, `rgba(${C}, ${0.04 + 0.03 * b})`)
      neb.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = neb
      ctx.fillRect(0, 0, W, H)

      // 奥へ続く光の床
      const horizon = cy + R * 1.55
      ctx.lineWidth = 1
      for (let i = 0; i < 14; i++) {
        const z = ((i + (t * 0.25) % 1) / 14)
        const y = horizon + (H - horizon) * z * z
        ctx.strokeStyle = `rgba(${C}, ${0.03 + z * 0.12})`
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
      }
      for (let i = -12; i <= 12; i++) {
        ctx.strokeStyle = `rgba(${C}, ${0.08 - Math.abs(i) * 0.004})`
        ctx.beginPath(); ctx.moveTo(cx + i * R * 0.12, horizon); ctx.lineTo(cx + i * W * 0.12, H); ctx.stroke()
      }
      // 台座
      for (let i = 0; i < 4; i++) {
        const rx = R * (0.8 + i * 0.35)
        ctx.beginPath()
        ctx.ellipse(cx, horizon, rx, rx * 0.16, 0, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${C}, ${(0.4 - i * 0.08) * (0.6 + 0.4 * b)})`
        ctx.lineWidth = i === 0 ? 2 : 1
        ctx.stroke()
      }
      const pool = ctx.createRadialGradient(cx, horizon, 0, cx, horizon, R * 1.3)
      pool.addColorStop(0, `rgba(${C}, ${0.3 + 0.2 * b})`)
      pool.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.save(); ctx.translate(cx, horizon); ctx.scale(1, 0.18); ctx.fillStyle = pool; ctx.beginPath(); ctx.arc(0, 0, R * 1.3, 0, Math.PI * 2); ctx.fill(); ctx.restore()
      // 光の柱
      // 光の柱（横にやわらかく消える）
      ctx.save()
      ctx.translate(cx, horizon)
      ctx.scale(1, 9)
      const beam = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.32)
      beam.addColorStop(0, `rgba(${C}, ${0.14 + 0.1 * b})`)
      beam.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = beam
      ctx.beginPath(); ctx.arc(0, 0, R * 0.32, Math.PI, Math.PI * 2); ctx.fill()
      ctx.restore()

      // ブルーム：小さい裏の絵に球を描き、ぼかして重ねる
      gctx.setTransform(1, 0, 0, 1, 0, 0)
      gctx.clearRect(0, 0, glowCanvas.width, glowCanvas.height)
      gctx.globalCompositeOperation = 'lighter'
      drawSphere(gctx, glowCanvas.width / W, t, b, false)
      ctx.save()
      ctx.filter = `blur(${Math.round(R * 0.12)}px)`
      ctx.globalAlpha = 0.5 + 0.15 * b + voice * 0.3
      ctx.drawImage(glowCanvas, 0, 0, W, H)
      ctx.restore()
      drawSphere(ctx, 1, t, b, true)

      // 波形のリング（聞いている・話している）
      if (wave > 0.02) {
        const n = bars.length
        for (let i = 0; i < n; i++) {
          const target = voice * (0.35 + 0.65 * Math.abs(Math.sin(i * 0.37 + t * 9) * Math.cos(i * 0.11 - t * 4)))
          bars[i] += (target - bars[i]) * Math.min(dt * 14, 1)
          const a = (i / n) * Math.PI * 2 - Math.PI / 2
          const r0 = R * 1.14
          const r1 = r0 + R * (0.04 + bars[i] * 0.55)
          ctx.strokeStyle = `rgba(${C}, ${(0.35 + bars[i] * 0.6) * wave})`
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0)
          ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
          ctx.stroke()
        }
      }

      // 目盛りのリング
      const tickR = R * 1.48
      const rot1 = t * 0.05 * (1 + energy * 2)
      for (let i = 0; i < 180; i++) {
        const a = (i / 180) * Math.PI * 2 + rot1
        const long = i % 15 === 0
        const len = long ? R * 0.08 : R * 0.03
        ctx.strokeStyle = `rgba(${C}, ${long ? 0.7 : 0.3})`
        ctx.lineWidth = long ? 1.6 : 1
        ctx.beginPath()
        ctx.moveTo(cx + Math.cos(a) * tickR, cy + Math.sin(a) * tickR)
        ctx.lineTo(cx + Math.cos(a) * (tickR + len), cy + Math.sin(a) * (tickR + len))
        ctx.stroke()
      }
      // 区切られた太いリング（逆回り）
      const segR = R * 1.7
      const rot2 = -t * 0.12 * (1 + energy * 2.5)
      ctx.lineWidth = Math.max(2, R * 0.03)
      for (let s = 0; s < 3; s++) {
        const a0 = rot2 + (s * Math.PI * 2) / 3
        ctx.strokeStyle = `rgba(${C}, ${0.45 + 0.25 * b})`
        ctx.beginPath(); ctx.arc(cx, cy, segR, a0, a0 + 1.4); ctx.stroke()
        ctx.strokeStyle = `rgba(225, 248, 255, ${0.8})`
        ctx.beginPath(); ctx.arc(cx, cy, segR, a0 + 1.4, a0 + 1.48); ctx.stroke()
      }
      // 外周の文字
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(t * 0.03)
      const textR = R * 1.92
      ctx.font = `${Math.max(9, Math.round(R * 0.07))}px ui-monospace, SFMono-Regular, Menlo, monospace`
      ctx.fillStyle = `rgba(${C}, 0.55)`
      ctx.textAlign = 'center'
      const words = labelRef.current.split('  ')
      words.forEach((w, wi) => {
        const base = (wi / words.length) * Math.PI * 2
        const step = (Math.max(9, R * 0.07) * 1.05) / textR
        ;[...w].forEach((ch, ci) => {
          const a = base + (ci - w.length / 2) * step
          ctx.save()
          ctx.rotate(a)
          ctx.translate(0, -textR)
          ctx.fillText(ch, 0, 0)
          ctx.restore()
        })
      })
      ctx.restore()
      // 点線の外輪
      ctx.setLineDash([2, 7])
      ctx.strokeStyle = `rgba(${C}, 0.25)`
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.arc(cx, cy, R * 2.1, 0, Math.PI * 2); ctx.stroke()
      ctx.setLineDash([])
      // 四隅のかぎ
      const kb = R * 2.15, kl = R * 0.2
      ctx.strokeStyle = `rgba(${C}, ${0.5 + 0.3 * b})`
      ctx.lineWidth = 1.5
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const x = cx + sx * kb * 0.75, y = cy + sy * kb * 0.75
        ctx.beginPath(); ctx.moveTo(x - sx * kl, y); ctx.lineTo(x, y); ctx.lineTo(x, y - sy * kl); ctx.stroke()
      }

      // 軌道の光点（尾を引く）
      for (const [k, rot, sp] of [[1.28, 0.35, 0.55], [1.36, -0.6, -0.4]] as const) {
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot)
        ctx.strokeStyle = `rgba(${C}, 0.18)`
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.ellipse(0, 0, R * k, R * k * 0.26, 0, 0, Math.PI * 2); ctx.stroke()
        const a = t * sp * (1 + energy * 1.5)
        for (let j = 0; j < 14; j++) {
          const aa = a - j * 0.05 * Math.sign(sp)
          const x = Math.cos(aa) * R * k, y = Math.sin(aa) * R * k * 0.26
          ctx.fillStyle = `rgba(200, 240, 255, ${(1 - j / 14) * 0.8})`
          const s = (1 - j / 14) * 3.2
          ctx.beginPath(); ctx.arc(x, y, s, 0, Math.PI * 2); ctx.fill()
        }
        ctx.restore()
      }

      // 漂う光の粒
      for (const q of motes) {
        q.a += dt * q.s * (1 + energy * 2)
        const x = cx + Math.cos(q.a) * R * q.r
        const y = cy + q.y * R * 0.9 + Math.sin(q.a) * R * q.r * 0.22
        ctx.fillStyle = `rgba(${C}, ${0.35 + 0.3 * Math.sin(q.a * 3)})`
        ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6)
      }

      // 切り替わりの衝撃波
      for (let i = shocks.length - 1; i >= 0; i--) {
        const age = t - shocks[i].t
        if (age > 1.4) { shocks.splice(i, 1); continue }
        ctx.strokeStyle = `rgba(200, 240, 255, ${(1 - age / 1.4) * 0.6})`
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.arc(cx, cy, R * (1 + age * 1.6), 0, Math.PI * 2); ctx.stroke()
      }
      ctx.globalCompositeOperation = 'source-over'
    }

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      draw(now / 1000, dt)
      raf = requestAnimationFrame(frame)
    }
    if (reduced()) { draw(0, 0); return () => ro.disconnect() }
    const onVis = () => { cancelAnimationFrame(raf); if (!document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame) } }
    document.addEventListener('visibilitychange', onVis)
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); ro.disconnect(); document.removeEventListener('visibilitychange', onVis) }
  }, [])

  return <canvas ref={ref} aria-hidden="true" className={className} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
}
