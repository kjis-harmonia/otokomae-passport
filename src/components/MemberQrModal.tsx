import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { supabase } from '../lib/supabase'
import passportTemplate from '../assets/passport/otokomae-passport-template.png'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

interface Props {
  userId: string
  name: string
  issuedAt: string
  onClose: () => void
}

export function MemberQrModal({ userId, name, issuedAt, onClose }: Props) {
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

  const qrPayload = JSON.stringify({
    type:     'ginjiro-member',
    userId,
    name,
    issuedAt,
  })

  const issuedDateFmt = issuedAt
    ? new Date(issuedAt).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })
    : '—'

  const lastVisitFmt = lastVisitDate
    ? new Date(lastVisitDate + 'T00:00:00').toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })
    : '—'

  const shortId = userId.length > 22 ? userId.slice(0, 22) + '…' : userId

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
          background: 'rgba(5,3,2,0.85)',
          border: '1px solid rgba(201,162,74,0.32)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#F2E6C8', cursor: 'pointer',
          boxShadow: '0 2px 12px rgba(0,0,0,0.6)',
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
          paddingTop: 'max(56px, calc(env(safe-area-inset-top, 0px) + 48px))',
          paddingBottom: 'max(36px, env(safe-area-inset-bottom, 36px))',
          paddingLeft: 20,
          paddingRight: 20,
          overflowY: 'auto',
          boxSizing: 'border-box',
        }}
      >
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, duration: 0.36, ease: 'easeOut' }}
          style={{
            position: 'relative',
            width: '100%',
            maxWidth: 380,
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 24px 64px rgba(0,0,0,0.8), 0 0 0 1px rgba(201,162,74,0.15)',
          }}
        >
          {/* Template image — full card background */}
          <img
            src={passportTemplate}
            alt="男前証"
            draggable={false}
            style={{ width: '100%', display: 'block', userSelect: 'none' }}
          />

          {/* ── Dynamic overlays ───────────────────────────────────────────── */}

          {/* QR code
              Template QR枠: 画像左列 (x≈3.5-39.5%, y≈47.8-65.5%)
              白背景+8pxパディングで枠内に収める */}
          <div
            style={{
              position: 'absolute',
              top: '48.5%',
              left: '3.5%',
              width: '36%',
              background: '#FFFFFF',
              padding: '8px',
              borderRadius: 4,
              boxSizing: 'border-box',
            }}
          >
            <QRCodeSVG
              value={qrPayload}
              size={200}
              level="M"
              marginSize={0}
              style={{ width: '100%', height: 'auto', display: 'block' }}
            />
          </div>

          {/* 会員名
              下線 y≈55.6% → フォント高(~1.9%) 引いて top=53.5%
              右端の「様」はテンプレ固定なので right=11% で回避 */}
          <div
            style={{
              position: 'absolute',
              top: '53.5%',
              left: '42%',
              right: '11%',
              textAlign: 'right',
            }}
          >
            <p style={{
              fontFamily: SERIF,
              fontSize: 'clamp(11px, 3.2vw, 14px)',
              fontWeight: 700,
              color: '#F2E6C8',
              letterSpacing: '0.05em',
              lineHeight: 1,
            }}>
              {name}
            </p>
          </div>

          {/* 会員ID
              下線 y≈63.4% → フォント高(~1.1%) 引いて top=62.2% */}
          <div
            style={{
              position: 'absolute',
              top: '62%',
              left: '42%',
              right: '4%',
            }}
          >
            <p style={{
              fontFamily: 'monospace',
              fontSize: 'clamp(7px, 1.9vw, 9px)',
              color: 'rgba(242,230,200,0.7)',
              letterSpacing: '0.03em',
              wordBreak: 'break-all',
              lineHeight: 1.3,
            }}>
              {shortId}
            </p>
          </div>

          {/* 入会日
              下線 y≈72.7% → フォント高(~1.6%) 引いて top=71%
              左半分: x=4-46% */}
          <div
            style={{
              position: 'absolute',
              top: '71%',
              left: '4%',
              right: '54%',
              textAlign: 'center',
            }}
          >
            <p style={{
              fontSize: 'clamp(9px, 2.6vw, 11px)',
              color: '#F2E6C8',
              fontFamily: SERIF,
              letterSpacing: '0.04em',
            }}>
              {issuedDateFmt}
            </p>
          </div>

          {/* 最終来店日
              右半分: x=50-96% */}
          <div
            style={{
              position: 'absolute',
              top: '71%',
              left: '50%',
              right: '4%',
              textAlign: 'center',
            }}
          >
            <p style={{
              fontSize: 'clamp(9px, 2.6vw, 11px)',
              color: '#F2E6C8',
              fontFamily: SERIF,
              letterSpacing: '0.04em',
            }}>
              {lastVisitFmt}
            </p>
          </div>
        </motion.div>

        <p style={{
          fontSize: 10, color: 'rgba(201,162,74,0.3)', marginTop: 18,
          letterSpacing: '0.12em', textAlign: 'center', lineHeight: 1.7,
        }}>
          店舗でこのQRをご提示ください
        </p>
      </div>
    </motion.div>
  )
}
