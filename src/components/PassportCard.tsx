import { useState, useEffect } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { supabase } from '../lib/supabase'
import { getUserId } from '../utils/userId'
import { loadMemberStatus, getStoredValue, ONBOARDING_NAME_KEY } from '../utils/storage'

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
  50%      { transform: scale(1.02) translate(-3px,3px);  opacity: 0.24; }
  75%      { transform: scale(1.04) translate(4px, 2px);  opacity: 0.28; }
}
`

function fmtLastVisit(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}.${m}.${day}`
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
      .then(({ data }) => {
        if (data?.last_visit_date) setLastVisitDate(data.last_visit_date as string)
      })
  }, [userId])

  const memberName = getStoredValue<string>(ONBOARDING_NAME_KEY, memberStatus.memberName) || 'ゲスト'

  const qrPayload = JSON.stringify({
    type: 'ginjiro-member',
    userId,
    name: memberName,
  })

  const shortId = userId.length > 26 ? userId.slice(0, 26) + '…' : userId
  const lastVisitFmt = lastVisitDate ? fmtLastVisit(lastVisitDate) : null

  return (
    <>
    <div style={{ padding: '0 14px' }}>
      <style>{CARD_CSS}</style>

      {/* Floating wrapper */}
      <div style={{ animation: 'gjFloat 5s ease-in-out infinite' }}>

        {/* Card */}
        <div
          style={{
            position: 'relative',
            borderRadius: 24,
            background: [
              'linear-gradient(158deg,',
              '  #090102 0%,',
              '  #130308 18%,',
              '  #1E060D 36%,',
              '  #260811 50%,',
              '  #1E060D 66%,',
              '  #100203 84%,',
              '  #090102 100%)',
            ].join(''),
            border: '1px solid rgba(201,162,74,0.28)',
            boxShadow: [
              '0 28px 72px rgba(0,0,0,0.90)',
              '0 0 0 0.5px rgba(201,162,74,0.06)',
              'inset 0 1px 0 rgba(201,162,74,0.18)',
              'inset 0 -1px 0 rgba(201,162,74,0.04)',
              '0 0 44px rgba(100,5,25,0.20)',
            ].join(', '),
            overflow: 'hidden',
            padding: '22px 20px 18px',
          }}
        >
          {/* Layer 0: heat haze / aura — slow-pulsing crimson glow */}
          <div
            aria-hidden
            style={{
              position: 'absolute',
              top: '20%', left: '10%',
              width: '80%', height: '65%',
              background: 'radial-gradient(ellipse at 50% 50%, rgba(130,8,34,0.40) 0%, rgba(85,5,20,0.18) 45%, transparent 70%)',
              animation: 'gjAura 9s ease-in-out infinite',
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />

          {/* Layer 1: conic-gradient shine sweep (3-5s cycle) */}
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
                '  transparent 156deg,',
                '  rgba(255,246,206,0.014) 170deg,',
                '  rgba(255,250,218,0.068) 180deg,',
                '  rgba(201,162,74,0.022) 190deg,',
                '  transparent 204deg,',
                '  transparent 360deg',
                ')',
              ].join(''),
              animation: 'gjPassportShine 4s linear infinite',
              pointerEvents: 'none',
              zIndex: 1,
            }}
          />

          {/* Layer 2: glass reflection — static diagonal gloss stripe */}
          <div
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              background: [
                'linear-gradient(',
                '  136deg,',
                '  transparent 0%,',
                '  transparent 35%,',
                '  rgba(255,255,255,0.016) 43%,',
                '  rgba(255,255,255,0.052) 50%,',
                '  rgba(255,255,255,0.016) 57%,',
                '  transparent 65%,',
                '  transparent 100%',
                ')',
              ].join(''),
              pointerEvents: 'none',
              zIndex: 2,
            }}
          />

          {/* Layer 3: top gold accent line */}
          <div
            aria-hidden
            style={{
              position: 'absolute',
              top: 0, left: 0, right: 0,
              height: 2,
              background: 'linear-gradient(90deg, transparent 0%, rgba(201,162,74,0.44) 15%, rgba(255,240,195,0.92) 50%, rgba(201,162,74,0.44) 85%, transparent 100%)',
              zIndex: 3,
            }}
          />

          {/* Content */}
          <div style={{ position: 'relative', zIndex: 4 }}>

            {/* Header label */}
            <p style={{
              fontSize: 8,
              fontWeight: 700,
              letterSpacing: '0.30em',
              color: 'rgba(201,162,74,0.50)',
              fontFamily: 'monospace',
              marginBottom: 18,
            }}>
              GINJIRO OFFICIAL MEMBER CARD
            </p>

            {/* Main row */}
            <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>

              {/* Left: name / ID / last visit */}
              <div style={{ flex: 1, minWidth: 0 }}>

                {/* Member name */}
                <p style={{
                  fontFamily: SERIF,
                  fontSize: 'clamp(26px, 7.2vw, 34px)',
                  fontWeight: 700,
                  color: '#F2E6C8',
                  lineHeight: 1.15,
                  letterSpacing: '0.06em',
                  textShadow: '0 2px 18px rgba(0,0,0,0.80), 0 0 32px rgba(201,162,74,0.07)',
                  marginBottom: 8,
                }}>
                  {memberStatus.memberName}
                  <span style={{
                    fontSize: 'clamp(17px, 4.6vw, 22px)',
                    fontWeight: 400,
                    color: 'rgba(242,230,200,0.52)',
                    marginLeft: '0.28em',
                  }}>
                    様
                  </span>
                </p>

                {/* Member ID */}
                <p style={{
                  fontFamily: 'monospace',
                  fontSize: 'clamp(8px, 2.1vw, 10px)',
                  color: 'rgba(242,230,200,0.26)',
                  letterSpacing: '0.04em',
                  lineHeight: 1.4,
                  wordBreak: 'break-all',
                  marginBottom: 14,
                }}>
                  {shortId}
                </p>

                {/* Divider */}
                <div style={{
                  height: 1,
                  background: 'linear-gradient(90deg, rgba(201,162,74,0.30) 0%, rgba(201,162,74,0.08) 75%, transparent 100%)',
                  marginBottom: 12,
                }} />

                {/* Last visit date */}
                <div>
                  <p style={{
                    fontSize: 8,
                    letterSpacing: '0.20em',
                    color: 'rgba(201,162,74,0.48)',
                    fontFamily: 'monospace',
                    marginBottom: 5,
                  }}>
                    最終来店日
                  </p>
                  <p style={{
                    fontFamily: SERIF,
                    fontSize: 'clamp(15px, 4.2vw, 20px)',
                    fontWeight: 600,
                    color: lastVisitDate ? '#F2E6C8' : 'rgba(242,230,200,0.22)',
                    letterSpacing: '0.05em',
                    lineHeight: 1,
                  }}>
                    {lastVisitFmt ?? '——.——.——'}
                  </p>
                </div>
              </div>

              {/* Right: QR code (tap to enlarge) */}
              <div style={{ flexShrink: 0 }}>
                <div
                  onClick={() => setQrEnlarged(true)}
                  style={{
                    padding: 6,
                    background: '#FFFFFF',
                    borderRadius: 12,
                    border: '1.5px solid rgba(0,210,255,0.82)',
                    boxShadow: [
                      '0 0 10px rgba(0,210,255,0.46)',
                      '0 0 30px rgba(0,210,255,0.16)',
                      'inset 0 0 10px rgba(0,210,255,0.06)',
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
                  {/* Tap hint */}
                  <div style={{
                    position: 'absolute', bottom: 2, right: 3,
                    fontSize: 7, color: 'rgba(0,210,255,0.55)',
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
              background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.22) 25%, rgba(201,162,74,0.22) 75%, transparent)',
              marginTop: 20,
              marginBottom: 12,
            }} />

            {/* Tagline */}
            <p style={{
              textAlign: 'center',
              fontSize: 9,
              letterSpacing: '0.32em',
              color: 'rgba(201,162,74,0.42)',
              fontFamily: SERIF,
            }}>
              男前を、維持する。
            </p>
          </div>
        </div>
      </div>
    </div>

    {/* QR Enlarged Modal */}
    {qrEnlarged && (
      <div
        onClick={() => setQrEnlarged(false)}
        style={{
          position: 'fixed', inset: 0, zIndex: 500,
          background: 'rgba(0,0,0,0.94)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: '32px',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <p style={{
          fontSize: 8, letterSpacing: '0.30em',
          color: 'rgba(0,210,255,0.45)',
          marginBottom: 20, fontFamily: 'monospace',
        }}>
          GINJIRO MEMBER QR — TAP TO CLOSE
        </p>

        <div style={{
          padding: 12,
          background: '#FFFFFF',
          borderRadius: 18,
          border: '2px solid rgba(0,210,255,0.88)',
          boxShadow: [
            '0 0 20px rgba(0,210,255,0.55)',
            '0 0 60px rgba(0,210,255,0.20)',
            'inset 0 0 20px rgba(0,210,255,0.08)',
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
            fontFamily: SERIF, fontSize: 14, fontWeight: 700,
            color: 'rgba(242,230,200,0.7)',
            letterSpacing: '0.12em', marginBottom: 6,
          }}>
            {memberName}
          </p>
          <p style={{
            fontSize: 9, color: 'rgba(242,230,200,0.3)',
            letterSpacing: '0.08em', fontFamily: 'monospace',
          }}>
            {userId.slice(0, 24)}…
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
