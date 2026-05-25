import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { loadStyles } from '../utils/styleStorage'
import type { StyleCard } from '../data/styleCard'
import { STYLE_CATEGORY_LABELS, STYLE_CATEGORIES, STATS_KEYS, STATS_LABELS } from '../data/styleCard'
import type { NavTab } from '../data/brand'

interface Props {
  onTabChange: (tab: NavTab) => void
}

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

// ─── Sub-components ──────────────────────────────────────────────────────────

function HeroCard({ style, onTap }: { style: StyleCard; onTap: () => void }) {
  return (
    <div
      className="relative w-full cursor-pointer overflow-hidden"
      style={{ height: '58dvh', minHeight: 300 }}
      onClick={onTap}
    >
      {style.imageUrl ? (
        <img
          src={style.imageUrl}
          alt={style.title}
          className="absolute inset-0 w-full h-full"
          style={{ objectFit: 'cover', objectPosition: 'center bottom' }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center" style={{ background: '#1A0E0C' }}>
          <span style={{ fontSize: 64, opacity: 0.12 }}>✂</span>
        </div>
      )}

      {/* Gradient overlay */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(180deg, rgba(5,3,2,0.14) 0%, transparent 28%, rgba(5,3,2,0.55) 58%, rgba(5,3,2,0.97) 100%)',
        }}
      />

      {/* Featured badge */}
      {style.isFeatured && (
        <div className="absolute top-4 left-4">
          <span
            className="rounded px-2 py-0.5 text-[9px] font-bold tracking-[0.2em] uppercase"
            style={{
              background: 'rgba(201,162,74,0.14)',
              border: '1px solid rgba(201,162,74,0.36)',
              color: '#C9A24A',
            }}
          >
            おすすめ
          </span>
        </div>
      )}

      {/* Content */}
      <div className="absolute bottom-0 left-0 right-0 px-5 pb-5">
        <span
          className="inline-block rounded px-2 py-0.5 text-[9px] font-bold tracking-[0.16em] uppercase mb-2"
          style={{
            background: 'rgba(107,15,18,0.72)',
            color: '#F2E6C8',
            border: '1px solid rgba(180,50,50,0.38)',
          }}
        >
          {STYLE_CATEGORY_LABELS[style.category]}
        </span>
        <h2
          className="text-2xl font-bold leading-tight mb-1"
          style={{ color: '#F2E6C8', fontFamily: SERIF, textShadow: '0 2px 16px rgba(0,0,0,0.9)' }}
        >
          {style.title}
        </h2>
        {style.catchCopy && (
          <p
            className="text-[12px] mb-3 line-clamp-2"
            style={{ color: 'rgba(242,230,200,0.66)', textShadow: '0 1px 8px rgba(0,0,0,0.8)' }}
          >
            {style.catchCopy}
          </p>
        )}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onTap() }}
          className="rounded-xl px-5 py-2.5 text-sm font-bold tracking-widest transition-opacity active:opacity-70"
          style={{
            background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
            border: '1px solid rgba(201,162,74,0.44)',
            color: '#F2E6C8',
            boxShadow: '0 4px 20px rgba(107,15,18,0.55)',
          }}
        >
          この男になる
        </button>
      </div>
    </div>
  )
}

