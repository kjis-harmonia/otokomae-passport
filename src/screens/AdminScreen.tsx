import { useState, useRef, useCallback, useEffect } from 'react'
import { Html5Qrcode } from 'html5-qrcode'
import { getStoredValue, setStoredValue } from '../utils/storage'
import type { TicketRow, TicketType } from '../data/ticket'
import { TICKET_TYPE_LABELS, TICKET_TYPE_COLORS } from '../data/ticket'
import { issueTickets, getTicketsForStaff, redeemTickets } from '../utils/ticketStore'
import {
  registerCustomerWithContext, searchCustomersByName, recoverMember,
  getCustomerContextForStaff, issueBindCode,
} from '../utils/customerStore'
import { callStaffRpc, rpcErrorMessage, RpcError } from '../utils/staffSession'
import type { CustomerRow } from '../utils/customerStore'
import { isWelcomeCouponBlockedToday, WELCOME_COUPON_WEEKEND_MESSAGE } from '../utils/welcomeCoupon'
import { isStaging } from '../utils/env'
import { StgBadge } from '../components/StgBadge'
import { normalizeCurrentReservation, isReservationForDate, type CurrentReservation } from '../utils/currentReservation'
import { PREMIUM_COUPONS } from '../data/wallet'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const STAFF_NAME_KEY        = 'ginjiro_staff_name'
const STAFF_NAMES  = ['テイテイ', 'ヨンピル', '銀二郎', 'シルビア', 'リアン', 'キャンディ', 'ヒョウ']
const MAX_QTY      = 30
const QTY_PRESETS  = [1, 2, 3, 5, 10, 30]
const DISCOUNT_AMOUNT_PRESETS = [100, 500, 1000]

const TICKET_TABS: { type: TicketType; label: string; autoTitle: string }[] = [
  { type: 'discount', label: '割引券',   autoTitle: '割引券' },
  { type: 'otoku',    label: '漢トク券', autoTitle: '漢トク券' },
]

// ── 当日の割引利用状況 ────────────────────────────────────────────────────────

/**
 * usedType（当日すでに使用済みの割引種別。未使用ならnull）に対して、
 * attemptedType（これから使おうとしている割引種別）が使用可能か判定する。
 */
export function canUseDiscountType(usedType: string | null, attemptedType: string): boolean {
  if (usedType === null) return true
  if (usedType !== attemptedType) return false // 異なる割引種別の併用は不可（1日どれか一つ）
  return attemptedType !== 'coupon' // メンテナンスクーポンのみ1日1回。漢トク券・割引券は同種なら複数枚可
}

const DISCOUNT_TYPE_LABEL: Record<string, string> = {
  otoku: '漢トク券',
  discount: '割引券',
  coupon: 'メンテナンスクーポン',
}

// ── Sound ─────────────────────────────────────────────────────────────────────

export function playSuccessSound() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator(); const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    osc.type = 'sine'; osc.frequency.value = 880
    gain.gain.setValueAtTime(0.35, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5)
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.5)
    setTimeout(() => ctx.close(), 700)
  } catch { /* AudioContext unavailable */ }
}

function playWarningSound() {
  try {
    const ctx = new AudioContext()
    ;[0, 0.22, 0.44].forEach(offset => {
      const osc = ctx.createOscillator(); const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = 'square'; osc.frequency.value = 440
      gain.gain.setValueAtTime(0.25, ctx.currentTime + offset)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.16)
      osc.start(ctx.currentTime + offset); osc.stop(ctx.currentTime + offset + 0.16)
    })
    setTimeout(() => ctx.close(), 900)
  } catch { /* AudioContext unavailable */ }
}

// ── 来店日 / メンテナンスクーポン（サーバー RPC） ───────────────────────────────

/** 最終来店日（YYYY-MM-DD / 記録なし null）。通信失敗は例外。 */
async function fetchLastVisitDate(userId: string): Promise<string | null> {
  return (await getCustomerContextForStaff(userId)).last_visit_date
}

/** 来店チェックイン（来店日＝本日JST）。staff_check_in RPC。失敗時は例外。 */
export async function checkInVisit(userId: string): Promise<string> {
  const r = await callStaffRpc<{ visit_date: string }>('staff_check_in', { p_user_id: userId })
  return String(r.visit_date).slice(0, 10)
}

export interface MaintenanceCouponPreview {
  valid:          boolean
  reason:         string | null
  user_id:        string
  customer_name:  string | null
  days_remaining: number | null
  qr_expires_at:  string
  menu:           { name: string; stylist: string; normal_price: number; member_price: number }
}

/** メンテナンスクーポンQRの確認（消費しない）。通信失敗は例外。 */
export async function previewMaintenanceCoupon(token: string): Promise<MaintenanceCouponPreview> {
  return callStaffRpc<MaintenanceCouponPreview>('staff_preview_maintenance_coupon', { p_token: token })
}

/**
 * メンテナンスクーポンの使用確定（サーバー側で 5分有効・未使用・14日以内・当日ルールを再検証し、
 * トークン消費・使用ログ・来店日更新を1トランザクションで行う）。失敗時は RpcError。
 */
export async function redeemMaintenanceCoupon(token: string, staffName: string): Promise<{ user_id: string; customer_name: string | null }> {
  return callStaffRpc('staff_redeem_maintenance_coupon', { p_token: token, p_staff_name: staffName })
}

/** 旧形式（userId のみ・トークン無し）のクーポンQR */
export function isLegacyMaintenanceQr(d: MaintenanceCouponQRData): boolean {
  return !d.token
}

export const LEGACY_MAINTENANCE_QR_MESSAGE =
  '旧形式のクーポンQRです。お客様にアプリを最新にしてクーポンQRを再表示してもらってください。'

// ── Utilities ─────────────────────────────────────────────────────────────────


function daysSince(dateStr: string): number {
  const base = new Date(dateStr); base.setHours(0, 0, 0, 0)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return Math.floor((today.getTime() - base.getTime()) / 86_400_000)
}

/** YYYY-MM-DD → YYYY / MM / DD */
function fmtVisitDate(iso: string): string {
  const p = iso.split('-')
  return p.length === 3 ? `${p[0]} / ${p[1]} / ${p[2]}` : iso
}

