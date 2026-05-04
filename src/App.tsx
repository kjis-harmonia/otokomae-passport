import { useState } from 'react'
import { PhoneStatusBar } from './components/PhoneStatusBar'
import { AppHeader } from './components/AppHeader'
import { BottomNavigation } from './components/BottomNavigation'
import { HomeScreen } from './screens/HomeScreen'
import { GachaScreen } from './screens/GachaScreen'
import { TryOnScreen } from './screens/TryOnScreen'
import { ReserveScreen } from './screens/ReserveScreen'
import { MyPageScreen } from './screens/MyPageScreen'
import { MOCK_MEMBER } from './data/brand'
import type { NavTab, MemberStatus } from './data/brand'
import { loadMemberStatus } from './utils/storage'

function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('home')
  const [memberStatus, setMemberStatus] = useState<MemberStatus>(loadMemberStatus)

  const liveMember = {
    ...MOCK_MEMBER,
    rank: memberStatus.rank,
    points: memberStatus.points,
    visitCount: memberStatus.visitCount,
  }

  return (
    <div
      className="app-shell flex flex-col h-dvh max-w-[430px] mx-auto overflow-hidden"
    >
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
  )
}

export default App
