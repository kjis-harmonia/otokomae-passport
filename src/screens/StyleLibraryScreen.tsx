import { useState, useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronLeft } from 'lucide-react'
import { loadStyles } from '../utils/styleStorage'
import { StyleCardImage, StyleCardPlaceholder } from '../components/StyleCardPlaceholder'
import { resolveStyleImageUrl } from '../data/styleImages'
import { getReserveUrl } from '../data/reserveLinks'
import type { StyleCard } from '../data/styleCard'
import type { NavTab } from '../data/brand'

interface Props {
  onTabChange: (tab: NavTab) => void
  onModalChange?: (open: boolean) => void
}

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

const UI_CATEGORIES = [
  {
    id: '昭和の漢',
    sub: 'SHOWA MEN',
    titles: ['昭和のアイパー', 'カールアイパー', 'バチバチパンチパーマ', 'リーゼントパンチ', 'ちょい悪オヤジ専用 昭和ヘアスタイル'],
  },
  {
    id: '王道パーマ',
    sub: 'CLASSIC PERM',
    titles: ['俺は濡れパン', 'ジャマイカンアフロ', 'スペインパーマ', 'サラリーマン専用 ギリギリパーマ'],
  },
  {
    id: '威圧感MAX',
    sub: 'MAXIMUM PRESSURE',
    titles: ['極道ボウズ', 'トラック野郎御用達', 'テイテイ刈り', 'バチバチパンチパーマ', 'シンサイパンチ'],
  },
  {
    id: '季節限定',
    sub: 'SEASONAL',
    titles: ['夏ニグロ', '銀パラ', '覚醒の色'],
  },
] as const

// ── Image helpers ─────────────────────────────────────────────────────────────

function getCardImgStyle(_style: StyleCard): React.CSSProperties {
  return { objectFit: 'contain', objectPosition: 'center center' }
}

function getCardOverlay(style: StyleCard): string {
  const base = style.title === 'トラック野郎御用達' ? 'rgba(0,0,0' : 'rgba(5,3,2'
  return (
    `linear-gradient(to top,` +
    `${base},0.98) 0%,${base},0.85) 20%,${base},0.48) 42%,${base},0.08) 64%,transparent 80%)`
  )
}

// ── Hero billboard ────────────────────────────────────────────────────────────

function LibraryHero({ style, onTap }: { style: StyleCard; onTap: () => void }) {
  return (
    <motion.button
      type="button"
      onClick={onTap}
      whileTap={{ scale: 0.995 }}
      className="relative block w-full overflow-hidden focus:outline-none"
      style={{ height: '48dvh', background: '#070303' }}
    >
      <StyleCardImage
        src={resolveStyleImageUrl(style)}
        alt={style.title}
        className="absolute inset-0 w-full h-full"
        imgStyle={{ objectFit: 'contain', objectPosition: 'center' }}
        size="lg"
      />

      {/* Cinematic gradients */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: [
            'linear-gradient(to top,  rgba(5,3,2,0.97) 0%, rgba(5,3,2,0.72) 28%, rgba(5,3,2,0.08) 58%, transparent 76%)',
            'linear-gradient(to right, rgba(5,3,2,0.32) 0%, transparent 44%)',
          ].join(', '),
        }}
      />

      {/* Bottom content */}
      <div className="absolute bottom-0 left-0 right-0 px-5 pb-5">
        <p
          style={{
            fontSize: 9, letterSpacing: '0.28em',
            color: 'rgba(201,162,74,0.72)', marginBottom: 5,
          }}
        >
          FEATURED
        </p>
        <h2
          style={{
            fontFamily: SERIF, fontSize: 32, fontWeight: 700,
            color: '#F2E6C8', lineHeight: 1.12, marginBottom: 6,
            textShadow: '0 2px 20px rgba(0,0,0,0.8)',
          }}
        >
          {style.title}
        </h2>
        {style.catchCopy && (
          <p
            style={{
              fontSize: 13, color: 'rgba(242,230,200,0.56)',
              lineHeight: 1.6, marginBottom: 14,
              textShadow: '0 1px 8px rgba(0,0,0,0.9)',
            }}
          >
            {style.catchCopy}
          </p>
        )}
        <span
          style={{
            display: 'inline-flex', alignItems: 'center',
            padding: '9px 18px', borderRadius: 12,
            background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
            border: '1px solid rgba(201,162,74,0.44)',
            boxShadow: '0 3px 14px rgba(107,15,18,0.45)',
            fontFamily: SERIF, fontSize: 14, fontWeight: 700,
            letterSpacing: '0.18em', color: '#F2E6C8',
          }}
        >
          詳しく見る
        </span>
      </div>
    </motion.button>
  )
}

