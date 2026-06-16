import type React from 'react'
import type { NavTab } from '../data/brand'

interface Props {
  active: NavTab
  onChange: (tab: NavTab) => void
  onQrPress: () => void
}

const TAB_LABELS: Partial<Record<NavTab, string>> = {
  home:      'ホーム',
  tickets:   'チケット',
  styles:    'スタイル',
  diagnosis: '診断',
}

// 4 tabs flanking the center QR button
const LEFT_TABS:  NavTab[] = ['home', 'tickets']
const RIGHT_TABS: NavTab[] = ['styles', 'diagnosis']

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

// ── Icons ─────────────────────────────────────────────────────────────────────

interface IconProps { isActive: boolean }

function IconHome({ isActive }: IconProps) {
  const stroke = isActive ? 'url(#ginjiro-nav-gold-active)' : 'url(#ginjiro-nav-gold-muted)'
  const sw = isActive ? 1.65 : 1.5
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <polyline points="3,12.5 12,4 21,12.5"
        stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 12v8h5v-5h4v5h5v-8"
        stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Coupon / ticket — horizontal stub with perforated divider */
function IconTickets({ isActive }: IconProps) {
  const stroke = isActive ? 'url(#ginjiro-nav-gold-active)' : 'url(#ginjiro-nav-gold-muted)'
  const sw = isActive ? 1.65 : 1.5
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      {/* Ticket body with side notches */}
      <path
        d="M2 8.5C2 8.5 3.5 8.5 3.5 12S2 15.5 2 15.5V17a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-1.5c0 0-1.5 0-1.5-3.5S22 8.5 22 8.5V7a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v1.5Z"
        stroke={stroke} strokeWidth={sw} strokeLinejoin="round"
      />
      {/* Perforated stub line */}
      <line x1="8" y1="6" x2="8" y2="18"
        stroke={stroke} strokeWidth="0.9" strokeDasharray="1.6 1.8" opacity="0.72" strokeLinecap="round" />
    </svg>
  )
}

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

/** QR-scan icon for the center button — corner brackets + data grid */
function IconQRButton() {
  const c = '#C9A24A'
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true">
      {/* Corner brackets (viewfinder) */}
      <path d="M4 9V5h4"  stroke={c} strokeWidth="2"   strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 9V5h-4" stroke={c} strokeWidth="2"  strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 15v4h4"  stroke={c} strokeWidth="2"  strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 15v4h-4" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {/* Data squares */}
      <rect x="8.5"  y="8.5"  width="2.8" height="2.8" rx="0.5" fill={c} />
      <rect x="12.7" y="8.5"  width="2.8" height="2.8" rx="0.5" fill={c} opacity="0.72" />
      <rect x="8.5"  y="12.7" width="2.8" height="2.8" rx="0.5" fill={c} opacity="0.72" />
      <rect x="13.2" y="13.2" width="2"   height="2"   rx="0.4" fill={c} opacity="0.50" />
    </svg>
  )
}

function TabIcon({ id, isActive }: { id: NavTab; isActive: boolean }) {
  switch (id) {
    case 'home':      return <IconHome      isActive={isActive} />
    case 'tickets':   return <IconTickets   isActive={isActive} />
    case 'styles':    return <IconStyles    isActive={isActive} />
    case 'diagnosis': return <IconDiagnosis isActive={isActive} />
    default:          return null
  }
}

// ── Single regular tab button ─────────────────────────────────────────────────

