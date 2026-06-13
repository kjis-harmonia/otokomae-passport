import { useState, useEffect, useCallback, useRef } from 'react'
import type { MemberStatus } from '../data/brand'
import { AnimatePresence, motion } from 'framer-motion'
import { QrCode, X, Share2, CalendarDays } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { MemberQrModal } from '../components/MemberQrModal'
import { getMemberIssuedAt, getUserId } from '../utils/userId'
import { saveMemberStatus } from '../utils/storage'
import { supabase } from '../lib/supabase'
import type { TicketRow, TicketType } from '../data/ticket'
import { TICKET_TYPE_LABELS, TICKET_TYPE_COLORS } from '../data/ticket'
import {
  issueTicket,
  getUserTickets,
  initiateTransfer,
  cancelTransfer,
} from '../utils/ticketStore'
import { isInStoreModeActive } from '../utils/inStoreMode'

// ── Constants ─────────────────────────────────────────────────────────────────

const SERIF            = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const RESERVATION_URL  = 'https://beauty.hotpepper.jp/'
const MAINT_LOCAL_KEY  = 'ginjiro_maintenance_visits'
const QR_VALID_SECS    = 300 // 5 minutes

// ── Pure helpers ──────────────────────────────────────────────────────────────

function addDays(iso: string, days: number): string {
  const d = new Date(iso)
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

function daysDiff(fromIso: string, toIso: string): number {
  return Math.ceil((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 86_400_000)
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, '/')
}

interface MaintenanceInfo {
  lastVisitDate: string
  nextDate: string
  daysRemaining: number
  color: string
  headline: string
  badge: string
}

function computeMaintenance(lastVisitDate: string | null): MaintenanceInfo | null {
  if (!lastVisitDate) return null
  const today         = new Date().toISOString().split('T')[0]
  const nextDate      = addDays(lastVisitDate, 14)
  const daysRemaining = daysDiff(today, nextDate)
  let color: string, headline: string, badge: string
  if (daysRemaining >= 10) {
    color = '#78C050'; headline = `次回推奨日まで ${daysRemaining}日`; badge = '快調'
  } else if (daysRemaining >= 4) {
    color = '#F0B840'; headline = `メンテナンス推奨まであと ${daysRemaining}日`; badge = 'そろそろ'
  } else if (daysRemaining >= 1) {
    color = '#E06060'; headline = `男前崩壊まであと ${daysRemaining}日`; badge = '緊急'
  } else if (daysRemaining === 0) {
    color = '#E03030'; headline = '今日が推奨メンテナンス日です'; badge = '今すぐ'
  } else {
    color = '#E03030'; headline = `男前崩壊 ${Math.abs(daysRemaining)}日超過`; badge = '崩壊'
  }
  return { lastVisitDate, nextDate, daysRemaining, color, headline, badge }
}

async function fetchUserLastVisitDate(userId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('maintenance_visits')
      .select('last_visit_date')
      .eq('user_id', userId)
      .single()
    if (!error && data) return (data as { last_visit_date: string }).last_visit_date
  } catch { /* ignore */ }
  try {
    const stored = JSON.parse(localStorage.getItem(MAINT_LOCAL_KEY) ?? '{}') as Record<string, string>
    return stored[userId] ?? null
  } catch { return null }
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  memberStatus: MemberStatus
  onMemberStatusChange: (next: MemberStatus) => void
}

