import {useStoreAccess} from './features/customerAccess/storeAccess'
import {CUSTOMER_ACCESS_ENABLED,resumeSavedMember,supportsPasskeys,passkeyStatus} from './features/customerAccess/passkeys'
import {PasskeyEnrollmentOffer} from './features/customerAccess/CustomerAccess'
import {useCustomerAccessSession} from './features/customerAccess/useCustomerAccessSession'
import { useState, useCallback, useEffect } from 'react'
import { getCustomerSession, clearCustomerSession } from './utils/customerSession'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { OnboardingScreen, type OnboardingDonePayload } from './screens/OnboardingScreen'
import { GinjiroLoadingScreen } from './screens/GinjiroLoadingScreen'
import { flushPendingContact } from './utils/customerContact'
import type { NavTab, MemberStatus } from './data/brand'
import type { WalletFilter } from './data/wallet'
import {
  loadMemberStatus,
  saveMemberStatus,
  getStoredValue,
  setStoredValue,
  removeStoredValue,
  MEMBER_STATUS_KEY,
  ONBOARDING_DONE_KEY,
  ONBOARDING_NAME_KEY,
} from './utils/storage'
import { HERO_SLIDE_IMAGES } from './data/styleImages'
import type { TicketRow } from './data/ticket'
import { TICKET_TYPE_LABELS, TICKET_TYPE_COLORS } from './data/ticket'
import { getTicketByTransferToken, acceptTransfer } from './utils/ticketStore'
import { MEMBER_ISSUED_AT_KEY, USER_ID_KEY } from './utils/userId'
import { seedDevData } from './utils/devSeed'
import { InstallGate, InstallGuide } from './components/InstallGuide'
import { V2App } from './v2/V2App'
import { needsInstallFirst } from './utils/installGuide'
import { isStaging } from './utils/env'
import { refreshPushIfGranted } from './utils/webPush'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const MUSIC_GUIDE_KEY = 'ginjiro_music_guided'
const SHOP_AUTH_KEY = 'ginjiro_shop_auth'
const PASSKEY_SETUP_PROMPT_KEY = 'ginjiro_passkey_setup_prompt_v1'

type AppPhase = 'onboarding' | 'app'

// Staging だけ：?preview=v2 で、登録なしに V2.0 の画面を見られる（GPT など AI に見せる用）。本番では効かない
const PREVIEW_V2 = isStaging() && new URLSearchParams(window.location.search).get('preview') === 'v2'
type TransferPhase = 'preview' | 'accepting' | 'done' | 'error'

