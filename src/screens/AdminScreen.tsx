import { useState, useRef, useCallback, useEffect } from 'react'
import { Html5Qrcode } from 'html5-qrcode'
import { QRCodeSVG } from 'qrcode.react'
import { supabase } from '../lib/supabase'
import { getStoredValue, setStoredValue } from '../utils/storage'
import type { TicketRow, TicketType } from '../data/ticket'
import { TICKET_TYPE_LABELS, TICKET_TYPE_COLORS } from '../data/ticket'
import { issueTicket, getUserTickets, markTicketUsed } from '../utils/ticketStore'
import { getJapanDateString } from '../utils/dateUtils'
import { upsertCustomer, searchCustomersByName, recoverMember } from '../utils/customerStore'
import type { CustomerRow } from '../utils/customerStore'
import { isStaging } from '../utils/env'
import { StgBadge } from '../components/StgBadge'
import { getLiveStatuses, setLiveStatus, subscribeLiveStatuses } from '../utils/liveStatusStore'
import {
  LIVE_STATUS_CODES, LIVE_STATUS_THEME,
  liveStatusLabel, liveStatusPulseClass, liveStatusSignpoleClass, nextLiveStatus,
} from '../data/liveStatus'
import '../components/liveStatusSignpole.css'
import type { LiveStatusRow } from '../data/liveStatus'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const STAFF_NAME_KEY        = 'ginjiro_staff_name'
const MAINTENANCE_LOCAL_KEY = 'ginjiro_maintenance_visits'
const STAFF_NAMES  = ['テイテイ', 'ヨンピル', '銀二郎', 'シルビア', 'リアン', 'キャンディ', 'ヒョウ']
const MAX_QTY      = 30
const QTY_PRESETS  = [1, 2, 3, 5, 10, 30]

const TICKET_TABS: { type: TicketType; label: string; autoTitle: string }[] = [
  { type: 'discount', label: '割引券',   autoTitle: '割引券' },
  { type: 'otoku',    label: '漢トク券', autoTitle: '漢トク券' },
]

// ── Usage log (ticket consumption) ───────────────────────────────────────────

interface UsageLogEntry {
  id: string
  used_at: string
  usage_date: string
  staff_name: string
  customer_name: string
  user_id: string
  ticket_id: string | null
  ticket_type: string
  amount: number
  terminal: string
  status: string
}

async function saveUsageLog(entry: Omit<UsageLogEntry, 'id' | 'used_at'>): Promise<void> {
  try {
    await supabase.from('ticket_usage_logs').insert({
      ...entry,
      used_at: new Date().toISOString(),
    })
  } catch { /* non-fatal: log failure must not block UI */ }
}

/** JST 当日に userId が1件でも使用済みなら true（種別を問わず） */
async function fetchTodayUsed(userId: string, today: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('ticket_usage_logs')
      .select('id')
      .eq('user_id', userId)
      .eq('usage_date', today)
      .eq('status', 'used')
      .limit(1)
    if (!error && data) return data.length > 0
  } catch { /* table may not exist yet — treat as no restriction */ }
  return false
}

// ── Issue log ─────────────────────────────────────────────────────────────────

interface IssueLogEntry {
  id: string
  issued_at: string
  staff_name: string
  customer_name: string
  user_id: string
  ticket_type: string
  amount: number
  quantity: number
  terminal: string
  status: string
}

async function saveIssueLog(entry: Omit<IssueLogEntry, 'id' | 'issued_at'>): Promise<void> {
  try {
    await supabase.from('ticket_issue_logs').insert({
      ...entry,
      issued_at: new Date().toISOString(),
    })
  } catch { /* non-fatal */ }
}

async function fetchRecentLogs(limit = 12): Promise<IssueLogEntry[]> {
  try {
    const { data, error } = await supabase
      .from('ticket_issue_logs')
      .select('*')
      .order('issued_at', { ascending: false })
      .limit(limit)
    if (!error && data) return data as IssueLogEntry[]
  } catch { /* ignore */ }
  return []
}

function fmtLogTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ── Sound ─────────────────────────────────────────────────────────────────────

function playSuccessSound() {
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

// ── Supabase: maintenance_visits ──────────────────────────────────────────────

async function fetchLastVisitDate(userId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('maintenance_visits')
      .select('last_visit_date')
      .eq('user_id', userId)
      .single()
    if (!error && data) return (data as { last_visit_date: string }).last_visit_date
  } catch { /* fall through */ }
  const local = getStoredValue<Record<string, string>>(MAINTENANCE_LOCAL_KEY, {})
  return local[userId] ?? null
}

