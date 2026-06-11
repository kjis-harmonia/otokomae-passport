import { useState, useCallback } from 'react'
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
import PremiumGachaExperience from './components/PremiumGachaExperience'
import type { GachaResult } from './components/PremiumGachaExperience'
import { MOCK_MEMBER } from './data/brand'
import type { NavTab, MemberStatus } from './data/brand'
import { loadMemberStatus, saveMemberStatus, getStoredValue, ONBOARDING_DONE_KEY } from './utils/storage'

type AppPhase = 'onboarding' | 'app'

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
    </>
  )
}

export default App
