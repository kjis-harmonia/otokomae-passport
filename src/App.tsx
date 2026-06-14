import { useState, useCallback, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AppHeader } from './components/AppHeader'
import { BottomNavigation } from './components/BottomNavigation'
import { HomeScreen } from './screens/HomeScreen'
import { GachaScreen } from './screens/GachaScreen'
import { TryOnScreen } from './screens/TryOnScreen'
import { ReserveScreen } from './screens/ReserveScreen'
import { MyPageScreen } from './screens/MyPageScreen'
import { StyleLibraryScreen } from './screens/StyleLibraryScreen'
import { DiagnosisScreen } from './screens/DiagnosisScreen'
import { OnboardingScreen } from './screens/OnboardingScreen'
import { GinjiroLoadingScreen } from './screens/GinjiroLoadingScreen'
import PremiumGachaExperience from './components/PremiumGachaExperience'
import type { GachaResult } from './components/PremiumGachaExperience'
import { MOCK_MEMBER } from './data/brand'
import type { NavTab, MemberStatus } from './data/brand'
import { loadMemberStatus, saveMemberStatus, getStoredValue, ONBOARDING_DONE_KEY } from './utils/storage'
import { HERO_SLIDE_IMAGES } from './data/styleImages'
import type { TicketRow } from './data/ticket'
import { TICKET_TYPE_LABELS, TICKET_TYPE_COLORS } from './data/ticket'
import { getTicketByTransferToken, acceptTransfer } from './utils/ticketStore'
import { getUserId } from './utils/userId'
import { useBgm } from './hooks/useBgm'
import { seedDevData } from './utils/devSeed'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const MUSIC_GUIDE_KEY = 'ginjiro_music_guided'

type AppPhase = 'onboarding' | 'app'
type TransferPhase = 'preview' | 'accepting' | 'done' | 'error'

// ── Music Guide Popup (one-time, first home screen visit) ─────────────────────
function MusicGuidePopup({ onDismiss }: { onDismiss: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.30 }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 300,
        background: 'rgba(0,0,0,0.82)',
        backdropFilter: 'blur(5px)',
        WebkitBackdropFilter: 'blur(5px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.90, y: 20 }}
        animate={{ opacity: 1, scale: 1,    y: 0  }}
        exit={{    opacity: 0, scale: 0.94,  y: 8  }}
        transition={{ duration: 0.38, ease: [0.22, 0.68, 0.34, 1.0] }}
        style={{
          width: '100%',
          maxWidth: 360,
          borderRadius: 28,
          background: 'linear-gradient(162deg, #0e0b06 0%, #080602 100%)',
          border: '1px solid rgba(212,175,55,0.30)',
          boxShadow: [
            '0 36px 90px rgba(0,0,0,0.95)',
            '0 0 0 0.5px rgba(212,175,55,0.10)',
            'inset 0 1px 0 rgba(212,175,55,0.16)',
          ].join(', '),
          padding: '36px 28px 30px',
        }}
      >
        {/* Record icon medallion */}
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div style={{
            width: 60,
            height: 60,
            borderRadius: '50%',
            background: 'rgba(212,175,55,0.06)',
            border: '1px solid rgba(212,175,55,0.30)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 22px rgba(212,175,55,0.18), inset 0 1px 0 rgba(212,175,55,0.10)',
          }}>
            <svg width="30" height="30" viewBox="0 0 19 19" fill="none" aria-hidden>
              <circle cx="9.5" cy="9.5" r="8.5" stroke="#d4af37" strokeWidth="1"    fill="rgba(0,0,0,0.20)" />
              <circle cx="9.5" cy="9.5" r="6.8" stroke="#d4af37" strokeWidth="0.45" fill="none" opacity="0.45" />
              <circle cx="9.5" cy="9.5" r="5.5" stroke="#d4af37" strokeWidth="0.35" fill="none" opacity="0.30" />
              <circle cx="9.5" cy="9.5" r="3.8" stroke="#d4af37" strokeWidth="0.8"  fill="rgba(0,0,0,0.35)" />
              <circle cx="9.5" cy="9.5" r="1.3" fill="#d4af37" />
            </svg>
          </div>
        </div>

        {/* Header */}
        <h2 style={{
          fontFamily: SERIF,
          fontSize: 20,
          fontWeight: 700,
          color: '#e6ca65',
          textAlign: 'center',
          letterSpacing: '0.10em',
          marginBottom: 18,
          textShadow: '0 2px 14px rgba(212,175,55,0.30)',
        }}>
          🎵 音楽について
        </h2>

        {/* Divider */}
        <div style={{
          height: '0.5px',
          background: 'linear-gradient(90deg, transparent, rgba(212,175,55,0.28) 30%, rgba(212,175,55,0.28) 70%, transparent)',
          marginBottom: 24,
        }} />

        {/* Body */}
        <p style={{
          fontFamily: SERIF,
          fontSize: 16,
          lineHeight: 2.1,
          color: '#F2E6C8',
          textAlign: 'center',
          letterSpacing: '0.05em',
          marginBottom: 10,
        }}>
          銀二郎テーマソングは<br />
          ホーム画面右上の<br />
          レコード盤から<br />
          いつでも ON / OFF を<br />
          切り替えできます。
        </p>
        <p style={{
          fontFamily: SERIF,
          fontSize: 13,
          lineHeight: 1.8,
          color: 'rgba(242,230,200,0.46)',
          textAlign: 'center',
          letterSpacing: '0.06em',
          marginBottom: 28,
        }}>
          ごゆっくりお楽しみください。
        </p>

        {/* CTA */}
        <motion.button
          type="button"
          onClick={onDismiss}
          whileTap={{ scale: 0.97 }}
          style={{
            width: '100%',
            padding: '17px 0',
            borderRadius: 16,
            background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 58%, #8B1A1A 100%)',
            border: '1px solid rgba(212,175,55,0.46)',
            boxShadow: [
              '0 4px 28px rgba(107,15,18,0.58)',
              '0 0 14px rgba(212,175,55,0.10)',
            ].join(', '),
            fontFamily: SERIF,
            fontSize: 17,
            fontWeight: 700,
            letterSpacing: '0.26em',
            color: '#F2E6C8',
            cursor: 'pointer',
          }}
        >
          男前開始
        </motion.button>
      </motion.div>
    </motion.div>
  )
}

