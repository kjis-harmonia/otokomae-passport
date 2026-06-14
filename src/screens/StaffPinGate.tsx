import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { AdminScreen } from './AdminScreen'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const CORRECT_PIN = '8181'
const PIN_AUTH_KEY = 'ginjiro_staff_pin_auth'

const PIN_CSS = `
@keyframes gjPinShine {
  from { transform: translate(-50%,-50%) rotate(0deg); }
  to   { transform: translate(-50%,-50%) rotate(360deg); }
}
`

export function StaffPinGate() {
  const [authed, setAuthed] = useState(() =>
    sessionStorage.getItem(PIN_AUTH_KEY) === '1'
  )
  const [pin, setPin] = useState('')
  const [error, setError] = useState(false)
  const [shakeKey, setShakeKey] = useState(0)
  const [success, setSuccess] = useState(false)

  const submitPin = useCallback((candidate: string) => {
    if (candidate === CORRECT_PIN) {
      setSuccess(true)
      sessionStorage.setItem(PIN_AUTH_KEY, '1')
      setTimeout(() => setAuthed(true), 500)
    } else {
      setError(true)
      setShakeKey((k) => k + 1)
      setTimeout(() => {
        setPin('')
        setError(false)
      }, 700)
    }
  }, [])

  const handleDigit = useCallback((d: string) => {
    if (error) return
    setPin((prev) => {
      if (prev.length >= 4) return prev
      const next = prev + d
      if (next.length === 4) {
        setTimeout(() => submitPin(next), 80)
      }
      return next
    })
  }, [error, submitPin])

  const handleBack = useCallback(() => {
    if (error) return
    setPin((p) => p.slice(0, -1))
  }, [error])

  // Keyboard support
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key >= '0' && e.key <= '9') handleDigit(e.key)
      if (e.key === 'Backspace') handleBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleDigit, handleBack])

  if (authed) return <AdminScreen />

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key="pin-gate"
        initial={{ opacity: 0 }}
        animate={{ opacity: success ? 0 : 1 }}
        transition={{ duration: success ? 0.4 : 0.3 }}
        style={{
          minHeight: '100dvh',
          background: 'linear-gradient(180deg, #080302 0%, #0B0403 55%, #090304 100%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 28px',
          userSelect: 'none',
        }}
      >
        <style>{PIN_CSS}</style>

        {/* Top accent line */}
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, height: 2,
          background: 'linear-gradient(90deg, transparent 0%, rgba(139,26,26,0.6) 20%, rgba(201,162,74,0.9) 50%, rgba(139,26,26,0.6) 80%, transparent 100%)',
        }} />

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.44 }}
          style={{ textAlign: 'center', marginBottom: 52 }}
        >
          {/* Decorative ring */}
          <div style={{ position: 'relative', width: 72, height: 72, margin: '0 auto 20px' }}>
            <div style={{
              position: 'absolute', inset: 0, borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(107,15,18,0.42) 0%, transparent 68%)',
            }} />
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
              style={{
                position: 'absolute', inset: 0, borderRadius: '50%',
                background: 'conic-gradient(from 0deg, rgba(201,162,74,0.05), rgba(201,162,74,0.50), rgba(255,248,210,0.80), rgba(201,162,74,0.50), rgba(201,162,74,0.05))',
              }}
            />
            <div style={{
              position: 'absolute', top: '50%', left: '50%',
              transform: 'translate(-50%,-50%)',
              width: 56, height: 56, borderRadius: '50%',
              background: '#0B0403',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <span style={{ fontSize: 20, opacity: 0.7 }}>✂</span>
            </div>
          </div>

          <p style={{
            fontSize: 9, letterSpacing: '0.34em',
            color: 'rgba(201,162,74,0.52)',
            marginBottom: 6,
          }}>
            STAFF TERMINAL
          </p>
          <h1 style={{
            fontFamily: SERIF,
            fontSize: 22, fontWeight: 700,
            color: '#F2E6C8', letterSpacing: '0.10em',
            marginBottom: 4,
          }}>
            銀二郎端末
          </h1>
          <p style={{
            fontSize: 8, letterSpacing: '0.24em',
            color: 'rgba(201,162,74,0.36)',
          }}>
            OTOKOMAE PASSPORT SCANNER
          </p>
        </motion.div>

        {/* PIN dots */}
        <motion.div
          key={shakeKey}
          animate={error ? { x: [-10, 10, -8, 8, -5, 5, -3, 3, 0] } : {}}
          transition={{ duration: 0.55 }}
          style={{ display: 'flex', gap: 20, marginBottom: 48 }}
        >
          {[0, 1, 2, 3].map((i) => (
            <motion.div
              key={i}
              animate={{
                background: i < pin.length
                  ? error ? '#E06060' : '#C9A24A'
                  : success && i < 4 ? '#80E060' : 'rgba(201,162,74,0.14)',
                boxShadow: i < pin.length && !error
                  ? '0 0 12px rgba(201,162,74,0.55)'
                  : 'none',
              }}
              transition={{ duration: 0.15 }}
              style={{
                width: 14, height: 14, borderRadius: '50%',
                border: `1.5px solid ${
                  i < pin.length
                    ? error ? 'rgba(224,96,96,0.7)' : 'rgba(201,162,74,0.7)'
                    : 'rgba(201,162,74,0.22)'
                }`,
              }}
            />
          ))}
        </motion.div>

        {/* Error text */}
        <AnimatePresence>
          {error && (
            <motion.p
              key="err"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              style={{
                fontSize: 12, color: '#E06060',
                letterSpacing: '0.10em',
                marginBottom: 20,
                textAlign: 'center',
                fontFamily: SERIF,
              }}
            >
              PINが正しくありません
            </motion.p>
          )}
        </AnimatePresence>

        {/* Numpad */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.42 }}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 10,
            width: '100%',
            maxWidth: 270,
          }}
        >
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
            <NumKey key={n} label={String(n)} onPress={() => handleDigit(String(n))} />
          ))}

          {/* Empty */}
          <div />

          {/* 0 */}
          <NumKey label="0" onPress={() => handleDigit('0')} />

          {/* Backspace */}
          <motion.button
            type="button"
            onClick={handleBack}
            whileTap={{ scale: 0.93, opacity: 0.7 }}
            style={{
              padding: '18px 0', borderRadius: 14,
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.08)',
              color: 'rgba(242,230,200,0.38)',
              fontSize: 20, cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            ⌫
          </motion.button>
        </motion.div>

        {/* Bottom accent */}
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, height: 1,
          background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.18), transparent)',
        }} />
      </motion.div>
    </AnimatePresence>
  )
}

function NumKey({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <motion.button
      type="button"
      onClick={onPress}
      whileTap={{ scale: 0.92, background: 'rgba(201,162,74,0.20)' }}
      style={{
        padding: '18px 0', borderRadius: 14,
        background: 'rgba(201,162,74,0.06)',
        border: '1px solid rgba(201,162,74,0.18)',
        color: '#F2E6C8',
        fontFamily: SERIF, fontSize: 22, fontWeight: 700,
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {label}
    </motion.button>
  )
}
