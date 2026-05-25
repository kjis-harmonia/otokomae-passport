import { useEffect } from 'react'
import { motion } from 'framer-motion'
import { BRAND } from '../data/brand'

interface Props {
  onDone: () => void
}

export function SplashScreen({ onDone }: Props) {
  useEffect(() => {
    const t = setTimeout(onDone, 2400)
    return () => clearTimeout(t)
  }, [onDone])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.55 }}
      className="fixed inset-0 max-w-[430px] mx-auto flex flex-col items-center justify-center"
      style={{
        background:
          'radial-gradient(circle at 50% 0%, rgba(139,26,42,0.18), transparent 40%), linear-gradient(160deg, #080706 0%, #0a0909 48%, #0e0708 100%)',
        zIndex: 9999,
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.3, ease: 'easeOut' }}
        className="flex flex-col items-center gap-8"
      >
        <div
          className="rounded-2xl overflow-hidden"
          style={{
            width: 120,
            height: 120,
            border: '1px solid rgba(201,162,39,0.3)',
            boxShadow: '0 0 48px rgba(201,162,39,0.1), 0 24px 40px rgba(0,0,0,0.5)',
          }}
        >
          <img
            src="/images/ginjiro-splash.png"
            alt="銀二郎"
            className="w-full h-full object-cover"
          />
        </div>

        <div className="text-center space-y-2.5">
          <p
            className="text-[10px] tracking-[0.4em] uppercase"
            style={{ color: 'rgba(201,162,39,0.6)' }}
          >
            {BRAND.nameEn}
          </p>
          <p
            className="text-4xl font-bold"
            style={{
              color: '#F5F0E8',
              letterSpacing: '0.08em',
              textShadow: '0 0 40px rgba(201,162,39,0.14)',
            }}
          >
            {BRAND.shopName}
          </p>
          <p
            className="text-sm tracking-[0.24em]"
            style={{ color: 'rgba(201,162,39,0.52)' }}
          >
            {BRAND.tagline}
          </p>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, scaleX: 0 }}
        animate={{ opacity: 1, scaleX: 1 }}
        transition={{ duration: 1.1, delay: 0.9, ease: 'easeOut' }}
        className="absolute bottom-20"
        style={{
          width: 64,
          height: 1,
          background:
            'linear-gradient(90deg, transparent, rgba(201,162,39,0.5), transparent)',
        }}
      />
    </motion.div>
  )
}
