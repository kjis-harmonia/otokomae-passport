import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { loadStyles } from '../utils/styleStorage'
import { StyleCardImage } from '../components/StyleCardPlaceholder'
import { StyleDetailModal } from '../components/StyleDetailModal'
import { HERO_SLIDE_IMAGES, resolveStyleImageUrl, resolveStyleImagePosition } from '../data/styleImages'
import type { StyleCard } from '../data/styleCard'
import type { Member, NavTab } from '../data/brand'
import { MAINTENANCE_CUT_URL } from '../data/reserveLinks'
import { getDaysRemaining, formatVisitDate, getLastVisit } from '../utils/visitHistory'
import {
  getMaintenanceVisit,
  saveMaintenanceVisit,
  getNextRecommendedDate,
  getDaysUntilRecommended,
  shouldShowNotificationBanner,
  MAINTENANCE_CYCLE_DAYS,
  fmtDate,
} from '../utils/maintenanceSchedule'
import {
  isNotificationSupported,
  getNotificationPermission,
  requestNotificationPermission,
  triggerMaintenanceNotification,
} from '../utils/pushNotification'
import { getUserId } from '../utils/userId'
import { getUserTickets } from '../utils/ticketStore'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

// Easing curve used for stagger animations
const EASE_OUT = [0.25, 0.46, 0.45, 0.94] as const

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
      {/* Dark base */}
      <div className="absolute inset-0" style={{ background: '#050302' }} />

      {/* Slides: crossfade */}
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
                onError={(e) => {
                  ;(e.target as HTMLImageElement).style.display = 'none'
                }}
              />
            </motion.div>
          ) : null,
        )}
      </AnimatePresence>

      {/* Gradient overlays: 上下 + 左サイド */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          zIndex: 2,
          background: [
            /* 左サイド: 筆文字可読性のため */
            'linear-gradient(90deg, rgba(5,3,2,0.40) 0%, rgba(5,3,2,0.0) 42%)',
            /* 上下: ロゴ締め + 下部フェード */
            'linear-gradient(180deg, rgba(5,3,2,0.82) 0%, rgba(5,3,2,0.0) 22%, rgba(5,3,2,0.0) 48%, rgba(5,3,2,0.60) 68%, rgba(5,3,2,0.97) 100%)',
          ].join(', '),
        }}
      />

      {/* Bottom: dot indicators */}
      <div
        className="absolute bottom-5 left-0 right-0 flex justify-center gap-1.5"
        style={{ zIndex: 3 }}
      >
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

// ── DailyStyleCard ────────────────────────────────────────────────────────────

function DailySectionLabel() {
  const [imgError, setImgError] = useState(false)

  return (
    <div className="mb-2 px-1">
      <div
        style={{
          height: '0.5px',
          background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.20), transparent)',
          marginBottom: 10,
        }}
      />
      <div className="flex justify-center">
        {!imgError ? (
          <img
            src="/images/sections/today-otokomae-title.svg"
            alt="本日の男前"
            onError={() => setImgError(true)}
            style={{ width: 'clamp(160px, 44vw, 210px)', height: 'auto', objectFit: 'contain' }}
          />
        ) : (
          <p
            style={{
              fontSize: 8,
              letterSpacing: '0.34em',
              textTransform: 'uppercase' as const,
              color: 'rgba(201,162,74,0.38)',
            }}
          >
            TODAY'S OTOKOMAE
          </p>
        )}
      </div>
    </div>
  )
}

