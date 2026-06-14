import type React from 'react'
import type { NavTab } from '../data/brand'

interface Props {
  active: NavTab
  onChange: (tab: NavTab) => void
}

const TAB_LABELS: Record<NavTab, string> = {
  home:      'ホーム',
  gacha:     'ガチャ',
  tryon:     '試着',
  styles:    '図鑑',
  diagnosis: '診断',
  reserve:   '予約',
  mypage:    'マイ',
}

// Sealed tabs — code preserved for future restoration
const TABS: NavTab[] = ['home', 'styles', 'diagnosis']

// ── SVG gradient defs ─────────────────────────────────────────────────────────

function GinjiroNavGradients() {
  return (
    <svg
      width="0"
      height="0"
      aria-hidden="true"
      style={{ position: 'absolute', overflow: 'hidden' }}
    >
      <defs>
        {/* Active: polished brass-gold shimmer */}
        <linearGradient id="ginjiro-nav-gold-active" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#bf953f" />
          <stop offset="24%"  stopColor="#fcf6ba" />
          <stop offset="48%"  stopColor="#b38728" />
          <stop offset="74%"  stopColor="#fbf5b7" />
          <stop offset="100%" stopColor="#aa771c" />
        </linearGradient>
        {/* Inactive: antique bronze, sunken */}
        <linearGradient id="ginjiro-nav-gold-muted" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#3d2e13" />
          <stop offset="50%"  stopColor="#806334" />
          <stop offset="100%" stopColor="#2a1e0c" />
        </linearGradient>
      </defs>
    </svg>
  )
}

// ── Custom icons ──────────────────────────────────────────────────────────────

interface IconProps { isActive: boolean }

/** Architectural house — sharp roof, open doorway */
function IconHome({ isActive }: IconProps) {
  const stroke = isActive ? 'url(#ginjiro-nav-gold-active)' : 'url(#ginjiro-nav-gold-muted)'
  const sw = isActive ? 1.65 : 1.5
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <polyline
        points="3,12.5 12,4 21,12.5"
        stroke={stroke} strokeWidth={sw}
        strokeLinecap="round" strokeLinejoin="round"
      />
      <path
        d="M5 12v8h5v-5h4v5h5v-8"
        stroke={stroke} strokeWidth={sw}
        strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}

/** Gallery grid — 4 showcase frames, archive/exhibition feel */
function IconStyles({ isActive }: IconProps) {
  const stroke = isActive ? 'url(#ginjiro-nav-gold-active)' : 'url(#ginjiro-nav-gold-muted)'
  const sw = isActive ? 1.65 : 1.5
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <rect x="3"  y="3"  width="8" height="8" rx="1.5" stroke={stroke} strokeWidth={sw} />
      <rect x="13" y="3"  width="8" height="8" rx="1.5" stroke={stroke} strokeWidth={sw} />
      <rect x="3"  y="13" width="8" height="8" rx="1.5" stroke={stroke} strokeWidth={sw} />
      <rect x="13" y="13" width="8" height="8" rx="1.5" stroke={stroke} strokeWidth={sw} />
    </svg>
  )
}

/** Precision scope — outer ring, inner reticle, crosshairs */
function IconDiagnosis({ isActive }: IconProps) {
  const stroke = isActive ? 'url(#ginjiro-nav-gold-active)' : 'url(#ginjiro-nav-gold-muted)'
  const sw = isActive ? 1.65 : 1.5
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5"  stroke={stroke} strokeWidth={sw} />
      <circle cx="12" cy="12" r="2.8"  stroke={stroke} strokeWidth={sw} />
      <line x1="12"   y1="3"    x2="12"   y2="6.8"  stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
      <line x1="12"   y1="17.2" x2="12"   y2="21"   stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
      <line x1="3"    y1="12"   x2="6.8"  y2="12"   stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
      <line x1="17.2" y1="12"   x2="21"   y2="12"   stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
    </svg>
  )
}

function TabIcon({ id, isActive }: { id: NavTab; isActive: boolean }) {
  switch (id) {
    case 'home':      return <IconHome      isActive={isActive} />
    case 'styles':    return <IconStyles    isActive={isActive} />
    case 'diagnosis': return <IconDiagnosis isActive={isActive} />
    default:          return null
  }
}

// ── BottomNavigation ──────────────────────────────────────────────────────────

export function BottomNavigation({ active, onChange }: Props) {
  return (
    <nav
      className="relative flex shrink-0 overflow-hidden"
      style={{
        background: 'linear-gradient(180deg, rgba(9,2,2,0.94) 0%, rgba(0,0,0,0.97) 100%)',
        backdropFilter: 'blur(28px) saturate(1.8)',
        WebkitBackdropFilter: 'blur(28px) saturate(1.8)',
        borderTop: '1px solid rgba(230,202,101,0.22)',
        boxShadow: '0 -12px 30px rgba(0,0,0,0.55), inset 0 1px 0 rgba(245,240,232,0.03)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      } as React.CSSProperties}
    >
      <GinjiroNavGradients />

      {/* Top gold shimmer line */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0"
        style={{
          height: 1,
          background: 'linear-gradient(90deg, transparent, rgba(230,202,101,0.55), transparent)',
        }}
      />

      {TABS.map(tab => {
        const isActive = active === tab
        return (
          <button
            key={tab}
            type="button"
            onClick={() => onChange(tab)}
            aria-label={TAB_LABELS[tab]}
            aria-current={isActive ? 'page' : undefined}
            className="relative flex flex-col items-center justify-center gap-1 flex-1 py-3.5 active:opacity-60"
            style={{ transition: 'opacity 0.15s' }}
          >
            {/* Bottom indicator bar */}
            {isActive && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute rounded-full"
                style={{
                  bottom: 6,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: 24,
                  height: 2,
                  background: 'linear-gradient(90deg, #7a4b12, #fcf6ba 50%, #aa771c)',
                  boxShadow: '0 0 10px rgba(230,202,101,0.38)',
                }}
              />
            )}

            {/* Icon wrapper — drop-shadow + scale on active */}
            <span
              aria-hidden="true"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                filter: isActive
                  ? 'drop-shadow(0 0 5px rgba(230,202,101,0.44)) drop-shadow(0 1px 3px rgba(180,130,40,0.26))'
                  : 'none',
                transform: isActive ? 'scale(1.08)' : 'scale(1)',
                opacity: isActive ? 1 : 0.58,
                transition: 'filter 0.22s, transform 0.20s, opacity 0.20s',
              }}
            >
              <TabIcon id={tab} isActive={isActive} />
            </span>

            {/* Label */}
            <span
              style={{
                fontSize: 10,
                letterSpacing: isActive ? '0.10em' : '0.07em',
                color: isActive ? '#e6ca65' : 'rgba(138,111,62,0.68)',
                textShadow: isActive ? '0 0 10px rgba(230,202,101,0.30)' : 'none',
                transition: 'color 0.20s, text-shadow 0.20s, letter-spacing 0.20s',
              }}
            >
              {TAB_LABELS[tab]}
            </span>
          </button>
        )
      })}
    </nav>
  )
}
