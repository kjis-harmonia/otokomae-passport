import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MOCK_MEMBER } from '../data/brand'
import type { Member, MemberStatus } from '../data/brand'
import { setStoredValue, ONBOARDING_DONE_KEY, ONBOARDING_NAME_KEY } from '../utils/storage'
import { MemberPassportCard } from '../components/MemberPassportCard'
import { MemberQrModal } from '../components/MemberQrModal'
import { getUserId, getMemberIssuedAt } from '../utils/userId'

type Step = 0 | 1 | 2

interface Props {
  memberStatus: MemberStatus
  onDone: (nextStatus: MemberStatus) => void
}

const slideVariants = {
  enter: { opacity: 0, x: 36 },
  center: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -36 },
}

export function OnboardingScreen({ memberStatus, onDone }: Props) {
  const [step, setStep] = useState<Step>(0)
  const [name, setName] = useState('')
  const [showQr, setShowQr] = useState(false)

  const trimmedName = name.trim() || 'ゲスト'

  function handleStart() {
    // BGM: play on user gesture to satisfy browser autoplay policy
    try {
      const audio = new Audio('/audio/ginjiro-theme.mp3')
      audio.volume = 0.28
      audio.loop = false
      void audio.play()
    } catch { /* audio unavailable — silent fail */ }
    setStep(1)
  }

  const previewMember: Member = {
    ...MOCK_MEMBER,
    name: trimmedName,
    rank: memberStatus.rank,
    points: memberStatus.points,
    visitCount: memberStatus.visitCount,
  }

  function handleFinish() {
    const nextStatus: MemberStatus = { ...memberStatus, memberName: trimmedName }
    setStoredValue(ONBOARDING_DONE_KEY, true)
    setStoredValue(ONBOARDING_NAME_KEY, trimmedName)
    onDone(nextStatus)
  }

  return (
    <>
    {showQr && (
      <MemberQrModal onClose={() => setShowQr(false)} />
    )}
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
      className="fixed inset-0 max-w-[430px] mx-auto flex flex-col"
      style={{
        background:
          step === 0
            ? 'transparent'
            : 'radial-gradient(circle at 50% 0%, rgba(139,26,42,0.14), transparent 38%), linear-gradient(160deg, #080706 0%, #0a0909 48%, #0e0708 100%)',
        zIndex: 9998,
      }}
    >
      {/* Progress dots — hidden on step 0 (splash handles its own dots) */}
      {step > 0 && (
        <div className="flex justify-center gap-2 pt-14 pb-6 shrink-0">
          {([0, 1, 2] as const).map((i) => (
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
                {([0, 1, 2] as const).map((i) => (
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

          {/* ── Step 1: Name input ── */}
          {step === 1 && (
            <motion.div
              key={1}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.32 }}
              className="absolute inset-0 flex flex-col justify-center px-8 gap-8"
            >
              <div className="space-y-2">
                <p
                  className="text-[10px] tracking-[0.3em] uppercase"
                  style={{ color: 'rgba(201,162,39,0.55)' }}
                >
                  Step 2 / 3
                </p>
                <h2
                  className="text-2xl font-bold tracking-wide"
                  style={{ color: '#F5F0E8' }}
                >
                  あなたのお名前は？
                </h2>
                <p className="text-sm" style={{ color: 'rgba(245,240,232,0.42)' }}>
                  男前証に記載されます。
                </p>
              </div>

              <div className="space-y-4">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例：銀二郎"
                  maxLength={20}
                  className="w-full px-4 py-3.5 rounded-xl text-base outline-none"
                  style={{
                    background: 'rgba(26,22,20,0.96)',
                    border: '1px solid rgba(201,162,39,0.38)',
                    color: '#F5F0E8',
                    caretColor: '#C9A227',
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    // userId と issuedAt をここで確定する
                    getUserId()
                    getMemberIssuedAt()
                    setStep(2)
                  }}
                  className="w-full py-3.5 rounded-xl text-sm font-semibold tracking-widest transition-opacity active:opacity-70"
                  style={{
                    background: 'linear-gradient(135deg, #8B1A2A 0%, #B02035 100%)',
                    border: '1px solid rgba(176,32,53,0.45)',
                    color: '#F5F0E8',
                    boxShadow: '0 8px 24px rgba(139,26,42,0.24)',
                  }}
                >
                  男前証を発行する
                </button>
              </div>
            </motion.div>
          )}

          {/* ── Step 2: Passport issued ── */}
          {step === 2 && (
            <motion.div
              key={2}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.32 }}
              className="absolute inset-0 flex flex-col justify-center gap-6 pb-6"
            >
              <div className="px-8 space-y-1.5">
                <p
                  className="text-[10px] tracking-[0.3em] uppercase"
                  style={{ color: 'rgba(201,162,39,0.55)' }}
                >
                  発行完了
                </p>
                <h2
                  className="text-xl font-bold tracking-wide leading-snug"
                  style={{ color: '#F5F0E8' }}
                >
                  {trimmedName} 様の<br />男前証が発行されました。
                </h2>
              </div>

              <MemberPassportCard
                member={previewMember}
                onQrTap={() => setShowQr(true)}
              />

              <div className="px-8">
                <button
                  type="button"
                  onClick={handleFinish}
                  className="w-full py-3.5 rounded-xl text-sm font-semibold tracking-widest transition-opacity active:opacity-70"
                  style={{
                    background:
                      'linear-gradient(135deg, rgba(201,162,39,0.22), rgba(139,26,42,0.18))',
                    border: '1px solid rgba(201,162,39,0.42)',
                    color: '#E8C547',
                  }}
                >
                  アプリを始める
                </button>
              </div>
            </motion.div>
          )}

        </AnimatePresence>
      </div>
    </motion.div>
    </>
  )
}
