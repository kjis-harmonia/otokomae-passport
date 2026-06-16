import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { MAINTENANCE_CUT_URL } from '../data/reserveLinks'
import { fmtDate } from '../utils/maintenanceSchedule'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const MONO = 'ui-monospace, "SF Mono", "Fira Code", monospace'

const CX = 110, CY = 110, RING_R = 84
const CIRC = 2 * Math.PI * RING_R  // ≈ 527.79

// 14 tick marks: one per day interval, day-0 at top (clockwise)
const TICKS = Array.from({ length: 14 }, (_, i) => {
  const angle = (i / 14) * Math.PI * 2 - Math.PI / 2
  const isMajor = i === 0 || i === 7
  const r1 = isMajor ? 90 : 94
  return {
    x1: CX + r1 * Math.cos(angle), y1: CY + r1 * Math.sin(angle),
    x2: CX + 100 * Math.cos(angle), y2: CY + 100 * Math.sin(angle),
    isMajor,
  }
})

// Brushed-metal sunburst texture (36 fine radial lines, clipped to dial)
const SUNBURST = Array.from({ length: 36 }, (_, i) => {
  const angle = (i / 36) * Math.PI * 2
  return {
    x1: CX + 3 * Math.cos(angle), y1: CY + 3 * Math.sin(angle),
    x2: CX + 101 * Math.cos(angle), y2: CY + 101 * Math.sin(angle),
  }
})

// ── Types ─────────────────────────────────────────────────────────────────────

export type FreshnessWidgetProps = {
  lastVisitDate?: string | null
  nextRecommendedDate?: string | null
  daysRemaining?: number | null
  onReserve?: () => void
  notifSupported?: boolean
  notifPermission?: NotificationPermission
  onRequestNotif?: () => void
  onScan?: () => void
  scanMsg?: string | null
}

type GaugeTheme = {
  color: string
  glowColor: string
  statusText: string
  isPulsing: boolean
  isCritical: boolean
}

// ── Gauge theme by freshness % ────────────────────────────────────────────────

