import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Lock } from 'lucide-react'
import { loadStyles } from '../utils/styleStorage'
import { useScrollLock } from '../utils/useScrollLock'
import { StyleCardImage } from '../components/StyleCardPlaceholder'
import type { StyleCard } from '../data/styleCard'
import { STYLE_CATEGORY_LABELS, STYLE_CATEGORIES, STATS_KEYS, STATS_LABELS } from '../data/styleCard'
import type { Member, NavTab } from '../data/brand'

interface Props {
  member: Member
  onTabChange: (tab: NavTab) => void
  onModalChange?: (open: boolean) => void
}

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

// ── Coming-soon mock data ─────────────────────────────────────────────────

const COMING_SOON = [
  { id: 'cs1', title: '極道フェード', date: '2026.07' },
  { id: 'cs2', title: '孤高の七三', date: '2026.07' },
  { id: 'cs3', title: '征服者パーマ', date: '2026.08' },
  { id: 'cs4', title: '黒龍クロップ', date: '2026.09' },
]

// ── Hero ──────────────────────────────────────────────────────────────────

function HeroSection({
  hero,
  memberName,
  onReserve,
  onDiagnosis,
  onTap,
}: {
  hero: StyleCard | null
  memberName: string
  onReserve: () => void
  onDiagnosis: () => void
  onTap: () => void
}) {
  const firstName = memberName.split(' ')[1] ?? memberName
  const bg = hero?.imageUrl ?? '/images/hero-ginjiro-app.webp'

  return (
    <div
      className="relative w-full overflow-hidden"
      style={{ height: '65dvh', minHeight: 400, cursor: hero ? 'pointer' : 'default' }}
      onClick={onTap}
    >
      {/* Background image */}
      <img
        src={bg}
        alt=""
        className="absolute inset-0 w-full h-full"
        style={{ objectFit: 'cover', objectPosition: 'center bottom' }}
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = 'none'
        }}
      />

      {/* Dark fill behind image (visible when image fails) */}
      <div className="absolute inset-0" style={{ background: '#080504', zIndex: 0 }} />

      {/* Gradient overlay — heavy top + heavy bottom, light in middle */}
      <div
        className="absolute inset-0"
        style={{
          zIndex: 1,
          background:
            'linear-gradient(180deg, rgba(5,3,2,0.68) 0%, rgba(5,3,2,0.0) 24%, rgba(5,3,2,0.0) 44%, rgba(5,3,2,0.68) 66%, rgba(5,3,2,0.98) 100%)',
        }}
      />

      {/* Top bar: logo + member name */}
      <div className="absolute top-0 left-0 right-0 flex items-start justify-between px-5 pt-5" style={{ zIndex: 2 }}>
        <div className="flex items-center gap-2.5">
          <span
            style={{
              fontSize: 20,
              color: '#C9A24A',
              textShadow: '0 0 14px rgba(201,162,74,0.55)',
              lineHeight: 1,
            }}
          >
            ✂
          </span>
          <div>
            <p className="text-[7px] tracking-[0.36em] uppercase" style={{ color: 'rgba(201,162,74,0.46)' }}>
              Premium Barber
            </p>
            <p
              className="text-base font-bold leading-none"
              style={{ color: '#F2E6C8', fontFamily: SERIF, textShadow: '0 1px 8px rgba(0,0,0,0.8)' }}
            >
              銀二郎
            </p>
          </div>
        </div>
        <p className="text-[10px] pt-1" style={{ color: 'rgba(201,162,74,0.44)' }}>
          {firstName} 様
        </p>
      </div>

      {/* Bottom content */}
      <div
        className="absolute bottom-0 left-0 right-0 px-5 pb-6"
        style={{ zIndex: 2 }}
        onClick={(e) => e.stopPropagation()}
      >
        {hero ? (
          <>
            <div className="flex items-center gap-2 mb-2">
              <span
                className="inline-block rounded px-2 py-0.5 text-[9px] font-bold tracking-[0.16em] uppercase"
                style={{
                  background: 'rgba(107,15,18,0.75)',
                  color: '#F2E6C8',
                  border: '1px solid rgba(180,50,50,0.42)',
                }}
              >
                {STYLE_CATEGORY_LABELS[hero.category]}
              </span>
              {hero.isFeatured && (
                <span
                  className="inline-block rounded px-2 py-0.5 text-[9px] font-bold tracking-[0.14em] uppercase"
                  style={{
                    background: 'rgba(201,162,74,0.14)',
                    color: '#C9A24A',
                    border: '1px solid rgba(201,162,74,0.32)',
                  }}
                >
                  おすすめ
                </span>
              )}
            </div>
            <h1
              className="text-[28px] font-bold leading-tight mb-1.5"
              style={{ color: '#F2E6C8', fontFamily: SERIF, textShadow: '0 2px 20px rgba(0,0,0,0.9)' }}
            >
              {hero.title}
            </h1>
            {hero.catchCopy && (
              <p
                className="text-[13px] mb-4 leading-relaxed line-clamp-2"
                style={{ color: 'rgba(242,230,200,0.64)', textShadow: '0 1px 8px rgba(0,0,0,0.8)' }}
              >
                {hero.catchCopy}
              </p>
            )}
          </>
        ) : (
          <>
            <p
              className="text-[10px] tracking-[0.3em] uppercase mb-2"
              style={{ color: 'rgba(201,162,74,0.5)' }}
            >
              Premium Barber Style
            </p>
            <h1
              className="text-[30px] font-bold leading-tight mb-4"
              style={{ color: '#F2E6C8', fontFamily: SERIF, textShadow: '0 2px 20px rgba(0,0,0,0.9)' }}
            >
              男前を、手に入れろ。
            </h1>
          </>
        )}

        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onReserve}
            className="flex-1 rounded-xl py-3.5 text-[13px] font-bold tracking-[0.16em] transition-opacity active:opacity-70"
            style={{
              background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 58%, #8B1A1A 100%)',
              border: '1px solid rgba(201,162,74,0.44)',
              color: '#F2E6C8',
              boxShadow: '0 4px 22px rgba(107,15,18,0.55), inset 0 1px 0 rgba(242,230,200,0.06)',
            }}
          >
            このスタイルにする
          </button>
          <button
            type="button"
            onClick={onDiagnosis}
            className="flex-1 rounded-xl py-3.5 text-[13px] font-bold tracking-[0.16em] transition-opacity active:opacity-70"
            style={{
              background: 'rgba(242,230,200,0.07)',
              border: '1px solid rgba(201,162,74,0.3)',
              color: 'rgba(242,230,200,0.82)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
            }}
          >
            男前診断
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Poster card ───────────────────────────────────────────────────────────

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
          border: '1px solid rgba(201,162,74,0.15)',
        }}
      >
        <StyleCardImage
          src={style.imageUrl}
          alt={style.title}
          className="w-full h-full"
          imgStyle={{ objectFit: 'cover', objectPosition: 'center bottom' }}
          size="sm"
        />
        <div
          className="absolute inset-x-0 bottom-0"
          style={{ height: '55%', background: 'linear-gradient(180deg, transparent, rgba(5,3,2,0.88))' }}
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
      <p className="text-[10px] mt-0.5" style={{ color: 'rgba(201,162,74,0.46)' }}>
        ¥{style.price.toLocaleString()}
      </p>
    </div>
  )
}