function isShopUnlocked(): boolean {
  return CUSTOMER_ACCESS_ENABLED || localStorage.getItem(SHOP_AUTH_KEY) === '1'
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

function App() {
  // テストデータを localStorage に1度だけ投入
  seedDevData()
  // 端末に一時保存した連絡先（本名・電話番号）を、サーバーの仕組みがあれば送る
  useEffect(() => { void flushPendingContact() }, [])

  // ── Loading state: min time + critical image preload ──────────────────────────
  const quickBooking=CUSTOMER_ACCESS_ENABLED && new URLSearchParams(location.search).get('tab')==='reserve'
  const [minTimeDone, setMinTimeDone] = useState(quickBooking)
  const [imgReady,    setImgReady]    = useState(quickBooking)
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
  // スマホでは、ホーム画面に追加してアイコンから開いたときだけ登録できる（iPhone は Safari とアプリで保存場所が別なので、二重登録を防ぐ）
  const [installFirst] = useState(() => !PREVIEW_V2 && needsInstallFirst())
  const [phase, setPhase] = useState<AppPhase>(() => {
    if (PREVIEW_V2) return 'app'
    const done = getStoredValue<boolean>(ONBOARDING_DONE_KEY, false)
    return done ? 'app' : 'onboarding'
  })
  const [activeTab, setActiveTabState] = useState<NavTab>(() => {
    const tab = new URLSearchParams(window.location.search).get('tab')
    const requestedTab = tab
    if (requestedTab === 'shop' && !isShopUnlocked()) return 'home'
    // 下タブの SHOP（番号入力のあと）は予約の画面を開く。ショップのページへは行かない
    if (requestedTab === 'shop') return 'reserve'
    const valid: NavTab[] = ['home', 'qr', 'next', 'reserve', 'mypage', 'tickets']
    return valid.includes(requestedTab as NavTab) ? (requestedTab as NavTab) : 'home'
  })
  const setActiveTab = useCallback((tab: NavTab) => {
    setActiveTabState(tab)
  }, [])
  const [memberStatus, setMemberStatus] = useState<MemberStatus>(loadMemberStatus)
  const [passkeyOffer,setPasskeyOffer]=useState(false)
  const [afterStoreSetup,setAfterStoreSetup]=useState(false)
  const storeAccess=useStoreAccess()
  const customerAccessSession=useCustomerAccessSession()
  useEffect(()=>{
    if(!CUSTOMER_ACCESS_ENABLED)return
    const changed=()=>{if(getCustomerSession()&&getStoredValue<boolean>(ONBOARDING_DONE_KEY,false)){setMemberStatus(loadMemberStatus());setPhase('app')}}
    window.addEventListener('ginjiro:customer-session-changed',changed)
    if(phase==='onboarding'&&getCustomerSession())void resumeSavedMember().catch(()=>{})
    return()=>window.removeEventListener('ginjiro:customer-session-changed',changed)
  },[phase])
  const [welcomeCouponDialog, setWelcomeCouponDialog] = useState<{ name: string; ticket: TicketRow | null } | null>(null)
  const [ticketInitialFilter, setTicketInitialFilter] = useState<WalletFilter>('cut')
  const [ticketRefreshKey, setTicketRefreshKey] = useState(0)
  const [hasOpenModal, setHasOpenModal] = useState(false)
  // Existing signed-in members also need a first setup entry; never enroll from a display-only member ID.
  useEffect(()=>{
    if(!CUSTOMER_ACCESS_ENABLED || storeAccess.mode!=='verified' || phase!=='app' || appLoading || activeTab!=='home' || welcomeCouponDialog || hasOpenModal || !customerAccessSession || !supportsPasskeys())return
    let alive=true
    void passkeyStatus().then(status=>{
      if(alive && getCustomerSession()===customerAccessSession && !status.registered && getStoredValue<string|null>(PASSKEY_SETUP_PROMPT_KEY,null)!==status.user_id)setPasskeyOffer(true)
    }).catch(()=>{})
    return()=>{alive=false}
  },[phase,appLoading,activeTab,welcomeCouponDialog,hasOpenModal,customerAccessSession,storeAccess.mode])
  useEffect(()=>{
    const verified=()=>{
      setMemberStatus(loadMemberStatus());setPhase('app')
      void passkeyStatus().then(status=>{
        if(!status.registered&&supportsPasskeys()){setActiveTab('home');setAfterStoreSetup(true);setPasskeyOffer(true)}
        else {setActiveTab('reserve')}
      }).catch(()=>{setActiveTab('reserve')})
    }
    window.addEventListener('ginjiro:store-verified',verified)
    return()=>window.removeEventListener('ginjiro:store-verified',verified)
  },[setActiveTab])

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
    let alive = true
    getTicketByTransferToken(transferToken)
      .then(t => {
        if (alive) setTransferTicket(t)
      })
      .catch(err => {
        console.error('[App] getTicketByTransferToken error:', err)
        if (alive) setTransferTicket(null)
      })
      .finally(() => { if (alive) setTransferLoading(false) })
    window.history.replaceState({}, '', window.location.pathname)
    return () => { alive = false }
  }, [transferToken])

  async function handleAcceptTransfer() {
    if (!transferToken || !transferTicket) return
    setTransferPhase('accepting')
    try {
      const ticket = await acceptTransfer(transferToken)
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
    // Face ID is offered after the first store verification, not on self-registration.
    if (payload?.welcomeCouponIssued && payload.ticket) {
      setWelcomeCouponDialog({ name: nextStatus.memberName, ticket: payload.ticket })
    }
  }

  // JOHNNY のお知らせ：許可済みなら受け取り先をサーバーに入れ直す（変わることがある）
  useEffect(() => { if (phase === 'app') void refreshPushIfGranted() }, [phase])

  return (
    <>
      {/* ── Phase-based render: onboarding OR app — never both ── */}
      {phase === 'onboarding' ? (

        /* StartScreen: standalone fullscreen, HomeScreen is NOT mounted */
        installFirst ? <InstallGate /> : (
        <OnboardingScreen
          memberStatus={memberStatus}
          onDone={handleOnboardingDone}
        />)

      ) : (

        /* App shell: mounted only after onboarding completes */
        <>
          {/* V2.0：上に正式ロゴと ☰、下にタブ3つ（ホーム｜会員QR｜次回予約）。チケット・ログインは ☰、AI予約は全画面 */}
          <V2App activeTab={activeTab} setActiveTab={setActiveTab} ticketFilter={ticketInitialFilter} ticketKey={ticketRefreshKey} onModalChange={handleModalChange} />

          {/* ホーム画面に追加の案内（Safari などで開いているときだけ。クーポンのあと） */}
          <InstallGuide autoAllowed={!PREVIEW_V2 && activeTab === 'home' && !passkeyOffer && !welcomeCouponDialog} />

          <AnimatePresence>
            {welcomeCouponDialog && (
              <WelcomeCouponDialog
                key="welcome-coupon"
                name={welcomeCouponDialog.name}
                onTickets={() => {
                  setWelcomeCouponDialog(null)
                  setTicketInitialFilter('other')
                  setTicketRefreshKey(k => k + 1)
                  setActiveTab('tickets')
                }}
                onHome={() => {
                  setWelcomeCouponDialog(null)
                  setTicketInitialFilter('cut')
                  setActiveTab('home')
                }}
              />
            )}
          </AnimatePresence>

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

      {passkeyOffer&&!welcomeCouponDialog&&!appLoading&&<PasskeyEnrollmentOffer onClose={()=>{const memberId=getStoredValue<string|null>(USER_ID_KEY,null);if(memberId)setStoredValue(PASSKEY_SETUP_PROMPT_KEY,memberId);setPasskeyOffer(false);if(afterStoreSetup){setAfterStoreSetup(false);setActiveTab('reserve')}}}/>}
      {/* Loading screen — topmost, covers everything during initial load */}
      <AnimatePresence>
        {appLoading && <GinjiroLoadingScreen key="loading" />}
      </AnimatePresence>
    </>
  )
}

export default App
