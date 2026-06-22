import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { supabase } from '../lib/supabase'
import { loadStyles } from '../utils/styleStorage'
import { StyleCardImage } from '../components/StyleCardPlaceholder'
import { StyleDetailModal } from '../components/StyleDetailModal'
import { FreshnessWidget } from '../components/FreshnessWidget'
import { LiveStatusSection } from '../components/LiveStatusSection'
import { HERO_SLIDE_IMAGES, resolveStyleImageUrl, resolveStyleImagePosition } from '../data/styleImages'
import type { StyleCard } from '../data/styleCard'
import type { Member, NavTab } from '../data/brand'
import {
  getNextRecommendedDate,
  getDaysUntilRecommended,
} from '../utils/maintenanceSchedule'
import {
  isNotificationSupported,
  getNotificationPermission,
  requestNotificationPermission,
  triggerMaintenanceNotification,
} from '../utils/pushNotification'
import { getUserId } from '../utils/userId'
import { getStoredValue } from '../utils/storage'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

// Easing curve used for stagger animations
const EASE_OUT = [0.25, 0.46, 0.45, 0.94] as const

const MAINTENANCE_LOCAL_KEY = 'ginjiro_maintenance_visits'

// ── Card image helpers (HomeScreen preview row) ───────────────────────────────

function getThumbImgStyle(style: StyleCard): React.CSSProperties {
  if (style.title === 'トラック野郎御用達') {
    return { objectFit: 'contain', objectPosition: 'center center', transform: 'scale(0.94)' }
  }
  return { objectFit: 'cover', objectPosition: resolveStyleImagePosition(style) }
}

function getThumbOverlay(style: StyleCard): string {
  const base = style.title === 'トラック野郎御用達' ? 'rgba(0,0,0' : 'rgba(5,3,2'
  return (
    `linear-gradient(to top,` +
    `${base},0.98) 0%,${base},0.84) 22%,${base},0.44) 44%,${base},0.06) 64%,transparent 80%)`
  )
}


// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  member: Member
  onTabChange: (tab: NavTab) => void
  onModalChange?: (open: boolean) => void
}

// ── StylesRow (home carousel preview — max 6 priority styles) ────────────────

const HOME_PRIORITY_TITLES = [
  '海軍御用達',
  '俺は濡れパン',
  'バチバチパンチパーマ',
  '昭和のアイパー',
  'カールアイパー',
  '銀パラ',
] as const

function StylesRow({
  styles,
  onStyleSelect,
  onSeeAll,
}: {
  styles: StyleCard[]
  onStyleSelect: (s: StyleCard) => void
  onSeeAll: () => void
}) {
  const byTitle = new Map(styles.map(s => [s.title, s]))
  const featured = HOME_PRIORITY_TITLES
    .map(t => byTitle.get(t))
    .filter((s): s is StyleCard => s !== undefined)
  const displayStyles = featured.length > 0 ? featured : styles.slice(0, 6)

  if (displayStyles.length === 0) return null

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center gap-3 px-5 mb-4">
        <p
          className="text-[17px] font-bold leading-none flex-shrink-0"
          style={{ color: '#F2E6C8', fontFamily: SERIF }}
        >
          銀二郎スタイル
        </p>
        <div
          style={{
            height: 1, flex: 1,
            background: 'linear-gradient(90deg, rgba(201,162,74,0.28), transparent)',
          }}
        />
        <button
          type="button"
          onClick={onSeeAll}
          style={{
            flexShrink: 0,
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            fontSize: 9, letterSpacing: '0.18em',
            color: 'rgba(201,162,74,0.58)',
          }}
        >
          全て見る →
        </button>
      </div>

      {/* Horizontal carousel */}
      <div
        className="[&::-webkit-scrollbar]:hidden"
        style={{
          display: 'flex',
          gap: 10,
          overflowX: 'scroll',
          paddingLeft: 20,
          paddingRight: 20,
          paddingBottom: 4,
          scrollbarWidth: 'none',
          WebkitOverflowScrolling: 'touch',
        } as React.CSSProperties}
      >
        {displayStyles.map((style, i) => (
          <motion.button
            key={style.id}
            type="button"
            onClick={() => onStyleSelect(style)}
            whileTap={{ scale: 0.94 }}
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.05, duration: 0.3, ease: EASE_OUT }}
            style={{
              flexShrink: 0,
              width: 'clamp(140px, 44vw, 162px)',
              aspectRatio: '3/4',
              borderRadius: 12,
              overflow: 'hidden',
              position: 'relative',
              background: '#0A0504',
              border: '1px solid rgba(201,162,74,0.13)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
              cursor: 'pointer',
            }}
          >
            <StyleCardImage
              src={resolveStyleImageUrl(style)}
              alt={style.title}
              className="absolute inset-0 w-full h-full"
              imgStyle={getThumbImgStyle(style)}
              size="md"
            />
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ background: getThumbOverlay(style) }}
            />
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '0 10px 10px' }}>
              <p
                style={{
                  fontFamily: SERIF, fontSize: 11, fontWeight: 700,
                  color: '#F2E6C8', lineHeight: 1.22,
                  textShadow: '0 1px 8px rgba(0,0,0,0.95)',
                }}
              >
                {style.title}
              </p>
              <p style={{ fontSize: 10, color: 'rgba(201,162,74,0.84)', marginTop: 2 }}>
                ¥{style.price.toLocaleString()}
              </p>
            </div>
          </motion.button>
        ))}
      </div>
    </div>
  )
}

