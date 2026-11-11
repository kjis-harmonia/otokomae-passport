// 12:00 の「解禁」が粉々に飛び散る（11/11 慶一郎さん）
//   筆文字（kaikin-brush.png）を 40〜60 枚の三角の破片に割り、回転しながら外へ飛ばし、金の粉を残して消える。
//   古い iPhone でもカクつかないよう、破片は最初に1枚ずつ小さな canvas に描いておき、毎回は移動・回転して貼るだけ。
//   「動きを減らす」設定の方には出さない（呼ぶ側でふわっと消す）
import { useEffect, useRef } from 'react'

const SRC = '/gacha/kaikin-brush.png'
const SHATTER_MS = 1500
const CRACK_MS = 160 // 最初はひびが入ってわずかに離れるだけ（割れた瞬間が見える）

type Shard = { c: HTMLCanvasElement; ox: number; oy: number; x: number; y: number; vx: number; vy: number; a: number; va: number }
type Dust = { x: number; y: number; vx: number; vy: number; r: number; life: number; t0: number }

/** 画面での「解禁」の位置（CSS の .launch-kaikin と同じ：幅 min(82vw, 520px)、真ん中） */
function kaikinBox(img: HTMLImageElement) {
  const W = window.innerWidth, H = window.innerHeight
  const w = Math.min(W * 0.82, 520), h = w * (img.naturalHeight / img.naturalWidth)
  return { x: (W - w) / 2, y: (H - h) / 2, w, h }
}