function DailyStyleCard({ style, onTap }: { style: StyleCard; onTap: () => void }) {
  return (
    <div className="px-5">
      <DailySectionLabel />

      <button
        type="button"
        onClick={onTap}
        className="block relative w-full overflow-hidden transition-opacity active:opacity-85"
        style={{
          aspectRatio: '1440 / 2200',
          borderRadius: 20,
          border: '1px solid rgba(201,162,74,0.28)',
          boxShadow:
            '0 20px 56px rgba(0,0,0,0.7), 0 0 0 0.5px rgba(201,162,74,0.08), inset 0 1px 0 rgba(242,230,200,0.04)',
        }}
      >
        {/* Image */}
        <StyleCardImage
          src={resolveStyleImageUrl(style)}
          alt={style.title}
          className="absolute inset-0 w-full h-full"
          imgStyle={{ objectFit: 'cover', objectPosition: resolveStyleImagePosition(style) }}
          size="lg"
        />

        {/* Watermark */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 pointer-events-none">
          <p
            style={{
              fontFamily: SERIF,
              fontSize: 30,
              fontWeight: 700,
              color: 'rgba(242,230,200,0.06)',
              letterSpacing: '0.14em',
              lineHeight: 1,
            }}
          >
            銀二郎
          </p>
          <p
            style={{
              fontSize: 7,
              fontWeight: 600,
              letterSpacing: '0.32em',
              color: 'rgba(201,162,74,0.05)',
              textTransform: 'uppercase',
            }}
          >
            GINJIRO STYLE
          </p>
        </div>

        {/* Gradient overlay — heavy bottom for text, minimal top */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'linear-gradient(180deg, rgba(5,3,2,0.06) 0%, rgba(5,3,2,0.0) 20%, rgba(5,3,2,0.0) 52%, rgba(5,3,2,0.80) 70%, rgba(5,3,2,0.98) 100%)',
          }}
        />

        {/* Bottom content */}
        <div className="absolute bottom-0 left-0 right-0 px-5 pb-6">
          <h2
            style={{
              fontSize: 26,
              fontWeight: 700,
              color: '#F2E6C8',
              fontFamily: SERIF,
              lineHeight: 1.2,
              textShadow: '0 2px 24px rgba(0,0,0,0.98)',
              letterSpacing: '0.04em',
              marginBottom: style.catchCopy ? 6 : 14,
            }}
          >
            {style.title}
          </h2>
          {style.catchCopy && (
            <p
              style={{
                fontSize: 11,
                color: 'rgba(201,162,74,0.72)',
                fontStyle: 'italic',
                lineHeight: 1.4,
                marginBottom: 14,
              }}
            >
              {style.catchCopy}
            </p>
          )}
          <div
            className="w-full rounded-xl py-3 text-center"
            style={{
              background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
              border: '1px solid rgba(201,162,74,0.44)',
              boxShadow: '0 4px 20px rgba(107,15,18,0.45)',
            }}
          >
            <span
              className="text-[12px] font-bold tracking-[0.24em]"
              style={{ color: '#F2E6C8', fontFamily: SERIF }}
            >
              詳しく見る
            </span>
          </div>
        </div>
      </button>
    </div>
  )
}

function DailyStyleEmpty() {
  return (
    <div className="px-5">
      <DailySectionLabel />
      <div
        className="w-full flex items-center justify-center"
        style={{
          aspectRatio: '1440 / 2200',
          borderRadius: 20,
          background: 'linear-gradient(145deg, #100806, #0A0504)',
          border: '1px solid rgba(201,162,74,0.1)',
        }}
      >
        <p className="text-sm" style={{ color: 'rgba(201,162,74,0.30)', fontFamily: SERIF }}>
          スタイルを準備中...
        </p>
      </div>
    </div>
  )
}

// ── MaintenanceCutSection ─────────────────────────────────────────────────────

/**
 * 【14日以内限定】メンテナンスカットセクション
 *
 * スタッフ端末で来店登録されると localStorage に visitHistory が書き込まれる。
 * このコンポーネントは mount 時に getLastVisit() を読み込み、
 * 登録済みの場合は前回来店日・残り日数を自動表示する。
 */
