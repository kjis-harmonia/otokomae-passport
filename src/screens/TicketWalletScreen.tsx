import { useState, useEffect, useMemo, useCallback, useRef, type ReactNode } from 'react'
import { motion, AnimatePresence, LayoutGroup, useReducedMotion } from 'framer-motion'
import { Phone, QrCode } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { MAINTENANCE_CUT_URL } from '../data/reserveLinks'
import { getUserId } from '../utils/userId'
import { getUserTickets, clearActiveTicket, initiateTransfer, cancelTransfer } from '../utils/ticketStore'
import { fetchLastVisitDateStrict, fetchTodayUsedType } from '../utils/customerStore'
import { RpcError } from '../utils/staffSession'
import { callCustomerRpc } from '../utils/customerSession'
import { PreviousTicketsPrompt } from '../components/PreviousTicketsBind'
import { loadMemberStatus, getStoredValue, ONBOARDING_NAME_KEY } from '../utils/storage'
import { getLastVisit } from '../utils/visitHistory'
import { getMaintenanceVisit } from '../utils/maintenanceSchedule'
import { createReservation, saveCurrentReservation, RESERVATION_MAX_DAYS_AHEAD, type CurrentReservation } from '../utils/currentReservation'
import { getJapanDateString, addDaysToDateString } from '../utils/dateUtils'
import type { TicketRow } from '../data/ticket'
import { SHOP_PHONE_TEL, WALLET_FILTERS, type WalletCard, type WalletFilter } from '../data/wallet'
import {
  getMaintenanceState, getPremiumState,
  buildMaintenanceCard, buildPremiumCards, buildTicketCards, filterCards, canUseDiscountTypeToday,
} from '../utils/walletLogic'
import { isWelcomeCouponBlockedToday, WELCOME_COUPON_WEEKEND_MESSAGE } from '../utils/welcomeCoupon'
import { WalletStack } from '../components/wallet/WalletStack'
import { WalletDetailSheet } from '../components/wallet/WalletDetailSheet'
import { CARD_HEIGHT, CARD_STRIP } from '../components/wallet/WalletCardFace'
import { SERIF, IVORY } from '../components/wallet/walletTheme'
import '../components/wallet/wallet.css'

const MAINTENANCE_LOCAL_KEY = 'ginjiro_maintenance_visits'

/** 時刻依存の状態（漢前Premium・0:00跨ぎ）を再評価する間隔 */
const CLOCK_TICK_MS = 30_000

// ── 来店日の取得（既存データとの後方互換） ────────────────────────────────────

/**
 * Normalize a visit date string to YYYY-MM-DD regardless of display format.
 * Accepts: "2026-06-10", "2026 / 06 / 10", "2026/06/10"
 */
function normalizeVisitDate(value: string): string | null {
  if (!value) return null
  const normalized = value
    .trim()
    .replace(/\s+/g, '')
    .replace(/\//g, '-')
    .slice(0, 10)
  const date = new Date(`${normalized}T00:00:00`)
  if (Number.isNaN(date.getTime())) return null
  return normalized
}

/**
 * 前回来店日（QR来店登録日）を取得する。
 *   1. サーバー（get_my_last_visit RPC。スタッフ端末の来店登録が書き込む正式な起点）
 *   2. 通信できない場合のみ、端末内の旧データを表示用に参照（後方互換）
 *      localStorage ginjiro_maintenance_visits / ginjiro_visit_history / ginjiro_maintenance_visit
 *   クーポンの利用可否は最終的に店舗端末での確定時にサーバーが判定する。
 */
async function fetchLastVisitDateForUser(userId: string): Promise<string | null> {
  try {
    const d = await fetchLastVisitDateStrict(userId)
    return d ? normalizeVisitDate(d) : null
  } catch { /* 通信失敗 → 端末内の旧データで表示 */ }

  try {
    const local = getStoredValue<Record<string, unknown>>(MAINTENANCE_LOCAL_KEY, {})
    const val = local[userId]
    if (typeof val === 'string') return normalizeVisitDate(val)
    if (val && typeof val === 'object') {
      const nested = (val as Record<string, unknown>).last_visit_date
      if (typeof nested === 'string') return normalizeVisitDate(nested)
    }
  } catch { /* ignore */ }

  const legacy = getLastVisit()
  if (legacy && (!legacy.userId || legacy.userId === userId)) {
    const d = normalizeVisitDate(legacy.visitedAt)
    if (d) return d
  }
  const schedule = getMaintenanceVisit()
  if (schedule?.source === 'qr') return normalizeVisitDate(schedule.lastVisitDate)
  return null
}

// ── Types ─────────────────────────────────────────────────────────────────────

type ConfirmTicket = { ticket: TicketRow; qrPayload: string }
type PremiumCategory = Extract<WalletCard['category'], 'classic' | 'special' | 'ginpara'>
type PremiumCard = WalletCard & { category: PremiumCategory }
type PremiumQrItem = { card: PremiumCard; qrPayload: string }
type CutSpecialCoupon = (typeof CUT_SPECIAL_VISUALS)[number]

const PREMIUM_QR_VALID_MS = 30 * 60 * 1000

function usableTickets(card: WalletCard): TicketRow[] {
  if (card.source.kind !== 'ticket' || card.status !== 'active') return []
  return card.source.tickets.filter(t => !t.used && !t.pending_transfer)
}

function isPremiumCategory(category: WalletCard['category']): boolean {
  return category === 'classic' || category === 'special' || category === 'ginpara'
}

function isPremiumCard(card: WalletCard): card is WalletCard & { category: PremiumCategory } {
  return isPremiumCategory(card.category)
}

function buildPremiumQrPayload(card: PremiumCard, userId: string, memberName: string): string {
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + PREMIUM_QR_VALID_MS)
  const price = card.prices[0]
  return JSON.stringify({
    type: 'ginjiro-premium-coupon',
    userId,
    name: memberName,
    couponId: card.id,
    category: card.category,
    title: card.title,
    menuLabel: price?.label ?? card.subtitle ?? card.title,
    normalPrice: price?.normalPrice ?? null,
    memberPrice: price?.memberPrice ?? 0,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  })
}

function WalletFilterText({ filter }: { filter: WalletFilter }) {
  if (filter === 'cut') {
    return (
      <span className="wallet-chip-label">
        <span className="wallet-chip-main">GINJIRO</span>
        <span className="wallet-chip-sub">CUT</span>
      </span>
    )
  }
  if (filter === 'premium') {
    return (
      <span className="wallet-chip-label">
        <span className="wallet-chip-main">漢前Premium</span>
        <span className="wallet-chip-sub">パーマ</span>
      </span>
    )
  }
  return (
    <span className="wallet-chip-label">
      <span className="wallet-chip-main">割引</span>
      <span className="wallet-chip-sub">チケット</span>
    </span>
  )
}

// ── TicketWalletScreen ────────────────────────────────────────────────────────

