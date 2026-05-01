import { Home, Gift, Shirt, CalendarDays, UserCircle } from 'lucide-react'
import type { NavTab } from '../data/brand'

interface Props {
  active: NavTab
  onChange: (tab: NavTab) => void
}

const TAB_LABELS: Record<NavTab, string> = {
  home: 'ホーム',
  gacha: 'ガチャ',
  tryon: '試着',
  reserve: '予約',
  mypage: 'マイ',
}

const TABS: NavTab[] = ['home', 'gacha', 'tryon', 'reserve', 'mypage']

function TabIcon({ id }: { id: NavTab }) {
  switch (id) {
    case 'home':    return <Home size={22} strokeWidth={1.8} />
    case 'gacha':   return <Gift size={22} strokeWidth={1.8} />
    case 'tryon':   return <Shirt size={22} strokeWidth={1.8} />
    case 'reserve': return <CalendarDays size={22} strokeWidth={1.8} />
    case 'mypage':  return <UserCircle size={22} strokeWidth={1.8} />
  }
}

export function BottomNavigation({ active, onChange }: Props) {
  return (
    <nav
      className="flex shrink-0"
      style={{
        background: '#111111',
        borderTop: '1px solid rgba(201,162,39,0.18)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      {TABS.map(tab => (
        <button
          key={tab}
          type="button"
          onClick={() => onChange(tab)}
          className="flex flex-col items-center justify-center gap-1 flex-1 py-3 text-[10px] tracking-wider transition-colors"
          style={{ color: active === tab ? '#C9A227' : '#666666' }}
        >
          <TabIcon id={tab} />
          <span>{TAB_LABELS[tab]}</span>
        </button>
      ))}
    </nav>
  )
}
