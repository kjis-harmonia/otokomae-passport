import { useState, useRef, useCallback } from 'react'
import { Html5Qrcode } from 'html5-qrcode'
import {
  recordVisit,
  loadVisitHistory,
  getDaysRemaining,
  formatVisitDate,
  MAINTENANCE_CUT_WINDOW_DAYS,
  awardPointsToUser,
} from '../utils/visitHistory'
import { setStoredValue, getStoredValue } from '../utils/storage'
import type { TicketRow, TicketType } from '../data/ticket'
import { TICKET_TYPE_LABELS, TICKET_TYPE_COLORS } from '../data/ticket'
import { issueTicket, getUserTickets, markTicketUsed } from '../utils/ticketStore'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const STAFF_ID_KEY = 'ginjiro_staff_id'

// ── QR payload ────────────────────────────────────────────────────────────────

interface PassportQRData {
  type: string
  userId: string
  name: string
  rank: 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM'
  points: number
}

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

function pointsToRankKey(points: number): PassportQRData['rank'] {
  if (points >= 100000) return 'PLATINUM'
  if (points >= 50000)  return 'GOLD'
  if (points >= 20000)  return 'SILVER'
  return 'BRONZE'
}

function parseQR(text: string): PassportQRData | null {
  try {
    const d = JSON.parse(text)
    if (d.type !== 'otokomae-passport' || !d.userId || !d.name || !d.rank) return null
    return d as PassportQRData
  } catch {
    return null
  }
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function addDaysDisplay(dateStr: string, n: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function fmtCreatedAt(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase = 'scan' | 'result' | 'done'

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
            width: '100%', padding: '14px', borderRadius: 14,
            background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
            border: '1px solid rgba(201,162,74,0.44)',
            boxShadow: '0 4px 20px rgba(107,15,18,0.45)',
            color: '#F2E6C8', fontFamily: SERIF, fontSize: 14,
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
  const [scannedData, setScannedData]     = useState<PassportQRData | null>(null)
  const [lastVisitDate, setLastVisitDate] = useState<string | null>(null)
  const [parseError, setParseError]       = useState<string | null>(null)
  const [cameraError, setCameraError]     = useState<string | null>(null)
  const [showManual, setShowManual]       = useState(false)
  const [manualInput, setManualInput]     = useState('')

  // Points input (result phase)
  const [awardedPointsInput, setAwardedPointsInput] = useState('')

  // Registration result (done phase)
  const [registeredDate, setRegisteredDate]   = useState<string | null>(null)
  const [finalAwardedPts, setFinalAwardedPts] = useState(0)
  const [finalTotalPts, setFinalTotalPts]     = useState(0)
  const [finalRankKey, setFinalRankKey]       = useState<PassportQRData['rank']>('BRONZE')

  // Staff ID
  const [staffId, setStaffId]             = useState(() => getStoredValue<string>(STAFF_ID_KEY, ''))
  const [showStaffIdInput, setShowStaffIdInput] = useState(false)
  const [staffIdDraft, setStaffIdDraft]   = useState('')

  // Ticket form (result phase)
  const [ticketType, setTicketType]       = useState<TicketType>('coupon')
  const [ticketTitle, setTicketTitle]     = useState('')
  const [ticketAmount, setTicketAmount]   = useState('')
  const [ticketMemo, setTicketMemo]       = useState('')
  const [ticketExpiresAt, setTicketExpiresAt] = useState('')
  const [issueLoading, setIssueLoading]   = useState(false)
  const [issueError, setIssueError]       = useState<string | null>(null)
  const [issuedCount, setIssuedCount]     = useState(0)

  // User's existing tickets (result phase)
  const [userTickets, setUserTickets]     = useState<TicketRow[]>([])
  const [ticketsLoading, setTicketsLoading] = useState(false)
  const [markingUsed, setMarkingUsed]     = useState<string | null>(null)

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

  const handleScanned = useCallback((text: string) => {
    const data = parseQR(text)
    if (!data) {
      setParseError(`認識できないQRコードです\n→ ${text.slice(0, 80)}`)
      return
    }
    setParseError(null)
    setScannedData(data)
    const history = loadVisitHistory()
    setLastVisitDate(history[0]?.visitedAt ?? null)
    setPhase('result')
    loadUserTickets(data.userId)
  }, [loadUserTickets])

  const handleRegister = () => {
    if (!scannedData) return

    const awarded  = Math.max(0, parseInt(awardedPointsInput, 10) || 0)
    const newTotal = scannedData.points + awarded
    const newRank  = pointsToRankKey(newTotal)
    const today    = todayISO()

    recordVisit({
      userId:        scannedData.userId,
      visitedAt:     today,
      serviceType:   'maintenance-cut',
      syncSource:    'qr',
      awardedPoints: awarded,
    })

    awardPointsToUser(scannedData.userId, awarded, today)

    setRegisteredDate(today)
    setLastVisitDate(today)
    setFinalAwardedPts(awarded)
    setFinalTotalPts(newTotal)
    setFinalRankKey(newRank)
    setPhase('done')
  }

  const handleReset = () => {
    setPhase('scan')
    setScannedData(null)
    setLastVisitDate(null)
    setRegisteredDate(null)
    setParseError(null)
    setCameraError(null)
    setShowManual(false)
    setManualInput('')
    setAwardedPointsInput('')
    setFinalAwardedPts(0)
    setFinalTotalPts(0)
    setTicketTitle('')
    setTicketAmount('')
    setTicketMemo('')
    setTicketExpiresAt('')
    setIssueError(null)
    setIssuedCount(0)
    setUserTickets([])
  }

  function handleSaveStaffId() {
    const trimmed = staffIdDraft.trim()
    if (!trimmed) return
    setStaffId(trimmed)
    setStoredValue(STAFF_ID_KEY, trimmed)
    setShowStaffIdInput(false)
  }

  const handleIssueTicket = async () => {
    if (!scannedData || !ticketTitle.trim() || !staffId.trim()) return
    setIssueLoading(true)
    setIssueError(null)
    try {
      const issued = await issueTicket({
        user_id:    scannedData.userId,
        type:       ticketType,
        title:      ticketTitle.trim(),
        amount:     ticketType === 'cut-ticket' ? 0 : Math.max(0, parseInt(ticketAmount, 10) || 0),
        memo:       ticketMemo.trim() || undefined,
        issued_by:  staffId,
        expires_at: ticketExpiresAt || undefined,
      })
      setUserTickets(prev => [issued, ...prev])
      setIssuedCount(c => c + 1)
      setTicketTitle('')
      setTicketAmount('')
      setTicketMemo('')
      setTicketExpiresAt('')
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
    } catch {
      // Non-fatal — ticket will re-sync on next load
    } finally {
      setMarkingUsed(null)
    }
  }

  // ── Derived values ─────────────────────────────────────────────────────────

  const daysRemaining = lastVisitDate ? getDaysRemaining(lastVisitDate) : null
  const expiryDateStr = lastVisitDate ? addDaysDisplay(lastVisitDate, MAINTENANCE_CUT_WINDOW_DAYS) : null
  const rankColor     = scannedData ? (RANK_COLOR[scannedData.rank] ?? '#C9A24A') : '#C9A24A'

  const previewAwarded = Math.max(0, parseInt(awardedPointsInput, 10) || 0)
  const previewTotal   = scannedData ? scannedData.points + previewAwarded : 0
  const previewRankKey = pointsToRankKey(previewTotal)

  const activeTickets = userTickets.filter(t => !t.used)
  const canIssue = ticketTitle.trim() !== '' && staffId.trim() !== '' && !issueLoading

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

        {/* StaffId area */}
        {showStaffIdInput ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={staffIdDraft}
              onChange={e => setStaffIdDraft(e.target.value)}
              placeholder="担当者名 / ID"
              autoFocus
              onKeyDown={e => { if (e.key === 'Enter') handleSaveStaffId() }}
              style={{
                flex: 1, padding: '8px 12px', borderRadius: 10,
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(201,162,74,0.3)',
                color: '#F2E6C8', fontSize: 12, fontFamily: SERIF, outline: 'none',
              }}
            />
            <button
              onClick={handleSaveStaffId}
              disabled={!staffIdDraft.trim()}
              style={{
                padding: '8px 14px', borderRadius: 10,
                background: staffIdDraft.trim() ? 'rgba(201,162,74,0.18)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${staffIdDraft.trim() ? 'rgba(201,162,74,0.4)' : 'rgba(255,255,255,0.08)'}`,
                color: staffIdDraft.trim() ? '#C9A24A' : 'rgba(255,255,255,0.2)',
                fontSize: 12, fontFamily: SERIF, fontWeight: 700,
                cursor: staffIdDraft.trim() ? 'pointer' : 'default',
              }}
            >
              設定
            </button>
            <button
              onClick={() => setShowStaffIdInput(false)}
              style={{
                padding: '8px 10px', borderRadius: 10,
                background: 'transparent', border: '1px solid rgba(255,255,255,0.08)',
                color: 'rgba(242,230,200,0.3)', fontSize: 12, cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            onClick={() => { setStaffIdDraft(staffId); setShowStaffIdInput(true) }}
            style={{
              display: 'block', margin: '0 auto',
              padding: '4px 14px', borderRadius: 99,
              background: staffId ? 'rgba(201,162,74,0.1)' : 'rgba(224,96,70,0.12)',
              border: `1px solid ${staffId ? 'rgba(201,162,74,0.28)' : 'rgba(224,96,70,0.35)'}`,
              color: staffId ? '#C9A24A' : '#E07050',
              fontSize: 10, fontFamily: SERIF, fontWeight: 700,
              letterSpacing: '0.12em', cursor: 'pointer',
            }}
          >
            {staffId ? `担当: ${staffId}` : '担当者IDを設定'}
          </button>
        )}
      </header>

      {/* ── Main ── */}
      <main style={{
        flex: 1, overflowY: 'auto', padding: '24px 20px 32px',
        maxWidth: 480, margin: '0 auto', width: '100%', boxSizing: 'border-box',
      }}>

        {/* ===== PHASE: SCAN ===== */}
        {phase === 'scan' && (
          <div>
            <div style={{
              borderRadius: 20,
              border: '1px solid rgba(201,162,74,0.18)',
              background: '#0A0504',
              overflow: 'hidden',
              marginBottom: 16,
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
              <QrCameraScanner
                onScan={handleScanned}
                onCameraError={(msg) => { setCameraError(msg); setShowManual(true) }}
              />
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
                width: '100%', padding: '11px', borderRadius: 12,
                background: 'transparent', border: '1px solid rgba(201,162,74,0.18)',
                color: 'rgba(201,162,74,0.55)', fontSize: 12,
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
                  onClick={() => { if (manualInput.trim()) { handleScanned(manualInput.trim()); setManualInput('') } }}
                  disabled={!manualInput.trim()}
                  style={{
                    width: '100%', padding: '12px', borderRadius: 12,
                    background: manualInput.trim() ? 'rgba(40,80,20,0.5)' : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${manualInput.trim() ? 'rgba(120,180,80,0.4)' : 'rgba(255,255,255,0.1)'}`,
                    color: manualInput.trim() ? '#C8F0A0' : 'rgba(255,255,255,0.25)',
                    fontFamily: SERIF, fontSize: 13, fontWeight: 700,
                    letterSpacing: '0.14em',
                    cursor: manualInput.trim() ? 'pointer' : 'default',
                  }}
                >
                  読み取る
                </button>
              </div>
            )}
          </div>
        )}

        {/* ===== PHASE: RESULT ===== */}
        {phase === 'result' && scannedData && (
          <div>
            {/* Scan success */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 20 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#78C050', boxShadow: '0 0 10px rgba(120,192,80,0.6)' }} />
              <p style={{ fontSize: 11, letterSpacing: '0.22em', color: '#78C050', fontFamily: SERIF }}>スキャン成功</p>
            </div>

            {/* Member card */}
            <div style={{
              borderRadius: 20,
              border: `1px solid ${rankColor}44`,
              background: 'linear-gradient(160deg, #120A06 0%, #0A0504 100%)',
              overflow: 'hidden', marginBottom: 16,
              boxShadow: `0 12px 40px rgba(0,0,0,0.6), 0 0 0 1px ${rankColor}10`,
            }}>
              <div style={{ height: 2, background: `linear-gradient(90deg, transparent, ${rankColor}, transparent)` }} />
              <div style={{ padding: '18px 20px 0' }}>
                <span style={{
                  display: 'inline-block', fontSize: 9, letterSpacing: '0.18em', fontWeight: 700,
                  color: rankColor, padding: '2px 8px', borderRadius: 99,
                  border: `1px solid ${rankColor}44`, background: `${rankColor}14`, marginBottom: 6,
                }}>
                  {RANK_LABEL[scannedData.rank] ?? scannedData.rank}
                </span>
                <h2 style={{
                  fontSize: 28, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF,
                  letterSpacing: '0.06em', marginBottom: 4,
                }}>
                  {scannedData.name}
                  <span style={{ fontSize: 16, marginLeft: 6, color: 'rgba(242,230,200,0.45)' }}>様</span>
                </h2>
                <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.3)', letterSpacing: '0.1em', marginBottom: 14 }}>
                  ID: {scannedData.userId}
                </p>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderTop: '1px solid rgba(201,162,74,0.1)' }}>
                {[
                  { label: '現在ポイント', value: `${scannedData.points.toLocaleString()} pt`, color: '#C9A24A',                         br: true },
                  { label: '前回来店',     value: lastVisitDate ? formatVisitDate(lastVisitDate) : '記録なし', color: lastVisitDate ? '#F2E6C8' : 'rgba(242,230,200,0.28)', br: false },
                  { label: 'メンテ期限',   value: expiryDateStr ?? '—',                          color: expiryDateStr ? '#F2E6C8' : 'rgba(242,230,200,0.28)',   br: true },
                  {
                    label: '残り日数',
                    value: daysRemaining === null ? '—' : daysRemaining <= 0 ? '期限切れ' : `あと${daysRemaining}日`,
                    color: daysRemaining === null ? 'rgba(242,230,200,0.28)' : daysRemaining <= 0 ? '#E06060' : daysRemaining <= 3 ? '#E09060' : '#78C050',
                    br: false,
                  },
                ].map((cell, i) => (
                  <div key={i} style={{
                    padding: '13px 18px',
                    borderTop: i >= 2 ? '1px solid rgba(201,162,74,0.1)' : undefined,
                    borderRight: cell.br ? '1px solid rgba(201,162,74,0.1)' : undefined,
                  }}>
                    <p style={{ fontSize: 9, letterSpacing: '0.14em', color: 'rgba(242,230,200,0.35)', marginBottom: 4 }}>
                      {cell.label}
                    </p>
                    <p style={{ fontSize: 15, fontWeight: 700, color: cell.color, fontFamily: SERIF }}>{cell.value}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* ── 付与ポイント入力欄 ── */}
            <div style={{
              borderRadius: 16,
              border: '1px solid rgba(201,162,74,0.22)',
              background: 'rgba(201,162,74,0.04)',
              padding: '16px 18px',
              marginBottom: 16,
            }}>
              <p style={{
                fontSize: 10, letterSpacing: '0.18em', color: 'rgba(201,162,74,0.7)',
                marginBottom: 10, fontFamily: SERIF, fontWeight: 700,
              }}>
                付与ポイント
              </p>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    placeholder="例：1500"
                    value={awardedPointsInput}
                    onChange={e => setAwardedPointsInput(e.target.value.replace(/[^0-9]/g, ''))}
                    style={{
                      width: '100%', padding: '12px 14px',
                      borderRadius: 12,
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(201,162,74,0.3)',
                      color: '#F2E6C8', fontSize: 20, fontWeight: 700,
                      fontFamily: SERIF, outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
                <span style={{ fontSize: 14, color: 'rgba(201,162,74,0.7)', fontFamily: SERIF, flexShrink: 0 }}>pt</span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, textAlign: 'center' }}>
                  <p style={{ fontSize: 9, color: 'rgba(242,230,200,0.35)', letterSpacing: '0.12em', marginBottom: 3 }}>現在</p>
                  <p style={{ fontSize: 16, fontWeight: 700, color: 'rgba(201,162,74,0.7)', fontFamily: SERIF }}>
                    {scannedData.points.toLocaleString()}
                    <span style={{ fontSize: 10, marginLeft: 2 }}>pt</span>
                  </p>
                </div>
                <div style={{ fontSize: 16, color: 'rgba(201,162,74,0.4)' }}>→</div>
                <div style={{ flex: 1, textAlign: 'center' }}>
                  <p style={{ fontSize: 9, color: 'rgba(242,230,200,0.35)', letterSpacing: '0.12em', marginBottom: 3 }}>付与後</p>
                  <p style={{ fontSize: 16, fontWeight: 700, color: '#C9A24A', fontFamily: SERIF }}>
                    {previewTotal.toLocaleString()}
                    <span style={{ fontSize: 10, marginLeft: 2 }}>pt</span>
                  </p>
                </div>
                <div style={{ fontSize: 16, color: 'rgba(201,162,74,0.4)' }}>→</div>
                <div style={{ flex: 1, textAlign: 'center' }}>
                  <p style={{ fontSize: 9, color: 'rgba(242,230,200,0.35)', letterSpacing: '0.12em', marginBottom: 3 }}>ランク</p>
                  <p style={{ fontSize: 13, fontWeight: 700, color: RANK_COLOR[previewRankKey] ?? '#C9A24A', fontFamily: SERIF }}>
                    {RANK_LABEL[previewRankKey]}
                  </p>
                </div>
              </div>
            </div>

            {/* ── チケット発行フォーム ── */}
            <div style={{
              borderRadius: 16,
              border: '1px solid rgba(74,127,201,0.22)',
              background: 'rgba(74,127,201,0.04)',
              padding: '16px 18px',
              marginBottom: 16,
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

              {/* Type selector */}
              <div style={{ display: 'flex', gap: 7, marginBottom: 10 }}>
                {(['coupon', 'discount', 'cut-ticket'] as TicketType[]).map(t => {
                  const tc = TICKET_TYPE_COLORS[t]
                  const active = ticketType === t
                  return (
                    <button
                      key={t}
                      onClick={() => setTicketType(t)}
                      style={{
                        flex: 1, padding: '8px 4px', borderRadius: 10,
                        background: active ? tc.bg : 'transparent',
                        border: `1px solid ${active ? tc.border : 'rgba(255,255,255,0.1)'}`,
                        color: active ? tc.text : 'rgba(242,230,200,0.35)',
                        fontSize: 11, fontFamily: SERIF, fontWeight: 700,
                        letterSpacing: '0.06em', cursor: 'pointer',
                      }}
                    >
                      {TICKET_TYPE_LABELS[t]}
                    </button>
                  )
                })}
              </div>

              {/* Title */}
              <input
                type="text"
                placeholder="タイトル（例：ご来店クーポン）"
                value={ticketTitle}
                onChange={e => setTicketTitle(e.target.value)}
                style={{
                  width: '100%', padding: '10px 12px', borderRadius: 10,
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: '#F2E6C8', fontSize: 13, fontFamily: SERIF, outline: 'none',
                  boxSizing: 'border-box', marginBottom: 8,
                }}
              />

              {/* Amount (hidden for cut-ticket) */}
              {ticketType !== 'cut-ticket' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 14, color: 'rgba(201,162,74,0.55)', fontFamily: SERIF, flexShrink: 0 }}>¥</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    placeholder="金額"
                    value={ticketAmount}
                    onChange={e => setTicketAmount(e.target.value.replace(/[^0-9]/g, ''))}
                    style={{
                      flex: 1, padding: '10px 12px', borderRadius: 10,
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      color: '#F2E6C8', fontSize: 16, fontWeight: 700,
                      fontFamily: SERIF, outline: 'none', boxSizing: 'border-box',
                    }}
                  />
                </div>
              )}

              {/* Memo */}
              <input
                type="text"
                placeholder="メモ（任意）"
                value={ticketMemo}
                onChange={e => setTicketMemo(e.target.value)}
                style={{
                  width: '100%', padding: '9px 12px', borderRadius: 10,
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: '#F2E6C8', fontSize: 12, fontFamily: SERIF, outline: 'none',
                  boxSizing: 'border-box', marginBottom: 8,
                }}
              />

              {/* Expiry */}
              <div style={{ marginBottom: 12 }}>
                <p style={{ fontSize: 9, letterSpacing: '0.12em', color: 'rgba(242,230,200,0.3)', marginBottom: 4 }}>
                  有効期限（任意）
                </p>
                <input
                  type="date"
                  value={ticketExpiresAt}
                  onChange={e => setTicketExpiresAt(e.target.value)}
                  style={{
                    padding: '8px 12px', borderRadius: 10,
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: '#F2E6C8', fontSize: 13, fontFamily: SERIF, outline: 'none',
                  }}
                />
              </div>

              {issueError && (
                <p style={{ fontSize: 12, color: '#E06060', marginBottom: 8 }}>{issueError}</p>
              )}

              <button
                onClick={handleIssueTicket}
                disabled={!canIssue}
                style={{
                  width: '100%', padding: '12px', borderRadius: 12,
                  background: canIssue
                    ? 'linear-gradient(135deg, rgba(74,127,201,0.25) 0%, rgba(74,127,201,0.45) 100%)'
                    : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${canIssue ? 'rgba(74,127,201,0.5)' : 'rgba(255,255,255,0.08)'}`,
                  color: canIssue ? '#8DC4F4' : 'rgba(242,230,200,0.22)',
                  fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.14em',
                  cursor: canIssue ? 'pointer' : 'default',
                }}
              >
                {issueLoading ? '発行中…' : !staffId.trim() ? '担当者IDを設定してください' : 'チケットを発行する'}
              </button>
            </div>

            {/* ── 保有チケット（未使用） ── */}
            {(activeTickets.length > 0 || ticketsLoading) && (
              <div style={{
                borderRadius: 16,
                border: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(255,255,255,0.02)',
                padding: '14px 16px',
                marginBottom: 16,
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
                            onClick={() => handleMarkUsed(ticket.id)}
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

            {/* Action buttons */}
            <button
              onClick={handleRegister}
              style={{
                width: '100%', padding: '16px', borderRadius: 16,
                background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
                border: '1px solid rgba(201,162,74,0.44)',
                boxShadow: '0 4px 24px rgba(107,15,18,0.5)',
                color: '#F2E6C8', fontFamily: SERIF, fontSize: 15,
                fontWeight: 700, letterSpacing: '0.22em', cursor: 'pointer', marginBottom: 12,
              }}
            >
              来店登録
            </button>
            <button
              onClick={handleReset}
              style={{
                width: '100%', padding: '12px', borderRadius: 12,
                background: 'transparent', border: '1px solid rgba(255,255,255,0.1)',
                color: 'rgba(242,230,200,0.38)', fontFamily: SERIF, fontSize: 12,
                letterSpacing: '0.14em', cursor: 'pointer',
              }}
            >
              再スキャン
            </button>
          </div>
        )}

        {/* ===== PHASE: DONE ===== */}
        {phase === 'done' && scannedData && (
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: 68, height: 68, borderRadius: '50%',
              background: 'rgba(120,192,80,0.1)',
              border: '2px solid rgba(120,192,80,0.44)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 16px',
              boxShadow: '0 0 24px rgba(120,192,80,0.18)',
            }}>
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                <path d="M8 16 L13 21 L24 11" stroke="#78C050" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>

            <h2 style={{
              fontSize: 22, fontWeight: 700, color: '#78C050', fontFamily: SERIF,
              letterSpacing: '0.08em', marginBottom: 6,
            }}>
              来店登録完了
            </h2>
            <p style={{ fontSize: 14, color: 'rgba(242,230,200,0.55)', fontFamily: SERIF, marginBottom: 22 }}>
              {scannedData.name}様の来店を記録しました
            </p>

            <div style={{
              borderRadius: 18,
              border: '1px solid rgba(120,192,80,0.2)',
              background: 'rgba(120,192,80,0.05)',
              overflow: 'hidden',
              marginBottom: issuedCount > 0 ? 12 : 24, textAlign: 'left',
            }}>
              <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, #78C050 50%, transparent)' }} />

              <div style={{ padding: '14px 20px' }}>
                {[
                  { label: '来店日',         value: registeredDate ? formatVisitDate(registeredDate) : '—', color: '#F2E6C8' },
                  { label: '付与ポイント',   value: `+${finalAwardedPts.toLocaleString()} pt`,              color: finalAwardedPts > 0 ? '#C9A24A' : 'rgba(242,230,200,0.35)' },
                  { label: '更新後ポイント', value: `${finalTotalPts.toLocaleString()} pt`,                 color: '#C9A24A' },
                  { label: '現在ランク',     value: RANK_LABEL[finalRankKey] ?? finalRankKey,               color: RANK_COLOR[finalRankKey] ?? '#C9A24A' },
                  { label: 'メンテナンスカット', value: `あと${MAINTENANCE_CUT_WINDOW_DAYS}日`,             color: '#78C050' },
                ].map((row, i) => (
                  <div key={i}>
                    {i > 0 && <div style={{ height: '0.5px', background: 'rgba(120,192,80,0.14)', margin: '11px 0' }} />}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span style={{ fontSize: 11, color: 'rgba(242,230,200,0.38)', letterSpacing: '0.1em' }}>{row.label}</span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: row.color, fontFamily: SERIF }}>{row.value}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {issuedCount > 0 && (
              <div style={{
                borderRadius: 12,
                border: '1px solid rgba(74,127,201,0.3)',
                background: 'rgba(74,127,201,0.08)',
                padding: '10px 16px',
                marginBottom: 24, textAlign: 'left',
              }}>
                <p style={{ fontSize: 11, color: '#8DC4F4', fontFamily: SERIF }}>
                  チケット {issuedCount}件 を発行しました
                </p>
              </div>
            )}

            <button
              onClick={handleReset}
              style={{
                width: '100%', padding: '16px', borderRadius: 16,
                background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
                border: '1px solid rgba(201,162,74,0.44)',
                boxShadow: '0 4px 24px rgba(107,15,18,0.5)',
                color: '#F2E6C8', fontFamily: SERIF, fontSize: 14,
                fontWeight: 700, letterSpacing: '0.2em', cursor: 'pointer',
              }}
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
    </div>
  )
}
