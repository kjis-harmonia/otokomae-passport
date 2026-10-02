import { useState, useCallback, useEffect } from 'react'
import { supabase } from './lib/supabase'
import { getCustomerSession, clearCustomerSession } from './utils/customerSession'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { AppHeader } from './components/AppHeader'
import { BottomNavigation } from './components/BottomNavigation'
import { HomeScreen } from './screens/HomeScreen'
import { GachaScreen } from './screens/GachaScreen'
import { TryOnScreen } from './screens/TryOnScreen'
import { ReserveScreen } from './screens/ReserveScreen'
import { TicketWalletScreen } from './screens/TicketWalletScreen'
import { MyPageScreen } from './screens/MyPageScreen'
import { StyleLibraryScreen } from './screens/StyleLibraryScreen'
import { ShopScreen } from './screens/ShopScreen'
import { DiagnosisScreen } from './screens/DiagnosisScreen'
import { OnboardingScreen, type OnboardingDonePayload } from './screens/OnboardingScreen'
import { GinjiroLoadingScreen } from './screens/GinjiroLoadingScreen'
import PremiumGachaExperience from './components/PremiumGachaExperience'
import { MemberQrModal } from './components/MemberQrModal'
import { MOCK_MEMBER } from './data/brand'
import type { NavTab, MemberStatus } from './data/brand'
import type { WalletFilter } from './data/wallet'
import {
  loadMemberStatus,
  saveMemberStatus,
  getStoredValue,
  removeStoredValue,
  MEMBER_STATUS_KEY,
  ONBOARDING_DONE_KEY,
  ONBOARDING_NAME_KEY,
} from './utils/storage'
import { HERO_SLIDE_IMAGES } from './data/styleImages'
import type { TicketRow } from './data/ticket'
import { TICKET_TYPE_LABELS, TICKET_TYPE_COLORS } from './data/ticket'
import { getTicketByTransferToken, acceptTransfer } from './utils/ticketStore'
import { getUserId, MEMBER_ISSUED_AT_KEY, USER_ID_KEY } from './utils/userId'
import { useBgm } from './hooks/useBgm'
import { seedDevData } from './utils/devSeed'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const MUSIC_GUIDE_KEY = 'ginjiro_music_guided'
const SHOP_AUTH_KEY = 'ginjiro_shop_auth'

type AppPhase = 'onboarding' | 'app'
type TransferPhase = 'preview' | 'accepting' | 'done' | 'error'

function isShopUnlocked(): boolean {
  return localStorage.getItem(SHOP_AUTH_KEY) === '1'
}

function isLocalPreviewHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  )
}

