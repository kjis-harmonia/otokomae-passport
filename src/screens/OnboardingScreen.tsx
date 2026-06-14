import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { MemberStatus } from '../data/brand'
import { setStoredValue, ONBOARDING_DONE_KEY, ONBOARDING_NAME_KEY } from '../utils/storage'
import { getUserId, getMemberIssuedAt } from '../utils/userId'

type Step = 0 | 1

interface Props {
  memberStatus: MemberStatus
  onDone: (nextStatus: MemberStatus) => void
}

const slideVariants = {
  enter: { opacity: 0, x: 36 },
  center: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -36 },
}

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

export function OnboardingScreen({ memberStatus, onDone }: Props) {
  const [step, setStep] = useState<Step>(0)
  const [name, setName] = useState('')
  const [inputFocused, setInputFocused] = useState(false)

  const trimmedName = name.trim() || 'ゲスト'

  function handleStart() {
    // BGM: play on user gesture to satisfy browser autoplay policy
    try {
      const audio = new Audio('/assets/audio/ginjiro-theme.mp4')
      audio.volume = 0.28
      audio.loop = false
      void audio.play()
    } catch { /* audio unavailable — silent fail */ }
    setStep(1)
  }

  function handleFinish() {
    const nextStatus: MemberStatus = { ...memberStatus, memberName: trimmedName }
    setStoredValue(ONBOARDING_DONE_KEY, true)
    setStoredValue(ONBOARDING_NAME_KEY, trimmedName)
    onDone(nextStatus)
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
      className="flex flex-col h-dvh max-w-[430px] mx-auto relative overflow-hidden"
      style={{
        background:
          step === 0
            ? '#000'
            : 'radial-gradient(circle at 50% 0%, rgba(139,26,42,0.14), transparent 38%), linear-gradient(160deg, #080706 0%, #0a0909 48%, #0e0708 100%)',
      }}
    >
      {/* Progress dots — hidden on step 0 (splash handles its own dots) */}
      {step > 0 && (
        <div className="flex justify-center gap-2 pt-14 pb-6 shrink-0">
          {([0, 1] as const).map((i) => (
            <div
              key={i}
              style={{
                width: i === step ? 22 : 6,
                height: 6,
                borderRadius: 3,
                background:
                  i === step
                    ? 'linear-gradient(90deg, #C9A227, #E8C547)'
                    : 'rgba(255,255,255,0.1)',
                transition: 'all 0.35s ease',
              }}
            />
          ))}
        </div>
      )}

      {/* Step content */}
      <div className="flex-1 relative overflow-hidden">
        <AnimatePresence mode="wait">

          {/* ── Step 0: Full-screen brand splash ── */}
          {step === 0 && (
            <motion.div
              key={0}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }}
              style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}
            >
              {/* Background image */}
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  backgroundImage: "url('/images/ginjiro-splash.png')",
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }}
              />

              {/* Gradient overlay: fades lower portion for button legibility */}
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background:
                    'linear-gradient(180deg, rgba(0,0,0,0.0) 0%, rgba(0,0,0,0.0) 55%, rgba(0,0,0,0.45) 85%, rgba(0,0,0,0.7) 100%)',
                  pointerEvents: 'none',
                  zIndex: 1,
                }}
              />

              {/* Music notice — shimmer */}
              <style>{`
                @keyframes gjSplashShimmer {
                  0%   { background-position: -200% center; }
                  100% { background-position:  200% center; }
                }
              `}</style>
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 124px)',
                  width: 'min(78vw, 320px)',
                  textAlign: 'center',
                  zIndex: 2,
                  pointerEvents: 'none',
                }}
              >
                <p
                  style={{
                    fontSize: 12,
                    lineHeight: 1.6,
                    letterSpacing: '0.04em',
                    display: 'inline-block',
                    background: [
                      'linear-gradient(90deg,',
                      '  rgba(212,175,55,0.85) 0%,',
                      '  rgba(255,250,210,0.97) 44%,',
                      '  rgba(255,255,255,0.95) 50%,',
                      '  rgba(255,250,210,0.97) 56%,',
                      '  rgba(212,175,55,0.85) 100%)',
                    ].join(''),
                    backgroundSize: '200% auto',
                    WebkitBackgroundClip: 'text',
                    backgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    color: 'transparent',
                    animation: 'gjSplashShimmer 3s linear infinite',
                  }}
                >
                  ※「始める」を押すと音楽が流れます<br />
                  男前の準備をしてからお進みください。
                </p>
              </div>

              {/* CTA button */}
              <button
                type="button"
                onClick={handleStart}
                style={{
                  position: 'absolute',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 56px)',
                  width: 'min(78vw, 320px)',
                  height: '52px',
                  background: 'rgba(0, 0, 0, 0.55)',
                  border: '1px solid #8A6E3C',
                  color: '#C9A24A',
                  fontFamily: '"Shippori Mincho", "Noto Serif JP", serif',
                  letterSpacing: '0.15em',
                  fontSize: '15px',
                  borderRadius: '10px',
                  backdropFilter: 'blur(8px)',
                  WebkitBackdropFilter: 'blur(8px)',
                  cursor: 'pointer',
                  transition: 'background 200ms ease-out',
                  zIndex: 2,
                }}
              >
                始める
              </button>

              {/* Progress dots (below button) */}
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 32px)',
                  display: 'flex',
                  gap: '8px',
                  zIndex: 2,
                }}
              >
                {([0, 1] as const).map((i) => (
                  <div
                    key={i}
                    style={{
                      width: i === 0 ? 22 : 6,
                      height: 6,
                      borderRadius: 3,
                      background: i === 0 ? '#C9A24A' : 'rgba(212,175,55,0.25)',
                    }}
                  />
                ))}
              </div>
            </motion.div>
          )}

          {/* ── Step 1: Name input — luxury ── */}
          {step === 1 && (
            <motion.div
              key={1}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.32 }}
              style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}
            >
              {/* ── Keyframes ── */}
              <style>{`
                @keyframes gjStep2Aura {
                  0%, 100% { opacity: 0.62; transform: scale(1.00); }
                  50%       { opacity: 0.90; transform: scale(1.07); }
                }
                @keyframes gjConicSpin {
                  from { transform: translate(-50%, -50%) rotate(0deg);   }
                  to   { transform: translate(-50%, -50%) rotate(360deg); }
                }
                @keyframes gjBtnShimmer {
                  0%   { background-position: -200% center; }
                  100% { background-position:  200% center; }
                }
                .gj-name-input::placeholder {
                  color: rgba(212,175,55,0.28);
                  letter-spacing: 0.06em;
                }
              `}</style>

              {/* ── Background ambient layers ── */}
              <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
                {/* Upper crimson breathing orb */}
                <div style={{
                  position: 'absolute', top: '12%', left: '5%', right: '5%', height: '44%',
                  background: 'radial-gradient(ellipse at 50% 38%, rgba(74,14,23,0.68) 0%, rgba(40,5,12,0.36) 44%, transparent 70%)',
                  animation: 'gjStep2Aura 7s ease-in-out infinite',
                }} />
                {/* Lower warmth orb (offset phase) */}
                <div style={{
                  position: 'absolute', bottom: '4%', left: '22%', right: '22%', height: '28%',
                  background: 'radial-gradient(ellipse at 50% 62%, rgba(60,10,18,0.36) 0%, transparent 68%)',
                  animation: 'gjStep2Aura 7s ease-in-out infinite',
                  animationDelay: '-3.5s',
                }} />
                {/* Micro-noise grain */}
                <svg
                  aria-hidden
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.032 }}
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <filter id="gjStep2Noise">
                    <feTurbulence type="fractalNoise" baseFrequency="0.78" numOctaves="4" stitchTiles="stitch" />
                  </filter>
                  <rect width="100%" height="100%" filter="url(#gjStep2Noise)" />
                </svg>
              </div>

              {/* ── Content ── */}
              <div style={{ position: 'relative', zIndex: 10, padding: '0 28px' }}>

                {/* STEP label — small, muted */}
                <p style={{
                  fontSize: 9, letterSpacing: '0.36em', textTransform: 'uppercase',
                  color: 'rgba(201,162,39,0.38)', textAlign: 'center',
                  fontFamily: 'monospace', marginBottom: 38,
                }}>
                  Step 2 / 2
                </p>

                {/* Heading */}
                <h2 style={{
                  fontFamily: SERIF,
                  fontSize: 'clamp(26px, 7.2vw, 32px)',
                  fontWeight: 700,
                  color: '#F2E6C8',
                  letterSpacing: '0.10em',
                  lineHeight: 1.4,
                  textAlign: 'center',
                  textShadow: '0 2px 28px rgba(0,0,0,0.88)',
                  marginBottom: 12,
                }}>
                  あなたのお名前は？
                </h2>

                {/* Sub-copy */}
                <p style={{
                  fontSize: 11, letterSpacing: '0.18em', lineHeight: 1.7,
                  color: 'rgba(201,162,39,0.50)', textAlign: 'center',
                  fontFamily: SERIF, marginBottom: 32,
                }}>
                  この名で、男前証を発行します。
                </p>

                {/* ── Input with conic focus ring ── */}
                <div style={{
                  position: 'relative', marginBottom: 18, borderRadius: 16,
                  // When not focused: gold border via background + padding
                  // When focused: conic ring takes over
                  padding: inputFocused ? '2px' : '1.5px',
                  background: inputFocused ? 'transparent' : 'rgba(212,175,55,0.48)',
                }}>
                  {/* Rotating conic ring — focused only */}
                  {inputFocused && (
                    <div aria-hidden style={{
                      position: 'absolute', inset: 0, borderRadius: 16,
                      overflow: 'hidden', zIndex: 0,
                    }}>
                      <div style={{
                        position: 'absolute', top: '50%', left: '50%',
                        width: '280%', height: '280%',
                        background: [
                          'conic-gradient(',
                          '  from 0deg at 50% 50%,',
                          '  #5c0f1a  0deg,',
                          '  #C9A24A  75deg,',
                          '  #F0E4C0 150deg,',
                          '  #C9A24A 225deg,',
                          '  #5c0f1a 310deg,',
                          '  #5c0f1a 360deg',
                          ')',
                        ].join(''),
                        animation: 'gjConicSpin 3s linear infinite',
                      }} />
                    </div>
                  )}
                  {/* Input field */}
                  <input
                    type="text"
                    className="gj-name-input"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onFocus={() => setInputFocused(true)}
                    onBlur={() => setInputFocused(false)}
                    placeholder="例：銀二郎"
                    maxLength={20}
                    style={{
                      position: 'relative', zIndex: 1,
                      display: 'block', width: '100%', boxSizing: 'border-box',
                      padding: '18px 22px',
                      background: 'rgba(10,5,3,0.97)',
                      border: 'none',
                      borderRadius: 13,
                      color: '#F2E6C8',
                      fontSize: 20,
                      fontFamily: SERIF,
                      letterSpacing: '0.12em',
                      textShadow: name ? '0 0 14px rgba(212,175,55,0.20)' : 'none',
                      caretColor: '#C9A24A',
                      outline: 'none',
                      transition: 'text-shadow 0.2s',
                    }}
                  />
                </div>

                {/* ── Issue button with shimmer ── */}
                <div style={{ position: 'relative', borderRadius: 15, overflow: 'hidden' }}>
                  {/* Shimmer sweep */}
                  <div aria-hidden style={{
                    position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none',
                    background: [
                      'linear-gradient(90deg,',
                      '  transparent 0%,',
                      '  rgba(255,248,210,0.10) 44%,',
                      '  rgba(255,255,255,0.08) 50%,',
                      '  rgba(255,248,210,0.10) 56%,',
                      '  transparent 100%)',
                    ].join(''),
                    backgroundSize: '200% auto',
                    animation: 'gjBtnShimmer 3s linear infinite',
                  }} />
                  <button
                    type="button"
                    onClick={() => { getUserId(); getMemberIssuedAt(); handleFinish() }}
                    style={{
                      position: 'relative', zIndex: 1,
                      display: 'block', width: '100%',
                      padding: '18px 20px',
                      background: [
                        'linear-gradient(158deg,',
                        '  #3a0a12 0%,',
                        '  #6a1020 28%,',
                        '  #8B1A2A 55%,',
                        '  #6a1020 80%,',
                        '  #3a0a12 100%)',
                      ].join(''),
                      border: '1px solid rgba(212,175,55,0.62)',
                      boxShadow: [
                        '0 10px 36px rgba(58,10,18,0.72)',
                        '0 2px 8px rgba(0,0,0,0.85)',
                        'inset 0 1px 0 rgba(212,175,55,0.22)',
                        'inset 0 -1px 0 rgba(0,0,0,0.4)',
                        '0 0 60px rgba(139,26,42,0.18)',
                      ].join(', '),
                      borderRadius: 14,
                      color: '#F2E6C8',
                      fontFamily: SERIF,
                      fontSize: 16,
                      fontWeight: 700,
                      letterSpacing: '0.22em',
                      cursor: 'pointer',
                      WebkitTapHighlightColor: 'transparent',
                      transition: 'transform 0.12s ease, box-shadow 0.12s ease',
                    }}
                    onMouseDown={e => {
                      e.currentTarget.style.transform = 'scale(0.98)'
                      e.currentTarget.style.boxShadow = '0 5px 18px rgba(58,10,18,0.82), 0 1px 4px rgba(0,0,0,0.9), inset 0 1px 0 rgba(212,175,55,0.14), 0 0 28px rgba(139,26,42,0.14)'
                    }}
                    onMouseUp={e => {
                      e.currentTarget.style.transform = 'scale(1.0)'
                      e.currentTarget.style.boxShadow = ''
                    }}
                    onTouchStart={e => {
                      e.currentTarget.style.transform = 'scale(0.98)'
                      e.currentTarget.style.boxShadow = '0 5px 18px rgba(58,10,18,0.82), 0 1px 4px rgba(0,0,0,0.9), inset 0 1px 0 rgba(212,175,55,0.14), 0 0 28px rgba(139,26,42,0.14)'
                    }}
                    onTouchEnd={e => {
                      e.currentTarget.style.transform = 'scale(1.0)'
                      e.currentTarget.style.boxShadow = ''
                    }}
                    onTouchCancel={e => {
                      e.currentTarget.style.transform = 'scale(1.0)'
                      e.currentTarget.style.boxShadow = ''
                    }}
                  >
                    男前証を発行する
                  </button>
                </div>

              </div>
            </motion.div>
          )}

        </AnimatePresence>
      </div>
    </motion.div>
  )
}