// ── Style thumbnail card ──────────────────────────────────────────────────────

function StyleThumb({
  style, onTap, index,
}: {
  style: StyleCard
  onTap: () => void
  index: number
}) {
  return (
    <motion.button
      type="button"
      onClick={onTap}
      whileTap={{ scale: 0.92 }}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.045, duration: 0.32, ease: [0.25, 0.46, 0.45, 0.94] }}
      style={{
        flexShrink: 0,
        width: 'clamp(116px, 37vw, 155px)',
        aspectRatio: '2/3',
        borderRadius: 10,
        overflow: 'hidden',
        position: 'relative',
        background: '#0A0504',
        border: '1px solid rgba(201,162,74,0.13)',
        boxShadow: '0 4px 18px rgba(0,0,0,0.5)',
        cursor: 'pointer',
      }}
    >
      <StyleCardImage
        src={resolveStyleImageUrl(style)}
        alt={style.title}
        className="absolute inset-0 w-full h-full"
        imgStyle={getCardImgStyle(style)}
        size="md"
      />
      <div className="absolute inset-0 pointer-events-none" style={{ background: getCardOverlay(style) }} />
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '0 9px 10px' }}>
        <p
          style={{
            fontFamily: SERIF, fontSize: 14, fontWeight: 700,
            color: '#F2E6C8', lineHeight: 1.22,
            textShadow: '0 1px 8px rgba(0,0,0,0.95)',
          }}
        >
          {style.title}
        </p>
        <p style={{ fontSize: 12, color: 'rgba(201,162,74,0.84)', marginTop: 3 }}>
          ¥{style.price.toLocaleString()}
        </p>
      </div>
    </motion.button>
  )
}

// ── Category row ──────────────────────────────────────────────────────────────

function StyleRow({
  id, sub, styles, onStyleSelect,
}: {
  id: string
  sub: string
  styles: StyleCard[]
  onStyleSelect: (s: StyleCard) => void
}) {
  if (styles.length === 0) return null

  return (
    <motion.div
      style={{ marginBottom: 36 }}
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.4 }}
    >
      {/* Row header */}
      <div
        style={{
          display: 'flex', alignItems: 'baseline', gap: 8,
          padding: '0 16px 12px',
        }}
      >
        <h2
          style={{
            fontFamily: SERIF, fontSize: 21, fontWeight: 700,
            color: '#F2E6C8', letterSpacing: '0.04em',
          }}
        >
          {id}
        </h2>
        <span
          style={{
            fontSize: 9, letterSpacing: '0.24em',
            color: 'rgba(201,162,74,0.58)', fontWeight: 700,
          }}
        >
          {sub}
        </span>
        <div
          style={{
            height: '0.5px', flex: 1,
            background: 'linear-gradient(90deg, rgba(201,162,74,0.18), transparent)',
          }}
        />
      </div>

      {/* Horizontal scroll strip */}
      <div
        className="[&::-webkit-scrollbar]:hidden"
        style={{
          display: 'flex',
          gap: 10,
          overflowX: 'scroll',
          paddingLeft: 16,
          paddingRight: 32,
          scrollbarWidth: 'none',
          WebkitOverflowScrolling: 'touch',
        } as React.CSSProperties}
      >
        {styles.map((style, i) => (
          <StyleThumb
            key={style.id}
            style={style}
            index={i}
            onTap={() => onStyleSelect(style)}
          />
        ))}
      </div>
    </motion.div>
  )
}

