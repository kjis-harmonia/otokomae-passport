import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { getLiveStatuses, subscribeLiveStatuses } from '../utils/liveStatusStore'
import { LIVE_STATUS_COLORS, liveStatusLabel } from '../data/liveStatus'
import type { LiveStatusRow } from '../data/liveStatus'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const MONO = 'ui-monospace, "SF Mono", "Fira Code", monospace'

function fmtUpdatedAt(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function SectionHeader() {
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
      <SectionHeader />
      <div
        style={{
          display: 'flex', gap: 14,
          overflowX: 'scroll', scrollbarWidth: 'none',
          paddingLeft: 20, paddingRight: 20, paddingTop: 6, paddingBottom: 6,
          WebkitOverflowScrolling: 'touch',
        } as React.CSSProperties}
        className="[&::-webkit-scrollbar]:hidden"
      >
        {rows.map((row, i) => {
          const isCenter = i === Math.floor((rows.length - 1) / 2)
          const c = LIVE_STATUS_COLORS[row.status]
          const isDim = row.status === 'full' || row.status === 'closed'
          const isGlowing = row.status === 'ready' || row.status === 'limited'

          return (
            <motion.div
              key={row.id}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08, duration: 0.4 }}
              style={{
                flexShrink: 0,
                width: isCenter ? 'clamp(150px, 42vw, 168px)' : 'clamp(130px, 37vw, 148px)',
                aspectRatio: '3/4',
                borderRadius: 18,
                background: 'linear-gradient(155deg, #130608 0%, #0A0404 55%, #080407 100%)',
                border: `1.5px solid ${c.border}`,
                boxShadow: [
                  '0 14px 40px rgba(0,0,0,0.65)',
                  isGlowing ? `0 0 28px ${c.glow}` : '',
                ].filter(Boolean).join(', '),
                opacity: isDim ? 0.55 : 1,
                transform: isCenter ? 'scale(1.0)' : 'scale(0.93)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '14px 10px',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              <div style={{ height: 2, position: 'absolute', top: 0, left: 0, right: 0, background: `linear-gradient(90deg, transparent, ${c.border} 50%, transparent)` }} />

              <p style={{
                fontSize: 9, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.50)',
                fontFamily: MONO, marginBottom: 8,
              }}>
                SEAT
              </p>
              <p style={{
                fontFamily: SERIF, fontSize: isCenter ? 19 : 16, fontWeight: 700,
                color: '#F2E6C8', letterSpacing: '0.06em', marginBottom: 14, textAlign: 'center',
              }}>
                {row.name}
              </p>

              <div style={{
                padding: '5px 14px', borderRadius: 99,
                background: isGlowing ? `${c.glow}` : 'rgba(255,255,255,0.04)',
                border: `1px solid ${c.border}`,
                marginBottom: 10,
              }}>
                <span style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: '0.10em',
                  color: isDim ? c.color : '#0B0403',
                  fontFamily: SERIF,
                }}>
                  {liveStatusLabel(row.id, row.status)}
                </span>
              </div>

              <p style={{ fontSize: 8, letterSpacing: '0.10em', color: 'rgba(242,230,200,0.30)', fontFamily: MONO }}>
                更新 {fmtUpdatedAt(row.updated_at)}
              </p>
            </motion.div>
          )
        })}
        <div style={{ width: 6, flexShrink: 0 }} />
      </div>
    </div>
  )
}
