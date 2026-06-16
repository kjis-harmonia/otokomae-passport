import type React from 'react'
import type { NavTab } from '../data/brand'

interface Props {
  active:    NavTab
  onChange:  (tab: NavTab) => void
  onQrPress: () => void
  qrActive?: boolean
}

const TAB_LABELS: Partial<Record<NavTab, string>> = {
  home:      'ホーム',
  tickets:   'チケット',
  styles:    'スタイル',
  diagnosis: '診断',
}

const MONO = 'ui-monospace, "SF Mono", "Fira Code", monospace'

const LEFT_TABS:  NavTab[] = ['home', 'tickets']
const RIGHT_TABS: NavTab[] = ['styles', 'diagnosis']

// ── SVG gradient defs (shared across tab icons) ───────────────────────────────

function GinjiroNavGradients() {
  return (
    <svg width="0" height="0" aria-hidden="true"
      style={{ position: 'absolute', overflow: 'hidden' }}>
      <defs>
        <linearGradient id="ginjiro-nav-gold-active" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#bf953f" />
          <stop offset="24%"  stopColor="#fcf6ba" />
          <stop offset="48%"  stopColor="#b38728" />
          <stop offset="74%"  stopColor="#fbf5b7" />
          <stop offset="100%" stopColor="#aa771c" />
        </linearGradient>
        <linearGradient id="ginjiro-nav-gold-muted" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#3d2e13" />
          <stop offset="50%"  stopColor="#806334" />
          <stop offset="100%" stopColor="#2a1e0c" />
        </linearGradient>
      </defs>
    </svg>
  )
}

// ── Tab icons ─────────────────────────────────────────────────────────────────

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

function IconTickets({ isActive }: IconProps) {
  const stroke = isActive ? 'url(#ginjiro-nav-gold-active)' : 'url(#ginjiro-nav-gold-muted)'
  const sw = isActive ? 1.65 : 1.5
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path
        d="M2 8.5C2 8.5 3.5 8.5 3.5 12S2 15.5 2 15.5V17a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-1.5c0 0-1.5 0-1.5-3.5S22 8.5 22 8.5V7a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v1.5Z"
        stroke={stroke} strokeWidth={sw} strokeLinejoin="round"
      />
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

/**
 * QR medal icon — three finder patterns + data modules.
 * Inline defs keep gradient scoped to this SVG instance.
 */
function IconQRMedal() {
  const g = 'gj-qr-medal-gold'
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}>
      <defs>
        <linearGradient id={g} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#b38728" />
          <stop offset="45%"  stopColor="#fcf6ba" />
          <stop offset="100%" stopColor="#aa771c" />
        </linearGradient>
      </defs>

      {/* ── Top-left finder ── */}
      <rect x="1"  y="1"  width="9" height="9" rx="1.5"
        stroke={`url(#${g})`} strokeWidth="1.35" />
      <rect x="3"  y="3"  width="5" height="5" rx="0.8"
        fill={`url(#${g})`} />

      {/* ── Top-right finder ── */}
      <rect x="14" y="1"  width="9" height="9" rx="1.5"
        stroke={`url(#${g})`} strokeWidth="1.35" />
      <rect x="16" y="3"  width="5" height="5" rx="0.8"
        fill={`url(#${g})`} />

      {/* ── Bottom-left finder ── */}
      <rect x="1"  y="14" width="9" height="9" rx="1.5"
        stroke={`url(#${g})`} strokeWidth="1.35" />
      <rect x="3"  y="16" width="5" height="5" rx="0.8"
        fill={`url(#${g})`} />

      {/* ── Bottom-right data modules (variable opacity = depth) ── */}
      <rect x="14"   y="14"   width="2.6" height="2.6" rx="0.5" fill={`url(#${g})`} />
      <rect x="17.6" y="14"   width="2.6" height="2.6" rx="0.5" fill={`url(#${g})`} opacity="0.78" />
      <rect x="21.2" y="14"   width="2.5" height="2.5" rx="0.5" fill={`url(#${g})`} opacity="0.52" />
      <rect x="14"   y="17.6" width="2.6" height="2.6" rx="0.5" fill={`url(#${g})`} opacity="0.78" />
      <rect x="17.6" y="17.6" width="2.6" height="2.6" rx="0.5" fill={`url(#${g})`} opacity="0.44" />
      <rect x="21.2" y="17.8" width="1.8" height="1.8" rx="0.4" fill={`url(#${g})`} opacity="0.55" />
      <rect x="14"   y="21.2" width="2.6" height="2.5" rx="0.5" fill={`url(#${g})`} opacity="0.55" />
      <rect x="17.6" y="21.4" width="1.8" height="1.8" rx="0.4" fill={`url(#${g})`} opacity="0.38" />
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

// ── Regular tab button ────────────────────────────────────────────────────────

function NavTabButton({
  id, active, onChange,
}: { id: NavTab; active: NavTab; onChange: (t: NavTab) => void }) {
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
          opacity: isActive ? 1 : 0.70,
          transition: 'filter 0.22s, transform 0.20s, opacity 0.20s',
        }}
      >
        <TabIcon id={id} isActive={isActive} />
      </span>

      {/* Label */}
      <span style={{
        fontSize: 10,
        letterSpacing: isActive ? '0.10em' : '0.07em',
        color: isActive ? '#e6ca65' : 'rgba(176,138,66,0.82)',
        textShadow: isActive ? '0 0 10px rgba(230,202,101,0.30)' : 'none',
        transition: 'color 0.20s, text-shadow 0.20s, letter-spacing 0.20s',
      }}>
        {TAB_LABELS[id]}
      </span>
    </button>
  )
}