// ── ReserveSheet (横スワイプで呼び出す予約シート) ─────────────────────────────

function ReserveSheet({
  style,
  onClose,
}: {
  style: StyleCard
  onClose: () => void
}) {
  const reserveUrl = getReserveUrl(style.title)
  const imgUrl = resolveStyleImageUrl(style)

  return (
    <>
      {/* Backdrop */}
      <motion.div
        className="absolute inset-0"
        style={{ background: 'rgba(0,0,0,0.6)', zIndex: 140 }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      {/* Sheet */}
      <motion.div
        className="absolute left-0 right-0 bottom-0"
        style={{
          zIndex: 150,
          background: 'linear-gradient(180deg, #100604 0%, #0A0504 100%)',
          borderRadius: '20px 20px 0 0',
          border: '1px solid rgba(201,162,74,0.22)',
          borderBottom: 'none',
          boxShadow: '0 -24px 60px rgba(0,0,0,0.7)',
          padding: '28px 20px',
          paddingBottom: 'max(32px, env(safe-area-inset-bottom, 32px))',
        }}
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Style info row */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 24 }}>
          <div
            style={{
              width: 68, height: 90, borderRadius: 10,
              overflow: 'hidden', flexShrink: 0,
              background: '#050302',
              border: '1px solid rgba(201,162,74,0.14)',
            }}
          >
            <img
              src={imgUrl}
              alt={style.title}
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 8, letterSpacing: '0.26em', color: 'rgba(201,162,74,0.46)', marginBottom: 7 }}>
              STYLE RESERVATION
            </p>
            <h3
              style={{
                fontFamily: SERIF, fontSize: 22, fontWeight: 700,
                color: '#F2E6C8', lineHeight: 1.2, marginBottom: 5,
                letterSpacing: '0.04em',
              }}
            >
              {style.title}
            </h3>
            <p style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 700, color: '#C9A24A' }}>
              ¥{style.price.toLocaleString()}
            </p>
          </div>
        </div>

        {/* Divider */}
        <div style={{ height: '0.5px', background: 'rgba(201,162,74,0.12)', marginBottom: 24 }} />

        {/* Reserve button */}
        <motion.button
          type="button"
          onClick={() => {
            if (reserveUrl) window.open(reserveUrl, '_blank', 'noopener,noreferrer')
            onClose()
          }}
          style={{
            width: '100%', padding: '15px 0', borderRadius: 14,
            background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
            border: '1px solid rgba(201,162,74,0.44)',
            boxShadow: '0 4px 28px rgba(107,15,18,0.52)',
            fontFamily: SERIF, fontSize: 15, fontWeight: 700,
            letterSpacing: '0.22em', color: '#F2E6C8', cursor: 'pointer',
          }}
          whileTap={{ scale: 0.98 }}
          transition={{ duration: 0.13 }}
        >
          このスタイルで予約する
        </motion.button>

        {/* Cancel */}
        <button
          type="button"
          onClick={onClose}
          style={{
            width: '100%', marginTop: 12, padding: '10px 0',
            background: 'none', border: 'none',
            fontSize: 13, color: 'rgba(242,230,200,0.28)',
            letterSpacing: '0.1em', cursor: 'pointer',
          }}
        >
          キャンセル
        </button>
      </motion.div>
    </>
  )
}

// ── StyleReelView (TikTok / Reels 縦スワイプ全画面) ──────────────────────────

