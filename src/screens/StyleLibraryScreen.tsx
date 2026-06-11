import { useState, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { loadStyles } from '../utils/styleStorage'
import { StyleCardImage } from '../components/StyleCardPlaceholder'
import { StyleDetailModal } from '../components/StyleDetailModal'
import { resolveStyleImageUrl, resolveStyleImagePosition } from '../data/styleImages'
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

// ── Image helpers (unchanged) ─────────────────────────────────────────────────

function getCardImgStyle(style: StyleCard): React.CSSProperties {
  if (style.title === 'トラック野郎御用達') {
    return { objectFit: 'contain', objectPosition: 'center center', transform: 'scale(0.94)' }
  }
  return { objectFit: 'cover', objectPosition: resolveStyleImagePosition(style) }
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
        imgStyle={{ objectFit: 'cover', objectPosition: resolveStyleImagePosition(style) }}
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
            fontSize: 8, letterSpacing: '0.28em',
            color: 'rgba(201,162,74,0.72)', marginBottom: 5,
          }}
        >
          FEATURED
        </p>
        <h2
          style={{
            fontFamily: SERIF, fontSize: 28, fontWeight: 700,
            color: '#F2E6C8', lineHeight: 1.12, marginBottom: 6,
            textShadow: '0 2px 20px rgba(0,0,0,0.8)',
          }}
        >
          {style.title}
        </h2>
        {style.catchCopy && (
          <p
            style={{
              fontSize: 11, color: 'rgba(242,230,200,0.56)',
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
            fontFamily: SERIF, fontSize: 12, fontWeight: 700,
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
            fontFamily: SERIF, fontSize: 12, fontWeight: 700,
            color: '#F2E6C8', lineHeight: 1.22,
            textShadow: '0 1px 8px rgba(0,0,0,0.95)',
          }}
        >
          {style.title}
        </p>
        <p style={{ fontSize: 10, color: 'rgba(201,162,74,0.84)', marginTop: 3 }}>
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
            fontFamily: SERIF, fontSize: 18, fontWeight: 700,
            color: '#F2E6C8', letterSpacing: '0.04em',
          }}
        >
          {id}
        </h2>
        <span
          style={{
            fontSize: 7.5, letterSpacing: '0.24em',
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

// ── Main screen ───────────────────────────────────────────────────────────────

export function StyleLibraryScreen({ onTabChange, onModalChange }: Props) {
  const [styles] = useState(() =>
    loadStyles()
      .filter((s) => s.isPublished)
      .sort((a, b) => a.sortOrder - b.sortOrder),
  )
  const [selectedStyle, setSelectedStyle] = useState<StyleCard | null>(null)

  useEffect(() => {
    onModalChange?.(selectedStyle !== null)
  }, [selectedStyle, onModalChange])

  // Random pick from featured for variety on each visit
  const [heroStyle] = useState<StyleCard | null>(() => {
    const featured = styles.filter((s) => s.isFeatured)
    const pool = featured.length > 0 ? featured : styles
    return pool[Math.floor(Math.random() * pool.length)] ?? null
  })

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
        <p
          style={{
            fontSize: 8, letterSpacing: '0.30em',
            color: 'rgba(201,162,74,0.50)', marginBottom: 3,
          }}
        >
          STYLE LIBRARY
        </p>
        <h1
          style={{
            fontFamily: SERIF, fontSize: 26, fontWeight: 700,
            color: '#F2E6C8', letterSpacing: '0.04em',
          }}
        >
          男前スタイル図鑑
        </h1>
      </div>

      {/* Hero */}
      {heroStyle && (
        <LibraryHero
          style={heroStyle}
          onTap={() => setSelectedStyle(heroStyle)}
        />
      )}

      {/* Category rows */}
      <div style={{ paddingTop: 32 }}>
        {rows.map(({ id, sub, styles: rowStyles }) => (
          <StyleRow
            key={id}
            id={id}
            sub={sub}
            styles={rowStyles}
            onStyleSelect={setSelectedStyle}
          />
        ))}
      </div>

      {/* Style detail modal */}
      <AnimatePresence>
        {selectedStyle && (
          <StyleDetailModal
            key={selectedStyle.id}
            style={selectedStyle}
            onClose={() => setSelectedStyle(null)}
            onReserve={() => {
              setSelectedStyle(null)
              onTabChange('reserve')
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
