import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Camera, ChevronLeft, Check, ZoomIn, ZoomOut, Share2, ImagePlus, Wand2 } from 'lucide-react'
import type { ImageSegmenter } from '@mediapipe/tasks-vision'
import { getStoredValue, setStoredValue, TRYON_STYLE_KEY } from '../utils/storage'
import { getReserveUrl } from '../data/reserveLinks'

type Phase = 'setup' | 'compose'

interface TryOnStyle {
  id: string
  name: string
  imageSrc: string | null
  position: string
}

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const BOTTOM_NAV_H = 64

// MediaPipe settings
const VISION_WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
const HAIR_MODEL_URL   = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite'
const HAIR_CATEGORY    = 1 // selfie_multiclass: 0=BG, 1=hair, 2=body, 3=face, 4=clothes

// Style hair mask cache — computed once per style id per session
const styleMaskCache = new Map<string, HTMLCanvasElement>()

const STYLES: TryOnStyle[] = [
  { id: 'nurepan', name: '濡れパン',          imageSrc: '/assets/hero-nurepan.jpg',      position: '50% 35%' },
  { id: 'curl',    name: 'カールアイパー',     imageSrc: '/assets/hero-curl-iper.jpg',    position: '50% 30%' },
  { id: 'natsu',   name: '夏ニグロ',           imageSrc: '/assets/hero-natsu-niguro.jpg', position: '50% 32%' },
  { id: 'punch',   name: 'パンチパーマ',       imageSrc: '/assets/hero-punch-perm.jpg',   position: '50% 35%' },
  { id: 'ginpara', name: '銀パラ',             imageSrc: '/assets/ginpara.png',           position: '50% 34%' },
  { id: 'teitei',  name: 'テイテイ刈り',       imageSrc: '/assets/teitei-gari.png',       position: '50% 24%' },
  { id: 'gokudo',  name: '極道ボウズ',         imageSrc: '/assets/gokudo-bozu.png',       position: '50% 30%' },
  { id: 'showa',   name: '昭和のアイパー',     imageSrc: '/assets/showa-aiper.png',       position: '50% 30%' },
  { id: 'rejent',  name: 'リーゼントパンチ',   imageSrc: '/assets/rejent-punch.png',      position: '50% 30%' },
  { id: 'afro',    name: 'ジャマイカンアフロ', imageSrc: '/assets/jamaican-afro.png',     position: '50% 30%' },
  { id: 'spain',   name: 'スペインパーマ',     imageSrc: '/assets/spain-parm.jpeg',       position: '50% 30%' },
  { id: 'truck',   name: 'トラック野郎御用達', imageSrc: '/assets/truck-yaro.png',        position: '50% 50%' },
]

// ── Helpers ────────────────────────────────────────────────────────────────────

