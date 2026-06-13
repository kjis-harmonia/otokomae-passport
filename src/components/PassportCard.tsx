import { useState, useEffect } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { supabase } from '../lib/supabase'
import { getUserId, getMemberIssuedAt } from '../utils/userId'
import { loadMemberStatus } from '../utils/storage'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

const SHINE_KEYFRAMES = `
@keyframes gjPassportShine {
  from { transform: translate(-50%, -50%) rotate(0deg); }
  to   { transform: translate(-50%, -50%) rotate(360deg); }
}
`

type RankEn = 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM'

const RANK_MAP: Record<string, RankEn> = {
  ブロンズ: 'BRONZE',
  シルバー: 'SILVER',
  ゴールド: 'GOLD',
  プラチナ: 'PLATINUM',
}

interface RankStyle {
  color: string
  bg: string
  border: string
  shadow: string
  gradient?: string
}

const RANK_STYLE: Record<RankEn, RankStyle> = {
  BRONZE: {
    color:  '#CD8A3A',
    bg:     'rgba(205,138,58,0.13)',
    border: 'rgba(205,138,58,0.42)',
    shadow: '0 0 10px rgba(205,138,58,0.22)',
  },
  SILVER: {
    color:  '#B8B8C8',
    bg:     'rgba(184,184,200,0.11)',
    border: 'rgba(184,184,200,0.38)',
    shadow: '0 0 10px rgba(184,184,200,0.18)',
  },
  GOLD: {
    color:  '#C9A24A',
    bg:     'rgba(201,162,74,0.14)',
    border: 'rgba(201,162,74,0.48)',
    shadow: '0 0 14px rgba(201,162,74,0.28)',
  },
  PLATINUM: {
    color:   '#C8DEF4',
    bg:      'rgba(180,210,244,0.12)',
    border:  'rgba(180,210,244,0.44)',
    shadow:  '0 0 18px rgba(160,200,255,0.30)',
    gradient: 'linear-gradient(90deg, #90B8D8, #D4ECFF, #A8CCEE)',
  },
}

function nextVisitStr(lastVisitDate: string): string {
  const d = new Date(lastVisitDate + 'T00:00:00')
  d.setDate(d.getDate() + 14)
  return d.toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' })
}