function consumeDevOnboardingReset(): void {
  if (typeof window === 'undefined') return
  if (!isLocalPreviewHost(window.location.hostname)) return

  const params = new URLSearchParams(window.location.search)
  const shouldReset = params.get('resetOnboarding') === '1' || params.get('devReset') === 'onboarding'
  if (!shouldReset) return

  removeStoredValue(ONBOARDING_DONE_KEY)
  removeStoredValue(ONBOARDING_NAME_KEY)
  removeStoredValue(MEMBER_STATUS_KEY)
  removeStoredValue(MUSIC_GUIDE_KEY)

  if (params.get('freshUser') === '1' || params.get('newUser') === '1') {
    removeStoredValue(USER_ID_KEY)
    removeStoredValue(MEMBER_ISSUED_AT_KEY)
    clearCustomerSession() // 前のユーザーの顧客セッションを持ち越さない
  }

  params.delete('resetOnboarding')
  params.delete('devReset')
  params.delete('freshUser')
  params.delete('newUser')
  const nextSearch = params.toString()
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`,
  )
}

consumeDevOnboardingReset()

function SoundtrackIcon({ active = false, size = 26 }: { active?: boolean; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      style={{ display: 'block', filter: active ? 'drop-shadow(0 0 6px rgba(232,199,122,0.42))' : 'none' }}
    >
      <path
        d="M10.4 7.2v10.45"
        stroke={active ? '#E8C77A' : '#C9A24A'}
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M10.4 7.2l5.4-1.25v3.2l-5.4 1.25"
        stroke={active ? '#E8C77A' : '#C9A24A'}
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8.15" cy="18.1" r="2.35" fill={active ? '#E8C77A' : '#C9A24A'} opacity={active ? 0.95 : 0.62} />
      <rect x="16.7" y="13.1" width="1.8" height="6.2" rx="0.9" fill={active ? '#E8C77A' : '#C9A24A'} opacity="0.72" />
      <rect x="20.1" y="9.4" width="1.8" height="9.9" rx="0.9" fill={active ? '#E8C77A' : '#C9A24A'} opacity={active ? 0.95 : 0.52} />
      <rect x="23.5" y="11.9" width="1.8" height="7.4" rx="0.9" fill={active ? '#E8C77A' : '#C9A24A'} opacity="0.66" />
      <path
        d="M15.3 21.6h10.5"
        stroke={active ? '#E8C77A' : '#C9A24A'}
        strokeWidth="1.1"
        strokeLinecap="round"
        opacity="0.38"
      />
    </svg>
  )
}

// ── Music Guide Popup (one-time, first home screen visit) ─────────────────────
function MusicGuidePopup({ onDismiss }: { onDismiss: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.30 }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 300,
        background: 'rgba(0,0,0,0.82)',
        backdropFilter: 'blur(5px)',
        WebkitBackdropFilter: 'blur(5px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.90, y: 20 }}
        animate={{ opacity: 1, scale: 1,    y: 0  }}
        exit={{    opacity: 0, scale: 0.94,  y: 8  }}
        transition={{ duration: 0.38, ease: [0.22, 0.68, 0.34, 1.0] }}
        style={{
          width: '100%',
          maxWidth: 360,
          borderRadius: 28,
          background: 'linear-gradient(162deg, #0e0b06 0%, #080602 100%)',
          border: '1px solid rgba(212,175,55,0.30)',
          boxShadow: [
            '0 36px 90px rgba(0,0,0,0.95)',
            '0 0 0 0.5px rgba(212,175,55,0.10)',
            'inset 0 1px 0 rgba(212,175,55,0.16)',
          ].join(', '),
          padding: '36px 28px 30px',
        }}
      >
        {/* Soundtrack icon medallion */}
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div style={{
            width: 60,
            height: 60,
            borderRadius: '50%',
            background: 'rgba(212,175,55,0.06)',
            border: '1px solid rgba(212,175,55,0.30)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 22px rgba(212,175,55,0.18), inset 0 1px 0 rgba(212,175,55,0.10)',
          }}>
            <SoundtrackIcon active size={36} />
          </div>
        </div>

        {/* Header */}
        <h2 style={{
          fontFamily: SERIF,
          fontSize: 20,
          fontWeight: 700,
          color: '#e6ca65',
          textAlign: 'center',
          letterSpacing: '0.10em',
          marginBottom: 18,
          textShadow: '0 2px 14px rgba(212,175,55,0.30)',
        }}>
          🎵 音楽について
        </h2>

        {/* Divider */}
        <div style={{
          height: '0.5px',
          background: 'linear-gradient(90deg, transparent, rgba(212,175,55,0.28) 30%, rgba(212,175,55,0.28) 70%, transparent)',
          marginBottom: 24,
        }} />

        {/* Body */}
        <p style={{
          fontFamily: SERIF,
          fontSize: 16,
          lineHeight: 2.1,
          color: '#F2E6C8',
          textAlign: 'center',
          letterSpacing: '0.05em',
          marginBottom: 10,
        }}>
          銀二郎サウンドは<br />
          ホーム画面右上の<br />
          サウンドボタンから<br />
          好きな曲を選べます。<br />
          再生と停止も<br />
          いつでも切り替えできます。
        </p>
        <p style={{
          fontFamily: SERIF,
          fontSize: 13,
          lineHeight: 1.8,
          color: 'rgba(242,230,200,0.46)',
          textAlign: 'center',
          letterSpacing: '0.06em',
          marginBottom: 28,
        }}>
          ごゆっくりお楽しみください。
        </p>

        {/* CTA */}
        <motion.button
          type="button"
          onClick={onDismiss}
          whileTap={{ scale: 0.97 }}
          style={{
            width: '100%',
            padding: '17px 0',
            borderRadius: 16,
            background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 58%, #8B1A1A 100%)',
            border: '1px solid rgba(212,175,55,0.46)',
            boxShadow: [
              '0 4px 28px rgba(107,15,18,0.58)',
              '0 0 14px rgba(212,175,55,0.10)',
            ].join(', '),
            fontFamily: SERIF,
            fontSize: 17,
            fontWeight: 700,
            letterSpacing: '0.26em',
            color: '#F2E6C8',
            cursor: 'pointer',
          }}
        >
          男前開始
        </motion.button>
      </motion.div>
    </motion.div>
  )
}

function WelcomeCouponDialog({
  name,
  onTickets,
  onHome,
}: {
  name: string
  onTickets: () => void
  onHome: () => void
}) {
  if (typeof document === 'undefined') return null

  return createPortal(
    <motion.div
      key="welcome-coupon-dialog"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22 }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99990,
        display: 'grid',
        placeItems: 'center',
        padding: 'max(24px, env(safe-area-inset-top, 0px)) 24px max(24px, env(safe-area-inset-bottom, 0px))',
        background:
          'radial-gradient(circle at 50% 24%, rgba(78,12,18,0.34), transparent 44%), linear-gradient(180deg, rgba(5,3,3,0.94), rgba(9,4,5,0.98))',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 10 }}
        transition={{ duration: 0.36, ease: [0.22, 0.68, 0.34, 1] }}
        role="dialog"
        aria-modal="true"
        aria-label={`${name}さんのWelcomeクーポン`}
        style={{
          width: '100%',
          maxWidth: 390,
          padding: '0 4px',
          textAlign: 'center',
        }}
      >
        <div
          aria-hidden
          style={{
            width: 42,
            height: 1,
            margin: '0 auto 34px',
            background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.82), transparent)',
          }}
        />
        <p
          style={{
            margin: '0 0 18px',
            color: 'rgba(201,162,74,0.68)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.28em',
            textTransform: 'uppercase',
          }}
        >
          Welcome Coupon
        </p>
        <h2
          style={{
            margin: '0 0 18px',
            color: '#F2E6C8',
            fontFamily: SERIF,
            fontSize: 'clamp(25px, 7vw, 31px)',
            lineHeight: 1.55,
            letterSpacing: '0.08em',
            fontWeight: 700,
          }}
        >
          ようこそ、<br />
          二代目銀二郎へ
        </h2>
        <p
          style={{
            margin: '0 auto 24px',
            color: 'rgba(242,230,200,0.62)',
            fontFamily: SERIF,
            fontSize: 14,
            lineHeight: 1.9,
            letterSpacing: '0.08em',
          }}
        >
          Welcomeクーポンをお届けしました
        </p>
        <div
          style={{
            width: '100%',
            padding: '18px 0',
            margin: '0 auto 28px',
            borderTop: '1px solid rgba(201,162,74,0.22)',
            borderBottom: '1px solid rgba(201,162,74,0.22)',
          }}
        >
          <p
            style={{
              margin: 0,
              color: '#F2E6C8',
              fontFamily: SERIF,
              fontSize: 'clamp(19px, 5.4vw, 23px)',
              lineHeight: 1.45,
              letterSpacing: '0.08em',
              fontWeight: 700,
            }}
          >
            特殊パーマ<br />
            <span style={{ color: '#D9B763', letterSpacing: '0.04em' }}>¥2,000 OFF</span>
          </p>
        </div>
        <div style={{ display: 'grid', gap: 16 }}>
          <button
            type="button"
            onClick={onTickets}
            style={{
              minHeight: 52,
              borderRadius: 14,
              border: '1px solid rgba(201,162,74,0.58)',
              background:
                'linear-gradient(160deg, rgba(76,14,18,0.96) 0%, rgba(111,18,28,0.96) 56%, rgba(55,8,12,0.98) 100%)',
              boxShadow: '0 12px 34px rgba(54,8,12,0.48), inset 0 1px 0 rgba(242,230,200,0.08)',
              color: '#F2E6C8',
              fontFamily: SERIF,
              fontSize: 15,
              fontWeight: 700,
              letterSpacing: '0.18em',
              cursor: 'pointer',
            }}
          >
            クーポンを見る
          </button>
          <button
            type="button"
            onClick={onHome}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'rgba(242,230,200,0.46)',
              fontFamily: SERIF,
              fontSize: 12,
              lineHeight: 1.7,
              letterSpacing: '0.14em',
              cursor: 'pointer',
              padding: '2px 0',
            }}
          >
            ホームへ
          </button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  )
}

function ShopPasswordGate({
  open,
  onUnlock,
  onClose,
}: {
  open: boolean
  onUnlock: () => void
  onClose: () => void
}) {
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    if (!open) {
      setPasscode('')
      setError(null)
    }
  }, [open])

  // パスコードはサーバー側（verify_shop_passcode RPC）で照合する。フロントは正解を持たない。
  async function submit() {
    if (checking || !passcode.trim()) return
    setChecking(true)
    try {
      // 顧客セッションがあれば失敗回数を端末単位で数える（第三者の失敗で全員がロックされない）
      const { data, error: rpcError } = await supabase.rpc('verify_shop_passcode', { p_passcode: passcode.trim(), p_session: getCustomerSession() })
      if (rpcError) { setError('通信できません。電波を確認してください'); return }
      const r = data as { ok?: boolean; error?: string }
      if (r?.ok) {
        localStorage.setItem(SHOP_AUTH_KEY, '1')
        onUnlock()
        return
      }
      setError(r?.error === 'locked' ? '入力ミスが続いたため10分間ロック中です' : 'パスワードが違います')
      setPasscode('')
    } catch {
      setError('通信できません。電波を確認してください')
    } finally {
      setChecking(false)
    }
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="shop-password-gate"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99999,
            background: 'rgba(0,0,0,0.46)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            display: 'grid',
            placeItems: 'center',
            padding: 20,
          }}
        >
          <motion.form
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.985 }}
            transition={{ duration: 0.24, ease: [0.22, 0.68, 0.34, 1] }}
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
            style={{
              width: '100%',
              maxWidth: 360,
              borderRadius: 26,
              background: '#fff',
              border: '1px solid #eadfce',
              boxShadow: '0 26px 80px rgba(0,0,0,0.34)',
              padding: '26px 22px 22px',
              color: '#111',
            }}
          >
            <p
              style={{
                margin: '0 0 6px',
                color: '#9b1f23',
                fontFamily: SERIF,
                fontSize: 13,
                fontWeight: 800,
                letterSpacing: '0.18em',
              }}
            >
              GINJIRO SHOP
            </p>
            <h2 style={{ margin: 0, fontSize: 24, fontWeight: 900, letterSpacing: 0 }}>
              パスワード入力
            </h2>
            <p style={{ margin: '9px 0 18px', color: '#666', fontSize: 13, lineHeight: 1.7 }}>
              SHOPは確認用ロック中です。パスワード入力後に表示します。
            </p>

            <input
              autoFocus
              inputMode="numeric"
              type="password"
              value={passcode}
              onChange={(event) => {
                setPasscode(event.target.value)
                setError(null)
              }}
              placeholder="パスワード"
              style={{
                width: '100%',
                height: 52,
                borderRadius: 16,
                border: `1.5px solid ${error ? '#c00019' : '#ddd4c8'}`,
                background: '#fbfaf8',
                color: '#111',
                fontSize: 22,
                fontWeight: 900,
                letterSpacing: '0.16em',
                outline: 'none',
                padding: '0 16px',
                boxSizing: 'border-box',
              }}
            />

            {error && (
              <p style={{ margin: '9px 0 0', color: '#c00019', fontSize: 12, fontWeight: 800 }}>
                {error}
              </p>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 10, marginTop: 18 }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  height: 48,
                  borderRadius: 999,
                  border: '1px solid #ddd4c8',
                  background: '#fff',
                  color: '#333',
                  fontWeight: 900,
                }}
              >
                戻る
              </button>
              <button
                type="submit"
                style={{
                  height: 48,
                  borderRadius: 999,
                  border: 0,
                  background: '#111',
                  color: '#fff',
                  fontWeight: 900,
                  boxShadow: '0 10px 22px rgba(0,0,0,0.18)',
                }}
              >
                SHOPを見る
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

type BgmController = ReturnType<typeof useBgm>

function BgmTrackSheet({
  open,
  bgm,
  onClose,
}: {
  open: boolean
  bgm: BgmController
  onClose: () => void
}) {
  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            type="button"
            aria-label="BGMメニューを閉じる"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 99998,
              border: 0,
              background: 'rgba(0,0,0,0.18)',
              cursor: 'default',
            }}
          />
          <motion.div
            key="bgm-track-sheet"
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.985 }}
            transition={{ duration: 0.24, ease: [0.22, 0.68, 0.34, 1] }}
            role="dialog"
            aria-modal="true"
            aria-label="BGM SELECT"
            style={{
              position: 'fixed',
              bottom: 'calc(env(safe-area-inset-bottom, 0px) + 90px)',
              left: 12,
              right: 12,
              zIndex: 99999,
              width: 'auto',
              maxWidth: 420,
              margin: '0 auto',
              borderRadius: 22,
              background:
                'radial-gradient(circle at 92% 0%, rgba(201,162,74,0.14), transparent 36%), linear-gradient(160deg, rgba(16,9,5,0.98) 0%, rgba(5,3,2,0.98) 100%)',
              border: '1px solid rgba(201,162,74,0.34)',
              boxShadow:
                '0 24px 70px rgba(0,0,0,0.84), inset 0 1px 0 rgba(242,230,200,0.08)',
              backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
              padding: '14px',
              boxSizing: 'border-box',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
              <div>
                <p
                  style={{
                    fontFamily: SERIF,
                    fontSize: 13,
                    fontWeight: 700,
                    letterSpacing: '0.18em',
                    color: '#F2E6C8',
                  }}
                >
                  BGM SELECT
                </p>
                <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.42)', marginTop: 2 }}>
                  好きな曲を選べます / {bgm.isPlaying ? `${bgm.currentTrack.title} 再生中` : '停止中'}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="BGMメニューを閉じる"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                  background: 'rgba(255,255,255,0.035)',
                  border: '1px solid rgba(201,162,74,0.18)',
                  color: 'rgba(242,230,200,0.58)',
                  cursor: 'pointer',
                  fontSize: 18,
                  lineHeight: '28px',
                }}
              >
                ×
              </button>
            </div>

            <div style={{ display: 'grid', gap: 8 }}>
              {bgm.tracks.map((track) => {
                const active = track.id === bgm.currentTrack.id
                const playing = active && bgm.isPlaying
                return (
                  <div
                    key={track.id}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '11px 12px',
                      borderRadius: 14,
                      background: active
                        ? 'linear-gradient(135deg, rgba(201,162,74,0.16), rgba(107,15,18,0.16))'
                        : 'rgba(255,255,255,0.025)',
                      border: active
                        ? '1px solid rgba(201,162,74,0.46)'
                        : '1px solid rgba(201,162,74,0.10)',
                      boxShadow: active ? '0 0 18px rgba(201,162,74,0.10), inset 0 1px 0 rgba(242,230,200,0.06)' : 'none',
                      color: '#F2E6C8',
                      textAlign: 'left',
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: '50%',
                        background: active ? '#C9A24A' : 'rgba(201,162,74,0.22)',
                        boxShadow: active ? '0 0 14px rgba(201,162,74,0.55)' : 'none',
                        flex: '0 0 auto',
                      }}
                    />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block', fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.05em' }}>
                        {track.title}
                      </span>
                      <span style={{ display: 'block', marginTop: 2, fontSize: 10, color: 'rgba(242,230,200,0.42)' }}>
                        {track.subtitle}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (playing) {
                          bgm.stop()
                        } else {
                          bgm.playTrack(track.id)
                        }
                      }}
                      style={{
                        flex: '0 0 auto',
                        minWidth: 62,
                        padding: '8px 12px',
                        borderRadius: 999,
                        background: playing
                          ? 'rgba(255,255,255,0.035)'
                          : 'linear-gradient(135deg, rgba(201,162,74,0.24), rgba(107,15,18,0.20))',
                        border: playing
                          ? '1px solid rgba(242,230,200,0.16)'
                          : '1px solid rgba(201,162,74,0.45)',
                        color: playing ? 'rgba(242,230,200,0.62)' : '#E8C77A',
                        fontFamily: SERIF,
                        fontSize: 12,
                        fontWeight: 700,
                        letterSpacing: '0.08em',
                        cursor: 'pointer',
                      }}
                    >
                      {playing ? '停止' : '再生'}
                    </button>
                  </div>
                )
              })}
            </div>

            <p style={{ marginTop: 10, fontSize: 10, lineHeight: 1.5, color: 'rgba(242,230,200,0.30)' }}>
              好きな曲を選んで、ここから再生と停止を切り替えできます。
            </p>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function App() {
  // テストデータを localStorage に1度だけ投入
  seedDevData()
  const [shopUnlocked, setShopUnlocked] = useState(isShopUnlocked)
  const [showShopPasswordGate, setShowShopPasswordGate] = useState(() => {
    const requestedTab = new URLSearchParams(window.location.search).get('tab')
    return requestedTab === 'shop' && !isShopUnlocked()
  })

  // ── Loading state: min time + critical image preload ──────────────────────────
  const [minTimeDone, setMinTimeDone] = useState(false)
  const [imgReady,    setImgReady]    = useState(false)
  const appLoading = !minTimeDone || !imgReady

  useEffect(() => {
    const t = setTimeout(() => setMinTimeDone(true), 1300)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    const urls = [
      '/images/ginjiro-splash.png',
      HERO_SLIDE_IMAGES[0]?.src,
      HERO_SLIDE_IMAGES[1]?.src,
    ].filter(Boolean) as string[]

    let remaining = urls.length
    const onSettled = () => { if (--remaining <= 0) setImgReady(true) }
    urls.forEach(src => {
      const img = new Image()
      img.onload  = onSettled
      img.onerror = onSettled
      img.src = src
    })
  }, [])

  // ── Phase ─────────────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<AppPhase>(() => {
    const done = getStoredValue<boolean>(ONBOARDING_DONE_KEY, false)
    return done ? 'app' : 'onboarding'
  })
  const [activeTab, setActiveTab] = useState<NavTab>(() => {
    const tab = new URLSearchParams(window.location.search).get('tab')
    const requestedTab = tab
    if (requestedTab === 'shop' && !isShopUnlocked()) return 'home'
    const valid: NavTab[] = ['home', 'styles', 'shop', 'diagnosis', 'tryon', 'reserve', 'mypage', 'tickets']
    return valid.includes(requestedTab as NavTab) ? (requestedTab as NavTab) : 'home'
  })
  const [memberStatus, setMemberStatus] = useState<MemberStatus>(loadMemberStatus)
  const [welcomeCouponDialog, setWelcomeCouponDialog] = useState<{ name: string; ticket: TicketRow | null } | null>(null)
  const [ticketInitialFilter, setTicketInitialFilter] = useState<WalletFilter>('cut')
  const [ticketRefreshKey, setTicketRefreshKey] = useState(0)
  const [isPremiumGachaOpen, setIsPremiumGachaOpen] = useState(false)
  const [hasOpenModal, setHasOpenModal] = useState(false)
  const [showQrModal, setShowQrModal] = useState(false)
  // navHighlight drives the bottom nav visual indicator independently from activeTab
  const [navHighlight, setNavHighlight] = useState<NavTab>(() => {
    const tab = new URLSearchParams(window.location.search).get('tab')
    const requestedTab = tab
    if (requestedTab === 'shop' && !isShopUnlocked()) return 'home'
    if (requestedTab === 'diagnosis') return 'shop'
    const navTabs: NavTab[] = ['home', 'styles', 'shop', 'tickets']
    return navTabs.includes(requestedTab as NavTab) ? (requestedTab as NavTab) : 'home'
  })

  // ── Transfer acceptance overlay ───────────────────────────────────────────────
  const [transferToken, setTransferToken]   = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('token')
  })
  const [transferTicket,  setTransferTicket]  = useState<TicketRow | null>(null)
  const [transferLoading, setTransferLoading] = useState(() =>
    !!new URLSearchParams(window.location.search).get('token')
  )
  const [transferPhase, setTransferPhase]   = useState<TransferPhase>('preview')
  const [transferError, setTransferError]   = useState<string | null>(null)
  const [acceptedTicket, setAcceptedTicket] = useState<TicketRow | null>(null)

  useEffect(() => {
    if (!transferToken) return
    setTransferLoading(true)
    setTransferTicket(null)
    getTicketByTransferToken(transferToken)
      .then(t => {
        setTransferTicket(t)
      })
      .catch(err => {
        console.error('[App] getTicketByTransferToken error:', err)
        setTransferTicket(null)
      })
      .finally(() => setTransferLoading(false))
    window.history.replaceState({}, '', window.location.pathname)
  }, [transferToken]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAcceptTransfer() {
    if (!transferToken || !transferTicket) return
    setTransferPhase('accepting')
    try {
      const ticket = await acceptTransfer(transferToken, getUserId())
      setAcceptedTicket(ticket)
      setTransferPhase('done')
    } catch (e) {
      setTransferError(e instanceof Error ? e.message : '受け取りに失敗しました')
      setTransferPhase('error')
    }
  }

  function handleRetryTransfer() {
    setTransferPhase('preview')
    setTransferError(null)
    // token はまだ state に残っているので再試行可能
    if (transferToken) {
      setTransferLoading(true)
      setTransferTicket(null)
      getTicketByTransferToken(transferToken)
        .then(t => setTransferTicket(t))
        .catch(() => setTransferTicket(null))
        .finally(() => setTransferLoading(false))
    }
  }

  function handleDismissTransfer() {
    setTransferToken(null)
    setTransferTicket(null)
    setTransferLoading(false)
    setTransferPhase('preview')
    setTransferError(null)
    setAcceptedTicket(null)
  }

  const handleModalChange = useCallback((open: boolean) => {
    setHasOpenModal(open)
  }, [])

  function handleOnboardingDone(nextStatus: MemberStatus, payload?: OnboardingDonePayload) {
    saveMemberStatus(nextStatus)
    setMemberStatus(nextStatus)
    setPhase('app')
    if (payload?.welcomeCouponIssued && payload.ticket) {
      setWelcomeCouponDialog({ name: nextStatus.memberName, ticket: payload.ticket })
    }
  }

  const handleTabChange = useCallback((tab: NavTab) => {
    const nextTab = tab
    if (nextTab === 'shop' && !shopUnlocked) {
      setShowShopPasswordGate(true)
      return
    }
    if (nextTab === 'diagnosis') {
      setNavHighlight('shop')
      setActiveTab('diagnosis')
      return
    }
    const navTabs: NavTab[] = ['home', 'styles', 'shop', 'tickets']
    if (navTabs.includes(nextTab)) setNavHighlight(nextTab)
    if (nextTab === 'tickets') setTicketInitialFilter('cut')
    setActiveTab(nextTab)
    if (tab === 'gacha') setIsPremiumGachaOpen(true)
  }, [shopUnlocked])

  const handleShopUnlock = useCallback(() => {
    setShopUnlocked(true)
    setShowShopPasswordGate(false)
    setNavHighlight('shop')
    setActiveTab('shop')
  }, [])

  const handleGachaComplete = useCallback(() => {
    // 結果の表示はガチャ演出側で行う
  }, [])

  const handleGachaClose = useCallback(() => {
    setIsPremiumGachaOpen(false)
  }, [])

  const bgm = useBgm()
  const [showBgmMenu, setShowBgmMenu] = useState(false)

  // ── Music guide — show once after first home screen mount ─────────────────────
  const [showMusicGuide, setShowMusicGuide] = useState(false)

  useEffect(() => {
    if (phase !== 'app') return
    if (welcomeCouponDialog) return
    // ホーム画面でのみ案内する（「クーポンを見る」でWalletへ直行したときにクーポンを隠さない）
    if (activeTab !== 'home') return
    if (localStorage.getItem(MUSIC_GUIDE_KEY) === 'true') return
    const t = setTimeout(() => setShowMusicGuide(true), 700)
    return () => clearTimeout(t)
  }, [phase, welcomeCouponDialog, activeTab])

  useEffect(() => {
    if (activeTab !== 'home') setShowBgmMenu(false)
  }, [activeTab])

  function dismissMusicGuide() {
    localStorage.setItem(MUSIC_GUIDE_KEY, 'true')
    setShowMusicGuide(false)
  }

  const liveMember = {
    ...MOCK_MEMBER,
    name: memberStatus.memberName,
    rank: memberStatus.rank,
    points: memberStatus.points,
    visitCount: memberStatus.visitCount,
  }

  return (
    <>
      {/* ── Phase-based render: onboarding OR app — never both ── */}
      {phase === 'onboarding' ? (

        /* StartScreen: standalone fullscreen, HomeScreen is NOT mounted */
        <OnboardingScreen
          memberStatus={memberStatus}
          onDone={handleOnboardingDone}
        />

      ) : (

        /* App shell: mounted only after onboarding completes */
        <>
          <div className="app-shell flex flex-col h-dvh w-full mx-auto overflow-hidden">
{activeTab !== 'home' && activeTab !== 'shop' && <AppHeader />}
            <main className="app-main flex-1 overflow-y-auto">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={activeTab}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                >
                  {activeTab === 'home'      && <HomeScreen member={liveMember} onTabChange={handleTabChange} onModalChange={handleModalChange} />}
                  {activeTab === 'gacha'     && <GachaScreen memberStatus={memberStatus} onMemberStatusChange={setMemberStatus} />}
                  {activeTab === 'tryon'     && <TryOnScreen />}
                  {activeTab === 'reserve'   && <ReserveScreen />}
                  {activeTab === 'tickets'   && (
                    <TicketWalletScreen
                      key={`tickets-${ticketInitialFilter}-${ticketRefreshKey}`}
                      onModalChange={handleModalChange}
                      initialFilter={ticketInitialFilter}
                    />
                  )}
                  {activeTab === 'styles'    && <StyleLibraryScreen onTabChange={handleTabChange} onModalChange={handleModalChange} />}
                  {activeTab === 'diagnosis' && <DiagnosisScreen onTabChange={handleTabChange} onModalChange={handleModalChange} />}
                  {activeTab === 'shop'      && <ShopScreen />}
                  {activeTab === 'mypage'    && <MyPageScreen memberStatus={memberStatus} onMemberStatusChange={setMemberStatus} />}
                </motion.div>
              </AnimatePresence>
            </main>
            {!hasOpenModal && (
              <BottomNavigation
                active={navHighlight}
                onChange={handleTabChange}
                onQrPress={() => setShowQrModal(true)}
                qrActive={showQrModal}
              />
            )}
          </div>

          {/* Soundtrack button — fixed top-right, visible on home tab only */}
          {activeTab === 'home' && !showQrModal && (
            <>
              <style>{`
                @keyframes bgmSoundtrackPulse {
                  0%   { box-shadow: 0 0 0  0px rgba(212,175,55,0.00); }
                  35%  { box-shadow: 0 0 0 10px rgba(212,175,55,0.42), 0 0 28px rgba(212,175,55,0.24); }
                  65%  { box-shadow: 0 0 0  5px rgba(212,175,55,0.22), 0 0 14px rgba(212,175,55,0.12); }
                  100% { box-shadow: 0 0 0  0px rgba(212,175,55,0.00); }
                }
              `}</style>

              {/* Pulse ring — golden aura around soundtrack button when music guide is open */}
              {showMusicGuide && (
                <div
                  aria-hidden
                  style={{
                    position: 'fixed',
                    top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
                    right: 16,
                    width: 40,
                    height: 40,
                    borderRadius: '50%',
                    zIndex: 339,
                    pointerEvents: 'none',
                    animation: 'bgmSoundtrackPulse 2.6s ease-in-out 2',
                  }}
                />
              )}

              <button
                type="button"
                onClick={() => {
                  setShowBgmMenu(true)
                }}
                aria-label="サウンドトラックを開く"
                style={{
                  position: 'fixed',
                  top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
                  right: 16,
                  zIndex: 10001,
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  background: bgm.isPlaying
                    ? 'linear-gradient(160deg, rgba(20,11,5,0.92), rgba(7,3,2,0.88) 54%, rgba(76,9,14,0.28))'
                    : 'linear-gradient(160deg, rgba(8,4,2,0.76), rgba(4,2,1,0.70))',
                  border: `1.5px solid ${bgm.isPlaying ? 'rgba(201,162,74,0.82)' : 'rgba(201,162,74,0.18)'}`,
                  boxShadow: bgm.isPlaying
                    ? '0 0 16px rgba(201,162,74,0.40), 0 0 6px rgba(201,162,74,0.22), 0 2px 10px rgba(0,0,0,0.6)'
                    : '0 2px 8px rgba(0,0,0,0.45)',
                  color: bgm.isPlaying ? '#C9A24A' : 'rgba(201,162,74,0.30)',
                  cursor: 'pointer',
                  backdropFilter: 'blur(14px)',
                  WebkitBackdropFilter: 'blur(14px)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  WebkitTapHighlightColor: 'transparent',
                  opacity: bgm.isPlaying ? 1 : 0.58,
                  transition: 'border-color 0.25s, box-shadow 0.25s, color 0.25s, opacity 0.25s',
                }}
              >
                <SoundtrackIcon active={bgm.isPlaying} size={25} />
              </button>

            </>
          )}

          {/* Music guide — one-time popup, first home screen visit */}
          <BgmTrackSheet
            open={activeTab === 'home' && !showQrModal && showBgmMenu}
            bgm={bgm}
            onClose={() => setShowBgmMenu(false)}
          />

          <AnimatePresence>
            {showMusicGuide && (
              <MusicGuidePopup key="music-guide" onDismiss={dismissMusicGuide} />
            )}
          </AnimatePresence>

          <AnimatePresence>
            {welcomeCouponDialog && (
              <WelcomeCouponDialog
                key="welcome-coupon"
                name={welcomeCouponDialog.name}
                onTickets={() => {
                  setWelcomeCouponDialog(null)
                  setTicketInitialFilter('other')
                  setTicketRefreshKey(k => k + 1)
                  setNavHighlight('tickets')
                  setActiveTab('tickets')
                }}
                onHome={() => {
                  setWelcomeCouponDialog(null)
                  setTicketInitialFilter('cut')
                  setNavHighlight('home')
                  setActiveTab('home')
                }}
              />
            )}
          </AnimatePresence>

          {isPremiumGachaOpen && (
            <PremiumGachaExperience
              onClose={handleGachaClose}
              onComplete={handleGachaComplete}
            />
          )}

          <AnimatePresence>
            {showQrModal && (
              <MemberQrModal key="member-qr" onClose={() => setShowQrModal(false)} />
            )}
          </AnimatePresence>

          <ShopPasswordGate
            open={showShopPasswordGate}
            onUnlock={handleShopUnlock}
            onClose={() => setShowShopPasswordGate(false)}
          />

          {transferToken && (
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.26 }}
                style={{ width: '100%', maxWidth: 380, borderRadius: 24, background: 'linear-gradient(160deg, #160a07 0%, #0a0504 100%)', border: '1px solid rgba(201,162,74,0.28)', boxShadow: '0 24px 64px rgba(0,0,0,0.9)', padding: '28px 24px 24px' }}
              >
                {(transferPhase === 'preview' || transferPhase === 'accepting') && (
                  <>
                    <p style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 700, color: '#F2E6C8', textAlign: 'center', lineHeight: 1.5, marginBottom: 16 }}>
                      チケットを受け取りますか？
                    </p>

                    {transferLoading ? (
                      <div style={{ borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', padding: '16px', marginBottom: 16, textAlign: 'center' }}>
                        <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.44)' }}>チケット情報を取得中…</p>
                      </div>
                    ) : transferTicket ? (() => {
                      const tc = TICKET_TYPE_COLORS[transferTicket.type]
                      return (
                        <div style={{ borderRadius: 12, background: tc.bg, border: `1px solid ${tc.border}`, padding: '12px 16px', marginBottom: 16 }}>
                          <p style={{ fontSize: 9, fontWeight: 700, color: tc.text, letterSpacing: '0.14em', marginBottom: 4 }}>{TICKET_TYPE_LABELS[transferTicket.type]}</p>
                          <p style={{ fontSize: 16, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF }}>{transferTicket.title}</p>
                          {(transferTicket.amount ?? 0) > 0 && (
                            <p style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: '#C9A24A', marginTop: 2 }}>¥{(transferTicket.amount ?? 0).toLocaleString()}</p>
                          )}
                          {transferTicket.expires_at && <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.4)', marginTop: 4 }}>期限 {new Date(transferTicket.expires_at).toLocaleDateString('ja-JP')}</p>}
                        </div>
                      )
                    })() : (
                      <div style={{ borderRadius: 12, background: 'rgba(224,96,80,0.08)', border: '1px solid rgba(224,96,80,0.28)', padding: '12px 16px', marginBottom: 16, textAlign: 'center' }}>
                        <p style={{ fontSize: 12, color: '#E06060', lineHeight: 1.6 }}>
                          このチケットは受け取れません。<br />
                          トークンが無効・期限切れ、またはすでに受け取り済みです。
                        </p>
                      </div>
                    )}

                    {transferTicket && (
                      <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.36)', textAlign: 'center', lineHeight: 1.7, marginBottom: 20 }}>
                        受け取ると、あなたのチケット一覧に追加されます。{'\n'}
                        この操作は取り消せません。
                      </p>
                    )}

                    <div style={{ display: 'flex', gap: 10 }}>
                      <button type="button" onClick={handleDismissTransfer} disabled={transferPhase === 'accepting'}
                        style={{ flex: 1, padding: '13px 0', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', fontSize: 13, color: 'rgba(242,230,200,0.52)', fontFamily: SERIF, letterSpacing: '0.14em', cursor: transferPhase === 'accepting' ? 'default' : 'pointer' }}>
                        {transferTicket ? '断る' : '閉じる'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { void handleAcceptTransfer() }}
                        disabled={transferPhase === 'accepting' || transferLoading || !transferTicket}
                        style={{
                          flex: 2, padding: '13px 0', borderRadius: 14,
                          background: (transferLoading || !transferTicket)
                            ? 'rgba(201,162,74,0.08)'
                            : 'linear-gradient(135deg, #5a3a00 0%, #9a6800 60%, #c9a24a 100%)',
                          border: `1px solid ${(transferLoading || !transferTicket) ? 'rgba(201,162,74,0.18)' : 'rgba(201,162,74,0.5)'}`,
                          boxShadow: (transferLoading || !transferTicket) ? 'none' : '0 4px 20px rgba(100,80,0,0.4)',
                          fontSize: 13, fontWeight: 700,
                          color: (transferLoading || !transferTicket) ? 'rgba(201,162,74,0.30)' : '#F2E6C8',
                          fontFamily: SERIF, letterSpacing: '0.16em',
                          cursor: (transferPhase === 'accepting' || transferLoading || !transferTicket) ? 'default' : 'pointer',
                        }}
                      >
                        {transferPhase === 'accepting' ? '処理中…' : '受け取る'}
                      </button>
                    </div>
                  </>
                )}

                {transferPhase === 'done' && acceptedTicket && (() => {
                  const tc = TICKET_TYPE_COLORS[acceptedTicket.type]
                  return (
                    <>
                      <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(100,200,100,0.1)', border: '1px solid rgba(100,200,100,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                        <span style={{ fontSize: 22 }}>✓</span>
                      </div>
                      <p style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 700, color: '#F2E6C8', textAlign: 'center', marginBottom: 12 }}>受け取りました</p>
                      <div style={{ borderRadius: 12, background: tc.bg, border: `1px solid ${tc.border}`, padding: '12px 16px', marginBottom: 20, textAlign: 'center' }}>
                        <p style={{ fontSize: 15, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF }}>{acceptedTicket.title}</p>
                      </div>
                      <button type="button" onClick={handleDismissTransfer}
                        style={{ width: '100%', padding: '13px 0', borderRadius: 14, background: 'rgba(201,162,74,0.12)', border: '1px solid rgba(201,162,74,0.36)', color: '#C9A24A', fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.16em', cursor: 'pointer' }}>
                        閉じる
                      </button>
                    </>
                  )
                })()}

                {transferPhase === 'error' && (
                  <>
                    <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'rgba(224,96,80,0.10)', border: '1px solid rgba(224,96,80,0.36)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
                      <span style={{ fontSize: 20, color: '#E06060' }}>✕</span>
                    </div>
                    <p style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: '#E06060', textAlign: 'center', marginBottom: 8 }}>受け取りに失敗しました</p>
                    <p style={{ fontSize: 13, color: 'rgba(242,230,200,0.52)', textAlign: 'center', marginBottom: 20, lineHeight: 1.6 }}>
                      {transferError ?? '受け取りに失敗しました'}
                    </p>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button type="button" onClick={handleDismissTransfer}
                        style={{ flex: 1, padding: '13px 0', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(242,230,200,0.52)', fontFamily: SERIF, fontSize: 13, letterSpacing: '0.14em', cursor: 'pointer' }}>
                        閉じる
                      </button>
                      <button type="button" onClick={handleRetryTransfer}
                        style={{ flex: 1, padding: '13px 0', borderRadius: 14, background: 'rgba(201,162,74,0.08)', border: '1px solid rgba(201,162,74,0.28)', color: 'rgba(201,162,74,0.80)', fontFamily: SERIF, fontSize: 13, letterSpacing: '0.14em', cursor: 'pointer' }}>
                        再試行
                      </button>
                    </div>
                  </>
                )}
              </motion.div>
            </div>
          )}
        </>
      )}

      {/* Loading screen — topmost, covers everything during initial load */}
      <AnimatePresence>
        {appLoading && <GinjiroLoadingScreen key="loading" />}
      </AnimatePresence>
    </>
  )
}

export default App
