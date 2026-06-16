import { motion } from 'framer-motion'
import { QRCodeSVG } from 'qrcode.react'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

const CARD_CSS = `
@keyframes gjOnbShine {
  from { transform: translate(-50%,-50%) rotate(0deg); }
  to   { transform: translate(-50%,-50%) rotate(360deg); }
}
@keyframes gjOnbFloat {
  0%,100% { transform: translateY(0px); }
  50%     { transform: translateY(-4px); }
}
@keyframes gjOnbAura {
  0%,100% { transform: scale(1.00) translate(0px,0px);  opacity: 0.20; }
  33%     { transform: scale(1.04) translate(4px,-3px);  opacity: 0.28; }
  66%     { transform: scale(1.02) translate(-3px,3px);  opacity: 0.22; }
}
`

interface Props {
  name: string
  userId: string
}

export function MemberPassportCard({ name, userId }: Props) {
  const displayName = name || 'ゲスト'
  const shortId = userId.length > 26 ? userId.slice(0, 26) + '…' : userId

  const qrPayload = JSON.stringify({
    type: 'ginjiro-member',
    userId,
    name: displayName,
  })

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      style={{ padding: '0 16px' }}
    >
      <style>{CARD_CSS}</style>

      {/* Float wrapper */}
      <div style={{ animation: 'gjOnbFloat 5s ease-in-out infinite' }}>

        {/* Card */}
        <div style={{
          position: 'relative',
          borderRadius: 22,
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
          border: '1px solid rgba(201,162,74,0.30)',
          boxShadow: [
            '0 24px 68px rgba(0,0,0,0.92)',
            '0 0 0 0.5px rgba(201,162,74,0.06)',
            'inset 0 1px 0 rgba(201,162,74,0.18)',
            'inset 0 -1px 0 rgba(201,162,74,0.04)',
            '0 0 44px rgba(100,5,25,0.22)',
          ].join(', '),
          overflow: 'hidden',
          padding: '20px 18px 16px',
        }}>

          {/* Layer 0: crimson aura */}
          <div aria-hidden style={{
            position: 'absolute', top: '20%', left: '10%', width: '80%', height: '65%',
            background: 'radial-gradient(ellipse at 50% 50%, rgba(130,8,34,0.40) 0%, rgba(85,5,20,0.16) 45%, transparent 70%)',
            animation: 'gjOnbAura 9s ease-in-out infinite',
            pointerEvents: 'none', zIndex: 0,
          }} />

          {/* Layer 1: conic shine sweep */}
          <div aria-hidden style={{
            position: 'absolute', top: '50%', left: '50%',
            width: '260%', height: '260%',
            background: [
              'conic-gradient(',
              '  from 0deg at 50% 50%,',
              '  transparent 0deg,',
              '  transparent 156deg,',
              '  rgba(255,246,206,0.012) 170deg,',
              '  rgba(255,250,218,0.062) 180deg,',
              '  rgba(201,162,74,0.018) 190deg,',
              '  transparent 204deg,',
              '  transparent 360deg',
              ')',
            ].join(''),
            animation: 'gjOnbShine 4s linear infinite',
            pointerEvents: 'none', zIndex: 1,
          }} />

          {/* Layer 2: glass gloss */}
          <div aria-hidden style={{
            position: 'absolute', inset: 0,
            background: [
              'linear-gradient(136deg,',
              '  transparent 35%,',
              '  rgba(255,255,255,0.014) 43%,',
              '  rgba(255,255,255,0.050) 50%,',
              '  rgba(255,255,255,0.014) 57%,',
              '  transparent 65%)',
            ].join(''),
            pointerEvents: 'none', zIndex: 2,
          }} />

          {/* Layer 3: top gold accent line */}
          <div aria-hidden style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 2,
            background: 'linear-gradient(90deg, transparent 0%, rgba(201,162,74,0.44) 15%, rgba(255,240,195,0.92) 50%, rgba(201,162,74,0.44) 85%, transparent 100%)',
            zIndex: 3,
          }} />

          {/* Content */}
          <div style={{ position: 'relative', zIndex: 4 }}>

            {/* Header label */}
            <p style={{
              fontSize: 11, fontWeight: 700, letterSpacing: '0.20em',
              color: 'rgba(230,210,140,0.78)', fontFamily: 'monospace', marginBottom: 16,
            }}>
              GINJIRO OFFICIAL MEMBER CARD
            </p>

            {/* Main row */}
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>

              {/* Left: name / ID / last visit */}
              <div style={{ flex: 1, minWidth: 0 }}>

                {/* Member name */}
                <p style={{
                  fontFamily: SERIF,
                  fontSize: 'clamp(22px, 6.5vw, 30px)',
                  fontWeight: 700,
                  color: '#F2E6C8',
                  lineHeight: 1.15,
                  letterSpacing: '0.06em',
                  textShadow: '0 2px 18px rgba(0,0,0,0.80), 0 0 30px rgba(201,162,74,0.06)',
                  marginBottom: 6,
                }}>
                  {displayName}
                  <span style={{
                    fontSize: 'clamp(15px, 4.2vw, 20px)',
                    fontWeight: 400,
                    color: 'rgba(242,230,200,0.50)',
                    marginLeft: '0.24em',
                  }}>様</span>
                </p>

                {/* Member ID */}
                <p style={{
                  fontFamily: 'monospace',
                  fontSize: 'clamp(10px, 2.2vw, 12px)',
                  color: 'rgba(230,202,101,0.65)',
                  letterSpacing: '0.04em',
                  lineHeight: 1.4,
                  wordBreak: 'break-all',
                  marginBottom: 12,
                }}>
                  {shortId}
                </p>

                {/* Divider */}
                <div style={{
                  height: 1,
                  background: 'linear-gradient(90deg, rgba(201,162,74,0.28) 0%, rgba(201,162,74,0.06) 75%, transparent 100%)',
                  marginBottom: 10,
                }} />

                {/* Last visit — always --- on initial issue */}
                <div>
                  <p style={{
                    fontSize: 10, letterSpacing: '0.18em',
                    color: 'rgba(201,162,74,0.75)', fontFamily: 'monospace', marginBottom: 4,
                  }}>
                    最終来店日
                  </p>
                  <p style={{
                    fontFamily: SERIF,
                    fontSize: 'clamp(14px, 3.8vw, 18px)',
                    fontWeight: 600,
                    color: 'rgba(242,230,200,0.22)',
                    letterSpacing: '0.08em',
                    lineHeight: 1,
                  }}>
                    ———
                  </p>
                </div>
              </div>

              {/* Right: QR code — blue neon */}
              <div style={{ flexShrink: 0 }}>
                <div style={{
                  padding: 6,
                  background: '#FFFFFF',
                  borderRadius: 10,
                  border: '1.5px solid rgba(0,210,255,0.82)',
                  boxShadow: [
                    '0 0 10px rgba(0,210,255,0.46)',
                    '0 0 28px rgba(0,210,255,0.16)',
                    'inset 0 0 10px rgba(0,210,255,0.06)',
                  ].join(', '),
                }}>
                  <QRCodeSVG
                    value={qrPayload}
                    size={88}
                    level="M"
                    marginSize={1}
                    fgColor="#000000"
                    bgColor="#FFFFFF"
                    style={{ display: 'block', borderRadius: 3 }}
                  />
                </div>
              </div>
            </div>

            {/* Bottom divider */}
            <div style={{
              height: 1,
              background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.20) 25%, rgba(201,162,74,0.20) 75%, transparent)',
              marginTop: 18, marginBottom: 10,
            }} />

            {/* Tagline */}
            <p style={{
              textAlign: 'center', fontSize: 13, letterSpacing: '0.26em',
              color: 'rgba(230,202,101,0.72)', fontFamily: SERIF,
            }}>
              男前を、維持する。
            </p>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
