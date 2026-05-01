import { Scissors, Bell } from 'lucide-react'
import { BRAND } from '../data/brand'

export function AppHeader() {
  function handleNotificationClick() {
    window.alert('お知らせ機能は近日公開予定です')
  }

  return (
    <header
      className="flex items-center justify-between px-5 py-3 shrink-0"
      style={{ background: '#0D0D0D', borderBottom: '1px solid rgba(201,162,39,0.18)' }}
    >
      <div className="flex items-center gap-3">
        <div
          className="p-1.5 rounded-lg"
          style={{
            background: 'rgba(201,162,39,0.08)',
            border: '1px solid rgba(201,162,39,0.22)',
          }}
        >
          <Scissors
            size={16}
            strokeWidth={2}
            style={{ color: '#C9A227', transform: 'rotate(270deg)' }}
          />
        </div>
        <div>
          <p className="text-base font-bold tracking-widest leading-none" style={{ color: '#F5F0E8' }}>
            {BRAND.shopName}
          </p>
          <p className="text-[9px] tracking-[0.18em] mt-0.5" style={{ color: 'rgba(201,162,39,0.55)' }}>
            {BRAND.tagline}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={handleNotificationClick}
        className="p-2 rounded-full transition-colors"
        style={{ background: 'rgba(255,255,255,0.04)', color: '#4A4A4A' }}
        aria-label="通知"
      >
        <Bell size={18} strokeWidth={1.8} />
      </button>
    </header>
  )
}
