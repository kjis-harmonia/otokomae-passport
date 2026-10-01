import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { MemberStatus } from '../data/brand'
import type { TicketRow } from '../data/ticket'
import { setStoredValue, ONBOARDING_DONE_KEY, ONBOARDING_NAME_KEY } from '../utils/storage'
import { getUserId, getMemberIssuedAt } from '../utils/userId'
import { completeCustomerOnboarding } from '../utils/ticketStore'
import { RpcError } from '../utils/staffSession'
import { DEFAULT_BGM_TRACK_SRC, registerBgmAudio, stopAllBgmAudio } from '../hooks/useBgm'

type Step = 0 | 1 | 2

export interface OnboardingDonePayload {
  hasVisitedBefore: boolean
  welcomeCouponIssued: boolean
  ticket: TicketRow | null
}

interface Props {
  memberStatus: MemberStatus
  onDone: (nextStatus: MemberStatus, payload?: OnboardingDonePayload) => void
}

const slideVariants = {
  enter: { opacity: 0, x: 36 },
  center: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -36 },
}

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

function playIntroBgm() {
  try {
    stopAllBgmAudio()
    const audio = registerBgmAudio(new Audio(DEFAULT_BGM_TRACK_SRC))
    audio.volume = 0.28
    audio.loop = false
    void audio.play()
  } catch {
    // Audio is optional and must not block onboarding.
  }
}

function onboardingErrorMessage(err: unknown): string {
  const code = err instanceof RpcError ? err.code : ''
  const message = err instanceof Error ? err.message : ''
  let detail = ''
  if (err instanceof RpcError && err.detail) {
    try {
      detail = typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail)
    } catch {
      detail = String(err.detail)
    }
  }
  const text = `${code} ${message} ${detail}`.toLowerCase()

  if (
    text.includes('complete_customer_onboarding') ||
    text.includes('pgrst202') ||
    text.includes('42883') ||
    text.includes('could not find the function') ||
    (text.includes('function') && text.includes('does not exist'))
  ) {
    return '初回登録用のDB更新がまだ反映されていません。管理者に確認してください。'
  }

  return '登録に失敗しました。通信状態を確認して、もう一度お試しください。'
}

function ChoiceButton({
  children,
  onClick,
}: {
  children: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        minWidth: 0,
        minHeight: 'clamp(50px, 8.2svh, 58px)',
        padding: '10px 8px',
        borderRadius: 16,
        border: '1px solid rgba(212,175,55,0.42)',
        background: 'linear-gradient(160deg, rgba(10,5,3,0.97), rgba(18,9,7,0.96))',
        color: '#F2E6C8',
        boxShadow: 'inset 0 1px 0 rgba(242,230,200,0.06), 0 10px 26px rgba(0,0,0,0.28)',
        fontFamily: SERIF,
        fontSize: 'clamp(15px, 4.4vw, 17px)',
        fontWeight: 800,
        lineHeight: 1.2,
        letterSpacing: '0.12em',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {children}
    </button>
  )
}