export function TicketWalletScreen({
  onModalChange,
  initialFilter = 'cut',
}: {
  onModalChange?: (open: boolean) => void
  initialFilter?: WalletFilter
}) {
  const userId       = getUserId()
  const reduced      = useReducedMotion() ?? false
  const memberStatus = loadMemberStatus()
  const memberName   = getStoredValue<string>(ONBOARDING_NAME_KEY, memberStatus.memberName)

  // undefined = loading
  const [lastVisitDate, setLastVisitDate] = useState<string | null | undefined>(undefined)
  const [tickets,       setTickets]       = useState<TicketRow[] | null>(null)
  // 当日すでに使った割引種別（null = 未使用）
  const [todayUsedType, setTodayUsedType] = useState<string | null>(null)
  const [now,           setNow]           = useState(() => new Date())

  const [filter,      setFilter]      = useState<WalletFilter>(initialFilter)
  const [featuredId,  setFeaturedId]  = useState<string | null>(null)
  const [detailId,    setDetailId]    = useState<string | null>(null)

  const [confirmItem,       setConfirmItem]       = useState<ConfirmTicket | null>(null)
  const [showMaintenanceQr, setShowMaintenanceQr] = useState(false)
  const [premiumReservationCard, setPremiumReservationCard] = useState<PremiumCard | null>(null)
  const [premiumQrItem, setPremiumQrItem] = useState<PremiumQrItem | null>(null)
  const pendingPremiumCallRef = useRef<{ card: PremiumCard; timer: number | null } | null>(null)
  const [cutReservationCoupon, setCutReservationCoupon] = useState<CutSpecialCoupon | null>(null)
  const [cutReservationNotice, setCutReservationNotice] = useState<CurrentReservation | null>(null)
  const pendingCutCallRef = useRef<{ coupon: CutSpecialCoupon; timer: number | null } | null>(null)
  const [transferTicket,    setTransferTicket]    = useState<TicketRow | null>(null)
  const [transferToken,     setTransferToken]     = useState<string | null>(null)
  const [xferring,          setXferring]          = useState(false)
  const [xferError,         setXferError]         = useState<string | null>(null)
  const [copied,            setCopied]            = useState(false)

  // ── Data loading ────────────────────────────────────────────────────────────

  const refreshTickets = useCallback(() => {
    getUserTickets(userId)
      .then(setTickets)
      .catch(() => setTickets([]))
  }, [userId])

  const refreshVisit = useCallback(() => {
    fetchLastVisitDateForUser(userId).then(d => setLastVisitDate(d ?? null))
  }, [userId])

  const refreshTodayUsed = useCallback(async () => {
    try {
      setTodayUsedType(await fetchTodayUsedType(userId))
    } catch {
      setTodayUsedType(null)
    }
  }, [userId])

  /** そのチケットを本日使えるか（異なる種別の併用不可・同種は複数枚可） */
  const blockedToday = (ticket: TicketRow) => !canUseDiscountTypeToday(todayUsedType, ticket.type)

  useEffect(() => {
    clearActiveTicket()  // 前セッションの残留 activeTicket をクリア
    refreshTickets()
    refreshVisit()
    void refreshTodayUsed() // eslint-disable-line react-hooks/set-state-in-effect

    // QR来店登録・チケット使用後に戻ってきたとき最新化
    const reload = () => {
      if (document.visibilityState !== 'visible') return
      setNow(new Date())
      refreshTickets()
      refreshVisit()
      void refreshTodayUsed()
    }
    const clock = window.setInterval(() => setNow(new Date()), CLOCK_TICK_MS)
    document.addEventListener('visibilitychange', reload)
    window.addEventListener('focus', reload)
    window.addEventListener('storage', reload)
    return () => {
      window.clearInterval(clock)
      document.removeEventListener('visibilitychange', reload)
      window.removeEventListener('focus', reload)
      window.removeEventListener('storage', reload)
    }
  }, [refreshTickets, refreshVisit, refreshTodayUsed])

  // ── Cards ───────────────────────────────────────────────────────────────────

  const loading = lastVisitDate === undefined || tickets === null
  const maintenance = getMaintenanceState(lastVisitDate ?? null, now)
  const premium     = getPremiumState(now)

  const allCards = useMemo<WalletCard[]>(() => {
    if (loading) return []
    return [
      buildMaintenanceCard(maintenance),
      ...buildPremiumCards(premium),
      ...buildTicketCards(tickets ?? [], now),
    ]
    // maintenance / premium は now・lastVisitDate から決まる
  }, [loading, lastVisitDate, tickets, now]) // eslint-disable-line react-hooks/exhaustive-deps

  const cards = useMemo(() => filterCards(allCards, filter), [allCards, filter])
  const detailCard = detailId ? allCards.find(c => c.id === detailId) ?? null : null
  const showCutSpecials = filter === 'cut'
  const premiumCards = useMemo<Array<WalletCard & { category: PremiumCategory }>>(
    () => filterCards(allCards.filter(isPremiumCard), 'premium').filter(isPremiumCard),
    [allCards],
  )
  const visiblePremiumCards = filter === 'premium' ? premiumCards : []
  const walletCards = filter === 'premium' ? [] : cards

  function selectFilter(next: WalletFilter) {
    setFilter(next)
    setFeaturedId(null)
  }

  // BottomNavigation はモーダル表示中に隠す
  const anyModalOpen = !!detailCard || !!confirmItem || showMaintenanceQr || !!premiumReservationCard || !!premiumQrItem || !!cutReservationCoupon || !!cutReservationNotice || !!transferToken || !!xferError
  useEffect(() => { onModalChange?.(anyModalOpen) }, [anyModalOpen, onModalChange])
  useEffect(() => () => onModalChange?.(false), [onModalChange])

  const showPendingPremiumReservation = useCallback(() => {
    const pending = pendingPremiumCallRef.current
    if (!pending) return
    if (pending.timer !== null) window.clearTimeout(pending.timer)
    pendingPremiumCallRef.current = null
    setPremiumReservationCard(pending.card)
  }, [])

  const showPendingCutReservation = useCallback(() => {
    const pending = pendingCutCallRef.current
    if (!pending) return
    if (pending.timer !== null) window.clearTimeout(pending.timer)
    pendingCutCallRef.current = null
    setCutReservationCoupon(pending.coupon)
  }, [])

  useEffect(() => {
    const revealAfterReturn = () => {
      if (document.visibilityState !== 'visible') return
      showPendingPremiumReservation()
      showPendingCutReservation()
    }
    document.addEventListener('visibilitychange', revealAfterReturn)
    window.addEventListener('focus', revealAfterReturn)
    window.addEventListener('pageshow', revealAfterReturn)
    return () => {
      const pending = pendingPremiumCallRef.current
      if (pending && pending.timer !== null) window.clearTimeout(pending.timer)
      pendingPremiumCallRef.current = null
      const pendingCut = pendingCutCallRef.current
      if (pendingCut && pendingCut.timer !== null) window.clearTimeout(pendingCut.timer)
      pendingCutCallRef.current = null
      document.removeEventListener('visibilitychange', revealAfterReturn)
      window.removeEventListener('focus', revealAfterReturn)
      window.removeEventListener('pageshow', revealAfterReturn)
    }
  }, [showPendingPremiumReservation, showPendingCutReservation])

  // ── Actions ─────────────────────────────────────────────────────────────────

  function openTicketUseModal(ticket: TicketRow) {
    if (isWelcomeCouponBlockedToday(ticket, now)) return
    const issuedAt  = new Date()
    const expiresAt = new Date(issuedAt.getTime() + 30 * 60 * 1000)
    setDetailId(null)
    setConfirmItem({
      ticket,
      qrPayload: JSON.stringify({
        type: 'ginjiro-ticket-use',
        userId,
        selectedTicketId: ticket.id,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      }),
    })
  }

  function handlePremiumCallClick(card: PremiumCard) {
    if (!premium.isOpenNow) return
    setDetailId(null)
    const current = pendingPremiumCallRef.current
    if (current && current.timer !== null) window.clearTimeout(current.timer)
    pendingPremiumCallRef.current = {
      card,
      // Android Chrome / LINE内ブラウザ / PCなど、tel起動後にページが隠れない環境向けの保険。
      timer: window.setTimeout(showPendingPremiumReservation, 1500),
    }
  }

  function handleCutSpecialCallClick(coupon: CutSpecialCoupon) {
    setDetailId(null)
    const current = pendingCutCallRef.current
    if (current && current.timer !== null) window.clearTimeout(current.timer)
    pendingCutCallRef.current = {
      coupon,
      timer: window.setTimeout(showPendingCutReservation, 1500),
    }
  }

  /** 「はい、QR表示」：Specialクーポンと同じ予約保存（下タブQRの CURRENT RESERVATION に即時反映）→ 会計用QR */
  function confirmPremiumReservation(card: PremiumCard, visitDate: string) {
    const reservation = createReservation(card.id, visitDate)
    if (!reservation) return
    saveCurrentReservation(reservation)
    openPremiumQr(card)
  }

  function openPremiumQr(card: PremiumCard) {
    setPremiumReservationCard(null)
    setPremiumQrItem({
      card,
      qrPayload: buildPremiumQrPayload(card, userId, memberName),
    })
  }

  function confirmCutReservation(coupon: CutSpecialCoupon, visitDate: string) {
    // 価格・メニューはマスタから。予約日当日だけ有効（翌日以降は端末から自動で消える）
    const reservation = createReservation(coupon.id, visitDate)
    if (!reservation) return
    saveCurrentReservation(reservation)
    setCutReservationCoupon(null)
    setCutReservationNotice(reservation)
  }

  async function handleTransfer(ticket: TicketRow) {
    if (ticket.used || ticket.pending_transfer) return
    setXferring(true)
    setXferError(null)
    try {
      const token = await initiateTransfer(ticket.id)
      setDetailId(null)
      setTransferToken(token)
      setTransferTicket(ticket)
    } catch (err) {
      setDetailId(null)
      setXferError(err instanceof Error ? err.message : '渡す処理が失敗しました。')
    } finally {
      setXferring(false)
    }
  }

  async function handleCancelTransfer() {
    if (transferTicket) {
      try { await cancelTransfer(transferTicket.id) } catch { /* ignore */ }
    }
    setTransferToken(null)
    setTransferTicket(null)
    refreshTickets()
  }

  const transferUrl = transferToken ? `${window.location.origin}/claim-ticket?token=${transferToken}` : null

  async function handleShareTransfer() {
    if (!transferUrl) return
    try {
      if (navigator.share) {
        await navigator.share({ title: '銀二郎チケット', text: 'チケットを受け取ってください', url: transferUrl })
      } else {
        await navigator.clipboard.writeText(transferUrl)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    } catch {
      // Share cancellation and clipboard permission denial do not need user-facing errors.
    }
  }


  /** カード前面の小さな CTA */
  function renderCardCta(card: WalletCard): ReactNode {
    if (card.category === 'cut' && maintenance.isEligible) {
      return <MiniCta icon={<QrCode size={14} />} label="提示する" tone="gold" onClick={() => setShowMaintenanceQr(true)} />
    }
    if (isPremiumCard(card)) {
      return (
        <MiniCta
          icon={<Phone size={14} />}
          label={premium.isOpenNow ? '電話で予約' : '17時から受付'}
          tone={premium.isOpenNow ? 'premium' : 'quiet'}
          href={premium.isOpenNow ? SHOP_PHONE_TEL : undefined}
          disabled={!premium.isOpenNow}
          onClick={() => handlePremiumCallClick(card)}
        />
      )
    }
    if (card.category === 'otoku' && card.status === 'active') {
      const usable = usableTickets(card)
      if (usable.length === 0) return null
      if (isWelcomeCouponBlockedToday(usable[0], now)) {
        return <MiniCta label="平日のみ" tone="quiet" disabled />
      }
      return blockedToday(usable[0])
        ? <MiniCta label="本日は利用不可" tone="quiet" disabled />
        : <MiniCta label="使用する" tone="gold" onClick={() => openTicketUseModal(usable[0])} />
    }
    return null
  }

  /** 詳細シートの CTA */
  function renderSheetActions(card: WalletCard): ReactNode {
    if (card.category === 'cut') {
      if (maintenance.isEligible) {
        return (
          <>
            <PrimaryButton tone="gold" onClick={() => { setDetailId(null); setShowMaintenanceQr(true) }}>
              <QrCode size={16} /> クーポンQRを提示する
            </PrimaryButton>
            <SecondaryLink href={MAINTENANCE_CUT_URL} external>Webで予約する</SecondaryLink>
          </>
        )
      }
      if (maintenance.daysRemaining === null) {
        return (
          <p style={{ fontSize: 12, lineHeight: 1.7, color: 'rgba(242,230,200,0.62)', textAlign: 'center' }}>
            ご来店時に、画面下の中央QRボタンから男前パスポートを提示してください。<br />
            スタッフが読み取ると DAY 14 がスタートします。
          </p>
        )
      }
      return <SecondaryLink href={MAINTENANCE_CUT_URL} external>メンテナンスカットを予約する</SecondaryLink>
    }

    if (isPremiumCard(card)) {
      return (
        <>
          <PrimaryButton
            tone={premium.isOpenNow ? 'premium' : 'quiet'}
            href={premium.isOpenNow ? SHOP_PHONE_TEL : undefined}
            disabled={!premium.isOpenNow}
            onClick={() => handlePremiumCallClick(card)}
          >
            <Phone size={16} /> 電話で予約する
          </PrimaryButton>
          {!premium.isOpenNow && (
            <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.5)', textAlign: 'center' }}>
              {premium.label}{premium.hint ? `｜${premium.hint}` : ''}
            </p>
          )}
        </>
      )
    }

    // 漢トク券
    const usable = usableTickets(card)
    if (card.status !== 'active') {
      return <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.45)', textAlign: 'center' }}>{card.statusLabel}</p>
    }
    if (usable.length === 0) {
      return <p style={{ fontSize: 12, color: 'rgba(255,196,80,0.8)', textAlign: 'center' }}>譲渡手続き中のため使用できません</p>
    }
    if (isWelcomeCouponBlockedToday(usable[0], now)) {
      return (
        <>
          <PrimaryButton tone="quiet" disabled>
            平日のみ利用できます
          </PrimaryButton>
          <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.5)', textAlign: 'center', lineHeight: 1.6 }}>
            {WELCOME_COUPON_WEEKEND_MESSAGE}
          </p>
        </>
      )
    }
    return (
      <>
        <PrimaryButton tone="gold" disabled={blockedToday(usable[0])} onClick={() => openTicketUseModal(usable[0])}>
          {blockedToday(usable[0]) ? '本日は利用不可' : '使用する'}
        </PrimaryButton>
        {blockedToday(usable[0]) && (
          <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.5)', textAlign: 'center', lineHeight: 1.6 }}>
            本日は別の割引をご利用済みです（割引の併用は1日1種類まで）。
          </p>
        )}
        <button
          type="button"
          className="wallet-cta"
          disabled={xferring}
          onClick={() => void handleTransfer(usable[0])}
          style={{ minHeight: 40, background: 'none', border: 'none', fontSize: 12, letterSpacing: '0.12em', color: 'rgba(242,230,200,0.5)', cursor: 'pointer' }}
        >
          {xferring ? '準備中…' : '譲る'}
        </button>
      </>
    )
  }

  // ── Header summary（開いた瞬間に「今」が分かる一行） ───────────────────────

  const liveCards = allCards.filter(c => c.status === 'active' || c.status === 'urgent')
  const urgentCut = allCards.find(c => c.category === 'cut' && c.status === 'urgent')
  const summary = urgentCut
    ? { tone: 'crimson' as const, text: `メンテナンスカットの期限は${urgentCut.statusLabel.replace(/^あと/, 'あと ')}` }
    : liveCards.length > 0
      ? { tone: 'gold' as const, text: `今日使える特典が ${liveCards.length}件 あります` }
      : null
  const todayLabel = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric', weekday: 'short' }).format(now)
  const featuredLabel = filter === 'cut' ? 'メンテナンスカット' : '割引チケット'

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="ginjiro-luxury-bg" style={{ minHeight: '100%', overflowX: 'hidden' }}>
      <div className="relative z-10" style={{ paddingTop: 22, paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 48px)' }}>
        {/* Large title */}
        <header className="px-5">
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
            <p style={{ fontSize: 10, letterSpacing: '0.3em', color: 'rgba(201,162,74,0.62)', fontFamily: 'ui-monospace, monospace' }}>
              TICKET WALLET
            </p>
            <p style={{ fontSize: 12, letterSpacing: '0.06em', color: 'rgba(242,230,200,0.5)' }}>{todayLabel}</p>
          </div>
          <h1 style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 700, color: IVORY, letterSpacing: '0.04em', lineHeight: 1.25, marginTop: 4 }}>
            チケットウォレット
          </h1>
          {summary && (
            <p style={{
              marginTop: 6, fontSize: 14, letterSpacing: '0.03em',
              color: summary.tone === 'crimson' ? '#F2B2AA' : 'rgba(242,230,200,0.72)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ width: 6, height: 6, borderRadius: 99, flexShrink: 0, background: summary.tone === 'crimson' ? '#D0424C' : '#C9A24A' }} />
              {summary.text}
            </p>
          )}
        </header>

        {/* 以前のチケットの引き継ぎ：常設表示はせず、必要なときだけ小さなモーダルで案内 */}
        <PreviousTicketsPrompt onBound={() => { refreshTickets(); refreshVisit(); void refreshTodayUsed() }} />

        {/* Filter chips（選択枠がスライド） */}
        <LayoutGroup id="wallet-chips">
          <div className="wallet-chips" role="toolbar" aria-label="カードの絞り込み" style={{ marginTop: 12 }}>
            {WALLET_FILTERS.map(f => (
              <button key={f.id} type="button" className="wallet-chip" aria-label={f.label} aria-pressed={filter === f.id} onClick={() => selectFilter(f.id)}>
                {filter === f.id && (
                  <motion.span
                    layoutId="wallet-chip-pill"
                    className="wallet-chip-pill"
                    transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 38 }}
                  />
                )}
                <WalletFilterText filter={f.id} />
              </button>
            ))}
          </div>
        </LayoutGroup>

        {/* Wallet */}
        <div style={{ marginTop: 14 }}>
          {loading ? (
            <DeckSkeleton />
          ) : showCutSpecials ? (
            <CutSpecialCouponSection onCallClick={handleCutSpecialCallClick} />
          ) : cards.length === 0 ? (
            <EmptyState filter={filter} />
          ) : (
            <>
              {visiblePremiumCards.length > 0 && (
                <PremiumCouponSection
                  cards={visiblePremiumCards}
                  canCallNow={premium.isOpenNow}
                  onCallClick={handlePremiumCallClick}
                />
              )}
              {walletCards.length > 0 && (
                <div style={{ marginTop: visiblePremiumCards.length > 0 ? 24 : 0 }}>
                  <WalletStack
                    cards={walletCards}
                    featuredId={featuredId}
                    featuredLabel={visiblePremiumCards.length > 0 ? 'そのほかのカード' : featuredLabel}
                    onFeature={setFeaturedId}
                    onOpen={card => setDetailId(card.id)}
                    renderCta={renderCardCta}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── カード詳細 Bottom Sheet ── */}
      <AnimatePresence>
        {detailCard && (
          <WalletDetailSheet
            key={detailCard.id}
            card={detailCard}
            onClose={() => setDetailId(null)}
            actions={renderSheetActions(detailCard)}
          />
        )}
      </AnimatePresence>

      {/* ── チケット使用QRモーダル ── */}
      <AnimatePresence>
        {confirmItem && (
          <QrDialog
            eyebrow="USE TICKET"
            title={confirmItem.ticket.title}
            amount={confirmItem.ticket.amount}
            value={confirmItem.qrPayload}
            onClose={() => { setConfirmItem(null); refreshTickets(); void refreshTodayUsed() }}
          />
        )}
      </AnimatePresence>

      {/* ── メンテナンスクーポン QRモーダル ── */}
      <AnimatePresence>
        {showMaintenanceQr && (
          <MaintenanceCouponQrDialog
            onClose={() => { setShowMaintenanceQr(false); refreshVisit(); void refreshTodayUsed() }}
          />
        )}
      </AnimatePresence>

      {/* ── 漢前Premium 予約確認モーダル ── */}
      <AnimatePresence>
        {premiumReservationCard && (
          <PremiumReservationDialog
            card={premiumReservationCard}
            onNo={() => setPremiumReservationCard(null)}
            onYes={visitDate => confirmPremiumReservation(premiumReservationCard, visitDate)}
          />
        )}
      </AnimatePresence>

      {/* ── 漢前Premium 専用QRモーダル ── */}
      <AnimatePresence>
        {premiumQrItem && (
          <QrDialog
            eyebrow="PREMIUM COUPON"
            title={premiumQrItem.card.title}
            amount={premiumQrItem.card.prices[0]?.memberPrice}
            value={premiumQrItem.qrPayload}
            onClose={() => setPremiumQrItem(null)}
          />
        )}
      </AnimatePresence>

      {/* ── カットSpecial 予約確認モーダル ── */}
      <AnimatePresence>
        {cutReservationCoupon && (
          <CutReservationDialog
            coupon={cutReservationCoupon}
            onNo={() => setCutReservationCoupon(null)}
            onYes={visitDate => confirmCutReservation(cutReservationCoupon, visitDate)}
          />
        )}
      </AnimatePresence>

      {/* ── カットSpecial QR反映完了アナウンス ── */}
      <AnimatePresence>
        {cutReservationNotice && (
          <CutReservationNotice
            reservation={cutReservationNotice}
            onClose={() => setCutReservationNotice(null)}
          />
        )}
      </AnimatePresence>

      {/* ── 譲渡エラーモーダル ── */}
      <AnimatePresence>
        {xferError && (
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}
            onClick={() => setXferError(null)}
          >
            <motion.div
              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
              transition={{ duration: reduced ? 0 : 0.22 }}
              onClick={e => e.stopPropagation()}
              style={{ width: '100%', maxWidth: 380, borderRadius: 20, background: 'linear-gradient(160deg, #160A07 0%, #0A0504 100%)', border: '1px solid rgba(224,96,80,0.32)', padding: '24px 20px', textAlign: 'center' }}
            >
              <p style={{ fontSize: 20, marginBottom: 12, color: '#E06060' }}>✕</p>
              <p style={{ fontFamily: SERIF, fontSize: 14, fontWeight: 700, color: IVORY, marginBottom: 10, lineHeight: 1.7 }}>
                {xferError}
              </p>
              <button type="button" onClick={() => setXferError(null)}
                style={{ width: '100%', marginTop: 8, padding: '12px 0', borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', fontSize: 13, color: 'rgba(242,230,200,0.52)', fontFamily: SERIF, letterSpacing: '0.14em', cursor: 'pointer' }}>
                閉じる
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── 譲渡 QR モーダル ── */}
      <AnimatePresence>
        {transferUrl && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.90)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <motion.div
              initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.94 }}
              transition={{ duration: reduced ? 0 : 0.24 }}
              style={{ width: '100%', maxWidth: 360, borderRadius: 24, background: 'linear-gradient(160deg, #160A07 0%, #0A0504 100%)', border: '1px solid rgba(201,162,74,0.28)', padding: '24px 20px', textAlign: 'center' }}
            >
              <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: IVORY, marginBottom: 4 }}>
                {transferTicket?.title ?? ''}
              </p>
              <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.40)', marginBottom: 18, letterSpacing: '0.06em' }}>
                受け取りたい人にQRを見せてください
              </p>
              <div style={{ display: 'inline-block', padding: 14, background: '#FFFFFF', borderRadius: 14, marginBottom: 18 }}>
                <QRCodeSVG value={transferUrl} size={180} level="M" />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                <button type="button" onClick={handleShareTransfer} className="wallet-cta"
                  style={{ width: '100%', padding: '12px 0', borderRadius: 12, background: 'rgba(255,180,0,0.09)', border: '1px solid rgba(255,180,0,0.3)', fontSize: 12, fontWeight: 700, color: '#FFB400', fontFamily: SERIF, letterSpacing: '0.14em', cursor: 'pointer' }}>
                  {copied ? 'コピーしました' : 'リンクを送る'}
                </button>
                <button type="button" onClick={handleCancelTransfer} className="wallet-cta"
                  style={{ width: '100%', padding: '12px 0', borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.10)', fontSize: 12, color: 'rgba(242,230,200,0.44)', fontFamily: SERIF, letterSpacing: '0.14em', cursor: 'pointer' }}>
                  取りやめる
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Sub components ────────────────────────────────────────────────────────────

type CtaTone = 'gold' | 'premium' | 'quiet'

const CUT_SPECIAL_VISUALS = [
  {
    id: 'cut-teitei-special',
    title: 'テイテイSpecialクーポン',
    imageSrc: '/images/tickets/cut-teitei-special.jpg',
    alt: 'テイテイSpecialクーポン 天空の髪ピチュ フルコース 6,800円',
    menuLabel: '天空の髪ピチュ FULL COURSE',
    normalPrice: null,
    memberPrice: 6800,
    benefit: 'カット・ヘッドスパ・顔剃り・マッサージ',
  },
  {
    id: 'cut-ginjiro-special',
    title: '銀二郎Specialクーポン',
    imageSrc: '/images/tickets/cut-ginjiro-special.jpg',
    alt: '銀二郎Specialクーポン スキンフェードカット 顔剃り、シャンプー付き 4,000円',
    menuLabel: 'スキンフェードカット',
    normalPrice: 4500,
    memberPrice: 4000,
    benefit: '顔剃り・シャンプー付き',
  },
] as const

const PREMIUM_VISUALS: Record<PremiumCategory, { imageSrc: string; alt: string; tone: 'gold' | 'red' | 'silver' }> = {
  classic: {
    imageSrc: '/images/tickets/premium-classics-wide.png',
    alt: 'GINJIRO CLASSICS アイパー、パンチ、ニグロ、濡れパン 9,000円から8,000円',
    tone: 'gold',
  },
  special: {
    imageSrc: '/images/tickets/premium-special-perm-wide.png',
    alt: 'SPECIAL PERM ピンパーマ、ツイストパーマ 12,000円から10,000円',
    tone: 'red',
  },
  ginpara: {
    imageSrc: '/images/tickets/premium-ginpara-wide.png',
    alt: 'GINPARA 銀パラ 16,000円から15,000円',
    tone: 'silver',
  },
}

function CutSpecialCouponSection({ onCallClick }: { onCallClick: (coupon: CutSpecialCoupon) => void }) {
  return (
    <section className="wallet-cut-special-list" aria-label="カット Special クーポン">
      {CUT_SPECIAL_VISUALS.map(item => (
        <article key={item.id} className="wallet-cut-special">
          <h2 className="wallet-cut-special__title">{item.title}</h2>
          <a
            href={SHOP_PHONE_TEL}
            className="wallet-cut-special__image-wrap"
            aria-label={`${item.title}を電話で予約する`}
            onClick={() => onCallClick(item)}
          >
            <img src={item.imageSrc} alt={item.alt} loading="lazy" decoding="async" />
          </a>
        </article>
      ))}
    </section>
  )
}

function PremiumCouponSection({
  cards,
  canCallNow,
  onCallClick,
}: {
  cards: PremiumCard[]
  canCallNow: boolean
  onCallClick: (card: PremiumCard) => void
}) {
  return (
    <section className="wallet-premium-coupon-list" aria-label="漢前Premiumクーポン">
      {cards.map(card => (
        <PremiumCouponCard key={card.id} card={card} canCallNow={canCallNow} onCallClick={onCallClick} />
      ))}
    </section>
  )
}

function PremiumCouponCard({
  card,
  canCallNow,
  onCallClick,
}: {
  card: PremiumCard
  canCallNow: boolean
  onCallClick: (card: PremiumCard) => void
}) {
  const visual = PREMIUM_VISUALS[card.category]

  return (
    <a
      href={canCallNow ? SHOP_PHONE_TEL : undefined}
      className={`wallet-premium-image-card wallet-premium-image-card--${visual.tone}${canCallNow ? '' : ' wallet-premium-image-card--disabled'}`}
      aria-label={canCallNow ? `${card.title}を電話で予約する` : `${card.title}は土日祝17時から19時のみ電話予約できます`}
      aria-disabled={!canCallNow}
      onClick={(event) => {
        if (!canCallNow) {
          event.preventDefault()
          return
        }
        onCallClick(card)
      }}
    >
      <img src={visual.imageSrc} alt={visual.alt} loading="lazy" decoding="async" />
    </a>
  )
}

const CTA_STYLES: Record<CtaTone, { background: string; border: string; color: string; shadow: string }> = {
  gold: {
    background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
    border: 'rgba(201,162,74,0.55)',
    color: IVORY,
    shadow: '0 4px 18px rgba(107,15,18,0.45)',
  },
  premium: {
    background: 'linear-gradient(135deg, #F3D98A 0%, #C9A24A 55%, #9A7B1C 100%)',
    border: 'rgba(243,217,138,0.9)',
    color: '#1A0E04',
    shadow: '0 4px 20px rgba(201,162,74,0.35)',
  },
  quiet: {
    background: 'rgba(255,255,255,0.04)',
    border: 'rgba(242,230,200,0.22)',
    color: 'rgba(242,230,200,0.78)',
    shadow: 'none',
  },
}

function MiniCta({ label, icon, tone, onClick, href, disabled }: {
  label: string
  icon?: ReactNode
  tone: CtaTone
  onClick?: () => void
  href?: string
  disabled?: boolean
}) {
  const s = CTA_STYLES[tone]
  const style: React.CSSProperties = {
    flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', gap: 6,
    height: 40, padding: '0 16px', borderRadius: 999,
    background: s.background, border: `1px solid ${s.border}`, color: s.color,
    boxShadow: s.shadow,
    fontSize: 13.5, fontWeight: 700, letterSpacing: '0.08em', fontFamily: SERIF,
    textDecoration: 'none', whiteSpace: 'nowrap',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.55 : 1,
  }
  const stop = (e: React.KeyboardEvent) => e.stopPropagation()
  if (href && !disabled) {
    return (
      <a
        data-wallet-cta
        href={href}
        className="wallet-cta"
        style={style}
        onKeyDown={stop}
        onClick={e => { e.stopPropagation(); onClick?.() }}
      >
        {icon}{label}
      </a>
    )
  }
  return (
    <button data-wallet-cta type="button" className="wallet-cta" style={style} disabled={disabled} onKeyDown={stop}
      onClick={e => { e.stopPropagation(); onClick?.() }}>
      {icon}{label}
    </button>
  )
}

function PrimaryButton({ children, tone, onClick, href, disabled }: {
  children: ReactNode
  tone: CtaTone
  onClick?: () => void
  href?: string
  disabled?: boolean
}) {
  const s = CTA_STYLES[disabled ? 'quiet' : tone]
  const style: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    width: '100%', minHeight: 52, borderRadius: 14,
    background: s.background, border: `1px solid ${s.border}`, color: s.color,
    boxShadow: s.shadow,
    fontSize: 15, fontWeight: 700, letterSpacing: '0.16em', fontFamily: SERIF,
    textDecoration: 'none',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  }
  if (href && !disabled) return <a href={href} className="wallet-cta" style={style} onClick={() => onClick?.()}>{children}</a>
  return <button type="button" className="wallet-cta" style={style} disabled={disabled} onClick={onClick}>{children}</button>
}