function fmtCreatedAt(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

// ── QR payload ────────────────────────────────────────────────────────────────

export interface PassportQRData {
  type: string
  userId: string
  name: string
  reservation?: CurrentReservation | null
}

export interface TicketUseQRData {
  type: 'ginjiro-ticket-use'
  userId: string
  selectedTicketId: string
  issuedAt: string
  expiresAt: string
}

export interface MaintenanceCouponQRData {
  type: 'ginjiro-maintenance-coupon'
  /** v2: サーバー発行の使い捨てトークン（5分有効） */
  v?: number
  token?: string
  /** 旧形式（v1）のみ。v2 では含まれない */
  userId?: string
  name?: string
}

export interface PremiumCouponQRData {
  type: 'ginjiro-premium-coupon'
  userId: string
  name: string
  couponId: string
  category: 'classic' | 'special' | 'ginpara'
  title: string
  menuLabel: string
  normalPrice?: number | null
  memberPrice: number
  issuedAt?: string
  expiresAt?: string
}

export type AnyQRData = PassportQRData | TicketUseQRData | MaintenanceCouponQRData | PremiumCouponQRData

export function isQrPayloadExpired(expiresAt?: string): boolean {
  if (!expiresAt) return false
  const expiry = new Date(expiresAt)
  if (Number.isNaN(expiry.getTime())) return true
  return new Date() > expiry
}

export function parseQR(text: string): AnyQRData | null {
  try {
    const d = JSON.parse(text)
    if (d.type === 'ginjiro-ticket-use' && d.userId && d.selectedTicketId) return d as TicketUseQRData
    if (d.type === 'ginjiro-maintenance-coupon' && (d.token || d.userId)) return d as MaintenanceCouponQRData
    if (d.type === 'ginjiro-premium-coupon' && d.userId && d.couponId) {
      // QR からは会員・クーポンID・期限だけを使い、メニュー名・価格は店舗側のマスタから復元する（QR内の価格は使わない）
      const def = PREMIUM_COUPONS.find(c => c.id === d.couponId)
      const price = def?.prices[0]
      if (!def || !price || (def.category !== 'classic' && def.category !== 'special' && def.category !== 'ginpara')) return null
      return {
        type: 'ginjiro-premium-coupon',
        userId: String(d.userId),
        name: typeof d.name === 'string' && d.name ? d.name : '名前未設定',
        couponId: def.id,
        category: def.category,
        title: def.title,
        menuLabel: price.label ?? def.subtitle ?? def.title,
        normalPrice: price.normalPrice ?? null,
        memberPrice: price.memberPrice,
        issuedAt: typeof d.issuedAt === 'string' ? d.issuedAt : undefined,
        expiresAt: typeof d.expiresAt === 'string' ? d.expiresAt : undefined,
      }
    }
    if ((d.type === 'ginjiro-member' || d.type === 'otokomae-passport') && d.userId) {
      return {
        type: d.type,
        userId: d.userId,
        name: d.name || '名前未設定',
        reservation: normalizeCurrentReservation(d.reservation),
      }
    }
    return null
  } catch { return null }
}

// ── Phase ─────────────────────────────────────────────────────────────────────

type Phase = 'scan' | 'loading' | 'result' | 'ticket-loading' | 'ticket-result' | 'maintenance-coupon' | 'premium-coupon'

// ── QR Camera Scanner ─────────────────────────────────────────────────────────

const QR_EL_ID          = 'gj-qr-reader'
const QR_RECOVERY_EL_ID = 'gj-qr-reader-recovery'

async function haltScanner(scanner: Html5Qrcode): Promise<void> {
  try { if (scanner.isScanning) await scanner.stop(); scanner.clear() } catch { /* ignore */ }
}

// 読み取り中の白い四隅ガイドは html5-qrcode が qrbox 設定に合わせて自前で描画する
// （Constants.BORDER_SHADER_DEFAULT_COLOR = "#ffffff"）。自前のオーバーレイを重ねると
// 二重表示になるため、ここでは追加しない。

export function QrCameraScanner({
  onScan,
  onCameraError,
  elId = QR_EL_ID,
  placeholder,
  boxHeight = 280,
  onActiveChange,
}: {
  onScan: (t: string) => void
  onCameraError: (m: string) => void
  elId?: string
  /**
   * 指定すると、読み取り前はこの内容をカメラ枠と同じボックス内に表示し、読み取り中は
   * 白い四隅のスキャンガイドをカメラ映像に重ねて表示する（枠を1つに統合するモード）。
   * 未指定の場合は従来通り、非アクティブ時は高さ0（カメラ枠を表示しない）。
   */
  placeholder?: React.ReactNode
  boxHeight?: number
  onActiveChange?: (active: boolean) => void
}) {
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const [active, setActive] = useState(false)

  function claimScanner(): Html5Qrcode | null {
    const s = scannerRef.current; scannerRef.current = null; return s
  }

  const setActiveState = useCallback((next: boolean) => {
    setActive(next)
    onActiveChange?.(next)
  }, [onActiveChange])

  const stop = useCallback(() => {
    const s = claimScanner(); if (!s) return
    setActiveState(false); void haltScanner(s)
  }, [setActiveState]) // eslint-disable-line react-hooks/exhaustive-deps

  const start = useCallback(async () => {
    if (scannerRef.current) return
    let scanner: Html5Qrcode
    try { scanner = new Html5Qrcode(elId) }
    catch { onCameraError('カメラを初期化できません。'); return }
    scannerRef.current = scanner
    try {
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (decoded) => {
          const s = claimScanner(); if (!s) return
          setActiveState(false); void haltScanner(s).then(() => onScan(decoded))
        },
        undefined,
      )
      setActiveState(true)
    } catch {
      const s = claimScanner(); if (s) void haltScanner(s)
      onCameraError('カメラにアクセスできません。手動入力をご利用ください。')
    }
  }, [onScan, onCameraError, elId, setActiveState]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { const s = claimScanner(); if (s) void haltScanner(s) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const showBox = placeholder ? true : active

  return (
    <div>
      <div style={{
        position: 'relative', width: '100%',
        minHeight: showBox ? boxHeight : 0,
        borderRadius: showBox ? 16 : 0,
        overflow: 'hidden',
        marginBottom: showBox ? 12 : 0,
        background: placeholder ? '#0A0504' : 'transparent',
        border: placeholder ? '1px solid rgba(201,162,74,0.16)' : 'none',
      }}>
        <div id={elId} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
        {placeholder && !active && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {placeholder}
          </div>
        )}
      </div>
      {!active ? (
        <button onClick={() => { void start() }} style={{ width: '100%', padding: '20px', borderRadius: 14, background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)', border: '1px solid rgba(201,162,74,0.44)', boxShadow: '0 4px 20px rgba(107,15,18,0.45)', color: '#F2E6C8', fontFamily: SERIF, fontSize: 20, fontWeight: 700, letterSpacing: '0.2em', cursor: 'pointer' }}>
          QRを読み取る
        </button>
      ) : (
        <button onClick={stop} style={{ width: '100%', padding: '14px', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: '#e5e5e5', fontFamily: SERIF, fontSize: 13, fontWeight: 600, letterSpacing: '0.14em', cursor: 'pointer' }}>
          スキャン停止
        </button>
      )}
    </div>
  )
}

// ── AdminScreen ───────────────────────────────────────────────────────────────

type AdminScreenMode = 'issue' | 'recovery'
type AdminMainTab = 'issue' | 'recovery'


export function AdminScreen({ mode = 'issue' }: { mode?: AdminScreenMode }) {
  const [phase, setPhase] = useState<Phase>('scan')

  // Customer
  const [scannedData, setScannedData]             = useState<PassportQRData | null>(null)
  const [prevLastVisitDate, setPrevLastVisitDate]  = useState<string | null | undefined>(undefined)
  const [parseError, setParseError]               = useState<string | null>(null)
  const [cameraError, setCameraError]             = useState<string | null>(null)
  const [showManual, setShowManual]               = useState(false)
  const [manualInput, setManualInput]             = useState('')

  // Staff
  const [staffId, setStaffId]               = useState(() => getStoredValue<string>(STAFF_NAME_KEY, ''))
  const [showStaffPicker, setShowStaffPicker] = useState(false)

  // Ticket form
  const [ticketTab, setTicketTab]           = useState<TicketType>('discount')
  const [discountAmountInput, setDiscountAmountInput] = useState('')
  const [otokuAmountInput, setOtokuAmountInput]       = useState('')
  const [quantity, setQuantity]             = useState(1)
  const [issueLoading, setIssueLoading]     = useState(false)
  const [issueError, setIssueError]         = useState<string | null>(null)

  // Confirmation modal
  const [showConfirm, setShowConfirm] = useState(false)

  // Success overlay
  const [showSuccess, setShowSuccess] = useState(false)
  const [successInfo, setSuccessInfo] = useState<{ name: string; label: string; amount: number; qty: number } | null>(null)

  // Existing tickets
  const [userTickets, setUserTickets]       = useState<TicketRow[]>([])
  const [ticketsLoading, setTicketsLoading] = useState(false)

  // Manual use confirm (staff-side)
  const [showUseConfirm, setShowUseConfirm]       = useState(false)
  const [pendingUseTicket, setPendingUseTicket]   = useState<TicketRow | null>(null)
  const [useConfirmLoading, setUseConfirmLoading] = useState(false)
  const [useError, setUseError]                   = useState<string | null>(null)
  const [todayUsedType, setTodayUsedType]         = useState<string | null>(null)
  const [showUseComplete, setShowUseComplete]     = useState(false)
  const [useCompleteInfo, setUseCompleteInfo]     = useState<{ name: string; label: string; amount: number; remaining: number; checkedIn: boolean } | null>(null)

  // Ticket-use QR flow
  const [ticketUseData, setTicketUseData]         = useState<TicketUseQRData | null>(null)
  const [ticketForUse, setTicketForUse]           = useState<TicketRow | null>(null)
  const [ticketQrExpired, setTicketQrExpired]     = useState(false)
  const [ticketConfirming, setTicketConfirming]   = useState(false)
  const [ticketConfirmed, setTicketConfirmed]     = useState(false)
  const [ticketBlockMsg, setTicketBlockMsg]       = useState<string | null>(null)
  const [ticketUsedThisSession, setTicketUsedThisSession] = useState(false)

  // Maintenance coupon QR flow
  const [maintCouponData, setMaintCouponData]         = useState<MaintenanceCouponQRData | null>(null)
  const [maintCouponTodayUsed, setMaintCouponTodayUsed] = useState(false)
  const [maintCouponConfirming, setMaintCouponConfirming] = useState(false)
  const [maintCouponConfirmed, setMaintCouponConfirmed] = useState(false)
  const [maintCouponBlockMsg, setMaintCouponBlockMsg] = useState<string | null>(null)
  const [maintCouponPreview, setMaintCouponPreview] = useState<MaintenanceCouponPreview | null>(null)

  // Premium coupon QR flow
  const [premiumCouponData, setPremiumCouponData] = useState<PremiumCouponQRData | null>(null)
  const [premiumCouponExpired, setPremiumCouponExpired] = useState(false)

  // Checkin
  const [checkInStatus, setCheckInStatus] = useState<'idle' | 'loading' | 'done'>('idle')
  const [checkInDate, setCheckInDate]     = useState<string | null>(null)

  // 既存会員のアプリ紐付けコード（6桁・10分有効・1回限り）
  const [bindCode, setBindCode]             = useState<{ code: string; expiresAt: string } | null>(null)
  const [bindCodeLoading, setBindCodeLoading] = useState(false)
  const [bindCodeError, setBindCodeError]   = useState<string | null>(null)

  // ── 表示モード（店舗端末メニューから issue / recovery のどちらかで開く） ────────
  const [mainTab] = useState<AdminMainTab>(mode)

  // Recovery tab state
  const [recoveryStep, setRecoveryStep]               = useState<'search' | 'detail' | 'scan' | 'confirm' | 'done'>('search')
  const [recoveryQuery, setRecoveryQuery]             = useState('')
  const [recoveryResults, setRecoveryResults]         = useState<CustomerRow[]>([])
  const [recoverySearching, setRecoverySearching]     = useState(false)
  const [selectedCustomer, setSelectedCustomer]       = useState<CustomerRow | null>(null)
  const [customerLastVisit, setCustomerLastVisit]     = useState<string | null | undefined>(undefined)
  const [customerTicketCount, setCustomerTicketCount] = useState<number | null>(null)
  const [recoveryNewUserId, setRecoveryNewUserId]     = useState<string | null>(null)
  const [recoveryReason, setRecoveryReason]           = useState('機種変更')
  const [recoveryLoading, setRecoveryLoading]         = useState(false)
  const [recoveryError, setRecoveryError]             = useState<string | null>(null)
  const [recoveryScanError, setRecoveryScanError]     = useState<string | null>(null)
  const [recoveryManualInput, setRecoveryManualInput] = useState('')

  // ── Derived ───────────────────────────────────────────────────────────────

  const discountParsed  = parseInt(discountAmountInput.replace(/[^\d]/g, ''), 10) || 0
  const otokuParsed     = parseInt(otokuAmountInput.replace(/[^\d]/g, ''), 10) || 0
  const effectiveAmount = ticketTab === 'discount' ? discountParsed : otokuParsed
  const isFirstVisit  = prevLastVisitDate === null
  const elapsedDays   = prevLastVisitDate ? daysSince(prevLastVisitDate) : null
  const isEligible    = !isFirstVisit && prevLastVisitDate !== undefined && elapsedDays !== null && elapsedDays <= 14
  const canIssue      = staffId.trim() !== '' && !issueLoading && effectiveAmount > 0
  const activeTickets = userTickets.filter(t => !t.used)
  const currentTab    = TICKET_TABS.find(t => t.type === ticketTab) ?? TICKET_TABS[0]
  const tc            = TICKET_TYPE_COLORS[ticketTab]

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleReset() {
    setPhase('scan')
    setScannedData(null)
    setPrevLastVisitDate(undefined)
    setParseError(null)
    setCameraError(null)
    setShowManual(false)
    setManualInput('')
    setTicketTab('discount')
    setDiscountAmountInput('')
    setOtokuAmountInput('')
    setQuantity(1)
    setIssueLoading(false)
    setIssueError(null)
    setShowConfirm(false)
    setShowSuccess(false)
    setSuccessInfo(null)
    setUserTickets([])
    setTicketsLoading(false)
    setTicketUseData(null)
    setTicketForUse(null)
    setTicketQrExpired(false)
    setTicketConfirmed(false)
    setTicketBlockMsg(null)
    setTicketUsedThisSession(false)
    setCheckInStatus('idle')
    setCheckInDate(null)
    setBindCode(null)
    setBindCodeError(null)
    setShowUseConfirm(false)
    setPendingUseTicket(null)
    setUseConfirmLoading(false)
    setUseError(null)
    setTodayUsedType(null)
    setShowUseComplete(false)
    setUseCompleteInfo(null)
    setMaintCouponData(null)
    setMaintCouponTodayUsed(false)
    setMaintCouponConfirming(false)
    setMaintCouponConfirmed(false)
    setMaintCouponBlockMsg(null)
    setMaintCouponPreview(null)
    setPremiumCouponData(null)
    setPremiumCouponExpired(false)
  }

  const handleScanned = useCallback(async (text: string) => {
    const data = parseQR(text)
    if (!data) { setParseError(`認識できないQRコードです\n→ ${text.slice(0, 80)}`); return }
    setParseError(null)

    if (data.type === 'ginjiro-ticket-use') {
      const tuData = data as TicketUseQRData
      setTicketUseData(tuData); setTicketBlockMsg(null)
      setTicketConfirmed(false); setTicketForUse(null)
      setPhase('ticket-loading')
      if (new Date() > new Date(tuData.expiresAt)) { setTicketQrExpired(true); setPhase('ticket-result'); return }
      setTicketQrExpired(false)
      try {
        const tickets = await getTicketsForStaff(tuData.userId)
        setTicketForUse(tickets.find(t => t.id === tuData.selectedTicketId) ?? null)
      } catch { setTicketForUse(null) }
      setPhase('ticket-result')
      return
    }

    if (data.type === 'ginjiro-maintenance-coupon') {
      const mcData = data as MaintenanceCouponQRData
      setMaintCouponData(mcData)
      setMaintCouponConfirmed(false)
      setMaintCouponBlockMsg(null)
      setMaintCouponConfirming(false)
      setMaintCouponPreview(null)
      setPhase('maintenance-coupon')
      if (isLegacyMaintenanceQr(mcData) || !mcData.token) {
        setMaintCouponTodayUsed(true)
        setMaintCouponBlockMsg(LEGACY_MAINTENANCE_QR_MESSAGE)
        return
      }
      // サーバー側で 5分有効・未使用・14日以内・当日ルールを確認（消費はしない）
      try {
        const preview = await previewMaintenanceCoupon(mcData.token)
        setMaintCouponPreview(preview)
        setMaintCouponTodayUsed(!preview.valid)
        if (!preview.valid) setMaintCouponBlockMsg(rpcErrorMessage(new RpcError(preview.reason ?? ''), 'このクーポンQRは使用できません。'))
        if (preview.valid) playSuccessSound(); else playWarningSound()
      } catch (err) {
        setMaintCouponTodayUsed(true)
        setMaintCouponBlockMsg(rpcErrorMessage(err, 'クーポンの確認に失敗しました。通信環境を確認してください。'))
      }
      return
    }

    if (data.type === 'ginjiro-premium-coupon') {
      const pcData = data as PremiumCouponQRData
      setPremiumCouponData(pcData)
      setPremiumCouponExpired(isQrPayloadExpired(pcData.expiresAt))
      setPhase('premium-coupon')
      return
    }

    const passportData = data as PassportQRData
    setScannedData(passportData)
    setPhase('loading')
    // 会員登録（初回登録・名前更新）＋来店日・チケット・当日利用状況をサーバーから一括取得。
    // 登録に失敗した状態では発行・使用に進ませない。
    let ctx
    try {
      ctx = await registerCustomerWithContext(passportData.userId, passportData.name)
    } catch (err) {
      setScannedData(null)
      setPhase('scan')
      setParseError(rpcErrorMessage(err, '会員情報の取得に失敗しました。通信環境を確認してもう一度読み取ってください。'))
      return
    }
    const prev = ctx.last_visit_date
    setPrevLastVisitDate(prev)
    if (prev === null) { /* first visit — no sound */ }
    else if (daysSince(prev) <= 14) playSuccessSound()
    else playWarningSound()
    setUserTickets(ctx.tickets)
    setTodayUsedType(ctx.today_used_type)
    // 会員QRの読み取り＝来店登録（14日サイクルを本日からリセット）
    setCheckInStatus('loading')
    try {
      const visitDate = await checkInVisit(passportData.userId)
      setCheckInDate(visitDate)
      setCheckInStatus('done')
    } catch (err) {
      setCheckInStatus('idle')
      setUseError(rpcErrorMessage(err, '来店登録に失敗しました。「来店チェックイン」を押して再度お試しください。'))
    }
    setPhase('result')
  }, [])

  function handleTabChange(type: TicketType) {
    setTicketTab(type)
    setDiscountAmountInput('')
    setOtokuAmountInput('')
    setIssueError(null)
  }

  // Called by fixed bottom button — shows confirm modal
  function handleIssueClick() {
    if (!canIssue || issueLoading) return
    setIssueError(null)
    setShowConfirm(true)
  }

  // Called from confirm modal — does the actual issue + log
  const handleIssueTicket = async () => {
    if (!scannedData || !staffId.trim() || effectiveAmount <= 0) return
    setShowConfirm(false)
    setIssueLoading(true)
    setIssueError(null)
    try {
      // 一括発行（サーバー側で全件成功 or 全件失敗。発行ログも同じトランザクションで記録）
      const issued = await issueTickets({
        userId:       scannedData.userId,
        type:         ticketTab === 'otoku' ? 'otoku' : 'discount',
        amount:       effectiveAmount,
        quantity,
        staffName:    staffId,
        customerName: scannedData.name,
      })
      setUserTickets(prev => [...issued, ...prev])

      playSuccessSound()
      setSuccessInfo({ name: scannedData.name, label: currentTab.autoTitle, amount: effectiveAmount, qty: quantity })
      setShowSuccess(true)
      setDiscountAmountInput('')
      setOtokuAmountInput('')
      setQuantity(1)
      setTimeout(() => setShowSuccess(false), 1800)
    } catch (err) {
      setIssueError(`発行に失敗しました。1枚も発行されていません。${rpcErrorMessage(err, '通信環境を確認して再度お試しください。')}`)
    } finally {
      setIssueLoading(false)
    }
  }

  function handleUseTicketClick(ticket: TicketRow) {
    if (!canUseDiscountType(todayUsedType, ticket.type) || !staffId.trim()) return
    if (isWelcomeCouponBlockedToday(ticket)) return
    setUseError(null)
    setPendingUseTicket(ticket)
    setShowUseConfirm(true)
  }

  const handleConfirmUse = async () => {
    if (!pendingUseTicket || !scannedData || !staffId.trim()) return
    setUseConfirmLoading(true)
    setUseError(null)
    const ticketId   = pendingUseTicket.id
    const ticketType = pendingUseTicket.type
    try {
      if (isWelcomeCouponBlockedToday(pendingUseTicket)) {
        setUseError(WELCOME_COUPON_WEEKEND_MESSAGE)
        setUseConfirmLoading(false)
        return
      }
      // used化・使用ログ・来店日更新をサーバー側で1トランザクション
      const { visitDate: today } = await redeemTickets({
        userId: scannedData.userId, ticketIds: [ticketId], staffName: staffId, customerName: scannedData.name,
      })
      const remaining = userTickets.filter(t => !t.used && t.id !== ticketId && t.type === ticketType).length
      setUserTickets(prev => prev.map(t =>
        t.id === ticketId ? { ...t, used: true, used_at: new Date().toISOString() } : t
      ))
      setTodayUsedType(ticketType)
      setCheckInStatus('done')
      setCheckInDate(today)
      setUseCompleteInfo({
        name:      scannedData.name,
        label:     TICKET_TYPE_LABELS[ticketType] ?? pendingUseTicket.title,
        amount:    pendingUseTicket.amount,
        remaining,
        checkedIn: true,
      })
      setShowUseConfirm(false)
      setPendingUseTicket(null)
      setShowUseComplete(true)
      setTimeout(() => setShowUseComplete(false), 3500)
      playSuccessSound()
    } catch (err) {
      setUseError(`使用確定に失敗しました。${rpcErrorMessage(err, 'ネットワークを確認してください。')}`)
    } finally {
      setUseConfirmLoading(false)
    }
  }

  /** 本人確認のうえ、お客様の端末をアプリに紐付けるコードを発行（お客様がアプリで入力） */
  const handleIssueBindCode = async () => {
    if (!scannedData || bindCodeLoading) return
    if (!staffId.trim()) { setBindCodeError('担当者を選択してください。'); return }
    setBindCodeLoading(true)
    setBindCodeError(null)
    try {
      const r = await issueBindCode(scannedData.userId, staffId)
      setBindCode({ code: r.code, expiresAt: r.expires_at })
    } catch (err) {
      setBindCodeError(rpcErrorMessage(err, '引き継ぎコードの発行に失敗しました。通信環境を確認してください。'))
    } finally {
      setBindCodeLoading(false)
    }
  }

  const handleCheckIn = async () => {
    if (!scannedData || checkInStatus === 'loading') return
    setCheckInStatus('loading')
    try {
      setCheckInDate(await checkInVisit(scannedData.userId))
      setCheckInStatus('done')
      setUseError(null)
      playSuccessSound()
    } catch (err) {
      setCheckInStatus('idle')
      setUseError(rpcErrorMessage(err, '来店登録に失敗しました。通信環境を確認してください。'))
    }
  }

  const handleConfirmTicketUse = async () => {
    if (!ticketUseData || !ticketForUse || !staffId.trim()) return
    if (ticketUsedThisSession) { setTicketBlockMsg('このお会計では既にチケットを1枚使用しています。'); return }
    if (ticketForUse.used) { setTicketBlockMsg('このチケットはすでに使用済みです。'); return }
    if (isWelcomeCouponBlockedToday(ticketForUse)) { setTicketBlockMsg(WELCOME_COUPON_WEEKEND_MESSAGE); return }
    setTicketConfirming(true); setTicketBlockMsg(null)
    try {
      // 当日の併用ルール（異なる割引種別は不可・同種は複数枚可）・本人確認・used化・使用ログ・
      // 来店日更新はサーバー側で1トランザクション
      await redeemTickets({
        userId: ticketUseData.userId, ticketIds: [ticketForUse.id], staffName: staffId, customerName: '',
      })
      setTicketForUse(prev => prev ? { ...prev, used: true, used_at: new Date().toISOString() } : prev)
      setTicketConfirmed(true); setTicketUsedThisSession(true)
      playSuccessSound()
    } catch (err) {
      setTicketBlockMsg(`使用確定できませんでした。${rpcErrorMessage(err, 'ネットワークを確認してください。')}`)
    } finally { setTicketConfirming(false) }
  }

  const handleConfirmMaintenanceCoupon = async () => {
    if (!maintCouponData || !staffId.trim() || maintCouponTodayUsed || maintCouponConfirmed) return
    if (!maintCouponData.token) { setMaintCouponBlockMsg(LEGACY_MAINTENANCE_QR_MESSAGE); return }
    setMaintCouponConfirming(true)
    setMaintCouponBlockMsg(null)
    try {
      // サーバー側で再検証（5分有効・未使用・14日以内・当日ルール）し、使い捨てで確定
      await redeemMaintenanceCoupon(maintCouponData.token, staffId)
      setMaintCouponConfirmed(true)
      setMaintCouponTodayUsed(true)
      playSuccessSound()
    } catch (err) {
      setMaintCouponBlockMsg(rpcErrorMessage(err, '使用確定に失敗しました。ネットワークを確認してください。'))
      playWarningSound()
    } finally {
      setMaintCouponConfirming(false)
    }
  }

  function handleSelectStaff(name: string) {
    setStaffId(name); setStoredValue(STAFF_NAME_KEY, name); setShowStaffPicker(false)
  }

  // ── Recovery tab handlers ─────────────────────────────────────────────────

  const handleRecoverySearch = useCallback(async () => {
    if (!recoveryQuery.trim()) return
    setRecoverySearching(true)
    setRecoveryResults(await searchCustomersByName(recoveryQuery.trim()))
    setRecoverySearching(false)
  }, [recoveryQuery])

  const handleSelectCustomer = useCallback(async (customer: CustomerRow) => {
    setSelectedCustomer(customer)
    setRecoveryStep('detail')
    setCustomerLastVisit(undefined)
    setCustomerTicketCount(null)
    const [lastVisit, tickets] = await Promise.all([
      fetchLastVisitDate(customer.user_id).catch(() => null),
      getTicketsForStaff(customer.user_id).catch(() => [] as TicketRow[]),
    ])
    setCustomerLastVisit(lastVisit)
    setCustomerTicketCount(tickets.filter(t => !t.used).length)
  }, [])

  const handleRecoveryQrScan = useCallback((text: string) => {
    const parsed = parseQR(text)
    if (!parsed) {
      setRecoveryScanError('認識できないQRコードです。パスポートQRを読み取ってください。')
      return
    }
    if (parsed.type === 'ginjiro-ticket-use') {
      setRecoveryScanError('チケット使用QRです。パスポートQRを読み取ってください。')
      return
    }
    if (parsed.type === 'ginjiro-maintenance-coupon' || parsed.type === 'ginjiro-premium-coupon') {
      setRecoveryScanError('クーポンQRです。パスポートQRを読み取ってください。')
      return
    }
    const newUserId = (parsed as PassportQRData).userId
    if (newUserId === selectedCustomer?.user_id) {
      setRecoveryScanError('同じ端末のQRです。新しい端末のQRを読み取ってください。')
      return
    }
    setRecoveryNewUserId(newUserId)
    setRecoveryScanError(null)
    setRecoveryStep('confirm')
  }, [selectedCustomer])

  const handleRecoveryExecute = useCallback(async () => {
    if (!selectedCustomer || !recoveryNewUserId || !staffId.trim()) return
    setRecoveryLoading(true)
    setRecoveryError(null)
    const result = await recoverMember(selectedCustomer.user_id, recoveryNewUserId, staffId, recoveryReason)
    setRecoveryLoading(false)
    if ('error' in result) {
      setRecoveryError(result.error)
      return
    }
    playSuccessSound()
    setRecoveryStep('done')
  }, [selectedCustomer, recoveryNewUserId, staffId, recoveryReason])

  const handleRecoveryReset = useCallback(() => {
    setRecoveryStep('search')
    setRecoveryQuery('')
    setRecoveryResults([])
    setRecoverySearching(false)
    setSelectedCustomer(null)
    setCustomerLastVisit(undefined)
    setCustomerTicketCount(null)
    setRecoveryNewUserId(null)
    setRecoveryReason('機種変更')
    setRecoveryLoading(false)
    setRecoveryError(null)
    setRecoveryScanError(null)
    setRecoveryManualInput('')
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ minHeight: '100dvh', background: 'linear-gradient(180deg, #080302 0%, #0A0403 60%, #090304 100%)', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        @keyframes gj-spin   { to { transform: rotate(360deg); } }
        @keyframes gj-slot-in {
          0%   { opacity: 0; transform: translateY(-28px) scale(0.94); filter: drop-shadow(0 0 32px rgba(230,202,101,0.9)); }
          40%  { opacity: 1; transform: translateY(5px) scale(1.012); filter: drop-shadow(0 0 16px rgba(230,202,101,0.55)); }
          65%  { transform: translateY(-2px) scale(1.003); filter: drop-shadow(0 0 6px rgba(230,202,101,0.2)); }
          100% { transform: translateY(0) scale(1); filter: none; }
        }
        @keyframes gj-burst {
          0%   { opacity: 0.65; transform: scale(0.35); }
          55%  { opacity: 0.18; }
          100% { opacity: 0;    transform: scale(2.4); }
        }
        @keyframes gj-success-fade {
          0%   { opacity: 0; }
          10%  { opacity: 1; }
          75%  { opacity: 1; }
          100% { opacity: 0; }
        }
        @keyframes gj-success-pop {
          0%   { transform: scale(0.82); opacity: 0; }
          22%  { transform: scale(1.05); opacity: 1; }
          42%  { transform: scale(0.98); }
          100% { transform: scale(1);    opacity: 1; }
        }
        @keyframes gj-pulse-gold {
          0%, 100% { box-shadow: 0 0 0 1px rgba(201,162,74,0.32), 0 4px 16px rgba(0,0,0,0.55); }
          50%       { box-shadow: 0 0 0 1.5px rgba(201,162,74,0.68), 0 0 22px rgba(201,162,74,0.28), 0 4px 22px rgba(0,0,0,0.65); }
        }
        @keyframes gj-pulse-red {
          0%, 100% { box-shadow: 0 0 16px rgba(128,12,20,0.5), 0 0 0 2px rgba(230,202,101,0.55); }
          50%       { box-shadow: 0 0 36px rgba(128,12,20,0.8), 0 0 60px rgba(128,12,20,0.35), 0 0 0 2px rgba(230,202,101,0.9); }
        }
        @keyframes gj-toast-in {
          from { opacity: 0; transform: translateY(-100%); }
          to   { opacity: 1; transform: translateY(0); }
        }
        input[type=number]::-webkit-inner-spin-button,
        input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
      `}</style>

      {/* ── Realtime log toast ── */}

      {isStaging() && <StgBadge />}

      {/* ── Header ── */}
      <header style={{
        padding: '18px 20px 14px',
        borderBottom: '1px solid rgba(201,162,74,0.12)',
        background: 'linear-gradient(180deg, rgba(201,162,74,0.03) 0%, transparent 100%)',
        flexShrink: 0,
        marginTop: 0,
        transition: 'margin-top 0.3s ease',
      }}>
        <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, #8B1A1A 30%, #C9A24A 50%, #8B1A1A 70%, transparent)', marginBottom: 12 }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <p style={{ fontSize: 8, letterSpacing: '0.32em', color: '#e5e5e5', marginBottom: 1 }}>STAFF TERMINAL</p>
            <h1 style={{ fontSize: 18, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF, letterSpacing: '0.1em' }}>
              {mode === 'recovery' ? '会員復旧' : '店舗端末'}
            </h1>
          </div>
          <button
            onClick={() => setShowStaffPicker(true)}
            style={{
              padding: '9px 20px', borderRadius: 10,
              background: staffId ? 'rgba(139,26,26,0.3)' : 'rgba(224,96,70,0.1)',
              border: `1.5px solid ${staffId ? 'rgba(201,162,74,0.55)' : 'rgba(224,96,70,0.4)'}`,
              color: staffId ? '#F2E6C8' : '#E07050',
              fontSize: 14, fontFamily: SERIF, fontWeight: 700, letterSpacing: '0.08em', cursor: 'pointer',
            }}
          >
            {staffId ? `担当：${staffId}` : '担当者未設定'}
          </button>
        </div>
      </header>


      {/* ── 登録者数ダッシュボード ── */}

      {/* ── Main tab switcher ── */}

      {/* ── Main scroll area ── */}
      <main style={{
        flex: 1, overflowY: 'auto',
        padding: `20px 20px ${mainTab === 'issue' && phase === 'result' ? '108px' : '32px'}`,
        maxWidth: 480, margin: '0 auto', width: '100%', boxSizing: 'border-box',
      }}>

        {/* ===== SCAN ===== */}
        {mainTab === 'issue' && phase === 'scan' && (
          <div>
            {!staffId.trim() ? (
              <>
                {/* Waiting card（担当者未選択時は静的表示。スキャン枠とカメラ映像の統合はQrCameraScanner側のplaceholderモードで行う） */}
                <div style={{ borderRadius: 20, border: '1px solid rgba(201,162,74,0.16)', background: '#0A0504', overflow: 'hidden', marginBottom: 20 }}>
                  <div style={{ padding: '36px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
                    <div style={{ width: 68, height: 68, position: 'relative' }}>
                      {[
                        { top: 0,    left: 0,    borderTop: '3px solid',    borderLeft: '3px solid',   borderRadius: '4px 0 0 0' },
                        { top: 0,    right: 0,   borderTop: '3px solid',    borderRight: '3px solid',  borderRadius: '0 4px 0 0' },
                        { bottom: 0, left: 0,    borderBottom: '3px solid', borderLeft: '3px solid',   borderRadius: '0 0 0 4px' },
                        { bottom: 0, right: 0,   borderBottom: '3px solid', borderRight: '3px solid',  borderRadius: '0 0 4px 0' },
                      ].map((s, i) => (
                        <div key={i} style={{ position: 'absolute', width: 22, height: 22, borderColor: 'rgba(201,162,74,0.40)', ...s }} />
                      ))}
                    </div>
                    <p style={{ fontSize: 15, color: '#ffffff', fontFamily: SERIF, letterSpacing: '0.08em', textAlign: 'center', lineHeight: 1.7 }}>
                      次の男前パスポートをスキャンしてください
                    </p>
                  </div>
                </div>

                <div style={{ padding: '28px 20px', borderRadius: 16, background: 'rgba(139,26,26,0.1)', border: '1px solid rgba(201,162,74,0.22)', textAlign: 'center', marginBottom: 16 }}>
                  <p style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 700, color: '#ffffff', letterSpacing: '0.06em', marginBottom: 18, lineHeight: 1.6 }}>
                    先に担当者を選択してください
                  </p>
                  <button
                    onClick={() => setShowStaffPicker(true)}
                    style={{ padding: '16px 32px', borderRadius: 14, background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)', border: '1px solid rgba(201,162,74,0.5)', boxShadow: '0 4px 20px rgba(107,15,18,0.4)', color: '#F2E6C8', fontFamily: SERIF, fontSize: 17, fontWeight: 700, letterSpacing: '0.14em', cursor: 'pointer' }}
                  >
                    担当者を選択する
                  </button>
                </div>
              </>
            ) : (
              <div style={{ marginBottom: 14 }}>
                <QrCameraScanner
                  onScan={text => { void handleScanned(text) }}
                  onCameraError={msg => { setCameraError(msg); setShowManual(true) }}
                  placeholder={
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '20px' }}>
                      <div style={{ width: 68, height: 68, position: 'relative' }}>
                        {[
                          { top: 0,    left: 0,    borderTop: '3px solid',    borderLeft: '3px solid',   borderRadius: '4px 0 0 0' },
                          { top: 0,    right: 0,   borderTop: '3px solid',    borderRight: '3px solid',  borderRadius: '0 4px 0 0' },
                          { bottom: 0, left: 0,    borderBottom: '3px solid', borderLeft: '3px solid',   borderRadius: '0 0 0 4px' },
                          { bottom: 0, right: 0,   borderBottom: '3px solid', borderRight: '3px solid',  borderRadius: '0 0 4px 0' },
                        ].map((s, i) => (
                          <div key={i} style={{ position: 'absolute', width: 22, height: 22, borderColor: 'rgba(201,162,74,0.40)', ...s }} />
                        ))}
                      </div>
                      <p style={{ fontSize: 15, color: '#ffffff', fontFamily: SERIF, letterSpacing: '0.08em', textAlign: 'center', lineHeight: 1.7 }}>
                        次の男前パスポートをスキャンしてください
                      </p>
                    </div>
                  }
                />
              </div>
            )}

            {cameraError && <p style={{ fontSize: 12, color: '#E06060', textAlign: 'center', marginBottom: 12, lineHeight: 1.5 }}>{cameraError}</p>}
            {parseError && (
              <div style={{ borderRadius: 12, background: 'rgba(139,26,26,0.15)', border: '1px solid rgba(224,96,96,0.28)', padding: '10px 14px', marginBottom: 12 }}>
                <p style={{ fontSize: 12, color: '#E06060', whiteSpace: 'pre-line' }}>{parseError}</p>
              </div>
            )}

            <button onClick={() => setShowManual(v => !v)} style={{ width: '100%', padding: '14px', borderRadius: 12, background: 'transparent', border: '1px solid rgba(201,162,74,0.16)', color: '#e5e5e5', fontSize: 15, letterSpacing: '0.12em', cursor: 'pointer', fontFamily: SERIF, marginBottom: 10 }}>
              {showManual ? '手動入力を閉じる' : '手動入力（カメラ非対応時）'}
            </button>

            {showManual && (
              <div style={{ marginBottom: 12 }}>
                <textarea
                  value={manualInput}
                  onChange={e => setManualInput(e.target.value)}
                  placeholder='{"type":"otokomae-passport","userId":"demo-user-001","name":"慶一郎"}'
                  rows={4}
                  style={{ width: '100%', padding: '12px', borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(201,162,74,0.22)', color: '#F2E6C8', fontSize: 11, fontFamily: 'monospace', resize: 'vertical', outline: 'none', boxSizing: 'border-box', marginBottom: 10, lineHeight: 1.5 }}
                />
                <button
                  onClick={() => { if (manualInput.trim()) { void handleScanned(manualInput.trim()); setManualInput('') } }}
                  disabled={!manualInput.trim()}
                  style={{ width: '100%', padding: '16px', borderRadius: 12, background: manualInput.trim() ? 'rgba(40,80,20,0.5)' : 'rgba(255,255,255,0.04)', border: `1px solid ${manualInput.trim() ? 'rgba(120,180,80,0.4)' : 'rgba(255,255,255,0.1)'}`, color: manualInput.trim() ? '#C8F0A0' : '#999999', fontFamily: SERIF, fontSize: 16, fontWeight: 700, letterSpacing: '0.14em', cursor: manualInput.trim() ? 'pointer' : 'default' }}
                >
                  読み取る
                </button>
              </div>
            )}

            {/* Store QR */}

            {/* Issue log panel */}
          </div>
        )}

        {/* ===== LOADING ===== */}
        {mainTab === 'issue' && phase === 'loading' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 80 }}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', border: '2px solid rgba(201,162,74,0.14)', borderTop: '2px solid rgba(201,162,74,0.7)', animation: 'gj-spin 0.8s linear infinite', marginBottom: 20 }} />
            <p style={{ fontSize: 14, color: '#e5e5e5', fontFamily: SERIF, letterSpacing: '0.14em' }}>判定中...</p>
          </div>
        )}

        {/* ===== RESULT ===== */}
        {mainTab === 'issue' && phase === 'result' && scannedData && (
          <div>
            {/* ── Customer card ── */}
            <div style={{ position: 'relative', marginBottom: 16 }}>
              <div
                key={`burst-${scannedData.userId}`}
                style={{
                  position: 'absolute', inset: 0, borderRadius: 22, zIndex: 1, pointerEvents: 'none',
                  background: 'radial-gradient(circle at 50% 38%, rgba(230,202,101,0.32) 0%, rgba(139,26,26,0.16) 45%, transparent 72%)',
                  animation: 'gj-burst 0.9s ease-out both',
                }}
              />
              <div
                key={scannedData.userId}
                style={{
                  borderRadius: 20, overflow: 'hidden', position: 'relative', zIndex: 2,
                  border: '1px solid rgba(201,162,74,0.45)',
                  background: 'linear-gradient(160deg, #1c0e08 0%, #0e0604 100%)',
                  boxShadow: '0 0 25px rgba(230,202,101,0.22), 0 14px 44px rgba(0,0,0,0.75)',
                  animation: 'gj-slot-in 0.52s cubic-bezier(0.34,1.56,0.64,1) both',
                }}
              >
                <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, #8B5A10 20%, #C9A24A 40%, #F2E6C8 50%, #C9A24A 60%, #8B5A10 80%, transparent)' }} />
                <div style={{ padding: '16px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: 8, letterSpacing: '0.28em', color: '#e5e5e5', marginBottom: 4 }}>CUSTOMER</p>
                      <h2 style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, color: '#F2E6C8', letterSpacing: '0.06em', marginBottom: 3, lineHeight: 1.1 }}>
                        {scannedData.name}
                        <span style={{ fontSize: 14, marginLeft: 4, color: '#e5e5e5' }}>様</span>
                      </h2>
                      <p style={{ fontSize: 9, color: '#e5e5e5', letterSpacing: '0.06em', marginBottom: 2 }}>
                        ID: {scannedData.userId.slice(0, 22)}…
                      </p>
                      {prevLastVisitDate && (
                        <p style={{ fontSize: 10, color: '#e5e5e5', letterSpacing: '0.04em' }}>
                          最終来店 {fmtVisitDate(prevLastVisitDate)}
                        </p>
                      )}
                    </div>
                    <div style={{
                      flexShrink: 0, padding: '10px 14px', borderRadius: 14, textAlign: 'center', minWidth: 72,
                      background: isFirstVisit ? 'rgba(90,130,210,0.1)' : isEligible ? 'rgba(80,192,80,0.1)' : 'rgba(200,80,60,0.1)',
                      border: `1px solid ${isFirstVisit ? 'rgba(90,130,210,0.28)' : isEligible ? 'rgba(80,192,80,0.32)' : 'rgba(200,80,60,0.28)'}`,
                    }}>
                      <p style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, lineHeight: 1.1, marginBottom: 3, color: isFirstVisit ? 'rgba(140,180,240,0.9)' : isEligible ? '#80E060' : '#E06040' }}>
                        {isFirstVisit ? '初回' : `${elapsedDays}日`}
                      </p>
                      <p style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', color: isFirstVisit ? 'rgba(140,180,240,1)' : isEligible ? 'rgba(128,224,96,1)' : 'rgba(224,96,64,1)' }}>
                        {isFirstVisit ? '初回来店' : isEligible ? '対象◎' : '対象外'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Special予約：予約日当日だけ予約割引を表示（価格は店舗側マスタ。QR内の価格は使わない） */}
            {scannedData.reservation && isReservationForDate(scannedData.reservation) && (
              <div style={{
                marginBottom: 14,
                borderRadius: 18,
                overflow: 'hidden',
                background: 'linear-gradient(155deg, #150806 0%, #060303 100%)',
                border: '1px solid rgba(201,162,74,0.34)',
                boxShadow: '0 10px 34px rgba(0,0,0,0.48), inset 0 1px 0 rgba(255,238,190,0.06)',
              }}>
                <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.75), transparent)' }} />
                <div style={{ padding: '15px 18px' }}>
                  <p style={{ fontSize: 8, letterSpacing: '0.28em', color: 'rgba(201,162,74,0.86)', marginBottom: 8 }}>
                    CURRENT RESERVATION · 本日のご予約
                  </p>
                  <p style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#F2E6C8', lineHeight: 1.35, marginBottom: 4 }}>
                    {scannedData.reservation.title}
                  </p>
                  <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.68)', lineHeight: 1.55, marginBottom: 10 }}>
                    {scannedData.reservation.menuLabel}
                  </p>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 8 }}>
                    {typeof scannedData.reservation.normalPrice === 'number' && (
                      <span style={{ fontSize: 13, color: 'rgba(242,230,200,0.38)', textDecoration: 'line-through' }}>
                        ¥{scannedData.reservation.normalPrice.toLocaleString()}
                      </span>
                    )}
                    <span style={{ fontFamily: SERIF, fontSize: 28, fontWeight: 700, color: '#C9A24A', lineHeight: 1 }}>
                      ¥{scannedData.reservation.memberPrice.toLocaleString()}
                    </span>
                  </div>
                  <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.54)', lineHeight: 1.55 }}>
                    {scannedData.reservation.benefit} / 電話予約済み
                  </p>
                </div>
              </div>
            )}
            {scannedData.reservation && !isReservationForDate(scannedData.reservation) && (
              <p style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', fontSize: 12, color: '#bdbdbd', lineHeight: 1.6 }}>
                {scannedData.reservation.title}：ご予約日 {scannedData.reservation.visitDate.replace(/-/g, '/')}（本日は対象外のため予約割引なし）
              </p>
            )}

            {/* ── アプリ紐付けコード（既存会員の移行・端末のセッション再発行） ── */}
            <div style={{ marginBottom: 14, borderRadius: 16, padding: '14px 16px', background: 'rgba(201,162,74,0.05)', border: '1px solid rgba(201,162,74,0.22)' }}>
              {bindCode ? (
                <div style={{ textAlign: 'center' }}>
                  <p style={{ fontSize: 13, color: '#e5e5e5', marginBottom: 6 }}>お客様のアプリに入力してもらってください</p>
                  <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: 40, fontWeight: 800, letterSpacing: '0.24em', color: '#F2E6C8', paddingLeft: '0.24em' }}>
                    {bindCode.code}
                  </p>
                  <p style={{ fontSize: 12, color: '#C9A24A', marginTop: 4 }}>
                    {new Date(bindCode.expiresAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} まで有効・1回限り
                  </p>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => { void handleIssueBindCode() }}
                  disabled={bindCodeLoading}
                  style={{ width: '100%', minHeight: 48, borderRadius: 12, background: 'transparent', border: '1px solid rgba(201,162,74,0.4)', color: '#F2E6C8', fontFamily: SERIF, fontSize: 15, fontWeight: 700, letterSpacing: '0.1em', cursor: bindCodeLoading ? 'default' : 'pointer' }}
                >
                  {bindCodeLoading ? '発行中…' : '引き継ぎコードを発行'}
                  <span style={{ display: 'block', fontSize: 12, fontWeight: 400, color: '#e5e5e5', marginTop: 3, letterSpacing: '0.04em' }}>
                    ご本人確認のうえ発行（アプリで「以前のチケットを引き継ぐ」を選んだお客様）
                  </span>
                </button>
              )}
              {bindCodeError && <p style={{ fontSize: 13, color: '#E06060', marginTop: 8 }}>{bindCodeError}</p>}
            </div>

            {/* ── 来店チェックイン ── */}
            <div style={{ marginBottom: 14 }}>
              {checkInStatus === 'done' && checkInDate ? (
                <div style={{
                  borderRadius: 16, padding: '20px',
                  background: 'linear-gradient(135deg, rgba(15,50,22,0.7) 0%, rgba(8,35,15,0.9) 100%)',
                  border: '1px solid rgba(80,192,90,0.38)',
                  boxShadow: '0 4px 24px rgba(20,100,40,0.18)',
                  textAlign: 'center',
                }}>
                  <div style={{
                    width: 44, height: 44, borderRadius: '50%', margin: '0 auto 12px',
                    background: 'rgba(80,192,90,0.15)',
                    border: '1.5px solid rgba(80,192,90,0.5)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 20, color: '#80E060',
                  }}>✓</div>
                  <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: '#80E060', letterSpacing: '0.1em', marginBottom: 10 }}>
                    来店チェックイン完了
                  </p>
                  <p style={{ fontFamily: SERIF, fontSize: 13, color: '#e5e5e5', lineHeight: 1.8, letterSpacing: '0.04em' }}>
                    QR読み取りと同時に<br />
                    {scannedData.name}様の来店日を<br />
                    <span style={{ fontWeight: 700, color: '#F2E6C8', letterSpacing: '0.12em' }}>{fmtVisitDate(checkInDate)}</span><br />
                    として記録しました。
                  </p>
                </div>
              ) : (
                <button
                  onClick={() => { void handleCheckIn() }}
                  disabled={checkInStatus === 'loading'}
                  style={{
                    width: '100%', padding: '18px 0', borderRadius: 16,
                    background: checkInStatus === 'loading'
                      ? 'rgba(20,60,30,0.5)'
                      : 'linear-gradient(135deg, rgba(20,60,30,0.85) 0%, rgba(10,45,20,0.95) 100%)',
                    border: '1px solid rgba(100,200,100,0.35)',
                    boxShadow: checkInStatus === 'loading' ? 'none' : '0 4px 22px rgba(20,90,42,0.28)',
                    fontFamily: SERIF, fontSize: 17, fontWeight: 700,
                    letterSpacing: '0.14em', color: checkInStatus === 'loading' ? '#999999' : '#D0F4D8',
                    cursor: checkInStatus === 'loading' ? 'default' : 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  {checkInStatus === 'loading' ? '記録中…' : '来店チェックイン'}
                  {checkInStatus !== 'loading' && (
                    <span style={{ display: 'block', fontSize: 10, fontWeight: 400, color: 'rgba(208,244,216,1)', letterSpacing: '0.08em', marginTop: 4 }}>
                      本日の来店日を記録します
                    </span>
                  )}
                </button>
              )}
            </div>

            {/* ── 使用可能チケット一覧 ── */}
            <div style={{ marginBottom: 14 }}>
              <p style={{ fontSize: 9, letterSpacing: '0.24em', color: '#e5e5e5', marginBottom: 10, fontFamily: SERIF }}>
                保有チケット（未使用 {ticketsLoading ? '—' : `${activeTickets.length}枚`}）
              </p>
              {ticketsLoading ? (
                <div style={{ padding: '16px', textAlign: 'center', borderRadius: 14, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <p style={{ fontSize: 12, color: '#e5e5e5' }}>読込中…</p>
                </div>
              ) : activeTickets.length === 0 ? (
                <div style={{ padding: '16px', textAlign: 'center', borderRadius: 14, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <p style={{ fontSize: 12, color: '#e5e5e5' }}>保有チケットなし</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {activeTickets.map(ticket => {
                    const tktTc = TICKET_TYPE_COLORS[ticket.type]
                    const isBlockedToday = !canUseDiscountType(todayUsedType, ticket.type)
                    const isWelcomeBlocked = isWelcomeCouponBlockedToday(ticket)
                    const noStaff = !staffId.trim()
                    const btnDisabled = isBlockedToday || isWelcomeBlocked || noStaff
                    return (
                      <div key={ticket.id} style={{ borderRadius: 16, background: tktTc.cardBg, border: `1px solid ${tktTc.border}`, overflow: 'hidden' }}>
                        <div style={{ height: 2, background: `linear-gradient(90deg, transparent, ${tktTc.border}, transparent)` }} />
                        <div style={{ padding: '14px 16px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                            <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: tktTc.bg, border: `1px solid ${tktTc.border}`, color: tktTc.text, letterSpacing: '0.1em' }}>
                              {TICKET_TYPE_LABELS[ticket.type]}
                            </span>
                            <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 99, background: 'rgba(80,210,120,0.15)', border: '1px solid rgba(80,210,120,0.4)', color: '#50d278' }}>未使用</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <p style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: '#F2E6C8', marginBottom: 2 }}>{ticket.title}</p>
                              {ticket.amount > 0 && (
                                <p style={{ fontFamily: SERIF, fontSize: 24, fontWeight: 700, color: '#C9A24A', lineHeight: 1, marginBottom: 4 }}>¥{ticket.amount.toLocaleString()}</p>
                              )}
                              <p style={{ fontSize: 9, color: '#e5e5e5' }}>発行日 {fmtCreatedAt(ticket.created_at)}</p>
                              {ticket.expires_at && (
                                <p style={{ fontSize: 9, color: 'rgba(255,180,0,1)', marginTop: 1 }}>有効期限 {fmtCreatedAt(ticket.expires_at)}</p>
                              )}
                            </div>
                            <button
                              onClick={() => handleUseTicketClick(ticket)}
                              disabled={btnDisabled}
                              style={{
                                flexShrink: 0, padding: '13px 16px', borderRadius: 12,
                                background: btnDisabled ? 'rgba(255,255,255,0.04)' : 'linear-gradient(135deg, #0a3d1a 0%, #1a7a38 100%)',
                                border: `1.5px solid ${btnDisabled ? 'rgba(255,255,255,0.09)' : 'rgba(100,200,100,0.44)'}`,
                                boxShadow: btnDisabled ? 'none' : '0 4px 16px rgba(20,90,42,0.35)',
                                color: btnDisabled ? '#999999' : '#D0F4D8',
                                fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.12em',
                                cursor: btnDisabled ? 'default' : 'pointer',
                                whiteSpace: 'nowrap', minWidth: 80, textAlign: 'center',
                              }}
                            >
                              {isBlockedToday ? '本日使用済' : isWelcomeBlocked ? '平日のみ' : '使用確定'}
                            </button>
                          </div>
                          {isWelcomeBlocked && (
                            <p style={{ fontSize: 9, color: 'rgba(224,96,80,1)', marginTop: 8, lineHeight: 1.5 }}>
                              {WELCOME_COUPON_WEEKEND_MESSAGE}
                            </p>
                          )}
                          {isBlockedToday && (
                            <p style={{ fontSize: 9, color: 'rgba(224,96,80,1)', marginTop: 8, lineHeight: 1.5 }}>
                              本日は{todayUsedType ? DISCOUNT_TYPE_LABEL[todayUsedType] ?? todayUsedType : '他の割引'}をご利用済みのため使用できません。<br />
                              割引の併用は1日1種類までです（同じ種別は複数枚使用できます）。
                            </p>
                          )}
                          {noStaff && !isBlockedToday && !isWelcomeBlocked && (
                            <p style={{ fontSize: 9, color: 'rgba(224,140,0,1)', marginTop: 8 }}>担当者を選択してください</p>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* ── チケット発行フォーム ── */}
            <div style={{ borderRadius: 18, marginBottom: 14, border: '1px solid rgba(201,162,74,0.18)', background: 'linear-gradient(160deg, #0e0808 0%, #090504 100%)', padding: '18px' }}>

              {/* Tab selector */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
                {TICKET_TABS.map(tab => {
                  const tabTc  = TICKET_TYPE_COLORS[tab.type]
                  const active = ticketTab === tab.type
                  return (
                    <button
                      key={tab.type}
                      onClick={() => handleTabChange(tab.type)}
                      style={{
                        flex: 1, padding: '15px 4px', borderRadius: 13,
                        background: active ? tabTc.cardBg : 'rgba(255,255,255,0.03)',
                        border: `1.5px solid ${active ? tabTc.border : 'rgba(255,255,255,0.08)'}`,
                        color: active ? tabTc.text : '#b3b3b3',
                        fontSize: 15, fontFamily: SERIF, fontWeight: 700, letterSpacing: '0.06em',
                        cursor: 'pointer',
                        animation: active ? 'gj-pulse-gold 2.4s ease-in-out infinite' : 'none',
                        transition: 'all 0.18s',
                      }}
                    >
                      {tab.label}
                    </button>
                  )
                })}
              </div>

              {/* ── Amount input: both tabs free-form ── */}
              <div style={{ marginBottom: 20 }}>
                <p style={{ fontSize: 9, letterSpacing: '0.22em', color: '#e5e5e5', marginBottom: 10 }}>金額を入力</p>
                {ticketTab === 'discount' && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 10 }}>
                    {DISCOUNT_AMOUNT_PRESETS.map(amount => {
                      const active = discountAmountInput === String(amount)
                      return (
                        <button
                          key={amount}
                          type="button"
                          onClick={() => setDiscountAmountInput(String(amount))}
                          style={{
                            padding: '12px 4px', borderRadius: 12,
                            background: active ? tc.cardBg : 'rgba(255,255,255,0.04)',
                            border: `1.5px solid ${active ? tc.border : 'rgba(255,255,255,0.09)'}`,
                            color: active ? tc.text : '#e5e5e5',
                            fontFamily: SERIF, fontSize: 16, fontWeight: 700,
                            cursor: 'pointer',
                            transition: 'all 0.15s',
                          }}
                        >
                          ¥{amount.toLocaleString()}
                        </button>
                      )
                    })}
                  </div>
                )}
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: effectiveAmount > 0 ? '#C9A24A' : '#999999', pointerEvents: 'none' }}>¥</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    value={ticketTab === 'discount' ? discountAmountInput : otokuAmountInput}
                    onChange={e => {
                      const v = e.target.value.replace(/[^\d]/g, '')
                      if (ticketTab === 'discount') {
                        setDiscountAmountInput(v)
                      } else {
                        setOtokuAmountInput(v)
                      }
                    }}
                    placeholder="0"
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      padding: '18px 16px 18px 40px', borderRadius: 14,
                      background: effectiveAmount > 0 ? tc.cardBg : 'rgba(255,255,255,0.04)',
                      border: `1.5px solid ${effectiveAmount > 0 ? tc.border : 'rgba(255,255,255,0.12)'}`,
                      color: '#F2E6C8', fontFamily: SERIF, fontSize: 28, fontWeight: 700,
                      outline: 'none', letterSpacing: '0.04em',
                      transition: 'border-color 0.15s, background 0.15s',
                    }}
                  />
                </div>
                {effectiveAmount > 0 && (
                  <p style={{ fontSize: 11, color: '#e5e5e5', textAlign: 'right', marginTop: 6, letterSpacing: '0.06em' }}>
                    ¥{effectiveAmount.toLocaleString()} の{currentTab.autoTitle}
                  </p>
                )}
                {(() => {
                  const raw = ticketTab === 'discount' ? discountAmountInput : otokuAmountInput
                  return raw !== '' && effectiveAmount <= 0
                    ? <p style={{ fontSize: 11, color: '#E06060', marginTop: 6 }}>1円以上の金額を入力してください</p>
                    : null
                })()}
              </div>

              {/* Quantity */}
              <p style={{ fontSize: 9, letterSpacing: '0.22em', color: '#e5e5e5', marginBottom: 10 }}>枚数を選択</p>
              <div style={{ display: 'flex', gap: 7, marginBottom: 12 }}>
                {QTY_PRESETS.map(n => (
                  <button
                    key={n}
                    onClick={() => setQuantity(n)}
                    style={{
                      flex: 1, padding: '14px 2px', borderRadius: 11,
                      background: quantity === n ? tc.cardBg : 'rgba(255,255,255,0.04)',
                      border: `1.5px solid ${quantity === n ? tc.border : 'rgba(255,255,255,0.09)'}`,
                      color: quantity === n ? tc.text : '#e5e5e5',
                      fontFamily: SERIF, fontSize: 16, fontWeight: 700,
                      cursor: 'pointer',
                      animation: quantity === n ? 'gj-pulse-gold 2.2s ease-in-out infinite' : 'none',
                      transition: 'all 0.15s',
                    }}
                  >
                    {n}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, marginBottom: 18 }}>
                <button onClick={() => setQuantity(q => Math.max(1, q - 1))} style={{ width: 46, height: 46, borderRadius: '50%', background: 'rgba(255,255,255,0.05)', border: '1.5px solid rgba(255,255,255,0.13)', color: '#e5e5e5', fontSize: 22, fontWeight: 300, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
                <div style={{ textAlign: 'center', minWidth: 72 }}>
                  <span style={{ fontFamily: SERIF, fontSize: 32, fontWeight: 700, color: '#F2E6C8', letterSpacing: '-0.01em' }}>{quantity}</span>
                  <span style={{ fontSize: 12, color: '#e5e5e5', marginLeft: 4 }}>枚</span>
                </div>
                <button onClick={() => setQuantity(q => Math.min(MAX_QTY, q + 1))} style={{ width: 46, height: 46, borderRadius: '50%', background: 'rgba(255,255,255,0.05)', border: '1.5px solid rgba(255,255,255,0.13)', color: '#e5e5e5', fontSize: 22, fontWeight: 300, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>＋</button>
              </div>

              {/* Summary */}
              {effectiveAmount > 0 && (
                <div style={{ padding: '10px 16px', borderRadius: 12, background: 'rgba(201,162,74,0.06)', border: '1px solid rgba(201,162,74,0.18)', textAlign: 'center' }}>
                  <p style={{ fontFamily: SERIF, fontSize: 14, color: '#C9A24A', letterSpacing: '0.06em' }}>
                    {currentTab.autoTitle} ¥{effectiveAmount.toLocaleString()} x {quantity}枚
                  </p>
                </div>
              )}

              {issueError && <p style={{ fontSize: 12, color: '#E06060', marginTop: 10, lineHeight: 1.5 }}>{issueError}</p>}
            </div>

          </div>
        )}

        {/* ===== TICKET-LOADING ===== */}
        {mainTab === 'issue' && phase === 'ticket-loading' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 80 }}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', border: '2px solid rgba(201,162,74,0.14)', borderTop: '2px solid rgba(201,162,74,0.7)', animation: 'gj-spin 0.8s linear infinite', marginBottom: 20 }} />
            <p style={{ fontSize: 14, color: '#e5e5e5', fontFamily: SERIF, letterSpacing: '0.14em' }}>チケット確認中...</p>
          </div>
        )}

        {/* ===== TICKET-RESULT ===== */}
        {mainTab === 'issue' && phase === 'ticket-result' && ticketUseData && (
          <div>
            {ticketQrExpired ? (
              <div style={{ borderRadius: 18, background: 'linear-gradient(135deg, rgba(70,15,15,0.6), rgba(50,8,8,0.8))', border: '1px solid rgba(200,80,60,0.3)', padding: '28px 22px', textAlign: 'center', marginBottom: 16 }}>
                <p style={{ fontSize: 9, letterSpacing: '0.3em', color: 'rgba(200,100,80,1)', marginBottom: 12 }}>QR EXPIRED</p>
                <p style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: '#E06040', marginBottom: 10 }}>QRコードの有効期限が切れています</p>
                <p style={{ fontSize: 12, color: 'rgba(220,120,100,1)', lineHeight: 1.6 }}>お客様に再度「使用する」を押していただいてください。</p>
              </div>
            ) : ticketForUse === null ? (
              <div style={{ borderRadius: 18, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', padding: '28px 22px', textAlign: 'center', marginBottom: 16 }}>
                <p style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: '#e5e5e5', marginBottom: 8 }}>チケットが見つかりません</p>
                <p style={{ fontSize: 12, color: '#e5e5e5', lineHeight: 1.6 }}>すでに使用済みか、存在しないチケットです。</p>
              </div>
            ) : ticketConfirmed ? (
              <div style={{ borderRadius: 18, background: 'linear-gradient(135deg, rgba(15,50,22,0.6), rgba(8,35,15,0.8))', border: '1px solid rgba(80,192,90,0.38)', padding: '28px 22px', textAlign: 'center', marginBottom: 16, boxShadow: '0 4px 36px rgba(80,192,80,0.14)' }}>
                <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(100,200,100,0.12)', border: '1px solid rgba(100,200,100,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', fontSize: 24 }}>✓</div>
                <p style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: '#80E060', marginBottom: 10 }}>使用確定しました</p>
                <p style={{ fontFamily: SERIF, fontSize: 17, color: '#F2E6C8', marginBottom: 4 }}>{ticketForUse.title}</p>
                {ticketForUse.amount > 0 && (
                  <p style={{ fontFamily: SERIF, fontSize: 22, color: '#C9A24A', marginBottom: 8 }}>¥{ticketForUse.amount.toLocaleString()}</p>
                )}
                <p style={{ fontSize: 12, color: 'rgba(128,224,96,1)', marginTop: 4, lineHeight: 1.6 }}>
                  来店チェックイン完了<br />
                  <span style={{ fontSize: 10, color: 'rgba(128,224,96,1)' }}>メンテナンスカウントダウンをリセットしました</span>
                </p>
              </div>
            ) : (
              <>
                {(() => {
                  const tktTc     = TICKET_TYPE_COLORS[ticketForUse.type]
                  const isUsed    = ticketForUse.used
                  const isExpired = !!ticketForUse.expires_at && new Date(ticketForUse.expires_at) < new Date()
                  return (
                    <div style={{ borderRadius: 16, marginBottom: 14, border: `1px solid ${tktTc.border}`, background: 'linear-gradient(160deg, #120A06 0%, #0A0504 100%)', overflow: 'hidden' }}>
                      <div style={{ height: 2, background: `linear-gradient(90deg, transparent, ${tktTc.border}, transparent)` }} />
                      <div style={{ padding: '16px 18px' }}>
                        <p style={{ fontSize: 9, letterSpacing: '0.22em', color: '#e5e5e5', marginBottom: 8, fontFamily: SERIF }}>チケット確認</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: tktTc.bg, border: `1px solid ${tktTc.border}`, color: tktTc.text, letterSpacing: '0.1em' }}>
                            {TICKET_TYPE_LABELS[ticketForUse.type]}
                          </span>
                          {isUsed    && <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: 'rgba(224,96,80,0.12)', border: '1px solid rgba(224,96,80,0.38)', color: '#E06050' }}>使用済み</span>}
                          {isExpired && <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: 'rgba(255,180,0,0.1)',  border: '1px solid rgba(255,180,0,0.3)',  color: '#FFB400' }}>期限切れ</span>}
                          {!isUsed && !isExpired && <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: 'rgba(100,210,110,0.08)', border: '1px solid rgba(100,210,110,0.3)', color: '#64D26E' }}>未使用</span>}
                        </div>
                        <p style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#F2E6C8', marginBottom: ticketForUse.amount > 0 ? 4 : 10 }}>{ticketForUse.title}</p>
                        {ticketForUse.amount > 0 && (
                          <p style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, color: '#C9A24A', marginBottom: 10, lineHeight: 1 }}>¥{ticketForUse.amount.toLocaleString()}</p>
                        )}
                        <p style={{ fontSize: 9, color: '#e5e5e5', marginTop: 4 }}>
                          QR有効期限 {new Date(ticketUseData.expiresAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} まで
                        </p>
                      </div>
                    </div>
                  )
                })()}

                {ticketBlockMsg && (
                  <div style={{ borderRadius: 12, background: 'rgba(139,26,26,0.15)', border: '1px solid rgba(224,96,96,0.28)', padding: '10px 14px', marginBottom: 12 }}>
                    <p style={{ fontSize: 12, color: '#E06060' }}>{ticketBlockMsg}</p>
                  </div>
                )}
                {!staffId.trim() && (
                  <div style={{ borderRadius: 12, background: 'rgba(224,140,0,0.1)', border: '1px solid rgba(224,140,0,0.3)', padding: '10px 14px', marginBottom: 12 }}>
                    <p style={{ fontSize: 11, color: '#E08C00' }}>担当者を選択してください</p>
                  </div>
                )}
                {ticketUsedThisSession && (
                  <div style={{ borderRadius: 12, background: 'rgba(255,180,0,0.08)', border: '1px solid rgba(255,180,0,0.28)', padding: '10px 14px', marginBottom: 12 }}>
                    <p style={{ fontSize: 11, color: '#FFB400' }}>このお会計では既に1枚使用しています（1会計1枚ルール）</p>
                  </div>
                )}
                {isWelcomeCouponBlockedToday(ticketForUse) && !ticketBlockMsg && (
                  <div style={{ borderRadius: 12, background: 'rgba(139,26,26,0.15)', border: '1px solid rgba(224,96,96,0.28)', padding: '10px 14px', marginBottom: 12 }}>
                    <p style={{ fontSize: 12, color: '#E06060' }}>{WELCOME_COUPON_WEEKEND_MESSAGE}</p>
                  </div>
                )}

                {!ticketForUse.used && (
                  <button
                    onClick={() => { void handleConfirmTicketUse() }}
                    disabled={ticketConfirming || !staffId.trim() || ticketUsedThisSession || isWelcomeCouponBlockedToday(ticketForUse)}
                    style={{
                      width: '100%', padding: '16px', borderRadius: 14, marginBottom: 10,
                      background: (ticketConfirming || !staffId.trim() || ticketUsedThisSession || isWelcomeCouponBlockedToday(ticketForUse))
                        ? 'rgba(255,255,255,0.04)'
                        : 'linear-gradient(135deg, #0a3d1a 0%, #145a2a 60%, #1a7a38 100%)',
                      border: `1px solid ${(ticketConfirming || !staffId.trim() || ticketUsedThisSession || isWelcomeCouponBlockedToday(ticketForUse)) ? 'rgba(255,255,255,0.08)' : 'rgba(100,200,100,0.44)'}`,
                      boxShadow: (ticketConfirming || !staffId.trim() || ticketUsedThisSession || isWelcomeCouponBlockedToday(ticketForUse)) ? 'none' : '0 4px 20px rgba(20,90,42,0.45)',
                      color: (ticketConfirming || !staffId.trim() || ticketUsedThisSession || isWelcomeCouponBlockedToday(ticketForUse)) ? '#999999' : '#D0F4D8',
                      fontFamily: SERIF, fontSize: 15, fontWeight: 700, letterSpacing: '0.18em',
                      cursor: (ticketConfirming || !staffId.trim() || ticketUsedThisSession || isWelcomeCouponBlockedToday(ticketForUse)) ? 'default' : 'pointer',
                    }}
                  >
                    {ticketConfirming ? '確定中…' : isWelcomeCouponBlockedToday(ticketForUse) ? '平日のみ利用可' : '使用確定'}
                  </button>
                )}
              </>
            )}

            <button onClick={handleReset} style={{ width: '100%', padding: '14px', borderRadius: 14, background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)', border: '1px solid rgba(201,162,74,0.44)', boxShadow: '0 4px 24px rgba(107,15,18,0.5)', color: '#F2E6C8', fontFamily: SERIF, fontSize: 14, fontWeight: 700, letterSpacing: '0.22em', cursor: 'pointer' }}>
              次のお客様
            </button>
          </div>
        )}

        {/* ===== MAINTENANCE-COUPON ===== */}
        {mainTab === 'issue' && phase === 'maintenance-coupon' && maintCouponData && (
          <div>
            {/* Customer card */}
            <div style={{ borderRadius: 20, overflow: 'hidden', background: 'linear-gradient(160deg, #1c0e08 0%, #0e0604 100%)', border: '1px solid rgba(100,200,100,0.38)', boxShadow: '0 0 25px rgba(100,200,100,0.12), 0 14px 44px rgba(0,0,0,0.75)', marginBottom: 16, animation: 'gj-slot-in 0.52s cubic-bezier(0.34,1.56,0.64,1) both' }}>
              <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, #0a3d1a 30%, #1a7a38 50%, #0a3d1a 70%, transparent)' }} />
              <div style={{ padding: '16px 20px' }}>
                <p style={{ fontSize: 8, letterSpacing: '0.28em', color: 'rgba(100,200,100,1)', marginBottom: 4 }}>MAINTENANCE COUPON</p>
                <h2 style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, color: '#F2E6C8', letterSpacing: '0.06em', marginBottom: 6, lineHeight: 1.1 }}>
                  {maintCouponPreview?.customer_name ?? maintCouponData.name ?? 'お客様'}<span style={{ fontSize: 14, marginLeft: 4, color: '#e5e5e5' }}>様</span>
                </h2>
                {maintCouponPreview && (
                  <p style={{ fontSize: 12, color: '#e5e5e5', letterSpacing: '0.04em' }}>
                    {maintCouponPreview.days_remaining === null
                      ? '来店記録なし'
                      : maintCouponPreview.days_remaining < 0
                        ? `前回来店から14日経過（期限切れ）`
                        : maintCouponPreview.days_remaining === 0
                          ? '14日サイクル：本日まで'
                          : `14日サイクル：あと${maintCouponPreview.days_remaining}日`}
                  </p>
                )}
              </div>
            </div>

            {/* Coupon detail card */}
            <div style={{ borderRadius: 16, background: 'linear-gradient(155deg, #060e07 0%, #040a04 100%)', border: `1px solid ${maintCouponTodayUsed ? 'rgba(224,96,80,0.36)' : maintCouponConfirmed ? 'rgba(100,200,100,0.44)' : 'rgba(100,200,100,0.28)'}`, overflow: 'hidden', marginBottom: 14 }}>
              <div style={{ height: 2, background: `linear-gradient(90deg, transparent, ${maintCouponConfirmed ? 'rgba(100,200,100,0.7)' : 'rgba(100,200,100,0.3)'}, transparent)` }} />
              <div style={{ padding: '16px 18px' }}>
                <p style={{ fontSize: 9, letterSpacing: '0.22em', color: 'rgba(100,200,100,1)', marginBottom: 8, fontFamily: SERIF }}>メンテナンスクーポン確認</p>
                <p style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#F2E6C8', marginBottom: 4 }}>
                  {maintCouponPreview?.menu.name ?? '銀二郎Only メンテナンスカット'}
                </p>
                <p style={{ fontSize: 13, color: '#e5e5e5', marginBottom: 6 }}>担当：{maintCouponPreview?.menu.stylist ?? '銀二郎'}</p>
                <p style={{ fontFamily: SERIF, fontWeight: 700, marginBottom: 8, lineHeight: 1, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 14, color: 'rgba(242,230,200,0.5)', textDecoration: 'line-through' }}>
                    ¥{(maintCouponPreview?.menu.normal_price ?? 3000).toLocaleString()}
                  </span>
                  <span style={{ fontSize: 24, color: '#C9A24A' }}>¥{(maintCouponPreview?.menu.member_price ?? 2500).toLocaleString()}</span>
                </p>
                {maintCouponConfirmed ? (
                  <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: 'rgba(100,200,100,0.15)', border: '1px solid rgba(100,200,100,0.5)', color: '#64D26E' }}>使用済み</span>
                ) : maintCouponTodayUsed ? (
                  <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 99, background: 'rgba(224,96,80,0.12)', border: '1px solid rgba(224,96,80,0.38)', color: '#E06050' }}>使用不可</span>
                ) : (
                  <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: 'rgba(100,210,110,0.08)', border: '1px solid rgba(100,210,110,0.3)', color: '#64D26E' }}>有効</span>
                )}
              </div>
            </div>

            {/* 使用不可の理由（サーバー側の判定結果）は下の maintCouponBlockMsg に表示 */}

            {/* 使用確定済み */}
            {maintCouponConfirmed && (
              <div style={{ borderRadius: 16, background: 'linear-gradient(135deg, rgba(15,50,22,0.6), rgba(8,35,15,0.8))', border: '1px solid rgba(80,192,90,0.38)', padding: '22px', textAlign: 'center', marginBottom: 14, boxShadow: '0 4px 36px rgba(80,192,80,0.14)' }}>
                <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(100,200,100,0.12)', border: '1px solid rgba(100,200,100,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', fontSize: 24 }}>✓</div>
                <p style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#80E060', marginBottom: 6 }}>使用確定しました</p>
                <p style={{ fontSize: 12, color: '#e5e5e5', lineHeight: 1.7 }}>
                  {maintCouponPreview?.menu.name ?? '銀二郎Only メンテナンスカット'} ¥{(maintCouponPreview?.menu.member_price ?? 2500).toLocaleString()}<br />
                  使用ログを記録しました（このQRは再利用できません）。
                </p>
                <p style={{ fontSize: 12, color: 'rgba(128,224,96,1)', marginTop: 10, lineHeight: 1.6 }}>
                  来店チェックイン完了<br />
                  <span style={{ fontSize: 10, color: 'rgba(128,224,96,1)' }}>メンテナンスカウントダウンをリセットしました</span>
                </p>
              </div>
            )}

            {/* エラーメッセージ */}
            {maintCouponBlockMsg && (
              <div style={{ borderRadius: 12, background: 'rgba(139,26,26,0.15)', border: '1px solid rgba(224,96,96,0.28)', padding: '10px 14px', marginBottom: 12 }}>
                <p style={{ fontSize: 12, color: '#E06060' }}>{maintCouponBlockMsg}</p>
              </div>
            )}

            {/* 担当者未選択 */}
            {!staffId.trim() && (
              <div style={{ borderRadius: 12, background: 'rgba(224,140,0,0.1)', border: '1px solid rgba(224,140,0,0.3)', padding: '10px 14px', marginBottom: 12 }}>
                <p style={{ fontSize: 11, color: '#E08C00' }}>担当者を選択してください</p>
              </div>
            )}

            {/* 使用確定ボタン */}
            {!maintCouponConfirmed && !maintCouponTodayUsed && (
              <button
                onClick={() => { void handleConfirmMaintenanceCoupon() }}
                disabled={maintCouponConfirming || !staffId.trim()}
                style={{
                  width: '100%', padding: '16px', borderRadius: 14, marginBottom: 10,
                  background: (maintCouponConfirming || !staffId.trim())
                    ? 'rgba(255,255,255,0.04)'
                    : 'linear-gradient(135deg, #0a3d1a 0%, #145a2a 60%, #1a7a38 100%)',
                  border: `1px solid ${(maintCouponConfirming || !staffId.trim()) ? 'rgba(255,255,255,0.08)' : 'rgba(100,200,100,0.44)'}`,
                  boxShadow: (maintCouponConfirming || !staffId.trim()) ? 'none' : '0 4px 20px rgba(20,90,42,0.45)',
                  color: (maintCouponConfirming || !staffId.trim()) ? '#999999' : '#D0F4D8',
                  fontFamily: SERIF, fontSize: 15, fontWeight: 700, letterSpacing: '0.18em',
                  cursor: (maintCouponConfirming || !staffId.trim()) ? 'default' : 'pointer',
                }}
              >
                {maintCouponConfirming ? '確定中…' : '使用確定'}
              </button>
            )}

            <button onClick={handleReset} style={{ width: '100%', padding: '14px', borderRadius: 14, background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)', border: '1px solid rgba(201,162,74,0.44)', boxShadow: '0 4px 24px rgba(107,15,18,0.5)', color: '#F2E6C8', fontFamily: SERIF, fontSize: 14, fontWeight: 700, letterSpacing: '0.22em', cursor: 'pointer' }}>
              次のお客様
            </button>
          </div>
        )}

        {/* ===== PREMIUM-COUPON ===== */}
        {mainTab === 'issue' && phase === 'premium-coupon' && premiumCouponData && (
          <div>
            <div style={{ borderRadius: 20, overflow: 'hidden', background: 'linear-gradient(160deg, #1A0E05 0%, #080404 100%)', border: `1px solid ${premiumCouponExpired ? 'rgba(224,96,80,0.38)' : 'rgba(201,162,74,0.42)'}`, boxShadow: '0 0 25px rgba(201,162,74,0.12), 0 14px 44px rgba(0,0,0,0.75)', marginBottom: 16, animation: 'gj-slot-in 0.52s cubic-bezier(0.34,1.56,0.64,1) both' }}>
              <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, #8B1A1A 25%, #C9A24A 50%, #8B1A1A 75%, transparent)' }} />
              <div style={{ padding: '16px 20px' }}>
                <p style={{ fontSize: 8, letterSpacing: '0.28em', color: 'rgba(201,162,74,0.9)', marginBottom: 4 }}>PREMIUM COUPON</p>
                <h2 style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, color: '#F2E6C8', letterSpacing: '0.06em', marginBottom: 6, lineHeight: 1.1 }}>
                  {premiumCouponData.name}<span style={{ fontSize: 14, marginLeft: 4, color: '#e5e5e5' }}>様</span>
                </h2>
                <p style={{ fontSize: 9, color: '#e5e5e5', letterSpacing: '0.06em' }}>
                  ID: {premiumCouponData.userId.slice(0, 22)}…
                </p>
              </div>
            </div>

            <div style={{ borderRadius: 16, background: 'linear-gradient(155deg, #100806 0%, #050303 100%)', border: `1px solid ${premiumCouponExpired ? 'rgba(224,96,80,0.36)' : 'rgba(201,162,74,0.30)'}`, overflow: 'hidden', marginBottom: 14 }}>
              <div style={{ height: 2, background: `linear-gradient(90deg, transparent, ${premiumCouponExpired ? 'rgba(224,96,80,0.6)' : 'rgba(201,162,74,0.64)'}, transparent)` }} />
              <div style={{ padding: '16px 18px' }}>
                <p style={{ fontSize: 9, letterSpacing: '0.22em', color: premiumCouponExpired ? '#E06050' : 'rgba(201,162,74,0.92)', marginBottom: 8, fontFamily: SERIF }}>
                  電話予約済み確認QR
                </p>
                <p style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: '#F2E6C8', marginBottom: 5 }}>
                  {premiumCouponData.title}
                </p>
                <p style={{ fontSize: 13, color: 'rgba(242,230,200,0.66)', lineHeight: 1.6, marginBottom: 12 }}>
                  {premiumCouponData.menuLabel}
                </p>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
                  {premiumCouponData.normalPrice !== undefined && premiumCouponData.normalPrice !== null && (
                    <span style={{ fontSize: 16, color: 'rgba(242,230,200,0.38)', textDecoration: 'line-through' }}>
                      ¥{premiumCouponData.normalPrice.toLocaleString()}
                    </span>
                  )}
                  <span style={{ fontFamily: SERIF, fontSize: 34, fontWeight: 700, color: '#C9A24A', lineHeight: 1 }}>
                    ¥{premiumCouponData.memberPrice.toLocaleString()}
                  </span>
                </div>
                <div style={{ display: 'grid', gap: 7, marginTop: 10 }}>
                  <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.74)', lineHeight: 1.6 }}>
                    スキンフェード＋顔剃り込み / 電話予約限定
                  </p>
                  <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.52)', lineHeight: 1.6 }}>
                    予約済み確認用のQRです。内容と価格を確認して、通常会計で処理してください。
                  </p>
                </div>
                <span style={{ display: 'inline-block', marginTop: 12, fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: premiumCouponExpired ? 'rgba(224,96,80,0.12)' : 'rgba(100,210,110,0.08)', border: `1px solid ${premiumCouponExpired ? 'rgba(224,96,80,0.38)' : 'rgba(100,210,110,0.3)'}`, color: premiumCouponExpired ? '#E06050' : '#64D26E' }}>
                  {premiumCouponExpired ? '期限切れ' : '有効'}
                </span>
              </div>
            </div>

            {premiumCouponExpired && (
              <div style={{ borderRadius: 12, background: 'rgba(139,26,26,0.15)', border: '1px solid rgba(224,96,96,0.28)', padding: '12px 16px', marginBottom: 14 }}>
                <p style={{ fontSize: 13, color: '#E06060', lineHeight: 1.7, fontFamily: SERIF }}>
                  このQRは有効期限が切れています。<br />
                  お客様にもう一度QRを表示してもらってください。
                </p>
              </div>
            )}

            <button onClick={handleReset} style={{ width: '100%', padding: '14px', borderRadius: 14, background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)', border: '1px solid rgba(201,162,74,0.44)', boxShadow: '0 4px 24px rgba(107,15,18,0.5)', color: '#F2E6C8', fontFamily: SERIF, fontSize: 14, fontWeight: 700, letterSpacing: '0.22em', cursor: 'pointer' }}>
              次のお客様
            </button>
          </div>
        )}

        {/* ===== RECOVERY TAB ===== */}
        {mainTab === 'recovery' && (
          <div>
            {/* Step: search */}
            {recoveryStep === 'search' && (
              <div>
                <div style={{ marginBottom: 20, borderRadius: 18, background: 'linear-gradient(155deg, #0D0805 0%, #080403 100%)', border: '1px solid rgba(201,162,74,0.14)', padding: '16px 18px' }}>
                  <p style={{ fontSize: 8, letterSpacing: '0.32em', color: '#e5e5e5', marginBottom: 8 }}>MEMBER RECOVERY</p>
                  <p style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: '#F2E6C8', marginBottom: 6, letterSpacing: '0.04em' }}>会員データ復旧</p>
                  <p style={{ fontSize: 11, color: '#e5e5e5', lineHeight: 1.7 }}>
                    お客様の名前で旧会員データを検索し、<br />新端末へ移管します。
                  </p>
                </div>

                <p style={{ fontSize: 9, letterSpacing: '0.22em', color: '#e5e5e5', marginBottom: 10 }}>お客様名で検索</p>
                <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                  <input
                    type="text"
                    value={recoveryQuery}
                    onChange={e => setRecoveryQuery(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void handleRecoverySearch() }}
                    placeholder="名前を入力"
                    style={{
                      flex: 1, padding: '14px 16px', borderRadius: 12,
                      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(201,162,74,0.22)',
                      color: '#F2E6C8', fontSize: 16, fontFamily: SERIF, outline: 'none', letterSpacing: '0.04em',
                    }}
                  />
                  <button
                    onClick={() => void handleRecoverySearch()}
                    disabled={!recoveryQuery.trim() || recoverySearching}
                    style={{
                      padding: '14px 20px', borderRadius: 12, flexShrink: 0,
                      background: recoveryQuery.trim() ? 'rgba(201,162,74,0.12)' : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${recoveryQuery.trim() ? 'rgba(201,162,74,0.4)' : 'rgba(255,255,255,0.09)'}`,
                      color: recoveryQuery.trim() ? '#C9A24A' : '#999999',
                      fontFamily: SERIF, fontSize: 14, fontWeight: 700, letterSpacing: '0.1em',
                      cursor: recoveryQuery.trim() ? 'pointer' : 'default',
                    }}
                  >
                    {recoverySearching ? '…' : '検索'}
                  </button>
                </div>

                {recoveryResults.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {recoveryResults.map(customer => (
                      <button
                        key={customer.id}
                        onClick={() => void handleSelectCustomer(customer)}
                        style={{
                          width: '100%', textAlign: 'left', padding: '14px 16px', borderRadius: 14,
                          background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(201,162,74,0.18)',
                          cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
                        }}
                      >
                        <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: '#F2E6C8', marginBottom: 3 }}>{customer.name}</p>
                        <p style={{ fontSize: 9, color: '#e5e5e5', letterSpacing: '0.06em' }}>
                          登録 {new Date(customer.created_at).toLocaleDateString('ja-JP')} ／ コード {customer.recovery_code}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
                {recoveryResults.length === 0 && recoveryQuery && !recoverySearching && (
                  <p style={{ fontSize: 12, color: '#e5e5e5', textAlign: 'center', padding: '20px 0', lineHeight: 1.7 }}>
                    該当する会員が見つかりません<br />
                    <span style={{ fontSize: 10 }}>初回来店時にスタッフ端末でQRスキャンすると登録されます</span>
                  </p>
                )}
              </div>
            )}

            {/* Step: detail */}
            {recoveryStep === 'detail' && selectedCustomer && (
              <div>
                <button
                  onClick={() => { setRecoveryStep('search'); setSelectedCustomer(null) }}
                  style={{ marginBottom: 16, padding: '8px 14px', borderRadius: 10, background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: '#e5e5e5', fontSize: 12, fontFamily: SERIF, cursor: 'pointer', letterSpacing: '0.1em' }}
                >
                  ← 検索に戻る
                </button>

                <div style={{ borderRadius: 18, background: 'linear-gradient(155deg, #130A07 0%, #0A0504 100%)', border: '1px solid rgba(201,162,74,0.32)', overflow: 'hidden', marginBottom: 18 }}>
                  <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, #8B1A1A 30%, #C9A24A 50%, #8B1A1A 70%, transparent)' }} />
                  <div style={{ padding: '18px 20px' }}>
                    <p style={{ fontSize: 8, letterSpacing: '0.28em', color: '#e5e5e5', marginBottom: 6 }}>CUSTOMER</p>
                    <p style={{ fontFamily: SERIF, fontSize: 24, fontWeight: 700, color: '#F2E6C8', marginBottom: 16 }}>
                      {selectedCustomer.name} <span style={{ fontSize: 14, color: '#e5e5e5' }}>様</span>
                    </p>
                    {([
                      { label: '登録日',       value: new Date(selectedCustomer.created_at).toLocaleDateString('ja-JP') },
                      { label: '復旧コード',   value: selectedCustomer.recovery_code, highlight: true },
                      { label: '前回来店日',   value: customerLastVisit === undefined ? '読込中…' : (customerLastVisit ?? '記録なし') },
                      { label: '保有チケット', value: customerTicketCount === null ? '読込中…' : `${customerTicketCount}枚` },
                    ] as { label: string; value: string; highlight?: boolean }[]).map(({ label, value, highlight }) => (
                      <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', paddingBottom: 10, marginBottom: 10, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                        <span style={{ fontSize: 10, color: '#e5e5e5', letterSpacing: '0.1em' }}>{label}</span>
                        <span style={{ fontFamily: SERIF, fontSize: highlight ? 17 : 14, fontWeight: 700, color: highlight ? '#C9A24A' : '#F2E6C8', letterSpacing: highlight ? '0.14em' : '0.04em' }}>{value}</span>
                      </div>
                    ))}
                    <p style={{ fontSize: 10, color: '#e5e5e5', lineHeight: 1.7, marginTop: 4 }}>
                      ※ 復旧コードをお客様に口頭確認してください
                    </p>
                  </div>
                </div>

                <button
                  onClick={() => { setRecoveryStep('scan'); setRecoveryError(null); setRecoveryScanError(null) }}
                  style={{
                    width: '100%', padding: '20px', borderRadius: 14,
                    background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
                    border: '1px solid rgba(201,162,74,0.44)',
                    boxShadow: '0 4px 20px rgba(107,15,18,0.45)',
                    color: '#F2E6C8', fontFamily: SERIF, fontSize: 18, fontWeight: 700, letterSpacing: '0.18em', cursor: 'pointer',
                  }}
                >
                  新端末のQRをスキャン
                </button>
              </div>
            )}

            {/* Step: scan (new device) */}
            {recoveryStep === 'scan' && (
              <div>
                <button
                  onClick={() => { setRecoveryStep('detail'); setRecoveryScanError(null) }}
                  style={{ marginBottom: 16, padding: '8px 14px', borderRadius: 10, background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: '#e5e5e5', fontSize: 12, fontFamily: SERIF, cursor: 'pointer', letterSpacing: '0.1em' }}
                >
                  ← 戻る
                </button>

                <div style={{ marginBottom: 14, padding: '12px 16px', borderRadius: 12, background: 'rgba(201,162,74,0.06)', border: '1px solid rgba(201,162,74,0.18)' }}>
                  <p style={{ fontSize: 11, color: '#e5e5e5', lineHeight: 1.7 }}>
                    新しい端末でパスポートアプリを開き、<br />マイページのQRコードを読み取ってください。
                  </p>
                </div>

                {recoveryScanError && (
                  <div style={{ borderRadius: 10, background: 'rgba(139,26,26,0.15)', border: '1px solid rgba(224,96,96,0.28)', padding: '8px 12px', marginBottom: 12 }}>
                    <p style={{ fontSize: 11, color: '#E06060' }}>{recoveryScanError}</p>
                  </div>
                )}

                <div style={{ marginBottom: 16 }}>
                  <QrCameraScanner
                    elId={QR_RECOVERY_EL_ID}
                    onScan={text => handleRecoveryQrScan(text)}
                    onCameraError={msg => setRecoveryScanError(msg)}
                  />
                </div>

                <p style={{ textAlign: 'center', fontSize: 10, color: '#e5e5e5', letterSpacing: '0.1em', marginBottom: 10 }}>または直接入力</p>

                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={recoveryManualInput}
                    onChange={e => setRecoveryManualInput(e.target.value)}
                    placeholder="u-xxxxxx-xxxxxx"
                    style={{
                      flex: 1, padding: '12px 14px', borderRadius: 10,
                      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)',
                      color: '#F2E6C8', fontSize: 12, fontFamily: 'monospace', outline: 'none',
                    }}
                  />
                  <button
                    onClick={() => {
                      const uid = recoveryManualInput.trim()
                      if (uid) {
                        handleRecoveryQrScan(JSON.stringify({ type: 'ginjiro-member', userId: uid, name: '' }))
                        setRecoveryManualInput('')
                      }
                    }}
                    disabled={!recoveryManualInput.trim()}
                    style={{
                      padding: '12px 16px', borderRadius: 10, flexShrink: 0,
                      background: recoveryManualInput.trim() ? 'rgba(40,80,20,0.5)' : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${recoveryManualInput.trim() ? 'rgba(120,180,80,0.4)' : 'rgba(255,255,255,0.1)'}`,
                      color: recoveryManualInput.trim() ? '#C8F0A0' : '#999999',
                      fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.1em',
                      cursor: recoveryManualInput.trim() ? 'pointer' : 'default',
                    }}
                  >
                    確定
                  </button>
                </div>
              </div>
            )}

            {/* Step: done */}
            {recoveryStep === 'done' && (
              <div style={{ textAlign: 'center', paddingTop: 40 }}>
                <div style={{ width: 80, height: 80, borderRadius: '50%', background: 'radial-gradient(circle, rgba(80,192,80,0.16) 0%, rgba(20,100,40,0.1) 60%, transparent 100%)', border: '1.5px solid rgba(100,200,100,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 22px', boxShadow: '0 0 32px rgba(80,192,80,0.28)' }}>
                  <span style={{ fontSize: 36, color: '#64D26E', lineHeight: 1 }}>✓</span>
                </div>
                <p style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, color: '#80E060', marginBottom: 16, letterSpacing: '0.08em' }}>復旧完了</p>
                <p style={{ fontSize: 13, color: '#F2E6C8', lineHeight: 1.9, marginBottom: 8 }}>
                  {selectedCustomer?.name}様のデータを<br />新端末へ移管しました。
                </p>
                <p style={{ fontSize: 11, color: '#e5e5e5', lineHeight: 1.7, marginBottom: 32 }}>
                  新端末でアプリを再読み込みすると<br />チケット・来店履歴が復旧されます。
                </p>
                <button
                  onClick={handleRecoveryReset}
                  style={{ padding: '16px 40px', borderRadius: 14, background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)', border: '1px solid rgba(201,162,74,0.44)', color: '#F2E6C8', fontFamily: SERIF, fontSize: 16, fontWeight: 700, letterSpacing: '0.18em', cursor: 'pointer' }}
                >
                  続けて復旧する
                </button>
              </div>
            )}
          </div>
        )}

      </main>

      {/* ── Fixed bottom: 次のお客様 / 発行する ── */}
      {mainTab === 'issue' && phase === 'result' && scannedData && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 100,
          background: 'linear-gradient(0deg, rgba(6,2,1,0.99) 0%, rgba(6,2,1,0.92) 70%, transparent 100%)',
          padding: '14px 20px calc(14px + env(safe-area-inset-bottom, 0px))',
        }}>
          <div style={{ display: 'flex', gap: 10, maxWidth: 480, margin: '0 auto' }}>
            <button
              type="button"
              onClick={handleReset}
              style={{
                flex: '0 0 34%', height: 66, borderRadius: 18,
                background: 'rgba(255,255,255,0.045)',
                border: '1.5px solid rgba(255,255,255,0.14)',
                color: '#e5e5e5',
                fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.12em',
                cursor: 'pointer',
              }}
            >
              次のお客様
            </button>
            <button
              onClick={handleIssueClick}
              disabled={!canIssue}
              style={{
                flex: 1, height: 66, borderRadius: 18,
                background: canIssue
                  ? 'linear-gradient(90deg, #800c14 0%, #3a0307 100%)'
                  : 'rgba(255,255,255,0.04)',
                border: `2px solid ${canIssue ? '#e6ca65' : 'rgba(255,255,255,0.07)'}`,
                boxShadow: canIssue
                  ? ['0 0 32px rgba(128,12,20,0.72)', '0 0 64px rgba(128,12,20,0.36)', 'inset 0 1px 0 rgba(230,202,101,0.28)', 'inset 0 -1px 0 rgba(230,202,101,0.1)', '0 6px 32px rgba(0,0,0,0.85)'].join(', ')
                  : 'none',
                color: canIssue ? '#F2E6C8' : '#999999',
                fontFamily: SERIF, fontSize: 21, fontWeight: 700, letterSpacing: '0.22em',
                cursor: canIssue ? 'pointer' : 'default',
                animation: canIssue ? 'gj-pulse-red 2.8s ease-in-out infinite' : 'none',
                transition: 'background 0.2s, border-color 0.2s',
              }}
            >
              {issueLoading ? '発行中…' : '発行する'}
            </button>
          </div>
        </div>
      )}

      {/* ── Recovery confirm modal ── */}
      {mainTab === 'recovery' && recoveryStep === 'confirm' && selectedCustomer && recoveryNewUserId && (
        <div
          onClick={() => { setRecoveryStep('scan'); setRecoveryError(null) }}
          style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 20px' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 440, borderRadius: 24, background: 'linear-gradient(160deg, #160A07 0%, #0A0504 100%)', border: '1px solid rgba(201,162,74,0.32)', boxShadow: '0 32px 80px rgba(0,0,0,0.9)', overflow: 'hidden' }}
          >
            <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, #8B1A1A 30%, #C9A24A 50%, #8B1A1A 70%, transparent)' }} />
            <div style={{ padding: '28px 26px 24px' }}>
              <p style={{ fontSize: 9, letterSpacing: '0.34em', color: '#e5e5e5', marginBottom: 10, textAlign: 'center' }}>CONFIRM RECOVERY</p>
              <p style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#F2E6C8', textAlign: 'center', marginBottom: 22 }}>
                会員データを復旧します
              </p>

              <div style={{ borderRadius: 14, background: 'rgba(201,162,74,0.04)', border: '1px solid rgba(201,162,74,0.16)', padding: '16px 18px', marginBottom: 16 }}>
                {([
                  { label: '会員名', value: `${selectedCustomer.name} 様` },
                  { label: '旧ID',   value: selectedCustomer.user_id.slice(0, 18) + '…' },
                  { label: '新ID',   value: recoveryNewUserId.slice(0, 18) + '…' },
                  { label: '担当',   value: staffId || '未設定' },
                ] as { label: string; value: string }[]).map(({ label, value }) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', paddingBottom: 8, marginBottom: 8, borderBottom: '1px solid rgba(201,162,74,0.08)' }}>
                    <span style={{ fontSize: 10, color: '#e5e5e5', letterSpacing: '0.1em' }}>{label}</span>
                    <span style={{ fontFamily: SERIF, fontSize: 14, fontWeight: 700, color: '#F2E6C8', wordBreak: 'break-all', maxWidth: '65%', textAlign: 'right' }}>{value}</span>
                  </div>
                ))}

                <div style={{ marginTop: 10 }}>
                  <p style={{ fontSize: 10, color: '#e5e5e5', letterSpacing: '0.1em', marginBottom: 8 }}>復旧理由</p>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {['機種変更', 'Safariデータ削除', 'その他'].map(reason => (
                      <button
                        key={reason}
                        onClick={() => setRecoveryReason(reason)}
                        style={{
                          flex: 1, padding: '8px 4px', borderRadius: 8,
                          background: recoveryReason === reason ? 'rgba(201,162,74,0.15)' : 'rgba(255,255,255,0.03)',
                          border: `1px solid ${recoveryReason === reason ? 'rgba(201,162,74,0.5)' : 'rgba(255,255,255,0.08)'}`,
                          color: recoveryReason === reason ? '#C9A24A' : '#e5e5e5',
                          fontSize: 10, fontFamily: SERIF, letterSpacing: '0.04em', cursor: 'pointer',
                        }}
                      >
                        {reason}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {recoveryError && (
                <div style={{ borderRadius: 10, background: 'rgba(139,26,26,0.15)', border: '1px solid rgba(224,96,96,0.28)', padding: '8px 12px', marginBottom: 14 }}>
                  <p style={{ fontSize: 11, color: '#E06060' }}>{recoveryError}</p>
                </div>
              )}

              <p style={{ fontSize: 11, color: '#e5e5e5', textAlign: 'center', marginBottom: 20, lineHeight: 1.7 }}>
                旧端末のチケット・来店履歴・使用ログが<br />すべて新端末に移管されます。
              </p>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => { setRecoveryStep('scan'); setRecoveryError(null) }}
                  disabled={recoveryLoading}
                  style={{ flex: 1, padding: '14px 0', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', fontSize: 13, color: '#e5e5e5', fontFamily: SERIF, letterSpacing: '0.14em', cursor: 'pointer' }}
                >
                  キャンセル
                </button>
                <button
                  onClick={() => void handleRecoveryExecute()}
                  disabled={recoveryLoading || !staffId.trim()}
                  style={{
                    flex: 2, padding: '14px 0', borderRadius: 14,
                    background: recoveryLoading ? 'rgba(20,60,30,0.5)' : 'linear-gradient(135deg, #0a3d1a 0%, #145a2a 60%, #1a7a38 100%)',
                    border: `1px solid ${recoveryLoading ? 'rgba(100,200,100,0.12)' : 'rgba(100,200,100,0.44)'}`,
                    boxShadow: recoveryLoading ? 'none' : '0 4px 20px rgba(20,90,42,0.45)',
                    fontSize: 15, fontWeight: 700,
                    color: recoveryLoading ? '#999999' : '#D0F4D8',
                    fontFamily: SERIF, letterSpacing: '0.18em',
                    cursor: recoveryLoading ? 'default' : 'pointer',
                  }}
                >
                  {recoveryLoading ? '移管中…' : '復旧実行'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirmation modal ── */}
      {showConfirm && scannedData && (
        <div
          onClick={() => setShowConfirm(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 20px' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 440, borderRadius: 24, background: 'linear-gradient(160deg, #160A07 0%, #0A0504 100%)', border: '1px solid rgba(201,162,74,0.32)', boxShadow: '0 32px 80px rgba(0,0,0,0.9)', overflow: 'hidden' }}
          >
            <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, #8B1A1A 30%, #C9A24A 50%, #8B1A1A 70%, transparent)' }} />
            <div style={{ padding: '28px 26px 24px' }}>
              <p style={{ fontSize: 9, letterSpacing: '0.34em', color: '#e5e5e5', marginBottom: 10, textAlign: 'center' }}>CONFIRM ISSUE</p>
              <p style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#F2E6C8', textAlign: 'center', marginBottom: 22 }}>
                {currentTab.autoTitle}を発行します
              </p>

              {/* Issue details */}
              <div style={{ borderRadius: 14, background: 'rgba(201,162,74,0.05)', border: '1px solid rgba(201,162,74,0.18)', padding: '16px 18px', marginBottom: 18 }}>
                {[
                  { label: 'お客様', value: `${scannedData.name} 様` },
                  { label: '種別',   value: currentTab.autoTitle },
                  { label: '金額',   value: `¥${effectiveAmount.toLocaleString()}` },
                  { label: '枚数',   value: `${quantity}枚` },
                  { label: '担当',   value: staffId },
                ].map(({ label, value }) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', paddingBottom: 8, marginBottom: 8, borderBottom: '1px solid rgba(201,162,74,0.09)' }}>
                    <span style={{ fontSize: 10, color: '#e5e5e5', letterSpacing: '0.1em' }}>{label}</span>
                    <span style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: '#F2E6C8' }}>{value}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 10, color: '#e5e5e5', letterSpacing: '0.1em' }}>合計</span>
                  <span style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: '#C9A24A' }}>
                    ¥{(effectiveAmount * quantity).toLocaleString()}
                  </span>
                </div>
              </div>

              <p style={{ fontSize: 11, color: '#e5e5e5', textAlign: 'center', lineHeight: 1.75, marginBottom: 22, letterSpacing: '0.04em' }}>
                この操作は店舗端末に記録されます。{'\n'}内容を確認してから発行してください。
              </p>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => setShowConfirm(false)}
                  style={{ flex: 1, padding: '14px 0', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', fontSize: 13, color: '#e5e5e5', fontFamily: SERIF, letterSpacing: '0.14em', cursor: 'pointer' }}
                >
                  キャンセル
                </button>
                <button
                  onClick={() => { void handleIssueTicket() }}
                  style={{ flex: 2, padding: '14px 0', borderRadius: 14, background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)', border: '1px solid rgba(201,162,74,0.50)', boxShadow: '0 4px 24px rgba(107,15,18,0.5)', fontSize: 15, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF, letterSpacing: '0.18em', cursor: 'pointer' }}
                >
                  発行する
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Use confirm modal ── */}
      {showUseConfirm && pendingUseTicket && scannedData && (
        <div
          onClick={() => { if (!useConfirmLoading) { setShowUseConfirm(false); setPendingUseTicket(null); setUseError(null) } }}
          style={{ position: 'fixed', inset: 0, zIndex: 420, background: 'rgba(0,0,0,0.90)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 20px' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 440, borderRadius: 24, background: 'linear-gradient(160deg, #060e07 0%, #040a04 100%)', border: '1px solid rgba(100,200,100,0.28)', boxShadow: '0 32px 80px rgba(0,0,0,0.92)', overflow: 'hidden' }}
          >
            <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, #0a3d1a 30%, #1a7a38 50%, #0a3d1a 70%, transparent)' }} />
            <div style={{ padding: '28px 26px 24px' }}>
              <p style={{ fontSize: 9, letterSpacing: '0.34em', color: 'rgba(100,200,100,1)', marginBottom: 10, textAlign: 'center' }}>CONFIRM USE</p>
              <p style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#F2E6C8', textAlign: 'center', marginBottom: 22 }}>
                チケットを使用します
              </p>

              <div style={{ borderRadius: 14, background: 'rgba(100,200,100,0.04)', border: '1px solid rgba(100,200,100,0.16)', padding: '16px 18px', marginBottom: 16 }}>
                {([
                  { label: 'お客様', value: `${scannedData.name} 様` },
                  { label: '種別',   value: TICKET_TYPE_LABELS[pendingUseTicket.type] },
                  ...(pendingUseTicket.amount > 0 ? [{ label: '金額', value: `¥${pendingUseTicket.amount.toLocaleString()}` }] : []),
                  { label: '担当',   value: staffId },
                ] as { label: string; value: string }[]).map(({ label, value }) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', paddingBottom: 8, marginBottom: 8, borderBottom: '1px solid rgba(100,200,100,0.08)' }}>
                    <span style={{ fontSize: 10, color: '#e5e5e5', letterSpacing: '0.1em' }}>{label}</span>
                    <span style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: '#F2E6C8' }}>{value}</span>
                  </div>
                ))}
                <p style={{ fontSize: 10, color: '#e5e5e5', lineHeight: 1.7, letterSpacing: '0.04em' }}>
                  この操作は取り消せません。
                </p>
              </div>

              {useError && (
                <div style={{ borderRadius: 10, background: 'rgba(139,26,26,0.15)', border: '1px solid rgba(224,96,96,0.28)', padding: '8px 12px', marginBottom: 14 }}>
                  <p style={{ fontSize: 11, color: '#E06060' }}>{useError}</p>
                </div>
              )}

              <p style={{ fontSize: 11, color: '#e5e5e5', textAlign: 'center', marginBottom: 20, letterSpacing: '0.04em' }}>
                本当に使用しますか？
              </p>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => { setShowUseConfirm(false); setPendingUseTicket(null); setUseError(null) }}
                  disabled={useConfirmLoading}
                  style={{ flex: 1, padding: '14px 0', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', fontSize: 13, color: '#e5e5e5', fontFamily: SERIF, letterSpacing: '0.14em', cursor: 'pointer' }}
                >
                  キャンセル
                </button>
                <button
                  onClick={() => { void handleConfirmUse() }}
                  disabled={useConfirmLoading}
                  style={{
                    flex: 2, padding: '14px 0', borderRadius: 14,
                    background: useConfirmLoading ? 'rgba(20,60,30,0.5)' : 'linear-gradient(135deg, #0a3d1a 0%, #145a2a 60%, #1a7a38 100%)',
                    border: `1px solid ${useConfirmLoading ? 'rgba(100,200,100,0.12)' : 'rgba(100,200,100,0.44)'}`,
                    boxShadow: useConfirmLoading ? 'none' : '0 4px 20px rgba(20,90,42,0.45)',
                    fontSize: 15, fontWeight: 700,
                    color: useConfirmLoading ? '#999999' : '#D0F4D8',
                    fontFamily: SERIF, letterSpacing: '0.18em',
                    cursor: useConfirmLoading ? 'default' : 'pointer',
                  }}
                >
                  {useConfirmLoading ? '確定中…' : '使用確定'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Use complete overlay ── */}
      {showUseComplete && useCompleteInfo && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 510, display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'gj-success-fade 3.5s ease-in-out both' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(4,8,4,0.97)' }} />
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', boxShadow: 'inset 0 0 120px rgba(80,192,80,0.16), inset 0 0 60px rgba(0,100,40,0.12)' }} />
          <div style={{ position: 'relative', textAlign: 'center', padding: '32px 28px', maxWidth: 380, animation: 'gj-success-pop 0.55s cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <div style={{ width: 84, height: 84, borderRadius: '50%', margin: '0 auto 22px', background: 'radial-gradient(circle, rgba(80,192,80,0.16) 0%, rgba(20,100,40,0.1) 60%, transparent 100%)', border: '1.5px solid rgba(100,200,100,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 32px rgba(80,192,80,0.28), 0 0 64px rgba(80,192,80,0.12)' }}>
              <span style={{ fontSize: 38, color: '#64D26E', lineHeight: 1 }}>✓</span>
            </div>
            <p style={{ fontSize: 10, letterSpacing: '0.44em', color: 'rgba(100,200,100,1)', marginBottom: 14 }}>USED</p>
            <p style={{ fontFamily: SERIF, fontSize: 34, fontWeight: 700, color: '#80E060', letterSpacing: '0.14em', marginBottom: 18, lineHeight: 1.1, textShadow: '0 0 40px rgba(80,192,80,0.4), 0 2px 6px rgba(0,0,0,0.95)' }}>
              使用完了
            </p>
            <p style={{ fontFamily: SERIF, fontSize: 16, color: '#F2E6C8', lineHeight: 1.9, letterSpacing: '0.04em', textShadow: '0 1px 10px rgba(0,0,0,0.95)', marginBottom: 16 }}>
              {useCompleteInfo.name}様の<br />
              {useCompleteInfo.label}{useCompleteInfo.amount > 0 ? ` ¥${useCompleteInfo.amount.toLocaleString()}` : ''} を<br />
              1枚使用しました。
            </p>
            <p style={{ fontFamily: SERIF, fontSize: 14, color: '#e5e5e5', letterSpacing: '0.06em' }}>
              残り：{useCompleteInfo.remaining}枚
            </p>
            {useCompleteInfo.checkedIn && (
              <p style={{ fontFamily: SERIF, fontSize: 12, color: 'rgba(128,224,96,1)', marginTop: 14, letterSpacing: '0.08em' }}>
                来店チェックインも完了しました
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Success overlay ── */}
      {showSuccess && successInfo && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'gj-success-fade 2.5s ease-in-out both' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(6,2,1,0.97)' }} />
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', boxShadow: 'inset 0 0 120px rgba(201,162,74,0.32), inset 0 0 60px rgba(139,26,26,0.28)' }} />
          <div style={{ position: 'relative', textAlign: 'center', padding: '32px 28px', maxWidth: 380, animation: 'gj-success-pop 0.55s cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <div style={{ width: 84, height: 84, borderRadius: '50%', margin: '0 auto 22px', background: 'radial-gradient(circle, rgba(201,162,74,0.18) 0%, rgba(139,26,26,0.12) 60%, transparent 100%)', border: '1.5px solid rgba(201,162,74,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 32px rgba(201,162,74,0.38), 0 0 64px rgba(201,162,74,0.18)' }}>
              <span style={{ fontSize: 38, color: '#e6ca65', lineHeight: 1 }}>✓</span>
            </div>
            <p style={{ fontSize: 10, letterSpacing: '0.44em', color: '#e5e5e5', marginBottom: 14 }}>ISSUED</p>
            <p style={{ fontFamily: SERIF, fontSize: 40, fontWeight: 700, color: '#e6ca65', letterSpacing: '0.14em', marginBottom: 20, lineHeight: 1.1, textShadow: '0 0 40px rgba(201,162,74,0.55), 0 0 80px rgba(139,26,26,0.4), 0 2px 6px rgba(0,0,0,0.95)' }}>
              発行完了
            </p>
            <p style={{ fontFamily: SERIF, fontSize: 16, color: '#F2E6C8', lineHeight: 1.9, letterSpacing: '0.06em', textShadow: '0 1px 10px rgba(0,0,0,0.95)', marginBottom: 14 }}>
              {successInfo.name}様に<br />
              {successInfo.label} ¥{successInfo.amount.toLocaleString()} × {successInfo.qty}枚<br />
              を付与しました。
            </p>
            <div style={{ padding: '10px 16px', borderRadius: 10, background: 'rgba(201,162,74,0.08)', border: '1px solid rgba(201,162,74,0.22)' }}>
              <p style={{ fontSize: 10, color: '#e5e5e5', letterSpacing: '0.08em', lineHeight: 1.6 }}>
                割引券発行ログを店舗端末に通知しました
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Staff Picker Modal ── */}
      {showStaffPicker && (
        <div onClick={() => setShowStaffPicker(false)} style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 500, background: 'linear-gradient(180deg, #0D0403 0%, #0A0302 100%)', border: '1px solid rgba(201,162,74,0.32)', borderRadius: 22, boxShadow: '0 32px 80px rgba(0,0,0,0.92)', overflow: 'hidden' }}>
            <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, #8B1A1A 30%, #C9A24A 50%, #8B1A1A 70%, transparent)' }} />
            <div style={{ padding: '22px 24px 18px', textAlign: 'center', borderBottom: '1px solid rgba(201,162,74,0.1)' }}>
              <p style={{ fontSize: 9, letterSpacing: '0.34em', color: '#e5e5e5', marginBottom: 6 }}>STAFF SELECTION</p>
              <h2 style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#F2E6C8', letterSpacing: '0.08em' }}>担当者を選んでください</h2>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: '18px 18px 14px' }}>
              {STAFF_NAMES.map(name => {
                const selected = staffId === name
                return (
                  <button
                    key={name}
                    onClick={() => handleSelectStaff(name)}
                    style={{
                      padding: '22px 10px', borderRadius: 14,
                      background: selected ? 'linear-gradient(135deg, rgba(139,26,26,0.7) 0%, rgba(107,15,18,0.85) 100%)' : 'rgba(0,0,0,0.5)',
                      border: `1.5px solid ${selected ? 'rgba(201,162,74,0.80)' : 'rgba(201,162,74,0.20)'}`,
                      boxShadow: selected ? '0 0 20px rgba(201,162,74,0.18)' : 'none',
                      color: selected ? '#F2E6C8' : '#e5e5e5',
                      fontFamily: SERIF, fontSize: 22, fontWeight: 700, letterSpacing: '0.04em',
                      cursor: 'pointer', transition: 'all 0.15s', WebkitTapHighlightColor: 'transparent',
                    }}
                  >
                    {name}
                    {selected && <span style={{ display: 'block', fontSize: 10, color: '#e5e5e5', letterSpacing: '0.16em', marginTop: 4, fontWeight: 400 }}>選択中</span>}
                  </button>
                )
              })}
            </div>
            <div style={{ padding: '0 18px 18px' }}>
              <button onClick={() => setShowStaffPicker(false)} style={{ width: '100%', padding: '14px', borderRadius: 12, background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: '#e5e5e5', fontFamily: SERIF, fontSize: 14, cursor: 'pointer', letterSpacing: '0.12em' }}>
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 営業開始／営業終了 確認モーダル ── */}
    </div>
  )
}
