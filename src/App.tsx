import { useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { PhoneStatusBar } from './components/PhoneStatusBar'
import { AppHeader } from './components/AppHeader'
import { BottomNavigation } from './components/BottomNavigation'
import { HomeScreen } from './screens/HomeScreen'
import { GachaScreen } from './screens/GachaScreen'
import { TryOnScreen } from './screens/TryOnScreen'
import { ReserveScreen } from './screens/ReserveScreen'
import { MyPageScreen } from './screens/MyPageScreen'
import { SplashScreen } from './screens/SplashScreen'
import { OnboardingScreen } from './screens/OnboardingScreen'
import { MOCK_MEMBER } from './data/brand'
import type { NavTab, MemberStatus } from './data/brand'
import { loadMemberStatus, saveMemberStatus, getStoredValue, ONBOARDING_DONE_KEY } from './utils/storage'

type AppPhase = 'splash' | 'onboarding' | 'app'

function App() {
  const [phase, setPhase] = useState<AppPhase>('splash')
  const [activeTab, setActiveTab] = useState<NavTab>('home')
  const [memberStatus, setMemberStatus] = useState<MemberStatus>(loadMemberStatus)

  function handleSplashDone() {
    const done = getStoredValue<boolean>(ONBOARDING_DONE_KEY, false)
    setPhase(done ? 'app' : 'onboarding')
  }

  function handleOnboardingDone(nextStatus: MemberStatus) {
    saveMemberStatus(nextStatus)
    setMemberStatus(nextStatus)
    setPhase('app')
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
      {/* Main app shell — always rendered beneath overlays */}
      <div className="app-shell flex flex-col h-dvh max-w-[430px] mx-auto overflow-hidden">
        <PhoneStatusBar />
        <AppHeader />
        <main className="app-main flex-1 overflow-y-auto">
          {activeTab === 'home' && <HomeScreen member={liveMember} onTabChange={setActiveTab} />}
          {activeTab === 'gacha' && <GachaScreen memberStatus={memberStatus} onMemberStatusChange={setMemberStatus} />}
          {activeTab === 'tryon' && <TryOnScreen />}
          {activeTab === 'reserve' && <ReserveScreen />}
          {activeTab === 'mypage' && <MyPageScreen memberStatus={memberStatus} onMemberStatusChange={setMemberStatus} />}
        </main>
        <BottomNavigation active={activeTab} onChange={setActiveTab} />
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
    </>
  )
}

export default App
