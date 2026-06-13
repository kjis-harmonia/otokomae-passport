import { useRef, useState, useEffect } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import passportTemplate from '../assets/passport/otokomae-passport-template.png'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

interface Props {
  userId: string
  name: string
  issuedAt: string
  lastVisitDate: string | null | undefined
  onClick?: () => void
  showCalibrate?: boolean
  calibCoords?: { x: number; y: number } | null
  onPointerMove?: (e: React.PointerEvent<HTMLDivElement>) => void
  onPointerLeave?: () => void
}

export function PassportCard({
  userId,
  name,
  issuedAt,
  lastVisitDate,
  onClick,
  showCalibrate,
  calibCoords,
  onPointerMove,
  onPointerLeave,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [cardW, setCardW] = useState(() => Math.max(300, (window?.innerWidth ?? 390) - 32))

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setCardW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const qrPayload = JSON.stringify({ type: 'ginjiro-member', userId, name, issuedAt })

  const issuedDateFmt = issuedAt
    ? new Date(issuedAt).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })
    : '—'
  const lastVisitFmt = lastVisitDate
    ? new Date(lastVisitDate + 'T00:00:00').toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })
    : '—'
  const shortId = userId.length > 24 ? userId.slice(0, 24) + '…' : userId

  // Font sizes relative to card width for consistent scaling across all iPhone sizes
  const fName = cardW * 0.052
  const fSama = cardW * 0.035
  const fId   = cardW * 0.021
  const fDate = cardW * 0.030

  return (
    <div
      ref={containerRef}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={() => !showCalibrate && onClick?.()}
      onKeyDown={e => e.key === 'Enter' && !showCalibrate && onClick?.()}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: '941 / 1672',
        overflow: 'hidden',
        borderRadius: 12,
        cursor: showCalibrate ? 'crosshair' : onClick ? 'pointer' : 'default',
        boxShadow: showCalibrate
          ? '0 0 0 2px rgba(0,255,255,0.6)'
          : '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(201,162,74,0.2)',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {/* Background: template image fills the aspect-ratio container */}
      <img
        src={passportTemplate}
        alt=""
        aria-hidden
        draggable={false}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'fill',
          display: 'block',
          userSelect: 'none',
        }}
      />

      {/* HTML overlay layer — all positioned as % of container */}
      <div style={{ position: 'absolute', inset: 0 }}>

        {/* QR — center x=30.5%, center y=53%; left=17%, width=27% */}
        <div style={{
          position: 'absolute',
          top: '45.5%',
          left: '17%',
          width: '27%',
          background: '#FFFFFF',
          padding: '1.4%',
          borderRadius: 3,
          boxSizing: 'border-box',
        }}>
          <QRCodeSVG
            value={qrPayload}
            size={200}
            level="M"
            marginSize={0}
            style={{ width: '100%', height: 'auto', display: 'block' }}
          />
        </div>

        {/* 会員名 + 様 — center x=70%, center y=55% */}
        <div style={{
          position: 'absolute',
          top: '55%',
          left: '41%',
          right: '3%',
          transform: 'translateY(-50%)',
          textAlign: 'center',
        }}>
          <p style={{
            fontFamily: SERIF,
            fontSize: fName,
            fontWeight: 700,
            color: '#F2E6C8',
            letterSpacing: '0.05em',
            lineHeight: 1.15,
            margin: 0,
          }}>
            {name}
            <span style={{
              fontSize: fSama,
              fontWeight: 400,
              color: 'rgba(242,230,200,0.5)',
              marginLeft: '0.25em',
            }}>様</span>
          </p>
        </div>

        {/* 会員ID — center x=70%, center y=61% */}
        <div style={{
          position: 'absolute',
          top: '61%',
          left: '41%',
          right: '3%',
          transform: 'translateY(-50%)',
          textAlign: 'center',
        }}>
          <p style={{
            fontFamily: 'monospace',
            fontSize: fId,
            color: 'rgba(242,230,200,0.45)',
            letterSpacing: '0.02em',
            wordBreak: 'break-all',
            lineHeight: 1.4,
            margin: 0,
          }}>
            {shortId}
          </p>
        </div>

        {/* 入会日 — center x=26.9%, center y=72.3% */}
        <div style={{
          position: 'absolute',
          top: '72.3%',
          left: '3%',
          right: '50%',
          transform: 'translateY(-50%)',
          textAlign: 'center',
        }}>
          <p style={{ fontSize: fDate, color: '#F2E6C8', fontFamily: SERIF, letterSpacing: '0.03em', margin: 0 }}>
            {issuedDateFmt}
          </p>
        </div>

        {/* 最終来店日 — center x=72.8%, center y=72.3% */}
        <div style={{
          position: 'absolute',
          top: '72.3%',
          left: '50%',
          right: '3%',
          transform: 'translateY(-50%)',
          textAlign: 'center',
        }}>
          <p style={{ fontSize: fDate, color: '#F2E6C8', fontFamily: SERIF, letterSpacing: '0.03em', margin: 0 }}>
            {lastVisitFmt}
          </p>
        </div>

        {/* 下段隠蔽 — 来店回数 / 施術メニュー / 次回推奨日 をカバー */}
        <div style={{
          position: 'absolute',
          top: '74%',
          left: 0, right: 0, bottom: 0,
          background: 'linear-gradient(to bottom, transparent 0%, #0A0907 14%)',
          pointerEvents: 'none',
          zIndex: 2,
        }} />

        {/* DEV: キャリブレーショングリッド */}
        {showCalibrate && (
          <>
            {Array.from({ length: 19 }, (_, i) => (i + 1) * 5).map(pct => (
              <div key={`h${pct}`} style={{
                position: 'absolute', top: `${pct}%`, left: 0, right: 0,
                height: 1, pointerEvents: 'none', zIndex: 8,
                background: pct % 10 === 0 ? 'rgba(0,255,255,0.65)' : 'rgba(0,255,255,0.25)',
              }}>
                <span style={{ position: 'absolute', right: 2, top: -8, fontSize: 7, color: 'cyan', background: 'rgba(0,0,0,0.75)', padding: '0 2px', lineHeight: 1.4 }}>
                  {pct}%
                </span>
              </div>
            ))}
            {Array.from({ length: 9 }, (_, i) => (i + 1) * 10).map(pct => (
              <div key={`v${pct}`} style={{
                position: 'absolute', left: `${pct}%`, top: 0, bottom: 0,
                width: 1, pointerEvents: 'none', zIndex: 8,
                background: 'rgba(255,255,0,0.35)',
              }}>
                <span style={{ position: 'absolute', top: 2, left: 2, fontSize: 7, color: 'yellow', background: 'rgba(0,0,0,0.75)', padding: '0 2px', lineHeight: 1.4, whiteSpace: 'nowrap' }}>
                  {pct}%
                </span>
              </div>
            ))}
            {calibCoords && (
              <>
                <div style={{ position: 'absolute', top: `${calibCoords.y}%`, left: 0, right: 0, height: 1, background: 'rgba(255,0,80,0.9)', pointerEvents: 'none', zIndex: 9 }} />
                <div style={{ position: 'absolute', left: `${calibCoords.x}%`, top: 0, bottom: 0, width: 1, background: 'rgba(255,0,80,0.9)', pointerEvents: 'none', zIndex: 9 }} />
                <div style={{
                  position: 'absolute',
                  top: `${calibCoords.y}%`,
                  left: `${Math.min(calibCoords.x, 60)}%`,
                  transform: `translate(${calibCoords.x > 60 ? '-108%' : '8px'}, -110%)`,
                  background: 'rgba(0,0,0,0.92)',
                  color: '#0F0',
                  fontSize: 11,
                  fontFamily: 'monospace',
                  fontWeight: 700,
                  padding: '3px 7px',
                  borderRadius: 4,
                  pointerEvents: 'none',
                  zIndex: 10,
                  whiteSpace: 'nowrap',
                  border: '1px solid rgba(0,255,0,0.3)',
                }}>
                  x:{calibCoords.x}% / y:{calibCoords.y}%
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