function SecondaryLink({ href, children, external }: { href: string; children: ReactNode; external?: boolean }) {
  return (
    <a
      href={href}
      className="wallet-cta"
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: 44, borderRadius: 12,
        border: '1px solid rgba(242,230,200,0.14)', background: 'rgba(255,255,255,0.02)',
        fontSize: 13, letterSpacing: '0.12em', color: 'rgba(242,230,200,0.72)', fontFamily: SERIF,
        textDecoration: 'none',
      }}
    >
      {children}
    </a>
  )
}

function QrDialog({ eyebrow, title, amount, value, onClose }: {
  eyebrow: string
  title: string
  amount?: number
  value: string
  onClose: () => void
}) {
  const reduced = useReducedMotion() ?? false
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.90)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.94 }}
        transition={{ duration: reduced ? 0 : 0.24 }}
        onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 360, borderRadius: 24, background: 'linear-gradient(160deg, #160A07 0%, #0A0504 100%)', border: '1px solid rgba(201,162,74,0.28)', boxShadow: '0 24px 64px rgba(0,0,0,0.88)', padding: '28px 24px 24px', textAlign: 'center' }}
      >
        <p style={{ fontSize: 9, letterSpacing: '0.28em', color: 'rgba(201,162,74,0.55)', marginBottom: 10 }}>{eyebrow}</p>
        <p style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: IVORY, lineHeight: 1.4, marginBottom: amount ? 4 : 16 }}>{title}</p>
        {!!amount && amount > 0 && (
          <p style={{ fontFamily: SERIF, fontSize: 24, fontWeight: 700, color: '#C9A24A', marginBottom: 16 }}>¥{amount.toLocaleString()}</p>
        )}
        <div style={{ display: 'inline-block', padding: 14, background: '#FFFFFF', borderRadius: 14, boxShadow: '0 8px 32px rgba(0,0,0,0.55)', marginBottom: 16 }}>
          <QRCodeSVG value={value} size={188} level="M" />
        </div>
        <p style={{ fontSize: 13, color: 'rgba(242,230,200,0.70)', lineHeight: 1.75, marginBottom: 20 }}>
          このQRをスタッフに提示してください。<br />
          使用確定は店舗端末でのみ行われます。
        </p>
        <button type="button" onClick={onClose} className="wallet-cta"
          style={{ width: '100%', padding: '13px 0', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', fontSize: 13, color: 'rgba(242,230,200,0.60)', fontFamily: SERIF, letterSpacing: '0.14em', cursor: 'pointer' }}>
          閉じる
        </button>
      </motion.div>
    </div>
  )
}

