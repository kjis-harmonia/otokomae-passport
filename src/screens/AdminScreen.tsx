import { useState, useRef, useCallback } from 'react'
import { Html5Qrcode } from 'html5-qrcode'
import { QRCodeSVG } from 'qrcode.react'
import { supabase } from '../lib/supabase'
import { getStoredValue, setStoredValue } from '../utils/storage'
import type { TicketRow, TicketType } from '../data/ticket'
import { TICKET_TYPE_LABELS, TICKET_TYPE_COLORS } from '../data/ticket'
import { issueTicket, getUserTickets, markTicketUsed } from '../utils/ticketStore'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const STAFF_NAME_KEY = 'ginjiro_staff_name'
const STAFF_NAMES = ['テイテイ', 'ヨンピル', '銀二郎', 'シルビア', 'リアン', 'キャンディ', 'ヒョウ']
// localStorage fallback key for dev / offline
const MAINTENANCE_LOCAL_KEY = 'ginjiro_maintenance_visits'

// ── Sound feedback (Web Audio API) ────────────────────────────────────────────

function playSuccessSound() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.type = 'sine'
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.35, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.5)
    setTimeout(() => ctx.close(), 700)
  } catch { /* AudioContext unavailable */ }
}

function playWarningSound() {
  try {
    const ctx = new AudioContext()
    ;[0, 0.22, 0.44].forEach(offset => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.type = 'square'
      osc.frequency.value = 440
      gain.gain.setValueAtTime(0.25, ctx.currentTime + offset)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.16)
      osc.start(ctx.currentTime + offset)
      osc.stop(ctx.currentTime + offset + 0.16)
    })
    setTimeout(() => ctx.close(), 900)
  } catch { /* AudioContext unavailable */ }
}

// ── Supabase: maintenance_visits ──────────────────────────────────────────────
// lastVisitDate はスタッフ端末でのみ書き込む。顧客側から変更不可。

async function fetchLastVisitDate(userId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('maintenance_visits')
      .select('last_visit_date')
      .eq('user_id', userId)
      .single()
    if (!error && data) return (data as { last_visit_date: string }).last_visit_date
  } catch { /* fall through */ }
  // localStorage fallback (dev / no Supabase env)
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
  // Always mirror to local fallback
  const local = getStoredValue<Record<string, string>>(MAINTENANCE_LOCAL_KEY, {})
  setStoredValue(MAINTENANCE_LOCAL_KEY, { ...local, [userId]: date })
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysSince(dateStr: string): number {
  const base = new Date(dateStr)
  base.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.floor((today.getTime() - base.getTime()) / 86_400_000)
}

function fmtDate(iso: string): string {
  return iso.replace(/-/g, '/')
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
  rank: 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM'
  points: number
}

// チケット使用QR（ユーザー側で生成、5分有効）
interface TicketUseQRData {
  type: 'ginjiro-ticket-use'
  userId: string
  selectedTicketId: string
  issuedAt: string
  expiresAt: string
}

type AnyQRData = PassportQRData | TicketUseQRData

const RANK_LABEL: Record<string, string> = {
  BRONZE:   'ブロンズ',
  SILVER:   'シルバー',
  GOLD:     'ゴールド',
  PLATINUM: 'プラチナ',
}

const RANK_COLOR: Record<string, string> = {
  BRONZE:   '#A67C52',
  SILVER:   '#B0BAC4',
  GOLD:     '#C9A24A',
  PLATINUM: '#DDE4EC',
}

// 店内設置用チェックインQR（静的、お客様がスキャン）
const STORE_CHECKIN_QR_VALUE = JSON.stringify({ type: 'ginjiro-store-checkin' })

function parseQR(text: string): AnyQRData | null {
  try {
    const d = JSON.parse(text)
    if (d.type === 'ginjiro-ticket-use' && d.userId && d.selectedTicketId) {
      return d as TicketUseQRData
    }
    if (d.type === 'ginjiro-member' && d.userId) {
      return { type: d.type, userId: d.userId, name: d.name || '名前未設定', rank: d.rank || 'BRONZE', points: d.points ?? 0 }
    }
    if (d.type === 'otokomae-passport' && d.userId) {
      return { type: d.type, userId: d.userId, name: d.name || '名前未設定', rank: d.rank || 'BRONZE', points: d.points ?? 0 }
    }
    return null
  } catch {
    return null
  }
}

// ── Ticket tabs (preset per type) ─────────────────────────────────────────────

const TICKET_TABS: { type: TicketType; label: string; autoTitle: string; amounts: number[] }[] = [
  { type: 'coupon',     label: 'クーポン', autoTitle: 'メンテナンスクーポン', amounts: [] },
  { type: 'discount',   label: '割引券',   autoTitle: '割引券',              amounts: [300, 500, 1000] },
  { type: 'cut-ticket', label: '漢トク券', autoTitle: '漢トク券',            amounts: [1000, 3000, 5000] },
]

// ── Phase ─────────────────────────────────────────────────────────────────────

type Phase = 'scan' | 'loading' | 'result' | 'ticket-loading' | 'ticket-result'

// ── QR Camera Scanner ─────────────────────────────────────────────────────────

const QR_EL_ID = 'gj-qr-reader'

interface ScannerProps {
  onScan: (text: string) => void
  onCameraError: (msg: string) => void
}

function QrCameraScanner({ onScan, onCameraError }: ScannerProps) {
  const instanceRef = useRef<Html5Qrcode | null>(null)
  const [active, setActive] = useState(false)

  const stop = useCallback(async () => {
    const s = instanceRef.current
    if (!s) return
    try {
      if (s.isScanning) await s.stop()
      s.clear()
    } catch { /* ignore */ }
    instanceRef.current = null
    setActive(false)
  }, [])

  const start = useCallback(async () => {
    if (instanceRef.current) return
    const scanner = new Html5Qrcode(QR_EL_ID)
    instanceRef.current = scanner
    try {
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (decoded) => { onScan(decoded); stop() },
        undefined,
      )
      setActive(true)
    } catch {
      instanceRef.current = null
      onCameraError('カメラにアクセスできません。手動入力をご利用ください。')
    }
  }, [onScan, onCameraError, stop])

  return (
    <div>
      <div
        id={QR_EL_ID}
        style={{
          width: '100%',
          minHeight: active ? 280 : 0,
          borderRadius: active ? 16 : 0,
          overflow: 'hidden',
          marginBottom: active ? 12 : 0,
        }}
      />
      {!active ? (
        <button
          onClick={start}
          style={{
            width: '100%', padding: '18px', borderRadius: 14,
            background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
            border: '1px solid rgba(201,162,74,0.44)',
            boxShadow: '0 4px 20px rgba(107,15,18,0.45)',
            color: '#F2E6C8', fontFamily: SERIF, fontSize: 18,
            fontWeight: 700, letterSpacing: '0.2em', cursor: 'pointer',
          }}
        >
          QRを読み取る
        </button>
      ) : (
        <button
          onClick={stop}
          style={{
            width: '100%', padding: '14px', borderRadius: 14,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'rgba(242,230,200,0.6)', fontFamily: SERIF, fontSize: 13,
            fontWeight: 600, letterSpacing: '0.14em', cursor: 'pointer',
          }}
        >
          スキャン停止
        </button>
      )}
    </div>
  )
}