function MaintenanceCutSection() {
  const [lastVisit] = useState(() => getLastVisit())
  const daysRemaining = lastVisit ? getDaysRemaining(lastVisit.visitedAt) : null
  const isEligible = daysRemaining !== null && daysRemaining >= 0

  return (
    <div className="px-4">
      {/* Section header */}
      <div className="mb-4 flex items-center gap-3 px-1">
        <p
          className="text-[17px] font-bold leading-none flex-shrink-0"
          style={{ color: '#F2E6C8', fontFamily: SERIF }}
        >
          期間限定クーポン
        </p>
        <div
          style={{
            height: 1,
            flex: 1,
            background: 'linear-gradient(90deg, rgba(201,162,74,0.3), transparent)',
          }}
        />
      </div>

      {/* Card */}
      <div
        style={{
          borderRadius: 24,
          border: '1px solid rgba(201,162,74,0.28)',
          background: 'linear-gradient(160deg, #120608 0%, #0A0404 60%, #080506 100%)',
          boxShadow:
            '0 16px 48px rgba(0,0,0,0.65), 0 0 0 0.5px rgba(201,162,74,0.06), inset 0 1px 0 rgba(242,230,200,0.03)',
          overflow: 'hidden',
        }}
      >
        {/* Top accent bar */}
        <div
          style={{
            height: 2,
            background: 'linear-gradient(90deg, transparent 0%, #8B1A1A 30%, #C9A24A 50%, #8B1A1A 70%, transparent 100%)',
          }}
        />

        <div className="px-5 pt-4 pb-5">
          {/* Badge row */}
          <div className="flex items-center gap-2 mb-3">
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '3px 10px',
                borderRadius: 99,
                background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 100%)',
                border: '1px solid rgba(201,162,74,0.36)',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.14em',
                color: '#F2E6C8',
                fontFamily: SERIF,
              }}
            >
              14日以内限定
            </span>
          </div>

          {/* Title */}
          <h3
            style={{
              fontSize: 26,
              fontWeight: 700,
              color: '#F2E6C8',
              fontFamily: SERIF,
              letterSpacing: '0.06em',
              lineHeight: 1.2,
              marginBottom: 8,
            }}
          >
            メンテナンスカット
          </h3>

          {/* Divider */}
          <div
            style={{
              height: '0.5px',
              background: 'linear-gradient(90deg, rgba(201,162,74,0.22), transparent)',
              marginBottom: 12,
            }}
          />

          {/* Description */}
          <p
            style={{
              fontSize: 12,
              lineHeight: 1.75,
              color: 'rgba(242,230,200,0.58)',
              marginBottom: 16,
            }}
          >
            前回来店から14日以内のお客様限定。{'\n'}
            フェード・刈り上げ・ラインを整えて男前をキープ。
          </p>

          {/* Phase2: visit status — renders only when lastVisit data is present */}
          {lastVisit && (
            <div
              style={{
                borderRadius: 12,
                background: 'rgba(201,162,74,0.06)',
                border: `1px solid ${isEligible ? 'rgba(201,162,74,0.22)' : 'rgba(139,26,26,0.32)'}`,
                padding: '10px 14px',
                marginBottom: 16,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <div>
                <p style={{ fontSize: 9, letterSpacing: '0.16em', color: 'rgba(242,230,200,0.36)', marginBottom: 2 }}>
                  前回来店
                </p>
                <p style={{ fontSize: 13, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF }}>
                  {formatVisitDate(lastVisit.visitedAt)}
                </p>
              </div>
              <div
                style={{
                  width: '0.5px',
                  height: 32,
                  background: 'rgba(201,162,74,0.18)',
                }}
              />
              <div style={{ textAlign: 'right' }}>
                <p style={{ fontSize: 9, letterSpacing: '0.16em', color: 'rgba(242,230,200,0.36)', marginBottom: 2 }}>
                  利用期限まで
                </p>
                <p
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    fontFamily: SERIF,
                    color: isEligible
                      ? (daysRemaining !== null && daysRemaining <= 3 ? '#E06060' : '#C9A24A')
                      : 'rgba(242,230,200,0.32)',
                  }}
                >
                  {isEligible && daysRemaining !== null
                    ? `あと${daysRemaining}日`
                    : '期限切れ'}
                </p>
              </div>
            </div>
          )}

          {/* Price row */}
          <div style={{ marginBottom: 14 }}>
            <p
              style={{
                fontSize: 9,
                letterSpacing: '0.16em',
                color: 'rgba(201,162,74,0.54)',
                marginBottom: 1,
              }}
            >
              優待価格
            </p>
            <p
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: '#C9A24A',
                fontFamily: SERIF,
                letterSpacing: '0.02em',
                lineHeight: 1,
              }}
            >
              ¥3,000
            </p>
          </div>

          <a
            href={MAINTENANCE_CUT_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'block',
              textAlign: 'center',
              padding: '14px 0',
              borderRadius: 14,
              background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
              border: '1px solid rgba(201,162,74,0.44)',
              boxShadow: '0 4px 20px rgba(107,15,18,0.45)',
              textDecoration: 'none',
            }}
          >
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: '0.14em',
                color: '#F2E6C8',
                fontFamily: SERIF,
              }}
            >
              メンテナンスカットクーポンを使用する
            </span>
          </a>
        </div>
      </div>
    </div>
  )
}

