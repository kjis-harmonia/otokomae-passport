import {useStoreAccess,useStoreRequest} from '../features/customerAccess/storeAccess'
import {StoreRequestNotice} from '../features/customerAccess/StoreVerification'
import { useState, useEffect } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { getUserId } from '../utils/userId'
import { loadMemberStatus, getStoredValue, ONBOARDING_NAME_KEY } from '../utils/storage'
import { getCustomerByUserId, fetchLastVisitDateStrict } from '../utils/customerStore'
import type { CustomerRow } from '../utils/customerStore'
import { couponPlanForQr } from '../utils/bookingCoupons'
import { PushToggle } from './PushToggle'
import { formatVisit, useNextReservation } from '../features/johnny/nextReservation'
import { heldFor, useGinpayHolds } from '../features/ginpay/holds'
import { CustomerAccessSettings } from '../features/customerAccess/CustomerAccess'
import { canShowInstallGuide, SHOW_INSTALL_GUIDE_EVENT } from '../utils/installGuide'
import {
  CURRENT_RESERVATION_CHANGED_EVENT,
  loadCurrentReservation,
  toCurrentReservationQrPayload,
} from '../utils/currentReservation'

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
  return `${y}.${m}.${day}`
}

/** compact：V2.0 の会員QR。会員証と来店時の本人確認の案内だけ（お知らせ・ログイン設定・復旧コードは別の画面） */
export function PassportCard({ compact = false }: { compact?: boolean } = {}) {
  const storeAccess=useStoreAccess()
  const storeRequest=useStoreRequest(storeAccess.mode!=='verified'&&storeAccess.mode!=='error')
  const memberStatus = loadMemberStatus()
  const userId = getUserId()

  const [lastVisitDate, setLastVisitDate] = useState<string | null>(null)
  const [qrEnlarged, setQrEnlarged] = useState(false)
  const [customerData, setCustomerData] = useState<CustomerRow | null | undefined>(undefined)
  const [currentReservation, setCurrentReservation] = useState(() => loadCurrentReservation())
  // カードに出す予約は「次回予約」と同じもの（ご予約は1つ）：アプリの予約があればそれ、無ければお電話のクーポン予約（予約日つき）
  const aiNext = useNextReservation()
  // 銀Pay の仮支払い（その予約に付いていれば「仮支払い済み」。レジで会員QR を読むと確定）
  const prepaid = heldFor(useGinpayHolds(), aiNext?.id)
  const shownReservation = aiNext
    ? (() => { const v = formatVisit(aiNext.starts_at); return { title: aiNext.items.map(i => i.name).join('・'), when: `${v.date} ${v.time}〜`, price: aiNext.total_price } })()
    : currentReservation
      ? { title: currentReservation.title, when: `${Number(currentReservation.visitDate.slice(5, 7))}月${Number(currentReservation.visitDate.slice(8, 10))}日・お電話のご予約`, price: currentReservation.memberPrice }
      : null

  useEffect(() => {
    // 最終来店日はサーバー（get_my_last_visit RPC）。通信できない場合のみ端末内の旧データで表示
    fetchLastVisitDateStrict(userId)
      .then(d => setLastVisitDate(d))
      .catch(() => {
        const local = getStoredValue<Record<string, string>>(MAINTENANCE_LOCAL_KEY, {})
        if (local[userId]) setLastVisitDate(local[userId])
      })
  }, [userId])

  useEffect(() => {
    getCustomerByUserId(userId).then(d => setCustomerData(d ?? null))
  }, [userId])

  // JOHNNY の予約で選んだ券が変わったら QR を作り直す
  const [, setCouponTick] = useState(0)
  useEffect(() => {
    const bump = () => setCouponTick(n => n + 1)
    window.addEventListener('ginjiro:coupon-plan-changed', bump)
    return () => window.removeEventListener('ginjiro:coupon-plan-changed', bump)
  }, [])

  useEffect(() => {
    const refreshReservation = () => setCurrentReservation(loadCurrentReservation())
    window.addEventListener(CURRENT_RESERVATION_CHANGED_EVENT, refreshReservation)
    window.addEventListener('storage', refreshReservation)
    window.addEventListener('focus', refreshReservation)
    return () => {
      window.removeEventListener(CURRENT_RESERVATION_CHANGED_EVENT, refreshReservation)
      window.removeEventListener('storage', refreshReservation)
      window.removeEventListener('focus', refreshReservation)
    }
  }, [])

  // QR には完全 userId を保持。カード表示は先頭 8 文字のみ。
  const memberName  = getStoredValue<string>(ONBOARDING_NAME_KEY, memberStatus.memberName) || 'ゲスト'
  const displayId   = userId.slice(0, 8).toUpperCase()
  const lastVisitFmt = lastVisitDate ? fmtLastVisit(lastVisitDate) : null

  const qrPayload = JSON.stringify({
    type: 'ginjiro-member',
    a: storeRequest.request?.id,
    userId,   // 完全 ID を必ず保持
    name: memberName,
    reservation: toCurrentReservationQrPayload(currentReservation),
    t: couponPlanForQr(),   // JOHNNY の予約で選んだ券（予約の日だけ）
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
          // 白大理石（ホームと同じ素材）に金の縁（10/26 慶一郎さん：赤茶のカードはアプリの世界観と合わない）
          background: 'linear-gradient(158deg, rgba(255,255,255,0.74) 0%, rgba(255,255,255,0.5) 55%, rgba(255,255,255,0.68) 100%), url(/images/v2/marble-bg.webp) center / cover no-repeat, #f4f1eb',
          border: '1px solid rgba(176,138,58,0.55)',
          boxShadow: [
            '0 18px 44px rgba(60,48,24,0.18)',
            '0 2px 8px rgba(60,48,24,0.10)',
            'inset 0 1px 0 rgba(255,255,255,0.9)',
            'inset 0 0 0 3px rgba(255,255,255,0.35)',
          ].join(', '),
          overflow: 'hidden',
          padding: '22px 20px 18px',
        }}>

          {/* Layer 0 — Crimson breathing aura */}
          <div aria-hidden style={{
            position: 'absolute',
            top: '20%', left: '10%',
            width: '80%', height: '65%',
            background: 'radial-gradient(ellipse at 50% 50%, rgba(255,246,214,0.35) 0%, transparent 70%)',
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
              '  rgba(255,255,255,0.45) 50%,',
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
            background: 'linear-gradient(90deg, transparent 0%, rgba(176,138,58,0.5) 15%, rgba(214,178,92,0.95) 50%, rgba(176,138,58,0.5) 85%, transparent 100%)',
            zIndex: 4,
          }} />

          {/* ── Content ── */}
          <div style={{ position: 'relative', zIndex: 5 }}>

            {/* Header */}
            <p className="passport-card-label" style={{
              fontSize: 12, fontWeight: 700, letterSpacing: '0.18em',
              color: '#9a7a2e', fontFamily: 'monospace',
              marginBottom: 16, whiteSpace: 'nowrap', overflow: 'hidden',
            }}>
              GINJIRO OFFICIAL MEMBER CARD
            </p>

            {/* Main row */}
            <div className="passport-main" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>

              {/* Left column */}
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>

                {/* ── 会員名 ── */}
                <p style={{
                  fontFamily: SERIF,
                  fontSize: 'clamp(26px, 7.2vw, 34px)',
                  fontWeight: 700,
                  color: '#1c1f1d',
                  lineHeight: 1.15,
                  letterSpacing: '0.06em',
                  textShadow: '0 1px 0 rgba(255,255,255,0.8)',
                  marginBottom: 6,
                }}>
                  {memberName}
                  {/* 「様」— 会員名の約52%サイズ、シルバー系 */}
                  <span style={{
                    fontSize: 'clamp(14px, 3.6vw, 18px)',
                    fontWeight: 300,
                    color: 'rgba(28,31,29,0.5)',
                    marginLeft: '0.30em',
                    verticalAlign: 'baseline',
                  }}>
                    様
                  </span>
                </p>

                {/* ── 会員ID（シャンパンゴールド、先頭8文字） ── */}
                <p style={{
                  fontFamily: 'monospace',
                  fontSize: 'clamp(12px, 3.0vw, 14px)',
                  color: '#8a6a22',
                  letterSpacing: '0.16em',
                  lineHeight: 1.4,
                  marginBottom: 12,
                  whiteSpace: 'nowrap',
                }}>
                  ID · {displayId}
                </p>

                {/* Divider */}
                <div style={{
                  height: 1,
                  background: 'linear-gradient(90deg, rgba(176,138,58,0.55) 0%, rgba(176,138,58,0.15) 70%, transparent 100%)',
                  marginBottom: 10,
                }} />

                {/* ── 最終来店日 ── */}
                <div>
                  <p style={{
                    fontSize: 13, letterSpacing: '0.18em',
                    color: '#9a7a2e',
                    fontFamily: 'monospace', marginBottom: 5,
                  }}>
                    LAST VISIT
                  </p>
                  <p style={{
                    fontFamily: SERIF,
                    // 細いスマホでも右が切れないよう、点区切りで小さめに（344px 幅でも収まる）
                    fontSize: 'clamp(16px, 4.6vw, 24px)',
                    fontWeight: 700,
                    color: lastVisitDate ? '#1c1f1d' : 'rgba(28,31,29,0.3)',
                    letterSpacing: '0.04em',
                    lineHeight: 1,
                    whiteSpace: 'nowrap',
                    textShadow: 'none',
                  }}>
                    {lastVisitFmt ?? '—'}
                  </p>
                </div>
              </div>

              {/* ── QR code — embedded look ── */}
              <div className="passport-qr-column" style={{ flexShrink: 0 }}>
                <div
                  className="passport-qr-thumb"
                  role="button"
                  tabIndex={0}
                  aria-label="会員QRを拡大"
                  onClick={() => setQrEnlarged(true)}
                  onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setQrEnlarged(true) } }}
                  style={{
                    padding: 7,
                    background: '#FFFFFF',
                    borderRadius: 12,
                    // 埋め込み感：外側 drop shadow + 内側 inset
                    border: '1px solid rgba(176,138,58,0.45)',
                    boxShadow: '0 4px 14px rgba(60,48,24,0.16)',
                    cursor: 'pointer',
                    position: 'relative',
                  }}
                >
                  <QRCodeSVG
                    value={qrPayload}
                    size={108}
                    level="M"
                    marginSize={2}
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
              background: 'linear-gradient(90deg, transparent, rgba(176,138,58,0.4) 25%, rgba(176,138,58,0.4) 75%, transparent)',
              marginTop: 18, marginBottom: 10,
            }} />

            {shownReservation && (
              <div style={{
                marginBottom: 12,
                borderRadius: 14,
                padding: '10px 12px',
                background: 'rgba(255,255,255,0.72)',
                border: '1px solid rgba(176,138,58,0.35)',
              }}>
                <p style={{
                  fontSize: 8,
                  letterSpacing: '0.24em',
                  color: '#9a7a2e',
                  marginBottom: 5,
                  fontFamily: 'monospace',
                }}>
                  CURRENT RESERVATION
                </p>
                <p style={{
                  fontFamily: SERIF,
                  fontSize: 13,
                  fontWeight: 700,
                  color: '#1c1f1d',
                  lineHeight: 1.45,
                  letterSpacing: '0.05em',
                }}>
                  {shownReservation.title}
                  {shownReservation.price != null && <span style={{ color: '#8a6a22', marginLeft: 8 }}>
                    ¥{shownReservation.price.toLocaleString()}
                  </span>}
                </p>
                <p style={{ fontSize: 12, color: 'rgba(28,31,29,0.7)', marginTop: 2, letterSpacing: '0.04em' }}>{shownReservation.when}</p>
                {aiNext && prepaid != null && <p style={{ fontSize: 13, fontWeight: 700, color: '#8a6a22', marginTop: 6, letterSpacing: '0.04em' }}>✓ 銀Pay 仮支払い済み ¥{prepaid.toLocaleString()}</p>}
              </div>
            )}

            {/* Tagline */}
            <p style={{
              textAlign: 'center',
              fontSize: 15,
              letterSpacing: '0.26em',
              color: '#8a6a22',
              fontFamily: SERIF,
            }}>
              男前を、維持する。
            </p>
          </div>
        </div>
      </div>

      <StoreRequestNotice mode={storeAccess.mode} error={storeRequest.error} onRefresh={storeRequest.refresh}/>
      {!compact && <>
      <div style={{ marginTop: 16 }}><CustomerAccessSettings /></div>

      {/* ── JOHNNY のお知らせ・ホーム画面に追加 ── */}
      <div style={{ marginTop: 16, display: 'grid', gap: 10 }}>
        <PushToggle tone="gold" />
        {canShowInstallGuide() && (
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event(SHOW_INSTALL_GUIDE_EVENT))}
            style={{
              width: '100%', padding: '15px 18px', borderRadius: 14, textAlign: 'left', cursor: 'pointer',
              background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(201,162,74,0.28)', color: '#F2E6C8',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            }}
          >
            <span>
              <span style={{ display: 'block', fontFamily: SERIF, fontSize: 15, fontWeight: 700, letterSpacing: '0.04em' }}>ホーム画面に追加する</span>
              <span style={{ display: 'block', fontSize: 12, color: 'rgba(242,230,200,0.5)', marginTop: 4 }}>アプリのように、ワンタップで開けます</span>
            </span>
            <span aria-hidden="true" style={{ color: '#C9A24A', fontSize: 18 }}>›</span>
          </button>
        )}
      </div>

      {/* ── Recovery Code（会員復旧コード） ── */}
      <div style={{ marginTop: 16 }}>
        <p style={{ fontSize: 8, letterSpacing: '0.34em', color: 'rgba(201,162,74,0.36)', textTransform: 'uppercase', marginBottom: 10 }}>
          端末変更・データ削除時の復旧
        </p>
        {customerData === undefined ? null : customerData === null ? (
          <div style={{ borderRadius: 16, background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.07)', padding: '18px 20px', textAlign: 'center' }}>
            <p style={{ fontFamily: SERIF, fontSize: 13, color: 'rgba(242,230,200,0.28)', marginBottom: 6 }}>復旧コード未発行</p>
            <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.18)', lineHeight: 1.7 }}>
              初回ご来店時にスタッフが登録します
            </p>
          </div>
        ) : (
          <div style={{ borderRadius: 16, background: 'linear-gradient(155deg, #0D0805 0%, #080403 100%)', border: '1px solid rgba(201,162,74,0.2)', padding: '18px 20px' }}>
            <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.38)', letterSpacing: '0.06em', marginBottom: 10, lineHeight: 1.7 }}>
              端末変更・データ削除時はスタッフに<br />こちらのコードをお伝えください
            </p>
            <p style={{ fontFamily: SERIF, fontSize: 'clamp(19px, 6vw, 26px)', fontWeight: 700, color: '#C9A24A', letterSpacing: '0.16em', textAlign: 'center', marginBottom: 8, whiteSpace: 'nowrap' }}>
              {customerData.recovery_code}
            </p>
            <p style={{ fontSize: 9, color: 'rgba(242,230,200,0.22)', textAlign: 'center', letterSpacing: '0.1em' }}>
              ※ このコードはスクリーンショットで保存してください
            </p>
          </div>
        )}
      </div>
      </>}
    </div>

    {/* ── QR 拡大モーダル ── */}
    {qrEnlarged && (
      <div
        className="customer-member-qr-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="拡大した会員QR"
        onClick={() => setQrEnlarged(false)}
        style={{
          position: 'fixed', inset: 0, zIndex: 500,
          background: 'rgba(0,0,0,0.95)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'flex-start', overflowY: 'auto',
          padding: 'max(16px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) max(16px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px))',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <div style={{ width: '100%', maxWidth: 360, margin: 'auto 0', flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <p style={{
          fontSize: 11, letterSpacing: '0.08em', textAlign: 'center',
          color: 'rgba(201,162,74,0.82)',
          marginBottom: 20, fontFamily: 'monospace',
        }}>
          GINJIRO MEMBER QR — TAP TO CLOSE
        </p>

        <div style={{
          width: 'min(100%, 299px)', flexShrink: 0,
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
            size={272}
            level="M"
            marginSize={4}
            fgColor="#000000"
            bgColor="#FFFFFF"
            style={{ display: 'block', width: '100%', height: 'auto' }}
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
            fontSize: 13, color: 'rgba(230,202,101,0.90)',
            letterSpacing: '0.12em', fontFamily: 'monospace',
          }}>
            ID · {userId.slice(0, 24)}
          </p>
          {shownReservation && (
            <div style={{
              marginTop: 16,
              borderRadius: 14,
              padding: '12px 14px',
              background: 'rgba(10,6,4,0.78)',
              border: '1px solid rgba(201,162,74,0.26)',
              textAlign: 'left',
            }}>
              <p style={{ fontSize: 9, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.72)', marginBottom: 6 }}>
                現在の予約
              </p>
              <p style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: '#F2E6C8', lineHeight: 1.5 }}>
                {shownReservation.title}
              </p>
              <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.64)', lineHeight: 1.6 }}>
                {shownReservation.when}{shownReservation.price != null ? ` / ¥${shownReservation.price.toLocaleString()}` : ''}
              </p>
            </div>
          )}
        </div>

        <button type="button" onClick={() => setQrEnlarged(false)} style={{
          marginTop: 28, fontSize: 13,
          color: 'rgba(242,230,200,0.68)',
          letterSpacing: '0.14em', minHeight: 44, padding: '10px 20px', border: 0, borderRadius: 22, background: 'rgba(255,255,255,.06)', cursor: 'pointer',
        }}>
          閉じる
        </button>
        </div>
      </div>
    )}
    </>
  )
}