export function OnboardingScreen({ memberStatus, onDone }: Props) {
  const [step, setStep] = useState<Step>(0)
  const [hasVisitedBefore, setHasVisitedBefore] = useState<boolean | null>(null)
  const [name, setName] = useState('')
  const [inputFocused, setInputFocused] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const trimmedName = name.trim()

  function handleStart() {
    playIntroBgm()
    setStep(1)
  }

  function handleChooseVisited(visited: boolean) {
    setHasVisitedBefore(visited)
    setSubmitError(null)
    setStep(2)
  }

  async function handleFinish() {
    if (submitting) return
    if (hasVisitedBefore === null) {
      setSubmitError('来店経験を選択してください。')
      setStep(1)
      return
    }
    if (!trimmedName) {
      setSubmitError('お名前を入力してください。')
      return
    }

    setSubmitting(true)
    setSubmitError(null)

    try {
      const userId = getUserId()
      getMemberIssuedAt()
      const result = await completeCustomerOnboarding(userId, trimmedName, hasVisitedBefore)
      const nextStatus: MemberStatus = { ...memberStatus, memberName: trimmedName }
      setStoredValue(ONBOARDING_DONE_KEY, true)
      setStoredValue(ONBOARDING_NAME_KEY, trimmedName)
      onDone(nextStatus, {
        hasVisitedBefore,
        welcomeCouponIssued: result.welcomeCouponIssued,
        ticket: result.ticket,
      })
    } catch (err) {
      console.error('[Onboarding] failed:', err)
      setSubmitError(onboardingErrorMessage(err))
      setSubmitting(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
      className="app-shell flex flex-col w-full mx-auto relative"
      style={{
        minHeight: '100dvh',
        height: 'auto',
        maxWidth: '100vw',
        overflowX: 'hidden',
        overflowY: 'auto',
        boxSizing: 'border-box',
        background:
          step === 0
            ? '#000'
            : 'radial-gradient(circle at 50% 0%, rgba(139,26,42,0.14), transparent 38%), linear-gradient(160deg, #080706 0%, #0a0909 48%, #0e0708 100%)',
      }}
    >
      {step > 0 && (
        <div
          className="flex justify-center gap-2 shrink-0"
          style={{
            paddingTop: 'max(22px, calc(env(safe-area-inset-top, 0px) + clamp(22px, 5.8svh, 44px)))',
            paddingBottom: 'clamp(16px, 3.4svh, 28px)',
          }}
        >
          {([1, 2] as const).map((i) => (
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

      <div
        className="flex-1 relative"
        style={{
          minHeight: 0,
          overflowX: 'hidden',
          overflowY: step === 0 ? 'hidden' : 'visible',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <AnimatePresence mode="wait">
          {step === 0 && (
            <motion.div
              key={0}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }}
              style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}
            >
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  backgroundImage: "url('/images/ginjiro-splash.png')",
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background:
                    'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, rgba(0,0,0,0.30) 45%, rgba(0,0,0,0.82) 100%)',
                  pointerEvents: 'none',
                  zIndex: 1,
                }}
              />

              <style>{`
                @keyframes gjSplashShimmer {
                  0% { background-position: -200% center; }
                  100% { background-position: 200% center; }
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
                    background:
                      'linear-gradient(90deg, rgba(212,175,55,0.85) 0%, rgba(255,250,210,0.97) 44%, rgba(255,255,255,0.95) 50%, rgba(255,250,210,0.97) 56%, rgba(212,175,55,0.85) 100%)',
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

              <button
                type="button"
                onClick={handleStart}
                style={{
                  position: 'absolute',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 56px)',
                  width: 'min(78vw, 320px)',
                  height: 52,
                  background: 'rgba(0, 0, 0, 0.55)',
                  border: '1px solid #8A6E3C',
                  color: '#C9A24A',
                  fontFamily: SERIF,
                  letterSpacing: '0.15em',
                  fontSize: 15,
                  borderRadius: 10,
                  backdropFilter: 'blur(8px)',
                  WebkitBackdropFilter: 'blur(8px)',
                  cursor: 'pointer',
                  zIndex: 2,
                }}
              >
                始める
              </button>

              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 32px)',
                  display: 'flex',
                  gap: 8,
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

          {step === 1 && (
            <motion.div
              key={1}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.32 }}
              style={{
                position: 'relative',
                width: '100%',
                flex: '1 1 auto',
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                padding: 'clamp(8px, 2.4svh, 22px) 0 max(24px, calc(env(safe-area-inset-bottom, 0px) + 24px))',
                boxSizing: 'border-box',
              }}
            >
              <style>{`
                @keyframes gjStepAura {
                  0%, 100% { opacity: 0.62; transform: scale(1.00); }
                  50% { opacity: 0.90; transform: scale(1.07); }
                }
              `}</style>

              <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
                <div style={{
                  position: 'absolute', top: '12%', left: '5%', right: '5%', height: '44%',
                  background: 'radial-gradient(ellipse at 50% 38%, rgba(74,14,23,0.68) 0%, rgba(40,5,12,0.36) 44%, transparent 70%)',
                  animation: 'gjStepAura 7s ease-in-out infinite',
                }} />
                <div style={{
                  position: 'absolute', bottom: '4%', left: '22%', right: '22%', height: '28%',
                  background: 'radial-gradient(ellipse at 50% 62%, rgba(60,10,18,0.36) 0%, transparent 68%)',
                  animation: 'gjStepAura 7s ease-in-out infinite',
                  animationDelay: '-3.5s',
                }} />
              </div>

              <div
                style={{
                  position: 'relative',
                  zIndex: 10,
                  width: '100%',
                  maxWidth: 430,
                  margin: '0 auto',
                  padding: '0 clamp(16px, 5vw, 28px)',
                  boxSizing: 'border-box',
                }}
              >
                <p style={{
                  fontSize: 'clamp(8px, 2.35vw, 9px)', letterSpacing: '0.34em', textTransform: 'uppercase',
                  color: 'rgba(201,162,39,0.38)', textAlign: 'center',
                  fontFamily: 'monospace', marginBottom: 'clamp(24px, 5.6svh, 38px)',
                }}>
                  Step 2 / 3
                </p>

                <h2 style={{
                  fontFamily: SERIF,
                  fontSize: 'clamp(23px, 6.9vw, 30px)',
                  fontWeight: 700,
                  color: '#F2E6C8',
                  letterSpacing: '0.06em',
                  lineHeight: 1.5,
                  textAlign: 'center',
                  textShadow: '0 2px 28px rgba(0,0,0,0.88)',
                  margin: '0 auto clamp(26px, 5.2svh, 34px)',
                  maxWidth: 392,
                  overflowWrap: 'normal',
                  wordBreak: 'keep-all',
                }}>
                  <span style={{ display: 'block', whiteSpace: 'nowrap' }}>二代目銀二郎を</span>
                  <span style={{ display: 'block', whiteSpace: 'nowrap' }}>ご利用いただいたことは</span>
                  <span style={{ display: 'block', whiteSpace: 'nowrap' }}>ありますか？</span>
                </h2>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
                    gap: 'clamp(10px, 3.2vw, 14px)',
                    width: '100%',
                  }}
                >
                  <ChoiceButton onClick={() => handleChooseVisited(true)}>はい</ChoiceButton>
                  <ChoiceButton onClick={() => handleChooseVisited(false)}>いいえ</ChoiceButton>
                </div>
              </div>
            </motion.div>
          )}

          {step === 2 && (
            <motion.div
              key={2}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.32 }}
              style={{
                position: 'relative',
                width: '100%',
                flex: '1 1 auto',
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                padding: 'clamp(8px, 2.4svh, 22px) 0 max(24px, calc(env(safe-area-inset-bottom, 0px) + 24px))',
                boxSizing: 'border-box',
              }}
            >
              <style>{`
                @keyframes gjStep2Aura {
                  0%, 100% { opacity: 0.62; transform: scale(1.00); }
                  50% { opacity: 0.90; transform: scale(1.07); }
                }
                @keyframes gjConicSpin {
                  from { transform: translate(-50%, -50%) rotate(0deg); }
                  to { transform: translate(-50%, -50%) rotate(360deg); }
                }
                @keyframes gjBtnShimmer {
                  0% { background-position: -200% center; }
                  100% { background-position: 200% center; }
                }
                .gj-name-input::placeholder {
                  color: rgba(212,175,55,0.28);
                  letter-spacing: 0.06em;
                }
              `}</style>

              <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
                <div style={{
                  position: 'absolute', top: '12%', left: '5%', right: '5%', height: '44%',
                  background: 'radial-gradient(ellipse at 50% 38%, rgba(74,14,23,0.68) 0%, rgba(40,5,12,0.36) 44%, transparent 70%)',
                  animation: 'gjStep2Aura 7s ease-in-out infinite',
                }} />
                <div style={{
                  position: 'absolute', bottom: '4%', left: '22%', right: '22%', height: '28%',
                  background: 'radial-gradient(ellipse at 50% 62%, rgba(60,10,18,0.36) 0%, transparent 68%)',
                  animation: 'gjStep2Aura 7s ease-in-out infinite',
                  animationDelay: '-3.5s',
                }} />
              </div>

              <div
                style={{
                  position: 'relative',
                  zIndex: 10,
                  width: '100%',
                  maxWidth: 430,
                  margin: '0 auto',
                  padding: '0 clamp(16px, 5vw, 28px)',
                  boxSizing: 'border-box',
                }}
              >
                <p style={{
                  fontSize: 'clamp(8px, 2.35vw, 9px)', letterSpacing: '0.34em', textTransform: 'uppercase',
                  color: 'rgba(201,162,39,0.38)', textAlign: 'center',
                  fontFamily: 'monospace', marginBottom: 'clamp(24px, 5.6svh, 38px)',
                }}>
                  Step 3 / 3
                </p>

                <h2 style={{
                  fontFamily: SERIF,
                  fontSize: 'clamp(23px, 6.9vw, 30px)',
                  fontWeight: 700,
                  color: '#F2E6C8',
                  letterSpacing: '0.06em',
                  lineHeight: 1.45,
                  textAlign: 'center',
                  textShadow: '0 2px 28px rgba(0,0,0,0.88)',
                  margin: '0 auto clamp(10px, 2.2svh, 14px)',
                  maxWidth: 392,
                  overflowWrap: 'normal',
                  wordBreak: 'keep-all',
                }}>
                  あなたのお名前は？
                </h2>

                <p style={{
                  fontSize: 'clamp(10px, 2.9vw, 12px)', letterSpacing: '0.12em', lineHeight: 1.7,
                  color: 'rgba(201,162,39,0.50)', textAlign: 'center',
                  fontFamily: SERIF, marginBottom: 'clamp(22px, 4.8svh, 32px)',
                }}>
                  この名で、男前証を発行します。
                </p>

                <div style={{
                  position: 'relative', marginBottom: 'clamp(12px, 2.4svh, 16px)', borderRadius: 16,
                  padding: inputFocused ? '2px' : '1.5px',
                  background: inputFocused ? 'transparent' : 'rgba(212,175,55,0.48)',
                }}>
                  {inputFocused && (
                    <div aria-hidden style={{ position: 'absolute', inset: 0, borderRadius: 16, overflow: 'hidden', zIndex: 0 }}>
                      <div style={{
                        position: 'absolute', top: '50%', left: '50%',
                        width: '280%', height: '280%',
                        background: 'conic-gradient(from 0deg at 50% 50%, #5c0f1a 0deg, #C9A24A 75deg, #F0E4C0 150deg, #C9A24A 225deg, #5c0f1a 310deg, #5c0f1a 360deg)',
                        animation: 'gjConicSpin 3s linear infinite',
                      }} />
                    </div>
                  )}
                  <input
                    type="text"
                    className="gj-name-input"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onFocus={() => setInputFocused(true)}
                    onBlur={() => setInputFocused(false)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void handleFinish()
                    }}
                    placeholder="例：銀二郎"
                    maxLength={20}
                    disabled={submitting}
                    style={{
                      position: 'relative', zIndex: 1,
                      display: 'block', width: '100%', boxSizing: 'border-box',
                      padding: 'clamp(15px, 3.8svh, 18px) clamp(16px, 5vw, 22px)',
                      background: 'rgba(10,5,3,0.97)',
                      border: 'none',
                      borderRadius: 13,
                      color: '#F2E6C8',
                      fontSize: 'clamp(17px, 5vw, 20px)',
                      fontFamily: SERIF,
                      letterSpacing: '0.08em',
                      textShadow: name ? '0 0 14px rgba(212,175,55,0.20)' : 'none',
                      caretColor: '#C9A24A',
                      outline: 'none',
                    }}
                  />
                </div>

                {submitError && (
                  <p style={{
                    margin: '0 0 clamp(10px, 2.4svh, 14px)',
                    color: '#E06060',
                    fontSize: 'clamp(11px, 3.1vw, 12px)',
                    lineHeight: 1.6,
                    textAlign: 'center',
                  }}>
                    {submitError}
                  </p>
                )}

                <div style={{ position: 'relative', borderRadius: 15, overflow: 'hidden' }}>
                  <div aria-hidden style={{
                    position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none',
                    background: 'linear-gradient(90deg, transparent 0%, rgba(255,248,210,0.10) 44%, rgba(255,255,255,0.08) 50%, rgba(255,248,210,0.10) 56%, transparent 100%)',
                    backgroundSize: '200% auto',
                    animation: 'gjBtnShimmer 3s linear infinite',
                  }} />
                  <button
                    type="button"
                    onClick={() => { void handleFinish() }}
                    disabled={submitting}
                    style={{
                      position: 'relative', zIndex: 1,
                      display: 'block', width: '100%',
                      minHeight: 'clamp(50px, 8.2svh, 58px)',
                      padding: 'clamp(14px, 3.6svh, 18px) 20px',
                      background: submitting
                        ? 'rgba(255,255,255,0.06)'
                        : 'linear-gradient(158deg, #3a0a12 0%, #6a1020 28%, #8B1A2A 55%, #6a1020 80%, #3a0a12 100%)',
                      border: '1px solid rgba(212,175,55,0.62)',
                      boxShadow: submitting
                        ? 'none'
                        : '0 10px 36px rgba(58,10,18,0.72), 0 2px 8px rgba(0,0,0,0.85), inset 0 1px 0 rgba(212,175,55,0.22), inset 0 -1px 0 rgba(0,0,0,0.4)',
                      borderRadius: 14,
                      color: submitting ? 'rgba(242,230,200,0.52)' : '#F2E6C8',
                      fontFamily: SERIF,
                      fontSize: 'clamp(14px, 4.2vw, 16px)',
                      fontWeight: 700,
                      letterSpacing: '0.18em',
                      cursor: submitting ? 'default' : 'pointer',
                      WebkitTapHighlightColor: 'transparent',
                    }}
                  >
                    {submitting ? '登録中...' : '入場'}
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