export function PassportCard() {
  const memberStatus = loadMemberStatus()
  const userId       = getUserId()
  const issuedAt     = getMemberIssuedAt()

  const [lastVisitDate, setLastVisitDate] = useState<string | null>(null)

  useEffect(() => {
    supabase
      .from('maintenance_visits')
      .select('last_visit_date')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.last_visit_date) setLastVisitDate(data.last_visit_date as string)
      })
  }, [userId])

  const rank    = RANK_MAP[memberStatus.rank] ?? 'BRONZE'
  const rs      = RANK_STYLE[rank]
  const isPlatinum = rank === 'PLATINUM'

  const qrPayload = JSON.stringify({
    type: 'ginjiro-member',
    userId,
    name: memberStatus.memberName,
    issuedAt,
  })

  const shortId = userId.length > 30 ? userId.slice(0, 30) + '…' : userId

  const lastVisitFmt = lastVisitDate
    ? new Date(lastVisitDate + 'T00:00:00').toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' })
    : '—'
  const nextFmt = lastVisitDate ? nextVisitStr(lastVisitDate) : '—'

  return (
    <div style={{ padding: '0 14px' }}>
      <style>{SHINE_KEYFRAMES}</style>

      <div
        style={{
          position: 'relative',
          borderRadius: 28,
          background: [
            'linear-gradient(155deg,',
            '  #0B0203 0%,',
            '  #14030A 22%,',
            '  #1E060C 42%,',
            '  #180408 62%,',
            '  #0E0304 82%,',
            '  #0B0203 100%)',
          ].join(''),
          border: '1px solid rgba(201,162,74,0.26)',
          boxShadow: [
            '0 32px 80px rgba(0,0,0,0.88)',
            '0 0 0 0.5px rgba(201,162,74,0.07)',
            'inset 0 1px 0 rgba(201,162,74,0.14)',
            'inset 0 -1px 0 rgba(201,162,74,0.05)',
          ].join(', '),
          overflow: 'hidden',
          padding: '20px 20px 16px',
        }}
      >
        {/* Deep crimson ambient glow */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: '30%', left: '20%',
            width: '70%', height: '50%',
            background: 'radial-gradient(ellipse at center, rgba(110,8,28,0.32) 0%, transparent 68%)',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />

        {/* Shine sweep */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: '50%', left: '50%',
            width: '260%', height: '260%',
            background: [
              'conic-gradient(',
              '  from 0deg at 50% 50%,',
              '  transparent 0deg,',
              '  transparent 158deg,',
              '  rgba(255,246,206,0.020) 171deg,',
              '  rgba(255,250,218,0.060) 180deg,',
              '  rgba(201,162,74,0.028) 189deg,',
              '  transparent 202deg,',
              '  transparent 360deg',
              ')',
            ].join(''),
            animation: 'gjPassportShine 13s linear infinite',
            pointerEvents: 'none',
            zIndex: 1,
          }}
        />

        {/* Top gold line */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0,
            height: 2,
            background: 'linear-gradient(90deg, transparent 0%, rgba(201,162,74,0.55) 18%, rgba(255,240,195,0.88) 50%, rgba(201,162,74,0.55) 82%, transparent 100%)',
            zIndex: 2,
          }}
        />

        {/* Content */}
        <div style={{ position: 'relative', zIndex: 3 }}>

          {/* ── Row 1: rank/label ↔ QR ── */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 18 }}>

            {/* Left: rank badge + sub labels */}
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* Rank badge */}
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 11px',
                  borderRadius: 99,
                  background: rs.bg,
                  border: `1px solid ${rs.border}`,
                  boxShadow: rs.shadow,
                  marginBottom: 10,
                }}
              >
                <span
                  style={{
                    width: 5, height: 5, borderRadius: '50%',
                    background: rs.color,
                    boxShadow: `0 0 5px ${rs.color}`,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 800,
                    letterSpacing: '0.24em',
                    fontFamily: 'monospace',
                    ...(isPlatinum && rs.gradient
                      ? {
                          background: rs.gradient,
                          WebkitBackgroundClip: 'text' as const,
                          WebkitTextFillColor: 'transparent' as const,
                        }
                      : { color: rs.color }),
                  }}
                >
                  {rank}
                </span>
              </span>

              <p style={{ fontSize: 7, letterSpacing: '0.30em', color: 'rgba(201,162,74,0.48)', marginBottom: 3 }}>
                GINJIRO OFFICIAL MEMBER
              </p>
              <p style={{ fontSize: 7, letterSpacing: '0.18em', color: 'rgba(242,230,200,0.18)', fontFamily: 'monospace' }}>
                OTOKOMAE PASSPORT
              </p>
            </div>

            {/* Right: QR */}
            <div style={{ flexShrink: 0 }}>
              <div
                style={{
                  padding: 7,
                  background: '#000',
                  borderRadius: 10,
                  border: '1.5px solid rgba(0,210,255,0.72)',
                  boxShadow: [
                    '0 0 8px rgba(0,210,255,0.38)',
                    '0 0 22px rgba(0,210,255,0.14)',
                    'inset 0 0 8px rgba(0,210,255,0.06)',
                  ].join(', '),
                }}
              >
                <QRCodeSVG
                  value={qrPayload}
                  size={90}
                  level="M"
                  marginSize={0}
                  fgColor="#FFFFFF"
                  bgColor="#000000"
                  style={{ display: 'block' }}
                />
              </div>
            </div>
          </div>

          {/* ── Divider ── */}
          <div style={{ height: '0.5px', background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.32) 20%, rgba(201,162,74,0.32) 80%, transparent)', marginBottom: 18 }} />

          {/* ── Member name ── */}
          <p
            style={{
              fontFamily: SERIF,
              fontSize: 'clamp(22px, 6.2vw, 30px)',
              fontWeight: 700,
              color: '#F2E6C8',
              textAlign: 'center',
              letterSpacing: '0.08em',
              lineHeight: 1.2,
              textShadow: '0 2px 20px rgba(0,0,0,0.7)',
              marginBottom: 10,
            }}
          >
            {memberStatus.memberName}
            <span
              style={{
                fontSize: 'clamp(15px, 4.2vw, 20px)',
                fontWeight: 400,
                color: 'rgba(242,230,200,0.52)',
                marginLeft: '0.3em',
              }}
            >
              様
            </span>
          </p>

          {/* ── Member ID ── */}
          <p
            style={{
              fontFamily: 'monospace',
              fontSize: 'clamp(9px, 2.4vw, 12px)',
              color: 'rgba(242,230,200,0.32)',
              textAlign: 'center',
              letterSpacing: '0.04em',
              wordBreak: 'break-all',
              lineHeight: 1.5,
              marginBottom: 16,
              padding: '0 6px',
            }}
          >
            {shortId}
          </p>

          {/* ── Divider ── */}
          <div style={{ height: '0.5px', background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.22) 20%, rgba(201,162,74,0.22) 80%, transparent)', marginBottom: 16 }} />

          {/* ── Stats grid ── */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 2,
              paddingBottom: 16,
            }}
          >
            {/* 来店回数 */}
            <div style={{ textAlign: 'center', padding: '0 2px' }}>
              <p style={{ fontSize: 7, letterSpacing: '0.10em', color: 'rgba(201,162,74,0.46)', marginBottom: 5 }}>来店</p>
              <p style={{ fontFamily: SERIF, fontSize: 'clamp(15px, 4.2vw, 20px)', fontWeight: 700, color: '#F2E6C8', lineHeight: 1 }}>
                {memberStatus.visitCount}
                <span style={{ fontSize: 9, fontWeight: 400, color: 'rgba(242,230,200,0.5)', marginLeft: 2 }}>回</span>
              </p>
            </div>

            {/* 累計ポイント */}
            <div style={{ textAlign: 'center', padding: '0 2px' }}>
              <p style={{ fontSize: 7, letterSpacing: '0.10em', color: 'rgba(201,162,74,0.46)', marginBottom: 5 }}>累計P</p>
              <p style={{ fontFamily: SERIF, fontSize: 'clamp(15px, 4.2vw, 20px)', fontWeight: 700, color: '#C9A24A', lineHeight: 1 }}>
                {memberStatus.points.toLocaleString()}
              </p>
            </div>

            {/* 最終施術 */}
            <div style={{ textAlign: 'center', padding: '0 2px' }}>
              <p style={{ fontSize: 7, letterSpacing: '0.10em', color: 'rgba(201,162,74,0.46)', marginBottom: 5 }}>最終施術</p>
              <p style={{ fontFamily: SERIF, fontSize: 'clamp(12px, 3.2vw, 15px)', fontWeight: 600, color: lastVisitDate ? '#F2E6C8' : 'rgba(242,230,200,0.28)', lineHeight: 1.2 }}>
                {lastVisitFmt}
              </p>
            </div>

            {/* 次回推奨 */}
            <div style={{ textAlign: 'center', padding: '0 2px' }}>
              <p style={{ fontSize: 7, letterSpacing: '0.10em', color: 'rgba(201,162,74,0.46)', marginBottom: 5 }}>次回推奨</p>
              <p style={{ fontFamily: SERIF, fontSize: 'clamp(12px, 3.2vw, 15px)', fontWeight: 600, color: lastVisitDate ? '#C9A24A' : 'rgba(242,230,200,0.28)', lineHeight: 1.2 }}>
                {nextFmt}
              </p>
            </div>
          </div>

          {/* ── Bottom divider ── */}
          <div style={{ height: '0.5px', background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.18) 20%, rgba(201,162,74,0.18) 80%, transparent)', marginBottom: 12 }} />

          {/* ── Tagline ── */}
          <p
            style={{
              textAlign: 'center',
              fontSize: 9,
              letterSpacing: '0.30em',
              color: 'rgba(201,162,74,0.42)',
              fontFamily: SERIF,
            }}
          >
            男前を、維持する。
          </p>
        </div>
      </div>
    </div>
  )
}