function PosterCard({ style, onTap }: { style: StyleCard; onTap: () => void }) {
  return (
    <div
      className="flex-shrink-0 cursor-pointer"
      style={{ width: 130, scrollSnapAlign: 'start' } as React.CSSProperties}
      onClick={onTap}
    >
      <div
        className="rounded-xl overflow-hidden relative"
        style={{
          width: 130,
          height: 186,
          background: '#1A0E0C',
          border: '1px solid rgba(201,162,74,0.16)',
        }}
      >
        {style.imageUrl ? (
          <img
            src={style.imageUrl}
            alt={style.title}
            className="w-full h-full"
            style={{ objectFit: 'cover', objectPosition: 'center bottom' }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span style={{ fontSize: 36, opacity: 0.18 }}>✂</span>
          </div>
        )}
        <div
          className="absolute inset-x-0 bottom-0"
          style={{
            height: '55%',
            background: 'linear-gradient(180deg, transparent, rgba(5,3,2,0.88))',
          }}
        />
        {style.isFeatured && (
          <div
            className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full"
            style={{ background: '#C9A24A', boxShadow: '0 0 6px rgba(201,162,74,0.5)' }}
          />
        )}
      </div>
      <p
        className="mt-2 text-[12px] font-medium leading-tight"
        style={{
          color: 'rgba(242,230,200,0.8)',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        } as React.CSSProperties}
      >
        {style.title}
      </p>
      <p className="text-[10px] mt-0.5" style={{ color: 'rgba(201,162,74,0.48)' }}>
        ¥{style.price.toLocaleString()}
      </p>
    </div>
  )
}

function CategoryLane({
  category,
  styles,
  onTap,
}: {
  category: string
  styles: StyleCard[]
  onTap: (s: StyleCard) => void
}) {
  return (
    <div className="space-y-3">
      <div className="px-5 flex items-center justify-between">
        <p className="text-sm font-bold tracking-wider" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
          {category}
        </p>
        <span className="text-[10px] tracking-[0.14em] uppercase" style={{ color: 'rgba(201,162,74,0.42)' }}>
          {styles.length} styles
        </span>
      </div>
      <div
        className="flex gap-3 overflow-x-auto [&::-webkit-scrollbar]:hidden"
        style={{
          scrollSnapType: 'x mandatory',
          paddingLeft: 20,
          paddingRight: 20,
          paddingBottom: 4,
          scrollbarWidth: 'none',
        } as React.CSSProperties}
      >
        {styles.map((s) => (
          <PosterCard key={s.id} style={s} onTap={() => onTap(s)} />
        ))}
      </div>
    </div>
  )
}

function StatBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex-shrink-0 text-[11px]" style={{ width: '5.5rem', color: 'rgba(201,162,74,0.65)' }}>
        {label}
      </span>
      <div
        className="flex-1 rounded-full overflow-hidden"
        style={{ height: 5, background: 'rgba(201,162,74,0.1)' }}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${(value / 5) * 100}%`,
            background: 'linear-gradient(90deg, #6B0F12, #C9A24A)',
            boxShadow: '0 0 6px rgba(201,162,74,0.26)',
            transition: 'width 0.7s ease',
          }}
        />
      </div>
      <span className="flex-shrink-0 w-3 text-right text-[11px]" style={{ color: 'rgba(201,162,74,0.52)' }}>
        {value}
      </span>
    </div>
  )
}

function DetailModal({
  style,
  onClose,
  onReserve,
}: {
  style: StyleCard
  onClose: () => void
  onReserve: () => void
}) {
  return (
    <>
      <motion.div
        className="fixed inset-0 z-50"
        style={{ background: 'rgba(0,0,0,0.72)' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.div
        className="fixed inset-x-0 bottom-0 z-50 overflow-y-auto"
        style={{
          maxHeight: '90dvh',
          background: 'linear-gradient(180deg, #150B0A 0%, #0A0504 100%)',
          borderRadius: '20px 20px 0 0',
          border: '1px solid rgba(201,162,74,0.22)',
          borderBottom: 'none',
          boxShadow: '0 -24px 60px rgba(0,0,0,0.6)',
        }}
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-0.5">
          <div className="w-9 h-1 rounded-full" style={{ background: 'rgba(201,162,74,0.24)' }} />
        </div>

        {/* Close */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-4 p-1.5 rounded-full transition-opacity active:opacity-60"
          style={{ background: 'rgba(201,162,74,0.1)', color: 'rgba(201,162,74,0.62)' }}
          aria-label="閉じる"
        >
          <X size={15} />
        </button>

        {/* Image */}
        {style.imageUrl && (
          <div
            className="mx-4 mt-3 rounded-xl overflow-hidden"
            style={{ height: 200, border: '1px solid rgba(201,162,74,0.12)' }}
          >
            <img
              src={style.imageUrl}
              alt={style.title}
              className="w-full h-full"
              style={{ objectFit: 'cover', objectPosition: 'center bottom' }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          </div>
        )}

        <div className="px-5 pt-4 pb-8 space-y-4">
          {/* Title */}
          <div>
            <span
              className="inline-block rounded px-2 py-0.5 text-[9px] font-bold tracking-[0.16em] uppercase mb-2"
              style={{
                background: 'rgba(107,15,18,0.65)',
                color: '#F2E6C8',
                border: '1px solid rgba(180,50,50,0.32)',
              }}
            >
              {STYLE_CATEGORY_LABELS[style.category]}
            </span>
            <h3 className="text-xl font-bold leading-snug" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
              {style.title}
            </h3>
            {style.catchCopy && (
              <p className="text-[12px] mt-1.5 leading-relaxed" style={{ color: 'rgba(201,162,74,0.7)' }}>
                {style.catchCopy}
              </p>
            )}
          </div>

          {/* Price + duration */}
          <div className="flex items-center gap-5">
            <div>
              <p className="text-[9px] tracking-[0.18em] uppercase mb-0.5" style={{ color: 'rgba(201,162,74,0.44)' }}>
                Price
              </p>
              <p className="text-lg font-bold" style={{ color: '#F2E6C8' }}>
                ¥{style.price.toLocaleString()}
              </p>
            </div>
            {style.durationMinutes > 0 && (
              <>
                <div style={{ width: 1, height: 28, background: 'rgba(201,162,74,0.14)' }} />
                <div>
                  <p className="text-[9px] tracking-[0.18em] uppercase mb-0.5" style={{ color: 'rgba(201,162,74,0.44)' }}>
                    Time
                  </p>
                  <p className="text-lg font-bold" style={{ color: '#F2E6C8' }}>
                    {style.durationMinutes}
                    <span className="text-sm ml-0.5" style={{ color: 'rgba(242,230,200,0.56)' }}>分</span>
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Description */}
          {style.description && (
            <p className="text-sm leading-relaxed" style={{ color: 'rgba(242,230,200,0.58)' }}>
              {style.description}
            </p>
          )}

          {/* Tags */}
          {style.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {style.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full px-2.5 py-1 text-[10px] tracking-[0.1em]"
                  style={{
                    background: 'rgba(201,162,74,0.08)',
                    color: 'rgba(201,162,74,0.62)',
                    border: '1px solid rgba(201,162,74,0.17)',
                  }}
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {/* Stats */}
          <div
            className="rounded-xl px-4 py-4 space-y-2.5"
            style={{ background: 'rgba(201,162,74,0.03)', border: '1px solid rgba(201,162,74,0.1)' }}
          >
            <p
              className="text-[9px] tracking-[0.22em] uppercase mb-3"
              style={{ color: 'rgba(201,162,74,0.44)' }}
            >
              スタイル特性
            </p>
            {STATS_KEYS.map((key) => (
              <StatBar key={key} label={STATS_LABELS[key]} value={style.stats[key]} />
            ))}
          </div>

          {/* CTA */}
          <button
            type="button"
            onClick={onReserve}
            className="w-full rounded-xl py-4 text-sm font-bold tracking-[0.24em] transition-opacity active:opacity-70"
            style={{
              background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
              border: '1px solid rgba(201,162,74,0.44)',
              color: '#F2E6C8',
              boxShadow: '0 4px 24px rgba(107,15,18,0.45), inset 0 1px 0 rgba(242,230,200,0.06)',
            }}
          >
            この男になる
          </button>
        </div>
      </motion.div>
    </>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center px-8 py-24 text-center">
      <div style={{ fontSize: 48, opacity: 0.16 }}>✂</div>
      <p className="mt-4 text-sm font-bold" style={{ color: 'rgba(242,230,200,0.44)', fontFamily: SERIF }}>
        スタイルは準備中です
      </p>
      <p className="mt-2 text-[11px]" style={{ color: 'rgba(201,162,74,0.36)' }}>
        もうしばらくお待ちください
      </p>
    </div>
  )
}

// ─── Main screen ─────────────────────────────────────────────────────────────

export function StyleLibraryScreen({ onTabChange }: Props) {
  const [styles] = useState(() =>
    loadStyles()
      .filter((s) => s.isPublished)
      .sort((a, b) => a.sortOrder - b.sortOrder),
  )
  const [selectedStyle, setSelectedStyle] = useState<StyleCard | null>(null)

  const hero = styles.find((s) => s.isFeatured) ?? styles[0] ?? null
  const laneCategories = STYLE_CATEGORIES.filter((cat) => styles.some((s) => s.category === cat))

  return (
    <div className="pb-10">
      {/* Header */}
      <div className="px-5 pt-4 pb-3">
        <p
          className="text-[10px] tracking-[0.24em] uppercase"
          style={{ color: 'rgba(201,162,74,0.54)' }}
        >
          Style Library
        </p>
        <h1 className="text-2xl font-bold" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
          男前スタイル図鑑
        </h1>
        {styles.length > 0 && (
          <p className="text-[11px] mt-0.5" style={{ color: 'rgba(201,162,74,0.42)' }}>
            {styles.length} スタイル収録
          </p>
        )}
      </div>

      {styles.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-6">
          {/* Hero card */}
          {hero && <HeroCard style={hero} onTap={() => setSelectedStyle(hero)} />}

          {/* Category lanes */}
          {laneCategories.map((cat) => (
            <CategoryLane
              key={cat}
              category={STYLE_CATEGORY_LABELS[cat]}
              styles={styles.filter((s) => s.category === cat)}
              onTap={setSelectedStyle}
            />
          ))}
        </div>
      )}

      {/* Detail modal */}
      <AnimatePresence>
        {selectedStyle && (
          <DetailModal
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