// ── StylesRow (horizontal scroll preview) ────────────────────────────────────

function StylesRow({
  styles,
  onStyleSelect,
}: {
  styles: StyleCard[]
  onStyleSelect: (s: StyleCard) => void
}) {
  if (styles.length === 0) return null

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center gap-3 px-5 mb-3">
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
        <p
          style={{
            fontSize: 8, letterSpacing: '0.22em',
            color: 'rgba(201,162,74,0.46)', flexShrink: 0,
          }}
        >
          ALL STYLES
        </p>
      </div>

      {/* Horizontal strip */}
      <div
        className="[&::-webkit-scrollbar]:hidden"
        style={{
          display: 'flex',
          gap: 10,
          overflowX: 'scroll',
          paddingLeft: 20,
          paddingRight: 32,
          scrollbarWidth: 'none',
          WebkitOverflowScrolling: 'touch',
        } as React.CSSProperties}
      >
        {styles.map((style, i) => (
          <motion.button
            key={style.id}
            type="button"
            onClick={() => onStyleSelect(style)}
            whileTap={{ scale: 0.92 }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04, duration: 0.3, ease: EASE_OUT }}
            style={{
              flexShrink: 0,
              width: 'clamp(108px, 34vw, 144px)',
              aspectRatio: '2/3',
              borderRadius: 10,
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
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '0 8px 9px' }}>
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
  const [visit, setVisit] = useState(() => getMaintenanceVisit())
  const [isEditing, setIsEditing] = useState(false)
  const [editDate, setEditDate] = useState('')
  const [notifPerm, setNotifPerm] = useState<NotificationPermission>(getNotificationPermission)

  // Trigger OS notification on mount if conditions are met
  useEffect(() => {
    if (visit) triggerMaintenanceNotification(visit.lastVisitDate)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // スタッフがカット券を使用済みにした日付を lastVisitDate へ自動反映
  useEffect(() => {
    const userId = getUserId()
    getUserTickets(userId)
      .then(tickets => {
        const latest = tickets
          .filter(t => t.type === 'cut-ticket' && t.used && t.used_at)
          .sort((a, b) => (b.used_at ?? '').localeCompare(a.used_at ?? ''))[0]
        if (!latest?.used_at) return
        const usedDate = latest.used_at.slice(0, 10)
        const current = getMaintenanceVisit()?.lastVisitDate
        if (!current || usedDate > current) {
          saveMaintenanceVisit(usedDate)
          setVisit(getMaintenanceVisit())
        }
      })
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const today = new Date().toISOString().slice(0, 10)

  function openEditor() {
    setEditDate(visit?.lastVisitDate ?? today)
    setIsEditing(true)
  }

  async function handleSave() {
    if (!editDate) return
    saveMaintenanceVisit(editDate)
    const saved = getMaintenanceVisit()
    setVisit(saved)
    setIsEditing(false)
    // 登録ボタンタップ = ユーザー操作なので、まだ未確認なら通知許可を自動リクエスト
    if (notifPerm === 'default') {
      const perm = await requestNotificationPermission()
      setNotifPerm(perm)
      if (perm === 'granted' && saved) triggerMaintenanceNotification(saved.lastVisitDate)
    } else if (saved) {
      triggerMaintenanceNotification(saved.lastVisitDate)
    }
  }

  async function handleRequestPermission() {
    const perm = await requestNotificationPermission()
    setNotifPerm(perm)
    if (perm === 'granted' && visit) triggerMaintenanceNotification(visit.lastVisitDate)
  }

  const daysLeft      = visit ? getDaysUntilRecommended(visit.lastVisitDate) : null
  const nextDate      = visit ? getNextRecommendedDate(visit.lastVisitDate) : null
  const isAlert       = daysLeft !== null && shouldShowNotificationBanner(visit!.lastVisitDate)
  const isOverdue     = daysLeft !== null && daysLeft < 0
  const elapsed       = daysLeft !== null
    ? Math.min(1, Math.max(0, (MAINTENANCE_CYCLE_DAYS - daysLeft) / MAINTENANCE_CYCLE_DAYS))
    : 0
  const notifSupported = isNotificationSupported()

  // ── Date editor ──

  if (isEditing) {
    return (
      <div className="px-4">
        <div className="mb-4 flex items-center gap-3 px-1">
          <p className="text-[17px] font-bold leading-none" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
            前回来店日を登録
          </p>
        </div>
        <div
          style={{
            borderRadius: 20,
            background: 'linear-gradient(145deg, rgba(22,9,7,0.96), rgba(10,5,4,0.98))',
            border: '1px solid rgba(201,162,74,0.22)',
            padding: '22px 20px',
          }}
        >
          <p style={{ fontSize: 10, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.52)', marginBottom: 14 }}>
            LAST VISIT DATE
          </p>
          <input
            type="date"
            value={editDate}
            max={today}
            onChange={(e) => setEditDate(e.target.value)}
            style={{
              width: '100%',
              background: 'rgba(201,162,74,0.06)',
              border: '1px solid rgba(201,162,74,0.28)',
              borderRadius: 12,
              padding: '12px 14px',
              fontSize: 16,
              color: '#F2E6C8',
              fontFamily: SERIF,
              outline: 'none',
              marginBottom: 16,
              colorScheme: 'dark',
            } as React.CSSProperties}
          />
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              onClick={() => setIsEditing(false)}
              style={{
                flex: 1, padding: '12px 0', borderRadius: 12,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.10)',
                fontSize: 13, color: 'rgba(242,230,200,0.52)',
                fontFamily: SERIF, letterSpacing: '0.14em',
              }}
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!editDate}
              style={{
                flex: 2, padding: '12px 0', borderRadius: 12,
                background: editDate
                  ? 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)'
                  : 'rgba(255,255,255,0.04)',
                border: `1px solid ${editDate ? 'rgba(201,162,74,0.44)' : 'rgba(255,255,255,0.08)'}`,
                boxShadow: editDate ? '0 4px 20px rgba(107,15,18,0.45)' : 'none',
                fontSize: 13, fontWeight: 700,
                color: editDate ? '#F2E6C8' : 'rgba(242,230,200,0.28)',
                fontFamily: SERIF, letterSpacing: '0.22em',
              }}
            >
              登録する
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── No visit registered ──

  if (!visit) {
    return (
      <div className="px-4">
        <div className="mb-4 flex items-center gap-3 px-1">
          <p className="text-[17px] font-bold leading-none" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
            メンテナンス予報
          </p>
          <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, rgba(201,162,74,0.3), transparent)' }} />
        </div>
        <div
          style={{
            borderRadius: 20,
            background: 'linear-gradient(145deg, rgba(22,9,7,0.96), rgba(10,5,4,0.98))',
            border: '1px solid rgba(201,162,74,0.14)',
            padding: '24px 20px',
            textAlign: 'center',
          }}
        >
          <p style={{ fontSize: 9, letterSpacing: '0.28em', color: 'rgba(201,162,74,0.42)', marginBottom: 14 }}>
            MAINTENANCE SCHEDULE
          </p>
          <p style={{ fontFamily: SERIF, fontSize: 14, color: 'rgba(242,230,200,0.56)', lineHeight: 1.8, marginBottom: 22 }}>
            前回来店日を登録して<br />
            次のカット時期をお知らせします。
          </p>
          <button
            type="button"
            onClick={openEditor}
            style={{
              width: '100%', padding: '13px 0', borderRadius: 14,
              background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
              border: '1px solid rgba(201,162,74,0.44)',
              boxShadow: '0 4px 20px rgba(107,15,18,0.45)',
              fontFamily: SERIF, fontSize: 13, fontWeight: 700,
              letterSpacing: '0.22em', color: '#F2E6C8',
            }}
          >
            前回来店日を登録する
          </button>
          {notifSupported && notifPerm === 'default' && (
            <button
              type="button"
              onClick={handleRequestPermission}
              style={{
                width: '100%', marginTop: 10, padding: '10px 0', borderRadius: 10,
                background: 'rgba(201,162,74,0.06)',
                border: '1px solid rgba(201,162,74,0.22)',
                fontSize: 11, letterSpacing: '0.14em',
                color: 'rgba(201,162,74,0.72)', fontFamily: SERIF,
              }}
            >
              カット時期になったら通知する
            </button>
          )}
          {notifSupported && notifPerm === 'granted' && (
            <p style={{ marginTop: 12, fontSize: 10, letterSpacing: '0.14em', color: 'rgba(201,162,74,0.44)' }}>
              通知ON — 来店日を登録すれば3日前にお知らせします
            </p>
          )}
        </div>
      </div>
    )
  }

  // ── Alert state (≤ NOTIFICATION_LEAD_DAYS) ──

  if (isAlert) {
    return (
      <div className="px-4">
        <div className="mb-4 flex items-center gap-3 px-1">
          <p className="text-[17px] font-bold leading-none flex-shrink-0" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
            メンテナンスアラート
          </p>
          <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, rgba(180,40,40,0.38), transparent)' }} />
          <button
            type="button"
            onClick={openEditor}
            style={{ fontSize: 10, color: 'rgba(201,162,74,0.54)', letterSpacing: '0.14em', flexShrink: 0 }}
          >
            変更
          </button>
        </div>
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3 }}
          style={{
            borderRadius: 20,
            background: 'linear-gradient(145deg, #2D0608, #1A0305)',
            border: '1px solid rgba(180,40,40,0.48)',
            boxShadow: '0 12px 40px rgba(120,10,10,0.42), inset 0 1px 0 rgba(255,80,60,0.06)',
            padding: '22px 20px 24px',
          }}
        >
          <p style={{ fontSize: 9, letterSpacing: '0.28em', color: 'rgba(200,60,50,0.68)', marginBottom: 8 }}>
            MAINTENANCE ALERT
          </p>
          <p
            style={{
              fontFamily: SERIF, fontSize: 20, fontWeight: 700,
              color: '#F2E6C8', lineHeight: 1.35, marginBottom: 4,
            }}
          >
            {isOverdue
              ? `男前崩壊中… ${Math.abs(daysLeft!)}日超過`
              : daysLeft === 0
                ? '今日が推奨日です。'
                : `男前崩壊まであと${daysLeft}日。`}
          </p>
          <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.50)', marginBottom: 18 }}>
            メンテナンスカットの時間です。
          </p>
          <div
            style={{
              display: 'flex', gap: 16, marginBottom: 18,
              padding: '12px 14px', borderRadius: 12,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <div>
              <p style={{ fontSize: 8, letterSpacing: '0.2em', color: 'rgba(201,162,74,0.44)', marginBottom: 3 }}>前回来店日</p>
              <p style={{ fontFamily: SERIF, fontSize: 13, color: 'rgba(242,230,200,0.72)' }}>{fmtDate(visit.lastVisitDate)}</p>
            </div>
            <div style={{ width: 1, background: 'rgba(255,255,255,0.06)' }} />
            <div>
              <p style={{ fontSize: 8, letterSpacing: '0.2em', color: 'rgba(201,162,74,0.44)', marginBottom: 3 }}>次回推奨日</p>
              <p style={{ fontFamily: SERIF, fontSize: 13, color: '#C9A24A' }}>{fmtDate(nextDate!)}</p>
            </div>
          </div>
          <a
            href={MAINTENANCE_CUT_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'block', textAlign: 'center',
              padding: '14px 0', borderRadius: 14,
              background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
              border: '1px solid rgba(201,162,74,0.44)',
              boxShadow: '0 4px 24px rgba(107,15,18,0.55)',
              textDecoration: 'none', fontFamily: SERIF,
              fontSize: 14, fontWeight: 700,
              letterSpacing: '0.22em', color: '#F2E6C8',
            }}
          >
            今すぐ予約する
          </a>
          {notifSupported && notifPerm === 'default' && (
            <button
              type="button"
              onClick={handleRequestPermission}
              style={{
                width: '100%', marginTop: 10, padding: '10px 0', borderRadius: 10,
                background: 'rgba(201,162,74,0.06)',
                border: '1px solid rgba(201,162,74,0.22)',
                fontSize: 11, letterSpacing: '0.14em',
                color: 'rgba(201,162,74,0.72)', fontFamily: SERIF,
              }}
            >
              カット時期になったら通知する
            </button>
          )}
          {notifSupported && notifPerm === 'granted' && (
            <p style={{ marginTop: 10, fontSize: 10, letterSpacing: '0.14em', color: 'rgba(201,162,74,0.44)', textAlign: 'center' }}>
              通知ON — 次回以降も3日前にお知らせします
            </p>
          )}
        </motion.div>
      </div>
    )
  }

  // ── Normal schedule card ──

  return (
    <div className="px-4">
      <div className="mb-4 flex items-center gap-3 px-1">
        <p className="text-[17px] font-bold leading-none flex-shrink-0" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
          メンテナンス予報
        </p>
        <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, rgba(201,162,74,0.3), transparent)' }} />
        <button
          type="button"
          onClick={openEditor}
          style={{ fontSize: 10, color: 'rgba(201,162,74,0.54)', letterSpacing: '0.14em', flexShrink: 0 }}
        >
          変更
        </button>
      </div>

      <div
        style={{
          borderRadius: 20,
          background: 'linear-gradient(145deg, rgba(22,9,7,0.96), rgba(10,5,4,0.98))',
          border: '1px solid rgba(201,162,74,0.18)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
          padding: '20px 20px 22px',
        }}
      >
        {/* Dates row */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 8, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.48)', marginBottom: 5 }}>前回来店日</p>
            <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: '#F2E6C8' }}>{fmtDate(visit.lastVisitDate)}</p>
          </div>
          <div style={{ width: 1, background: 'rgba(201,162,74,0.12)' }} />
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 8, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.48)', marginBottom: 5 }}>次回推奨日</p>
            <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: '#C9A24A' }}>{fmtDate(nextDate!)}</p>
          </div>
        </div>

        {/* Progress bar */}
        <div style={{ marginBottom: notifSupported ? 16 : 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
            <span style={{ fontSize: 8, letterSpacing: '0.18em', color: 'rgba(201,162,74,0.38)' }}>
              {MAINTENANCE_CYCLE_DAYS}DAY CYCLE
            </span>
            <span style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#C9A24A' }}>
              あと{Math.max(0, daysLeft!)}日
            </span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: 'rgba(201,162,74,0.10)', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${elapsed * 100}%`,
                borderRadius: 2,
                background: 'linear-gradient(90deg, rgba(201,162,74,0.45), rgba(201,162,74,0.88))',
                transition: 'width 0.6s ease',
              }}
            />
          </div>
        </div>

        {/* Notification opt-in */}
        {notifSupported && (
          notifPerm === 'granted' ? (
            <p style={{ fontSize: 10, letterSpacing: '0.14em', color: 'rgba(201,162,74,0.44)', textAlign: 'center', marginTop: 12 }}>
              通知ON — 来店3日前にお知らせします
            </p>
          ) : notifPerm === 'denied' ? (
            <p style={{ fontSize: 10, letterSpacing: '0.12em', color: 'rgba(200,80,60,0.52)', textAlign: 'center', marginTop: 12 }}>
              通知が拒否されています（設定から変更できます）
            </p>
          ) : (
            <button
              type="button"
              onClick={handleRequestPermission}
              style={{
                width: '100%', marginTop: 12, padding: '10px 0', borderRadius: 10,
                background: 'rgba(201,162,74,0.06)',
                border: '1px solid rgba(201,162,74,0.22)',
                fontSize: 11, letterSpacing: '0.14em',
                color: 'rgba(201,162,74,0.76)', fontFamily: SERIF,
              }}
            >
              カット時期になったら通知する
            </button>
          )
        )}
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

  const [dailyStyle] = useState<StyleCard | null>(() =>
    styles.length > 0 ? (styles[Math.floor(Math.random() * styles.length)] ?? null) : null,
  )

  return (
    <div>
      <HeroSlider />

      <div className="space-y-14 pt-7 pb-16">
        <motion.div
          initial={{ opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.06, duration: 0.44, ease: EASE_OUT }}
        >
          {dailyStyle ? (
            <DailyStyleCard style={dailyStyle} onTap={() => setSelectedStyle(dailyStyle)} />
          ) : (
            <DailyStyleEmpty />
          )}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.44, ease: EASE_OUT }}
        >
          <StylesRow styles={styles} onStyleSelect={setSelectedStyle} />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.23, duration: 0.44, ease: EASE_OUT }}
        >
          <MaintenanceCutSection />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.31, duration: 0.44, ease: EASE_OUT }}
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
  )
}
