import { useState, useCallback } from 'react'
import { AnimatePresence } from 'framer-motion'
import { PhoneStatusBar } from './components/PhoneStatusBar'
import { AppHeader } from './components/AppHeader'
import { BottomNavigation } from './components/BottomNavigation'
import { HomeScreen } from './screens/HomeScreen'
import { GachaScreen } from './screens/GachaScreen'
import { TryOnScreen } from './screens/TryOnScreen'
import { ReserveScreen } from './screens/ReserveScreen'
import { MyPageScreen } from './screens/MyPageScreen'
import { StyleLibraryScreen } from './screens/StyleLibraryScreen'
import { DiagnosisScreen } from './screens/DiagnosisScreen'
import { SplashScreen } from './screens/SplashScreen'
import { OnboardingScreen } from './screens/OnboardingScreen'
import PremiumGachaExperience from './components/PremiumGachaExperience'
import type { GachaResult } from './components/PremiumGachaExperience'
import { MOCK_MEMBER } from './data/brand'
import type { NavTab, MemberStatus } from './data/brand'
import { loadMemberStatus, saveMemberStatus, getStoredValue, ONBOARDING_DONE_KEY } from './utils/storage'

type AppPhase = 'splash' | 'onboarding' | 'app'

function App() {
  const [phase, setPhase] = useState<AppPhase>('splash')
  const [activeTab, setActiveTab] = useState<NavTab>(() => {
    const tab = new URLSearchParams(window.location.search).get('tab')
    const valid: NavTab[] = ['home', 'styles', 'diagnosis', 'tryon', 'reserve', 'mypage']
    return valid.includes(tab as NavTab) ? (tab as NavTab) : 'home'
  })
  const [memberStatus, setMemberStatus] = useState<MemberStatus>(loadMemberStatus)
  const [isPremiumGachaOpen, setIsPremiumGachaOpen] = useState(false)

  function handleSplashDone() {
    const done = getStoredValue<boolean>(ONBOARDING_DONE_KEY, false)
    setPhase(done ? 'app' : 'onboarding')
  }

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
        <PhoneStatusBar />
        {activeTab !== 'home' && <AppHeader />}
        <main className="app-main flex-1 overflow-y-auto">
          {activeTab === 'home' && <HomeScreen member={liveMember} onTabChange={handleTabChange} />}
          {activeTab === 'gacha' && <GachaScreen memberStatus={memberStatus} onMemberStatusChange={setMemberStatus} />}
          {activeTab === 'tryon' && <TryOnScreen />}
          {activeTab === 'reserve' && <ReserveScreen />}
          {activeTab === 'styles' && <StyleLibraryScreen onTabChange={handleTabChange} />}
          {activeTab === 'diagnosis' && <DiagnosisScreen onTabChange={handleTabChange} />}
          {activeTab === 'mypage' && <MyPageScreen memberStatus={memberStatus} onMemberStatusChange={setMemberStatus} />}
        </main>
        <BottomNavigation active={activeTab} onChange={handleTabChange} />
      </div>

      {/* Onboarding overlay — appears above app shell on first launch */}
      <AnimatePresence>
        {phase === 'onboarding' && (
          <OnboardingScreen
            key="onboarding"
            memberStatus={memberStatus}
            onDone={handleOnboardingDone}
          />
        )}
      </AnimatePresence>

      {/* Splash overlay — topmost, fades out revealing whatever is beneath */}
      <AnimatePresence>
        {phase === 'splash' && (
          <SplashScreen key="splash" onDone={handleSplashDone} />
        )}
      </AnimatePresence>

      {/* Premium Gacha — full-screen, above everything except splash/onboarding */}
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