function parsePos(pos: string): { x: number; y: number } {
  const [a, b] = pos.trim().split(/\s+/)
  return { x: parseFloat(a ?? '50') / 100, y: parseFloat(b ?? '30') / 100 }
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number, dy: number, dw: number, dh: number,
  px = 0.5, py = 0.3,
) {
  const imgAr = img.naturalWidth / img.naturalHeight
  const boxAr = dw / dh
  let sx: number, sy: number, sw: number, sh: number
  if (imgAr > boxAr) {
    sh = img.naturalHeight; sw = sh * boxAr
    sx = (img.naturalWidth - sw) * px; sy = 0
  } else {
    sw = img.naturalWidth; sh = sw / boxAr
    sx = 0; sy = (img.naturalHeight - sh) * py
  }
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload  = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

// ── Step label ─────────────────────────────────────────────────────────────────

function StepLabel({ n, label }: { n: number; label: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <div
        className="flex items-center justify-center rounded-full flex-shrink-0"
        style={{ width: 16, height: 16, background: 'rgba(201,162,74,0.12)', border: '1px solid rgba(201,162,74,0.28)' }}
      >
        <span style={{ fontSize: 8, color: 'rgba(201,162,74,0.80)', fontWeight: 700, lineHeight: 1 }}>{n}</span>
      </div>
      <p style={{ fontSize: 10, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.50)', textTransform: 'uppercase' }}>
        {label}
      </p>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function TryOnScreen() {
  const [phase, setPhase] = useState<Phase>('setup')
  const [selectedId, setSelectedId] = useState<string | null>(
    getStoredValue<string>(TRYON_STYLE_KEY, '') || null,
  )
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const fileInputRef   = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  // Compose overlay state
  const [overlayPos,   setOverlayPos]   = useState({ x: 0, y: 0 })
  const [overlayScale, setOverlayScale] = useState(1.0)
  const compositeRef = useRef<HTMLDivElement>(null)
  const isDragging   = useRef(false)
  const lastPtr      = useRef({ x: 0, y: 0 })

  // AI analysis state
  const [isAnalyzing,   setIsAnalyzing]   = useState(false)
  const [hairMaskUrl,   setHairMaskUrl]   = useState<string | null>(null)
  const segmenterRef    = useRef<ImageSegmenter | null>(null)
  const analyzedKeyRef  = useRef<string | null>(null) // `${photoUrl}:${styleId}`

  // Auto-run analysis when entering compose (once per photo+style combo)
  useEffect(() => {
    if (phase !== 'compose' || !photoUrl || !selectedId) return
    const key = `${photoUrl}:${selectedId}`
    if (analyzedKeyRef.current === key) return
    void runAnalysis()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // Reset overlay position when style changes in setup phase
  useEffect(() => {
    if (phase === 'setup') {
      setOverlayPos({ x: 0, y: 0 })
      setOverlayScale(1.0)
      setHairMaskUrl(null)
      analyzedKeyRef.current = null
    }
  }, [selectedId, phase])

  // ── Segmenter ────────────────────────────────────────────────────────────────

  async function getSegmenter(): Promise<ImageSegmenter> {
    if (segmenterRef.current) return segmenterRef.current
    const { ImageSegmenter, FilesetResolver } = await import('@mediapipe/tasks-vision')
    const vision = await FilesetResolver.forVisionTasks(VISION_WASM_URL)
    segmenterRef.current = await ImageSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetPath: HAIR_MODEL_URL, delegate: 'CPU' },
      outputCategoryMask: true,
      runningMode: 'IMAGE',
    })
    return segmenterRef.current
  }

  async function runAnalysis() {
    if (!photoUrl || !selectedStyle?.imageSrc) return
    setIsAnalyzing(true)

    try {
      const W = compositeRef.current?.clientWidth  ?? 390
      const H = compositeRef.current?.clientHeight ?? 600
      const seg = await getSegmenter()

      // ── 1. Segment user photo → hair centroid & bounding box ──────────────
      const userImg = await loadImg(photoUrl)
      const uc = document.createElement('canvas')
      uc.width = W; uc.height = H
      drawCover(uc.getContext('2d')!, userImg, 0, 0, W, H, 0.5, 0)

      const ur = seg.segment(uc)
      const ud = ur.categoryMask!.getAsUint8Array()
      ur.categoryMask!.close()

      let sumX = 0, sumY = 0, count = 0, minY = H, maxY = 0
      for (let i = 0; i < W * H; i++) {
        if (ud[i] === HAIR_CATEGORY) {
          const x = i % W, y = Math.floor(i / W)
          sumX += x; sumY += y; count++
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }

      // ── 2. Segment style image → build hair-only mask ──────────────────────
      let styleMaskCanvas = styleMaskCache.get(selectedStyle.id)
      if (!styleMaskCanvas) {
        const styleImg = await loadImg(selectedStyle.imageSrc)
        const sc = document.createElement('canvas')
        sc.width = W; sc.height = H
        const { x: px, y: py } = parsePos(selectedStyle.position)
        drawCover(sc.getContext('2d')!, styleImg, 0, 0, W, H, px, py)

        const sr = seg.segment(sc)
        const sd = sr.categoryMask!.getAsUint8Array()
        sr.categoryMask!.close()

        styleMaskCanvas = document.createElement('canvas')
        styleMaskCanvas.width = W; styleMaskCanvas.height = H
        const mc = styleMaskCanvas.getContext('2d')!
        const mi = mc.createImageData(W, H)
        for (let i = 0; i < W * H; i++) {
          if (sd[i] === HAIR_CATEGORY) {
            mi.data[i * 4]     = 255
            mi.data[i * 4 + 1] = 255
            mi.data[i * 4 + 2] = 255
            mi.data[i * 4 + 3] = 255
          }
        }
        mc.putImageData(mi, 0, 0)
        styleMaskCache.set(selectedStyle.id, styleMaskCanvas)
      }
      setHairMaskUrl(styleMaskCanvas.toDataURL())

      // ── 3. Auto-position overlay ───────────────────────────────────────────
      if (count > 0) {
        const hairCx  = sumX / count
        const hairCy  = sumY / count
        const hairH   = Math.max(1, maxY - minY)

        // Style hair region (at scale=1) occupies roughly the top 28% of the portrait.
        // We want that region to land at the user's hair centroid.
        const styleHairFrac = 0.28
        // ty formula: hairCy = H/2 - s*H/2 + ty + styleHairFrac * s * H
        //           → ty = hairCy - H/2 + s*(H/2 - styleHairFrac*H)
        const autoScale = Math.max(0.5, Math.min(2.0, hairH / (H * styleHairFrac)))
        const ty = hairCy - H / 2 + autoScale * (H / 2 - styleHairFrac * H)
        const tx = hairCx - W / 2

        setOverlayScale(autoScale)
        setOverlayPos({ x: tx, y: ty })
      }

      analyzedKeyRef.current = `${photoUrl}:${selectedId}`
    } catch (err) {
      console.error('[HairSeg]', err)
      // Analysis failed — keep default centered position
    } finally {
      setIsAnalyzing(false)
    }
  }

  // ── Event handlers ────────────────────────────────────────────────────────────

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const r = ev.target?.result
      if (typeof r === 'string') setPhotoUrl(r)
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  function handleSelectStyle(id: string) {
    setSelectedId(id)
    setStoredValue(TRYON_STYLE_KEY, id)
  }

  function handlePointerDown(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId)
    isDragging.current = true
    lastPtr.current = { x: e.clientX, y: e.clientY }
  }
  function handlePointerMove(e: React.PointerEvent) {
    if (!isDragging.current) return
    const dx = e.clientX - lastPtr.current.x
    const dy = e.clientY - lastPtr.current.y
    lastPtr.current = { x: e.clientX, y: e.clientY }
    setOverlayPos(p => ({ x: p.x + dx, y: p.y + dy }))
  }
  function handlePointerUp() { isDragging.current = false }

  // ── Canvas save / share ────────────────────────────────────────────────────────

  async function handleSaveShare() {
    const container = compositeRef.current
    if (!container || !photoUrl || !selectedStyle?.imageSrc) return

    const { width: W, height: H } = container.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio ?? 1, 2)
    const canvas = document.createElement('canvas')
    canvas.width  = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)

    try {
      const [userImg, styleImg] = await Promise.all([
        loadImg(photoUrl),
        loadImg(selectedStyle.imageSrc),
      ])

      // Base: user photo
      drawCover(ctx, userImg, 0, 0, W, H, 0.5, 0)

      // Style overlay with hair mask
      const temp = document.createElement('canvas')
      temp.width = W; temp.height = H
      const tCtx = temp.getContext('2d')!

      // Draw style image at overlay transform
      tCtx.save()
      tCtx.translate(W / 2 + overlayPos.x, H / 2 + overlayPos.y)
      tCtx.scale(overlayScale, overlayScale)
      tCtx.translate(-W / 2, -H / 2)
      const { x: px, y: py } = parsePos(selectedStyle.position)
      drawCover(tCtx, styleImg, 0, 0, W, H, px, py)
      tCtx.restore()

      // Apply hair mask (moves with the transform)
      const maskCanvas = styleMaskCache.get(selectedStyle.id)
      if (maskCanvas) {
        tCtx.save()
        tCtx.globalCompositeOperation = 'destination-in'
        tCtx.translate(W / 2 + overlayPos.x, H / 2 + overlayPos.y)
        tCtx.scale(overlayScale, overlayScale)
        tCtx.translate(-W / 2, -H / 2)
        tCtx.drawImage(maskCanvas, 0, 0, W, H)
        tCtx.restore()
      }

      ctx.drawImage(temp, 0, 0)
    } catch { /* draw only user photo on error */ }

    canvas.toBlob(async (blob) => {
      if (!blob) return
      const file = new File([blob], 'otokomae.png', { type: 'image/png' })
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            title: '男前試着室',
            text: `俺の男前スタイルは「${selectedStyle!.name}」だ！ #男前パスポート #銀二郎`,
            files: [file],
          })
          return
        } catch { /* fall through */ }
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = 'otokomae.png'
      document.body.appendChild(a); a.click()
      document.body.removeChild(a); URL.revokeObjectURL(url)
    }, 'image/png')
  }

  const selectedStyle = STYLES.find((s) => s.id === selectedId) ?? null
  const canStart = !!photoUrl && !!selectedId

  /* ══════════════════════════════════════════════════════════════════════════
     COMPOSE PHASE
  ══════════════════════════════════════════════════════════════════════════ */
  if (phase === 'compose') {
    const reserveUrl = selectedStyle ? getReserveUrl(selectedStyle.name) : ''

    return (
      <div
        className="flex flex-col overflow-hidden"
        style={{ height: `calc(100dvh - ${BOTTOM_NAV_H}px)` }}
      >
        {/* Top bar */}
        <div
          className="flex items-center px-5 flex-shrink-0"
          style={{ height: 52, borderBottom: '1px solid rgba(201,162,74,0.09)' }}
        >
          <button
            type="button"
            onClick={() => setPhase('setup')}
            className="flex items-center gap-1 active:opacity-60"
            style={{ color: 'rgba(201,162,74,0.68)' }}
          >
            <ChevronLeft size={18} strokeWidth={2} />
            <span className="text-xs tracking-wide" style={{ fontFamily: SERIF }}>戻る</span>
          </button>
          <p className="flex-1 text-center text-xs font-bold tracking-[0.18em]" style={{ color: 'rgba(242,230,200,0.56)', fontFamily: SERIF }}>
            {selectedStyle?.name ?? ''}
          </p>
          {/* Re-analyze button */}
          <button
            type="button"
            onClick={() => { analyzedKeyRef.current = null; void runAnalysis() }}
            disabled={isAnalyzing}
            className="flex items-center gap-1 px-2 py-1 rounded-lg active:opacity-60 disabled:opacity-30"
            style={{ background: 'rgba(201,162,74,0.08)', border: '1px solid rgba(201,162,74,0.22)', color: 'rgba(201,162,74,0.72)' }}
          >
            <Wand2 size={12} />
            <span className="text-[10px] font-bold tracking-[0.12em]">再認識</span>
          </button>
        </div>

        {/* Composite area */}
        <div
          ref={compositeRef}
          className="flex-1 relative overflow-hidden select-none"
          style={{ background: '#050302', cursor: 'grab' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {/* User photo base */}
          {photoUrl && (
            <img
              src={photoUrl}
              alt="あなたの写真"
              className="absolute inset-0 w-full h-full object-cover pointer-events-none"
              style={{ objectPosition: 'center top' }}
            />
          )}

          {/* Style hair overlay — masked to hair only, draggable */}
          {selectedStyle?.imageSrc && !isAnalyzing && (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                transform: `translate(${overlayPos.x}px, ${overlayPos.y}px) scale(${overlayScale})`,
                transformOrigin: '50% 50%',
                ...(hairMaskUrl ? {
                  WebkitMaskImage: `url(${hairMaskUrl})`,
                  maskImage: `url(${hairMaskUrl})`,
                  WebkitMaskSize: '100% 100%',
                  maskSize: '100% 100%',
                } : {}),
              }}
            >
              <img
                src={selectedStyle.imageSrc}
                alt={selectedStyle.name}
                className="absolute inset-0 w-full h-full object-cover pointer-events-none"
                style={{ objectPosition: selectedStyle.position }}
              />
            </div>
          )}

          {/* AI analysis loading overlay */}
          <AnimatePresence>
            {isAnalyzing && (
              <motion.div
                key="analyzing"
                className="absolute inset-0 flex flex-col items-center justify-center gap-4"
                style={{ background: 'rgba(5,3,2,0.72)', backdropFilter: 'blur(4px)' }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <div style={{ fontSize: 32, opacity: 0.6 }}>✂</div>
                <p className="text-sm tracking-[0.18em]" style={{ color: 'rgba(201,162,74,0.72)', fontFamily: SERIF }}>
                  髪型を認識中...
                </p>
                <div className="flex gap-2">
                  {[0, 1, 2].map((i) => (
                    <motion.div
                      key={i}
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ background: '#C9A24A' }}
                      animate={{ opacity: [0.25, 1, 0.25] }}
                      transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.22 }}
                    />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Drag hint */}
          {!isAnalyzing && (
            <div
              className="absolute top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 pointer-events-none"
              style={{ background: 'rgba(5,3,2,0.68)', border: '1px solid rgba(201,162,74,0.22)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
            >
              <p className="text-[9px] tracking-[0.18em]" style={{ color: 'rgba(201,162,74,0.60)' }}>
                ドラッグで位置調整
              </p>
            </div>
          )}
        </div>

        {/* Scale controls */}
        <div
          className="flex-shrink-0 flex items-center justify-center gap-4 py-2.5"
          style={{ borderTop: '1px solid rgba(201,162,74,0.08)', background: 'rgba(5,3,2,0.97)' }}
        >
          <button
            type="button"
            onClick={() => setOverlayScale(s => Math.max(0.3, Math.round((s - 0.1) * 10) / 10))}
            className="flex items-center justify-center rounded-full active:opacity-60"
            style={{ width: 36, height: 36, background: 'rgba(201,162,74,0.08)', border: '1px solid rgba(201,162,74,0.20)', color: 'rgba(201,162,74,0.72)' }}
          >
            <ZoomOut size={16} />
          </button>
          <p className="text-xs font-bold tabular-nums w-10 text-center" style={{ color: 'rgba(201,162,74,0.56)' }}>
            {Math.round(overlayScale * 100)}%
          </p>
          <button
            type="button"
            onClick={() => setOverlayScale(s => Math.min(2.5, Math.round((s + 0.1) * 10) / 10))}
            className="flex items-center justify-center rounded-full active:opacity-60"
            style={{ width: 36, height: 36, background: 'rgba(201,162,74,0.08)', border: '1px solid rgba(201,162,74,0.20)', color: 'rgba(201,162,74,0.72)' }}
          >
            <ZoomIn size={16} />
          </button>
          <div style={{ width: 1, height: 20, background: 'rgba(201,162,74,0.14)' }} />
          <button
            type="button"
            onClick={() => { setOverlayPos({ x: 0, y: 0 }); setOverlayScale(1.0) }}
            className="text-[10px] tracking-[0.12em] active:opacity-60"
            style={{ color: 'rgba(201,162,74,0.38)' }}
          >
            リセット
          </button>
        </div>

        {/* Action buttons */}
        <div
          className="flex-shrink-0 px-4 pb-5 pt-3 space-y-2.5"
          style={{ background: 'rgba(5,3,2,0.97)' }}
        >
          <div className="flex gap-2.5">
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={handleSaveShare}
              className="flex-1 flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold tracking-[0.16em]"
              style={{ background: 'rgba(201,162,74,0.08)', border: '1px solid rgba(201,162,74,0.32)', color: 'rgba(201,162,74,0.84)' }}
            >
              <Share2 size={15} />
              保存 / シェア
            </motion.button>
            {reserveUrl && (
              <motion.button
                type="button"
                whileTap={{ scale: 0.97 }}
                onClick={() => window.open(reserveUrl, '_blank', 'noopener,noreferrer')}
                className="flex-1 rounded-xl py-3 text-sm font-bold tracking-[0.18em]"
                style={{ background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)', border: '1px solid rgba(201,162,74,0.44)', color: '#F2E6C8', fontFamily: SERIF, boxShadow: '0 4px 20px rgba(107,15,18,0.44)' }}
              >
                このスタイルで予約
              </motion.button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setPhase('setup')}
            className="w-full text-center text-[11px] tracking-[0.14em] py-1 active:opacity-60"
            style={{ color: 'rgba(201,162,74,0.34)' }}
          >
            スタイルを選び直す
          </button>
        </div>
      </div>
    )
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SETUP PHASE
  ══════════════════════════════════════════════════════════════════════════ */
  return (
    <div className="py-5 pb-10 space-y-8">
      <div className="px-5">
        <p className="text-[8px] tracking-[0.32em] uppercase mb-1" style={{ color: 'rgba(201,162,74,0.44)' }}>OTOKOMAE TRY-ON</p>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF, letterSpacing: '0.06em', lineHeight: 1.1 }}>
          男前試着室
        </h1>
        <p className="text-[11px] mt-1" style={{ color: 'rgba(201,162,74,0.36)' }}>
          AIが髪型だけを自動認識して重ねます
        </p>
      </div>

      {/* Hidden file inputs */}
      <input ref={fileInputRef}   type="file" accept="image/*"           className="hidden" onChange={handleFileChange} />
      <input ref={cameraInputRef} type="file" accept="image/*" capture="user" className="hidden" onChange={handleFileChange} />

      {/* Step 1: Photo */}
      <div className="px-5">
        <StepLabel n={1} label="顔写真を選ぶ" />
        <div className="mt-3">
          {photoUrl ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              className="relative rounded-xl overflow-hidden"
              style={{ height: 220, border: '1px solid rgba(201,162,74,0.28)', boxShadow: '0 8px 40px rgba(0,0,0,0.55)' }}
            >
              <img src={photoUrl} alt="アップロードした写真" className="absolute inset-0 w-full h-full object-cover" style={{ objectPosition: 'center top' }} />
              <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(180deg, transparent 52%, rgba(5,3,2,0.84) 100%)' }} />
              <div className="absolute top-3 right-3 flex items-center justify-center rounded-full" style={{ width: 22, height: 22, background: 'linear-gradient(135deg, #C9A24A, #8B6510)', boxShadow: '0 0 10px rgba(201,162,74,0.40)' }}>
                <Check size={12} strokeWidth={2.5} style={{ color: '#0A0504' }} />
              </div>
              <div className="absolute bottom-0 left-0 right-0 px-4 pb-4 flex gap-2">
                <button type="button" onClick={() => cameraInputRef.current?.click()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg active:opacity-60" style={{ background: 'rgba(5,3,2,0.65)', border: '1px solid rgba(201,162,74,0.30)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
                  <Camera size={12} strokeWidth={2} style={{ color: 'rgba(201,162,74,0.78)' }} />
                  <span className="text-[11px] font-bold tracking-[0.14em]" style={{ color: 'rgba(201,162,74,0.78)' }}>撮影</span>
                </button>
                <button type="button" onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg active:opacity-60" style={{ background: 'rgba(5,3,2,0.65)', border: '1px solid rgba(201,162,74,0.30)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
                  <ImagePlus size={12} strokeWidth={2} style={{ color: 'rgba(201,162,74,0.78)' }} />
                  <span className="text-[11px] font-bold tracking-[0.14em]" style={{ color: 'rgba(201,162,74,0.78)' }}>ギャラリー</span>
                </button>
              </div>
            </motion.div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <button type="button" onClick={() => cameraInputRef.current?.click()} className="rounded-xl flex flex-col items-center gap-3 py-7 active:opacity-75 transition-opacity" style={{ background: 'linear-gradient(145deg, rgba(22,9,7,0.94), rgba(10,5,4,0.98))', border: '1px solid rgba(201,162,74,0.18)' }}>
                <div className="flex items-center justify-center rounded-full" style={{ width: 44, height: 44, background: 'linear-gradient(145deg, rgba(201,162,74,0.09), rgba(107,15,18,0.07))', border: '1px solid rgba(201,162,74,0.17)' }}>
                  <Camera size={20} strokeWidth={1.5} style={{ color: 'rgba(201,162,74,0.60)' }} />
                </div>
                <div className="text-center">
                  <p style={{ fontSize: 13, fontWeight: 700, color: 'rgba(242,230,200,0.76)', fontFamily: SERIF }}>カメラで撮影</p>
                  <p className="mt-0.5 text-[10px]" style={{ color: 'rgba(201,162,74,0.30)' }}>今すぐ撮る</p>
                </div>
              </button>
              <button type="button" onClick={() => fileInputRef.current?.click()} className="rounded-xl flex flex-col items-center gap-3 py-7 active:opacity-75 transition-opacity" style={{ background: 'linear-gradient(145deg, rgba(22,9,7,0.94), rgba(10,5,4,0.98))', border: '1px solid rgba(201,162,74,0.18)' }}>
                <div className="flex items-center justify-center rounded-full" style={{ width: 44, height: 44, background: 'linear-gradient(145deg, rgba(201,162,74,0.09), rgba(107,15,18,0.07))', border: '1px solid rgba(201,162,74,0.17)' }}>
                  <ImagePlus size={20} strokeWidth={1.5} style={{ color: 'rgba(201,162,74,0.60)' }} />
                </div>
                <div className="text-center">
                  <p style={{ fontSize: 13, fontWeight: 700, color: 'rgba(242,230,200,0.76)', fontFamily: SERIF }}>ギャラリー</p>
                  <p className="mt-0.5 text-[10px]" style={{ color: 'rgba(201,162,74,0.30)' }}>写真を選ぶ</p>
                </div>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Step 2: Style selector */}
      <div>
        <div className="px-5 mb-3"><StepLabel n={2} label="スタイルを選ぶ" /></div>
        <div className="flex gap-3 overflow-x-auto [&::-webkit-scrollbar]:hidden" style={{ paddingLeft: 20, paddingRight: 20, paddingBottom: 4, scrollbarWidth: 'none', scrollSnapType: 'x mandatory' } as React.CSSProperties}>
          {STYLES.map((style) => {
            const isSel = selectedId === style.id
            return (
              <motion.button
                key={style.id}
                type="button"
                onClick={() => handleSelectStyle(style.id)}
                whileTap={{ scale: 0.95 }}
                className="flex-shrink-0 rounded-xl overflow-hidden relative"
                style={{ width: 100, height: 148, scrollSnapAlign: 'start', border: isSel ? '1.5px solid rgba(201,162,74,0.66)' : '1px solid rgba(201,162,74,0.14)', boxShadow: isSel ? '0 0 24px rgba(201,162,74,0.14)' : 'none', background: '#0A0504' } as React.CSSProperties}
              >
                {style.imageSrc
                  ? <img src={style.imageSrc} alt={style.name} className="absolute inset-0 w-full h-full object-cover" style={{ objectPosition: style.position }} />
                  : <div className="absolute inset-0" style={{ background: 'linear-gradient(145deg, #1A0A08, #0A0504)' }} />
                }
                <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(180deg, rgba(5,3,2,0.0) 38%, rgba(5,3,2,0.90) 100%)' }} />
                {isSel && (
                  <div className="absolute top-2 right-2 flex items-center justify-center rounded-full" style={{ width: 18, height: 18, background: 'linear-gradient(135deg, #C9A24A, #8B6510)', boxShadow: '0 0 8px rgba(201,162,74,0.44)' }}>
                    <Check size={10} strokeWidth={2.5} style={{ color: '#0A0504' }} />
                  </div>
                )}
                <div className="absolute bottom-0 left-0 right-0 px-2 pb-2.5 text-center">
                  <p style={{ fontSize: 10, fontWeight: 700, color: isSel ? '#F2E6C8' : 'rgba(242,230,200,0.62)', fontFamily: SERIF, letterSpacing: '0.04em', textShadow: '0 1px 8px rgba(0,0,0,0.90)', lineHeight: 1.3 }}>
                    {style.name}
                  </p>
                </div>
              </motion.button>
            )
          })}
        </div>
      </div>

      {/* Step 3: Preview card */}
      <AnimatePresence>
        {selectedId && (
          <motion.div key="preview" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.25 }} className="px-5">
            <StepLabel n={3} label="男前を確認する" />
            <div className="mt-3 rounded-xl p-4 flex items-center gap-4" style={{ background: 'linear-gradient(145deg, rgba(22,9,7,0.94), rgba(10,5,4,0.98))', border: '1px solid rgba(201,162,74,0.14)' }}>
              {selectedStyle?.imageSrc && (
                <div className="flex-shrink-0 rounded-lg overflow-hidden" style={{ width: 56, height: 80, border: '1px solid rgba(201,162,74,0.18)' }}>
                  <img src={selectedStyle.imageSrc} alt={selectedStyle.name} className="w-full h-full object-cover" style={{ objectPosition: selectedStyle.position }} />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p style={{ fontSize: 9, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.40)', textTransform: 'uppercase', marginBottom: 5 }}>SELECTED STYLE</p>
                <p style={{ fontSize: 18, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF, letterSpacing: '0.06em' }}>{selectedStyle?.name}</p>
                {!photoUrl && <p className="mt-1.5 text-[10px]" style={{ color: 'rgba(201,162,74,0.32)' }}>顔写真を追加してください</p>}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* CTA */}
      <div className="px-5">
        <motion.button
          type="button"
          onClick={() => { if (canStart) setPhase('compose') }}
          disabled={!canStart}
          whileTap={canStart ? { scale: 0.98 } : {}}
          transition={{ duration: 0.15 }}
          className="w-full rounded-xl py-4 font-bold tracking-[0.3em]"
          style={{
            background: canStart ? 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)' : 'linear-gradient(145deg, rgba(22,9,7,0.48), rgba(10,5,4,0.68))',
            border: canStart ? '1px solid rgba(201,162,74,0.44)' : '1px solid rgba(201,162,74,0.09)',
            color: canStart ? '#F2E6C8' : 'rgba(242,230,200,0.24)',
            fontSize: 15, fontFamily: SERIF,
            boxShadow: canStart ? '0 4px 28px rgba(107,15,18,0.50)' : 'none',
            cursor: canStart ? 'pointer' : 'default',
          }}
        >
          {canStart ? '試着する' : !photoUrl ? '写真を選んでください' : 'スタイルを選んでください'}
        </motion.button>
      </div>

      <p className="text-center px-8 text-[10px]" style={{ color: 'rgba(201,162,74,0.20)' }}>
        正確な仕上がりは店頭でご相談ください。
      </p>
    </div>
  )
}
