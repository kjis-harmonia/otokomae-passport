import { Scissors, Bell } from 'lucide-react'
import { BRAND } from '../data/brand'

export function AppHeader() {
  function handleNotificationClick() {
    window.alert('お知らせ機能は近日公開予定です')
  }

  return (
    <header
      className="relative flex items-center justify-between px-5 py-3 shrink-0 overflow-hidden"
      style={{
        background:
          'linear-gradient(180deg, rgba(18,15,12,0.96), rgba(7,7,7,0.94))',
        borderBottom: '1px solid rgba(201,162,39,0.24)',
        boxShadow: '0 8px 28px rgba(0,0,0,0.36), inset 0 -1px 0 rgba(139,26,42,0.16)',
      }}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0"
        style={{
          height: 1,
          background: 'linear-gradient(90deg, transparent, rgba(232,197,71,0.55), transparent)',
        }}
      />
      <div className="flex items-center gap-3">
        <div
          className="p-1.5 rounded-lg"
          style={{
            background:
              'linear-gradient(145deg, rgba(201,162,39,0.18), rgba(139,26,42,0.08))',
            border: '1px solid rgba(201,162,39,0.34)',
            boxShadow: 'inset 0 0 14px rgba(201,162,39,0.1), 0 4px 16px rgba(0,0,0,0.32)',
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
          <p className="text-[9px] tracking-[0.22em] mt-0.5" style={{ color: 'rgba(201,162,39,0.68)' }}>
            GINJIRO BARBER
          </p>
          <p className="text-[9px] tracking-[0.16em] mt-0.5" style={{ color: 'rgba(245,240,232,0.34)' }}>
            {BRAND.tagline}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={handleNotificationClick}
        className="p-2 rounded-full transition-colors active:opacity-70"
        style={{
          background: 'linear-gradient(145deg, rgba(255,255,255,0.055), rgba(201,162,39,0.055))',
          border: '1px solid rgba(201,162,39,0.16)',
          color: 'rgba(201,162,39,0.7)',
        }}
        aria-label="通知"
      >
        <Bell size={18} strokeWidth={1.8} />
      </button>
    </header>
  )
}