const COUPON_TOKEN_ERRORS: Record<string, string> = {
  no_visit:   '来店記録がないため、まだご利用いただけません。',
  expired:    '前回来店から14日を過ぎたため、ご利用期限が終了しました。',
  used_today: '本日はすでに割引・クーポンをご利用済みです。',
  customer_auth_required: 'クーポンQRの表示には、以前のチケットの引き継ぎが必要です。',
}

/**
 * メンテナンスクーポンQR（5分有効・使い捨て）。
 * 表示するたびにサーバーで新しいトークンを発行し（前のQRは無効化）、期限が近づくと自動更新する。
 */
function MaintenanceCouponQrDialog({ onClose }: { onClose: () => void }) {
  const reduced = useReducedMotion() ?? false
  const [token, setToken] = useState<{ value: string; expiresAt: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const issue = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // 本人はサーバーが顧客セッションから特定する（user_id は送らない）
      const r = await callCustomerRpc<{ token: string; expires_at: string }>('customer_issue_maintenance_coupon')
      setToken({ value: r.token, expiresAt: new Date(r.expires_at).getTime() })
    } catch (err) {
      setToken(null)
      setError(err instanceof RpcError && COUPON_TOKEN_ERRORS[err.code]
        ? COUPON_TOKEN_ERRORS[err.code]
        : '通信できませんでした。電波の良い場所でもう一度お試しください。')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void issue() }, [issue]) // eslint-disable-line react-hooks/set-state-in-effect
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  const secondsLeft = token ? Math.max(0, Math.floor((token.expiresAt - nowMs) / 1000)) : 0
  // 期限の10秒前に自動で新しいQRへ更新
  useEffect(() => {
    if (token && !loading && secondsLeft <= 10) void issue() // eslint-disable-line react-hooks/set-state-in-effect
  }, [token, loading, secondsLeft, issue])

  const qrValue = token ? JSON.stringify({ type: 'ginjiro-maintenance-coupon', v: 2, token: token.value }) : ''
  const mm = Math.floor(secondsLeft / 60)
  const ss = String(secondsLeft % 60).padStart(2, '0')

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.90)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="銀二郎Only メンテナンスカット クーポンQR"
        initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.94 }}
        transition={{ duration: reduced ? 0 : 0.24 }}
        onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 360, borderRadius: 24, background: 'linear-gradient(160deg, #160A07 0%, #0A0504 100%)', border: '1px solid rgba(201,162,74,0.28)', boxShadow: '0 24px 64px rgba(0,0,0,0.88)', padding: '28px 24px 24px', textAlign: 'center' }}
      >
        <p style={{ fontSize: 10, letterSpacing: '0.28em', color: 'rgba(201,162,74,0.62)', marginBottom: 10 }}>MAINTENANCE COUPON</p>
        <p style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: IVORY, lineHeight: 1.4, marginBottom: 4 }}>銀二郎Only メンテナンスカット</p>
        <p style={{ fontFamily: SERIF, marginBottom: 16, display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, color: 'rgba(242,230,200,0.45)', textDecoration: 'line-through' }}>¥3,000</span>
          <span style={{ fontSize: 24, fontWeight: 700, color: '#C9A24A' }}>¥2,500</span>
          <span style={{ fontSize: 12, color: 'rgba(242,230,200,0.6)' }}>担当：銀二郎</span>
        </p>

        <div style={{ width: 216, height: 216, margin: '0 auto 14px', padding: 14, background: '#FFFFFF', borderRadius: 14, boxShadow: '0 8px 32px rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' }}>
          {token && !error
            ? <QRCodeSVG value={qrValue} size={188} level="M" />
            : <p style={{ fontSize: 12, color: '#555', lineHeight: 1.7 }}>{loading ? 'QRを準備しています…' : 'QRを表示できません'}</p>}
        </div>

        {error ? (
          <p style={{ fontSize: 13, color: '#F0A8A0', lineHeight: 1.7, marginBottom: 16 }}>{error}</p>
        ) : (
          <p style={{ fontSize: 13, color: 'rgba(242,230,200,0.75)', lineHeight: 1.75, marginBottom: 16 }}>
            このQRをスタッフに提示してください。<br />
            <span style={{ fontSize: 12, color: 'rgba(242,230,200,0.55)' }}>
              1回限り有効・{token ? `残り ${mm}:${ss}（自動で更新されます）` : '5分間有効'}
            </span>
          </p>
        )}

        {error && (
          <button type="button" onClick={() => { void issue() }} className="wallet-cta"
            style={{ width: '100%', padding: '12px 0', marginBottom: 10, borderRadius: 14, background: 'rgba(201,162,74,0.12)', border: '1px solid rgba(201,162,74,0.4)', fontSize: 13, fontWeight: 700, color: IVORY, fontFamily: SERIF, letterSpacing: '0.12em', cursor: 'pointer' }}>
            もう一度表示する
          </button>
        )}
        <button type="button" onClick={onClose} className="wallet-cta"
          style={{ width: '100%', padding: '13px 0', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', fontSize: 13, color: 'rgba(242,230,200,0.60)', fontFamily: SERIF, letterSpacing: '0.14em', cursor: 'pointer' }}>
          閉じる
        </button>
      </motion.div>
    </div>
  )
}