// ── Horizontal lane ───────────────────────────────────────────────────────

function Lane({
  title,
  badge,
  styles,
  onTap,
}: {
  title: string
  badge?: string
  styles: StyleCard[]
  onTap: (s: StyleCard) => void
}) {
  return (
    <div>
      <div className="px-5 mb-3.5 flex items-end gap-3">
        <p className="text-[17px] font-bold leading-none" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
          {title}
        </p>
        {badge && (
          <span
            className="rounded px-1.5 py-0.5 text-[8px] font-bold tracking-[0.16em] uppercase"
            style={{
              background: 'rgba(201,162,74,0.1)',
              border: '1px solid rgba(201,162,74,0.24)',
              color: 'rgba(201,162,74,0.65)',
            }}
          >
            {badge}
          </span>
        )}
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

// ── Coming soon ───────────────────────────────────────────────────────────

function ComingSoonCard({ item }: { item: { id: string; title: string; date: string } }) {
  return (
    <div
      className="flex-shrink-0 rounded-xl overflow-hidden relative"
      style={{
        width: 130,
        height: 186,
        background: 'linear-gradient(150deg, #1E0A0C, #0D0507)',
        border: '1px solid rgba(107,15,18,0.32)',
        scrollSnapAlign: 'start',
      } as React.CSSProperties}
    >
      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse at 50% 25%, rgba(107,15,18,0.3), transparent 68%)',
        }}
      />
      {/* COMING SOON badge */}
      <div className="absolute top-2.5 left-0 right-0 flex justify-center">
        <span
          className="rounded px-1.5 py-0.5 text-[7px] font-bold tracking-[0.14em] uppercase"
          style={{
            background: 'rgba(107,15,18,0.65)',
            border: '1px solid rgba(180,50,50,0.35)',
            color: 'rgba(242,230,200,0.6)',
          }}
        >
          Coming Soon
        </span>
      </div>
      {/* Center content */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-3">
        <Lock size={16} style={{ color: 'rgba(201,162,74,0.26)', flexShrink: 0 }} />
        <p
          className="text-[11px] font-bold text-center leading-snug"
          style={{
            color: 'rgba(242,230,200,0.24)',
            filter: 'blur(3px)',
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        >
          {item.title}
        </p>
        <p
          className="text-[9px] font-medium tracking-[0.1em]"
          style={{ color: 'rgba(201,162,74,0.52)' }}
        >
          {item.date}
        </p>
      </div>
    </div>
  )
}

function ComingSoonLane() {
  return (
    <div>
      <div className="px-5 mb-3.5 flex items-end gap-3">
        <p className="text-[17px] font-bold leading-none" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
          近日解放
        </p>
        <span
          className="rounded px-1.5 py-0.5 text-[8px] font-bold tracking-[0.16em] uppercase"
          style={{
            background: 'rgba(107,15,18,0.55)',
            border: '1px solid rgba(180,50,50,0.28)',
            color: 'rgba(242,230,200,0.5)',
          }}
        >
          Coming Soon
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
        {COMING_SOON.map((item) => (
          <ComingSoonCard key={item.id} item={item} />
        ))}
      </div>
    </div>
  )
}

// ── Detail modal ──────────────────────────────────────────────────────────

function StatBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className="flex-shrink-0 text-[11px]"
        style={{ width: '5.5rem', color: 'rgba(201,162,74,0.65)' }}
      >
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
      <span
        className="flex-shrink-0 w-3 text-right text-[11px]"
        style={{ color: 'rgba(201,162,74,0.52)' }}
      >
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
  // iOS Safari scroll bleed 防止: app-main をフリーズ + document touchmove 封鎖
  useScrollLock()

  return (
    <>
      {/* Backdrop — touchmove は useScrollLock の document リスナーが封鎖 */}
      <motion.div
        className="fixed inset-0 z-50"
        style={{ background: 'rgba(0,0,0,0.72)' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />

      {/* Sheet — flex column; このdivはスクロールしない */}
      <motion.div
        className="fixed inset-x-0 bottom-0 z-50"
        style={{
          /* svh = small viewport height。dvh より保守的で Dynamic Island 領域を含まない */
          maxHeight: 'calc(100svh - env(safe-area-inset-top, 0px))',
          background: 'linear-gradient(180deg, #150B0A 0%, #0A0504 100%)',
          borderRadius: '20px 20px 0 0',
          border: '1px solid rgba(201,162,74,0.22)',
          borderBottom: 'none',
          boxShadow: '0 -24px 60px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
        }}
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        onClick={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      >
        {/* 固定ヘッダー: ハンドル + 閉じるボタン（スクロールしない）
            paddingTop: safe-area-inset-top + 12px で Dynamic Island 下に退避 */}
        <div
          className="relative flex justify-center pb-1 flex-shrink-0"
          style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}
        >
          <div className="w-9 h-1 rounded-full" style={{ background: 'rgba(201,162,74,0.24)' }} />
          <button
            type="button"
            onClick={onClose}
            className="absolute top-2 right-4 p-1.5 rounded-full transition-opacity active:opacity-60"
            style={{ background: 'rgba(201,162,74,0.1)', color: 'rgba(201,162,74,0.62)' }}
            aria-label="閉じる"
          >
            <X size={15} />
          </button>
        </div>

        {/* スクロール担当要素 — ここだけがスクロールする */}
        <div
          data-modal-scroll
          style={{
            flex: 1,
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
            overscrollBehavior: 'contain',
            paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 140px)',
          }}
        >
          <div
            className="mx-4 mt-3 rounded-xl overflow-hidden"
            style={{ height: 200, border: '1px solid rgba(201,162,74,0.12)' }}
          >
            <StyleCardImage
              src={style.imageUrl}
              alt={style.title}
              className="w-full h-full"
              imgStyle={{ objectFit: 'cover', objectPosition: 'center bottom' }}
              size="md"
            />
          </div>

          <div className="px-5 pt-4 space-y-4">
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
              <h3
                className="text-xl font-bold leading-snug"
                style={{ color: '#F2E6C8', fontFamily: SERIF }}
              >
                {style.title}
              </h3>
              {style.catchCopy && (
                <p
                  className="text-[12px] mt-1.5 leading-relaxed"
                  style={{ color: 'rgba(201,162,74,0.7)' }}
                >
                  {style.catchCopy}
                </p>
              )}
            </div>

            <div className="flex items-center gap-5">
              <div>
                <p
                  className="text-[9px] tracking-[0.18em] uppercase mb-0.5"
                  style={{ color: 'rgba(201,162,74,0.44)' }}
                >
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
                    <p
                      className="text-[9px] tracking-[0.18em] uppercase mb-0.5"
                      style={{ color: 'rgba(201,162,74,0.44)' }}
                    >
                      Time
                    </p>
                    <p className="text-lg font-bold" style={{ color: '#F2E6C8' }}>
                      {style.durationMinutes}
                      <span className="text-sm ml-0.5" style={{ color: 'rgba(242,230,200,0.56)' }}>
                        分
                      </span>
                    </p>
                  </div>
                </>
              )}
            </div>

            {style.description && (
              <p className="text-sm leading-relaxed" style={{ color: 'rgba(242,230,200,0.58)' }}>
                {style.description}
              </p>
            )}

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

            <div
              className="rounded-xl px-4 py-4 space-y-2.5"
              style={{
                background: 'rgba(201,162,74,0.03)',
                border: '1px solid rgba(201,162,74,0.1)',
              }}
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
              このスタイルにする
            </button>
          </div>
        </div>
      </motion.div>
    </>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────

export function HomeScreen({ member, onTabChange, onModalChange }: Props) {
  const [styles] = useState(() =>
    loadStyles()
      .filter((s) => s.isPublished)
      .sort((a, b) => a.sortOrder - b.sortOrder),
  )
  const [selectedStyle, setSelectedStyle] = useState<StyleCard | null>(null)

  useEffect(() => {
    onModalChange?.(selectedStyle !== null)
  }, [selectedStyle, onModalChange])

  const hero = styles.find((s) => s.isFeatured) ?? styles[0] ?? null

  const popular = [...styles]
    .sort((a, b) => {
      if (a.isFeatured !== b.isFeatured) return a.isFeatured ? -1 : 1
      return b.stats.popularity - a.stats.popularity
    })
    .slice(0, 8)

  const laneCategories = STYLE_CATEGORIES.filter((cat) =>
    styles.some((s) => s.category === cat),
  )

  return (
    <div>
      {/* Hero */}
      <HeroSection
        hero={hero}
        memberName={member.name}
        onReserve={() => onTabChange('reserve')}
        onDiagnosis={() => onTabChange('diagnosis')}
        onTap={() => hero && setSelectedStyle(hero)}
      />

      <div className="space-y-8 pt-8 pb-10">
        {/* Popular */}
        {popular.length > 0 && (
          <Lane
            title="今週の人気男前"
            badge="Popular"
            styles={popular}
            onTap={setSelectedStyle}
          />
        )}

        {/* Category lanes */}
        {laneCategories.map((cat) => (
          <Lane
            key={cat}
            title={STYLE_CATEGORY_LABELS[cat]}
            styles={styles.filter((s) => s.category === cat)}
            onTap={setSelectedStyle}
          />
        ))}

        {/* Coming Soon */}
        <ComingSoonLane />

        {/* Bottom spacer for visual breathing room */}
        <div
          className="mx-5 rounded-2xl px-5 py-5"
          style={{
            background: 'linear-gradient(145deg, rgba(20,10,8,0.6), rgba(8,5,4,0.8))',
            border: '1px solid rgba(201,162,74,0.1)',
          }}
        >
          <p
            className="text-[10px] tracking-[0.22em] uppercase mb-1"
            style={{ color: 'rgba(201,162,74,0.44)' }}
          >
            銀二郎 Premium Barber
          </p>
          <p className="text-sm" style={{ color: 'rgba(242,230,200,0.44)', fontFamily: SERIF }}>
            あなただけの男前を、ここで手に入れてください。
          </p>
        </div>
      </div>

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
