import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

interface Props {
  userId: string
  name: string
  issuedAt: string
  onClose: () => void
}

export function MemberQrModal({ userId, name, issuedAt, onClose }: Props) {
  const qrPayload = JSON.stringify({
    type:     'ginjiro-member',
    userId,
    name,
    issuedAt,
  })

  const issuedDate = issuedAt
    ? new Date(issuedAt).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })
    : ''

  return (
    <motion.div
      className="fixed inset-0"
      style={{ zIndex: 200, background: 'rgba(4,2,1,0.97)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22 }}
    >
      {/* Close button */}
      <button
        type="button"
        onClick={onClose}
        aria-label="閉じる"
        style={{
          position: 'absolute',
          top: 'max(18px, env(safe-area-inset-top, 18px))',
          right: 18,
          zIndex: 201,
          width: 40, height: 40, borderRadius: '50%',
          background: 'rgba(5,3,2,0.8)',
          border: '1px solid rgba(201,162,74,0.28)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#F2E6C8', cursor: 'pointer',
          boxShadow: '0 2px 12px rgba(0,0,0,0.5)',
        }}
      >
        <X size={18} strokeWidth={2} />
      </button>

      {/* Scrollable content */}
      <div
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100%',
          padding: '80px 28px 48px',
          paddingTop: 'max(80px, calc(env(safe-area-inset-top, 0px) + 64px))',
          paddingBottom: 'max(48px, env(safe-area-inset-bottom, 48px))',
          overflowY: 'auto',
          boxSizing: 'border-box',
        }}
      >
        {/* Title block */}
        <div style={{ textAlign: 'center', marginBottom: 28, width: '100%' }}>
          <div style={{
            height: 1,
            background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.55), transparent)',
            marginBottom: 18,
          }} />
          <p style={{
            fontSize: 9, letterSpacing: '0.32em', color: 'rgba(201,162,74,0.48)',
            marginBottom: 8, textTransform: 'uppercase',
          }}>
            GINJIRO OFFICIAL MEMBERSHIP
          </p>
          <p style={{
            fontFamily: SERIF, fontSize: 32, fontWeight: 700,
            color: '#F2E6C8', letterSpacing: '0.14em', marginBottom: 5,
            textShadow: '0 0 24px rgba(201,162,74,0.18)',
          }}>
            男前証
          </p>
          <p style={{
            fontSize: 12, color: 'rgba(201,162,74,0.58)', letterSpacing: '0.18em',
          }}>
            銀二郎公式会員証
          </p>
          <div style={{
            height: 1,
            background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.55), transparent)',
            marginTop: 18,
          }} />
        </div>

        {/* Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.38, ease: 'easeOut' }}
          style={{
            background: 'linear-gradient(160deg, #150C07 0%, #0A0504 100%)',
            border: '1px solid rgba(201,162,74,0.32)',
            borderRadius: 20,
            padding: '28px 24px 24px',
            width: '100%',
            maxWidth: 340,
            boxShadow:
              '0 24px 64px rgba(0,0,0,0.72), 0 0 0 1px rgba(201,162,74,0.07), inset 0 1px 0 rgba(242,230,200,0.06)',
          }}
        >
          {/* Corner marks */}
          {(['top-3 left-3', 'top-3 right-3', 'bottom-3 left-3', 'bottom-3 right-3'] as const).map(pos => (
            <div
              key={pos}
              style={{
                position: 'absolute',
                ...Object.fromEntries(pos.split(' ').map(p => {
                  const [side, offset] = p.split('-')
                  return [side, `${parseInt(offset) * 4}px`]
                })),
                width: 12, height: 12,
                borderColor: 'rgba(201,162,74,0.3)',
                borderStyle: 'solid',
                borderTopWidth:    pos.includes('top')    ? 1 : 0,
                borderBottomWidth: pos.includes('bottom') ? 1 : 0,
                borderLeftWidth:   pos.includes('left')   ? 1 : 0,
                borderRightWidth:  pos.includes('right')  ? 1 : 0,
              }}
            />
          ))}

          {/* QR code — white background for scanner readability */}
          <div style={{
            background: '#FFFFFF',
            borderRadius: 12,
            padding: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 22,
          }}>
            <QRCodeSVG
              value={qrPayload}
              size={192}
              level="M"
              marginSize={0}
            />
          </div>

          {/* Divider */}
          <div style={{
            height: '0.5px',
            background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.28), transparent)',
            marginBottom: 18,
          }} />

          {/* Name */}
          <p style={{
            fontSize: 8, letterSpacing: '0.26em', color: 'rgba(201,162,74,0.42)',
            marginBottom: 7, textTransform: 'uppercase',
          }}>
            Member Name
          </p>
          <p style={{
            fontFamily: SERIF, fontSize: 24, fontWeight: 700,
            color: '#F2E6C8', letterSpacing: '0.04em', marginBottom: 18,
          }}>
            {name}
          </p>

          {/* ID + issued date row */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <div>
              <p style={{
                fontSize: 8, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.38)',
                marginBottom: 5, textTransform: 'uppercase',
              }}>
                Member ID
              </p>
              <p style={{
                fontFamily: 'monospace', fontSize: 10,
                color: 'rgba(242,230,200,0.38)', letterSpacing: '0.06em',
                wordBreak: 'break-all',
              }}>
                {userId}
              </p>
            </div>
            {issuedDate && (
              <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 12 }}>
                <p style={{ fontSize: 8, letterSpacing: '0.14em', color: 'rgba(201,162,74,0.3)', marginBottom: 3 }}>
                  発行日
                </p>
                <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.3)' }}>{issuedDate}</p>
              </div>
            )}
          </div>
        </motion.div>

        <p style={{
          fontSize: 10, color: 'rgba(201,162,74,0.3)', marginTop: 22,
          letterSpacing: '0.12em', textAlign: 'center', lineHeight: 1.7,
        }}>
          店舗でこのQRをご提示ください
        </p>
      </div>
    </motion.div>
  )
}
