import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { getLiveStatuses, subscribeLiveStatuses } from '../utils/liveStatusStore'
import {
  LIVE_STATUS_TEL,
  liveStatusAvailabilityMessage, liveStatusCtaLabel, liveStatusLabel, liveStatusPulseClass, liveStatusSignpoleClass,
} from '../data/liveStatus'
import { LIVE_STATUS_THEME } from '../data/liveStatus'
import type { LiveStatusRow } from '../data/liveStatus'
import './liveStatusSignpole.css'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const MONO = 'ui-monospace, "SF Mono", "Fira Code", monospace'

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function latestUpdatedAt(rows: LiveStatusRow[]): string | null {
  if (rows.length === 0) return null
  return rows.reduce((latest, r) => (r.updated_at > latest ? r.updated_at : latest), rows[0].updated_at)
}

function SectionHeader({ rows }: { rows: LiveStatusRow[] }) {
  const latest = latestUpdatedAt(rows)
  return (
    <div style={{
      marginBottom: 10,
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '0 20px',
    }}>
      <p style={{
        fontSize: 17, fontWeight: 700, lineHeight: 1, flexShrink: 0,
        color: '#F2E6C8', fontFamily: SERIF,
      }}>
        GINJIRO LIVE STATUS
      </p>
      <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, rgba(201,162,74,0.30), transparent)' }} />
      {latest && (
        <p style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', color: '#E8C868', flexShrink: 0, fontFamily: MONO, whiteSpace: 'nowrap' }}>
          最終更新 {fmtTime(latest)}
        </p>
      )}
    </div>
  )
}

export function LiveStatusSection() {
  const [rows, setRows] = useState<LiveStatusRow[]>([])

  useEffect(() => {
    getLiveStatuses().then(setRows)
    const unsubscribe = subscribeLiveStatuses((updated) => {
      setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
    })
    return unsubscribe
  }, [])

  if (rows.length === 0) return null

  return (
    <div>
      <SectionHeader rows={rows} />

      {/* ── モノリシック・メタルパネル ── */}
      <div style={{ padding: '0 20px' }}>
        <div
          style={{
            borderRadius: 20,
            background: 'linear-gradient(165deg, #0E0B09 0%, #070504 55%, #050403 100%)',
            border: '1px solid rgba(201,162,74,0.16)',
            boxShadow: [
              '0 18px 44px rgba(0,0,0,0.70)',
              'inset 0 1px 0 rgba(255,255,255,0.025)',
              'inset 0 0 0 0.5px rgba(201,162,74,0.06)',
            ].join(', '),
            padding: 8,
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {/* hairline metal texture */}
          <div
            aria-hidden="true"
            style={{
              position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0,
              backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.012) 2px, rgba(255,255,255,0.012) 3px)',
              mixBlendMode: 'overlay',
            }}
          />
          {/* top ambient edge light */}
          <div
            aria-hidden="true"
            style={{
              position: 'absolute', top: 0, left: 0, right: 0, height: 1, zIndex: 1,
              background: 'linear-gradient(90deg, transparent 0%, rgba(139,26,26,0.5) 18%, rgba(201,162,74,0.85) 50%, rgba(139,26,26,0.5) 82%, transparent 100%)',
            }}
          />

          <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {rows.map((row, i) => {
              const t = LIVE_STATUS_THEME[row.status]
              const cta = liveStatusCtaLabel(row.status)
              const isGlowing = row.status === 'ready' || row.status === 'limited'

              return (
                <motion.div
                  key={row.id}
                  className={liveStatusPulseClass(row.status)}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.06, duration: 0.32 }}
                  style={{
                    position: 'relative',
                    height: 64,
                    borderRadius: 16,
                    overflow: 'hidden',
                    background: 'linear-gradient(155deg, #130608 0%, #0A0404 60%, #08040A 100%)',
                    border: `1px solid ${t.border}`,
                    boxShadow: isGlowing ? t.glow : 'none',
                    opacity: t.dim ? 0.58 : 1,
                  }}
                >
                  {/* digital signpole stripe layer */}
                  <div className={liveStatusSignpoleClass(row.status)} aria-hidden="true" />

                  {/* left edge light slit */}
                  <div
                    aria-hidden="true"
                    style={{
                      position: 'absolute', top: 0, left: 0, bottom: 0, width: 3, zIndex: 1,
                      background: t.border,
                      boxShadow: isGlowing ? `0 0 10px ${t.border}` : 'none',
                    }}
                  />

                  <div style={{
                    position: 'relative', zIndex: 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    height: '100%', padding: '0 14px 0 16px', gap: 10,
                  }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
                        <span style={{
                          fontFamily: SERIF, fontSize: 16, fontWeight: 700,
                          color: '#F2E6C8', letterSpacing: '0.04em', flexShrink: 0,
                        }}>
                          {row.name}
                        </span>
                        <span style={{
                          fontSize: 12, fontWeight: 700, color: t.codeColor, letterSpacing: '0.02em',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
                        }}>
                          {liveStatusLabel(row.id, row.status)}
                        </span>
                      </div>
                      <p style={{
                        fontSize: 11, fontWeight: 600, color: t.availabilityColor, letterSpacing: '0.01em',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
                      }}>
                        {liveStatusAvailabilityMessage(row)}
                      </p>
                    </div>

                    {cta && (
                      <a
                        href={`tel:${LIVE_STATUS_TEL}`}
                        style={{
                          flexShrink: 0,
                          padding: '9px 12px', borderRadius: 10,
                          background: t.ctaBg,
                          border: `1px solid ${t.ctaBorder}`,
                          color: t.ctaColor,
                          fontFamily: SERIF, fontSize: 11, fontWeight: 700, letterSpacing: '0.01em',
                          textAlign: 'center', textDecoration: 'none',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {cta}
                      </a>
                    )}
                  </div>
                </motion.div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