// ── MaintenanceScheduleSection ────────────────────────────────────────────────

function MaintenanceScheduleSection() {
  const userId = getUserId()
  // undefined = loading, null = no record, string = YYYY-MM-DD
  const [lastVisitDate, setLastVisitDate] = useState<string | null | undefined>(undefined)
  const [notifPerm, setNotifPerm] = useState<NotificationPermission>(getNotificationPermission)

  // Fetch last_visit_date from Supabase (localStorage fallback)
  async function fetchVisit() {
    try {
      const { data, error } = await supabase
        .from('maintenance_visits')
        .select('last_visit_date')
        .eq('user_id', userId)
        .maybeSingle()
      if (!error && data?.last_visit_date) {
        setLastVisitDate(data.last_visit_date as string)
        return
      }
    } catch { /* ignore */ }
    const local = getStoredValue<Record<string, string>>(MAINTENANCE_LOCAL_KEY, {})
    setLastVisitDate(local[userId] ?? null)
  }

  useEffect(() => { void fetchVisit() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (lastVisitDate) triggerMaintenanceNotification(lastVisitDate)
  }, [lastVisitDate])

  async function handleRequestPermission() {
    const perm = await requestNotificationPermission()
    setNotifPerm(perm)
    if (perm === 'granted' && lastVisitDate) triggerMaintenanceNotification(lastVisitDate)
  }

  if (lastVisitDate === undefined) return null

  const daysLeft = lastVisitDate ? getDaysUntilRecommended(lastVisitDate) : null
  const nextDate = lastVisitDate ? getNextRecommendedDate(lastVisitDate) : null
  const notifSupported = isNotificationSupported()

  return (
    <div className="px-4">
      <FreshnessWidget
        lastVisitDate={lastVisitDate}
        nextRecommendedDate={nextDate}
        daysRemaining={daysLeft}
        notifSupported={notifSupported}
        notifPermission={notifPerm}
        onRequestNotif={handleRequestPermission}
      />
    </div>
  )
}

// ── HeroSlider ────────────────────────────────────────────────────────────────

