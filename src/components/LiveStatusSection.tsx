import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { getLiveStatuses, subscribeLiveStatuses } from '../utils/liveStatusStore'
import {
  LIVE_STATUS_CODES, LIVE_STATUS_THEME, LIVE_STATUS_TEL,
  liveStatusAvailabilityMessage, liveStatusCtaLabel, liveStatusLabel, liveStatusPulseClass, liveStatusSignpoleClass,
} from '../data/liveStatus'
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
      marginBottom: 16,
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
      <div
        style={{
          display: 'flex', gap: 14,
          overflowX: 'scroll', scrollbarWidth: 'none',
          paddingLeft: 20, paddingRight: 20, paddingTop: 10, paddingBottom: 10,
          WebkitOverflowScrolling: 'touch',
        } as React.CSSProperties}
        className="[&::-webkit-scrollbar]:hidden"
      >
        {rows.map((row, i) => {
          const isCenter = i === Math.floor((rows.length - 1) / 2)
          const t = LIVE_STATUS_THEME[row.status]
          const cta = liveStatusCtaLabel(row.status)

          return (
            <motion.div
              key={row.id}
              className={liveStatusPulseClass(row.status)}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08, duration: 0.4 }}
              style={{
                flexShrink: 0,
                width: 'min(61vw, 246px)',
                height: isCenter ? 150 : 140,
                borderRadius: 18,
                background: 'linear-gradient(155deg, #130608 0%, #0A0404 55%, #080407 100%)',
                border: `1.5px solid ${t.border}`,
                boxShadow: [
                  '0 14px 36px rgba(0,0,0,0.65)',
                  t.glow,
                ].filter(Boolean).join(', '),
                opacity: t.dim ? 0.62 : 1,
                transform: isCenter ? 'scale(1.07)' : 'scale(0.96)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '16px 18px',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              <div className={liveStatusSignpoleClass(row.status)} aria-hidden="true" />

              <div style={{ height: 2, position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1, background: `linear-gradient(90deg, transparent, ${t.border} 50%, transparent)` }} />

              <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
                <p style={{
                  fontFamily: SERIF, fontSize: isCenter ? 21 : 19, fontWeight: 700,
                  color: '#F2E6C8', letterSpacing: '0.05em', lineHeight: 1.15,
                }}>
                  {row.name}
                </p>
                <p style={{
                  fontFamily: MONO, fontSize: isCenter ? 22 : 19, fontWeight: 700,
                  color: t.codeColor, letterSpacing: '0.06em', lineHeight: 1.15,
                }}>
                  {LIVE_STATUS_CODES[row.status]}
                </p>
                <p style={{
                  fontSize: 13, fontWeight: 600, color: t.descColor, letterSpacing: '0.04em',
                }}>
                  {liveStatusLabel(row.id, row.status)}
                </p>
                <p style={{
                  fontSize: 12, fontWeight: 700, color: t.availabilityColor, letterSpacing: '0.02em',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
                }}>
                  {liveStatusAvailabilityMessage(row)}
                </p>
              </div>

              {cta && (
                <a
                  href={`tel:${LIVE_STATUS_TEL}`}
                  style={{
                    position: 'relative', zIndex: 1,
                    flexShrink: 0, marginLeft: 6,
                    padding: '8px 9px', borderRadius: 11,
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
            </motion.div>
          )
        })}
        <div style={{ width: 6, flexShrink: 0 }} />
      </div>
    </div>
  )
}
