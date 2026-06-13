import type React from 'react'
import { Home, Gift, Shirt, BookOpen, ClipboardList, CalendarDays, UserCircle } from 'lucide-react'
import type { NavTab } from '../data/brand'

interface Props {
  active: NavTab
  onChange: (tab: NavTab) => void
}

const TAB_LABELS: Record<NavTab, string> = {
  home: 'ホーム',
  gacha: 'ガチャ',
  tryon: '試着',
  styles: '図鑑',
  diagnosis: '診断',
  reserve: '予約',
  mypage: 'マイ',
}

// Excluded from nav — sealed until complete, code preserved for restoration:
// 'gacha'   — gacha feature
// 'tryon'   — try-on feature (coming soon)
// 'reserve' — reservation feature (coming soon)
// 'mypage'  — temporarily hidden; features migrating to HomeScreen
const TABS: NavTab[] = ['home', 'styles', 'diagnosis']

function TabIcon({ id }: { id: NavTab }) {
  switch (id) {
    case 'home':      return <Home size={20} strokeWidth={1.8} />
    case 'gacha':     return <Gift size={20} strokeWidth={1.8} />
    case 'tryon':     return <Shirt size={20} strokeWidth={1.8} />
    case 'styles':    return <BookOpen size={20} strokeWidth={1.8} />
    case 'diagnosis': return <ClipboardList size={20} strokeWidth={1.8} />
    case 'reserve':   return <CalendarDays size={20} strokeWidth={1.8} />
    case 'mypage':    return <UserCircle size={20} strokeWidth={1.8} />
  }
}

export function BottomNavigation({ active, onChange }: Props) {
  return (
    <nav
      className="relative flex shrink-0 overflow-hidden"
      style={{
        background: 'rgba(7,5,3,0.76)',
        backdropFilter: 'blur(24px) saturate(1.6)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.6)',
        borderTop: '1px solid rgba(201,162,39,0.22)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        boxShadow: '0 -12px 36px rgba(0,0,0,0.38), inset 0 1px 0 rgba(245,240,232,0.04)',
      } as React.CSSProperties}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0"
        style={{
          height: 1,
          background: 'linear-gradient(90deg, transparent, rgba(232,197,71,0.46), transparent)',
        }}
      />
      {TABS.map(tab => (
        <button
          key={tab}
          type="button"
          onClick={() => onChange(tab)}
          className="relative flex flex-col items-center justify-center gap-1 flex-1 py-3.5 text-[10px] tracking-wider transition-colors active:opacity-70"
          style={{
            color: active === tab ? '#E8C547' : 'rgba(245,240,232,0.34)',
            textShadow: active === tab ? '0 0 14px rgba(201,162,39,0.36)' : 'none',
          }}
        >
          {active === tab && (
            <span
              className="absolute top-1 h-0.5 w-6 rounded-full"
              style={{
                background: 'linear-gradient(90deg, transparent, #E8C547, transparent)',
                boxShadow: '0 0 12px rgba(232,197,71,0.5)',
              }}
            />
          )}
          <TabIcon id={tab} />
          <span>{TAB_LABELS[tab]}</span>
        </button>
      ))}
    </nav>
  )
}
