import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { PassportCard } from './PassportCard'

interface Props {
  onClose: () => void
}

export function MemberQrModal({ onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const targets = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), summary, a[href]') ?? []).filter(element => element.getClientRects().length > 0)
      const first = targets[0], last = targets.at(-1)
      if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('keydown', handleKey)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])
  return (
    <motion.div
      ref={dialogRef} className="fixed inset-0" role="dialog" aria-modal="true" aria-label="会員QR"
      style={{ zIndex: 10020, background: '#f4f5f1', overflowY: 'auto', overscrollBehavior: 'contain' }}
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
          width: 44, height: 44, borderRadius: '50%',
          background: '#fff',
          border: '1px solid #dedfd9',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#202321', cursor: 'pointer',
          boxShadow: 'none',
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
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.08, duration: 0.36, ease: 'easeOut' }}
          style={{ width: '100%', maxWidth: 400 }}
        >
          <PassportCard />
        </motion.div>
      </div>
    </motion.div>
  )
}