function getGaugeTheme(freshness: number): GaugeTheme {
  if (freshness >= 60) return {
    color: '#C9A24A',
    glowColor: 'rgba(201,162,74,0.48)',
    statusText: '男前、維持中',
    isPulsing: false,
    isCritical: false,
  }
  if (freshness >= 25) return {
    color: '#D08A3A',
    glowColor: 'rgba(208,138,58,0.44)',
    statusText: 'そろそろ整え時',
    isPulsing: false,
    isCritical: false,
  }
  if (freshness >= 1) return {
    color: '#C85040',
    glowColor: 'rgba(200,80,64,0.52)',
    statusText: '男前鮮度、低下中',
    isPulsing: true,
    isCritical: false,
  }
  return {
    color: '#8B2020',
    glowColor: 'rgba(139,32,32,0.58)',
    statusText: '鮮度限界 / 要メンテナンス',
    isPulsing: false,
    isCritical: true,
  }
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader() {
  return (
    <div style={{
      marginBottom: 16,
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '0 4px',
    }}>
      <p style={{
        fontSize: 17, fontWeight: 700, lineHeight: 1, flexShrink: 0,
        color: '#F2E6C8', fontFamily: SERIF,
      }}>
        メンテナンス予報
      </p>
      <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, rgba(201,162,74,0.30), transparent)' }} />
      <p style={{ fontSize: 8, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.36)', flexShrink: 0, fontFamily: MONO }}>
        FRESHNESS
      </p>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function FreshnessWidget({
  lastVisitDate,
  nextRecommendedDate,
  daysRemaining,
  onReserve,
  notifSupported,
  notifPermission,
  onRequestNotif,
  onScan,
  scanMsg,
}: FreshnessWidgetProps) {
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(mq.matches)
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // ── Empty state (no visit record) ─────────────────────────────────────────
  if (!lastVisitDate) {
    return (
      <div>
        <SectionHeader />
        <div style={{
          borderRadius: 20,
          background: 'linear-gradient(145deg, rgba(16,7,5,0.97), rgba(8,4,3,0.99))',
          border: '1px solid rgba(201,162,74,0.11)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
          padding: '28px 20px',
          textAlign: 'center',
        }}>
          <div style={{ margin: '0 auto 18px', width: 80, height: 80 }}>
            <svg viewBox="0 0 80 80" style={{ width: '100%', height: '100%' }} aria-hidden="true">
              <circle cx="40" cy="40" r="32" fill="none" stroke="rgba(201,162,74,0.07)" strokeWidth={4} />
              <circle cx="40" cy="40" r="23" fill="none" stroke="rgba(201,162,74,0.04)" strokeWidth={1.5} />
              <text x="40" y="47" textAnchor="middle"
                style={{ fontSize: '22px', fill: 'rgba(201,162,74,0.18)', fontFamily: SERIF }}>
                —
              </text>
            </svg>
          </div>

          <p style={{ fontSize: 8, letterSpacing: '0.28em', color: 'rgba(201,162,74,0.32)', marginBottom: 12, fontFamily: MONO }}>
            MANLINESS FRESHNESS
          </p>
          <p style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 700, color: 'rgba(242,230,200,0.58)', marginBottom: 8, lineHeight: 1.35 }}>
            来店記録なし
          </p>
          <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.34)', lineHeight: 1.9, marginBottom: 22 }}>
            男前証QRを店頭で読み込むと、<br />
            鮮度ステータスが開始されます。
          </p>

          {scanMsg && (
            <div style={{ borderRadius: 12, background: 'rgba(224,100,60,0.10)', border: '1px solid rgba(224,100,60,0.28)', padding: '10px 14px', marginBottom: 14 }}>
              <p style={{ fontSize: 12, color: '#E06040', lineHeight: 1.6 }}>{scanMsg}</p>
            </div>
          )}

          {onScan && (
            <button type="button" onClick={onScan}
              style={{
                width: '100%', padding: '13px 0', borderRadius: 14,
                background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
                border: '1px solid rgba(201,162,74,0.44)',
                boxShadow: '0 4px 20px rgba(107,15,18,0.45)',
                fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.22em',
                color: '#F2E6C8', cursor: 'pointer',
              }}>
              店内QRを読む
            </button>
          )}
        </div>
      </div>
    )
  }

  // ── Compute freshness (spec formula: 1 - elapsedDays/14) ──────────────────
  const daysLeft = daysRemaining ?? 0
  const elapsedDays = Math.max(0, 14 - Math.max(0, daysLeft))
  const freshness = Math.max(0, Math.min(100, Math.round((1 - elapsedDays / 14) * 100)))
  const isOverdue = daysLeft <= 0
  const g = getGaugeTheme(freshness)
  const filledArc = (freshness / 100) * CIRC

  // Visual drama flags (independent of gauge theme thresholds)
  const isLowWarning = freshness < 40 && freshness > 0
  const isCritical   = freshness === 0

  // Meteor tip: angle in degrees (0 = 12 o'clock, clockwise)
  const tipFinalDeg = (freshness / 100) * 360
  // Tip position in SVG coords (for static/reduced-motion fallback)
  const tipAngleRad = (freshness / 100) * Math.PI * 2 - Math.PI / 2
  const tipX = CX + RING_R * Math.cos(tipAngleRad)
  const tipY = CY + RING_R * Math.sin(tipAngleRad)

  const borderColor = isCritical ? 'rgba(139,26,26,0.55)'
    : isLowWarning  ? 'rgba(160,40,30,0.32)'
    : 'rgba(201,162,74,0.18)'

  const accentLine = isCritical
    ? 'linear-gradient(90deg, transparent, #6B0F12 30%, #8B1A1A 50%, #6B0F12 70%, transparent)'
    : isOverdue
    ? 'linear-gradient(90deg, transparent, #5A0A0E 20%, #C9A24A 50%, #5A0A0E 80%, transparent)'
    : 'linear-gradient(90deg, transparent, #5A0A0E 20%, #C9A24A 50%, #5A0A0E 80%, transparent)'

  const reserveCTA = isOverdue ? (
    onReserve ? (
      <button type="button" onClick={onReserve}
        style={{
          display: 'block', width: '100%', textAlign: 'center',
          padding: '14px 0', borderRadius: 14, cursor: 'pointer',
          background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
          border: '1px solid rgba(201,162,74,0.44)',
          boxShadow: '0 4px 24px rgba(107,15,18,0.55)',
          fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.22em', color: '#F2E6C8',
        }}>
        メンテナンスカットを予約する
      </button>
    ) : (
      <a href={MAINTENANCE_CUT_URL} target="_blank" rel="noopener noreferrer"
        style={{
          display: 'block', textAlign: 'center',
          padding: '14px 0', borderRadius: 14,
          background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
          border: '1px solid rgba(201,162,74,0.44)',
          boxShadow: '0 4px 24px rgba(107,15,18,0.55)',
          textDecoration: 'none',
          fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.22em', color: '#F2E6C8',
        }}>
        メンテナンスカットを予約する
      </a>
    )
  ) : (
    notifSupported ? (
      notifPermission === 'granted' ? (
        <p style={{ fontSize: 11, letterSpacing: '0.14em', color: 'rgba(201,162,74,0.80)', textAlign: 'center' }}>
          通知ON — 来店3日前にお知らせします
        </p>
      ) : notifPermission === 'denied' ? (
        <p style={{ fontSize: 11, letterSpacing: '0.12em', color: 'rgba(220,80,60,0.78)', textAlign: 'center' }}>
          通知が拒否されています（設定から変更できます）
        </p>
      ) : (
        <button type="button" onClick={onRequestNotif}
          style={{
            width: '100%', padding: '13px 0', borderRadius: 14, cursor: 'pointer',
            background: 'rgba(201,162,74,0.06)', border: '1px solid rgba(201,162,74,0.24)',
            fontSize: 13, letterSpacing: '0.14em', color: 'rgba(212,180,100,0.92)', fontFamily: SERIF,
          }}>
          カット時期になったら通知する
        </button>
      )
    ) : null
  )

  return (
    <div>
      <SectionHeader />
      <div style={{
        borderRadius: 24,
        background: 'linear-gradient(155deg, #130608 0%, #0A0404 55%, #080407 100%)',
        border: `1px solid ${borderColor}`,
        boxShadow: [
          '0 20px 60px rgba(0,0,0,0.78)',
          'inset 0 1px 0 rgba(255,255,255,0.025)',
          isCritical  ? '0 0 80px rgba(110,14,14,0.28)' : '',
          isLowWarning ? '0 0 40px rgba(80,14,14,0.14)' : '',
        ].filter(Boolean).join(', '),
        overflow: 'hidden',
        transition: 'border-color 0.6s, box-shadow 0.6s',
      }}>
        {/* Accent stripe */}
        <div style={{ height: 2, background: accentLine }} />

        <div style={{ padding: '20px 20px 22px' }}>

          {/* ── Chronograph gauge SVG ── */}
          <div style={{ position: 'relative', width: '100%', maxWidth: 248, margin: '0 auto 18px' }}>
            <svg
              viewBox="0 0 220 220"
              style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
              role="img"
              aria-label={`漢の鮮度 ${freshness}% — ${g.statusText}`}
            >
              <defs>
                {/* ── Clip path for dial interior ── */}
                <clipPath id="gj-fw-dial-clip">
                  <circle cx={CX} cy={CY} r={102} />
                </clipPath>

                {/* ── Outer bezel: antique deep shadow ── */}
                <linearGradient id="gj-fw-bezel-outer" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%"   stopColor="#1A0E06" stopOpacity="0.92" />
                  <stop offset="35%"  stopColor="#3A2510" stopOpacity="0.70" />
                  <stop offset="65%"  stopColor="#0E0804" stopOpacity="0.88" />
                  <stop offset="100%" stopColor="#1A0E06" stopOpacity="0.92" />
                </linearGradient>

                {/* ── Main bezel: polished brass-gold shimmer ── */}
                <linearGradient id="gj-fw-bezel" x1="10%" y1="0%" x2="90%" y2="100%">
                  <stop offset="0%"   stopColor="#8B6218" stopOpacity="0.55" />
                  <stop offset="16%"  stopColor="#EDD88A" stopOpacity="0.95" />
                  <stop offset="32%"  stopColor="#7A5410" stopOpacity="0.40" />
                  <stop offset="50%"  stopColor="#F0E090" stopOpacity="1.00" />
                  <stop offset="68%"  stopColor="#6A4808" stopOpacity="0.38" />
                  <stop offset="84%"  stopColor="#D4A030" stopOpacity="0.88" />
                  <stop offset="100%" stopColor="#8B6218" stopOpacity="0.52" />
                </linearGradient>

                {/* ── Dark metallic dial with off-center lighting ── */}
                <radialGradient id="gj-fw-dial" cx="38%" cy="30%" r="70%">
                  <stop offset="0%"   stopColor="#221210" />
                  <stop offset="40%"  stopColor="#100806" />
                  <stop offset="80%"  stopColor="#070404" />
                  <stop offset="100%" stopColor="#040202" />
                </radialGradient>

                {/* ── Sapphire glass reflection (cool upper-left highlight) ── */}
                <radialGradient id="gj-fw-sapphire" cx="28%" cy="22%" r="44%">
                  <stop offset="0%"   stopColor="rgba(195,215,255,0.062)" />
                  <stop offset="55%"  stopColor="rgba(195,215,255,0.016)" />
                  <stop offset="100%" stopColor="rgba(195,215,255,0.000)" />
                </radialGradient>

                {/* ── Crimson inner aura for low freshness ── */}
                <radialGradient id="gj-fw-warn-aura" cx="50%" cy="50%" r="50%">
                  <stop offset="0%"   stopColor="rgba(100,14,14,0.00)" />
                  <stop offset="65%"  stopColor="rgba(100,14,14,0.00)" />
                  <stop offset="100%" stopColor="rgba(110,16,16,0.55)" />
                </radialGradient>

                {/* ── Arc glow blur ── */}
                <filter id="gj-fw-glow" x="-55%" y="-55%" width="210%" height="210%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="6" />
                </filter>

                {/* ── Critical outer aura blur ── */}
                <filter id="gj-fw-crit-aura" x="-20%" y="-20%" width="140%" height="140%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="5" />
                </filter>

                {/* ── Meteor tip: layered glow ── */}
                <filter id="gj-fw-tip-glow" x="-120%" y="-120%" width="340%" height="340%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>

                {/* ── Gold shimmer gradient for percentage text ── */}
                <linearGradient id="gj-fw-pct-gold" gradientUnits="userSpaceOnUse"
                  x1={CX - 52} y1="0" x2={CX + 52} y2="0">
                  <stop offset="0%"   stopColor="#7A4E10" />
                  <stop offset="18%"  stopColor="#C9A24A" />
                  <stop offset="36%"  stopColor="#F0DC8C" />
                  <stop offset="48%"  stopColor="#FAF4E0" />
                  <stop offset="60%"  stopColor="#E8C860" />
                  <stop offset="78%"  stopColor="#AA771C" />
                  <stop offset="100%" stopColor="#7A4E10" />
                  {!reducedMotion && (
                    <animateTransform
                      attributeName="gradientTransform"
                      type="translate"
                      values="-200 0; 200 0; -200 0"
                      dur="3.5s"
                      repeatCount="indefinite"
                    />
                  )}
                </linearGradient>

                {/* ── Critical state text color ── */}
                <linearGradient id="gj-fw-crit-gold" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%"   stopColor="#6B1212" />
                  <stop offset="50%"  stopColor="#C03030" />
                  <stop offset="100%" stopColor="#6B1212" />
                </linearGradient>
              </defs>

              {/* ── Critical outer crimson aura ── */}
              {isCritical && (
                <circle cx={CX} cy={CY} r={110}
                  fill="none"
                  stroke="rgba(120,18,18,0.32)" strokeWidth={14}
                  filter="url(#gj-fw-crit-aura)" />
              )}
              {/* Low-warning outer bleed */}
              {isLowWarning && !isCritical && (
                <circle cx={CX} cy={CY} r={109}
                  fill="none"
                  stroke="rgba(100,16,16,0.20)" strokeWidth={10}
                  filter="url(#gj-fw-crit-aura)" />
              )}

              {/* ══ BEZEL STACK ══ */}

              {/* Outer shadow ring — depth and weight */}
              <circle cx={CX} cy={CY} r={109.5} fill="none"
                stroke="url(#gj-fw-bezel-outer)" strokeWidth={4} />

              {/* Main bezel — polished brass-gold */}
              <circle cx={CX} cy={CY} r={107} fill="none"
                stroke="url(#gj-fw-bezel)" strokeWidth={3.8} />

              {/* Bezel inner shadow line */}
              <circle cx={CX} cy={CY} r={104.8} fill="none"
                stroke="rgba(0,0,0,0.65)" strokeWidth={0.6} />

              {/* Inner bezel accent ring */}
              <circle cx={CX} cy={CY} r={103.8} fill="none"
                stroke="rgba(180,140,50,0.18)" strokeWidth={0.5} />

              {/* ══ DIAL ══ */}

              {/* Dark metallic dial fill */}
              <circle cx={CX} cy={CY} r={103} fill="url(#gj-fw-dial)" />

              {/* Brushed-metal sunburst texture (fine radial lines) */}
              <g clipPath="url(#gj-fw-dial-clip)" opacity="0.055" aria-hidden="true">
                {SUNBURST.map((l, i) => (
                  <line key={i}
                    x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
                    stroke="#EAD88A" strokeWidth="0.5"
                  />
                ))}
              </g>

              {/* Sapphire glass reflection */}
              <circle cx={CX} cy={CY} r={103} fill="url(#gj-fw-sapphire)" />

              {/* Inner dial separation ring */}
              <circle cx={CX} cy={CY} r={102} fill="none"
                stroke="rgba(255,255,255,0.028)" strokeWidth={0.5} />

              {/* ══ 12 O'CLOCK MACHINED MARKER ══ */}
              {/* Small polished metal index at top of bezel */}
              <rect
                x={CX - 2.2} y={CY - 107}
                width={4.4} height={9}
                rx={1.2}
                fill="url(#gj-fw-bezel)"
                opacity="0.90"
              />
              {/* Subtle shadow under the 12-marker */}
              <rect
                x={CX - 1.4} y={CY - 107}
                width={2.8} height={9}
                rx={0.8}
                fill="rgba(0,0,0,0.30)"
                opacity="0.55"
              />

              {/* ══ TICK MARKS ══ */}
              {TICKS.map((t, i) => (
                <line key={i}
                  x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
                  stroke={t.isMajor ? 'rgba(201,162,74,0.52)' : 'rgba(201,162,74,0.18)'}
                  strokeWidth={t.isMajor ? 1.8 : 0.8}
                  strokeLinecap="round" />
              ))}

              {/* ══ TRACK CHANNEL ══ */}
              <circle cx={CX} cy={CY} r={RING_R} fill="none"
                stroke="rgba(255,255,255,0.035)" strokeWidth={11} />

              {/* ══ CRIMSON INNER WARNING AURA ══ */}
              {(isLowWarning || isCritical) && (
                <circle cx={CX} cy={CY} r={103}
                  fill="url(#gj-fw-warn-aura)"
                  opacity={isCritical ? 0.85 : freshness < 25 ? 0.60 : 0.35}
                />
              )}

              {/* ══ GLOW BEHIND PROGRESS ARC ══ */}
              {freshness > 0 && (
                <motion.circle
                  cx={CX} cy={CY} r={RING_R}
                  fill="none"
                  stroke={g.glowColor}
                  strokeWidth={26}
                  strokeDasharray={`${filledArc} ${CIRC}`}
                  strokeLinecap="round"
                  transform={`rotate(-90 ${CX} ${CY})`}
                  filter="url(#gj-fw-glow)"
                  animate={g.isPulsing && !reducedMotion
                    ? { opacity: [0.18, 0.55, 0.18] }
                    : { opacity: isLowWarning ? 0.38 : 0.28 }
                  }
                  transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
                />
              )}

              {/* ══ PROGRESS ARC ══ */}
              {freshness > 0 && (
                <motion.circle
                  cx={CX} cy={CY} r={RING_R}
                  fill="none"
                  stroke={g.color}
                  strokeWidth={11}
                  strokeLinecap="round"
                  transform={`rotate(-90 ${CX} ${CY})`}
                  initial={{ strokeDasharray: `0 ${CIRC}` }}
                  animate={{ strokeDasharray: `${filledArc} ${CIRC}` }}
                  transition={reducedMotion
                    ? { duration: 0 }
                    : { duration: 1.2, ease: [0.4, 0, 0.2, 1] }
                  }
                />
              )}

              {/* ══ METEOR TIP GLOW ══ */}
              {freshness > 0 && (
                reducedMotion ? (
                  /* Static tip at final position */
                  <g>
                    <circle cx={tipX} cy={tipY} r={7}
                      fill="rgba(252,246,186,0.22)"
                      filter="url(#gj-fw-tip-glow)" />
                    <circle cx={tipX} cy={tipY} r={3.8}
                      fill="rgba(255,252,240,0.90)" />
                    <circle cx={tipX} cy={tipY} r={1.8}
                      fill="rgba(255,255,255,0.96)" />
                  </g>
                ) : (
                  /* Animated tip sweeping along the arc */
                  <motion.g
                    initial={{ rotate: 0 }}
                    animate={{ rotate: tipFinalDeg }}
                    transition={{ duration: 1.2, ease: [0.4, 0, 0.2, 1] }}
                    style={{
                      transformOrigin: `${CX}px ${CY}px`,
                      transformBox: 'view-box' as React.CSSProperties['transformBox'],
                    }}
                  >
                    {/* Outer halo */}
                    <circle cx={CX} cy={CY - RING_R} r={8}
                      fill="rgba(252,246,186,0.18)"
                      filter="url(#gj-fw-tip-glow)" />
                    {/* Mid glow */}
                    <circle cx={CX} cy={CY - RING_R} r={4.5}
                      fill="rgba(252,246,186,0.72)" />
                    {/* Hot core */}
                    <circle cx={CX} cy={CY - RING_R} r={2}
                      fill="rgba(255,255,252,0.98)" />
                  </motion.g>
                )
              )}

              {/* ── Inner separator ring ── */}
              <circle cx={CX} cy={CY} r={71} fill="none"
                stroke="rgba(201,162,74,0.08)" strokeWidth={0.5} />

              {/* ══════════════════════════════════
                  CENTER TEXT
                  ══════════════════════════════════ */}

              {/* Label: 漢の鮮度 */}
              <text x={CX} y={CY - 33} textAnchor="middle"
                style={{
                  fontSize: '9px',
                  fontFamily: MONO,
                  fill: '#F6E0A4',
                  letterSpacing: '1.8px',
                }}>
                漢の鮮度
              </text>

              {/* Percentage number — gold shimmer gradient fill */}
              <text x={CX} y={CY + 14} textAnchor="middle"
                style={{
                  fontFamily: SERIF,
                  fill: isCritical ? 'url(#gj-fw-crit-gold)' : 'url(#gj-fw-pct-gold)',
                  fontWeight: 900,
                  filter: isCritical ? 'none' : 'drop-shadow(0 1px 0 rgba(0,0,0,0.55)) drop-shadow(0 0 10px rgba(201,162,74,0.42))',
                }}>
                <tspan style={{ fontSize: '40px', letterSpacing: '-0.5px' }}>{freshness}</tspan>
                <tspan dy="-16" style={{ fontSize: '15px', letterSpacing: '0' }}>%</tspan>
              </text>

              {/* Status text */}
              <text x={CX} y={CY + 33} textAnchor="middle"
                style={{
                  fontSize: '11px',
                  fontFamily: SERIF,
                  fill: isCritical ? 'rgba(240,100,90,0.95)' : freshness < 25 ? 'rgba(240,165,125,0.92)' : '#FCF6BA',
                  letterSpacing: '0.4px',
                }}>
                {g.statusText}
              </text>

              {/* Days remaining */}
              {daysLeft > 0 && (
                <text x={CX} y={CY + 48} textAnchor="middle"
                  style={{
                    fontSize: '10px',
                    fill: 'rgba(245,245,247,0.80)',
                    letterSpacing: '0.6px',
                  }}>
                  次回目安まで あと{daysLeft}日
                </text>
              )}

              {/* Bottom label */}
              <text x={CX} y={CY + 62} textAnchor="middle"
                style={{
                  fontSize: '8px',
                  fontFamily: MONO,
                  fill: 'rgba(201,162,74,0.55)',
                  letterSpacing: '1.6px',
                }}>
                FRESHNESS · 14DAY CYCLE
              </text>
            </svg>
          </div>

          {/* ── Date info row ── */}
          <div style={{
            display: 'flex',
            borderRadius: 12,
            background: 'rgba(201,162,74,0.04)',
            border: '1px solid rgba(201,162,74,0.10)',
            overflow: 'hidden',
            marginBottom: 14,
          }}>
            <div style={{ flex: 1, padding: '10px 14px' }}>
              <p style={{ fontSize: 10, letterSpacing: '0.18em', color: 'rgba(201,162,74,0.76)', marginBottom: 3 }}>
                前回来店日
              </p>
              <p style={{ fontFamily: SERIF, fontSize: 14, fontWeight: 700, color: '#FCF6BA' }}>
                {fmtDate(lastVisitDate)}
              </p>
            </div>
            <div style={{ width: 1, background: 'rgba(201,162,74,0.10)' }} />
            <div style={{ flex: 1, padding: '10px 14px' }}>
              <p style={{ fontSize: 10, letterSpacing: '0.18em', color: 'rgba(201,162,74,0.76)', marginBottom: 3 }}>
                次回推奨日
              </p>
              <p style={{ fontFamily: SERIF, fontSize: 14, fontWeight: 700, color: isOverdue ? 'rgba(242,230,200,0.45)' : '#E0B84A' }}>
                {nextRecommendedDate ? fmtDate(nextRecommendedDate) : '—'}
              </p>
            </div>
          </div>

          {/* Scan result message */}
          {scanMsg && (
            <div style={{ borderRadius: 12, background: 'rgba(224,100,60,0.10)', border: '1px solid rgba(224,100,60,0.28)', padding: '10px 14px', marginBottom: 14 }}>
              <p style={{ fontSize: 12, color: '#E06040', lineHeight: 1.6 }}>{scanMsg}</p>
            </div>
          )}

          {/* ── CTA ── */}
          {reserveCTA}
        </div>
      </div>
    </div>
  )
}
