import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { PassportCard } from './PassportCard'

interface Props {
  userId: string
  name: string
  issuedAt: string
  onClose: () => void
}

export function MemberQrModal({ userId, name, issuedAt, onClose }: Props) {
  const [lastVisitDate, setLastVisitDate] = useState<string | null>(null)

  useEffect(() => {
    supabase
      .from('maintenance_visits')
      .select('last_visit_date')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.last_visit_date) setLastVisitDate(data.last_visit_date as string)
      })
  }, [userId])

  return (
    <motion.div
      className="fixed inset-0"
      style={{ zIndex: 200, background: 'rgba(4,2,1,0.97)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22 }}
    >
      {/* Close button */}
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

      {/* Scrollable content */}
      <div
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100%',
          paddingTop: 'max(56px, calc(env(safe-area-inset-top, 0px) + 48px))',
          paddingBottom: 'max(36px, env(safe-area-inset-bottom, 36px))',
          paddingLeft: 20,
          paddingRight: 20,
          overflowY: 'auto',
          boxSizing: 'border-box',
        }}
      >
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, duration: 0.36, ease: 'easeOut' }}
          style={{ width: '100%', maxWidth: 380 }}
        >
          <PassportCard
            userId={userId}
            name={name}
            issuedAt={issuedAt}
            lastVisitDate={lastVisitDate}
          />
        </motion.div>

        <p style={{
          fontSize: 10, color: 'rgba(201,162,74,0.3)', marginTop: 18,
          letterSpacing: '0.12em', textAlign: 'center', lineHeight: 1.7,
        }}>
          会計時にスタッフへ提示してください
        </p>
      </div>
    </motion.div>
  )
}