export function MyPageScreen({ memberStatus, onMemberStatusChange }: Props) {
  const [showMemberQr, setShowMemberQr]         = useState(false)
  const [tickets, setTickets]                   = useState<TicketRow[]>([])
  const [ticketsLoading, setTicketsLoading]     = useState(true)

  // UseModal — step 'confirm' → 'qr'
  const [useModalTicket, setUseModalTicket]     = useState<TicketRow | null>(null)
  const [useModalStep, setUseModalStep]         = useState<'confirm' | 'qr'>('confirm')
  const [qrPayload, setQrPayload]               = useState<string | null>(null)
  const [qrExpiresAt, setQrExpiresAt]           = useState<Date | null>(null)
  const [qrSecondsLeft, setQrSecondsLeft]       = useState(QR_VALID_SECS)

  // GiftModal
  const [giftModalTicket, setGiftModalTicket]   = useState<TicketRow | null>(null)
  const [transferring, setTransferring]         = useState(false)
  const [transferToken, setTransferToken]       = useState<string | null>(null)
  const [copied, setCopied]                     = useState(false)

  // Maintenance
  const [lastVisitDate, setLastVisitDate]       = useState<string | null | undefined>(undefined)

  // Stamp reward
  const [stampRewardMsg, setStampRewardMsg]     = useState<string | null>(null)
  const stampRewardIssuedRef                    = useRef(false)

  const userId = getUserId()

  // ── Data fetching ───────────────────────────────────────────────────────────

  const fetchTickets = useCallback(async () => {
    setTicketsLoading(true)
    try { setTickets(await getUserTickets(userId)) }
    catch { setTickets([]) }
    finally { setTicketsLoading(false) }
  }, [userId])

  useEffect(() => { void fetchTickets() }, [fetchTickets])
  useEffect(() => {
    fetchUserLastVisitDate(userId).then(d => setLastVisitDate(d))
  }, [userId])

  // ── Stamp reward ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (memberStatus.stampCount < 10) { stampRewardIssuedRef.current = false; return }
    if (stampRewardIssuedRef.current) return
    stampRewardIssuedRef.current = true
    void (async () => {
      try {
        await issueTicket({ user_id: userId, type: 'discount', title: 'スタンプ割引券', amount: 500, issued_by: 'STAMP_REWARD' })
        const next = { ...memberStatus, stampCount: memberStatus.stampCount - 10 }
        onMemberStatusChange(next); saveMemberStatus(next)
        setStampRewardMsg('割引券 ¥500 が発行されました！')
        await fetchTickets()
      } catch { stampRewardIssuedRef.current = false }
    })()
  }, [memberStatus.stampCount]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── QR countdown ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (useModalStep !== 'qr' || !qrExpiresAt) return
    const interval = setInterval(() => {
      setQrSecondsLeft(Math.max(0, Math.ceil((qrExpiresAt.getTime() - Date.now()) / 1000)))
    }, 1000)
    return () => clearInterval(interval)
  }, [useModalStep, qrExpiresAt])

  // ── UseModal handlers ───────────────────────────────────────────────────────

  function openUseModal(ticket: TicketRow) {
    setUseModalTicket(ticket)
    setUseModalStep('confirm')
    setQrPayload(null)
    setQrExpiresAt(null)
    setQrSecondsLeft(QR_VALID_SECS)
  }

  function handleUseConfirm() {
    if (!useModalTicket) return
    const now       = new Date()
    const expiresAt = new Date(now.getTime() + QR_VALID_SECS * 1000)
    setQrPayload(JSON.stringify({
      type:             'ginjiro-ticket-use',
      userId,
      selectedTicketId: useModalTicket.id,
      issuedAt:         now.toISOString(),
      expiresAt:        expiresAt.toISOString(),
    }))
    setQrExpiresAt(expiresAt)
    setQrSecondsLeft(QR_VALID_SECS)
    setUseModalStep('qr')
  }

  function closeUseModal() {
    setUseModalTicket(null)
    setUseModalStep('confirm')
    setQrPayload(null)
    setQrExpiresAt(null)
    setQrSecondsLeft(QR_VALID_SECS)
  }

  // ── GiftModal handlers ──────────────────────────────────────────────────────

  function openGiftModal(ticket: TicketRow) {
    setTransferToken(ticket.transfer_token ?? null)
    setGiftModalTicket(ticket)
  }

  function closeGiftModal() {
    setGiftModalTicket(null)
    setTransferToken(null)
  }

  async function handleInitiateGift(ticket: TicketRow) {
    if (ticket.used || ticket.pending_transfer) return
    setTransferring(true)
    try {
      const token = await initiateTransfer(ticket.id, userId)
      setTransferToken(token)
      setGiftModalTicket(prev => prev ? { ...prev, pending_transfer: true, transfer_token: token } : prev)
      setTickets(prev => prev.map(t => t.id === ticket.id ? { ...t, pending_transfer: true, transfer_token: token } : t))
    } catch { alert('処理に失敗しました。') }
    finally { setTransferring(false) }
  }

  async function handleCancelGift(ticket: TicketRow) {
    try {
      await cancelTransfer(ticket.id, userId)
      setTransferToken(null)
      setGiftModalTicket(prev => prev ? { ...prev, pending_transfer: false, transfer_token: null } : prev)
      setTickets(prev => prev.map(t => t.id === ticket.id ? { ...t, pending_transfer: false, transfer_token: null } : t))
    } catch { alert('キャンセルに失敗しました。') }
  }

  async function handleShareUrl(url: string) {
    try {
      if (navigator.share) {
        await navigator.share({ url, title: '銀二郎チケット' })
      } else {
        await navigator.clipboard.writeText(url)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    } catch { /* cancelled */ }
  }

  // ── Derived ─────────────────────────────────────────────────────────────────

  // cut-ticket は通常ホーム画面で管理するが、店内モード中は使用フローのためここでも表示
  const allActiveTickets = tickets.filter(t => !t.used && (t.type !== 'cut-ticket' || isInStoreModeActive()))
  const usedCount        = tickets.filter(t => t.used).length

  const ticketCounts = allActiveTickets.reduce(
    (acc, t) => { acc[t.type] = (acc[t.type] ?? 0) + 1; return acc },
    {} as Partial<Record<TicketType, number>>
  )

  const maintenanceInfo      = lastVisitDate === undefined ? null : computeMaintenance(lastVisitDate)
  const isMaintenanceLoading = lastVisitDate === undefined

  const fmtCountdown = `${Math.floor(qrSecondsLeft / 60)}:${String(qrSecondsLeft % 60).padStart(2, '0')}`

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{`.gj-hscroll::-webkit-scrollbar{display:none}`}</style>

      {/* ── 男前証 QR modal ── */}
      <AnimatePresence>
        {showMemberQr && (
          <MemberQrModal userId={userId} name={memberStatus.memberName} issuedAt={getMemberIssuedAt()} onClose={() => setShowMemberQr(false)} />
        )}
      </AnimatePresence>

      {/* ════════════════════════════════════
          使用する — Step 1: 確認 / Step 2: QR
      ════════════════════════════════════ */}
      <AnimatePresence>
        {useModalTicket && (() => {
          const t  = useModalTicket
          const tc = TICKET_TYPE_COLORS[t.type]
          return (
            <motion.div
              key="use-modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.95)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px 24px 48px' }}
              onClick={closeUseModal}
            >
              <motion.div
                initial={{ scale: 0.94, y: 16 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.94 }}
                transition={{ duration: 0.22 }}
                onClick={e => e.stopPropagation()}
                style={{ width: '100%', maxWidth: 340 }}
              >
                {/* Close */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
                  <button type="button" onClick={closeUseModal}
                    style={{ padding: 9, borderRadius: 99, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(242,230,200,0.5)', cursor: 'pointer' }}>
                    <X size={18} />
                  </button>
                </div>

                {useModalStep === 'confirm' ? (
                  /* ─── Confirm step ─── */
                  <div style={{ borderRadius: 20, background: 'linear-gradient(155deg, #160B07 0%, #0A0504 100%)', border: `1px solid ${tc.border}`, overflow: 'hidden' }}>
                    <div style={{ height: 2, background: `linear-gradient(90deg, ${tc.border}, transparent)` }} />
                    <div style={{ padding: '22px 20px 20px' }}>
                      <span style={{ display: 'inline-block', fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: tc.bg, border: `1px solid ${tc.border}`, color: tc.text, letterSpacing: '0.1em', marginBottom: 12 }}>
                        {TICKET_TYPE_LABELS[t.type]}
                      </span>
                      <p style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#F2E6C8', marginBottom: t.amount > 0 ? 4 : 14 }}>{t.title}</p>
                      {t.amount > 0 && (
                        <p style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 700, color: '#C9A24A', marginBottom: 14, lineHeight: 1 }}>¥{t.amount.toLocaleString()}</p>
                      )}
                      <div style={{ height: '0.5px', background: 'rgba(255,255,255,0.08)', marginBottom: 16 }} />
                      <p style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: '#F2E6C8', textAlign: 'center', lineHeight: 1.55, marginBottom: 8 }}>
                        このチケットを会計時に<br />使用しますか？
                      </p>
                      <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.4)', textAlign: 'center', lineHeight: 1.7, marginBottom: 22 }}>
                        会計時にスタッフへQRコードを<br />提示してください。
                      </p>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button type="button" onClick={closeUseModal}
                          style={{ flex: 1, padding: '12px 0', borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(242,230,200,0.52)', fontFamily: SERIF, fontSize: 12, letterSpacing: '0.12em', cursor: 'pointer' }}>
                          キャンセル
                        </button>
                        <button type="button" onClick={handleUseConfirm}
                          style={{ flex: 2, padding: '12px 0', borderRadius: 12, background: tc.bg, border: `1px solid ${tc.border}`, color: tc.text, fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.16em', cursor: 'pointer' }}>
                          はい
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  /* ─── QR step ─── */
                  <div style={{ borderRadius: 20, overflow: 'hidden', background: 'linear-gradient(155deg, #160B07 0%, #0A0504 100%)', border: `1px solid ${tc.border}`, boxShadow: `0 24px 56px rgba(0,0,0,0.7), 0 0 24px ${tc.border}44` }}>
                    <div style={{ height: 2, background: `linear-gradient(90deg, ${tc.border}, transparent)` }} />
                    <div style={{ padding: '20px 20px 18px' }}>
                      <span style={{ display: 'inline-block', fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: tc.bg, border: `1px solid ${tc.border}`, color: tc.text, letterSpacing: '0.1em', marginBottom: 10 }}>
                        {TICKET_TYPE_LABELS[t.type]}
                      </span>
                      <p style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: '#F2E6C8', marginBottom: t.amount > 0 ? 4 : 12 }}>{t.title}</p>
                      {t.amount > 0 && (
                        <p style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 700, color: '#C9A24A', marginBottom: 10, lineHeight: 1 }}>¥{t.amount.toLocaleString()}</p>
                      )}
                      {/* QR */}
                      {qrPayload && (
                        <div style={{ background: '#FFF', borderRadius: 12, padding: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                          <QRCodeSVG value={qrPayload} size={160} level="M" />
                        </div>
                      )}
                      {/* Countdown */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 8 }}>
                        <span style={{ fontSize: 10, color: qrSecondsLeft < 60 ? '#E06060' : 'rgba(242,230,200,0.38)', letterSpacing: '0.06em' }}>有効時間</span>
                        <span style={{ fontFamily: 'monospace', fontSize: 18, fontWeight: 700, color: qrSecondsLeft < 60 ? '#E06060' : '#C9A24A' }}>
                          {fmtCountdown}
                        </span>
                      </div>
                      <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.32)', textAlign: 'center', lineHeight: 1.7 }}>
                        会計時にスタッフへ提示してください<br />
                        このQRコードは5分間有効です
                      </p>
                    </div>
                  </div>
                )}

                {useModalStep === 'qr' && (
                  <p style={{ fontSize: 9, color: 'rgba(242,230,200,0.18)', textAlign: 'center', marginTop: 14, letterSpacing: '0.06em' }}>
                    ※ スタッフが使用確定するまで使用済みにはなりません
                  </p>
                )}
              </motion.div>
            </motion.div>
          )
        })()}
      </AnimatePresence>

      {/* ════════════════════════════════════
          友人へ贈る modal
      ════════════════════════════════════ */}
      <AnimatePresence>
        {giftModalTicket && (() => {
          const t  = giftModalTicket
          const tc = TICKET_TYPE_COLORS[t.type]
          const isPending   = !!t.pending_transfer
          const transferUrl = (transferToken ?? t.transfer_token)
            ? `${window.location.origin}${window.location.pathname}?transfer=${transferToken ?? t.transfer_token}`
            : null
          return (
            <motion.div
              key="gift-modal-bg"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.88)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
              onClick={closeGiftModal}
            >
              <motion.div
                initial={{ y: 64 }}
                animate={{ y: 0 }}
                exit={{ y: 80 }}
                transition={{ duration: 0.26 }}
                onClick={e => e.stopPropagation()}
                style={{ width: '100%', maxWidth: 480, borderRadius: '24px 24px 0 0', background: 'linear-gradient(180deg, #160a07 0%, #0a0504 100%)', border: '1px solid rgba(201,162,74,0.24)', borderBottom: 'none', padding: '20px 20px 36px', maxHeight: '85dvh', overflowY: 'auto' }}
              >
                <div style={{ width: 40, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.12)', margin: '0 auto 20px' }} />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <div>
                    <p style={{ fontSize: 9, letterSpacing: '0.26em', color: 'rgba(201,162,74,0.45)', textTransform: 'uppercase', marginBottom: 3 }}>Gift</p>
                    <p style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 700, color: '#F2E6C8' }}>友人への贈り物</p>
                  </div>
                  <button type="button" onClick={closeGiftModal} style={{ padding: 8, borderRadius: 99, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(242,230,200,0.5)', cursor: 'pointer' }}>
                    <X size={16} />
                  </button>
                </div>

                <div style={{ padding: '12px 14px', borderRadius: 12, background: tc.bg, border: `1px solid ${tc.border}`, marginBottom: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <p style={{ fontSize: 9, fontWeight: 700, color: tc.text, letterSpacing: '0.1em', marginBottom: 3 }}>{TICKET_TYPE_LABELS[t.type]}</p>
                    <p style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: '#F2E6C8' }}>{t.title}</p>
                  </div>
                  {t.amount > 0 && <p style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#C9A24A' }}>¥{t.amount.toLocaleString()}</p>}
                </div>

                {!isPending && !transferUrl ? (
                  <>
                    <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.36)', lineHeight: 1.7, marginBottom: 18, textAlign: 'center' }}>
                      QRコードまたはリンクで友人に贈れます。<br />相手のチケットウォレットに追加されます。
                    </p>
                    <button type="button" onClick={() => void handleInitiateGift(t)} disabled={transferring}
                      style={{ width: '100%', padding: '15px 0', borderRadius: 14, background: transferring ? 'rgba(255,255,255,0.04)' : 'linear-gradient(135deg, rgba(201,162,74,0.17) 0%, rgba(139,26,42,0.13) 100%)', border: `1px solid ${transferring ? 'rgba(255,255,255,0.08)' : 'rgba(201,162,74,0.42)'}`, color: transferring ? 'rgba(242,230,200,0.28)' : '#C9A24A', fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.18em', cursor: transferring ? 'default' : 'pointer' }}>
                      {transferring ? '準備中…' : '贈り物を準備する'}
                    </button>
                  </>
                ) : (
                  <>
                    {transferUrl && (
                      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
                        <div style={{ background: '#FFF', borderRadius: 14, padding: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                          <QRCodeSVG value={transferUrl} size={172} level="M" />
                        </div>
                      </div>
                    )}
                    <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.38)', textAlign: 'center', lineHeight: 1.7, marginBottom: 14 }}>
                      QRを読み取るか、リンクを送ってください
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {transferUrl && (
                        <>
                          <button type="button" onClick={() => void handleShareUrl(transferUrl)}
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', padding: '13px 0', borderRadius: 14, background: 'rgba(201,162,74,0.1)', border: '1px solid rgba(201,162,74,0.32)', color: '#C9A24A', fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.12em', cursor: 'pointer' }}>
                            <Share2 size={15} />
                            {copied ? 'コピーしました' : 'リンクを送る'}
                          </button>
                          <button type="button" onClick={() => window.open(`https://line.me/R/msg/text/?${encodeURIComponent(transferUrl)}`, '_blank')}
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', padding: '13px 0', borderRadius: 14, background: 'rgba(0,185,0,0.07)', border: '1px solid rgba(0,185,0,0.28)', color: '#40C840', fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.12em', cursor: 'pointer' }}>
                            LINE で送る
                          </button>
                        </>
                      )}
                      <button type="button" onClick={() => void handleCancelGift(t)}
                        style={{ width: '100%', padding: '11px 0', borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(242,230,200,0.36)', fontFamily: SERIF, fontSize: 12, letterSpacing: '0.14em', cursor: 'pointer' }}>
                        取りやめる
                      </button>
                    </div>
                  </>
                )}
              </motion.div>
            </motion.div>
          )
        })()}
      </AnimatePresence>

      {/* ════════════════════════════════════
          Main content
      ════════════════════════════════════ */}
      <div>
        {/* ── Header ── */}
        <div style={{ padding: '40px 24px 20px', textAlign: 'center' }}>
          <div style={{ height: '0.5px', background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.55) 20%, rgba(201,162,74,0.55) 80%, transparent)', marginBottom: 18 }} />
          <p style={{ fontSize: 9, letterSpacing: '0.38em', color: 'rgba(201,162,74,0.38)', marginBottom: 7, textTransform: 'uppercase' }}>Ginjiro Official</p>
          <h1 style={{ fontFamily: SERIF, fontSize: 36, fontWeight: 700, color: '#F2E6C8', letterSpacing: '0.1em', margin: '0 0 4px', lineHeight: 1, textShadow: '0 0 30px rgba(201,162,74,0.15)' }}>銀二郎</h1>
          <p style={{ fontSize: 8, letterSpacing: '0.3em', color: 'rgba(201,162,74,0.26)', textTransform: 'uppercase' }}>Otoko-Mae Passport</p>
          <div style={{ height: '0.5px', background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.55) 20%, rgba(201,162,74,0.55) 80%, transparent)', marginTop: 18 }} />
        </div>

        {/* ══════════════════════
            Block ① 男前証
        ══════════════════════ */}
        <div style={{ padding: '0 16px 10px' }}>
          <p style={{ fontSize: 8, letterSpacing: '0.34em', color: 'rgba(201,162,74,0.36)', textTransform: 'uppercase' }}>① 男前証</p>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.46, ease: 'easeOut' }}
          style={{ margin: '0 16px', borderRadius: 22, overflow: 'hidden', position: 'relative', background: 'radial-gradient(circle at 84% 14%, rgba(139,26,42,0.28), transparent 42%), linear-gradient(155deg, #1C0F0B 0%, #0B0505 52%, #150A10 100%)', border: '1px solid rgba(201,162,74,0.44)', boxShadow: '0 28px 60px rgba(0,0,0,0.82), inset 0 1px 0 rgba(242,230,200,0.09)' }}
        >
          <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.55) 12%, #E8C547 50%, rgba(201,162,74,0.55) 88%, transparent)' }} />
          {([{ top: 10, left: 10 }, { top: 10, right: 10 }, { bottom: 10, left: 10 }, { bottom: 10, right: 10 }] as const).map((pos, i) => {
            const borders = [
              { borderTop: '1px solid rgba(201,162,74,0.32)', borderLeft: '1px solid rgba(201,162,74,0.32)' },
              { borderTop: '1px solid rgba(201,162,74,0.32)', borderRight: '1px solid rgba(201,162,74,0.32)' },
              { borderBottom: '1px solid rgba(201,162,74,0.32)', borderLeft: '1px solid rgba(201,162,74,0.32)' },
              { borderBottom: '1px solid rgba(201,162,74,0.32)', borderRight: '1px solid rgba(201,162,74,0.32)' },
            ][i]
            return <div key={i} style={{ position: 'absolute', width: 14, height: 14, ...pos, ...borders }} />
          })}
          <div style={{ padding: '22px 22px 20px' }}>
            <p style={{ fontSize: 8, letterSpacing: '0.3em', color: 'rgba(201,162,74,0.36)', textTransform: 'uppercase', marginBottom: 14 }}>Ginjiro Official Member</p>
            <p style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 700, color: '#F2E6C8', letterSpacing: '0.06em', lineHeight: 1, marginBottom: 4 }}>
              {memberStatus.memberName}
              <span style={{ fontFamily: SERIF, fontSize: 14, marginLeft: 7, color: 'rgba(242,230,200,0.4)' }}>様</span>
            </p>
            <div style={{ height: '0.5px', background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.28), transparent)', margin: '14px 0' }} />
            <p style={{ fontSize: 8, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.3)', marginBottom: 5, textTransform: 'uppercase' }}>Member ID</p>
            <p style={{ fontFamily: 'monospace', fontSize: 10, color: 'rgba(242,230,200,0.3)', letterSpacing: '0.06em', wordBreak: 'break-all', marginBottom: 18 }}>{userId}</p>
            <button type="button" onClick={() => setShowMemberQr(true)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '15px 0', borderRadius: 14, background: 'linear-gradient(135deg, rgba(201,162,74,0.13) 0%, rgba(139,26,42,0.1) 100%)', border: '1px solid rgba(201,162,74,0.36)', cursor: 'pointer' }}>
              <QrCode size={16} strokeWidth={1.6} style={{ color: 'rgba(201,162,74,0.7)' }} />
              <span style={{ fontFamily: SERIF, fontSize: 13, fontWeight: 700, color: '#C9A24A', letterSpacing: '0.22em' }}>男前証を表示</span>
            </button>
          </div>
        </motion.div>

        {/* ══════════════════════
            Block ② メンテナンス
        ══════════════════════ */}
        <div style={{ padding: '28px 16px 0' }}>
          <p style={{ fontSize: 8, letterSpacing: '0.34em', color: 'rgba(201,162,74,0.36)', textTransform: 'uppercase', marginBottom: 10 }}>② 男前メンテナンス</p>

          {isMaintenanceLoading ? (
            <div style={{ borderRadius: 18, border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.01)', padding: 24, textAlign: 'center' }}>
              <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.2)' }}>読込中…</p>
            </div>
          ) : maintenanceInfo === null ? (
            <div style={{ borderRadius: 18, background: 'linear-gradient(155deg, #130A07 0%, #0A0504 100%)', border: '1px solid rgba(255,255,255,0.09)', padding: '24px 20px', textAlign: 'center' }}>
              <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'rgba(201,162,74,0.07)', border: '1px solid rgba(201,162,74,0.14)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
                <CalendarDays size={22} strokeWidth={1.5} style={{ color: 'rgba(201,162,74,0.38)' }} />
              </div>
              <p style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: 'rgba(242,230,200,0.35)', marginBottom: 8 }}>来店履歴なし</p>
              <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.2)', lineHeight: 1.7, marginBottom: 18 }}>まずは一度ご来店ください。<br />スタッフが来店日を記録します。</p>
              <button type="button" onClick={() => window.open(RESERVATION_URL, '_blank')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '13px 22px', borderRadius: 14, background: 'linear-gradient(135deg, rgba(139,26,42,0.22), rgba(80,10,16,0.3))', border: '1px solid rgba(139,26,42,0.45)', color: '#E06070', fontFamily: SERIF, fontSize: 12, fontWeight: 700, letterSpacing: '0.14em', cursor: 'pointer' }}>
                <CalendarDays size={13} strokeWidth={2} />
                メンテナンスカットを予約する
              </button>
            </div>
          ) : (
            <div style={{ borderRadius: 18, overflow: 'hidden', background: 'linear-gradient(155deg, #130A07 0%, #0A0504 100%)', border: `1px solid ${maintenanceInfo.color}30`, boxShadow: `0 0 40px ${maintenanceInfo.color}0B` }}>
              <div style={{ height: 2, background: `linear-gradient(90deg, ${maintenanceInfo.color}88 0%, transparent 65%)` }} />
              <div style={{ padding: '18px 20px 20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: '3px 9px', borderRadius: 99, background: `${maintenanceInfo.color}20`, border: `1px solid ${maintenanceInfo.color}55`, color: maintenanceInfo.color, letterSpacing: '0.1em' }}>
                    {maintenanceInfo.badge}
                  </span>
                </div>
                <p style={{ fontFamily: SERIF, fontSize: 21, fontWeight: 700, color: maintenanceInfo.color, lineHeight: 1.3, marginBottom: 16, textShadow: `0 0 18px ${maintenanceInfo.color}38` }}>
                  {maintenanceInfo.headline}
                </p>
                <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
                  {[{ label: '前回来店日', value: fmtDate(maintenanceInfo.lastVisitDate) }, { label: '次回推奨日', value: fmtDate(maintenanceInfo.nextDate) }].map((item, i) => (
                    <div key={i} style={{ flex: 1, padding: '10px 12px', borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                      <p style={{ fontSize: 8, letterSpacing: '0.16em', color: 'rgba(242,230,200,0.28)', marginBottom: 5, textTransform: 'uppercase' }}>{item.label}</p>
                      <p style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: '#F2E6C8' }}>{item.value}</p>
                    </div>
                  ))}
                </div>
                <button type="button" onClick={() => window.open(RESERVATION_URL, '_blank')}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '13px 0', borderRadius: 14, background: 'linear-gradient(135deg, rgba(139,26,42,0.22), rgba(80,10,16,0.3))', border: '1px solid rgba(139,26,42,0.45)', color: '#E06070', fontFamily: SERIF, fontSize: 12, fontWeight: 700, letterSpacing: '0.14em', cursor: 'pointer' }}>
                  <CalendarDays size={13} strokeWidth={2} />
                  メンテナンスカットを予約する
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ══════════════════════
            Block ③ 保有チケット（Netflix横スワイプ）
            ※ cut-ticket は除外（ホーム画面で管理）
        ══════════════════════ */}
        <div style={{ paddingTop: 28 }}>
          <div style={{ padding: '0 16px', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <p style={{ fontSize: 8, letterSpacing: '0.34em', color: 'rgba(201,162,74,0.36)', textTransform: 'uppercase' }}>③ 保有チケット</p>
              {allActiveTickets.length > 0 && (
                <span style={{ fontSize: 9, padding: '1px 7px', borderRadius: 99, background: 'rgba(201,162,74,0.1)', border: '1px solid rgba(201,162,74,0.24)', color: 'rgba(201,162,74,0.68)' }}>
                  {allActiveTickets.length}枚
                </span>
              )}
            </div>
            {Object.keys(ticketCounts).length > 0 && (
              <div style={{ display: 'flex', gap: 8, marginTop: 7, flexWrap: 'wrap' }}>
                {(Object.entries(ticketCounts) as [TicketType, number][]).map(([type, count]) => {
                  const tc = TICKET_TYPE_COLORS[type]
                  return (
                    <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 99, background: tc.bg, border: `1px solid ${tc.border}` }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: tc.text, fontFamily: SERIF, letterSpacing: '0.04em' }}>
                        {TICKET_TYPE_LABELS[type]} ×{count}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {ticketsLoading ? (
            <div style={{ padding: '20px 16px', textAlign: 'center' }}>
              <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.2)' }}>読込中…</p>
            </div>
          ) : allActiveTickets.length === 0 ? (
            <div style={{ margin: '0 16px', borderRadius: 18, border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.015)', padding: '28px 20px', textAlign: 'center' }}>
              <p style={{ fontFamily: SERIF, fontSize: 14, color: 'rgba(242,230,200,0.25)', marginBottom: 8 }}>保有チケットはありません</p>
              <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.13)', lineHeight: 1.7 }}>スタッフが来店時にチケットを発行します</p>
            </div>
          ) : (
            <div className="gj-hscroll" style={{ display: 'flex', overflowX: 'auto', scrollSnapType: 'x mandatory', gap: 12, paddingLeft: 16, paddingRight: 16, paddingBottom: 4, scrollbarWidth: 'none' }}>
              {allActiveTickets.map(ticket => {
                const tc        = TICKET_TYPE_COLORS[ticket.type]
                const isPending = !!ticket.pending_transfer
                const isExpired = !!ticket.expires_at && new Date(ticket.expires_at) < new Date()
                return (
                  <div key={ticket.id} style={{ minWidth: 252, maxWidth: 272, flexShrink: 0, scrollSnapAlign: 'start', borderRadius: 18, overflow: 'hidden', background: 'linear-gradient(155deg, #160B07 0%, #0A0504 100%)', border: `1px solid ${isPending ? 'rgba(255,180,0,0.34)' : isExpired ? 'rgba(255,255,255,0.06)' : tc.border}`, boxShadow: '0 12px 32px rgba(0,0,0,0.52)' }}>
                    <div style={{ height: 2, background: `linear-gradient(90deg, ${tc.border} 0%, transparent 65%)` }} />
                    <div style={{ padding: '16px 16px 14px' }}>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
                        <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: tc.bg, border: `1px solid ${tc.border}`, color: tc.text, letterSpacing: '0.1em' }}>{TICKET_TYPE_LABELS[ticket.type]}</span>
                        {isPending && <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'rgba(255,180,0,0.1)', border: '1px solid rgba(255,180,0,0.38)', color: '#FFB400' }}>贈り中</span>}
                        {isExpired && <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'rgba(224,96,80,0.1)', border: '1px solid rgba(224,96,80,0.34)', color: '#E06050' }}>期限切れ</span>}
                        {!isPending && !isExpired && <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'rgba(120,192,80,0.1)', border: '1px solid rgba(120,192,80,0.28)', color: '#78C050' }}>未使用</span>}
                      </div>
                      <p style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 700, color: '#F2E6C8', letterSpacing: '0.03em', marginBottom: ticket.amount > 0 ? 2 : 10 }}>{ticket.title}</p>
                      {ticket.amount > 0 && (
                        <p style={{ fontFamily: SERIF, fontSize: 28, fontWeight: 700, color: '#C9A24A', letterSpacing: '0.02em', marginBottom: 8, lineHeight: 1 }}>¥{ticket.amount.toLocaleString()}</p>
                      )}
                      <p style={{ fontSize: 9, color: isExpired ? '#E06050' : 'rgba(242,230,200,0.26)', letterSpacing: '0.06em', marginBottom: 14 }}>
                        {ticket.expires_at ? `期限 ${fmtDate(ticket.expires_at)}` : `発行 ${fmtDate(ticket.created_at)}`}
                      </p>
                      <div style={{ height: '0.5px', background: 'rgba(255,255,255,0.07)', marginBottom: 12 }} />
                      <div style={{ display: 'flex', gap: 7 }}>
                        <button type="button" onClick={() => openGiftModal(ticket)} disabled={isPending || isExpired}
                          style={{ flex: 1, padding: '11px 0', borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: isPending || isExpired ? 'rgba(242,230,200,0.18)' : 'rgba(242,230,200,0.52)', fontFamily: SERIF, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', cursor: isPending || isExpired ? 'default' : 'pointer' }}>
                          友人へ贈る
                        </button>
                        <button type="button" onClick={() => openUseModal(ticket)} disabled={isExpired}
                          style={{ flex: 1, padding: '11px 0', borderRadius: 10, background: isExpired ? 'rgba(255,255,255,0.03)' : tc.bg, border: `1px solid ${isExpired ? 'rgba(255,255,255,0.06)' : tc.border}`, color: isExpired ? 'rgba(242,230,200,0.18)' : tc.text, fontFamily: SERIF, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', cursor: isExpired ? 'default' : 'pointer' }}>
                          使用する
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {usedCount > 0 && (
            <p style={{ fontSize: 9, color: 'rgba(242,230,200,0.17)', marginTop: 8, textAlign: 'center', letterSpacing: '0.1em' }}>使用済み {usedCount}件</p>
          )}
        </div>

        {/* ── 来店スタンプ ── */}
        <div style={{ margin: '28px 16px 0' }}>
          <p style={{ fontSize: 8, letterSpacing: '0.34em', color: 'rgba(201,162,74,0.36)', textTransform: 'uppercase', marginBottom: 10 }}>来店スタンプ</p>
          <div style={{ borderRadius: 20, background: 'radial-gradient(circle at 50% -12%, rgba(139,26,42,0.16), transparent 55%), linear-gradient(160deg, #130A07 0%, #0A0504 100%)', border: '1px solid rgba(201,162,74,0.2)', padding: '20px 20px 16px' }}>
            <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.34)', letterSpacing: '0.06em', lineHeight: 1.7, marginBottom: 16, textAlign: 'center' }}>
              10個たまると <span style={{ color: '#C9A24A', fontWeight: 700, fontFamily: SERIF }}>割引券 ¥500</span> を自動発行
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', marginBottom: 14 }}>
              {[0, 1].map(row => (
                <div key={row} style={{ display: 'flex', gap: 8 }}>
                  {[0, 1, 2, 3, 4].map(col => {
                    const idx    = row * 5 + col
                    const filled = idx < memberStatus.stampCount
                    return (
                      <div key={idx} style={{ width: 40, height: 40, borderRadius: '50%', background: filled ? 'radial-gradient(circle at 36% 30%, #F0D060, #9A7418)' : 'rgba(255,255,255,0.03)', border: filled ? '1px solid rgba(232,197,71,0.36)' : '1px solid rgba(201,162,74,0.1)', boxShadow: filled ? '0 0 16px rgba(201,162,39,0.42), inset 0 1px 0 rgba(255,255,255,0.24)' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.3s ease' }}>
                        {filled && <div style={{ width: 12, height: 12, borderRadius: '50%', background: 'rgba(255,255,255,0.38)' }} />}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
            <p style={{ textAlign: 'center', fontFamily: SERIF }}>
              <span style={{ fontSize: 26, fontWeight: 700, color: memberStatus.stampCount > 0 ? '#E8C547' : 'rgba(242,230,200,0.22)' }}>{memberStatus.stampCount}</span>
              <span style={{ fontSize: 13, color: 'rgba(242,230,200,0.2)', marginLeft: 2 }}> / 10</span>
            </p>
            {stampRewardMsg && (
              <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} style={{ marginTop: 12, padding: '10px 16px', borderRadius: 12, background: 'rgba(120,192,80,0.1)', border: '1px solid rgba(120,192,80,0.3)', textAlign: 'center' }}>
                <p style={{ fontSize: 12, color: '#78C050', fontWeight: 700 }}>✓ {stampRewardMsg}</p>
              </motion.div>
            )}
            <button type="button"
              onClick={() => { const next = { ...memberStatus, stampCount: 10 }; onMemberStatusChange(next); saveMemberStatus(next) }}
              style={{ display: 'block', margin: '12px auto 0', fontSize: 9, color: 'rgba(242,230,200,0.14)', cursor: 'pointer', background: 'none', border: 'none', letterSpacing: '0.06em', textDecoration: 'underline', textUnderlineOffset: 3 }}>
              開発用：スタンプ10個
            </button>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '28px 20px 10px' }}>
          <p style={{ fontSize: 9, textAlign: 'center', color: 'rgba(201,162,74,0.15)', letterSpacing: '0.1em' }}>
            ※ 会員情報の本格連携は近日公開予定です
          </p>
        </div>
        <div style={{ height: 20 }} />
      </div>
    </>
  )
}