/** 予約日（今日〜RESERVATION_MAX_DAYS_AHEAD 日後）。Specialクーポン・漢前Premium 共通 */
function useReservationDate() {
  const today = getJapanDateString()
  const maxDate = addDaysToDateString(today, RESERVATION_MAX_DAYS_AHEAD)
  const [visitDate, setVisitDate] = useState(today)
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(visitDate) && visitDate >= today && visitDate <= maxDate
  return { today, maxDate, visitDate, setVisitDate, validDate }
}

function ReservationDateField({ value, min, max, onChange }: { value: string; min: string; max: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: 'block', textAlign: 'left', marginBottom: 18 }}>
      <span style={{ display: 'block', fontSize: 11, letterSpacing: '0.12em', color: 'rgba(242,230,200,0.6)', marginBottom: 6 }}>
        ご予約日（この日だけ有効）
      </span>
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={e => onChange(e.target.value)}
        aria-label="ご予約日"
        style={{
          width: '100%', height: 46, borderRadius: 12, padding: '0 12px', colorScheme: 'dark',
          background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(201,162,74,0.35)', color: IVORY,
          fontFamily: SERIF, fontSize: 15, outline: 'none',
        }}
      />
    </label>
  )
}

function PremiumReservationDialog({ card, onYes, onNo }: {
  card: PremiumCard
  onYes: (visitDate: string) => void
  onNo: () => void
}) {
  const reduced = useReducedMotion() ?? false
  const price = card.prices[0]
  const { today, maxDate, visitDate, setVisitDate, validDate } = useReservationDate()
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}
      onClick={onNo}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="予約済み確認"
        initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.94 }}
        transition={{ duration: reduced ? 0 : 0.22 }}
        onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 372, borderRadius: 24, background: 'linear-gradient(160deg, #180806 0%, #080404 100%)', border: '1px solid rgba(201,162,74,0.36)', boxShadow: '0 24px 64px rgba(0,0,0,0.86)', padding: '26px 22px 22px', textAlign: 'center' }}
      >
        <p style={{ fontSize: 9, letterSpacing: '0.28em', color: 'rgba(201,162,74,0.58)', marginBottom: 10 }}>PHONE RESERVATION</p>
        <p style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: IVORY, lineHeight: 1.45, marginBottom: 8 }}>
          予約済みですか？
        </p>
        <p style={{ fontSize: 13, color: 'rgba(242,230,200,0.68)', lineHeight: 1.75, marginBottom: 14 }}>
          電話予約が完了した場合のみ、<br />
          店舗会計用のQRを表示します。
        </p>
        <div style={{ borderRadius: 16, background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(201,162,74,0.18)', padding: '14px 14px 13px', marginBottom: 18, textAlign: 'left' }}>
          <p style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 700, color: IVORY, marginBottom: 5 }}>{card.title}</p>
          <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.6)', lineHeight: 1.6, marginBottom: 8 }}>{price?.label ?? card.subtitle}</p>
          <p style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            {price?.normalPrice !== undefined && (
              <span style={{ fontSize: 13, color: 'rgba(242,230,200,0.38)', textDecoration: 'line-through' }}>
                ¥{price.normalPrice.toLocaleString()}
              </span>
            )}
            <span style={{ fontFamily: SERIF, fontSize: 28, fontWeight: 700, color: '#C9A24A', lineHeight: 1 }}>
              ¥{(price?.memberPrice ?? 0).toLocaleString()}
            </span>
          </p>
          <p style={{ marginTop: 8, fontSize: 11, color: 'rgba(242,230,200,0.52)', lineHeight: 1.5 }}>
            スキンフェード＋顔剃り込み / 店舗端末専用
          </p>
        </div>
        <ReservationDateField value={visitDate} min={today} max={maxDate} onChange={setVisitDate} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.35fr', gap: 10 }}>
          <button
            type="button"
            onClick={onNo}
            className="wallet-cta"
            style={{ minHeight: 52, borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', color: 'rgba(242,230,200,0.62)', fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.12em', cursor: 'pointer' }}
          >
            いいえ
          </button>
          <button
            type="button"
            onClick={() => { if (validDate) onYes(visitDate) }}
            disabled={!validDate}
            className="wallet-cta"
            style={{ minHeight: 52, borderRadius: 14, background: 'linear-gradient(135deg, #F3D98A 0%, #C9A24A 58%, #8B691A 100%)', border: '1px solid rgba(243,217,138,0.9)', boxShadow: '0 4px 22px rgba(201,162,74,0.36)', color: '#170C03', fontFamily: SERIF, fontSize: 13, fontWeight: 800, letterSpacing: '0.10em', cursor: validDate ? 'pointer' : 'default', opacity: validDate ? 1 : 0.55 }}
          >
            はい、QR表示
          </button>
        </div>
      </motion.div>
    </div>
  )
}

function formatVisitDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const weekday = ['日', '月', '火', '水', '木', '金', '土'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${m}月${d}日（${weekday}）`
}

function CutReservationDialog({ coupon, onYes, onNo }: {
  coupon: CutSpecialCoupon
  onYes: (visitDate: string) => void
  onNo: () => void
}) {
  const reduced = useReducedMotion() ?? false
  const { today, maxDate, visitDate, setVisitDate, validDate } = useReservationDate()
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}
      onClick={onNo}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="予約済み確認"
        initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.94 }}
        transition={{ duration: reduced ? 0 : 0.22 }}
        onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 372, borderRadius: 24, background: 'linear-gradient(160deg, #180806 0%, #080404 100%)', border: '1px solid rgba(201,162,74,0.36)', boxShadow: '0 24px 64px rgba(0,0,0,0.86)', padding: '26px 22px 22px', textAlign: 'center' }}
      >
        <p style={{ fontSize: 9, letterSpacing: '0.28em', color: 'rgba(201,162,74,0.58)', marginBottom: 10 }}>PHONE RESERVATION</p>
        <p style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: IVORY, lineHeight: 1.45, marginBottom: 8 }}>
          予約済みですか？
        </p>
        <p style={{ fontSize: 13, color: 'rgba(242,230,200,0.68)', lineHeight: 1.75, marginBottom: 14 }}>
          電話予約が完了した場合のみ、<br />
          下タブのQRへ現在の予約状況を反映します。
        </p>
        <div style={{ borderRadius: 16, background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(201,162,74,0.18)', padding: '14px 14px 13px', marginBottom: 18, textAlign: 'left' }}>
          <p style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 700, color: IVORY, marginBottom: 5 }}>{coupon.title}</p>
          <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.6)', lineHeight: 1.6, marginBottom: 8 }}>{coupon.menuLabel}</p>
          <p style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            {typeof coupon.normalPrice === 'number' && (
              <span style={{ fontSize: 13, color: 'rgba(242,230,200,0.38)', textDecoration: 'line-through' }}>
                ¥{coupon.normalPrice.toLocaleString()}
              </span>
            )}
            <span style={{ fontFamily: SERIF, fontSize: 28, fontWeight: 700, color: '#C9A24A', lineHeight: 1 }}>
              ¥{coupon.memberPrice.toLocaleString()}
            </span>
          </p>
          <p style={{ marginTop: 8, fontSize: 11, color: 'rgba(242,230,200,0.52)', lineHeight: 1.5 }}>
            {coupon.benefit} / 電話予約済み
          </p>
        </div>
        <ReservationDateField value={visitDate} min={today} max={maxDate} onChange={setVisitDate} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.35fr', gap: 10 }}>
          <button
            type="button"
            onClick={onNo}
            className="wallet-cta"
            style={{ minHeight: 52, borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', color: 'rgba(242,230,200,0.62)', fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.12em', cursor: 'pointer' }}
          >
            いいえ
          </button>
          <button
            type="button"
            onClick={() => { if (validDate) onYes(visitDate) }}
            disabled={!validDate}
            className="wallet-cta"
            style={{ minHeight: 52, borderRadius: 14, background: 'linear-gradient(135deg, #F3D98A 0%, #C9A24A 58%, #8B691A 100%)', border: '1px solid rgba(243,217,138,0.9)', boxShadow: '0 4px 22px rgba(201,162,74,0.36)', color: '#170C03', fontFamily: SERIF, fontSize: 13, fontWeight: 800, letterSpacing: '0.10em', cursor: validDate ? 'pointer' : 'default', opacity: validDate ? 1 : 0.55 }}
          >
            はい、QRに反映
          </button>
        </div>
      </motion.div>
    </div>
  )
}

function CutReservationNotice({ reservation, onClose }: {
  reservation: CurrentReservation
  onClose: () => void
}) {
  const reduced = useReducedMotion() ?? false
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="QR反映完了"
        initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.94 }}
        transition={{ duration: reduced ? 0 : 0.22 }}
        onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 372, borderRadius: 24, background: 'linear-gradient(160deg, #150706 0%, #070303 100%)', border: '1px solid rgba(201,162,74,0.34)', boxShadow: '0 24px 64px rgba(0,0,0,0.86)', padding: '28px 22px 22px', textAlign: 'center' }}
      >
        <p style={{ fontSize: 9, letterSpacing: '0.28em', color: 'rgba(201,162,74,0.62)', marginBottom: 12 }}>RESERVATION UPDATED</p>
        <p style={{ fontFamily: SERIF, fontSize: 21, fontWeight: 700, color: IVORY, lineHeight: 1.5, marginBottom: 10 }}>
          下タブのQRへ反映しました
        </p>
        <p style={{ fontSize: 13, color: 'rgba(242,230,200,0.70)', lineHeight: 1.85, marginBottom: 16 }}>
          お会計時は下タブ中央のQRコードを開き、<br />
          従業員にお見せください。
        </p>
        <div style={{ borderRadius: 16, background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(201,162,74,0.18)', padding: '14px 14px 13px', marginBottom: 18, textAlign: 'left' }}>
          <p style={{ fontSize: 11, letterSpacing: '0.1em', color: '#C9A24A', marginBottom: 6 }}>ご予約日 {formatVisitDate(reservation.visitDate)}・当日のみ有効</p>
          <p style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 700, color: IVORY, marginBottom: 5 }}>{reservation.title}</p>
          <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.62)', lineHeight: 1.6, marginBottom: 8 }}>{reservation.menuLabel}</p>
          <p style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            {typeof reservation.normalPrice === 'number' && (
              <span style={{ fontSize: 13, color: 'rgba(242,230,200,0.38)', textDecoration: 'line-through' }}>
                ¥{reservation.normalPrice.toLocaleString()}
              </span>
            )}
            <span style={{ fontFamily: SERIF, fontSize: 27, fontWeight: 700, color: '#C9A24A', lineHeight: 1 }}>
              ¥{reservation.memberPrice.toLocaleString()}
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="wallet-cta"
          style={{ width: '100%', minHeight: 52, borderRadius: 14, background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)', border: '1px solid rgba(201,162,74,0.44)', boxShadow: '0 4px 22px rgba(107,15,18,0.40)', color: IVORY, fontFamily: SERIF, fontSize: 14, fontWeight: 800, letterSpacing: '0.14em', cursor: 'pointer' }}
        >
          OK
        </button>
      </motion.div>
    </div>
  )
}

function DeckSkeleton() {
  const block: React.CSSProperties = {
    borderRadius: 24, background: 'linear-gradient(158deg, #15100E 0%, #0B0807 100%)',
    border: '1px solid rgba(201,162,74,0.08)',
  }
  return (
    <div aria-hidden="true" style={{ margin: '0 16px', paddingTop: 30 }}>
      <div style={{ ...block, height: CARD_HEIGHT }} />
      <div style={{ ...block, height: CARD_STRIP, marginTop: 50, opacity: 0.6 }} />
      <div style={{ ...block, height: CARD_STRIP, marginTop: -8, opacity: 0.35 }} />
    </div>
  )
}

function EmptyState({ filter }: { filter: WalletFilter }) {
  const label = filter === 'cut'
    ? 'メンテナンスカット'
    : filter === 'premium'
      ? '漢前Premiumパーマ'
      : '割引チケット'
  return (
    <div style={{
      margin: '0 16px', height: CARD_HEIGHT,
      borderRadius: 24,
      border: '1px dashed rgba(201,162,74,0.22)',
      background: 'radial-gradient(80% 60% at 50% 0%, rgba(201,162,74,0.05) 0%, transparent 70%), rgba(255,255,255,0.012)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '0 28px', textAlign: 'center',
    }}>
      <span style={{ width: 28, height: 1, background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.6), transparent)', marginBottom: 18 }} />
      <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: 'rgba(242,230,200,0.82)', letterSpacing: '0.08em' }}>
        {label}はありません
      </p>
      <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.46)', lineHeight: 1.8, marginTop: 10 }}>
        来店すると新しい特典が<br />追加されることがあります。
      </p>
      <span style={{ width: 28, height: 1, background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.6), transparent)', marginTop: 18 }} />
    </div>
  )
}