function App() {
  // テストデータを localStorage に1度だけ投入
  seedDevData()

  // ── Loading state: min time + critical image preload ──────────────────────────
  const [minTimeDone, setMinTimeDone] = useState(false)
  const [imgReady,    setImgReady]    = useState(false)
  const appLoading = !minTimeDone || !imgReady

  useEffect(() => {
    const t = setTimeout(() => setMinTimeDone(true), 1300)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    const urls = [
      '/images/ginjiro-splash.png',
      HERO_SLIDE_IMAGES[0]?.src,
      HERO_SLIDE_IMAGES[1]?.src,
    ].filter(Boolean) as string[]

    let remaining = urls.length
    const onSettled = () => { if (--remaining <= 0) setImgReady(true) }
    urls.forEach(src => {
      const img = new Image()
      img.onload  = onSettled
      img.onerror = onSettled
      img.src = src
    })
  }, [])

  // ── Phase ─────────────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<AppPhase>(() => {
    const done = getStoredValue<boolean>(ONBOARDING_DONE_KEY, false)
    return done ? 'app' : 'onboarding'
  })
  const [activeTab, setActiveTab] = useState<NavTab>(() => {
    const tab = new URLSearchParams(window.location.search).get('tab')
    const valid: NavTab[] = ['home', 'styles', 'diagnosis', 'tryon', 'reserve', 'mypage']
    return valid.includes(tab as NavTab) ? (tab as NavTab) : 'home'
  })
  const [memberStatus, setMemberStatus] = useState<MemberStatus>(loadMemberStatus)
  const [isPremiumGachaOpen, setIsPremiumGachaOpen] = useState(false)
  const [hasOpenModal, setHasOpenModal] = useState(false)

  // ── Transfer acceptance overlay ───────────────────────────────────────────────
  const [transferToken, setTransferToken]   = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('transfer')
  )
  const [transferTicket, setTransferTicket] = useState<TicketRow | null>(null)
  const [transferPhase, setTransferPhase]   = useState<TransferPhase>('preview')
  const [transferError, setTransferError]   = useState<string | null>(null)
  const [acceptedTicket, setAcceptedTicket] = useState<TicketRow | null>(null)

  useEffect(() => {
    if (!transferToken) return
    getTicketByTransferToken(transferToken)
      .then(t => setTransferTicket(t))
      .catch(() => setTransferTicket(null))
    window.history.replaceState({}, '', window.location.pathname)
  }, [transferToken]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAcceptTransfer() {
    if (!transferToken) return
    setTransferPhase('accepting')
    try {
      const ticket = await acceptTransfer(transferToken, getUserId())
      setAcceptedTicket(ticket)
      setTransferPhase('done')
    } catch (e) {
      setTransferError(e instanceof Error ? e.message : '受け取りに失敗しました')
      setTransferPhase('error')
    }
  }

  function handleDismissTransfer() {
    setTransferToken(null)
    setTransferTicket(null)
    setTransferPhase('preview')
    setTransferError(null)
    setAcceptedTicket(null)
  }

  const handleModalChange = useCallback((open: boolean) => {
    setHasOpenModal(open)
  }, [])

  function handleOnboardingDone(nextStatus: MemberStatus) {
    saveMemberStatus(nextStatus)
    setMemberStatus(nextStatus)
    setPhase('app')
  }

  const handleTabChange = useCallback((tab: NavTab) => {
    setActiveTab(tab)
    if (tab === 'gacha') setIsPremiumGachaOpen(true)
  }, [])

  const handleGachaComplete = useCallback((result: GachaResult) => {
    console.log('[PremiumGacha] result:', result)
  }, [])

  const handleGachaClose = useCallback(() => {
    setIsPremiumGachaOpen(false)
  }, [])

  const bgm = useBgm()

  // ── Music guide — show once after first home screen mount ─────────────────────
  const [showMusicGuide, setShowMusicGuide] = useState(false)

  useEffect(() => {
    if (phase !== 'app') return
    if (localStorage.getItem(MUSIC_GUIDE_KEY) === 'true') return
    const t = setTimeout(() => setShowMusicGuide(true), 700)
    return () => clearTimeout(t)
  }, [phase])

  function dismissMusicGuide() {
    localStorage.setItem(MUSIC_GUIDE_KEY, 'true')
    setShowMusicGuide(false)
  }

  const liveMember = {
    ...MOCK_MEMBER,
    name: memberStatus.memberName,
    rank: memberStatus.rank,
    points: memberStatus.points,
    visitCount: memberStatus.visitCount,
  }

  return (
    <>
      {/* ── Phase-based render: onboarding OR app — never both ── */}
      {phase === 'onboarding' ? (

        /* StartScreen: standalone fullscreen, HomeScreen is NOT mounted */
        <OnboardingScreen
          memberStatus={memberStatus}
          onDone={handleOnboardingDone}
        />

      ) : (

        /* App shell: mounted only after onboarding completes */
        <>
          <div className="app-shell flex flex-col h-dvh max-w-[430px] mx-auto overflow-hidden">
{activeTab !== 'home' && <AppHeader />}
            <main className="app-main flex-1 overflow-y-auto">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={activeTab}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                >
                  {activeTab === 'home'      && <HomeScreen member={liveMember} onTabChange={handleTabChange} onModalChange={handleModalChange} />}
                  {activeTab === 'gacha'     && <GachaScreen memberStatus={memberStatus} onMemberStatusChange={setMemberStatus} />}
                  {activeTab === 'tryon'     && <TryOnScreen />}
                  {activeTab === 'reserve'   && <ReserveScreen />}
                  {activeTab === 'styles'    && <StyleLibraryScreen onTabChange={handleTabChange} onModalChange={handleModalChange} />}
                  {activeTab === 'diagnosis' && <DiagnosisScreen onTabChange={handleTabChange} onModalChange={handleModalChange} />}
                  {activeTab === 'mypage'    && <MyPageScreen memberStatus={memberStatus} onMemberStatusChange={setMemberStatus} />}
                </motion.div>
              </AnimatePresence>
            </main>
            {!hasOpenModal && <BottomNavigation active={activeTab} onChange={handleTabChange} />}
          </div>

          {/* BGM toggle — fixed top-right, visible on home tab only */}
          {activeTab === 'home' && (
            <>
              <style>{`
                @keyframes bgmRecordSpin {
                  from { transform: rotate(0deg); }
                  to   { transform: rotate(360deg); }
                }
                @keyframes bgmRecordPulse {
                  0%   { box-shadow: 0 0 0  0px rgba(212,175,55,0.00); }
                  35%  { box-shadow: 0 0 0 10px rgba(212,175,55,0.42), 0 0 28px rgba(212,175,55,0.24); }
                  65%  { box-shadow: 0 0 0  5px rgba(212,175,55,0.22), 0 0 14px rgba(212,175,55,0.12); }
                  100% { box-shadow: 0 0 0  0px rgba(212,175,55,0.00); }
                }
              `}</style>

              {/* Pulse ring — golden aura around record button when music guide is open */}
              {showMusicGuide && (
                <div
                  aria-hidden
                  style={{
                    position: 'fixed',
                    top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
                    right: 16,
                    width: 36,
                    height: 36,
                    borderRadius: '50%',
                    zIndex: 319,
                    pointerEvents: 'none',
                    animation: 'bgmRecordPulse 2.6s ease-in-out 2',
                  }}
                />
              )}

              <button
                type="button"
                onClick={bgm.toggle}
                aria-label={bgm.isOn ? 'BGMをOFFにする' : 'BGMをONにする'}
                style={{
                  position: 'fixed',
                  top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
                  right: 16,
                  zIndex: showMusicGuide ? 320 : 120,
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: bgm.isOn ? 'rgba(12,6,2,0.88)' : 'rgba(8,4,2,0.72)',
                  border: `1.5px solid ${bgm.isOn ? 'rgba(201,162,74,0.82)' : 'rgba(201,162,74,0.18)'}`,
                  boxShadow: bgm.isOn
                    ? '0 0 16px rgba(201,162,74,0.40), 0 0 6px rgba(201,162,74,0.22), 0 2px 10px rgba(0,0,0,0.6)'
                    : '0 2px 8px rgba(0,0,0,0.45)',
                  color: bgm.isOn ? '#C9A24A' : 'rgba(201,162,74,0.30)',
                  cursor: 'pointer',
                  backdropFilter: 'blur(14px)',
                  WebkitBackdropFilter: 'blur(14px)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  WebkitTapHighlightColor: 'transparent',
                  opacity: bgm.isOn ? 1 : 0.58,
                  transition: 'border-color 0.25s, box-shadow 0.25s, color 0.25s, opacity 0.25s',
                }}
              >
                {/* レコード盤アイコン */}
                <svg
                  width="19"
                  height="19"
                  viewBox="0 0 19 19"
                  fill="none"
                  aria-hidden="true"
                  style={{
                    animation: bgm.isOn ? 'bgmRecordSpin 5s linear infinite' : 'none',
                  }}
                >
                  {/* 外周 */}
                  <circle cx="9.5" cy="9.5" r="8.5" stroke="currentColor" strokeWidth="1" fill="rgba(0,0,0,0.20)" />
                  {/* 外側グルーヴ */}
                  <circle cx="9.5" cy="9.5" r="6.8" stroke="currentColor" strokeWidth="0.45" fill="none" opacity="0.45" />
                  {/* 内側グルーヴ */}
                  <circle cx="9.5" cy="9.5" r="5.5" stroke="currentColor" strokeWidth="0.35" fill="none" opacity="0.30" />
                  {/* レーベル面 */}
                  <circle cx="9.5" cy="9.5" r="3.8" stroke="currentColor" strokeWidth="0.8" fill="rgba(0,0,0,0.35)" />
                  {/* センタースピンドル */}
                  <circle cx="9.5" cy="9.5" r="1.3" fill="currentColor" />
                </svg>
              </button>
            </>
          )}

          {/* Music guide — one-time popup, first home screen visit */}
          <AnimatePresence>
            {showMusicGuide && (
              <MusicGuidePopup key="music-guide" onDismiss={dismissMusicGuide} />
            )}
          </AnimatePresence>

          {isPremiumGachaOpen && (
            <PremiumGachaExperience
              onClose={handleGachaClose}
              onComplete={handleGachaComplete}
            />
          )}

          {transferToken && (
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.26 }}
                style={{ width: '100%', maxWidth: 380, borderRadius: 24, background: 'linear-gradient(160deg, #160a07 0%, #0a0504 100%)', border: '1px solid rgba(201,162,74,0.28)', boxShadow: '0 24px 64px rgba(0,0,0,0.9)', padding: '28px 24px 24px' }}
              >
                {(transferPhase === 'preview' || transferPhase === 'accepting') && (
                  <>
                    <p style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 700, color: '#F2E6C8', textAlign: 'center', lineHeight: 1.5, marginBottom: 16 }}>
                      チケットを受け取りますか？
                    </p>

                    {transferTicket ? (() => {
                      const tc = TICKET_TYPE_COLORS[transferTicket.type]
                      return (
                        <div style={{ borderRadius: 12, background: tc.bg, border: `1px solid ${tc.border}`, padding: '12px 16px', marginBottom: 16 }}>
                          <p style={{ fontSize: 9, fontWeight: 700, color: tc.text, letterSpacing: '0.14em', marginBottom: 4 }}>{TICKET_TYPE_LABELS[transferTicket.type]}</p>
                          <p style={{ fontSize: 16, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF }}>{transferTicket.title}</p>
                          {transferTicket.expires_at && <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.4)', marginTop: 4 }}>期限 {new Date(transferTicket.expires_at).toLocaleDateString('ja-JP')}</p>}
                        </div>
                      )
                    })() : (
                      <div style={{ borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', padding: '12px 16px', marginBottom: 16, textAlign: 'center' }}>
                        <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.44)' }}>チケット情報を取得中…</p>
                      </div>
                    )}

                    <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.36)', textAlign: 'center', lineHeight: 1.7, marginBottom: 20 }}>
                      受け取ると、あなたのチケット一覧に追加されます。{'\n'}
                      この操作は取り消せません。
                    </p>

                    <div style={{ display: 'flex', gap: 10 }}>
                      <button type="button" onClick={handleDismissTransfer} disabled={transferPhase === 'accepting'}
                        style={{ flex: 1, padding: '13px 0', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', fontSize: 13, color: 'rgba(242,230,200,0.52)', fontFamily: SERIF, letterSpacing: '0.14em', cursor: 'pointer' }}>
                        断る
                      </button>
                      <button type="button" onClick={handleAcceptTransfer} disabled={transferPhase === 'accepting'}
                        style={{ flex: 2, padding: '13px 0', borderRadius: 14, background: 'linear-gradient(135deg, #5a3a00 0%, #9a6800 60%, #c9a24a 100%)', border: '1px solid rgba(201,162,74,0.5)', boxShadow: '0 4px 20px rgba(100,80,0,0.4)', fontSize: 13, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF, letterSpacing: '0.16em', cursor: transferPhase === 'accepting' ? 'default' : 'pointer' }}>
                        {transferPhase === 'accepting' ? '処理中…' : '受け取る'}
                      </button>
                    </div>
                  </>
                )}

                {transferPhase === 'done' && acceptedTicket && (() => {
                  const tc = TICKET_TYPE_COLORS[acceptedTicket.type]
                  return (
                    <>
                      <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(100,200,100,0.1)', border: '1px solid rgba(100,200,100,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                        <span style={{ fontSize: 22 }}>✓</span>
                      </div>
                      <p style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 700, color: '#F2E6C8', textAlign: 'center', marginBottom: 12 }}>受け取りました</p>
                      <div style={{ borderRadius: 12, background: tc.bg, border: `1px solid ${tc.border}`, padding: '12px 16px', marginBottom: 20, textAlign: 'center' }}>
                        <p style={{ fontSize: 15, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF }}>{acceptedTicket.title}</p>
                      </div>
                      <button type="button" onClick={handleDismissTransfer}
                        style={{ width: '100%', padding: '13px 0', borderRadius: 14, background: 'rgba(201,162,74,0.12)', border: '1px solid rgba(201,162,74,0.36)', color: '#C9A24A', fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.16em', cursor: 'pointer' }}>
                        閉じる
                      </button>
                    </>
                  )
                })()}

                {transferPhase === 'error' && (
                  <>
                    <p style={{ fontSize: 14, color: '#E06060', textAlign: 'center', marginBottom: 16, lineHeight: 1.6 }}>
                      {transferError ?? '受け取りに失敗しました'}
                    </p>
                    <button type="button" onClick={handleDismissTransfer}
                      style={{ width: '100%', padding: '13px 0', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(242,230,200,0.52)', fontFamily: SERIF, fontSize: 13, letterSpacing: '0.14em', cursor: 'pointer' }}>
                      閉じる
                    </button>
                  </>
                )}
              </motion.div>
            </div>
          )}
        </>
      )}

      {/* Loading screen — topmost, covers everything during initial load */}
      <AnimatePresence>
        {appLoading && <GinjiroLoadingScreen key="loading" />}
      </AnimatePresence>
    </>
  )
}

export default App