function NavTabButton({ id, active, onChange }: { id: NavTab; active: NavTab; onChange: (t: NavTab) => void }) {
  const isActive = active === id
  return (
    <button
      type="button"
      onClick={() => onChange(id)}
      aria-label={TAB_LABELS[id]}
      aria-current={isActive ? 'page' : undefined}
      className="relative flex flex-col items-center justify-center gap-1 active:opacity-60"
      style={{
        flex: 1,
        paddingTop: 10,
        paddingBottom: 10,
        transition: 'opacity 0.15s',
        WebkitTapHighlightColor: 'transparent',
      } as React.CSSProperties}
    >
      {/* Active indicator bar */}
      {isActive && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute rounded-full"
          style={{
            bottom: 6,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 22,
            height: 2,
            background: 'linear-gradient(90deg, #7a4b12, #fcf6ba 50%, #aa771c)',
            boxShadow: '0 0 8px rgba(230,202,101,0.38)',
          }}
        />
      )}

      {/* Icon */}
      <span
        aria-hidden="true"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          filter: isActive
            ? 'drop-shadow(0 0 5px rgba(230,202,101,0.44)) drop-shadow(0 1px 3px rgba(180,130,40,0.26))'
            : 'none',
          transform: isActive ? 'scale(1.08)' : 'scale(1)',
          opacity: isActive ? 1 : 0.52,
          transition: 'filter 0.22s, transform 0.20s, opacity 0.20s',
        }}
      >
        <TabIcon id={id} isActive={isActive} />
      </span>

      {/* Label */}
      <span
        style={{
          fontSize: 10,
          letterSpacing: isActive ? '0.10em' : '0.07em',
          color: isActive ? '#e6ca65' : 'rgba(138,111,62,0.62)',
          textShadow: isActive ? '0 0 10px rgba(230,202,101,0.30)' : 'none',
          transition: 'color 0.20s, text-shadow 0.20s, letter-spacing 0.20s',
        }}
      >
        {TAB_LABELS[id]}
      </span>
    </button>
  )
}

// ── BottomNavigation ──────────────────────────────────────────────────────────

export function BottomNavigation({ active, onChange, onQrPress }: Props) {
  return (
    /* Outer wrapper: shrinks to fit, allows the QR button to overflow upward */
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <GinjiroNavGradients />

      {/* ── Floating center QR button ── */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: '50%',
          /* Center horizontally, float the button center at the nav's top edge */
          transform: 'translate(-50%, -50%)',
          zIndex: 10,
        }}
      >
        <button
          type="button"
          onClick={onQrPress}
          aria-label="男前証QRを表示"
          style={{
            width: 62,
            height: 62,
            borderRadius: '50%',
            /* Dark dial background */
            background: 'linear-gradient(145deg, #1C0C08 0%, #080404 100%)',
            /* Dual-ring: inner gold border + dark gap + outer subtle ring */
            border: '2px solid #C9A24A',
            boxShadow: [
              '0 0 0 1.5px #050202',                    /* dark gap */
              '0 0 0 3.5px rgba(179,135,40,0.42)',      /* outer ring */
              '0 -4px 22px rgba(201,162,74,0.14)',      /* upward glow */
              '0 8px 28px rgba(0,0,0,0.80)',            /* drop shadow */
            ].join(', '),
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
            transition: 'box-shadow 0.22s, transform 0.14s',
          } as React.CSSProperties}
        >
          <IconQRButton />
        </button>
      </div>

      {/* ── Navigation bar ── */}
      <nav
        role="navigation"
        aria-label="メインナビゲーション"
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'stretch',
          background: 'linear-gradient(180deg, rgba(10,6,4,0.97) 0%, rgba(0,0,0,0.99) 100%)',
          backdropFilter: 'blur(28px) saturate(1.6)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.6)',
          borderTop: '1px solid rgba(230,202,101,0.20)',
          boxShadow: '0 -20px 40px rgba(0,0,0,0.70), inset 0 1px 0 rgba(245,240,232,0.025)',
          /* Extra top padding so the tab content doesn't crowd the floating QR button */
          paddingTop: 8,
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        } as React.CSSProperties}
      >
        {/* Top shimmer line */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: '0 0 auto 0',
            height: 1,
            background: 'linear-gradient(90deg, transparent 5%, rgba(230,202,101,0.52) 50%, transparent 95%)',
            pointerEvents: 'none',
          }}
        />

        {/* Left tabs */}
        {LEFT_TABS.map(id => (
          <NavTabButton key={id} id={id} active={active} onChange={onChange} />
        ))}

        {/* Center spacer — same width as a normal tab, reserved for the QR button */}
        <div style={{ flex: 1 }} aria-hidden="true" />

        {/* Right tabs */}
        {RIGHT_TABS.map(id => (
          <NavTabButton key={id} id={id} active={active} onChange={onChange} />
        ))}
      </nav>
    </div>
  )
}
