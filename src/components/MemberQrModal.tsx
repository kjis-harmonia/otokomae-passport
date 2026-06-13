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

          {/* ── Dynamic overlays (same coordinates as inline card) ── */}

          {/* QR — center(30.5%, 53%), 27% wide */}
          <div style={{
            position: 'absolute',
            top: '45.5%',
            left: '17%',
            width: '27%',
            background: '#FFFFFF',
            padding: '5px',
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

          {/* 会員名 + 様 — center(70%, 55%) */}
          <div style={{
            position: 'absolute',
            top: '55%',
            left: '41%',
            right: '3%',
            transform: 'translateY(-50%)',
            textAlign: 'center',
          }}>
            <p style={{ fontFamily: SERIF, fontSize: '4.5vw', fontWeight: 700, color: '#F2E6C8', letterSpacing: '0.05em', lineHeight: 1.15 }}>
              {name}<span style={{ fontSize: '3vw', fontWeight: 400, color: 'rgba(242,230,200,0.5)', marginLeft: '0.25em' }}>様</span>
            </p>
          </div>

          {/* 会員ID — center(70%, 61%) */}
          <div style={{
            position: 'absolute',
            top: '61%',
            left: '41%',
            right: '3%',
            transform: 'translateY(-50%)',
            textAlign: 'center',
          }}>
            <p style={{ fontFamily: 'monospace', fontSize: '1.6vw', color: 'rgba(242,230,200,0.5)', letterSpacing: '0.03em', wordBreak: 'break-all', lineHeight: 1.4 }}>
              {shortId}
            </p>
          </div>

          {/* 入会日 — center(26.9%, 72.3%) */}
          <div style={{
            position: 'absolute',
            top: '72.3%',
            left: '3%',
            right: '50%',
            transform: 'translateY(-50%)',
            textAlign: 'center',
          }}>
            <p style={{ fontSize: '2.4vw', color: '#F2E6C8', fontFamily: SERIF, letterSpacing: '0.04em' }}>
              {issuedDateFmt}
            </p>
          </div>

          {/* 最終来店日 — center(72.8%, 72.3%) */}
          <div style={{
            position: 'absolute',
            top: '72.3%',
            left: '50%',
            right: '3%',
            transform: 'translateY(-50%)',
            textAlign: 'center',
          }}>
            <p style={{ fontSize: '2.4vw', color: '#F2E6C8', fontFamily: SERIF, letterSpacing: '0.04em' }}>
              {lastVisitFmt}
            </p>
          </div>

          {/* 下段非表示 (来店回数 · 施術メニュー · 次回推奨日 を隠蔽) */}
          <div style={{
            position: 'absolute',
            top: '74%',
            left: 0, right: 0, bottom: 0,
            background: 'linear-gradient(to bottom, transparent 0%, #0A0907 14%)',
            pointerEvents: 'none',
            zIndex: 2,
          }} />
        </motion.div>

        <p style={{
          fontSize: 10, color: 'rgba(201,162,74,0.3)', marginTop: 18,
          letterSpacing: '0.12em', textAlign: 'center', lineHeight: 1.7,
        }}>
          会計時にスタッフへ提示してください
        </p>
      </div>
    </motion.div>
  )
}
