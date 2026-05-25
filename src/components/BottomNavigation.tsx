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

// 'gacha' is intentionally excluded — feature is sealed but code is preserved for restoration
const TABS: NavTab[] = ['home', 'styles', 'diagnosis', 'tryon', 'reserve', 'mypage']

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
        background:
          'linear-gradient(180deg, rgba(23,20,15,0.96), rgba(8,8,8,0.98))',
        borderTop: '1px solid rgba(201,162,39,0.28)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        boxShadow: '0 -10px 30px rgba(0,0,0,0.42), inset 0 1px 0 rgba(245,240,232,0.04)',
      }}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0"
        style={{
          height: 1,
          background: 'linear-gradient(90deg, transparent, rgba(232,197,71,0.58), transparent)',
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
