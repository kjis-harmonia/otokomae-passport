import { useState, useCallback, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { QRCodeSVG } from 'qrcode.react'
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
import PremiumGachaExperience from './components/PremiumGachaExperience'
import type { GachaResult } from './components/PremiumGachaExperience'
import { MOCK_MEMBER } from './data/brand'
import type { NavTab, MemberStatus } from './data/brand'
import { loadMemberStatus, saveMemberStatus, getStoredValue, ONBOARDING_DONE_KEY } from './utils/storage'
import type { TicketRow } from './data/ticket'
import { TICKET_TYPE_LABELS, TICKET_TYPE_COLORS } from './data/ticket'
import { getTicketByTransferToken, acceptTransfer } from './utils/ticketStore'
import { getUserId } from './utils/userId'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

type AppPhase = 'onboarding' | 'app'
type TransferPhase = 'preview' | 'accepting' | 'done' | 'error'

function App() {
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

  // ── Transfer acceptance overlay ──────────────────────────────────────────────
  const [transferToken, setTransferToken]     = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('transfer')
  )
  const [transferTicket, setTransferTicket]   = useState<TicketRow | null>(null)
  const [transferPhase, setTransferPhase]     = useState<TransferPhase>('preview')
  const [transferError, setTransferError]     = useState<string | null>(null)
  const [acceptedTicket, setAcceptedTicket]   = useState<TicketRow | null>(null)

  useEffect(() => {
    if (!transferToken) return
    // トークン付きURLを開いた時点でチケット情報を取得
    getTicketByTransferToken(transferToken)
      .then(t => setTransferTicket(t))
      .catch(() => setTransferTicket(null))
    // URLからtransferパラメータを除去（リロード時の再表示を防ぐ）
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

  // Intercept the "gacha" tab to open the premium experience full-screen.
  const handleTabChange = useCallback((tab: NavTab) => {
    setActiveTab(tab)
    if (tab === 'gacha') {
      setIsPremiumGachaOpen(true)
    }
  }, [])

  const handleGachaComplete = useCallback((result: GachaResult) => {
    console.log('[PremiumGacha] result:', result)
  }, [])

  const handleGachaClose = useCallback(() => {
    setIsPremiumGachaOpen(false)
  }, [])

  const liveMember = {
    ...MOCK_MEMBER,
    name: memberStatus.memberName,
    rank: memberStatus.rank,
    points: memberStatus.points,
    visitCount: memberStatus.visitCount,
  }

  return (
    <>
      {/* Main app shell — always rendered beneath overlays */}
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

      {/* Onboarding — full-screen splash on first launch */}
      <AnimatePresence>
        {phase === 'onboarding' && (
          <OnboardingScreen
            key="onboarding"
            memberStatus={memberStatus}
            onDone={handleOnboardingDone}
          />
        )}
      </AnimatePresence>

      {/* Premium Gacha — full-screen, above everything except onboarding */}
      {isPremiumGachaOpen && (
        <PremiumGachaExperience
          onClose={handleGachaClose}
          onComplete={handleGachaComplete}
        />
      )}

      {/* Transfer acceptance overlay — shown when app is opened via ?transfer=TOKEN */}
      {transferToken && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.26 }}
            style={{ width: '100%', maxWidth: 380, borderRadius: 24, background: 'linear-gradient(160deg, #160a07 0%, #0a0504 100%)', border: '1px solid rgba(201,162,74,0.28)', boxShadow: '0 24px 64px rgba(0,0,0,0.9)', padding: '28px 24px 24px' }}
          >
            {/* preview / accepting */}
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

            {/* done */}
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

            {/* error */}
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
  )
}

export default App
