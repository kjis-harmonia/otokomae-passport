import { motion } from 'framer-motion'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

const CSS = `
@keyframes gjLdGlow {
  0%, 100% {
    opacity: 0.40;
    text-shadow: 0 0 12px rgba(201,162,74,0.12);
  }
  50% {
    opacity: 1;
    text-shadow:
      0 0 28px rgba(201,162,74,0.90),
      0 0 56px rgba(201,162,74,0.40),
      0 0 90px rgba(139,26,26,0.22);
  }
}
@keyframes gjLdSubGlow {
  0%, 100% { opacity: 0.22; letter-spacing: 0.44em; }
  50%       { opacity: 0.72; letter-spacing: 0.50em; }
}
@keyframes gjLdLine {
  0%   { width: 0;     opacity: 0; }
  20%  { opacity: 1; }
  80%  { opacity: 1; }
  100% { width: 120px; opacity: 0; }
}
`

export function GinjiroLoadingScreen() {
  return (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.55, ease: 'easeOut' }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0,
      }}
    >
      <style>{CSS}</style>

      {/* Top accent */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 2,
        background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.6) 50%, transparent)',
      }} />

      {/* GINJIRO */}
      <h1 style={{
        fontFamily: SERIF,
        fontSize: 'clamp(34px, 9vw, 48px)',
        fontWeight: 700,
        color: '#C9A24A',
        letterSpacing: '0.26em',
        margin: 0,
        animation: 'gjLdGlow 2.4s ease-in-out infinite',
        textIndent: '0.26em', // compensate letter-spacing
      }}>
        GINJIRO
      </h1>

      {/* Gold divider line */}
      <div style={{
        height: 1,
        background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.7), transparent)',
        animation: 'gjLdLine 2.4s ease-in-out infinite',
        margin: '16px 0',
      }} />

      {/* LOADING... */}
      <p style={{
        fontSize: 9,
        color: 'rgba(201,162,74,0.5)',
        margin: 0,
        fontFamily: 'monospace',
        animation: 'gjLdSubGlow 2.4s ease-in-out infinite 0.6s',
      }}>
        LOADING...
      </p>

      {/* Bottom accent */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, height: 1,
        background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.18) 50%, transparent)',
      }} />
    </motion.div>
  )
}