const REEL_VARIANTS = {
  enter: (d: number) => ({ y: d >= 0 ? '-100%' : '100%', opacity: 0.5 }),
  center: { y: 0, opacity: 1 },
  exit:  (d: number) => ({ y: d >= 0 ? '100%' : '-100%', opacity: 0.5 }),
}

function StyleReelView({
  styles,
  startIndex,
  onClose,
}: {
  styles: StyleCard[]
  startIndex: number
  onClose: () => void
}) {
  const [idx, setIdx]             = useState(startIndex)
  const [dir, setDir]             = useState(0)
  const [showReserveSheet, setShowReserveSheet] = useState(false)
  const touchStartY               = useRef<number | null>(null)
  const touchStartX               = useRef<number | null>(null)
  const touchStartTime            = useRef<number | null>(null)

  const style    = styles[idx]
  const imgUrl   = style ? resolveStyleImageUrl(style) : null
  const reserveUrl = style ? getReserveUrl(style.title) : null

  // Close reserve sheet when navigating to a new style
  useEffect(() => { setShowReserveSheet(false) }, [idx])

  function navigate(newDir: -1 | 1) {
    const next = idx + newDir
    if (next < 0 || next >= styles.length) return
    setDir(newDir)
    setIdx(next)
  }

  function onTouchStart(e: React.TouchEvent) {
    touchStartY.current    = e.touches[0].clientY
    touchStartX.current    = e.touches[0].clientX
    touchStartTime.current = Date.now()
  }

  function onTouchEnd(e: React.TouchEvent) {
    if (touchStartY.current === null || touchStartX.current === null) return
    const dy  = e.changedTouches[0].clientY - touchStartY.current
    const dx  = e.changedTouches[0].clientX - touchStartX.current
    const dt  = Date.now() - (touchStartTime.current ?? Date.now())
    const velY = Math.abs(dy) / Math.max(dt, 1)
    const velX = Math.abs(dx) / Math.max(dt, 1)

    // Determine dominant direction
    const isHorizontal = Math.abs(dx) > Math.abs(dy) * 1.2

    if (isHorizontal) {
      // Left swipe → open reserve sheet
      if (dx < -60 || (dx < 0 && velX > 0.4)) setShowReserveSheet(true)
    } else {
      if (dy < -50 || (dy < 0 && velY > 0.45))     navigate(-1) // swipe up → next
      else if (dy > 50 || (dy > 0 && velY > 0.45)) navigate(1)  // swipe down → prev
    }

    touchStartY.current    = null
    touchStartX.current    = null
    touchStartTime.current = null
  }

  if (!style) return null

  return (
    <motion.div
      className="fixed inset-0"
      style={{ zIndex: 100, background: '#050302', overflow: 'hidden' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      {/* Swipe area */}
      <div
        className="w-full h-full"
        style={{ touchAction: 'none', position: 'relative' }}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <AnimatePresence initial={false} custom={dir}>
          <motion.div
            key={idx}
            className="absolute inset-0"
            custom={dir}
            variants={REEL_VARIANTS}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: 'spring', stiffness: 340, damping: 34, mass: 0.9 }}
          >
            {/* Blurred background (fills dark bars) */}
            {imgUrl && (
              <div
                className="absolute inset-0"
                style={{
                  backgroundImage: `url(${imgUrl})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  filter: 'blur(26px) brightness(0.17)',
                  transform: 'scale(1.12)',
                }}
                aria-hidden
              />
            )}

            {/* Main image — full display, no cropping */}
            {imgUrl ? (
              <img
                src={imgUrl}
                alt={style.title}
                className="absolute inset-0 w-full h-full"
                style={{ objectFit: 'contain', objectPosition: 'center' }}
                draggable={false}
              />
            ) : (
              <StyleCardPlaceholder className="absolute inset-0" size="lg" />
            )}

            {/* Bottom gradient */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  'linear-gradient(to top, rgba(5,3,2,0.97) 0%, rgba(5,3,2,0.76) 22%, rgba(5,3,2,0.18) 50%, transparent 68%)',
              }}
            />

            {/* Bottom content */}
            <div
              className="absolute bottom-0 left-0 right-0"
              style={{
                padding: '0 20px',
                paddingBottom: 'max(28px, env(safe-area-inset-bottom, 28px))',
              }}
            >
              <p style={{ fontSize: 11, letterSpacing: '0.26em', color: 'rgba(201,162,74,0.6)', marginBottom: 8 }}>
                GINJIRO STYLE
              </p>
              <h2
                style={{
                  fontFamily: SERIF, fontSize: 32, fontWeight: 700,
                  color: '#F2E6C8', lineHeight: 1.15, marginBottom: 8,
                  letterSpacing: '0.04em', textShadow: '0 2px 20px rgba(0,0,0,0.8)',
                }}
              >
                {style.title}
              </h2>
              {style.catchCopy && (
                <p style={{ fontSize: 14, color: 'rgba(201,162,74,0.7)', fontStyle: 'italic', lineHeight: 1.5, marginBottom: 14 }}>
                  {style.catchCopy}
                </p>
              )}
              {style.tags.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 18 }}>
                  {style.tags.slice(0, 3).map(tag => (
                    <span
                      key={tag}
                      style={{
                        fontSize: 12, padding: '4px 12px', borderRadius: 99,
                        background: 'rgba(201,162,74,0.09)',
                        border: '1px solid rgba(201,162,74,0.24)',
                        color: 'rgba(242,230,200,0.6)',
                        letterSpacing: '0.06em',
                      }}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {/* Price + reserve */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flexShrink: 0 }}>
                  <p style={{ fontSize: 10, letterSpacing: '0.18em', color: 'rgba(201,162,74,0.46)', marginBottom: 2 }}>PRICE</p>
                  <p style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: '#C9A24A' }}>
                    ¥{style.price.toLocaleString()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (reserveUrl) window.open(reserveUrl, '_blank', 'noopener,noreferrer')
                  }}
                  style={{
                    flex: 1, padding: '15px 0', borderRadius: 14,
                    background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
                    border: '1px solid rgba(201,162,74,0.44)',
                    boxShadow: '0 4px 20px rgba(107,15,18,0.5)',
                    fontFamily: SERIF, fontSize: 16, fontWeight: 700,
                    letterSpacing: '0.2em', color: '#F2E6C8', cursor: 'pointer',
                  }}
                >
                  予約する
                </button>
              </div>
              {/* Nav counter + swipe hint */}
              <div
                style={{
                  display: 'flex', justifyContent: 'space-between',
                  alignItems: 'center', marginTop: 16,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                  {idx > 0 && (
                    <button type="button" onClick={() => navigate(1)}
                      style={{ background: 'none', border: 'none', padding: '4px 8px', color: 'rgba(242,230,200,0.35)', fontSize: 11, letterSpacing: '0.1em', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                      <span style={{ fontSize: 14, lineHeight: 1 }}>↑</span>
                      <span>前へ</span>
                    </button>
                  )}
                  <p style={{ fontSize: 12, color: 'rgba(201,162,74,0.35)', letterSpacing: '0.12em' }}>
                    {idx + 1} / {styles.length}
                  </p>
                  {idx < styles.length - 1 && (
                    <button type="button" onClick={() => navigate(-1)}
                      style={{ background: 'none', border: 'none', padding: '4px 8px', color: 'rgba(242,230,200,0.35)', fontSize: 11, letterSpacing: '0.1em', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                      <span>次へ</span>
                      <span style={{ fontSize: 14, lineHeight: 1 }}>↓</span>
                    </button>
                  )}
                </div>
                {/* 一覧に戻る */}
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    background: 'rgba(5,3,2,0.6)', border: '1px solid rgba(201,162,74,0.28)',
                    borderRadius: 99, padding: '7px 14px',
                    cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 5,
                    color: 'rgba(242,230,200,0.7)',
                    backdropFilter: 'blur(8px)',
                    WebkitBackdropFilter: 'blur(8px)',
                  }}
                >
                  <span style={{ fontSize: 14, lineHeight: 1 }}>←</span>
                  <span style={{ fontSize: 12, letterSpacing: '0.08em', fontWeight: 600 }}>一覧に戻る</span>
                </button>
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Reserve sheet — rendered above animated cards */}
      <AnimatePresence>
        {showReserveSheet && (
          <ReserveSheet
            key="reserve-sheet"
            style={style}
            onClose={() => setShowReserveSheet(false)}
          />
        )}
      </AnimatePresence>

      {/* Back button — fixed above all animated cards */}
      <button
        type="button"
        onClick={onClose}
        aria-label="戻る"
        style={{
          position: 'absolute',
          top: 'max(14px, env(safe-area-inset-top, 14px))',
          left: 14,
          zIndex: 200,
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '9px 16px 9px 10px',
          borderRadius: 99,
          background: 'rgba(5,3,2,0.72)',
          border: '1px solid rgba(201,162,74,0.32)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          color: '#F2E6C8', cursor: 'pointer',
          boxShadow: '0 2px 12px rgba(0,0,0,0.5)',
        }}
      >
        <ChevronLeft size={18} strokeWidth={2.5} />
        <span style={{ fontSize: 14, letterSpacing: '0.06em', fontWeight: 600, lineHeight: 1 }}>戻る</span>
      </button>
    </motion.div>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function StyleLibraryScreen({ onTabChange: _onTabChange, onModalChange }: Props) {
  const [styles] = useState(() =>
    loadStyles()
      .filter((s) => s.isPublished)
      .sort((a, b) => a.sortOrder - b.sortOrder),
  )
  const [reelIndex, setReelIndex] = useState<number | null>(null)

  useEffect(() => {
    onModalChange?.(reelIndex !== null)
  }, [reelIndex, onModalChange])

  const [heroStyle] = useState<StyleCard | null>(() => {
    const featured = styles.filter((s) => s.isFeatured)
    const pool = featured.length > 0 ? featured : styles
    return pool[Math.floor(Math.random() * pool.length)] ?? null
  })

  function openReel(style: StyleCard) {
    const i = styles.findIndex((s) => s.id === style.id)
    setReelIndex(i >= 0 ? i : 0)
  }

  const rows = UI_CATEGORIES.map(({ id, sub, titles }) => ({
    id,
    sub,
    styles: titles
      .map((t) => styles.find((s) => s.title === t))
      .filter((s): s is StyleCard => s !== undefined),
  }))

  return (
    <div style={{ paddingBottom: 40 }}>
      {/* Page header */}
      <div style={{ padding: '18px 16px 12px' }}>
        <p style={{ fontSize: 8, letterSpacing: '0.30em', color: 'rgba(201,162,74,0.50)', marginBottom: 3 }}>
          STYLE LIBRARY
        </p>
        <h1 style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, color: '#F2E6C8', letterSpacing: '0.04em' }}>
          男前スタイル図鑑
        </h1>
      </div>

      {/* Hero */}
      {heroStyle && (
        <LibraryHero style={heroStyle} onTap={() => openReel(heroStyle)} />
      )}

      {/* Category rows */}
      <div style={{ paddingTop: 32 }}>
        {rows.map(({ id, sub, styles: rowStyles }) => (
          <StyleRow key={id} id={id} sub={sub} styles={rowStyles} onStyleSelect={openReel} />
        ))}
      </div>

      {/* Full-screen reel */}
      <AnimatePresence>
        {reelIndex !== null && (
          <StyleReelView
            key="reel"
            styles={styles}
            startIndex={reelIndex}
            onClose={() => setReelIndex(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
