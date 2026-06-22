import { useEffect, useState } from 'react'
import { getLiveStatuses, subscribeLiveStatuses } from '../utils/liveStatusStore'
import {
  LIVE_STATUS_TEL,
  liveStatusAvailabilityMessage, liveStatusCtaLabel,
} from '../data/liveStatus'
import type { LiveStatusRow, LiveStatusValue } from '../data/liveStatus'
import './liveStatusLuxury.css'

const SANS = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "Hiragino Sans", sans-serif'
const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

const CHAMPAGNE = '#D4C29D'
const OXBLOOD = '#A31D1D'

// 右側に表示する控えめなステータスワード（英字・小さくトラッキング）
const STATUS_WORD: Record<LiveStatusValue, string> = {
  ready: 'READY',
  limited: 'LIMITED',
  full: 'FULL',
  closed: 'CLOSED',
}

function statusWordColor(status: LiveStatusValue): string {
  if (status === 'ready') return CHAMPAGNE
  if (status === 'limited') return OXBLOOD
  return 'rgba(255,255,255,0.32)'
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function latestUpdatedAt(rows: LiveStatusRow[]): string | null {
  if (rows.length === 0) return null
  return rows.reduce((latest, r) => (r.updated_at > latest ? r.updated_at : latest), rows[0].updated_at)
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

  const latest = latestUpdatedAt(rows)

  return (
    <div style={{ background: '#000000', padding: '32px 24px' }}>
      {/* ── Header ── */}
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 18,
      }}>
        <p style={{
          fontFamily: SANS, fontSize: 20, fontWeight: 500, letterSpacing: '2.5px',
          color: '#F5F1E8', margin: 0,
        }}>
          GINJIRO LIVE STATUS
        </p>
        {latest && (
          <p style={{
            fontSize: 11, letterSpacing: '2px', color: 'rgba(212,194,157,0.75)',
            fontFamily: SANS, margin: 0, flexShrink: 0,
          }}>
            最終更新 {fmtTime(latest)}
          </p>
        )}
      </div>

      {/* ── Status rows ── */}
      <div>
        {rows.map((row, i) => {
          const cta = liveStatusCtaLabel(row.status)
          const isLast = i === rows.length - 1
          const wordColor = statusWordColor(row.status)

          return (
            <div
              key={row.id}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 18,
                padding: '24px 0',
                borderBottom: isLast ? 'none' : '1px solid rgba(255,255,255,0.03)',
                background: 'transparent',
              }}
            >
              {/* ── Left: name + subcopy ── */}
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{
                  fontFamily: SERIF, fontWeight: 500, fontSize: 18, letterSpacing: '2px',
                  color: '#ffffff', margin: 0, marginBottom: 8,
                }}>
                  {row.name}
                </p>
                <p style={{
                  fontSize: 12, letterSpacing: '1.2px', color: 'rgba(255,255,255,0.58)',
                  fontFamily: SANS, margin: 0,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {liveStatusAvailabilityMessage(row)}
                </p>
              </div>

              {/* ── Right: status word + ghost CTA ── */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                <span
                  className={row.status === 'limited' ? 'gj-luxury-status--limited' : undefined}
                  style={{
                    fontSize: 10, letterSpacing: '2px', fontWeight: 600,
                    color: wordColor, fontFamily: SANS, whiteSpace: 'nowrap',
                    textShadow: row.status === 'ready' ? '0 0 4px rgba(212,194,157,0.2)' : 'none',
                  }}
                >
                  {STATUS_WORD[row.status]}
                </span>

                {cta && (
                  <a
                    href={`tel:${LIVE_STATUS_TEL}`}
                    className="gj-luxury-tel"
                    style={{
                      background: 'transparent',
                      border: '1px solid rgba(212,194,157,0.3)',
                      color: CHAMPAGNE,
                      padding: '8px 12px',
                      borderRadius: 2,
                      fontSize: 11, fontWeight: 400, letterSpacing: '1px',
                      fontFamily: SANS, textDecoration: 'none', whiteSpace: 'nowrap',
                    }}
                  >
                    {cta}
                  </a>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