export function KaikinShatter({ onDone }: { onDone: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  // 親は1秒ごとに描き直すので、終わりの合図は ref で持つ（effect を張り直すと、割れる動きが最初からやり直しになる）
  const done = useRef(onDone)
  useEffect(() => { done.current = onDone }, [onDone])
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    let raf = 0, stopped = false
    const img = new Image()
    img.src = SRC
    const start = () => {
      if (stopped) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const W = window.innerWidth, H = window.innerHeight
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr)
      const ctx = cv.getContext('2d')
      if (!ctx) { done.current(); return }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const box = kaikinBox(img)
      // 割れ目：横 7・縦 5 のゆがんだ格子 → 1マスを2つの三角に（70枚。文字の無い透明な破片は省く → 40〜60枚）
      const COLS = 7, ROWS = 5
      const pts: { x: number; y: number }[][] = []
      for (let j = 0; j <= ROWS; j++) {
        pts.push([])
        for (let i = 0; i <= COLS; i++) {
          const edge = i === 0 || j === 0 || i === COLS || j === ROWS
          const jx = edge ? 0 : (Math.random() - 0.5) * (box.w / COLS) * 0.7
          const jy = edge ? 0 : (Math.random() - 0.5) * (box.h / ROWS) * 0.7
          pts[j].push({ x: box.x + (i / COLS) * box.w + jx, y: box.y + (j / ROWS) * box.h + jy })
        }
      }
      // 文字があるか（透明でない画素）を見るための小さな写し
      const probe = document.createElement('canvas')
      probe.width = 76; probe.height = Math.round(76 * img.naturalHeight / img.naturalWidth)
      const pc = probe.getContext('2d', { willReadFrequently: true })!
      pc.drawImage(img, 0, 0, probe.width, probe.height)
      const pd = pc.getImageData(0, 0, probe.width, probe.height).data
      const inked = (tri: { x: number; y: number }[]) => {
        // 三角の中の数点で、文字があるか
        for (let k = 0; k < 12; k++) {
          let u = Math.random(), v = Math.random()
          if (u + v > 1) { u = 1 - u; v = 1 - v }
          const px = tri[0].x + u * (tri[1].x - tri[0].x) + v * (tri[2].x - tri[0].x)
          const py = tri[0].y + u * (tri[1].y - tri[0].y) + v * (tri[2].y - tri[0].y)
          const sx = Math.floor(((px - box.x) / box.w) * probe.width), sy = Math.floor(((py - box.y) / box.h) * probe.height)
          if (sx >= 0 && sy >= 0 && sx < probe.width && sy < probe.height && pd[(sy * probe.width + sx) * 4 + 3] > 60) return true
        }
        return false
      }
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2
      const shards: Shard[] = []
      const dust: Dust[] = []
      for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
        const p00 = pts[j][i], p10 = pts[j][i + 1], p01 = pts[j + 1][i], p11 = pts[j + 1][i + 1]
        for (const tri of [[p00, p10, p11], [p00, p11, p01]]) {
          if (!inked(tri)) continue
          const minX = Math.min(...tri.map(p => p.x)), minY = Math.min(...tri.map(p => p.y))
          const maxX = Math.max(...tri.map(p => p.x)), maxY = Math.max(...tri.map(p => p.y))
          const bw = Math.ceil(maxX - minX) + 2, bh = Math.ceil(maxY - minY) + 2
          const c = document.createElement('canvas')
          c.width = Math.ceil(bw * dpr); c.height = Math.ceil(bh * dpr)
          const g = c.getContext('2d')!
          g.scale(dpr, dpr)
          g.beginPath(); g.moveTo(tri[0].x - minX + 1, tri[0].y - minY + 1); g.lineTo(tri[1].x - minX + 1, tri[1].y - minY + 1); g.lineTo(tri[2].x - minX + 1, tri[2].y - minY + 1); g.closePath(); g.clip()
          g.drawImage(img, box.x - minX + 1, box.y - minY + 1, box.w, box.h)
          const mx = (tri[0].x + tri[1].x + tri[2].x) / 3, my = (tri[0].y + tri[1].y + tri[2].y) / 3
          const dx = mx - cx, dy = my - cy, d = Math.hypot(dx, dy) || 1
          const sp = 3 + Math.random() * 6.5
          shards.push({ c, ox: mx - minX + 1, oy: my - minY + 1, x: mx, y: my, vx: (dx / d) * sp + (Math.random() - 0.5) * 3, vy: (dy / d) * sp - 2 - Math.random() * 3, a: 0, va: (Math.random() - 0.5) * 0.3 })
          // 割れたところから金の粉
          for (let k = 0; k < 5; k++) dust.push({ x: mx + (Math.random() - 0.5) * 14, y: my + (Math.random() - 0.5) * 14, vx: (Math.random() - 0.5) * 1.8, vy: (Math.random() - 0.5) * 1.8 - 0.5, r: 1.2 + Math.random() * 2, life: 1100 + Math.random() * 1000, t0: 80 + Math.random() * 220 })
        }
      }
      const t0 = performance.now()
      const frame = (now: number) => {
        if (stopped) return
        const t = now - t0
        ctx.clearRect(0, 0, W, H)
        // 破片：外へ飛び、回り、少し落ち、消える
        const fade = t < CRACK_MS ? 1 : Math.max(0, 1 - (t - CRACK_MS) / (SHATTER_MS * 0.7))
        if (fade > 0) {
          ctx.globalAlpha = fade
          for (const s of shards) {
            const k = t < CRACK_MS ? 0.12 : 1 // ひびの間はほとんど動かない
            s.x += s.vx * k; s.y += s.vy * k; if (t >= CRACK_MS) { s.vy += 0.26; s.vx *= 0.985; s.a += s.va }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            ctx.translate(s.x, s.y); ctx.rotate(s.a)
            ctx.drawImage(s.c, -s.ox, -s.oy, s.c.width / dpr, s.c.height / dpr)
          }
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        }
        // 金の粉：ゆっくり舞って消える
        ctx.fillStyle = '#f2d27e'
        for (const p of dust) {
          const life = t - p.t0
          if (life < 0 || life > p.life) continue
          p.x += p.vx; p.y += p.vy; p.vx *= 0.97; p.vy = p.vy * 0.97 + 0.015
          ctx.globalAlpha = Math.min(1, 1.15 * (1 - life / p.life))
          ctx.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r)
        }
        ctx.globalAlpha = 1
        if (t < SHATTER_MS + 500) raf = requestAnimationFrame(frame)
        else done.current()
      }
      raf = requestAnimationFrame(frame)
    }
    if (img.complete && img.naturalWidth) start()
    else { img.onload = start; img.onerror = () => done.current() }
    return () => { stopped = true; cancelAnimationFrame(raf) }
  }, [])
  return <canvas ref={ref} className="launch-shatter" aria-hidden="true" />
}
