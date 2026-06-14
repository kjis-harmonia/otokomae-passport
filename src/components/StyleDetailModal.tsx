import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useScrollLock } from '../utils/useScrollLock'
import { resolveStyleImageUrl, resolveDetailTopOpacity } from '../data/styleImages'
import { getReserveUrl } from '../data/reserveLinks'
import type { StyleCard } from '../data/styleCard'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

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
        {/* Hero image — full display, no cropping */}
        <div className="relative flex-shrink-0 w-full" style={{ background: '#050302' }}>
          <img
            src={resolveStyleImageUrl(style)}
            alt={style.title}
            style={{
              width: '100%',
              height: 'auto',
              maxHeight: '72dvh',
              minHeight: '40dvh',
              display: 'block',
              objectFit: 'contain',
            }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
          {/* Gradient: top-dim + strong bottom */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                `linear-gradient(180deg, rgba(5,3,2,${topOpacity}) 0%, rgba(5,3,2,0.0) 30%, rgba(5,3,2,0.0) 52%, rgba(5,3,2,0.82) 76%, rgba(5,3,2,1.0) 100%)`,
            }}
          />
          {/* Close button — left to avoid overlap with BGM record icon */}
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 left-4 p-2 rounded-full transition-opacity active:opacity-60"
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
          {/* Title + catchCopy + tag chips overlaid on image */}
          <div className="absolute bottom-0 left-0 right-0 px-5 pb-5">
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
            {style.tags.length > 0 && (
              <div
                className="[&::-webkit-scrollbar]:hidden"
                style={{
                  display: 'flex',
                  gap: 6,
                  overflowX: 'auto',
                  flexWrap: 'nowrap',
                  scrollbarWidth: 'none',
                  marginTop: 10,
                } as React.CSSProperties}
              >
                {style.tags.map((tag) => (
                  <span
                    key={tag}
                    style={{
                      flexShrink: 0,
                      fontSize: 12,
                      padding: '4px 12px',
                      borderRadius: 99,
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
          <div className="px-5 pt-5 space-y-5">
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

            {/* PRICE + 予約する */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flexShrink: 0 }}>
                <p style={{ fontSize: 10, letterSpacing: '0.18em', color: 'rgba(201,162,74,0.46)', marginBottom: 2 }}>PRICE</p>
                <p style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: '#C9A24A' }}>
                  ¥{style.price.toLocaleString()}
                </p>
              </div>
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
                style={{
                  flex: 1,
                  padding: '15px 0',
                  borderRadius: 14,
                  background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
                  border: '1px solid rgba(201,162,74,0.44)',
                  color: '#F2E6C8',
                  fontSize: 16,
                  fontWeight: 700,
                  fontFamily: SERIF,
                  letterSpacing: '0.2em',
                  boxShadow: '0 4px 28px rgba(107,15,18,0.5)',
                  cursor: 'pointer',
                }}
                whileTap={{ scale: 0.98 }}
                transition={{ duration: 0.15, ease: [0.25, 0, 0.25, 1] }}
              >
                予約する
              </motion.button>
            </div>
          </div>
        </div>
      </motion.div>
    </>
  )
}
