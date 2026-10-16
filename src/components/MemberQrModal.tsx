import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { PassportCard } from './PassportCard'
import { formatVisit, useNextReservation } from '../features/johnny/nextReservation'

interface Props {
  onClose: () => void
}

export function MemberQrModal({ onClose }: Props) {
  const next = useNextReservation()
  const visit = next ? formatVisit(next.starts_at) : null
  return (
    <motion.div
      className="fixed inset-0"
      style={{ zIndex: 10020, background: 'rgba(4,2,1,0.97)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22 }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="閉じる"
        style={{
          position: 'absolute',
          top: 'max(18px, env(safe-area-inset-top, 18px))',
          left: 18,
          zIndex: 10021,
          width: 40, height: 40, borderRadius: '50%',
          background: 'rgba(5,3,2,0.85)',
          border: '1px solid rgba(201,162,74,0.32)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#F2E6C8', cursor: 'pointer',
          boxShadow: '0 2px 12px rgba(0,0,0,0.6)',
        }}
      >
        <X size={18} strokeWidth={2} />
      </button>

      <div
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100%',
          paddingTop: 'max(56px, calc(env(safe-area-inset-top, 0px) + 48px))',
          paddingBottom: 'max(36px, env(safe-area-inset-bottom, 36px))',
          overflowY: 'auto',
          boxSizing: 'border-box',
        }}
      >
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, duration: 0.36, ease: 'easeOut' }}
          style={{ width: '100%', maxWidth: 400 }}
        >
          {next && visit && (
            <section
              aria-label="次のご予約"
              style={{
                margin: '0 16px 14px', padding: '12px 16px', borderRadius: 14,
                background: 'rgba(28,28,30,0.92)', color: '#FFFFFF',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif',
                display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12,
              }}
            >
              <span style={{ fontSize: 13, color: 'rgba(235,235,245,0.6)', flexShrink: 0 }}>次のご予約</span>
              <span style={{ textAlign: 'right' }}>
                <span style={{ display: 'block', fontSize: 17, fontWeight: 600 }}>
                  {visit.relative ? `${visit.relative} ` : ''}{visit.date} {visit.time}
                </span>
                <span style={{ display: 'block', fontSize: 13, color: 'rgba(235,235,245,0.6)', marginTop: 2 }}>
                  {next.items.map(i => i.name).join('・')}
                </span>
              </span>
            </section>
          )}
          <PassportCard />
        </motion.div>
      </div>
    </motion.div>
  )
}
