import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useScrollLock } from '../utils/useScrollLock'
import { StyleCardImage } from './StyleCardPlaceholder'
import { resolveStyleImageUrl, resolveStyleImagePosition, resolveDetailTopOpacity } from '../data/styleImages'
import { getReserveUrl } from '../data/reserveLinks'
import type { StyleCard } from '../data/styleCard'
import { STATS_KEYS, STATS_LABELS } from '../data/styleCard'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

function StarRating({ value }: { value: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          style={{
            fontSize: 13,
            color: i <= value ? '#C9A24A' : 'rgba(201,162,74,0.16)',
            lineHeight: 1,
          }}
        >
          ★
        </span>
      ))}
    </div>
  )
}

export function StyleDetailModal({
  style,
  onClose,
  onReserve,
}: {
  style: StyleCard
  onClose: () => void
  onReserve: () => void
}) {
  useScrollLock()
  const topOpacity = resolveDetailTopOpacity(style)
  const reserveUrl = getReserveUrl(style.title)

  return (
    <>
      <motion.div
        className="fixed inset-0 z-50"
        style={{ background: 'rgba(0,0,0,0.78)' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />

      <motion.div
        className="fixed inset-x-0 bottom-0 z-50"
        style={{
          maxHeight: 'calc(100svh - env(safe-area-inset-top, 0px))',
          background: '#0A0504',
          borderRadius: '20px 20px 0 0',
          border: '1px solid rgba(201,162,74,0.18)',
          borderBottom: 'none',
          boxShadow: '0 -24px 60px rgba(0,0,0,0.7)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        onClick={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      >
        {/* Hero image */}
        <div className="relative flex-shrink-0 w-full" style={{ height: '50vh' }}>
          <StyleCardImage
            src={resolveStyleImageUrl(style)}
            alt={style.title}
            className="absolute inset-0 w-full h-full"
            imgStyle={{ objectFit: 'cover', objectPosition: resolveStyleImagePosition(style) }}
            size="lg"
          />
          {/* Gradient: top-dim + strong bottom */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                `linear-gradient(180deg, rgba(5,3,2,${topOpacity}) 0%, rgba(5,3,2,0.0) 30%, rgba(5,3,2,0.0) 42%, rgba(5,3,2,0.86) 72%, rgba(5,3,2,1.0) 100%)`,
            }}
          />
          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 right-4 p-2 rounded-full transition-opacity active:opacity-60"
            style={{
              background: 'rgba(5,3,2,0.62)',
              border: '1px solid rgba(201,162,74,0.24)',
              color: 'rgba(242,230,200,0.82)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
            }}
            aria-label="閉じる"
          >
            <X size={16} />
          </button>
          {/* Title + catchCopy overlaid on image */}
          <div className="absolute bottom-0 left-0 right-0 px-6 pb-6">
            <h2
              style={{
                fontSize: 32,
                fontWeight: 700,
                color: '#F2E6C8',
                fontFamily: SERIF,
                lineHeight: 1.2,
                textShadow: '0 2px 24px rgba(0,0,0,0.95)',
                letterSpacing: '0.04em',
              }}
            >
              {style.title}
            </h2>
            {style.catchCopy && (
              <p
                style={{
                  fontSize: 13,
                  color: 'rgba(201,162,74,0.78)',
                  marginTop: 6,
                  lineHeight: 1.4,
                  fontStyle: 'italic',
                }}
              >
                {style.catchCopy}
              </p>
            )}
          </div>
        </div>

        {/* Scrollable content */}
        <div
          data-modal-scroll
          style={{
            flex: 1,
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
            overscrollBehavior: 'contain',
            paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 36px)',
          }}
        >
          <div className="px-5 pt-6 space-y-5">
            {/* 能力値 */}
            <div
              style={{
                borderRadius: 16,
                background: 'linear-gradient(145deg, rgba(22,9,7,0.92), rgba(10,5,4,0.96))',
                border: '1px solid rgba(201,162,74,0.14)',
                padding: '18px 20px',
              }}
            >
              <p
                style={{
                  fontSize: 9,
                  letterSpacing: '0.26em',
                  textTransform: 'uppercase',
                  color: 'rgba(201,162,74,0.44)',
                  marginBottom: 14,
                }}
              >
                能力値
              </p>
              <div className="space-y-3.5">
                {STATS_KEYS.map((key) => (
                  <div key={key} className="flex items-center justify-between">
                    <span
                      style={{
                        fontSize: 14,
                        color: 'rgba(242,230,200,0.74)',
                        fontFamily: SERIF,
                        letterSpacing: '0.06em',
                      }}
                    >
                      {STATS_LABELS[key]}
                    </span>
                    <StarRating value={style.stats[key]} />
                  </div>
                ))}
              </div>
            </div>

            {/* こんな人におすすめ */}
            {style.tags.length > 0 && (
              <div
                style={{
                  borderRadius: 16,
                  background: 'linear-gradient(145deg, rgba(22,9,7,0.92), rgba(10,5,4,0.96))',
                  border: '1px solid rgba(201,162,74,0.14)',
                  padding: '18px 20px',
                }}
              >
                <p
                  style={{
                    fontSize: 9,
                    letterSpacing: '0.26em',
                    textTransform: 'uppercase',
                    color: 'rgba(201,162,74,0.44)',
                    marginBottom: 14,
                  }}
                >
                  こんな人におすすめ
                </p>
                <div className="space-y-2.5">
                  {style.tags.map((tag) => (
                    <div key={tag} className="flex items-center gap-3">
                      <div
                        style={{
                          width: 4,
                          height: 4,
                          borderRadius: '50%',
                          background: 'rgba(201,162,74,0.64)',
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          fontSize: 14,
                          color: 'rgba(242,230,200,0.78)',
                          fontFamily: SERIF,
                          letterSpacing: '0.04em',
                        }}
                      >
                        {tag}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* オーダー文 */}
            {style.description && (
              <div
                style={{
                  borderRadius: 16,
                  background: 'linear-gradient(145deg, rgba(22,9,7,0.92), rgba(10,5,4,0.96))',
                  border: '1px solid rgba(201,162,74,0.14)',
                  padding: '18px 20px',
                }}
              >
                <p
                  style={{
                    fontSize: 9,
                    letterSpacing: '0.26em',
                    textTransform: 'uppercase',
                    color: 'rgba(201,162,74,0.44)',
                    marginBottom: 12,
                  }}
                >
                  オーダー文
                </p>
                <p
                  style={{
                    fontSize: 14,
                    color: 'rgba(242,230,200,0.66)',
                    lineHeight: 1.9,
                    fontFamily: SERIF,
                    letterSpacing: '0.04em',
                    whiteSpace: 'pre-line',
                  }}
                >
                  {style.description}
                </p>
              </div>
            )}

            {/* 予約する */}
            <motion.button
              type="button"
              onClick={() => {
                if (reserveUrl) {
                  window.open(reserveUrl, '_blank', 'noopener,noreferrer')
                  onClose()
                } else {
                  onReserve()
                }
              }}
              className="w-full rounded-xl py-4 font-bold tracking-[0.36em]"
              style={{
                background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
                border: '1px solid rgba(201,162,74,0.44)',
                color: '#F2E6C8',
                fontSize: 16,
                fontFamily: SERIF,
                boxShadow:
                  '0 4px 28px rgba(107,15,18,0.5), inset 0 1px 0 rgba(242,230,200,0.06)',
              }}
              whileTap={{ scale: 0.98 }}
              transition={{ duration: 0.15, ease: [0.25, 0, 0.25, 1] }}
            >
              予約する
            </motion.button>
          </div>
        </div>
      </motion.div>
    </>
  )
}