function HeroSlider() {
  const [current, setCurrent] = useState(0)
  const touchStartX = useRef<number | null>(null)

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrent((i) => (i + 1) % HERO_SLIDE_IMAGES.length)
    }, 7000)
    return () => clearInterval(timer)
  }, [])

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0]?.clientX ?? null
  }

  function handleTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return
    const endX = e.changedTouches[0]?.clientX
    if (endX === undefined) return
    const diff = endX - touchStartX.current
    touchStartX.current = null
    if (Math.abs(diff) < 40) return
    if (diff < 0) {
      setCurrent((i) => (i + 1) % HERO_SLIDE_IMAGES.length)
    } else {
      setCurrent((i) => (i - 1 + HERO_SLIDE_IMAGES.length) % HERO_SLIDE_IMAGES.length)
    }
  }

  return (
    <div
      className="relative w-full overflow-hidden select-none"
      style={{ aspectRatio: '1440 / 2200', maxHeight: '88dvh' }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div className="absolute inset-0" style={{ background: '#050302' }} />
      <AnimatePresence mode="sync">
        {HERO_SLIDE_IMAGES.map((img, i) =>
          i === current ? (
            <motion.div
              key={`slide-${i}`}
              className="absolute inset-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.6, ease: [0.25, 0, 0.25, 1] }}
            >
              <motion.img
                src={img.src}
                alt={img.alt}
                className="absolute inset-0 w-full h-full"
                style={{ objectFit: 'cover', objectPosition: img.position }}
                initial={{ scale: 1 }}
                animate={{ scale: 1.04 }}
                transition={{ duration: 9, ease: [0.22, 0, 0.36, 1] }}
                onError={(e) => { ;(e.target as HTMLImageElement).style.display = 'none' }}
              />
            </motion.div>
          ) : null,
        )}
      </AnimatePresence>
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          zIndex: 2,
          background: [
            'linear-gradient(90deg, rgba(5,3,2,0.40) 0%, rgba(5,3,2,0.0) 42%)',
            'linear-gradient(180deg, rgba(5,3,2,0.82) 0%, rgba(5,3,2,0.0) 22%, rgba(5,3,2,0.0) 48%, rgba(5,3,2,0.60) 68%, rgba(5,3,2,0.97) 100%)',
          ].join(', '),
        }}
      />
      <div className="absolute bottom-5 left-0 right-0 flex justify-center gap-1.5" style={{ zIndex: 3 }}>
        {HERO_SLIDE_IMAGES.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setCurrent(i)}
            aria-label={`スライド ${i + 1}`}
            style={{
              width: i === current ? 18 : 6,
              height: 6,
              borderRadius: 3,
              background: i === current ? '#C9A24A' : 'rgba(242,230,200,0.26)',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              flexShrink: 0,
              transition: 'width 0.35s ease, background 0.35s ease',
            }}
          />
        ))}
      </div>
    </div>
  )
}

// ── HomeScreen ────────────────────────────────────────────────────────────────

export function HomeScreen({ onTabChange, onModalChange }: Props) {
  const [styles] = useState(() =>
    loadStyles()
      .filter((s) => s.isPublished)
      .sort((a, b) => a.sortOrder - b.sortOrder),
  )
  const [selectedStyle, setSelectedStyle] = useState<StyleCard | null>(null)

  useEffect(() => {
    onModalChange?.(selectedStyle !== null)
  }, [selectedStyle, onModalChange])

  return (
    <div className="ginjiro-luxury-bg ginjiro-luxury-bg--home">
      <div className="relative z-10">
        <HeroSlider />

        <div className="space-y-12 pt-7 pb-16">

          {/* ① GINJIRO LIVE STATUS — 今予約できる？ */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.04, duration: 0.42, ease: EASE_OUT }}
          >
            <LiveStatusSection />
          </motion.div>

          {/* ② 漢の鮮度 — そろそろ切る時期？ */}
          <motion.div
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12, duration: 0.44, ease: EASE_OUT }}
          >
            <MaintenanceScheduleSection />
          </motion.div>

          {/* ③ 銀二郎スタイル — どんな髪型にする？ */}
          <motion.div
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.20, duration: 0.44, ease: EASE_OUT }}
          >
            <StylesRow
              styles={styles}
              onStyleSelect={setSelectedStyle}
              onSeeAll={() => onTabChange('styles')}
            />
          </motion.div>
        </div>

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
    </div>
  )
}