async function upsertLastVisitDate(userId: string, date: string): Promise<void> {
  try {
    await supabase
      .from('maintenance_visits')
      .upsert(
        { user_id: userId, last_visit_date: date, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' },
      )
  } catch { /* non-fatal */ }
  const local = getStoredValue<Record<string, string>>(MAINTENANCE_LOCAL_KEY, {})
  setStoredValue(MAINTENANCE_LOCAL_KEY, { ...local, [userId]: date })
}

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

interface PassportQRData {
  type: string
  userId: string
  name: string
}

interface TicketUseQRData {
  type: 'ginjiro-ticket-use'
  userId: string
  selectedTicketId: string
  issuedAt: string
  expiresAt: string
}

interface MaintenanceCouponQRData {
  type: 'ginjiro-maintenance-coupon'
  userId: string
  name: string
}

type AnyQRData = PassportQRData | TicketUseQRData | MaintenanceCouponQRData

const STORE_CHECKIN_QR_VALUE = JSON.stringify({ type: 'ginjiro-store-checkin' })

function parseQR(text: string): AnyQRData | null {
  try {
    const d = JSON.parse(text)
    if (d.type === 'ginjiro-ticket-use' && d.userId && d.selectedTicketId) return d as TicketUseQRData
    if (d.type === 'ginjiro-maintenance-coupon' && d.userId) return d as MaintenanceCouponQRData
    if ((d.type === 'ginjiro-member' || d.type === 'otokomae-passport') && d.userId) {
      return { type: d.type, userId: d.userId, name: d.name || '名前未設定' }
    }
    return null
  } catch { return null }
}

// ── Phase ─────────────────────────────────────────────────────────────────────

type Phase = 'scan' | 'loading' | 'result' | 'ticket-loading' | 'ticket-result' | 'maintenance-coupon'

// ── QR Camera Scanner ─────────────────────────────────────────────────────────

const QR_EL_ID          = 'gj-qr-reader'
const QR_RECOVERY_EL_ID = 'gj-qr-reader-recovery'

async function haltScanner(scanner: Html5Qrcode): Promise<void> {
  try { if (scanner.isScanning) await scanner.stop(); scanner.clear() } catch { /* ignore */ }
}

function QrCameraScanner({
  onScan,
  onCameraError,
  elId = QR_EL_ID,
}: {
  onScan: (t: string) => void
  onCameraError: (m: string) => void
  elId?: string
}) {
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const [active, setActive] = useState(false)

  function claimScanner(): Html5Qrcode | null {
    const s = scannerRef.current; scannerRef.current = null; return s
  }

  const stop = useCallback(() => {
    const s = claimScanner(); if (!s) return
    setActive(false); void haltScanner(s)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
          setActive(false); void haltScanner(s).then(() => onScan(decoded))
        },
        undefined,
      )
      setActive(true)
    } catch {
      const s = claimScanner(); if (s) void haltScanner(s)
      onCameraError('カメラにアクセスできません。手動入力をご利用ください。')
    }
  }, [onScan, onCameraError, elId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { const s = claimScanner(); if (s) void haltScanner(s) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div id={elId} style={{ width: '100%', minHeight: active ? 280 : 0, borderRadius: active ? 16 : 0, overflow: 'hidden', marginBottom: active ? 12 : 0 }} />
      {!active ? (
        <button onClick={() => { void start() }} style={{ width: '100%', padding: '20px', borderRadius: 14, background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)', border: '1px solid rgba(201,162,74,0.44)', boxShadow: '0 4px 20px rgba(107,15,18,0.45)', color: '#F2E6C8', fontFamily: SERIF, fontSize: 20, fontWeight: 700, letterSpacing: '0.2em', cursor: 'pointer' }}>
          QRを読み取る
        </button>
      ) : (
        <button onClick={stop} style={{ width: '100%', padding: '14px', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(242,230,200,0.6)', fontFamily: SERIF, fontSize: 13, fontWeight: 600, letterSpacing: '0.14em', cursor: 'pointer' }}>
          スキャン停止
        </button>
      )}
    </div>
  )
}

// ── AdminScreen ───────────────────────────────────────────────────────────────

export function AdminScreen() {
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
  const [todayUsedThisDay, setTodayUsedThisDay]   = useState(false)
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

  // Checkin
  const [checkInStatus, setCheckInStatus] = useState<'idle' | 'loading' | 'done'>('idle')
  const [checkInDate, setCheckInDate]     = useState<string | null>(null)

  // Store QR
  const [showStoreQr, setShowStoreQr] = useState(false)

  // ── Main tab (issue / recovery / live-status) ─────────────────────────────
  const [mainTab, setMainTab] = useState<'issue' | 'recovery' | 'live-status'>('issue')

  // Live status tab state
  const [liveStatusRows, setLiveStatusRows] = useState<LiveStatusRow[]>([])

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

  // Issue log (realtime toast + log view)
  const [logToast, setLogToast]         = useState<IssueLogEntry | null>(null)
  const logToastTimerRef                = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showLogPanel, setShowLogPanel] = useState(false)
  const [recentLogs, setRecentLogs]     = useState<IssueLogEntry[]>([])
  const [logsLoading, setLogsLoading]   = useState(false)

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

  // ── Realtime subscription ─────────────────────────────────────────────────

  useEffect(() => {
    const channel = supabase
      .channel('ticket-issue-logs-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'ticket_issue_logs' },
        (payload) => {
          const entry = payload.new as IssueLogEntry
          if (logToastTimerRef.current) clearTimeout(logToastTimerRef.current)
          setLogToast(entry)
          logToastTimerRef.current = setTimeout(() => setLogToast(null), 6000)
          // If log panel is open, prepend the new entry
          setRecentLogs(prev => [entry, ...prev].slice(0, 12))
        },
      )
      .subscribe()

    return () => { void supabase.removeChannel(channel) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live status (LIVE STATUS管理タブ) ───────────────────────────────────────

  useEffect(() => {
    getLiveStatuses().then(setLiveStatusRows)
    const unsubscribe = subscribeLiveStatuses((updated) => {
      setLiveStatusRows(prev => prev.map(r => (r.id === updated.id ? updated : r)))
    })
    return unsubscribe
  }, [])

  const handleCycleLiveStatus = useCallback(async (row: LiveStatusRow) => {
    const updated = await setLiveStatus(row.id, nextLiveStatus(row.status))
    if (updated) setLiveStatusRows(prev => prev.map(r => (r.id === updated.id ? updated : r)))
  }, [])

  // ── Log panel ─────────────────────────────────────────────────────────────

  const loadRecentLogs = useCallback(async () => {
    setLogsLoading(true)
    setRecentLogs(await fetchRecentLogs(12))
    setLogsLoading(false)
  }, [])

  useEffect(() => {
    if (showLogPanel) void loadRecentLogs()
  }, [showLogPanel, loadRecentLogs])

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
    setShowUseConfirm(false)
    setPendingUseTicket(null)
    setUseConfirmLoading(false)
    setUseError(null)
    setTodayUsedThisDay(false)
    setShowUseComplete(false)
    setUseCompleteInfo(null)
    setMaintCouponData(null)
    setMaintCouponTodayUsed(false)
    setMaintCouponConfirming(false)
    setMaintCouponConfirmed(false)
    setMaintCouponBlockMsg(null)
  }

  const loadUserTickets = useCallback(async (userId: string) => {
    setTicketsLoading(true)
    try { setUserTickets(await getUserTickets(userId)) }
    catch { setUserTickets([]) }
    finally { setTicketsLoading(false) }
  }, [])

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
        const tickets = await getUserTickets(tuData.userId)
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
      setPhase('maintenance-coupon')
      const todayJST = getJapanDateString()
      const usedToday = await fetchTodayUsed(mcData.userId, todayJST)
      setMaintCouponTodayUsed(usedToday)
      return
    }

    const passportData = data as PassportQRData
    setScannedData(passportData)
    setPhase('loading')
    // Phase2: 会員テーブルへ初回登録（非致命的 — 失敗しても発行フローは継続）
    void upsertCustomer(passportData.userId, passportData.name)
    const prev = await fetchLastVisitDate(passportData.userId)
    setPrevLastVisitDate(prev)
    if (prev === null) { /* first visit — no sound */ }
    else if (daysSince(prev) <= 14) playSuccessSound()
    else playWarningSound()
    await loadUserTickets(passportData.userId)
    const todayJST = getJapanDateString()
    const usedThisDay = await fetchTodayUsed(passportData.userId, todayJST)
    setTodayUsedThisDay(usedThisDay)
    setPhase('result')
  }, [loadUserTickets])

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
      const issued: TicketRow[] = []
      for (let i = 0; i < quantity; i++) {
        const ticket = await issueTicket({
          user_id:   scannedData.userId,
          type:      ticketTab,
          title:     currentTab.autoTitle,
          amount:    effectiveAmount,
          issued_by: staffId,
        })
        issued.push(ticket)
      }
      setUserTickets(prev => [...issued, ...prev])

      // Write issue log to Supabase (triggers Realtime on all other terminals)
      await saveIssueLog({
        staff_name:    staffId,
        customer_name: scannedData.name,
        user_id:       scannedData.userId,
        ticket_type:   ticketTab,
        amount:        effectiveAmount,
        quantity,
        terminal:      'staff-terminal',
        status:        'issued',
      })

      playSuccessSound()
      setSuccessInfo({ name: scannedData.name, label: currentTab.autoTitle, amount: effectiveAmount, qty: quantity })
      setShowSuccess(true)
      setTimeout(() => { setShowSuccess(false); handleReset() }, 2500)
    } catch (err) {
      setIssueError(`発行に失敗しました（${err instanceof Error ? err.message : String(err)}）`)
    } finally {
      setIssueLoading(false)
    }
  }

  function handleUseTicketClick(ticket: TicketRow) {
    if (todayUsedThisDay || !staffId.trim()) return
    setUseError(null)
    setPendingUseTicket(ticket)
    setShowUseConfirm(true)
  }

  const handleConfirmUse = async () => {
    if (!pendingUseTicket || !scannedData || !staffId.trim()) return
    setUseConfirmLoading(true)
    setUseError(null)
    const today = getJapanDateString()
    const ticketId   = pendingUseTicket.id
    const ticketType = pendingUseTicket.type
    try {
      await markTicketUsed(ticketId, staffId)
      await saveUsageLog({
        usage_date:    today,
        staff_name:    staffId,
        customer_name: scannedData.name,
        user_id:       scannedData.userId,
        ticket_id:     ticketId,
        ticket_type:   ticketType,
        amount:        pendingUseTicket.amount,
        terminal:      'staff-terminal',
        status:        'used',
      })
      await upsertLastVisitDate(scannedData.userId, today)
      const remaining = userTickets.filter(t => !t.used && t.id !== ticketId && t.type === ticketType).length
      setUserTickets(prev => prev.map(t =>
        t.id === ticketId ? { ...t, used: true, used_at: new Date().toISOString() } : t
      ))
      setTodayUsedThisDay(true)
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
      setUseError(`使用確定に失敗しました。${err instanceof Error ? err.message : 'ネットワークを確認してください。'}`)
    } finally {
      setUseConfirmLoading(false)
    }
  }

  const handleCheckIn = async () => {
    if (!scannedData || checkInStatus === 'loading') return
    setCheckInStatus('loading')
    const today = getJapanDateString()
    try {
      await upsertLastVisitDate(scannedData.userId, today)
      setCheckInDate(today)
      setCheckInStatus('done')
      playSuccessSound()
    } catch {
      setCheckInStatus('idle')
    }
  }

  const handleConfirmTicketUse = async () => {
    if (!ticketUseData || !ticketForUse || !staffId.trim()) return
    if (ticketUsedThisSession) { setTicketBlockMsg('このお会計では既にチケットを1枚使用しています。'); return }
    if (ticketForUse.used) { setTicketBlockMsg('このチケットはすでに使用済みです。'); return }
    setTicketConfirming(true); setTicketBlockMsg(null)
    const today = getJapanDateString()
    try {
      // 当日利用チェック（3種共通 1日1枚制限）
      const usedToday = await fetchTodayUsed(ticketUseData.userId, today)
      if (usedToday) {
        setTicketBlockMsg('本日はすでにクーポンを利用済みです（1日1枚制限）。')
        setTicketConfirming(false)
        return
      }
      await markTicketUsed(ticketForUse.id, staffId)
      await saveUsageLog({
        usage_date:    today,
        staff_name:    staffId,
        customer_name: '',
        user_id:       ticketUseData.userId,
        ticket_id:     ticketForUse.id,
        ticket_type:   ticketForUse.type,
        amount:        ticketForUse.amount,
        terminal:      'staff-terminal',
        status:        'used',
      })
      await upsertLastVisitDate(ticketUseData.userId, today)
      setTicketForUse(prev => prev ? { ...prev, used: true, used_at: new Date().toISOString() } : prev)
      setTicketConfirmed(true); setTicketUsedThisSession(true)
      playSuccessSound()
    } catch {
      setTicketBlockMsg('使用確定に失敗しました。ネットワークを確認してください。')
    } finally { setTicketConfirming(false) }
  }

  const handleConfirmMaintenanceCoupon = async () => {
    if (!maintCouponData || !staffId.trim() || maintCouponTodayUsed || maintCouponConfirmed) return
    setMaintCouponConfirming(true)
    setMaintCouponBlockMsg(null)
    const today = getJapanDateString()
    try {
      await saveUsageLog({
        usage_date:    today,
        staff_name:    staffId,
        customer_name: maintCouponData.name,
        user_id:       maintCouponData.userId,
        ticket_id:     null,
        ticket_type:   'coupon',
        amount:        0,
        terminal:      'staff-terminal',
        status:        'used',
      })
      await upsertLastVisitDate(maintCouponData.userId, today)
      setMaintCouponConfirmed(true)
      setMaintCouponTodayUsed(true)
      playSuccessSound()
    } catch {
      setMaintCouponBlockMsg('使用確定に失敗しました。ネットワークを確認してください。')
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
    const [lastVisit, countResult] = await Promise.all([
      fetchLastVisitDate(customer.user_id),
      supabase.from('tickets').select('id', { count: 'exact', head: true }).eq('user_id', customer.user_id).eq('used', false),
    ])
    setCustomerLastVisit(lastVisit)
    setCustomerTicketCount(countResult.count ?? 0)
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
      {logToast && (
        <div
          onClick={() => setLogToast(null)}
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, zIndex: 700,
            background: 'rgba(12,6,3,0.97)', borderBottom: '1px solid rgba(201,162,74,0.3)',
            padding: '12px 16px', cursor: 'pointer',
            animation: 'gj-toast-in 0.28s ease-out both',
            boxShadow: '0 4px 24px rgba(0,0,0,0.7)',
          }}
        >
          <p style={{ fontSize: 8, letterSpacing: '0.3em', color: 'rgba(201,162,74,0.5)', marginBottom: 4 }}>ISSUE LOG — 他端末からの通知</p>
          <p style={{ fontFamily: SERIF, fontSize: 13, color: '#F2E6C8', lineHeight: 1.5 }}>
            <span style={{ color: '#C9A24A' }}>{logToast.staff_name}</span>
            {' が '}
            <span style={{ color: '#F2E6C8' }}>{logToast.customer_name}様</span>
            {' に '}
            {logToast.ticket_type === 'discount' ? '割引券' : '漢トク券'}
            {' ¥'}{logToast.amount.toLocaleString()}
            {' ×'}{logToast.quantity}枚 を発行
          </p>
          <p style={{ fontSize: 9, color: 'rgba(242,230,200,0.3)', marginTop: 3 }}>{fmtLogTime(logToast.issued_at)}</p>
        </div>
      )}

      {isStaging() && <StgBadge />}

      {/* ── Header ── */}
      <header style={{
        padding: '18px 20px 14px',
        borderBottom: '1px solid rgba(201,162,74,0.12)',
        background: 'linear-gradient(180deg, rgba(201,162,74,0.03) 0%, transparent 100%)',
        flexShrink: 0,
        marginTop: logToast ? 72 : 0,
        transition: 'margin-top 0.3s ease',
      }}>
        <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, #8B1A1A 30%, #C9A24A 50%, #8B1A1A 70%, transparent)', marginBottom: 12 }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <p style={{ fontSize: 8, letterSpacing: '0.32em', color: 'rgba(201,162,74,0.48)', marginBottom: 1 }}>STAFF TERMINAL</p>
            <h1 style={{ fontSize: 18, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF, letterSpacing: '0.1em' }}>銀二郎端末</h1>
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

      {/* ── Main tab switcher ── */}
      <div style={{ display: 'flex', borderBottom: '1px solid rgba(201,162,74,0.12)', background: 'rgba(0,0,0,0.25)', flexShrink: 0 }}>
        {([
          { id: 'issue',       label: 'チケット発行' },
          { id: 'recovery',    label: '会員復旧' },
          { id: 'live-status', label: 'LIVE STATUS' },
        ] as { id: 'issue' | 'recovery' | 'live-status'; label: string }[]).map(tab => {
          const isActive = mainTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setMainTab(tab.id)}
              style={{
                flex: 1, padding: '13px 8px',
                background: isActive ? 'rgba(201,162,74,0.06)' : 'transparent',
                border: 'none',
                borderBottom: `2px solid ${isActive ? 'rgba(201,162,74,0.65)' : 'transparent'}`,
                color: isActive ? '#C9A24A' : 'rgba(242,230,200,0.32)',
                fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.08em',
                cursor: 'pointer', transition: 'all 0.18s', WebkitTapHighlightColor: 'transparent',
              }}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* ── Main scroll area ── */}
      <main style={{
        flex: 1, overflowY: 'auto',
        padding: `20px 20px ${mainTab === 'issue' && phase === 'result' ? '108px' : '32px'}`,
        maxWidth: 480, margin: '0 auto', width: '100%', boxSizing: 'border-box',
      }}>

        {/* ===== SCAN ===== */}
        {mainTab === 'issue' && phase === 'scan' && (
          <div>
            {/* Waiting card */}
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
                <p style={{ fontSize: 13, color: 'rgba(242,230,200,0.4)', fontFamily: SERIF, letterSpacing: '0.08em', textAlign: 'center', lineHeight: 1.7 }}>
                  次の男前パスポートをスキャンしてください
                </p>
              </div>
            </div>

            {!staffId.trim() ? (
              <div style={{ padding: '28px 20px', borderRadius: 16, background: 'rgba(139,26,26,0.1)', border: '1px solid rgba(201,162,74,0.22)', textAlign: 'center', marginBottom: 16 }}>
                <p style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: '#C9A24A', letterSpacing: '0.06em', marginBottom: 18, lineHeight: 1.6 }}>
                  先に担当者を選択してください
                </p>
                <button
                  onClick={() => setShowStaffPicker(true)}
                  style={{ padding: '16px 32px', borderRadius: 14, background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)', border: '1px solid rgba(201,162,74,0.5)', boxShadow: '0 4px 20px rgba(107,15,18,0.4)', color: '#F2E6C8', fontFamily: SERIF, fontSize: 17, fontWeight: 700, letterSpacing: '0.14em', cursor: 'pointer' }}
                >
                  担当者を選択する
                </button>
              </div>
            ) : (
              <div style={{ marginBottom: 14 }}>
                <QrCameraScanner
                  onScan={text => { void handleScanned(text) }}
                  onCameraError={msg => { setCameraError(msg); setShowManual(true) }}
                />
              </div>
            )}

            {cameraError && <p style={{ fontSize: 12, color: '#E06060', textAlign: 'center', marginBottom: 12, lineHeight: 1.5 }}>{cameraError}</p>}
            {parseError && (
              <div style={{ borderRadius: 12, background: 'rgba(139,26,26,0.15)', border: '1px solid rgba(224,96,96,0.28)', padding: '10px 14px', marginBottom: 12 }}>
                <p style={{ fontSize: 12, color: '#E06060', whiteSpace: 'pre-line' }}>{parseError}</p>
              </div>
            )}

            <button onClick={() => setShowManual(v => !v)} style={{ width: '100%', padding: '14px', borderRadius: 12, background: 'transparent', border: '1px solid rgba(201,162,74,0.16)', color: 'rgba(201,162,74,0.50)', fontSize: 14, letterSpacing: '0.12em', cursor: 'pointer', fontFamily: SERIF, marginBottom: 10 }}>
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
                  style={{ width: '100%', padding: '16px', borderRadius: 12, background: manualInput.trim() ? 'rgba(40,80,20,0.5)' : 'rgba(255,255,255,0.04)', border: `1px solid ${manualInput.trim() ? 'rgba(120,180,80,0.4)' : 'rgba(255,255,255,0.1)'}`, color: manualInput.trim() ? '#C8F0A0' : 'rgba(255,255,255,0.25)', fontFamily: SERIF, fontSize: 16, fontWeight: 700, letterSpacing: '0.14em', cursor: manualInput.trim() ? 'pointer' : 'default' }}
                >
                  読み取る
                </button>
              </div>
            )}

            {/* Store QR */}
            <div style={{ marginTop: 16 }}>
              <button onClick={() => setShowStoreQr(v => !v)} style={{ width: '100%', padding: '11px', borderRadius: 12, background: 'transparent', border: '1px solid rgba(201,162,74,0.12)', color: 'rgba(201,162,74,0.40)', fontSize: 11, letterSpacing: '0.14em', cursor: 'pointer', fontFamily: SERIF }}>
                {showStoreQr ? '店内設置QRを閉じる' : '店内設置QRを表示（印刷用）'}
              </button>
              {showStoreQr && (
                <div style={{ marginTop: 12, borderRadius: 16, background: '#0A0504', border: '1px solid rgba(201,162,74,0.16)', padding: '20px', textAlign: 'center' }}>
                  <p style={{ fontSize: 9, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.5)', marginBottom: 10 }}>STORE CHECK-IN QR</p>
                  <div style={{ display: 'inline-block', padding: 14, background: '#FFFFFF', borderRadius: 12 }}>
                    <QRCodeSVG value={STORE_CHECKIN_QR_VALUE} size={180} level="M" />
                  </div>
                  <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.3)', marginTop: 10, lineHeight: 1.6 }}>
                    お客様がこのQRをアプリでスキャンすると<br />来店チェックインが完了します
                  </p>
                </div>
              )}
            </div>

            {/* Issue log panel */}
            <div style={{ marginTop: 14 }}>
              <button
                onClick={() => setShowLogPanel(v => !v)}
                style={{ width: '100%', padding: '11px', borderRadius: 12, background: 'transparent', border: '1px solid rgba(201,162,74,0.12)', color: 'rgba(201,162,74,0.40)', fontSize: 11, letterSpacing: '0.14em', cursor: 'pointer', fontFamily: SERIF }}
              >
                {showLogPanel ? '発行ログを閉じる' : '最近の発行ログを確認する'}
              </button>
              {showLogPanel && (
                <div style={{ marginTop: 10, borderRadius: 14, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(201,162,74,0.1)', padding: '14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <p style={{ fontSize: 9, letterSpacing: '0.2em', color: 'rgba(201,162,74,0.5)' }}>ISSUE LOG — 全端末共有</p>
                    <button onClick={() => void loadRecentLogs()} style={{ fontSize: 9, color: 'rgba(201,162,74,0.45)', background: 'none', border: 'none', cursor: 'pointer', letterSpacing: '0.1em' }}>
                      更新
                    </button>
                  </div>
                  {logsLoading ? (
                    <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.28)', textAlign: 'center', padding: '8px 0' }}>読込中…</p>
                  ) : recentLogs.length === 0 ? (
                    <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.24)', textAlign: 'center', padding: '8px 0' }}>発行ログはありません</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {recentLogs.map(log => (
                        <div key={log.id} style={{ padding: '8px 10px', borderRadius: 9, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                            <span style={{ fontSize: 10, color: '#C9A24A', fontFamily: SERIF, fontWeight: 700 }}>
                              {log.staff_name}
                            </span>
                            <span style={{ fontSize: 9, color: 'rgba(242,230,200,0.3)', letterSpacing: '0.04em' }}>
                              {fmtLogTime(log.issued_at)}
                            </span>
                          </div>
                          <p style={{ fontSize: 11, color: '#F2E6C8', lineHeight: 1.4 }}>
                            {log.customer_name}様 ／ {log.ticket_type === 'discount' ? '割引券' : '漢トク券'} ¥{log.amount.toLocaleString()} × {log.quantity}枚
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ===== LOADING ===== */}
        {mainTab === 'issue' && phase === 'loading' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 80 }}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', border: '2px solid rgba(201,162,74,0.14)', borderTop: '2px solid rgba(201,162,74,0.7)', animation: 'gj-spin 0.8s linear infinite', marginBottom: 20 }} />
            <p style={{ fontSize: 14, color: 'rgba(242,230,200,0.4)', fontFamily: SERIF, letterSpacing: '0.14em' }}>判定中...</p>
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
                      <p style={{ fontSize: 8, letterSpacing: '0.28em', color: 'rgba(201,162,74,0.48)', marginBottom: 4 }}>CUSTOMER</p>
                      <h2 style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, color: '#F2E6C8', letterSpacing: '0.06em', marginBottom: 3, lineHeight: 1.1 }}>
                        {scannedData.name}
                        <span style={{ fontSize: 14, marginLeft: 4, color: 'rgba(242,230,200,0.42)' }}>様</span>
                      </h2>
                      <p style={{ fontSize: 9, color: 'rgba(242,230,200,0.28)', letterSpacing: '0.06em', marginBottom: 2 }}>
                        ID: {scannedData.userId.slice(0, 22)}…
                      </p>
                      {prevLastVisitDate && (
                        <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.36)', letterSpacing: '0.04em' }}>
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
                      <p style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', color: isFirstVisit ? 'rgba(140,180,240,0.55)' : isEligible ? 'rgba(128,224,96,0.6)' : 'rgba(224,96,64,0.6)' }}>
                        {isFirstVisit ? '初回来店' : isEligible ? '対象◎' : '対象外'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
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
                  <p style={{ fontFamily: SERIF, fontSize: 13, color: 'rgba(242,230,200,0.72)', lineHeight: 1.8, letterSpacing: '0.04em' }}>
                    {scannedData.name}様の前回来店日を<br />
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
                    letterSpacing: '0.14em', color: checkInStatus === 'loading' ? 'rgba(208,244,216,0.45)' : '#D0F4D8',
                    cursor: checkInStatus === 'loading' ? 'default' : 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  {checkInStatus === 'loading' ? '記録中…' : '来店チェックイン'}
                  {checkInStatus !== 'loading' && (
                    <span style={{ display: 'block', fontSize: 10, fontWeight: 400, color: 'rgba(208,244,216,0.5)', letterSpacing: '0.08em', marginTop: 4 }}>
                      本日の来店日を記録します
                    </span>
                  )}
                </button>
              )}
            </div>

            {/* ── 使用可能チケット一覧 ── */}
            <div style={{ marginBottom: 14 }}>
              <p style={{ fontSize: 9, letterSpacing: '0.24em', color: 'rgba(201,162,74,0.5)', marginBottom: 10, fontFamily: SERIF }}>
                保有チケット（未使用 {ticketsLoading ? '—' : `${activeTickets.length}枚`}）
              </p>
              {ticketsLoading ? (
                <div style={{ padding: '16px', textAlign: 'center', borderRadius: 14, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.28)' }}>読込中…</p>
                </div>
              ) : activeTickets.length === 0 ? (
                <div style={{ padding: '16px', textAlign: 'center', borderRadius: 14, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.24)' }}>保有チケットなし</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {activeTickets.map(ticket => {
                    const tktTc = TICKET_TYPE_COLORS[ticket.type]
                    const isBlockedToday = todayUsedThisDay
                    const noStaff = !staffId.trim()
                    const btnDisabled = isBlockedToday || noStaff
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
                              <p style={{ fontSize: 9, color: 'rgba(242,230,200,0.28)' }}>発行日 {fmtCreatedAt(ticket.created_at)}</p>
                              {ticket.expires_at && (
                                <p style={{ fontSize: 9, color: 'rgba(255,180,0,0.55)', marginTop: 1 }}>有効期限 {fmtCreatedAt(ticket.expires_at)}</p>
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
                                color: btnDisabled ? 'rgba(242,230,200,0.22)' : '#D0F4D8',
                                fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.12em',
                                cursor: btnDisabled ? 'default' : 'pointer',
                                whiteSpace: 'nowrap', minWidth: 80, textAlign: 'center',
                              }}
                            >
                              {isBlockedToday ? '本日使用済' : '使用確定'}
                            </button>
                          </div>
                          {isBlockedToday && (
                            <p style={{ fontSize: 9, color: 'rgba(224,96,80,0.55)', marginTop: 8, lineHeight: 1.5 }}>
                              本日はすでにチケットを使用済みです。チケットの使用は1日1枚までです。
                            </p>
                          )}
                          {noStaff && !isBlockedToday && (
                            <p style={{ fontSize: 9, color: 'rgba(224,140,0,0.55)', marginTop: 8 }}>担当者を選択してください</p>
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
                        color: active ? tabTc.text : 'rgba(242,230,200,0.28)',
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
                <p style={{ fontSize: 9, letterSpacing: '0.22em', color: 'rgba(242,230,200,0.36)', marginBottom: 10 }}>金額を入力</p>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: effectiveAmount > 0 ? '#C9A24A' : 'rgba(242,230,200,0.22)', pointerEvents: 'none' }}>¥</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    value={ticketTab === 'discount' ? discountAmountInput : otokuAmountInput}
                    onChange={e => {
                      const v = e.target.value.replace(/[^\d]/g, '')
                      ticketTab === 'discount' ? setDiscountAmountInput(v) : setOtokuAmountInput(v)
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
                  <p style={{ fontSize: 11, color: 'rgba(201,162,74,0.55)', textAlign: 'right', marginTop: 6, letterSpacing: '0.06em' }}>
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
              <p style={{ fontSize: 9, letterSpacing: '0.22em', color: 'rgba(242,230,200,0.36)', marginBottom: 10 }}>枚数を選択</p>
              <div style={{ display: 'flex', gap: 7, marginBottom: 12 }}>
                {QTY_PRESETS.map(n => (
                  <button
                    key={n}
                    onClick={() => setQuantity(n)}
                    style={{
                      flex: 1, padding: '14px 2px', borderRadius: 11,
                      background: quantity === n ? tc.cardBg : 'rgba(255,255,255,0.04)',
                      border: `1.5px solid ${quantity === n ? tc.border : 'rgba(255,255,255,0.09)'}`,
                      color: quantity === n ? tc.text : 'rgba(242,230,200,0.55)',
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
                <button onClick={() => setQuantity(q => Math.max(1, q - 1))} style={{ width: 46, height: 46, borderRadius: '50%', background: 'rgba(255,255,255,0.05)', border: '1.5px solid rgba(255,255,255,0.13)', color: 'rgba(242,230,200,0.75)', fontSize: 22, fontWeight: 300, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
                <div style={{ textAlign: 'center', minWidth: 72 }}>
                  <span style={{ fontFamily: SERIF, fontSize: 32, fontWeight: 700, color: '#F2E6C8', letterSpacing: '-0.01em' }}>{quantity}</span>
                  <span style={{ fontSize: 12, color: 'rgba(242,230,200,0.38)', marginLeft: 4 }}>枚</span>
                </div>
                <button onClick={() => setQuantity(q => Math.min(MAX_QTY, q + 1))} style={{ width: 46, height: 46, borderRadius: '50%', background: 'rgba(255,255,255,0.05)', border: '1.5px solid rgba(255,255,255,0.13)', color: 'rgba(242,230,200,0.75)', fontSize: 22, fontWeight: 300, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>＋</button>
              </div>

              {/* Summary */}
              {effectiveAmount > 0 && (
                <div style={{ padding: '10px 16px', borderRadius: 12, background: 'rgba(201,162,74,0.06)', border: '1px solid rgba(201,162,74,0.18)', textAlign: 'center' }}>
                  <p style={{ fontFamily: SERIF, fontSize: 14, color: '#C9A24A', letterSpacing: '0.06em' }}>
                    {currentTab.autoTitle}　¥{effectiveAmount.toLocaleString()}　×　{quantity}枚
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
            <p style={{ fontSize: 14, color: 'rgba(242,230,200,0.4)', fontFamily: SERIF, letterSpacing: '0.14em' }}>チケット確認中...</p>
          </div>
        )}

        {/* ===== TICKET-RESULT ===== */}
        {mainTab === 'issue' && phase === 'ticket-result' && ticketUseData && (
          <div>
            {ticketQrExpired ? (
              <div style={{ borderRadius: 18, background: 'linear-gradient(135deg, rgba(70,15,15,0.6), rgba(50,8,8,0.8))', border: '1px solid rgba(200,80,60,0.3)', padding: '28px 22px', textAlign: 'center', marginBottom: 16 }}>
                <p style={{ fontSize: 9, letterSpacing: '0.3em', color: 'rgba(200,100,80,0.7)', marginBottom: 12 }}>QR EXPIRED</p>
                <p style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: '#E06040', marginBottom: 10 }}>QRコードの有効期限が切れています</p>
                <p style={{ fontSize: 12, color: 'rgba(220,120,100,0.6)', lineHeight: 1.6 }}>お客様に再度「使用する」を押していただいてください。</p>
              </div>
            ) : ticketForUse === null ? (
              <div style={{ borderRadius: 18, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', padding: '28px 22px', textAlign: 'center', marginBottom: 16 }}>
                <p style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: 'rgba(242,230,200,0.4)', marginBottom: 8 }}>チケットが見つかりません</p>
                <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.3)', lineHeight: 1.6 }}>すでに使用済みか、存在しないチケットです。</p>
              </div>
            ) : ticketConfirmed ? (
              <div style={{ borderRadius: 18, background: 'linear-gradient(135deg, rgba(15,50,22,0.6), rgba(8,35,15,0.8))', border: '1px solid rgba(80,192,90,0.38)', padding: '28px 22px', textAlign: 'center', marginBottom: 16, boxShadow: '0 4px 36px rgba(80,192,80,0.14)' }}>
                <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(100,200,100,0.12)', border: '1px solid rgba(100,200,100,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', fontSize: 24 }}>✓</div>
                <p style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: '#80E060', marginBottom: 10 }}>使用確定しました</p>
                <p style={{ fontFamily: SERIF, fontSize: 17, color: '#F2E6C8', marginBottom: 4 }}>{ticketForUse.title}</p>
                {ticketForUse.amount > 0 && (
                  <p style={{ fontFamily: SERIF, fontSize: 22, color: '#C9A24A', marginBottom: 8 }}>¥{ticketForUse.amount.toLocaleString()}</p>
                )}
                <p style={{ fontSize: 12, color: 'rgba(128,224,96,0.65)', marginTop: 4, lineHeight: 1.6 }}>
                  来店チェックイン完了<br />
                  <span style={{ fontSize: 10, color: 'rgba(128,224,96,0.45)' }}>メンテナンスカウントダウンをリセットしました</span>
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
                        <p style={{ fontSize: 9, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.52)', marginBottom: 8, fontFamily: SERIF }}>チケット確認</p>
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
                        <p style={{ fontSize: 9, color: 'rgba(242,230,200,0.28)', marginTop: 4 }}>
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

                {!ticketForUse.used && (
                  <button
                    onClick={() => { void handleConfirmTicketUse() }}
                    disabled={ticketConfirming || !staffId.trim() || ticketUsedThisSession}
                    style={{
                      width: '100%', padding: '16px', borderRadius: 14, marginBottom: 10,
                      background: (ticketConfirming || !staffId.trim() || ticketUsedThisSession)
                        ? 'rgba(255,255,255,0.04)'
                        : 'linear-gradient(135deg, #0a3d1a 0%, #145a2a 60%, #1a7a38 100%)',
                      border: `1px solid ${(ticketConfirming || !staffId.trim() || ticketUsedThisSession) ? 'rgba(255,255,255,0.08)' : 'rgba(100,200,100,0.44)'}`,
                      boxShadow: (ticketConfirming || !staffId.trim() || ticketUsedThisSession) ? 'none' : '0 4px 20px rgba(20,90,42,0.45)',
                      color: (ticketConfirming || !staffId.trim() || ticketUsedThisSession) ? 'rgba(242,230,200,0.22)' : '#D0F4D8',
                      fontFamily: SERIF, fontSize: 15, fontWeight: 700, letterSpacing: '0.18em',
                      cursor: (ticketConfirming || !staffId.trim() || ticketUsedThisSession) ? 'default' : 'pointer',
                    }}
                  >
                    {ticketConfirming ? '確定中…' : '使用確定'}
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
                <p style={{ fontSize: 8, letterSpacing: '0.28em', color: 'rgba(100,200,100,0.5)', marginBottom: 4 }}>MAINTENANCE COUPON</p>
                <h2 style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, color: '#F2E6C8', letterSpacing: '0.06em', marginBottom: 6, lineHeight: 1.1 }}>
                  {maintCouponData.name}<span style={{ fontSize: 14, marginLeft: 4, color: 'rgba(242,230,200,0.42)' }}>様</span>
                </h2>
                <p style={{ fontSize: 9, color: 'rgba(242,230,200,0.28)', letterSpacing: '0.06em' }}>
                  ID: {maintCouponData.userId.slice(0, 22)}…
                </p>
              </div>
            </div>

            {/* Coupon detail card */}
            <div style={{ borderRadius: 16, background: 'linear-gradient(155deg, #060e07 0%, #040a04 100%)', border: `1px solid ${maintCouponTodayUsed ? 'rgba(224,96,80,0.36)' : maintCouponConfirmed ? 'rgba(100,200,100,0.44)' : 'rgba(100,200,100,0.28)'}`, overflow: 'hidden', marginBottom: 14 }}>
              <div style={{ height: 2, background: `linear-gradient(90deg, transparent, ${maintCouponConfirmed ? 'rgba(100,200,100,0.7)' : 'rgba(100,200,100,0.3)'}, transparent)` }} />
              <div style={{ padding: '16px 18px' }}>
                <p style={{ fontSize: 9, letterSpacing: '0.22em', color: 'rgba(100,200,100,0.52)', marginBottom: 8, fontFamily: SERIF }}>メンテナンスクーポン確認</p>
                <p style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#F2E6C8', marginBottom: 4 }}>メンテナンスカット</p>
                <p style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: '#C9A24A', marginBottom: 8, lineHeight: 1 }}>¥3,000</p>
                {maintCouponConfirmed ? (
                  <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: 'rgba(100,200,100,0.15)', border: '1px solid rgba(100,200,100,0.5)', color: '#64D26E' }}>使用済み</span>
                ) : maintCouponTodayUsed ? (
                  <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: 'rgba(224,96,80,0.12)', border: '1px solid rgba(224,96,80,0.38)', color: '#E06050' }}>本日使用済み</span>
                ) : (
                  <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: 'rgba(100,210,110,0.08)', border: '1px solid rgba(100,210,110,0.3)', color: '#64D26E' }}>有効</span>
                )}
              </div>
            </div>

            {/* 当日利用済みメッセージ */}
            {maintCouponTodayUsed && !maintCouponConfirmed && (
              <div style={{ borderRadius: 12, background: 'rgba(139,26,26,0.15)', border: '1px solid rgba(224,96,96,0.28)', padding: '12px 16px', marginBottom: 14 }}>
                <p style={{ fontSize: 13, color: '#E06060', lineHeight: 1.7, fontFamily: SERIF }}>
                  本日はすでにクーポンを利用済みです。<br />
                  <span style={{ fontSize: 11, color: 'rgba(224,96,96,0.65)' }}>1日1枚制限（メンテ・漢トク券・割引券 共通）</span>
                </p>
              </div>
            )}

            {/* 使用確定済み */}
            {maintCouponConfirmed && (
              <div style={{ borderRadius: 16, background: 'linear-gradient(135deg, rgba(15,50,22,0.6), rgba(8,35,15,0.8))', border: '1px solid rgba(80,192,90,0.38)', padding: '22px', textAlign: 'center', marginBottom: 14, boxShadow: '0 4px 36px rgba(80,192,80,0.14)' }}>
                <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(100,200,100,0.12)', border: '1px solid rgba(100,200,100,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', fontSize: 24 }}>✓</div>
                <p style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#80E060', marginBottom: 6 }}>使用確定しました</p>
                <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.5)', lineHeight: 1.7 }}>
                  メンテナンスクーポン ¥3,000<br />
                  使用ログを記録しました。
                </p>
                <p style={{ fontSize: 12, color: 'rgba(128,224,96,0.65)', marginTop: 10, lineHeight: 1.6 }}>
                  来店チェックイン完了<br />
                  <span style={{ fontSize: 10, color: 'rgba(128,224,96,0.45)' }}>メンテナンスカウントダウンをリセットしました</span>
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
                  color: (maintCouponConfirming || !staffId.trim()) ? 'rgba(242,230,200,0.22)' : '#D0F4D8',
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

        {/* ===== RECOVERY TAB ===== */}
        {mainTab === 'recovery' && (
          <div>
            {/* Step: search */}
            {recoveryStep === 'search' && (
              <div>
                <div style={{ marginBottom: 20, borderRadius: 18, background: 'linear-gradient(155deg, #0D0805 0%, #080403 100%)', border: '1px solid rgba(201,162,74,0.14)', padding: '16px 18px' }}>
                  <p style={{ fontSize: 8, letterSpacing: '0.32em', color: 'rgba(201,162,74,0.48)', marginBottom: 8 }}>MEMBER RECOVERY</p>
                  <p style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: '#F2E6C8', marginBottom: 6, letterSpacing: '0.04em' }}>会員データ復旧</p>
                  <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.34)', lineHeight: 1.7 }}>
                    お客様の名前で旧会員データを検索し、<br />新端末へ移管します。
                  </p>
                </div>

                <p style={{ fontSize: 9, letterSpacing: '0.22em', color: 'rgba(242,230,200,0.36)', marginBottom: 10 }}>お客様名で検索</p>
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
                      color: recoveryQuery.trim() ? '#C9A24A' : 'rgba(242,230,200,0.24)',
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
                        <p style={{ fontSize: 9, color: 'rgba(242,230,200,0.3)', letterSpacing: '0.06em' }}>
                          登録 {new Date(customer.created_at).toLocaleDateString('ja-JP')} ／ コード {customer.recovery_code}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
                {recoveryResults.length === 0 && recoveryQuery && !recoverySearching && (
                  <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.28)', textAlign: 'center', padding: '20px 0', lineHeight: 1.7 }}>
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
                  style={{ marginBottom: 16, padding: '8px 14px', borderRadius: 10, background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(242,230,200,0.4)', fontSize: 12, fontFamily: SERIF, cursor: 'pointer', letterSpacing: '0.1em' }}
                >
                  ← 検索に戻る
                </button>

                <div style={{ borderRadius: 18, background: 'linear-gradient(155deg, #130A07 0%, #0A0504 100%)', border: '1px solid rgba(201,162,74,0.32)', overflow: 'hidden', marginBottom: 18 }}>
                  <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, #8B1A1A 30%, #C9A24A 50%, #8B1A1A 70%, transparent)' }} />
                  <div style={{ padding: '18px 20px' }}>
                    <p style={{ fontSize: 8, letterSpacing: '0.28em', color: 'rgba(201,162,74,0.48)', marginBottom: 6 }}>CUSTOMER</p>
                    <p style={{ fontFamily: SERIF, fontSize: 24, fontWeight: 700, color: '#F2E6C8', marginBottom: 16 }}>
                      {selectedCustomer.name} <span style={{ fontSize: 14, color: 'rgba(242,230,200,0.42)' }}>様</span>
                    </p>
                    {([
                      { label: '登録日',       value: new Date(selectedCustomer.created_at).toLocaleDateString('ja-JP') },
                      { label: '復旧コード',   value: selectedCustomer.recovery_code, highlight: true },
                      { label: '前回来店日',   value: customerLastVisit === undefined ? '読込中…' : (customerLastVisit ?? '記録なし') },
                      { label: '保有チケット', value: customerTicketCount === null ? '読込中…' : `${customerTicketCount}枚` },
                    ] as { label: string; value: string; highlight?: boolean }[]).map(({ label, value, highlight }) => (
                      <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', paddingBottom: 10, marginBottom: 10, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                        <span style={{ fontSize: 10, color: 'rgba(242,230,200,0.42)', letterSpacing: '0.1em' }}>{label}</span>
                        <span style={{ fontFamily: SERIF, fontSize: highlight ? 17 : 14, fontWeight: 700, color: highlight ? '#C9A24A' : '#F2E6C8', letterSpacing: highlight ? '0.14em' : '0.04em' }}>{value}</span>
                      </div>
                    ))}
                    <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.3)', lineHeight: 1.7, marginTop: 4 }}>
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
                  style={{ marginBottom: 16, padding: '8px 14px', borderRadius: 10, background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(242,230,200,0.4)', fontSize: 12, fontFamily: SERIF, cursor: 'pointer', letterSpacing: '0.1em' }}
                >
                  ← 戻る
                </button>

                <div style={{ marginBottom: 14, padding: '12px 16px', borderRadius: 12, background: 'rgba(201,162,74,0.06)', border: '1px solid rgba(201,162,74,0.18)' }}>
                  <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.55)', lineHeight: 1.7 }}>
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

                <p style={{ textAlign: 'center', fontSize: 10, color: 'rgba(242,230,200,0.22)', letterSpacing: '0.1em', marginBottom: 10 }}>または直接入力</p>

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
                      color: recoveryManualInput.trim() ? '#C8F0A0' : 'rgba(255,255,255,0.25)',
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
                <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.38)', lineHeight: 1.7, marginBottom: 32 }}>
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

        {/* ===== LIVE STATUS管理 ===== */}
        {mainTab === 'live-status' && (
          <div>
            <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.42)', letterSpacing: '0.08em', marginBottom: 16, lineHeight: 1.7 }}>
              カードをタップすると<br />
              READY → LIMITED → FULL → CLOSED → READY の順で切り替わります。
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {liveStatusRows.map((row) => {
                const t = LIVE_STATUS_THEME[row.status]
                return (
                  <button
                    key={row.id}
                    className={liveStatusPulseClass(row.status)}
                    onClick={() => void handleCycleLiveStatus(row)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      minHeight: 132, borderRadius: 18,
                      background: 'linear-gradient(155deg, #130608 0%, #0A0404 55%, #080407 100%)',
                      border: `1.5px solid ${t.border}`,
                      boxShadow: [
                        '0 14px 36px rgba(0,0,0,0.55)',
                        t.glow,
                      ].filter(Boolean).join(', '),
                      opacity: t.dim ? 0.62 : 1,
                      padding: '16px 18px',
                      cursor: 'pointer', textAlign: 'left',
                      WebkitTapHighlightColor: 'transparent',
                      position: 'relative', overflow: 'hidden',
                    }}
                  >
                    <div className={liveStatusSignpoleClass(row.status)} aria-hidden="true" />

                    <div style={{ height: 2, position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1, background: `linear-gradient(90deg, transparent, ${t.border} 50%, transparent)` }} />

                    <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                      <p style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#F2E6C8', letterSpacing: '0.05em', lineHeight: 1.15 }}>
                        {row.name}
                      </p>
                      <p style={{ fontFamily: 'ui-monospace, "SF Mono", "Fira Code", monospace', fontSize: 21, fontWeight: 700, color: t.codeColor, letterSpacing: '0.06em', lineHeight: 1.15 }}>
                        {LIVE_STATUS_CODES[row.status]}
                      </p>
                      <p style={{ fontSize: 13, fontWeight: 600, color: t.descColor, letterSpacing: '0.04em' }}>
                        {liveStatusLabel(row.id, row.status)}
                      </p>
                      <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.30)', letterSpacing: '0.06em', marginTop: 2 }}>
                        更新 {fmtLogTime(row.updated_at)}
                      </p>
                    </div>

                    <span style={{
                      position: 'relative', zIndex: 1,
                      flexShrink: 0, marginLeft: 12,
                      padding: '6px 12px', borderRadius: 99,
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.10)',
                      fontSize: 10, fontWeight: 700, letterSpacing: '0.10em',
                      color: 'rgba(242,230,200,0.40)',
                      fontFamily: SERIF, whiteSpace: 'nowrap',
                    }}>
                      タップで切替
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </main>

      {/* ── Fixed bottom: 発行する ── */}
      {mainTab === 'issue' && phase === 'result' && scannedData && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 100,
          background: 'linear-gradient(0deg, rgba(6,2,1,0.99) 0%, rgba(6,2,1,0.92) 70%, transparent 100%)',
          padding: '14px 20px calc(14px + env(safe-area-inset-bottom, 0px))',
        }}>
          <button
            onClick={handleIssueClick}
            disabled={!canIssue}
            style={{
              width: '100%', height: 66, borderRadius: 18,
              background: canIssue
                ? 'linear-gradient(90deg, #800c14 0%, #3a0307 100%)'
                : 'rgba(255,255,255,0.04)',
              border: `2px solid ${canIssue ? '#e6ca65' : 'rgba(255,255,255,0.07)'}`,
              boxShadow: canIssue
                ? ['0 0 32px rgba(128,12,20,0.72)', '0 0 64px rgba(128,12,20,0.36)', 'inset 0 1px 0 rgba(230,202,101,0.28)', 'inset 0 -1px 0 rgba(230,202,101,0.1)', '0 6px 32px rgba(0,0,0,0.85)'].join(', ')
                : 'none',
              color: canIssue ? '#F2E6C8' : 'rgba(242,230,200,0.18)',
              fontFamily: SERIF, fontSize: 22, fontWeight: 700, letterSpacing: '0.26em',
              cursor: canIssue ? 'pointer' : 'default',
              animation: canIssue ? 'gj-pulse-red 2.8s ease-in-out infinite' : 'none',
              transition: 'background 0.2s, border-color 0.2s',
            }}
          >
            {issueLoading ? '発行中…' : '発行する'}
          </button>
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
              <p style={{ fontSize: 9, letterSpacing: '0.34em', color: 'rgba(201,162,74,0.5)', marginBottom: 10, textAlign: 'center' }}>CONFIRM RECOVERY</p>
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
                    <span style={{ fontSize: 10, color: 'rgba(242,230,200,0.42)', letterSpacing: '0.1em' }}>{label}</span>
                    <span style={{ fontFamily: SERIF, fontSize: 14, fontWeight: 700, color: '#F2E6C8', wordBreak: 'break-all', maxWidth: '65%', textAlign: 'right' }}>{value}</span>
                  </div>
                ))}

                <div style={{ marginTop: 10 }}>
                  <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.42)', letterSpacing: '0.1em', marginBottom: 8 }}>復旧理由</p>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {['機種変更', 'Safariデータ削除', 'その他'].map(reason => (
                      <button
                        key={reason}
                        onClick={() => setRecoveryReason(reason)}
                        style={{
                          flex: 1, padding: '8px 4px', borderRadius: 8,
                          background: recoveryReason === reason ? 'rgba(201,162,74,0.15)' : 'rgba(255,255,255,0.03)',
                          border: `1px solid ${recoveryReason === reason ? 'rgba(201,162,74,0.5)' : 'rgba(255,255,255,0.08)'}`,
                          color: recoveryReason === reason ? '#C9A24A' : 'rgba(242,230,200,0.3)',
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

              <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.4)', textAlign: 'center', marginBottom: 20, lineHeight: 1.7 }}>
                旧端末のチケット・来店履歴・使用ログが<br />すべて新端末に移管されます。
              </p>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => { setRecoveryStep('scan'); setRecoveryError(null) }}
                  disabled={recoveryLoading}
                  style={{ flex: 1, padding: '14px 0', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', fontSize: 13, color: 'rgba(242,230,200,0.52)', fontFamily: SERIF, letterSpacing: '0.14em', cursor: 'pointer' }}
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
                    color: recoveryLoading ? 'rgba(208,244,216,0.4)' : '#D0F4D8',
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
              <p style={{ fontSize: 9, letterSpacing: '0.34em', color: 'rgba(201,162,74,0.5)', marginBottom: 10, textAlign: 'center' }}>CONFIRM ISSUE</p>
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
                    <span style={{ fontSize: 10, color: 'rgba(242,230,200,0.42)', letterSpacing: '0.1em' }}>{label}</span>
                    <span style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: '#F2E6C8' }}>{value}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 10, color: 'rgba(242,230,200,0.42)', letterSpacing: '0.1em' }}>合計</span>
                  <span style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: '#C9A24A' }}>
                    ¥{(effectiveAmount * quantity).toLocaleString()}
                  </span>
                </div>
              </div>

              <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.36)', textAlign: 'center', lineHeight: 1.75, marginBottom: 22, letterSpacing: '0.04em' }}>
                この操作は店舗端末に記録されます。{'\n'}内容を確認してから発行してください。
              </p>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => setShowConfirm(false)}
                  style={{ flex: 1, padding: '14px 0', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', fontSize: 13, color: 'rgba(242,230,200,0.52)', fontFamily: SERIF, letterSpacing: '0.14em', cursor: 'pointer' }}
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
              <p style={{ fontSize: 9, letterSpacing: '0.34em', color: 'rgba(100,200,100,0.5)', marginBottom: 10, textAlign: 'center' }}>CONFIRM USE</p>
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
                    <span style={{ fontSize: 10, color: 'rgba(242,230,200,0.42)', letterSpacing: '0.1em' }}>{label}</span>
                    <span style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: '#F2E6C8' }}>{value}</span>
                  </div>
                ))}
                <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.36)', lineHeight: 1.7, letterSpacing: '0.04em' }}>
                  この操作は取り消せません。
                </p>
              </div>

              {useError && (
                <div style={{ borderRadius: 10, background: 'rgba(139,26,26,0.15)', border: '1px solid rgba(224,96,96,0.28)', padding: '8px 12px', marginBottom: 14 }}>
                  <p style={{ fontSize: 11, color: '#E06060' }}>{useError}</p>
                </div>
              )}

              <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.36)', textAlign: 'center', marginBottom: 20, letterSpacing: '0.04em' }}>
                本当に使用しますか？
              </p>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => { setShowUseConfirm(false); setPendingUseTicket(null); setUseError(null) }}
                  disabled={useConfirmLoading}
                  style={{ flex: 1, padding: '14px 0', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', fontSize: 13, color: 'rgba(242,230,200,0.52)', fontFamily: SERIF, letterSpacing: '0.14em', cursor: 'pointer' }}
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
                    color: useConfirmLoading ? 'rgba(208,244,216,0.4)' : '#D0F4D8',
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
            <p style={{ fontSize: 10, letterSpacing: '0.44em', color: 'rgba(100,200,100,0.62)', marginBottom: 14 }}>USED</p>
            <p style={{ fontFamily: SERIF, fontSize: 34, fontWeight: 700, color: '#80E060', letterSpacing: '0.14em', marginBottom: 18, lineHeight: 1.1, textShadow: '0 0 40px rgba(80,192,80,0.4), 0 2px 6px rgba(0,0,0,0.95)' }}>
              使用完了
            </p>
            <p style={{ fontFamily: SERIF, fontSize: 16, color: '#F2E6C8', lineHeight: 1.9, letterSpacing: '0.04em', textShadow: '0 1px 10px rgba(0,0,0,0.95)', marginBottom: 16 }}>
              {useCompleteInfo.name}様の<br />
              {useCompleteInfo.label}{useCompleteInfo.amount > 0 ? ` ¥${useCompleteInfo.amount.toLocaleString()}` : ''} を<br />
              1枚使用しました。
            </p>
            <p style={{ fontFamily: SERIF, fontSize: 14, color: 'rgba(242,230,200,0.45)', letterSpacing: '0.06em' }}>
              残り：{useCompleteInfo.remaining}枚
            </p>
            {useCompleteInfo.checkedIn && (
              <p style={{ fontFamily: SERIF, fontSize: 12, color: 'rgba(128,224,96,0.68)', marginTop: 14, letterSpacing: '0.08em' }}>
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
            <p style={{ fontSize: 10, letterSpacing: '0.44em', color: 'rgba(201,162,74,0.62)', marginBottom: 14 }}>ISSUED</p>
            <p style={{ fontFamily: SERIF, fontSize: 40, fontWeight: 700, color: '#e6ca65', letterSpacing: '0.14em', marginBottom: 20, lineHeight: 1.1, textShadow: '0 0 40px rgba(201,162,74,0.55), 0 0 80px rgba(139,26,26,0.4), 0 2px 6px rgba(0,0,0,0.95)' }}>
              発行完了
            </p>
            <p style={{ fontFamily: SERIF, fontSize: 16, color: '#F2E6C8', lineHeight: 1.9, letterSpacing: '0.06em', textShadow: '0 1px 10px rgba(0,0,0,0.95)', marginBottom: 14 }}>
              {successInfo.name}様に<br />
              {successInfo.label} ¥{successInfo.amount.toLocaleString()} × {successInfo.qty}枚<br />
              を付与しました。
            </p>
            <div style={{ padding: '10px 16px', borderRadius: 10, background: 'rgba(201,162,74,0.08)', border: '1px solid rgba(201,162,74,0.22)' }}>
              <p style={{ fontSize: 10, color: 'rgba(201,162,74,0.65)', letterSpacing: '0.08em', lineHeight: 1.6 }}>
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
              <p style={{ fontSize: 9, letterSpacing: '0.34em', color: 'rgba(201,162,74,0.5)', marginBottom: 6 }}>STAFF SELECTION</p>
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
                      color: selected ? '#F2E6C8' : 'rgba(242,230,200,0.7)',
                      fontFamily: SERIF, fontSize: 22, fontWeight: 700, letterSpacing: '0.04em',
                      cursor: 'pointer', transition: 'all 0.15s', WebkitTapHighlightColor: 'transparent',
                    }}
                  >
                    {name}
                    {selected && <span style={{ display: 'block', fontSize: 10, color: 'rgba(201,162,74,0.7)', letterSpacing: '0.16em', marginTop: 4, fontWeight: 400 }}>選択中</span>}
                  </button>
                )
              })}
            </div>
            <div style={{ padding: '0 18px 18px' }}>
              <button onClick={() => setShowStaffPicker(false)} style={{ width: '100%', padding: '14px', borderRadius: 12, background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(242,230,200,0.36)', fontFamily: SERIF, fontSize: 14, cursor: 'pointer', letterSpacing: '0.12em' }}>
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
