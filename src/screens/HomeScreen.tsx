import { useState, useEffect, useRef } from 'react'
import type { CSSProperties, TouchEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { supabase } from '../lib/supabase'
import { loadStyles } from '../utils/styleStorage'
import { StyleCardImage } from '../components/StyleCardPlaceholder'
import { StyleDetailModal } from '../components/StyleDetailModal'
import { FreshnessWidget } from '../components/FreshnessWidget'
import { HERO_SLIDE_IMAGES, resolveStyleImageUrl, resolveStyleImagePosition } from '../data/styleImages'
import { resolveStyleLibraryImageUrl } from '../data/styleLibraryImages'
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

function getThumbImgStyle(style: StyleCard): CSSProperties {
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

// ── Home style curation ──────────────────────────────────────────────────────

const HERO_SPOTLIGHT_TITLES = [
  '俺は濡れパン',
  'テイテイ刈り',
  'ジャマイカンアフロ',
  '海の男専用',
  'ちょい悪オヤジ専用 昭和ヘアスタイル',
] as const

const PICKUP_MENU_TITLES = [
  '俺は濡れパン',
  'カールアイパー',
  '銀パラ',
] as const

type HomeHeroSlide = {
  src: string
  position: string
  imageLeft: string
  imageTop: string
  imageSize: string
  isComposedArt: boolean
  title: string
  eyebrow: string
  copy: string
  sideCopy: string
  style?: StyleCard
}

const DEFAULT_HERO_IMAGE = {
  position: '50% 32%',
  imageLeft: '-4%',
  imageTop: '-6%',
  imageSize: '112%',
} as const

const COMPOSED_HERO_INSET = 'clamp(14px, 3.8vw, 22px)'
const COMPOSED_HERO_SIZE = 'calc(100% - clamp(28px, 7.6vw, 44px))'

type HeroDisplayConfig = Pick<HomeHeroSlide, 'title' | 'eyebrow' | 'copy' | 'sideCopy'> &
  Partial<Pick<HomeHeroSlide, 'position' | 'imageLeft' | 'imageTop' | 'imageSize' | 'isComposedArt'>> & {
    homeSrc?: string
  }

const HERO_DISPLAY: Record<string, HeroDisplayConfig> = {
  '俺は濡れパン': {
    title: 'フェード×濡れパン',
    eyebrow: '漢のスタイルは、自由だ。',
    copy: '無骨に、色気を纏う。',
    sideCopy: '髪で、生き様を語れ。',
    position: '50% 31%',
    imageLeft: '0%',
    imageTop: '0%',
    imageSize: '100%',
    homeSrc: '/images/home-hero/home-nurepan.webp.png',
    isComposedArt: true,
  },
  'テイテイ刈り': {
    title: 'テイテイ刈り',
    eyebrow: '輪郭で、男を語る。',
    copy: '攻めた刈り込みで締める。',
    sideCopy: '線が、印象を作る。',
    position: '50% 30%',
    imageLeft: '0%',
    imageTop: '0%',
    imageSize: '100%',
    homeSrc: '/images/home-hero/home-teyteygari.webp.png',
    isComposedArt: true,
  },
  'ジャマイカンアフロ': {
    title: 'ジャマイカンアフロ',
    eyebrow: '自由を、纏う。',
    copy: '熱を帯びた個性が立ち上がる。',
    sideCopy: '空気ごと、変えろ。',
    position: '50% 50%',
    imageLeft: '0%',
    imageTop: '0%',
    imageSize: '100%',
    homeSrc: '/images/home-hero/home-afro.webp.png',
    isComposedArt: true,
  },
  '海の男専用': {
    title: '海の男専用',
    eyebrow: '潮風に負けん、漢の髪型。',
    copy: '港で映える、漁師の貫禄。',
    sideCopy: '海で、生き様を語れ。',
    position: '50% 50%',
    imageLeft: '0%',
    imageTop: '0%',
    imageSize: '100%',
    homeSrc: '/assets/styles/library-uminotoko.jpg',
    isComposedArt: true,
  },
  '昭和のアイパー': {
    title: '昭和のアイパー',
    eyebrow: '渋さで、男を語る。',
    copy: '昭和の粋を、今に残す。',
    sideCopy: '曲げずに、締める。',
    position: '50% 50%',
    imageLeft: '0%',
    imageTop: '0%',
    imageSize: '100%',
    homeSrc: '/images/home-hero/home-showa-aipa-.webp.png',
    isComposedArt: true,
  },
  'ちょい悪オヤジ専用 昭和ヘアスタイル': {
    title: '昭和ヘアスタイル',
    eyebrow: '年輪で、魅せる。',
    copy: '大人の余裕を、形にする。',
    sideCopy: '渋さは、武器になる。',
    position: '50% 50%',
    imageLeft: '0%',
    imageTop: '0%',
    imageSize: '100%',
    homeSrc: '/images/home-hero/home-showa-hair.webp.png',
    isComposedArt: true,
  },
}

function pickStylesByTitle(styles: StyleCard[], titles: readonly string[], fallbackCount: number): StyleCard[] {
  const byTitle = new Map(styles.map((style) => [style.title, style]))
  const picked = titles
    .map((title) => byTitle.get(title))
    .filter((style): style is StyleCard => style !== undefined)

  if (picked.length >= fallbackCount) return picked.slice(0, fallbackCount)

  const pickedIds = new Set(picked.map((style) => style.id))
  return [
    ...picked,
    ...styles.filter((style) => !pickedIds.has(style.id)).slice(0, fallbackCount - picked.length),
  ]
}

function buildHeroSlides(styles: StyleCard[]): HomeHeroSlide[] {
  const picked = pickStylesByTitle(styles, HERO_SPOTLIGHT_TITLES, HERO_SPOTLIGHT_TITLES.length)

  if (picked.length > 0) {
    return picked.map((style) => {
      const display: HeroDisplayConfig = HERO_DISPLAY[style.title] ?? {
        title: style.title,
        eyebrow: '銀二郎が選ぶ、男前スタイル。',
        copy: style.catchCopy,
        sideCopy: '髪で、印象を変える。',
      }

      return {
        ...display,
        src: display.homeSrc ?? resolveStyleImageUrl(style),
        position: display.position ?? DEFAULT_HERO_IMAGE.position,
        imageLeft: display.imageLeft ?? DEFAULT_HERO_IMAGE.imageLeft,
        imageTop: display.imageTop ?? DEFAULT_HERO_IMAGE.imageTop,
        imageSize: display.imageSize ?? DEFAULT_HERO_IMAGE.imageSize,
        isComposedArt: display.isComposedArt ?? false,
        style,
      }
    })
  }

  return HERO_SLIDE_IMAGES.slice(0, 6).map((img) => ({
    src: img.src,
    position: DEFAULT_HERO_IMAGE.position,
    imageLeft: DEFAULT_HERO_IMAGE.imageLeft,
    imageTop: DEFAULT_HERO_IMAGE.imageTop,
    imageSize: DEFAULT_HERO_IMAGE.imageSize,
    isComposedArt: false,
    title: '銀二郎スタイル',
    eyebrow: '漢のスタイルは、自由だ。',
    copy: '技術で、見た目も生き方も変わる。',
    sideCopy: '髪で、生き様を語れ。',
  }))
}

function PickupMenuSection({
  styles,
  onStyleSelect,
  onSeeAll,
}: {
  styles: StyleCard[]
  onStyleSelect: (s: StyleCard) => void
  onSeeAll: () => void
}) {
  const displayStyles = pickStylesByTitle(styles, PICKUP_MENU_TITLES, 3)

  return (
    <section className="px-4">
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 12 }}>
        <div style={{ minWidth: 0 }}>
          <p
            style={{
              fontFamily: SERIF,
              fontSize: 24,
              fontWeight: 700,
              color: '#F2E6C8',
              lineHeight: 1,
              textShadow: '0 0 16px rgba(201,162,74,0.18)',
            }}
          >
            PICK UP MENU
          </p>
          <p style={{ marginTop: 7, fontSize: 12, color: 'rgba(242,230,200,0.58)' }}>
            技術で、見た目も生き方も変わる。
          </p>
        </div>
        <button
          type="button"
          onClick={onSeeAll}
          style={{
            flexShrink: 0,
            background: 'none',
            border: 'none',
            padding: '0 0 1px',
            cursor: 'pointer',
            fontSize: 11,
            lineHeight: 1.3,
            color: 'rgba(201,162,74,0.72)',
            textAlign: 'right',
          }}
        >
          すべて見る &gt;
        </button>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 8,
        }}
      >
        {displayStyles.map((style, i) => {
          return (
            <motion.article
              key={style.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05, duration: 0.32, ease: EASE_OUT }}
              style={{
                minWidth: 0,
                position: 'relative',
                overflow: 'hidden',
                borderRadius: 7,
                aspectRatio: '0.67',
                background: '#070403',
                border: '1px solid rgba(201,162,74,0.25)',
                boxShadow: '0 12px 30px rgba(0,0,0,0.56), inset 0 1px 0 rgba(242,230,200,0.05)',
              }}
            >
              <StyleCardImage
                src={resolveStyleLibraryImageUrl(style)}
                alt={style.title}
                className="absolute inset-0 w-full h-full"
                imgStyle={getThumbImgStyle(style)}
                size="md"
              />
              <div className="absolute inset-0 pointer-events-none" style={{ background: getThumbOverlay(style) }} />
              <div
                aria-hidden
                className="absolute inset-0 pointer-events-none"
                style={{
                  background:
                    'linear-gradient(180deg, rgba(201,162,74,0.13) 0%, transparent 18%, transparent 80%, rgba(107,15,18,0.18) 100%)',
                }}
              />
              <div style={{ position: 'absolute', left: 8, right: 8, bottom: 8 }}>
                <button
                  type="button"
                  onClick={() => onStyleSelect(style)}
                  style={{
                    width: '100%',
                    height: 30,
                    borderRadius: 5,
                    background: 'rgba(5,3,2,0.72)',
                    border: '1px solid rgba(201,162,74,0.70)',
                    color: '#E8C77A',
                    fontFamily: SERIF,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  見る &gt;
                </button>
              </div>
            </motion.article>
          )
        })}
      </div>
    </section>
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

function HeroSlider({
  slides,
  onPick,
}: {
  slides: HomeHeroSlide[]
  onPick: (style: StyleCard) => void
}) {
  const [current, setCurrent] = useState(0)
  const touchStartX = useRef<number | null>(null)
  const slideCount = Math.max(slides.length, 1)
  const activeIndex = current % slideCount

  useEffect(() => {
    if (slideCount <= 1) return
    const timer = setInterval(() => {
      setCurrent((i) => (i + 1) % slideCount)
    }, 7000)
    return () => clearInterval(timer)
  }, [slideCount])

  function handleTouchStart(e: TouchEvent) {
    touchStartX.current = e.touches[0]?.clientX ?? null
  }

  function handleTouchEnd(e: TouchEvent) {
    if (touchStartX.current === null) return
    const endX = e.changedTouches[0]?.clientX
    if (endX === undefined) return
    const diff = endX - touchStartX.current
    touchStartX.current = null
    if (Math.abs(diff) < 40) return
    if (diff < 0) {
      setCurrent((i) => (i + 1) % slideCount)
    } else {
      setCurrent((i) => (i - 1 + slideCount) % slideCount)
    }
  }

  const activeSlide = slides[activeIndex]

  if (!activeSlide) return null

  return (
    <section className="px-5 pt-5">
      <div
        className="relative w-full overflow-hidden select-none"
        style={{
          height: activeSlide.isComposedArt ? undefined : 'clamp(520px, 72svh, 740px)',
          minHeight: activeSlide.isComposedArt ? undefined : 520,
          aspectRatio: activeSlide.isComposedArt ? '1064 / 1478' : undefined,
          borderRadius: 20,
          border: '1px solid rgba(201,162,74,0.24)',
          boxShadow:
            '0 28px 76px rgba(0,0,0,0.72), 0 0 0 1px rgba(107,15,18,0.16), inset 0 -1px 0 rgba(242,230,200,0.07)',
          isolation: 'isolate',
          background: '#050302',
        }}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
      <div className="absolute inset-0" style={{ background: '#050302' }} />
      <AnimatePresence mode="sync">
        {slides.map((slide, i) =>
          i === activeIndex ? (
            <motion.div
              key={`${slide.src}-${i}`}
              className="absolute inset-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.6, ease: [0.25, 0, 0.25, 1] }}
            >
              <motion.img
                src={slide.src}
                alt={slide.title}
                className="absolute max-w-none"
                style={{
                  left: slide.isComposedArt ? COMPOSED_HERO_INSET : slide.imageLeft,
                  top: slide.isComposedArt ? COMPOSED_HERO_INSET : slide.imageTop,
                  width: slide.isComposedArt ? COMPOSED_HERO_SIZE : slide.imageSize,
                  height: slide.isComposedArt ? COMPOSED_HERO_SIZE : slide.imageSize,
                  borderRadius: slide.isComposedArt ? 14 : 0,
                  objectFit: slide.isComposedArt ? 'contain' : 'cover',
                  objectPosition: slide.isComposedArt ? 'center center' : slide.position,
                  background: '#050302',
                  filter: slide.isComposedArt
                    ? 'saturate(1) contrast(1.02) brightness(0.98)'
                    : 'saturate(0.94) contrast(1.06) brightness(0.96)',
                  transformOrigin: 'center center',
                  willChange: 'transform, opacity',
                }}
                initial={{ scale: 1.01 }}
                animate={{ scale: 1.045 }}
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
          background: activeSlide.isComposedArt
            ? 'transparent'
            : [
                'linear-gradient(90deg, rgba(5,3,2,0.95) 0%, rgba(5,3,2,0.86) 30%, rgba(5,3,2,0.38) 58%, rgba(5,3,2,0.14) 76%, rgba(5,3,2,0.54) 100%)',
                'linear-gradient(180deg, rgba(5,3,2,0.72) 0%, rgba(5,3,2,0.08) 22%, rgba(5,3,2,0.10) 54%, rgba(5,3,2,0.94) 78%, #050302 100%)',
              ].join(', '),
        }}
      />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          zIndex: 3,
          background: activeSlide.isComposedArt
            ? 'transparent'
            : 'radial-gradient(circle at 16% 44%, rgba(176,24,42,0.26), transparent 38%), radial-gradient(circle at 82% 34%, rgba(176,24,42,0.18), transparent 36%), linear-gradient(90deg, rgba(5,3,2,0.48) 0%, rgba(5,3,2,0.22) 46%, transparent 72%)',
        }}
      />
      {activeSlide.isComposedArt ? (
        activeSlide.style && (
          <button
            type="button"
            aria-label={`${activeSlide.title}の詳細を開く`}
            onClick={() => activeSlide.style && onPick(activeSlide.style)}
            style={{
              position: 'absolute',
              zIndex: 4,
              left: COMPOSED_HERO_INSET,
              top: COMPOSED_HERO_INSET,
              width: COMPOSED_HERO_SIZE,
              height: COMPOSED_HERO_SIZE,
              borderRadius: 14,
              border: 0,
              padding: 0,
              background: 'transparent',
              color: 'transparent',
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          />
        )
      ) : (
        <>
          <div
            className="absolute pointer-events-none"
            style={{
              zIndex: 3,
              left: 0,
              top: 0,
              bottom: 0,
              width: 'min(72%, 340px)',
              background:
                'linear-gradient(90deg, rgba(5,3,2,0.76) 0%, rgba(20,8,7,0.56) 52%, rgba(107,15,18,0.12) 82%, transparent 100%)',
            }}
          />
          <div
            className="absolute"
            style={{
              zIndex: 4,
              left: 'clamp(22px, 6vw, 34px)',
              right: 'clamp(56px, 16vw, 92px)',
              bottom: 'clamp(70px, 10svh, 94px)',
              maxWidth: 310,
            }}
          >
            <motion.p
              key={`eyebrow-${activeIndex}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.42, ease: EASE_OUT }}
              style={{
                fontFamily: SERIF,
                fontSize: 13,
                fontWeight: 700,
                color: 'rgba(242,230,200,0.88)',
                lineHeight: 1.45,
                textShadow: '0 1px 12px rgba(0,0,0,0.92)',
              }}
            >
              {activeSlide.eyebrow}
            </motion.p>
            <motion.h1
              key={`title-${activeIndex}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.48, ease: EASE_OUT, delay: 0.05 }}
              style={{
                marginTop: 8,
                fontFamily: SERIF,
                fontSize: 'clamp(29px, 7.7vw, 38px)',
                fontWeight: 900,
                lineHeight: 1.06,
                color: '#F2E6C8',
                textShadow: '0 2px 20px rgba(0,0,0,0.96), 0 0 18px rgba(107,15,18,0.36)',
                overflowWrap: 'anywhere',
                wordBreak: 'keep-all',
              }}
            >
              {activeSlide.title}
            </motion.h1>
            <motion.p
              key={`copy-${activeIndex}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.42, ease: EASE_OUT, delay: 0.12 }}
              style={{
                marginTop: 8,
                fontFamily: SERIF,
                fontSize: 14,
                color: 'rgba(242,230,200,0.76)',
                lineHeight: 1.55,
                textShadow: '0 1px 12px rgba(0,0,0,0.90)',
              }}
            >
              {activeSlide.copy}
            </motion.p>
            {activeSlide.style && (
              <motion.button
                key={`cta-${activeIndex}`}
                type="button"
                onClick={() => activeSlide.style && onPick(activeSlide.style)}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.42, ease: EASE_OUT, delay: 0.18 }}
                style={{
                  marginTop: 18,
                  height: 38,
                  padding: '0 16px',
                  borderRadius: 3,
                  background: 'rgba(7,4,3,0.66)',
                  border: '1px solid rgba(201,162,74,0.82)',
                  color: '#E8C77A',
                  fontFamily: SERIF,
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: 'pointer',
                  boxShadow: '0 12px 30px rgba(0,0,0,0.52), inset 0 1px 0 rgba(242,230,200,0.08)',
                }}
              >
                PICK UP STYLE &gt;
              </motion.button>
            )}
          </div>
          <p
            className="absolute"
            style={{
              zIndex: 4,
              right: 'clamp(18px, 5vw, 28px)',
              top: '36%',
              margin: 0,
              maxHeight: 150,
              writingMode: 'vertical-rl',
              fontFamily: SERIF,
              fontSize: 13,
              lineHeight: 1.7,
              color: 'rgba(242,230,200,0.58)',
              textShadow: '0 1px 12px rgba(0,0,0,0.95)',
              pointerEvents: 'none',
            }}
          >
            {activeSlide.sideCopy}
          </p>
        </>
      )}
      <div className="absolute bottom-5 left-0 right-0 flex justify-center gap-1.5" style={{ zIndex: 5 }}>
        {slides.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setCurrent(i)}
            aria-label={`スライド ${i + 1}`}
            style={{
              width: i === activeIndex ? 18 : 6,
              height: 6,
              borderRadius: 3,
              background: i === activeIndex ? '#C9A24A' : 'rgba(242,230,200,0.26)',
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
    </section>
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
  const heroSlides = buildHeroSlides(styles)

  useEffect(() => {
    onModalChange?.(selectedStyle !== null)
  }, [selectedStyle, onModalChange])

  return (
    <div className="ginjiro-luxury-bg ginjiro-luxury-bg--home">
      <div className="relative z-10">
        <HeroSlider slides={heroSlides} onPick={setSelectedStyle} />

        <div className="space-y-10 pt-5 pb-16">

          {/* ① PICK UP MENU — 推しスタイル */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.04, duration: 0.42, ease: EASE_OUT }}
          >
            <PickupMenuSection
              styles={styles}
              onStyleSelect={setSelectedStyle}
              onSeeAll={() => onTabChange('styles')}
            />
          </motion.div>

          {/* ② 漢の鮮度 — そろそろ切る時期？ */}
          <motion.div
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12, duration: 0.44, ease: EASE_OUT }}
          >
            <MaintenanceScheduleSection />
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