// ── BottomNavigation ──────────────────────────────────────────────────────────

export function BottomNavigation({ active, onChange, onQrPress, qrActive }: Props) {
  /*
   * Layout strategy:
   *   - Outer wrapper: position:relative, flex-shrink:0
   *   - QR button (position:absolute, top:-10px): protrudes 10 px above the bar
   *     so it looks "set into" the bar rather than floating freely above content
   *   - Center spacer div (flex:1, pointer-events:none): placeholder column
   *     keeps the 4 tab buttons symmetrically flanking the center slot
   */

  const qrBoxShadow = qrActive
    ? [
        '0 0 0 1.5px #030101',                      /* dark gap */
        '0 0 0 4.5px rgba(201,162,74,0.78)',         /* outer ring — bright */
        '0 0 20px rgba(201,162,74,0.40)',             /* reflective glow */
        'inset 0 1px 0 rgba(255,255,255,0.10)',       /* top edge highlight */
        '0 6px 24px rgba(0,0,0,0.72)',               /* depth shadow */
      ].join(', ')
    : [
        '0 0 0 1.5px #040101',                      /* dark gap */
        '0 0 0 4px rgba(179,135,40,0.48)',           /* outer ring — subdued */
        '0 0 10px rgba(179,135,40,0.12)',            /* ambient glow */
        'inset 0 1px 0 rgba(255,255,255,0.06)',      /* top edge highlight */
        '0 6px 22px rgba(0,0,0,0.72)',              /* depth shadow */
      ].join(', ')

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <GinjiroNavGradients />

      {/*
       * ── Center QR medal: wrapper + button + label ───────────────────────────
       * top: -10px → protrudes 10 px above nav bar top; 46 px sits inside bar.
       *
       * Structure: outer wrapper (pointer-events:none) holds a strictly-sized
       * circular <button> and a sibling <span> label.
       * The border/shadow are on an absolute <span> inside the button so they
       * never influence the button's flex layout or push the SVG off-center.
       */}
      <div
        style={{
          position: 'absolute',
          top: -10,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 10,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          pointerEvents: 'none',   /* wrapper is click-through */
        } as React.CSSProperties}
      >
        {/* ── Circular button (strict 56×56) ── */}
        <button
          type="button"
          onClick={onQrPress}
          aria-label="男前証QRを表示"
          style={{
            position: 'relative',
            width: 56,
            height: 56,
            flexShrink: 0,
            borderRadius: '50%',
            /* No border/background here — decorative ring is on inner span */
            background: 'transparent',
            border: 'none',
            padding: 0,
            margin: 0,
            cursor: 'pointer',
            pointerEvents: 'auto',   /* only the button captures taps */
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
            /* Flex-center the icon span */
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'box-shadow 0.28s ease',
          } as React.CSSProperties}
        >
          {/* Decorative ring layer — absolute so it never affects flex sizing */}
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              background: 'linear-gradient(155deg, #1E1208 0%, #0C0604 50%, #180C04 100%)',
              border: '2.5px solid #C9A24A',
              boxShadow: qrBoxShadow,
              pointerEvents: 'none',
              transition: 'box-shadow 0.28s ease',
            }}
          />

          {/* Icon container — relative z-index, spans full button, perfectly centered */}
          <span
            style={{
              position: 'relative',
              zIndex: 1,
              display: 'flex',
              width: '100%',
              height: '100%',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
              lineHeight: 1,
            }}
          >
            <IconQRMedal />
          </span>
        </button>

        {/* ── QR label — sibling below the button, not inside ── */}
        <span
          style={{
            marginTop: 5,
            fontSize: 10,
            fontFamily: MONO,
            letterSpacing: '0.18em',
            color: '#e6ca65',
            lineHeight: 1,
            opacity: qrActive ? 1 : 0.72,
            transition: 'opacity 0.22s',
            pointerEvents: 'none',
          }}
        >
          QR
        </span>
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
          /* paddingTop creates enough room for the QR button inside the bar
             (button protrudes 10 px above, so 46 px is inside; nav content
              should start below that ≈ top 8 px area is "behind" the button disc) */
          paddingTop: 6,
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

        {/*
         * Center spacer — same flex weight as a regular tab.
         * pointer-events:none so touches aimed at the QR button
         * are not captured by this invisible placeholder div.
         */}
        <div
          aria-hidden="true"
          style={{ flex: 1, pointerEvents: 'none' }}
        />

        {/* Right tabs */}
        {RIGHT_TABS.map(id => (
          <NavTabButton key={id} id={id} active={active} onChange={onChange} />
        ))}
      </nav>
    </div>
  )
}
