import { useState, useEffect } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { supabase } from '../lib/supabase'
import { getUserId } from '../utils/userId'
import { loadMemberStatus, getStoredValue, ONBOARDING_NAME_KEY } from '../utils/storage'

const MAINTENANCE_LOCAL_KEY = 'ginjiro_maintenance_visits'
const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

const CARD_CSS = `
@keyframes gjPassportShine {
  from { transform: translate(-50%, -50%) rotate(0deg); }
  to   { transform: translate(-50%, -50%) rotate(360deg); }
}
@keyframes gjFloat {
  0%, 100% { transform: translateY(0px); }
  50%       { transform: translateY(-4px); }
}
@keyframes gjAura {
  0%,100% { transform: scale(1.00) translate(0px, 0px); opacity: 0.22; }
  25%      { transform: scale(1.05) translate(5px,-4px);  opacity: 0.30; }
  50%      { transform: scale(1.02) translate(-3px, 3px); opacity: 0.24; }
  75%      { transform: scale(1.04) translate(4px,  2px); opacity: 0.28; }
}
@keyframes gjPassportSlide {
  0%   { background-position: -200% center; }
  100% { background-position:  200% center; }
}
`

function fmtLastVisit(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y} / ${m} / ${day}`
}

export function PassportCard() {
  const memberStatus = loadMemberStatus()
  const userId = getUserId()

  const [lastVisitDate, setLastVisitDate] = useState<string | null>(null)
  const [qrEnlarged, setQrEnlarged] = useState(false)

  useEffect(() => {
    supabase
      .from('maintenance_visits')
      .select('last_visit_date')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!error && data?.last_visit_date) {
          setLastVisitDate(data.last_visit_date as string)
        } else {
          const local = getStoredValue<Record<string, string>>(MAINTENANCE_LOCAL_KEY, {})
          if (local[userId]) setLastVisitDate(local[userId])
        }
      })
  }, [userId])

  // QR には完全 userId を保持。カード表示は先頭 8 文字のみ。
  const memberName  = getStoredValue<string>(ONBOARDING_NAME_KEY, memberStatus.memberName) || 'ゲスト'
  const displayId   = userId.slice(0, 8).toUpperCase()
  const lastVisitFmt = lastVisitDate ? fmtLastVisit(lastVisitDate) : null

  const qrPayload = JSON.stringify({
    type: 'ginjiro-member',
    userId,   // 完全 ID を必ず保持
    name: memberName,
  })

  return (
    <>
    <div style={{ padding: '0 14px' }}>
      <style>{CARD_CSS}</style>

      {/* Floating wrapper */}
      <div style={{ animation: 'gjFloat 5s ease-in-out infinite' }}>

        {/* ── Card shell ── */}
        <div style={{
          position: 'relative',
          borderRadius: 24,
          background: [
            'linear-gradient(158deg,',
            '  #080102 0%,',
            '  #120208 18%,',
            '  #1C060C 36%,',
            '  #240710 50%,',
            '  #1C060C 66%,',
            '  #0E0202 84%,',
            '  #080102 100%)',
          ].join(''),
          border: '1px solid rgba(201,162,74,0.32)',
          boxShadow: [
            '0 28px 72px rgba(0,0,0,0.92)',
            '0 0 0 0.5px rgba(201,162,74,0.08)',
            'inset 0 1px 0 rgba(201,162,74,0.22)',
            'inset 0 -1px 0 rgba(201,162,74,0.05)',
            '0 0 48px rgba(100,5,25,0.22)',
          ].join(', '),
          overflow: 'hidden',
          padding: '22px 20px 18px',
        }}>

          {/* Layer 0 — Crimson breathing aura */}
          <div aria-hidden style={{
            position: 'absolute',
            top: '20%', left: '10%',
            width: '80%', height: '65%',
            background: 'radial-gradient(ellipse at 50% 50%, rgba(130,8,34,0.38) 0%, rgba(85,5,20,0.16) 45%, transparent 70%)',
            animation: 'gjAura 9s ease-in-out infinite',
            pointerEvents: 'none', zIndex: 0,
          }} />

          {/* Layer 1 — Conic rotate (very subtle) */}
          <div aria-hidden style={{
            position: 'absolute',
            top: '50%', left: '50%',
            width: '260%', height: '260%',
            background: [
              'conic-gradient(',
              '  from 0deg at 50% 50%,',
              '  transparent 0deg,',
              '  transparent 160deg,',
              '  rgba(255,246,206,0.008) 170deg,',
              '  rgba(255,250,218,0.038) 180deg,',
              '  rgba(201,162,74,0.012) 190deg,',
              '  transparent 200deg,',
              '  transparent 360deg',
              ')',
            ].join(''),
            animation: 'gjPassportShine 6s linear infinite',
            pointerEvents: 'none', zIndex: 1,
          }} />

          {/* Layer 2 — Diagonal sliding shimmer (10s sweep) */}
          <div aria-hidden style={{
            position: 'absolute', inset: 0,
            background: [
              'linear-gradient(',
              '  110deg,',
              '  transparent  0%,',
              '  transparent 38%,',
              '  rgba(255,255,255,0.03) 44%,',
              '  rgba(255,255,255,0.08) 50%,',
              '  rgba(255,255,255,0.03) 56%,',
              '  transparent 62%,',
              '  transparent 100%)',
            ].join(''),
            backgroundSize: '200% auto',
            animation: 'gjPassportSlide 10s ease-in-out infinite',
            pointerEvents: 'none', zIndex: 2,
          }} />

          {/* Layer 3 — Hairline horizontal texture (metal card grain) */}
          <div aria-hidden style={{
            position: 'absolute', inset: 0,
            backgroundImage: [
              'repeating-linear-gradient(',
              '  0deg,',
              '  transparent,',
              '  transparent 2px,',
              '  rgba(255,255,255,0.016) 2px,',
              '  rgba(255,255,255,0.016) 3px',
              ')',
            ].join(''),
            pointerEvents: 'none', zIndex: 3,
            mixBlendMode: 'overlay',
          }} />

          {/* Layer 4 — Top gold accent line */}
          <div aria-hidden style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, height: 2,
            background: 'linear-gradient(90deg, transparent 0%, rgba(201,162,74,0.44) 15%, rgba(255,240,195,0.96) 50%, rgba(201,162,74,0.44) 85%, transparent 100%)',
            zIndex: 4,
          }} />

          {/* ── Content ── */}
          <div style={{ position: 'relative', zIndex: 5 }}>

            {/* Header */}
            <p style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.18em',
              color: 'rgba(201,162,74,0.52)', fontFamily: 'monospace',
              marginBottom: 16, whiteSpace: 'nowrap', overflow: 'hidden',
            }}>
              GINJIRO OFFICIAL MEMBER CARD
            </p>

            {/* Main row */}
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>

              {/* Left column */}
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>

                {/* ── 会員名 ── */}
                <p style={{
                  fontFamily: SERIF,
                  fontSize: 'clamp(26px, 7.2vw, 34px)',
                  fontWeight: 700,
                  color: '#f5f5f7',
                  lineHeight: 1.15,
                  letterSpacing: '0.06em',
                  // 強めの drop shadow で背景の赤フレアに負けない
                  textShadow: [
                    '0 1px 0 rgba(0,0,0,0.98)',
                    '0 2px 10px rgba(0,0,0,0.92)',
                    '0 0 32px rgba(0,0,0,0.70)',
                  ].join(', '),
                  marginBottom: 6,
                }}>
                  {memberName}
                  {/* 「様」— 会員名の約52%サイズ、シルバー系 */}
                  <span style={{
                    fontSize: 'clamp(14px, 3.6vw, 18px)',
                    fontWeight: 300,
                    color: 'rgba(200,200,212,0.68)',
                    marginLeft: '0.30em',
                    verticalAlign: 'baseline',
                  }}>
                    様
                  </span>
                </p>

                {/* ── 会員ID（シャンパンゴールド、先頭8文字） ── */}
                <p style={{
                  fontFamily: 'monospace',
                  fontSize: 'clamp(9px, 2.3vw, 11px)',
                  color: 'rgba(230,202,101,0.75)',
                  letterSpacing: '0.18em',
                  lineHeight: 1.4,
                  marginBottom: 12,
                  whiteSpace: 'nowrap',
                }}>
                  ID · {displayId}
                </p>

                {/* Divider */}
                <div style={{
                  height: 1,
                  background: 'linear-gradient(90deg, rgba(201,162,74,0.38) 0%, rgba(201,162,74,0.10) 70%, transparent 100%)',
                  marginBottom: 10,
                }} />

                {/* ── 最終来店日 ── */}
                <div>
                  <p style={{
                    fontSize: 9, letterSpacing: '0.24em',
                    color: 'rgba(201,162,74,0.65)',
                    fontFamily: 'monospace', marginBottom: 5,
                  }}>
                    LAST VISIT
                  </p>
                  <p style={{
                    fontFamily: SERIF,
                    fontSize: 'clamp(20px, 5.2vw, 24px)',
                    fontWeight: 700,
                    color: lastVisitDate ? '#f5f5f7' : 'rgba(242,230,200,0.16)',
                    letterSpacing: '0.04em',
                    lineHeight: 1,
                    whiteSpace: 'nowrap',
                    textShadow: lastVisitDate
                      ? '0 1px 0 rgba(0,0,0,0.98), 0 2px 10px rgba(0,0,0,0.88)'
                      : 'none',
                  }}>
                    {lastVisitFmt ?? 'YYYY / MM / DD'}
                  </p>
                </div>
              </div>

              {/* ── QR code — embedded look ── */}
              <div style={{ flexShrink: 0 }}>
                <div
                  onClick={() => setQrEnlarged(true)}
                  style={{
                    padding: 7,
                    background: '#FFFFFF',
                    borderRadius: 12,
                    // 埋め込み感：外側 drop shadow + 内側 inset
                    border: '1px solid rgba(201,162,74,0.42)',
                    boxShadow: [
                      '0 6px 20px rgba(0,0,0,0.68)',
                      '0 2px 6px rgba(0,0,0,0.55)',
                      'inset 0 2px 4px rgba(0,0,0,0.28)',
                      'inset 0 -1px 2px rgba(255,255,255,0.10)',
                      '0 0 0 0.5px rgba(201,162,74,0.22)',
                    ].join(', '),
                    cursor: 'pointer',
                    position: 'relative',
                  }}
                >
                  <QRCodeSVG
                    value={qrPayload}
                    size={96}
                    level="M"
                    marginSize={1}
                    fgColor="#000000"
                    bgColor="#FFFFFF"
                    style={{ display: 'block', borderRadius: 4 }}
                  />
                  <div style={{
                    position: 'absolute', bottom: 2, right: 3,
                    fontSize: 7, color: 'rgba(201,162,74,0.55)',
                    letterSpacing: '0.04em', lineHeight: 1,
                    pointerEvents: 'none',
                  }}>
                    ⊕
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom divider */}
            <div style={{
              height: 1,
              background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.24) 25%, rgba(201,162,74,0.24) 75%, transparent)',
              marginTop: 18, marginBottom: 10,
            }} />

            {/* Tagline */}
            <p style={{
              textAlign: 'center',
              fontSize: 13,
              letterSpacing: '0.28em',
              color: 'rgba(201,162,74,0.54)',
              fontFamily: SERIF,
              textShadow: '0 1px 8px rgba(0,0,0,0.65)',
            }}>
              男前を、維持する。
            </p>
          </div>
        </div>
      </div>
    </div>

    {/* ── QR 拡大モーダル ── */}
    {qrEnlarged && (
      <div
        onClick={() => setQrEnlarged(false)}
        style={{
          position: 'fixed', inset: 0, zIndex: 500,
          background: 'rgba(0,0,0,0.95)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: '32px',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <p style={{
          fontSize: 8, letterSpacing: '0.30em',
          color: 'rgba(201,162,74,0.52)',
          marginBottom: 20, fontFamily: 'monospace',
        }}>
          GINJIRO MEMBER QR — TAP TO CLOSE
        </p>

        <div style={{
          padding: 12,
          background: '#FFFFFF',
          borderRadius: 18,
          border: '1.5px solid rgba(201,162,74,0.58)',
          boxShadow: [
            '0 16px 48px rgba(0,0,0,0.85)',
            '0 4px 12px rgba(0,0,0,0.65)',
            'inset 0 2px 4px rgba(0,0,0,0.18)',
            '0 0 0 0.5px rgba(201,162,74,0.28)',
          ].join(', '),
        }}>
          <QRCodeSVG
            value={qrPayload}
            size={240}
            level="M"
            marginSize={2}
            fgColor="#000000"
            bgColor="#FFFFFF"
            style={{ display: 'block' }}
          />
        </div>

        <div style={{ marginTop: 24, textAlign: 'center' }}>
          <p style={{
            fontFamily: SERIF, fontSize: 15, fontWeight: 700,
            color: '#f5f5f7',
            letterSpacing: '0.12em', marginBottom: 8,
            textShadow: '0 2px 8px rgba(0,0,0,0.80)',
          }}>
            {memberName}
            <span style={{ fontSize: 11, fontWeight: 300, color: 'rgba(200,200,212,0.65)', marginLeft: '0.28em' }}>様</span>
          </p>
          <p style={{
            fontSize: 9, color: 'rgba(230,202,101,0.60)',
            letterSpacing: '0.14em', fontFamily: 'monospace',
          }}>
            ID · {userId.slice(0, 24)}
          </p>
        </div>

        <p style={{
          marginTop: 28, fontSize: 11,
          color: 'rgba(242,230,200,0.28)',
          letterSpacing: '0.14em',
        }}>
          タップして閉じる
        </p>
      </div>
    )}
    </>
  )
}
