import { useCallback, useEffect, useRef, useState } from 'react'
import { getLiveStatuses, subscribeLiveStatuses } from '../utils/liveStatusStore'
import {
  LIVE_STATUS_TEL,
  liveStatusAvailabilityMessage, liveStatusCtaLabel, liveStatusLabel,
} from '../data/liveStatus'
import type { LiveStatusRow, LiveStatusValue } from '../data/liveStatus'
import './liveStatusLuxury.css'

const SANS = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "Hiragino Sans", sans-serif'
const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

// 控えめな装飾用の英字コード（顧客向けの主要情報ではない）
const STATUS_WORD: Record<LiveStatusValue, string> = {
  ready: 'READY',
  limited: 'LIMITED',
  full: 'FULL',
  closed: 'CLOSED',
}

type CardTheme = {
  statusColor: string
  auraColor: string
  edgeColor: string
  dim: boolean
}

const CAROUSEL_THEME: Record<LiveStatusValue, CardTheme> = {
  ready:   { statusColor: '#D4C29D', auraColor: 'rgba(212,194,157,0.40)', edgeColor: 'rgba(212,194,157,0.30)', dim: false },
  limited: { statusColor: '#C23B3B', auraColor: 'rgba(163,29,29,0.42)',  edgeColor: 'rgba(163,29,29,0.32)',  dim: false },
  full:    { statusColor: 'rgba(255,255,255,0.40)', auraColor: 'transparent', edgeColor: 'rgba(255,255,255,0.07)', dim: true },
  closed:  { statusColor: 'rgba(255,255,255,0.30)', auraColor: 'transparent', edgeColor: 'rgba(255,255,255,0.05)', dim: true },
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
  const [activeIndex, setActiveIndex] = useState(0)
  const trackRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<(HTMLDivElement | null)[]>([])
  const hasCenteredRef = useRef(false)

  useEffect(() => {
    getLiveStatuses().then((data) => {
      setRows(data)
      setActiveIndex(Math.floor((data.length - 1) / 2))
    })
    const unsubscribe = subscribeLiveStatuses((updated) => {
      setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
    })
    return unsubscribe
  }, [])

  const handleScroll = useCallback(() => {
    const track = trackRef.current
    if (!track) return
    const trackCenter = track.scrollLeft + track.clientWidth / 2
    let closest = 0
    let closestDist = Infinity
    cardRefs.current.forEach((card, idx) => {
      if (!card) return
      const cardCenter = card.offsetLeft + card.offsetWidth / 2
      const dist = Math.abs(cardCenter - trackCenter)
      if (dist < closestDist) { closestDist = dist; closest = idx }
    })
    setActiveIndex(closest)
  }, [])

  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => { raf = 0; handleScroll() })
    }
    track.addEventListener('scroll', onScroll, { passive: true })
    return () => track.removeEventListener('scroll', onScroll)
  }, [handleScroll, rows.length])

  // 初回マウント時、activeカードを画面中央へ実際にスクロールして揃える
  // （scroll-snap-alignだけではユーザーがスクロールするまで中央に揃わないため）
  useEffect(() => {
    if (rows.length === 0 || hasCenteredRef.current) return
    const raf = requestAnimationFrame(() => {
      const track = trackRef.current
      const card = cardRefs.current[activeIndex]
      if (track && card) {
        track.scrollLeft = card.offsetLeft + card.offsetWidth / 2 - track.clientWidth / 2
        hasCenteredRef.current = true
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [rows, activeIndex])

  if (rows.length === 0) return null

  const latest = latestUpdatedAt(rows)

  return (
    <div style={{ background: '#000000', padding: '28px 0' }}>
      {/* ── Header ── */}
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 16, padding: '0 24px',
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

      {/* ── Cinematic carousel ── */}
      <div
        ref={trackRef}
        className="gj-carousel-track [&::-webkit-scrollbar]:hidden"
        style={{
          display: 'flex', alignItems: 'center',
          gap: 14,
          overflowX: 'scroll', scrollbarWidth: 'none',
          paddingLeft: 'calc(50% - min(38vw, 160px))',
          paddingRight: 'calc(50% - min(38vw, 160px))',
          paddingTop: 14, paddingBottom: 14,
          WebkitOverflowScrolling: 'touch',
        } as React.CSSProperties}
      >
        {rows.map((row, i) => {
          const theme = CAROUSEL_THEME[row.status]
          const cta = liveStatusCtaLabel(row.status)
          const isActive = i === activeIndex
          const isGlowing = !theme.dim

          return (
            <div
              key={row.id}
              ref={(el) => { cardRefs.current[i] = el }}
              className="gj-carousel-card"
              style={{
                flexShrink: 0,
                width: 'min(76vw, 320px)',
                height: 158,
                borderRadius: 18,
                position: 'relative',
                overflow: 'hidden',
                background: 'linear-gradient(165deg, rgba(22,15,11,0.94) 0%, rgba(6,4,3,0.98) 100%)',
                backdropFilter: 'blur(6px)',
                WebkitBackdropFilter: 'blur(6px)',
                border: `1px solid ${theme.edgeColor}`,
                boxShadow: [
                  '0 18px 40px rgba(0,0,0,0.75)',
                  isActive && isGlowing ? `0 14px 32px ${theme.auraColor}` : '',
                ].filter(Boolean).join(', '),
                transform: isActive ? 'scale(1.07)' : 'scale(0.90)',
                opacity: isActive ? 1 : (theme.dim ? 0.40 : 0.48),
                padding: '13px 18px',
                display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
              }}
            >
              {/* ── bottom aura (READY/LIMITED only) ── */}
              {isGlowing && (
                <div
                  aria-hidden="true"
                  className={row.status === 'limited' ? 'gj-carousel-aura--limited' : undefined}
                  style={{
                    position: 'absolute', left: '10%', right: '10%', bottom: -20, height: 46,
                    background: `radial-gradient(ellipse at center, ${theme.auraColor} 0%, transparent 72%)`,
                    filter: 'blur(10px)',
                    opacity: isActive ? 1 : 0.4,
                    pointerEvents: 'none',
                  }}
                />
              )}

              {/* ── 左カラム: スタイリスト名 ── */}
              <div style={{ position: 'relative', zIndex: 1, minWidth: 0, flexShrink: 1 }}>
                <p style={{
                  fontSize: 9, letterSpacing: '2px', color: 'rgba(255,255,255,0.30)',
                  fontFamily: SANS, margin: 0, marginBottom: 5,
                }}>
                  {STATUS_WORD[row.status]}
                </p>
                <p style={{
                  fontFamily: SERIF, fontWeight: 800, fontSize: 28, letterSpacing: '1px',
                  color: '#ffffff', margin: 0, lineHeight: 1.1,
                  textShadow: '0 1px 3px rgba(0,0,0,0.85), 0 0 18px rgba(212,194,157,0.16)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {row.name}
                </p>
              </div>

              {/* ── 右カラム: 日本語ステータス・空き状況・CTA（右揃え） ── */}
              <div style={{
                position: 'relative', zIndex: 1, flexShrink: 0,
                display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
                marginLeft: 14, textAlign: 'right',
              }}>
                <p style={{
                  fontFamily: SERIF, fontSize: 21, fontWeight: 700, letterSpacing: '0.5px',
                  color: theme.statusColor, margin: 0, marginBottom: 3,
                  textShadow: isGlowing ? `0 0 14px ${theme.auraColor}` : 'none',
                  whiteSpace: 'nowrap',
                }}>
                  {liveStatusLabel(row.id, row.status)}
                </p>
                <p style={{
                  fontSize: 15, fontWeight: 600, letterSpacing: '0.2px', color: '#EDE3D0',
                  fontFamily: SANS, margin: 0, marginBottom: cta ? 7 : 0,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
                }}>
                  {liveStatusAvailabilityMessage(row)}
                </p>

                {cta && (
                  <a
                    href={`tel:${LIVE_STATUS_TEL}`}
                    className="gj-carousel-tel"
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      height: 35, boxSizing: 'border-box',
                      background: 'rgba(0,0,0,0.45)',
                      border: '1px solid rgba(212,194,157,0.45)',
                      color: '#D4C29D',
                      padding: '0 14px',
                      borderRadius: 3,
                      fontSize: 14, fontWeight: 500, letterSpacing: '1px',
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
