import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { MAINTENANCE_CUT_URL } from '../data/reserveLinks'
import { fmtDate } from '../utils/maintenanceSchedule'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const MONO = 'ui-monospace, "SF Mono", "Fira Code", monospace'

// ── SVG gauge constants (viewBox 0 0 220 220) ─────────────────────────────────
const CX = 110
const CY = 110
const RING_R = 84
const CIRC = 2 * Math.PI * RING_R  // ≈ 527.79

// 14 tick marks: one per day interval, day-0 at top (clockwise)
const TICKS = Array.from({ length: 14 }, (_, i) => {
  const angle = (i / 14) * Math.PI * 2 - Math.PI / 2
  const isMajor = i === 0 || i === 7
  const r1 = isMajor ? 90 : 94
  return {
    x1: CX + r1 * Math.cos(angle),
    y1: CY + r1 * Math.sin(angle),
    x2: CX + 100 * Math.cos(angle),
    y2: CY + 100 * Math.sin(angle),
    isMajor,
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
          {/* Ambient empty ring */}
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

  const borderColor = isOverdue ? 'rgba(139,26,26,0.44)' : 'rgba(201,162,74,0.18)'
  const accentLine = isOverdue
    ? 'linear-gradient(90deg, transparent 0%, #6B0F12 30%, #8B1A1A 50%, #6B0F12 70%, transparent 100%)'
    : 'linear-gradient(90deg, transparent 0%, #5A0A0E 20%, #C9A24A 50%, #5A0A0E 80%, transparent 100%)'

  // CTA: use external callback if provided, otherwise link to URL
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
        <p style={{ fontSize: 10, letterSpacing: '0.14em', color: 'rgba(201,162,74,0.44)', textAlign: 'center' }}>
          通知ON — 来店3日前にお知らせします
        </p>
      ) : notifPermission === 'denied' ? (
        <p style={{ fontSize: 10, letterSpacing: '0.12em', color: 'rgba(200,80,60,0.50)', textAlign: 'center' }}>
          通知が拒否されています（設定から変更できます）
        </p>
      ) : (
        <button type="button" onClick={onRequestNotif}
          style={{
            width: '100%', padding: '13px 0', borderRadius: 14, cursor: 'pointer',
            background: 'rgba(201,162,74,0.06)', border: '1px solid rgba(201,162,74,0.24)',
            fontSize: 12, letterSpacing: '0.14em', color: 'rgba(201,162,74,0.76)', fontFamily: SERIF,
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
        background: 'linear-gradient(155deg, #120608 0%, #0A0404 60%, #080506 100%)',
        border: `1px solid ${borderColor}`,
        boxShadow: [
          '0 16px 52px rgba(0,0,0,0.70)',
          'inset 0 1px 0 rgba(255,255,255,0.02)',
          g.isCritical ? '0 0 64px rgba(100,16,16,0.20)' : '',
        ].filter(Boolean).join(', '),
        overflow: 'hidden',
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
                {/* Brushed-gold bezel gradient */}
                <linearGradient id="gj-fw-bezel" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%"   stopColor="#C9A24A" stopOpacity="0.68" />
                  <stop offset="20%"  stopColor="#7A5A18" stopOpacity="0.34" />
                  <stop offset="44%"  stopColor="#EDD070" stopOpacity="0.96" />
                  <stop offset="68%"  stopColor="#6A4C10" stopOpacity="0.30" />
                  <stop offset="100%" stopColor="#C9A24A" stopOpacity="0.62" />
                </linearGradient>
                {/* Dark metallic dial */}
                <radialGradient id="gj-fw-dial" cx="42%" cy="34%" r="64%">
                  <stop offset="0%"   stopColor="#1C0E0B" />
                  <stop offset="55%"  stopColor="#0C0605" />
                  <stop offset="100%" stopColor="#050303" />
                </radialGradient>
                {/* Arc glow blur */}
                <filter id="gj-fw-glow" x="-55%" y="-55%" width="210%" height="210%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="6" />
                </filter>
                {/* Subtle bezel glow for critical state */}
                <filter id="gj-fw-crit-aura" x="-20%" y="-20%" width="140%" height="140%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="4" />
                </filter>
              </defs>

              {/* ── Outer critical aura ── */}
              {g.isCritical && (
                <circle cx={CX} cy={CY} r={109} fill="none"
                  stroke="rgba(139,26,26,0.28)" strokeWidth={10}
                  filter="url(#gj-fw-crit-aura)" />
              )}

              {/* ── Bezel ring (brushed gold) ── */}
              <circle cx={CX} cy={CY} r={107} fill="none"
                stroke="url(#gj-fw-bezel)" strokeWidth={3.5} />
              <circle cx={CX} cy={CY} r={103.8} fill="none"
                stroke="rgba(0,0,0,0.52)" strokeWidth={0.5} />

              {/* ── Dark metallic dial ── */}
              <circle cx={CX} cy={CY} r={103} fill="url(#gj-fw-dial)" />

              {/* ── Inner bezel line (subtle depth) ── */}
              <circle cx={CX} cy={CY} r={102} fill="none"
                stroke="rgba(255,255,255,0.025)" strokeWidth={0.5} />

              {/* ── Tick marks: 14 day intervals ── */}
              {TICKS.map((t, i) => (
                <line key={i}
                  x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
                  stroke={t.isMajor ? 'rgba(201,162,74,0.42)' : 'rgba(201,162,74,0.16)'}
                  strokeWidth={t.isMajor ? 1.5 : 0.75}
                  strokeLinecap="round" />
              ))}

              {/* ── Track ring (empty channel) ── */}
              <circle cx={CX} cy={CY} r={RING_R} fill="none"
                stroke="rgba(255,255,255,0.045)" strokeWidth={11} />

              {/* ── Glow behind progress arc (pulsing for critical) ── */}
              {freshness > 0 && (
                <motion.circle
                  cx={CX} cy={CY} r={RING_R}
                  fill="none"
                  stroke={g.glowColor}
                  strokeWidth={24}
                  strokeDasharray={`${filledArc} ${CIRC}`}
                  strokeLinecap="round"
                  transform={`rotate(-90 ${CX} ${CY})`}
                  filter="url(#gj-fw-glow)"
                  animate={g.isPulsing && !reducedMotion
                    ? { opacity: [0.20, 0.52, 0.20] }
                    : { opacity: 0.28 }
                  }
                  transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
                />
              )}

              {/* ── Progress arc (freshness indicator) ── */}
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
                    : { duration: 0.88, ease: [0.4, 0, 0.2, 1] }
                  }
                />
              )}

              {/* ── Inner separator ring ── */}
              <circle cx={CX} cy={CY} r={71} fill="none"
                stroke="rgba(201,162,74,0.07)" strokeWidth={0.5} />

              {/* ════════════════════════════════
                  Center text (all in SVG units so
                  it scales with the gauge)
                  ════════════════════════════════ */}

              {/* Top label: 漢の鮮度 */}
              <text x={CX} y={CY - 33} textAnchor="middle"
                style={{
                  fontSize: '7px',
                  fontFamily: MONO,
                  fill: 'rgba(201,162,74,0.40)',
                  letterSpacing: '1.8px',
                }}>
                漢の鮮度
              </text>

              {/* Percentage number */}
              <text x={CX} y={CY + 14} textAnchor="middle"
                style={{
                  fontFamily: SERIF,
                  fill: g.color,
                  fontWeight: 'bold',
                }}>
                <tspan style={{ fontSize: '40px', letterSpacing: '-0.5px' }}>{freshness}</tspan>
                <tspan dy="-16" style={{ fontSize: '15px', letterSpacing: '0' }}>%</tspan>
              </text>

              {/* Status text */}
              <text x={CX} y={CY + 33} textAnchor="middle"
                style={{
                  fontSize: '8px',
                  fontFamily: SERIF,
                  fill: g.color,
                  opacity: 0.82,
                  letterSpacing: '0.4px',
                }}>
                {g.statusText}
              </text>

              {/* Days remaining (only when within cycle) */}
              {daysLeft > 0 && (
                <text x={CX} y={CY + 48} textAnchor="middle"
                  style={{
                    fontSize: '7.5px',
                    fill: 'rgba(242,230,200,0.28)',
                    letterSpacing: '0.6px',
                  }}>
                  次回目安まで あと{daysLeft}日
                </text>
              )}

              {/* Bottom label */}
              <text x={CX} y={CY + 62} textAnchor="middle"
                style={{
                  fontSize: '6.5px',
                  fontFamily: MONO,
                  fill: 'rgba(201,162,74,0.20)',
                  letterSpacing: '1.8px',
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
              <p style={{ fontSize: 8, letterSpacing: '0.18em', color: 'rgba(201,162,74,0.44)', marginBottom: 3 }}>
                前回来店日
              </p>
              <p style={{ fontFamily: SERIF, fontSize: 13, fontWeight: 700, color: '#F2E6C8' }}>
                {fmtDate(lastVisitDate)}
              </p>
            </div>
            <div style={{ width: 1, background: 'rgba(201,162,74,0.10)' }} />
            <div style={{ flex: 1, padding: '10px 14px' }}>
              <p style={{ fontSize: 8, letterSpacing: '0.18em', color: 'rgba(201,162,74,0.44)', marginBottom: 3 }}>
                次回推奨日
              </p>
              <p style={{ fontFamily: SERIF, fontSize: 13, fontWeight: 700, color: isOverdue ? 'rgba(242,230,200,0.32)' : '#C9A24A' }}>
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