// ── AdminScreen ───────────────────────────────────────────────────────────────

export function AdminScreen() {
  const [phase, setPhase] = useState<Phase>('scan')

  // Scan state
  const [scannedData, setScannedData]             = useState<PassportQRData | null>(null)
  // prevLastVisitDate = DB の値（今日スキャン前）。判定はこちらで行う。
  const [prevLastVisitDate, setPrevLastVisitDate] = useState<string | null | undefined>(undefined)
  const [parseError, setParseError]               = useState<string | null>(null)
  const [cameraError, setCameraError]             = useState<string | null>(null)
  const [showManual, setShowManual]               = useState(false)
  const [manualInput, setManualInput]             = useState('')

  // Staff name
  const [staffId, setStaffId]               = useState(() => getStoredValue<string>(STAFF_NAME_KEY, ''))
  const [showStaffPicker, setShowStaffPicker] = useState(false)

  // Ticket form
  const [ticketTab, setTicketTab]         = useState<TicketType>('coupon')
  const [ticketAmount, setTicketAmount]   = useState<number>(0)
  const [issueLoading, setIssueLoading]   = useState(false)
  const [issueError, setIssueError]       = useState<string | null>(null)
  const [issuedCount, setIssuedCount]     = useState(0)
  const [lastIssuedMsg, setLastIssuedMsg] = useState<string | null>(null)

  // User's existing tickets
  const [userTickets, setUserTickets]       = useState<TicketRow[]>([])
  const [ticketsLoading, setTicketsLoading] = useState(false)
  const [markingUsed, setMarkingUsed]       = useState<string | null>(null)

  // Ticket-use QR flow
  const [ticketUseData, setTicketUseData]       = useState<TicketUseQRData | null>(null)
  const [ticketForUse, setTicketForUse]         = useState<TicketRow | null>(null)
  const [ticketQrExpired, setTicketQrExpired]   = useState(false)
  const [isMaintenanceCut, setIsMaintenanceCut] = useState(false)
  const [ticketConfirming, setTicketConfirming] = useState(false)
  const [ticketConfirmed, setTicketConfirmed]   = useState(false)
  const [ticketBlockMsg, setTicketBlockMsg]     = useState<string | null>(null)
  const [ticketUsedThisSession, setTicketUsedThisSession] = useState(false)

  // Store QR display
  const [showStoreQr, setShowStoreQr] = useState(false)

  // ── Derived ───────────────────────────────────────────────────────────────

  // undefined = まだ取得していない、null = 初回来店（DB記録なし）
  const isFirstVisit = prevLastVisitDate === null
  const elapsed      = prevLastVisitDate ? daysSince(prevLastVisitDate) : null
  const isEligible   = !isFirstVisit && prevLastVisitDate !== undefined && elapsed! <= 14

  const rankColor  = scannedData ? (RANK_COLOR[scannedData.rank] ?? '#C9A24A') : '#C9A24A'
  const canIssue   = staffId.trim() !== '' && !issueLoading && (ticketTab === 'coupon' || ticketAmount > 0)
  const activeTickets = userTickets.filter(t => !t.used)

  // ── Handlers ──────────────────────────────────────────────────────────────

  const loadUserTickets = useCallback(async (userId: string) => {
    setTicketsLoading(true)
    try {
      const tickets = await getUserTickets(userId)
      setUserTickets(tickets)
    } catch {
      setUserTickets([])
    } finally {
      setTicketsLoading(false)
    }
  }, [])

  const handleScanned = useCallback(async (text: string) => {
    const data = parseQR(text)
    if (!data) {
      setParseError(`認識できないQRコードです\n→ ${text.slice(0, 80)}`)
      return
    }
    setParseError(null)

    // ── チケット使用QRの場合 ──
    if (data.type === 'ginjiro-ticket-use') {
      const tuData = data as TicketUseQRData
      setTicketUseData(tuData)
      setTicketBlockMsg(null)
      setTicketConfirmed(false)
      setTicketForUse(null)
      setPhase('ticket-loading')

      // QR有効期限チェック（5分）
      if (new Date() > new Date(tuData.expiresAt)) {
        setTicketQrExpired(true)
        setPhase('ticket-result')
        return
      }
      setTicketQrExpired(false)

      // チケット情報を取得
      try {
        const tickets = await getUserTickets(tuData.userId)
        const found   = tickets.find(t => t.id === tuData.selectedTicketId) ?? null
        setTicketForUse(found)
      } catch {
        setTicketForUse(null)
      }
      setPhase('ticket-result')
      return
    }

    // ── 男前証QRの場合（既存フロー） ──
    const passportData = data as PassportQRData
    setScannedData(passportData)
    setPhase('loading')

    // 1. DB から前回 lastVisitDate を取得（判定の基準）
    const prev = await fetchLastVisitDate(passportData.userId)
    setPrevLastVisitDate(prev)

    // 2. 今日の日付を DB に保存（スタッフ端末でのみ更新）
    await upsertLastVisitDate(passportData.userId, todayISO())

    // 3. 判定音を鳴らす
    if (prev === null) {
      // 初回来店 — 音なし
    } else if (daysSince(prev) <= 14) {
      playSuccessSound()
    } else {
      playWarningSound()
    }

    // 4. 保有チケット取得
    await loadUserTickets(passportData.userId)
    setPhase('result')
  }, [loadUserTickets])

  function handleTabChange(type: TicketType) {
    const tab = TICKET_TABS.find(t => t.type === type)!
    setTicketTab(type)
    setTicketAmount(tab.amounts[0] ?? 0)
    setIssueError(null)
    setLastIssuedMsg(null)
  }

  const handleIssueTicket = async () => {
    if (!scannedData || !staffId.trim()) return
    const currentTab = TICKET_TABS.find(t => t.type === ticketTab)!
    setIssueLoading(true)
    setIssueError(null)
    setLastIssuedMsg(null)
    try {
      const issued = await issueTicket({
        user_id:   scannedData.userId,
        type:      ticketTab,
        title:     currentTab.autoTitle,
        amount:    ticketAmount,
        issued_by: staffId,
      })
      setUserTickets(prev => [issued, ...prev])
      setIssuedCount(c => c + 1)
      const amtLabel = ticketAmount > 0 ? ` ¥${ticketAmount.toLocaleString()}` : ''
      setLastIssuedMsg(`「${currentTab.autoTitle}」${amtLabel} を発行しました`)
    } catch {
      setIssueError('発行に失敗しました。ネットワークを確認してください。')
    } finally {
      setIssueLoading(false)
    }
  }

  const handleMarkUsed = async (ticketId: string) => {
    if (!staffId.trim()) return
    setMarkingUsed(ticketId)
    try {
      await markTicketUsed(ticketId, staffId)
      setUserTickets(prev =>
        prev.map(t => t.id === ticketId ? { ...t, used: true, used_at: new Date().toISOString() } : t)
      )
    } catch { /* non-fatal */ }
    finally { setMarkingUsed(null) }
  }

  const handleConfirmTicketUse = async () => {
    if (!ticketUseData || !ticketForUse || !staffId.trim()) return

    // 1会計1枚制限
    if (ticketUsedThisSession) {
      setTicketBlockMsg('このお会計では既にチケットを1枚使用しています。')
      return
    }

    // メンテナンスカット制限: coupon以外は不可
    if (isMaintenanceCut && ticketForUse.type !== 'coupon') {
      setTicketBlockMsg('メンテナンスカットではこのチケットは使用できません。')
      return
    }

    // 使用済みチェック
    if (ticketForUse.used) {
      setTicketBlockMsg('このチケットはすでに使用済みです。')
      return
    }

    setTicketConfirming(true)
    setTicketBlockMsg(null)
    try {
      await markTicketUsed(ticketForUse.id, staffId)
      await upsertLastVisitDate(ticketUseData.userId, todayISO())
      setTicketForUse(prev => prev ? { ...prev, used: true, used_at: new Date().toISOString() } : prev)
      setTicketConfirmed(true)
      setTicketUsedThisSession(true)
      playSuccessSound()
    } catch {
      setTicketBlockMsg('使用確定に失敗しました。ネットワークを確認してください。')
    } finally {
      setTicketConfirming(false)
    }
  }

  function handleReset() {
    setPhase('scan')
    setScannedData(null)
    setPrevLastVisitDate(undefined)
    setParseError(null)
    setCameraError(null)
    setShowManual(false)
    setManualInput('')
    setTicketTab('coupon')
    setTicketAmount(0)
    setIssueError(null)
    setIssuedCount(0)
    setLastIssuedMsg(null)
    setUserTickets([])
    // ticket-use state
    setTicketUseData(null)
    setTicketForUse(null)
    setTicketQrExpired(false)
    setIsMaintenanceCut(false)
    setTicketConfirmed(false)
    setTicketBlockMsg(null)
    setTicketUsedThisSession(false)
  }

  function handleSelectStaff(name: string) {
    setStaffId(name)
    setStoredValue(STAFF_NAME_KEY, name)
    setShowStaffPicker(false)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{
      minHeight: '100dvh',
      background: 'linear-gradient(180deg, #080302 0%, #0A0403 60%, #090304 100%)',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* ── Header ── */}
      <header style={{
        padding: '20px 20px 16px',
        borderBottom: '1px solid rgba(201,162,74,0.14)',
        background: 'linear-gradient(180deg, rgba(201,162,74,0.04) 0%, transparent 100%)',
        flexShrink: 0,
      }}>
        <div style={{
          height: 2,
          background: 'linear-gradient(90deg, transparent, #8B1A1A 30%, #C9A24A 50%, #8B1A1A 70%, transparent)',
          marginBottom: 14,
        }} />
        <p style={{ fontSize: 9, letterSpacing: '0.32em', color: 'rgba(201,162,74,0.52)', textAlign: 'center', marginBottom: 3 }}>
          STAFF TERMINAL
        </p>
        <h1 style={{
          fontSize: 22, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF,
          letterSpacing: '0.1em', textAlign: 'center', marginBottom: 2,
        }}>
          銀二郎端末
        </h1>
        <p style={{ fontSize: 8, letterSpacing: '0.26em', color: 'rgba(201,162,74,0.38)', textAlign: 'center', marginBottom: 10 }}>
          OTOKOMAE PASSPORT SCANNER
        </p>

        {/* Staff Name */}
        <button
          onClick={() => setShowStaffPicker(true)}
          style={{
            display: 'block', margin: '0 auto',
            padding: '10px 28px', borderRadius: 12,
            background: staffId ? 'rgba(139,26,26,0.35)' : 'rgba(224,96,70,0.12)',
            border: `1.5px solid ${staffId ? 'rgba(201,162,74,0.6)' : 'rgba(224,96,70,0.45)'}`,
            boxShadow: staffId ? '0 0 12px rgba(201,162,74,0.12)' : 'none',
            color: staffId ? '#F2E6C8' : '#E07050',
            fontSize: 16, fontFamily: SERIF, fontWeight: 700,
            letterSpacing: '0.10em', cursor: 'pointer',
          }}
        >
          {staffId ? `担当者：${staffId}` : '担当者IDを設定'}
        </button>
      </header>

      {/* ── Main ── */}
      <main style={{
        flex: 1, overflowY: 'auto', padding: '24px 20px 32px',
        maxWidth: 480, margin: '0 auto', width: '100%', boxSizing: 'border-box',
      }}>

        {/* ===== SCAN ===== */}
        {phase === 'scan' && (
          <div>
            <div style={{
              borderRadius: 20, border: '1px solid rgba(201,162,74,0.18)',
              background: '#0A0504', overflow: 'hidden', marginBottom: 16,
            }}>
              <div style={{ padding: '32px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: 72, height: 72, position: 'relative', marginBottom: 12 }}>
                  {[
                    { top: 0,    left: 0,    borderTop: '3px solid',    borderLeft: '3px solid',   borderRadius: '4px 0 0 0' },
                    { top: 0,    right: 0,   borderTop: '3px solid',    borderRight: '3px solid',  borderRadius: '0 4px 0 0' },
                    { bottom: 0, left: 0,    borderBottom: '3px solid', borderLeft: '3px solid',   borderRadius: '0 0 0 4px' },
                    { bottom: 0, right: 0,   borderBottom: '3px solid', borderRight: '3px solid',  borderRadius: '0 0 4px 0' },
                  ].map((s, i) => (
                    <div key={i} style={{ position: 'absolute', width: 20, height: 20, borderColor: 'rgba(201,162,74,0.44)', ...s }} />
                  ))}
                </div>
                <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.35)', fontFamily: SERIF, letterSpacing: '0.06em' }}>
                  男前パスポートのQRをスキャン
                </p>
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              {!staffId.trim() ? (
                <div style={{
                  padding: '28px 20px', borderRadius: 16,
                  background: 'rgba(139,26,26,0.12)',
                  border: '1px solid rgba(201,162,74,0.24)',
                  textAlign: 'center',
                }}>
                  <p style={{
                    fontFamily: SERIF, fontSize: 20, fontWeight: 700,
                    color: '#C9A24A', letterSpacing: '0.06em',
                    marginBottom: 18, lineHeight: 1.6,
                  }}>
                    先に担当者を選択してください
                  </p>
                  <button
                    onClick={() => setShowStaffPicker(true)}
                    style={{
                      padding: '16px 32px', borderRadius: 14,
                      background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
                      border: '1px solid rgba(201,162,74,0.5)',
                      boxShadow: '0 4px 20px rgba(107,15,18,0.4)',
                      color: '#F2E6C8', fontFamily: SERIF, fontSize: 17,
                      fontWeight: 700, letterSpacing: '0.14em', cursor: 'pointer',
                    }}
                  >
                    担当者を選択する
                  </button>
                </div>
              ) : (
                <QrCameraScanner
                  onScan={(text) => { void handleScanned(text) }}
                  onCameraError={(msg) => { setCameraError(msg); setShowManual(true) }}
                />
              )}
            </div>

            {cameraError && (
              <p style={{ fontSize: 12, color: '#E06060', textAlign: 'center', marginBottom: 12, lineHeight: 1.5 }}>
                {cameraError}
              </p>
            )}
            {parseError && (
              <div style={{
                borderRadius: 12, background: 'rgba(139,26,26,0.15)',
                border: '1px solid rgba(224,96,96,0.28)', padding: '10px 14px', marginBottom: 12,
              }}>
                <p style={{ fontSize: 12, color: '#E06060', whiteSpace: 'pre-line' }}>{parseError}</p>
              </div>
            )}

            <button
              onClick={() => setShowManual(v => !v)}
              style={{
                width: '100%', padding: '15px', borderRadius: 12,
                background: 'transparent', border: '1px solid rgba(201,162,74,0.18)',
                color: 'rgba(201,162,74,0.55)', fontSize: 15,
                letterSpacing: '0.14em', cursor: 'pointer', fontFamily: SERIF,
              }}
            >
              {showManual ? '手動入力を閉じる' : '手動入力（カメラ非対応時）'}
            </button>

            {showManual && (
              <div style={{ marginTop: 12 }}>
                <textarea
                  value={manualInput}
                  onChange={e => setManualInput(e.target.value)}
                  placeholder={'{"type":"otokomae-passport","userId":"demo-user-001","name":"慶一郎","rank":"GOLD","points":52000}'}
                  rows={4}
                  style={{
                    width: '100%', padding: '12px', borderRadius: 12,
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(201,162,74,0.22)',
                    color: '#F2E6C8', fontSize: 11, fontFamily: 'monospace',
                    resize: 'vertical', outline: 'none',
                    boxSizing: 'border-box', marginBottom: 10, lineHeight: 1.5,
                  }}
                />
                <button
                  onClick={() => { if (manualInput.trim()) { void handleScanned(manualInput.trim()); setManualInput('') } }}
                  disabled={!manualInput.trim()}
                  style={{
                    width: '100%', padding: '16px', borderRadius: 12,
                    background: manualInput.trim() ? 'rgba(40,80,20,0.5)' : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${manualInput.trim() ? 'rgba(120,180,80,0.4)' : 'rgba(255,255,255,0.1)'}`,
                    color: manualInput.trim() ? '#C8F0A0' : 'rgba(255,255,255,0.25)',
                    fontFamily: SERIF, fontSize: 16, fontWeight: 700,
                    letterSpacing: '0.14em',
                    cursor: manualInput.trim() ? 'pointer' : 'default',
                  }}
                >
                  読み取る
                </button>
              </div>
            )}

            {/* 店内設置QR表示ボタン */}
            <div style={{ marginTop: 20 }}>
              <button
                onClick={() => setShowStoreQr(v => !v)}
                style={{ width: '100%', padding: '11px', borderRadius: 12, background: 'transparent', border: '1px solid rgba(201,162,74,0.14)', color: 'rgba(201,162,74,0.44)', fontSize: 11, letterSpacing: '0.14em', cursor: 'pointer', fontFamily: SERIF }}
              >
                {showStoreQr ? '店内設置QRを閉じる' : '店内設置QRを表示（印刷用）'}
              </button>
              {showStoreQr && (
                <div style={{ marginTop: 12, borderRadius: 16, background: '#0A0504', border: '1px solid rgba(201,162,74,0.18)', padding: '20px', textAlign: 'center' }}>
                  <p style={{ fontSize: 9, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.5)', marginBottom: 10 }}>STORE CHECK-IN QR</p>
                  <div style={{ display: 'inline-block', padding: 14, background: '#FFFFFF', borderRadius: 12 }}>
                    {/* QRCodeSVG は直接 import しているので使用可能 */}
                    <QRCodeSVG value={STORE_CHECKIN_QR_VALUE} size={180} level="M" />
                  </div>
                  <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.3)', marginTop: 10, lineHeight: 1.6 }}>
                    お客様がこのQRをアプリでスキャンすることで<br />来店チェックインが完了します
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ===== LOADING ===== */}
        {phase === 'loading' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 72 }}>
            <style>{`@keyframes gj-spin { to { transform: rotate(360deg); } }`}</style>
            <div style={{
              width: 48, height: 48, borderRadius: '50%',
              border: '2px solid rgba(201,162,74,0.14)',
              borderTop: '2px solid rgba(201,162,74,0.7)',
              animation: 'gj-spin 0.8s linear infinite',
              marginBottom: 20,
            }} />
            <p style={{ fontSize: 14, color: 'rgba(242,230,200,0.4)', fontFamily: SERIF, letterSpacing: '0.14em' }}>
              判定中...
            </p>
          </div>
        )}

        {/* ===== RESULT ===== */}
        {phase === 'result' && scannedData && (
          <div>

            {/* ── Judgment banner ── */}
            {isFirstVisit ? (
              /* 初回来店 */
              <div style={{
                borderRadius: 20, marginBottom: 16, overflow: 'hidden',
                background: 'linear-gradient(135deg, rgba(30,50,90,0.5), rgba(15,30,70,0.7))',
                border: '1px solid rgba(90,130,210,0.3)',
                padding: '28px 22px', textAlign: 'center',
              }}>
                <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, #6090E0 50%, transparent)', marginLeft: -22, marginRight: -22, marginBottom: 20 }} />
                <p style={{ fontSize: 9, letterSpacing: '0.3em', color: 'rgba(90,150,230,0.7)', marginBottom: 12 }}>FIRST VISIT</p>
                <p style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 700, color: '#90B8F0', letterSpacing: '0.06em', marginBottom: 8 }}>
                  初回来店
                </p>
                <p style={{ fontSize: 12, color: 'rgba(140,180,240,0.55)', letterSpacing: '0.08em', lineHeight: 1.6 }}>
                  判定対象外<br />次回から14日ルールが適用されます
                </p>
              </div>
            ) : isEligible ? (
              /* メンテナンスカット対象 */
              <div style={{
                borderRadius: 20, marginBottom: 16, overflow: 'hidden',
                background: 'linear-gradient(135deg, rgba(15,50,22,0.6), rgba(8,35,15,0.8))',
                border: '1px solid rgba(80,192,90,0.38)',
                padding: '28px 22px', textAlign: 'center',
                boxShadow: '0 4px 36px rgba(80,192,80,0.14)',
              }}>
                <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, #78C050 50%, transparent)', marginLeft: -22, marginRight: -22, marginBottom: 20 }} />
                <p style={{ fontSize: 9, letterSpacing: '0.3em', color: 'rgba(120,192,80,0.7)', marginBottom: 12 }}>
                  MAINTENANCE CUT — ELIGIBLE
                </p>
                <p style={{
                  fontFamily: SERIF, fontSize: 28, fontWeight: 700,
                  color: '#80E060', letterSpacing: '0.04em', marginBottom: 14,
                  textShadow: '0 0 24px rgba(120,192,80,0.5)',
                }}>
                  メンテナンスカット対象
                </p>
                <div style={{
                  display: 'inline-block',
                  background: 'rgba(80,192,80,0.12)', border: '1px solid rgba(80,192,80,0.3)',
                  borderRadius: 12, padding: '8px 24px',
                }}>
                  <p style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, color: 'rgba(140,230,100,0.9)' }}>
                    前回来店から {elapsed} 日
                  </p>
                </div>
              </div>
            ) : (
              /* 対象外 */
              <div style={{
                borderRadius: 20, marginBottom: 16, overflow: 'hidden',
                background: 'linear-gradient(135deg, rgba(70,15,15,0.6), rgba(50,8,8,0.8))',
                border: '1px solid rgba(200,80,60,0.3)',
                padding: '28px 22px', textAlign: 'center',
                boxShadow: '0 4px 32px rgba(200,60,60,0.1)',
              }}>
                <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, #C06040 50%, transparent)', marginLeft: -22, marginRight: -22, marginBottom: 20 }} />
                <p style={{ fontSize: 9, letterSpacing: '0.3em', color: 'rgba(200,100,80,0.7)', marginBottom: 12 }}>
                  MAINTENANCE CUT — NOT ELIGIBLE
                </p>
                <p style={{
                  fontFamily: SERIF, fontSize: 28, fontWeight: 700,
                  color: '#E06040', letterSpacing: '0.06em', marginBottom: 14,
                }}>
                  対象外
                </p>
                <div style={{
                  display: 'inline-block',
                  background: 'rgba(200,80,60,0.1)', border: '1px solid rgba(200,80,60,0.28)',
                  borderRadius: 12, padding: '8px 24px', marginBottom: 12,
                }}>
                  <p style={{ fontFamily: SERIF, fontSize: 24, fontWeight: 700, color: 'rgba(224,100,80,0.85)' }}>
                    前回来店から {elapsed} 日
                  </p>
                </div>
                <p style={{ fontSize: 13, color: 'rgba(220,120,100,0.6)', letterSpacing: '0.06em', fontFamily: SERIF }}>
                  通常メニューをご案内ください
                </p>
              </div>
            )}

            {/* ── Member card ── */}
            <div style={{
              borderRadius: 16, marginBottom: 16,
              border: `1px solid ${rankColor}44`,
              background: 'linear-gradient(160deg, #120A06 0%, #0A0504 100%)',
              boxShadow: `0 8px 30px rgba(0,0,0,0.5), 0 0 0 1px ${rankColor}10`,
            }}>
              <div style={{ height: 2, background: `linear-gradient(90deg, transparent, ${rankColor}, transparent)` }} />
              <div style={{ padding: '14px 18px' }}>
                <span style={{
                  display: 'inline-block', fontSize: 9, letterSpacing: '0.18em', fontWeight: 700,
                  color: rankColor, padding: '2px 8px', borderRadius: 99,
                  border: `1px solid ${rankColor}44`, background: `${rankColor}14`, marginBottom: 6,
                }}>
                  {RANK_LABEL[scannedData.rank] ?? scannedData.rank}
                </span>
                <h2 style={{
                  fontSize: 24, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF,
                  letterSpacing: '0.06em', marginBottom: 2,
                }}>
                  {scannedData.name}
                  <span style={{ fontSize: 14, marginLeft: 5, color: 'rgba(242,230,200,0.45)' }}>様</span>
                </h2>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 }}>
                  <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.28)', letterSpacing: '0.08em' }}>
                    ID: {scannedData.userId}
                  </p>
                  {prevLastVisitDate && (
                    <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.32)' }}>
                      前回 {fmtDate(prevLastVisitDate)}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* ── Ticket issue form ── */}
            <div style={{
              borderRadius: 16, marginBottom: 16,
              border: '1px solid rgba(74,127,201,0.22)',
              background: 'rgba(74,127,201,0.04)',
              padding: '16px 18px',
            }}>
              <p style={{
                fontSize: 10, letterSpacing: '0.18em', color: 'rgba(74,127,201,0.8)',
                marginBottom: 12, fontFamily: SERIF, fontWeight: 700,
              }}>
                チケット発行
                {issuedCount > 0 && (
                  <span style={{
                    marginLeft: 8, fontSize: 9, padding: '1px 7px', borderRadius: 99,
                    background: 'rgba(74,127,201,0.2)', border: '1px solid rgba(74,127,201,0.4)',
                    color: '#6AABF0',
                  }}>
                    発行済 {issuedCount}件
                  </span>
                )}
              </p>

              {/* Tab selector */}
              <div style={{ display: 'flex', gap: 7, marginBottom: 14 }}>
                {TICKET_TABS.map(tab => {
                  const tc = TICKET_TYPE_COLORS[tab.type]
                  const active = ticketTab === tab.type
                  return (
                    <button
                      key={tab.type}
                      onClick={() => handleTabChange(tab.type)}
                      style={{
                        flex: 1, padding: '11px 4px', borderRadius: 10,
                        background: active ? tc.bg : 'transparent',
                        border: `1px solid ${active ? tc.border : 'rgba(255,255,255,0.1)'}`,
                        color: active ? tc.text : 'rgba(242,230,200,0.32)',
                        fontSize: 12, fontFamily: SERIF, fontWeight: 700,
                        letterSpacing: '0.06em', cursor: 'pointer',
                      }}
                    >
                      {tab.label}
                    </button>
                  )
                })}
              </div>

              {/* Auto-title display */}
              {(() => {
                const currentTab = TICKET_TABS.find(t => t.type === ticketTab)!
                const tc = TICKET_TYPE_COLORS[ticketTab]
                return (
                  <>
                    <div style={{
                      padding: '10px 14px', borderRadius: 10, marginBottom: 12,
                      background: tc.bg, border: `1px solid ${tc.border}`,
                      display: 'flex', alignItems: 'center', gap: 10,
                    }}>
                      <div style={{ flex: 1 }}>
                        <p style={{ fontSize: 9, letterSpacing: '0.2em', color: 'rgba(242,230,200,0.35)', marginBottom: 3 }}>
                          発行チケット
                        </p>
                        <p style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: tc.text, letterSpacing: '0.06em' }}>
                          {currentTab.autoTitle}
                        </p>
                      </div>
                    </div>

                    {/* Preset amount buttons (割引券 / 漢トク券) */}
                    {currentTab.amounts.length > 0 && (
                      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                        {currentTab.amounts.map(amt => (
                          <button
                            key={amt}
                            onClick={() => setTicketAmount(amt)}
                            style={{
                              flex: 1, padding: '13px 4px', borderRadius: 10,
                              background: ticketAmount === amt ? tc.bg : 'transparent',
                              border: `1px solid ${ticketAmount === amt ? tc.border : 'rgba(255,255,255,0.1)'}`,
                              color: ticketAmount === amt ? tc.text : 'rgba(242,230,200,0.35)',
                              fontFamily: SERIF, fontSize: 14, fontWeight: 700, letterSpacing: '0.02em',
                              cursor: 'pointer', transition: 'all 0.15s',
                            }}
                          >
                            ¥{amt.toLocaleString()}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )
              })()}

              {issueError && (
                <p style={{ fontSize: 12, color: '#E06060', marginBottom: 8 }}>{issueError}</p>
              )}
              {lastIssuedMsg && (
                <p style={{ fontSize: 12, color: '#78C050', marginBottom: 8, letterSpacing: '0.06em' }}>
                  ✓ {lastIssuedMsg}
                </p>
              )}

              <button
                onClick={handleIssueTicket}
                disabled={!canIssue}
                style={{
                  width: '100%', padding: '13px', borderRadius: 12,
                  background: canIssue
                    ? 'linear-gradient(135deg, rgba(74,127,201,0.25) 0%, rgba(74,127,201,0.45) 100%)'
                    : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${canIssue ? 'rgba(74,127,201,0.5)' : 'rgba(255,255,255,0.08)'}`,
                  color: canIssue ? '#8DC4F4' : 'rgba(242,230,200,0.22)',
                  fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.14em',
                  cursor: canIssue ? 'pointer' : 'default',
                }}
              >
                {issueLoading
                  ? '発行中…'
                  : !staffId.trim()
                  ? '担当者を選択してください'
                  : '発行する'}
              </button>
            </div>

            {/* ── User's existing tickets ── */}
            {(activeTickets.length > 0 || ticketsLoading) && (
              <div style={{
                borderRadius: 16, marginBottom: 16,
                border: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(255,255,255,0.02)',
                padding: '14px 16px',
              }}>
                <p style={{
                  fontSize: 10, letterSpacing: '0.16em', color: 'rgba(242,230,200,0.35)',
                  marginBottom: 10, fontFamily: SERIF,
                }}>
                  保有チケット（未使用 {ticketsLoading ? '—' : `${activeTickets.length}件`}）
                </p>

                {ticketsLoading ? (
                  <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.28)', textAlign: 'center', padding: '8px 0' }}>
                    読込中…
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {activeTickets.map(ticket => {
                      const tc = TICKET_TYPE_COLORS[ticket.type]
                      return (
                        <div key={ticket.id} style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '10px 12px', borderRadius: 10,
                          background: tc.bg, border: `1px solid ${tc.border}`,
                        }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                              <span style={{
                                fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 99,
                                background: tc.bg, border: `1px solid ${tc.border}`, color: tc.text,
                              }}>
                                {TICKET_TYPE_LABELS[ticket.type]}
                              </span>
                              {ticket.amount > 0 && (
                                <span style={{ fontSize: 11, color: '#C9A24A', fontFamily: SERIF, fontWeight: 700 }}>
                                  ¥{ticket.amount.toLocaleString()}
                                </span>
                              )}
                            </div>
                            <p style={{ fontSize: 12, color: '#F2E6C8', fontFamily: SERIF }}>{ticket.title}</p>
                            <p style={{ fontSize: 9, color: 'rgba(242,230,200,0.3)', marginTop: 2 }}>
                              発行日 {fmtCreatedAt(ticket.created_at)}
                              {ticket.expires_at && ` ・ 期限 ${new Date(ticket.expires_at).toLocaleDateString('ja-JP')}`}
                            </p>
                          </div>
                          <button
                            onClick={() => { void handleMarkUsed(ticket.id) }}
                            disabled={markingUsed === ticket.id}
                            style={{
                              flexShrink: 0, padding: '6px 10px', borderRadius: 8,
                              background: 'rgba(255,255,255,0.06)',
                              border: '1px solid rgba(255,255,255,0.12)',
                              color: 'rgba(242,230,200,0.55)', fontSize: 10, fontFamily: SERIF,
                              fontWeight: 700, letterSpacing: '0.08em',
                              cursor: markingUsed === ticket.id ? 'default' : 'pointer',
                            }}
                          >
                            {markingUsed === ticket.id ? '…' : '使用済みに'}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Next customer */}
            <button
              onClick={handleReset}
              style={{
                width: '100%', padding: '16px', borderRadius: 16,
                background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
                border: '1px solid rgba(201,162,74,0.44)',
                boxShadow: '0 4px 24px rgba(107,15,18,0.5)',
                color: '#F2E6C8', fontFamily: SERIF, fontSize: 14,
                fontWeight: 700, letterSpacing: '0.22em', cursor: 'pointer',
              }}
            >
              次のお客様
            </button>
          </div>
        )}

        {/* ===== TICKET-LOADING ===== */}
        {phase === 'ticket-loading' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 72 }}>
            <style>{`@keyframes gj-spin { to { transform: rotate(360deg); } }`}</style>
            <div style={{ width: 48, height: 48, borderRadius: '50%', border: '2px solid rgba(201,162,74,0.14)', borderTop: '2px solid rgba(201,162,74,0.7)', animation: 'gj-spin 0.8s linear infinite', marginBottom: 20 }} />
            <p style={{ fontSize: 14, color: 'rgba(242,230,200,0.4)', fontFamily: SERIF, letterSpacing: '0.14em' }}>チケット確認中...</p>
          </div>
        )}

        {/* ===== TICKET-RESULT ===== */}
        {phase === 'ticket-result' && ticketUseData && (
          <div>
            {/* QR期限切れ */}
            {ticketQrExpired ? (
              <div style={{ borderRadius: 18, background: 'linear-gradient(135deg, rgba(70,15,15,0.6), rgba(50,8,8,0.8))', border: '1px solid rgba(200,80,60,0.3)', padding: '28px 22px', textAlign: 'center', marginBottom: 16 }}>
                <p style={{ fontSize: 9, letterSpacing: '0.3em', color: 'rgba(200,100,80,0.7)', marginBottom: 12 }}>QR EXPIRED</p>
                <p style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: '#E06040', marginBottom: 10 }}>QRコードの有効期限が切れています</p>
                <p style={{ fontSize: 12, color: 'rgba(220,120,100,0.6)', lineHeight: 1.6 }}>お客様に再度「使用する」を押していただいてください。</p>
              </div>
            ) : ticketForUse === null ? (
              /* チケット取得失敗 */
              <div style={{ borderRadius: 18, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', padding: '28px 22px', textAlign: 'center', marginBottom: 16 }}>
                <p style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: 'rgba(242,230,200,0.4)', marginBottom: 8 }}>チケットが見つかりません</p>
                <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.3)', lineHeight: 1.6 }}>すでに使用済みか、存在しないチケットです。</p>
              </div>
            ) : ticketConfirmed ? (
              /* 使用確定完了 */
              <div style={{ borderRadius: 18, background: 'linear-gradient(135deg, rgba(15,50,22,0.6), rgba(8,35,15,0.8))', border: '1px solid rgba(80,192,90,0.38)', padding: '28px 22px', textAlign: 'center', marginBottom: 16, boxShadow: '0 4px 36px rgba(80,192,80,0.14)' }}>
                <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(100,200,100,0.12)', border: '1px solid rgba(100,200,100,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', fontSize: 24 }}>✓</div>
                <p style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: '#80E060', marginBottom: 10 }}>使用確定しました</p>
                <p style={{ fontFamily: SERIF, fontSize: 17, color: '#F2E6C8', marginBottom: 4 }}>{ticketForUse.title}</p>
                {ticketForUse.amount > 0 && (
                  <p style={{ fontFamily: SERIF, fontSize: 22, color: '#C9A24A', marginBottom: 4 }}>¥{ticketForUse.amount.toLocaleString()}</p>
                )}
                <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.4)', marginTop: 10, lineHeight: 1.7 }}>来店日を記録しました</p>
              </div>
            ) : (
              /* 使用確定前 */
              <>
                {/* チケット情報 */}
                {(() => {
                  const tc = TICKET_TYPE_COLORS[ticketForUse.type]
                  const isUsed    = ticketForUse.used
                  const isExpired = !!ticketForUse.expires_at && new Date(ticketForUse.expires_at) < new Date()
                  return (
                    <div style={{ borderRadius: 16, marginBottom: 14, border: `1px solid ${tc.border}`, background: 'linear-gradient(160deg, #120A06 0%, #0A0504 100%)', overflow: 'hidden' }}>
                      <div style={{ height: 2, background: `linear-gradient(90deg, transparent, ${tc.border}, transparent)` }} />
                      <div style={{ padding: '16px 18px' }}>
                        <p style={{ fontSize: 9, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.52)', marginBottom: 8, fontFamily: SERIF }}>チケット確認</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: tc.bg, border: `1px solid ${tc.border}`, color: tc.text, letterSpacing: '0.1em' }}>
                            {TICKET_TYPE_LABELS[ticketForUse.type]}
                          </span>
                          {isUsed && <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: 'rgba(224,96,80,0.12)', border: '1px solid rgba(224,96,80,0.38)', color: '#E06050' }}>使用済み</span>}
                          {isExpired && <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: 'rgba(255,180,0,0.1)', border: '1px solid rgba(255,180,0,0.3)', color: '#FFB400' }}>期限切れ</span>}
                          {!isUsed && !isExpired && <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: 'rgba(100,210,110,0.08)', border: '1px solid rgba(100,210,110,0.3)', color: '#64D26E' }}>未使用</span>}
                        </div>
                        <p style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#F2E6C8', marginBottom: ticketForUse.amount > 0 ? 4 : 10 }}>{ticketForUse.title}</p>
                        {ticketForUse.amount > 0 && (
                          <p style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, color: '#C9A24A', marginBottom: 10, lineHeight: 1 }}>¥{ticketForUse.amount.toLocaleString()}</p>
                        )}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6, padding: '10px 12px', borderRadius: 10, background: 'rgba(255,255,255,0.03)' }}>
                          <p style={{ fontSize: 9, color: 'rgba(242,230,200,0.32)' }}>会員ID: {ticketUseData.userId.slice(0, 24)}…</p>
                          <p style={{ fontSize: 9, color: 'rgba(242,230,200,0.32)' }}>
                            {ticketForUse.expires_at ? `有効期限 ${ticketForUse.expires_at.slice(0,10).replace(/-/g,'/')}` : `発行日 ${fmtCreatedAt(ticketForUse.created_at)}`}
                          </p>
                          <p style={{ fontSize: 9, color: 'rgba(242,230,200,0.32)' }}>
                            QR有効期限 {new Date(ticketUseData.expiresAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} まで
                          </p>
                        </div>
                      </div>
                    </div>
                  )
                })()}

                {/* メンテナンスカットトグル */}
                <div style={{ borderRadius: 14, border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', padding: '12px 16px', marginBottom: 12 }}>
                  <p style={{ fontSize: 10, letterSpacing: '0.14em', color: 'rgba(242,230,200,0.38)', marginBottom: 10, fontFamily: SERIF }}>会計メニュー</p>
                  <button
                    onClick={() => { setIsMaintenanceCut(v => !v); setTicketBlockMsg(null) }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 12px', borderRadius: 10, background: isMaintenanceCut ? 'rgba(74,127,201,0.12)' : 'rgba(255,255,255,0.03)', border: `1px solid ${isMaintenanceCut ? 'rgba(74,127,201,0.4)' : 'rgba(255,255,255,0.1)'}`, cursor: 'pointer' }}
                  >
                    <div style={{ width: 18, height: 18, borderRadius: 4, background: isMaintenanceCut ? '#6AABF0' : 'transparent', border: `2px solid ${isMaintenanceCut ? '#6AABF0' : 'rgba(255,255,255,0.25)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.15s' }}>
                      {isMaintenanceCut && <span style={{ color: '#fff', fontSize: 12, fontWeight: 700, lineHeight: 1 }}>✓</span>}
                    </div>
                    <span style={{ fontSize: 13, fontFamily: SERIF, color: isMaintenanceCut ? '#6AABF0' : 'rgba(242,230,200,0.55)', letterSpacing: '0.08em' }}>
                      この会計はメンテナンスカット
                    </span>
                  </button>
                  {isMaintenanceCut && (
                    <p style={{ fontSize: 9, color: 'rgba(106,171,240,0.55)', marginTop: 6, lineHeight: 1.6, letterSpacing: '0.06em' }}>
                      ※ メンテナンスカットでは割引券・漢トク券は使用不可です
                    </p>
                  )}
                </div>

                {/* エラーメッセージ */}
                {ticketBlockMsg && (
                  <div style={{ borderRadius: 12, background: 'rgba(139,26,26,0.15)', border: '1px solid rgba(224,96,96,0.28)', padding: '10px 14px', marginBottom: 12 }}>
                    <p style={{ fontSize: 12, color: '#E06060' }}>{ticketBlockMsg}</p>
                  </div>
                )}

                {/* スタッフ未選択警告 */}
                {!staffId.trim() && (
                  <div style={{ borderRadius: 12, background: 'rgba(224,140,0,0.1)', border: '1px solid rgba(224,140,0,0.3)', padding: '10px 14px', marginBottom: 12 }}>
                    <p style={{ fontSize: 11, color: '#E08C00' }}>担当者を選択してください</p>
                  </div>
                )}

                {/* 1会計1枚制限警告 */}
                {ticketUsedThisSession && (
                  <div style={{ borderRadius: 12, background: 'rgba(255,180,0,0.08)', border: '1px solid rgba(255,180,0,0.28)', padding: '10px 14px', marginBottom: 12 }}>
                    <p style={{ fontSize: 11, color: '#FFB400' }}>このお会計では既に1枚使用しています（1会計1枚ルール）</p>
                  </div>
                )}

                {/* 使用確定ボタン */}
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

            {/* スキャン画面へ戻る */}
            <button
              onClick={handleReset}
              style={{ width: '100%', padding: '14px', borderRadius: 14, background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)', border: '1px solid rgba(201,162,74,0.44)', boxShadow: '0 4px 24px rgba(107,15,18,0.5)', color: '#F2E6C8', fontFamily: SERIF, fontSize: 14, fontWeight: 700, letterSpacing: '0.22em', cursor: 'pointer' }}
            >
              次のお客様
            </button>
          </div>
        )}
      </main>

      {/* ── Footer ── */}
      <footer style={{ padding: '12px 20px', borderTop: '1px solid rgba(201,162,74,0.07)', textAlign: 'center', flexShrink: 0 }}>
        <p style={{ fontSize: 9, letterSpacing: '0.2em', color: 'rgba(201,162,74,0.26)' }}>
          GINJIRO STAFF TERMINAL — Phase 1
        </p>
      </footer>

      {/* ── Staff Picker Modal ── */}
      {showStaffPicker && (
        <div
          onClick={() => setShowStaffPicker(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 300,
            background: 'rgba(0,0,0,0.88)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '24px',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%', maxWidth: 500,
              background: 'linear-gradient(180deg, #0D0403 0%, #0A0302 100%)',
              border: '1px solid rgba(201,162,74,0.32)',
              borderRadius: 22,
              boxShadow: '0 32px 80px rgba(0,0,0,0.9), 0 0 0 1px rgba(201,162,74,0.08)',
              overflow: 'hidden',
            }}
          >
            {/* Modal header */}
            <div style={{
              height: 2,
              background: 'linear-gradient(90deg, transparent, #8B1A1A 30%, #C9A24A 50%, #8B1A1A 70%, transparent)',
            }} />
            <div style={{ padding: '24px 24px 20px', textAlign: 'center', borderBottom: '1px solid rgba(201,162,74,0.12)' }}>
              <p style={{ fontSize: 9, letterSpacing: '0.34em', color: 'rgba(201,162,74,0.5)', marginBottom: 6 }}>
                STAFF SELECTION
              </p>
              <h2 style={{
                fontFamily: SERIF, fontSize: 20, fontWeight: 700,
                color: '#F2E6C8', letterSpacing: '0.08em',
              }}>
                担当者を選んでください
              </h2>
            </div>

            {/* Staff name grid */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 10,
              padding: '20px 20px 16px',
            }}>
              {STAFF_NAMES.map(name => {
                const selected = staffId === name
                return (
                  <button
                    key={name}
                    onClick={() => handleSelectStaff(name)}
                    style={{
                      padding: '22px 10px',
                      borderRadius: 14,
                      background: selected
                        ? 'linear-gradient(135deg, rgba(139,26,26,0.7) 0%, rgba(107,15,18,0.85) 100%)'
                        : 'rgba(0,0,0,0.5)',
                      border: `1.5px solid ${selected ? 'rgba(201,162,74,0.80)' : 'rgba(201,162,74,0.22)'}`,
                      boxShadow: selected ? '0 0 20px rgba(201,162,74,0.18), inset 0 1px 0 rgba(201,162,74,0.15)' : 'none',
                      color: selected ? '#F2E6C8' : 'rgba(242,230,200,0.7)',
                      fontFamily: SERIF,
                      fontSize: 22,
                      fontWeight: 700,
                      letterSpacing: '0.04em',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      WebkitTapHighlightColor: 'transparent',
                    }}
                  >
                    {name}
                    {selected && (
                      <span style={{ display: 'block', fontSize: 10, color: 'rgba(201,162,74,0.7)', letterSpacing: '0.16em', marginTop: 4, fontWeight: 400 }}>
                        選択中
                      </span>
                    )}
                  </button>
                )
              })}
            </div>

            {/* Cancel */}
            <div style={{ padding: '0 20px 20px' }}>
              <button
                onClick={() => setShowStaffPicker(false)}
                style={{
                  width: '100%', padding: '15px', borderRadius: 12,
                  background: 'transparent',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: 'rgba(242,230,200,0.38)',
                  fontFamily: SERIF, fontSize: 14, cursor: 'pointer',
                  letterSpacing: '0.12em',
                }}
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
