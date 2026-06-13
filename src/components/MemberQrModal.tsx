import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { PassportCard } from './PassportCard'

interface Props {
  onClose: () => void
}

export function MemberQrModal({ onClose }: Props) {
  return (
    <motion.div
      className="fixed inset-0"
      style={{ zIndex: 200, background: 'rgba(4,2,1,0.97)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
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
          right: 18,
          zIndex: 201,
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
          <PassportCard />
        </motion.div>
      </div>
    </motion.div>
  )
}
