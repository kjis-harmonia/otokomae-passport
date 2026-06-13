import { useState, useEffect, useCallback, useRef } from 'react'
import type { MemberStatus } from '../data/brand'
import { AnimatePresence, motion } from 'framer-motion'
import { QrCode, Bell, User, FileText, ChevronRight, Share2, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { MemberQrModal } from '../components/MemberQrModal'
import { getMemberIssuedAt, getUserId } from '../utils/userId'
import { saveMemberStatus } from '../utils/storage'
import type { TicketRow } from '../data/ticket'
import { TICKET_TYPE_LABELS, TICKET_TYPE_COLORS } from '../data/ticket'
import {
  issueTicket,
  getUserTickets,
  initiateTransfer,
  cancelTransfer,
} from '../utils/ticketStore'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

interface Props {
  memberStatus: MemberStatus
  onMemberStatusChange: (next: MemberStatus) => void
}

export function MyPageScreen({ memberStatus, onMemberStatusChange }: Props) {
  const [showMemberQr, setShowMemberQr]   = useState(false)
  const [tickets, setTickets]             = useState<TicketRow[]>([])
  const [ticketsLoading, setTicketsLoading] = useState(true)
  const [selectedTicket, setSelectedTicket] = useState<TicketRow | null>(null)
  const [transferToken, setTransferToken] = useState<string | null>(null)
  const [showTransferQr, setShowTransferQr] = useState(false)
  const [transferring, setTransferring]   = useState(false)
  const [copied, setCopied]               = useState(false)
  const [stampRewardMsg, setStampRewardMsg] = useState<string | null>(null)
  const stampRewardIssuedRef              = useRef(false)

  const userId = getUserId()

  const fetchTickets = useCallback(async () => {
    setTicketsLoading(true)
    try {
      const data = await getUserTickets(userId)
      setTickets(data)
    } catch {
      setTickets([])
    } finally {
      setTicketsLoading(false)
    }
  }, [userId])

  useEffect(() => { void fetchTickets() }, [fetchTickets])

  // ── Stamp reward auto-issue ───────────────────────────────────────────────────
  useEffect(() => {
    if (memberStatus.stampCount < 10) {
      stampRewardIssuedRef.current = false
      return
    }
    if (stampRewardIssuedRef.current) return
    stampRewardIssuedRef.current = true
    void (async () => {
      try {
        await issueTicket({
          user_id:   userId,
          type:      'discount',
          title:     'スタンプ割引券',
          amount:    500,
          issued_by: 'STAMP_REWARD',
        })
        const nextStatus = { ...memberStatus, stampCount: memberStatus.stampCount - 10 }
        onMemberStatusChange(nextStatus)
        saveMemberStatus(nextStatus)
        setStampRewardMsg('割引券 ¥500 が発行されました！チケットを確認してください。')
        await fetchTickets()
      } catch {
        stampRewardIssuedRef.current = false
      }
    })()
  }, [memberStatus.stampCount]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Transfer handlers ─────────────────────────────────────────────────────────
  async function handleInitiateTransfer(ticket: TicketRow) {
    if (ticket.used || ticket.pending_transfer) return
    if (ticket.expires_at && new Date(ticket.expires_at) < new Date()) {
      alert('期限が切れているため渡せません。')
      return
    }
    setTransferring(true)
    try {
      const token = await initiateTransfer(ticket.id, userId)
      setTransferToken(token)
      setShowTransferQr(true)
      setSelectedTicket(prev => prev ? { ...prev, pending_transfer: true, transfer_token: token } : prev)
      setTickets(prev => prev.map(t =>
        t.id === ticket.id ? { ...t, pending_transfer: true, transfer_token: token } : t
      ))
    } catch {
      alert('渡す処理が失敗しました。')
    } finally {
      setTransferring(false)
    }
  }

  async function handleCancelTransfer(ticket: TicketRow) {
    try {
      await cancelTransfer(ticket.id, userId)
      setShowTransferQr(false)
      setTransferToken(null)
      setSelectedTicket(prev => prev ? { ...prev, pending_transfer: false, transfer_token: null } : prev)
      setTickets(prev => prev.map(t =>
        t.id === ticket.id ? { ...t, pending_transfer: false, transfer_token: null } : t
      ))
    } catch {
      alert('キャンセルに失敗しました。')
    }
  }

  async function handleShareTransferUrl(url: string) {
    try {
      if (navigator.share) {
        await navigator.share({ url, title: '銀二郎チケット' })
      } else {
        await navigator.clipboard.writeText(url)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    } catch { /* share cancelled */ }
  }

  // ── Derived ───────────────────────────────────────────────────────────────────
  const allActiveTickets = tickets.filter(t => !t.used)
  const usedTickets      = tickets.filter(t => t.used)

  const latestIssuedTicket = allActiveTickets
    .slice()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] ?? null

  const latestUsedTicket = usedTickets
    .slice()
    .sort((a, b) => {
      const ta = a.used_at ? new Date(a.used_at).getTime() : 0
      const tb = b.used_at ? new Date(b.used_at).getTime() : 0
      return tb - ta
    })[0] ?? null

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── MemberQrModal ── */}
      <AnimatePresence>
        {showMemberQr && (
          <MemberQrModal
            userId={userId}
            name={memberStatus.memberName}
            issuedAt={getMemberIssuedAt()}
            onClose={() => setShowMemberQr(false)}
          />
        )}
      </AnimatePresence>

      {/* ── Ticket detail bottom sheet ── */}
      <AnimatePresence>
        {selectedTicket && (() => {
          const t  = selectedTicket
          const tc = TICKET_TYPE_COLORS[t.type]
          const isPending  = !!t.pending_transfer
          const isExpired  = !!t.expires_at && new Date(t.expires_at) < new Date()
          const canTransfer = !t.used && !isExpired
          const transferUrl = transferToken
            ? `${window.location.origin}${window.location.pathname}?transfer=${transferToken}`
            : t.transfer_token
              ? `${window.location.origin}${window.location.pathname}?transfer=${t.transfer_token}`
              : null
          return (
            <motion.div
              key="ticket-detail-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              style={{
                position: 'fixed', inset: 0, zIndex: 300,
                background: 'rgba(0,0,0,0.88)',
                display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
              }}
              onClick={() => { setSelectedTicket(null); setShowTransferQr(false); setTransferToken(null) }}
            >
              <motion.div
                initial={{ y: 64 }}
                animate={{ y: 0 }}
                exit={{ y: 80 }}
                transition={{ duration: 0.26 }}
                onClick={e => e.stopPropagation()}
                style={{
                  width: '100%', maxWidth: 480,
                  borderRadius: '24px 24px 0 0',
                  background: 'linear-gradient(180deg, #160a07 0%, #0a0504 100%)',
                  border: '1px solid rgba(201,162,74,0.24)',
                  borderBottom: 'none',
                  padding: '20px 20px 36px',
                  maxHeight: '90dvh', overflowY: 'auto',
                }}
              >
                {/* Handle */}
                <div style={{ width: 40, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.12)', margin: '0 auto 20px' }} />

                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
                  <div>
                    <span style={{
                      display: 'inline-block', fontSize: 9, fontWeight: 700,
                      padding: '2px 8px', borderRadius: 99,
                      background: tc.bg, border: `1px solid ${tc.border}`, color: tc.text,
                      marginBottom: 7, letterSpacing: '0.08em',
                    }}>
                      {TICKET_TYPE_LABELS[t.type]}
                    </span>
                    <p style={{ fontSize: 20, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF, lineHeight: 1.3 }}>{t.title}</p>
                    {t.amount > 0 && (
                      <p style={{ fontSize: 20, fontWeight: 700, color: '#C9A24A', fontFamily: SERIF, marginTop: 4 }}>
                        ¥{t.amount.toLocaleString()}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => { setSelectedTicket(null); setShowTransferQr(false); setTransferToken(null) }}
                    style={{ padding: 8, borderRadius: 99, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(242,230,200,0.5)', cursor: 'pointer' }}
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* Info table */}
                <div style={{ borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', padding: '12px 14px', marginBottom: 16 }}>
                  {([
                    { label: '発行日',   value: new Date(t.created_at).toLocaleDateString('ja-JP') },
                    t.expires_at ? { label: '有効期限', value: new Date(t.expires_at).toLocaleDateString('ja-JP') } : null,
                    t.memo        ? { label: 'メモ',     value: t.memo } : null,
                    isPending     ? { label: '状態',     value: '渡し手続き中' } : null,
                  ] as const).filter(Boolean).map((row, i, arr) => (
                    <div
                      key={i}
                      style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}
                    >
                      <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.38)' }}>{row!.label}</p>
                      <p style={{ fontSize: 11, fontWeight: 600, color: isExpired && row!.label === '有効期限' ? '#E06060' : '#F2E6C8' }}>
                        {row!.value}
                      </p>
                    </div>
                  ))}
                </div>

                <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.28)', lineHeight: 1.6, marginBottom: 16 }}>
                  ※ 1回のお会計で使えるチケットは1枚です。
                </p>

                {/* Transfer QR */}
                {showTransferQr && transferUrl && (
                  <div style={{ borderRadius: 16, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,180,0,0.24)', padding: 16, marginBottom: 16 }}>
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
                      <div style={{ padding: 12, background: '#FFFFFF', borderRadius: 12 }}>
                        <QRCodeSVG value={transferUrl} size={180} level="M" />
                      </div>
                    </div>
                    <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.42)', textAlign: 'center', lineHeight: 1.7, marginBottom: 12 }}>
                      QRを読み取ってもらうか、リンクを送ってください。
                    </p>
                    <button
                      type="button"
                      onClick={() => handleShareTransferUrl(transferUrl)}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', padding: '11px 0', borderRadius: 12, background: 'rgba(255,180,0,0.1)', border: '1px solid rgba(255,180,0,0.3)', color: '#FFB400', fontFamily: SERIF, fontSize: 12, fontWeight: 700, letterSpacing: '0.12em', cursor: 'pointer', marginBottom: 8 }}
                    >
                      <Share2 size={14} />
                      {copied ? 'コピーしました' : 'リンクを送る'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCancelTransfer(t)}
                      style={{ width: '100%', padding: '11px 0', borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(242,230,200,0.46)', fontFamily: SERIF, fontSize: 12, letterSpacing: '0.14em', cursor: 'pointer' }}
                    >
                      取りやめる
                    </button>
                  </div>
                )}

                {isPending && !showTransferQr && transferUrl && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                    <button type="button" onClick={() => setShowTransferQr(true)}
                      style={{ width: '100%', padding: '13px 0', borderRadius: 14, background: 'rgba(255,180,0,0.1)', border: '1px solid rgba(255,180,0,0.3)', color: '#FFB400', fontFamily: SERIF, fontSize: 12, fontWeight: 700, letterSpacing: '0.14em', cursor: 'pointer' }}>
                      QRを再表示する
                    </button>
                    <button type="button" onClick={() => void handleCancelTransfer(t)}
                      style={{ width: '100%', padding: '13px 0', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(242,230,200,0.46)', fontFamily: SERIF, fontSize: 12, letterSpacing: '0.14em', cursor: 'pointer' }}>
                      取りやめる
                    </button>
                  </div>
                )}

                {canTransfer && !isPending && !showTransferQr && (
                  <button
                    type="button"
                    onClick={() => void handleInitiateTransfer(t)}
                    disabled={transferring}
                    style={{ width: '100%', padding: '14px 0', borderRadius: 14, background: transferring ? 'rgba(255,255,255,0.04)' : 'rgba(255,180,0,0.08)', border: `1px solid ${transferring ? 'rgba(255,255,255,0.08)' : 'rgba(255,180,0,0.38)'}`, color: transferring ? 'rgba(242,230,200,0.28)' : '#FFB400', fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.16em', cursor: transferring ? 'default' : 'pointer' }}
                  >
                    {transferring ? '処理中…' : '家族・友達に渡す'}
                  </button>
                )}

                {isExpired && (
                  <p style={{ fontSize: 11, color: '#E06060', textAlign: 'center', marginTop: 8 }}>
                    期限が切れているため渡せません
                  </p>
                )}
              </motion.div>
            </motion.div>
          )
        })()}
      </AnimatePresence>

      {/* ════════════════════════════════════════════════════════════════
          Main scrollable content
      ════════════════════════════════════════════════════════════════ */}
      <div>

        {/* ── 1. Header banner ── */}
        <div style={{ padding: '44px 24px 24px', textAlign: 'center' }}>
          <div style={{ height: '0.5px', background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.55) 20%, rgba(201,162,74,0.55) 80%, transparent)', marginBottom: 20 }} />
          <p style={{ fontSize: 9, letterSpacing: '0.38em', color: 'rgba(201,162,74,0.4)', marginBottom: 8, textTransform: 'uppercase' }}>
            Ginjiro Official
          </p>
          <h1 style={{ fontFamily: SERIF, fontSize: 38, fontWeight: 700, color: '#F2E6C8', letterSpacing: '0.1em', margin: '0 0 5px', lineHeight: 1, textShadow: '0 0 32px rgba(201,162,74,0.15)' }}>
            銀二郎
          </h1>
          <p style={{ fontSize: 8, letterSpacing: '0.3em', color: 'rgba(201,162,74,0.28)', textTransform: 'uppercase' }}>
            Otoko-Mae Passport
          </p>
          <div style={{ height: '0.5px', background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.55) 20%, rgba(201,162,74,0.55) 80%, transparent)', marginTop: 20 }} />
        </div>

        {/* ── 2. 男前証 main card ── */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.48, ease: 'easeOut' }}
          style={{
            margin: '0 16px',
            borderRadius: 22,
            overflow: 'hidden',
            position: 'relative',
            background: 'radial-gradient(circle at 84% 14%, rgba(139,26,42,0.28), transparent 42%), linear-gradient(155deg, #1C0F0B 0%, #0B0505 52%, #150A10 100%)',
            border: '1px solid rgba(201,162,74,0.44)',
            boxShadow: '0 28px 60px rgba(0,0,0,0.82), inset 0 1px 0 rgba(242,230,200,0.09), 0 0 50px rgba(139,26,42,0.1)',
          }}
        >
          {/* Top accent */}
          <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.55) 12%, #E8C547 50%, rgba(201,162,74,0.55) 88%, transparent)' }} />

          {/* Corner marks */}
          <div style={{ position: 'absolute', top: 10, left: 10, width: 14, height: 14, borderTop: '1px solid rgba(201,162,74,0.32)', borderLeft: '1px solid rgba(201,162,74,0.32)' }} />
          <div style={{ position: 'absolute', top: 10, right: 10, width: 14, height: 14, borderTop: '1px solid rgba(201,162,74,0.32)', borderRight: '1px solid rgba(201,162,74,0.32)' }} />
          <div style={{ position: 'absolute', bottom: 10, left: 10, width: 14, height: 14, borderBottom: '1px solid rgba(201,162,74,0.32)', borderLeft: '1px solid rgba(201,162,74,0.32)' }} />
          <div style={{ position: 'absolute', bottom: 10, right: 10, width: 14, height: 14, borderBottom: '1px solid rgba(201,162,74,0.32)', borderRight: '1px solid rgba(201,162,74,0.32)' }} />

          <div style={{ padding: '22px 22px 20px' }}>
            <p style={{ fontSize: 8, letterSpacing: '0.3em', color: 'rgba(201,162,74,0.38)', textTransform: 'uppercase', marginBottom: 16 }}>
              Ginjiro Official Member
            </p>

            <p style={{ fontFamily: SERIF, fontSize: 32, fontWeight: 700, color: '#F2E6C8', letterSpacing: '0.06em', lineHeight: 1, marginBottom: 4 }}>
              {memberStatus.memberName}
              <span style={{ fontFamily: SERIF, fontSize: 15, marginLeft: 7, color: 'rgba(242,230,200,0.4)' }}>様</span>
            </p>

            <div style={{ height: '0.5px', background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.28), transparent)', margin: '14px 0' }} />

            <p style={{ fontSize: 8, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.32)', marginBottom: 5, textTransform: 'uppercase' }}>
              Member ID
            </p>
            <p style={{ fontFamily: 'monospace', fontSize: 10, color: 'rgba(242,230,200,0.32)', letterSpacing: '0.06em', wordBreak: 'break-all', marginBottom: 18 }}>
              {userId}
            </p>

            <button
              type="button"
              onClick={() => setShowMemberQr(true)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: 10, padding: '15px 0', borderRadius: 14,
                background: 'linear-gradient(135deg, rgba(201,162,74,0.13) 0%, rgba(139,26,42,0.1) 100%)',
                border: '1px solid rgba(201,162,74,0.36)',
                boxShadow: 'inset 0 1px 0 rgba(242,230,200,0.05), 0 4px 16px rgba(0,0,0,0.3)',
                cursor: 'pointer',
              }}
            >
              <QrCode size={16} strokeWidth={1.6} style={{ color: 'rgba(201,162,74,0.7)' }} />
              <span style={{ fontFamily: SERIF, fontSize: 13, fontWeight: 700, color: '#C9A24A', letterSpacing: '0.22em' }}>
                男前証を表示
              </span>
            </button>
          </div>
        </motion.div>

        {/* ── 3. チケットウォレット ── */}
        <div style={{ margin: '32px 16px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <p style={{ fontSize: 10, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.52)', textTransform: 'uppercase', fontFamily: SERIF, fontWeight: 700 }}>
              保有チケット
            </p>
            {!ticketsLoading && allActiveTickets.length > 0 && (
              <span style={{ fontSize: 9, padding: '1px 8px', borderRadius: 99, background: 'rgba(201,162,74,0.1)', border: '1px solid rgba(201,162,74,0.26)', color: 'rgba(201,162,74,0.7)' }}>
                {allActiveTickets.length}枚
              </span>
            )}
          </div>

          {ticketsLoading ? (
            <div style={{ padding: 24, textAlign: 'center', borderRadius: 16, border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.01)' }}>
              <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.22)' }}>読込中…</p>
            </div>
          ) : allActiveTickets.length === 0 ? (
            <div style={{ borderRadius: 18, border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.015)', padding: '28px 20px', textAlign: 'center' }}>
              <p style={{ fontFamily: SERIF, fontSize: 14, color: 'rgba(242,230,200,0.27)', marginBottom: 8 }}>保有チケットはありません</p>
              <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.15)', lineHeight: 1.7 }}>スタッフが来店時にチケットを発行します</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {allActiveTickets.map(ticket => {
                const tc = TICKET_TYPE_COLORS[ticket.type]
                const isPending = !!ticket.pending_transfer
                const isExpired = !!ticket.expires_at && new Date(ticket.expires_at) < new Date()
                return (
                  <button
                    key={ticket.id}
                    type="button"
                    onClick={() => setSelectedTicket(ticket)}
                    style={{
                      width: '100%', textAlign: 'left', cursor: 'pointer',
                      borderRadius: 18, overflow: 'hidden', padding: 0,
                      background: 'linear-gradient(155deg, #130A06 0%, #0A0504 100%)',
                      border: `1px solid ${isPending ? 'rgba(255,180,0,0.38)' : isExpired ? 'rgba(255,255,255,0.07)' : tc.border}`,
                      boxShadow: '0 10px 28px rgba(0,0,0,0.45)',
                    }}
                  >
                    {/* Type colour accent */}
                    <div style={{ height: 2, background: `linear-gradient(90deg, ${tc.border} 0%, transparent 75%)` }} />
                    <div style={{ padding: '16px 18px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                        <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: tc.bg, border: `1px solid ${tc.border}`, color: tc.text, letterSpacing: '0.1em' }}>
                          {TICKET_TYPE_LABELS[ticket.type]}
                        </span>
                        {isPending && (
                          <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'rgba(255,180,0,0.1)', border: '1px solid rgba(255,180,0,0.4)', color: '#FFB400' }}>渡し中</span>
                        )}
                        {isExpired && (
                          <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'rgba(224,96,80,0.1)', border: '1px solid rgba(224,96,80,0.35)', color: '#E06050' }}>期限切れ</span>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
                        <div>
                          <p style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: '#F2E6C8', letterSpacing: '0.03em', marginBottom: ticket.amount > 0 ? 2 : 6 }}>
                            {ticket.title}
                          </p>
                          {ticket.amount > 0 && (
                            <p style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: '#C9A24A', letterSpacing: '0.02em', marginBottom: 6 }}>
                              ¥{ticket.amount.toLocaleString()}
                            </p>
                          )}
                          <p style={{ fontSize: 9, color: 'rgba(242,230,200,0.26)', letterSpacing: '0.06em' }}>
                            発行 {new Date(ticket.created_at).toLocaleDateString('ja-JP')}
                            {ticket.expires_at && ` ・ 期限 ${new Date(ticket.expires_at).toLocaleDateString('ja-JP')}`}
                          </p>
                        </div>
                        <ChevronRight size={16} strokeWidth={1.4} style={{ color: 'rgba(201,162,74,0.26)', flexShrink: 0, marginBottom: 4 }} />
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}

          {usedTickets.length > 0 && (
            <p style={{ fontSize: 9, color: 'rgba(242,230,200,0.18)', marginTop: 10, textAlign: 'center', letterSpacing: '0.1em' }}>
              使用済み {usedTickets.length}件
            </p>
          )}
        </div>

        {/* ── 4. 来店スタンプ ── */}
        <div style={{ margin: '32px 16px 0' }}>
          <p style={{ fontSize: 10, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.52)', textTransform: 'uppercase', fontFamily: SERIF, fontWeight: 700, marginBottom: 14 }}>
            来店スタンプ
          </p>
          <div style={{
            borderRadius: 20,
            background: 'radial-gradient(circle at 50% -12%, rgba(139,26,42,0.16), transparent 55%), linear-gradient(160deg, #130A07 0%, #0A0504 100%)',
            border: '1px solid rgba(201,162,74,0.2)',
            padding: '22px 20px 18px',
          }}>
            <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.36)', letterSpacing: '0.06em', lineHeight: 1.7, marginBottom: 20, textAlign: 'center' }}>
              10個たまると次回使える<br />
              <span style={{ color: '#C9A24A', fontWeight: 700, fontFamily: SERIF, fontSize: 13 }}>割引券 ¥500</span> を自動発行
            </p>

            {/* 2 × 5 stamp grid */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', marginBottom: 16 }}>
              {[0, 1].map(row => (
                <div key={row} style={{ display: 'flex', gap: 10 }}>
                  {[0, 1, 2, 3, 4].map(col => {
                    const idx    = row * 5 + col
                    const filled = idx < memberStatus.stampCount
                    return (
                      <div
                        key={idx}
                        style={{
                          width: 40, height: 40, borderRadius: '50%',
                          background: filled
                            ? 'radial-gradient(circle at 36% 30%, #F0D060, #9A7418)'
                            : 'rgba(255,255,255,0.03)',
                          border: filled
                            ? '1px solid rgba(232,197,71,0.36)'
                            : '1px solid rgba(201,162,74,0.1)',
                          boxShadow: filled
                            ? '0 0 16px rgba(201,162,39,0.42), inset 0 1px 0 rgba(255,255,255,0.24)'
                            : 'none',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          transition: 'all 0.3s ease',
                        }}
                      >
                        {filled && (
                          <div style={{ width: 12, height: 12, borderRadius: '50%', background: 'rgba(255,255,255,0.38)', boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.5)' }} />
                        )}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>

            {/* Counter */}
            <p style={{ textAlign: 'center', fontFamily: SERIF, marginBottom: 0 }}>
              <span style={{ fontSize: 28, fontWeight: 700, color: memberStatus.stampCount > 0 ? '#E8C547' : 'rgba(242,230,200,0.25)' }}>
                {memberStatus.stampCount}
              </span>
              <span style={{ fontSize: 14, color: 'rgba(242,230,200,0.22)', marginLeft: 2 }}> / 10</span>
            </p>

            {/* Reward message */}
            {stampRewardMsg && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                style={{ marginTop: 14, padding: '10px 16px', borderRadius: 12, background: 'rgba(120,192,80,0.1)', border: '1px solid rgba(120,192,80,0.32)', textAlign: 'center' }}
              >
                <p style={{ fontSize: 12, color: '#78C050', fontWeight: 700, letterSpacing: '0.04em' }}>✓ {stampRewardMsg}</p>
              </motion.div>
            )}

            {/* Dev helper */}
            <button
              type="button"
              onClick={() => {
                const nextStatus = { ...memberStatus, stampCount: 10 }
                onMemberStatusChange(nextStatus)
                saveMemberStatus(nextStatus)
              }}
              style={{ display: 'block', margin: '14px auto 0', fontSize: 9, color: 'rgba(242,230,200,0.16)', cursor: 'pointer', background: 'none', border: 'none', letterSpacing: '0.06em', textDecoration: 'underline', textUnderlineOffset: 3 }}
            >
              開発用：スタンプ10個
            </button>
          </div>
        </div>

        {/* ── 5. 最近のアクティビティ ── */}
        <div style={{ margin: '32px 16px 0' }}>
          <p style={{ fontSize: 10, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.52)', textTransform: 'uppercase', fontFamily: SERIF, fontWeight: 700, marginBottom: 14 }}>
            最近のアクティビティ
          </p>
          <div style={{ borderRadius: 16, overflow: 'hidden', border: '1px solid rgba(201,162,74,0.13)' }}>
            {[
              {
                label: '最終来店日',
                value: latestIssuedTicket
                  ? new Date(latestIssuedTicket.created_at).toLocaleDateString('ja-JP')
                  : null,
              },
              {
                label: '最近発行されたチケット',
                value: latestIssuedTicket
                  ? `${latestIssuedTicket.title}${latestIssuedTicket.amount > 0 ? ' ¥' + latestIssuedTicket.amount.toLocaleString() : ''}`
                  : null,
              },
              {
                label: '最近使用したチケット',
                value: latestUsedTicket
                  ? `${latestUsedTicket.title}${latestUsedTicket.amount > 0 ? ' ¥' + latestUsedTicket.amount.toLocaleString() : ''}`
                  : null,
              },
            ].map((row, i) => (
              <div
                key={i}
                style={{
                  padding: '14px 16px',
                  background: 'rgba(14,8,5,0.98)',
                  borderBottom: i < 2 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                }}
              >
                <p style={{ fontSize: 9, letterSpacing: '0.2em', color: 'rgba(201,162,74,0.34)', textTransform: 'uppercase', marginBottom: 5 }}>
                  {row.label}
                </p>
                <p style={{ fontFamily: SERIF, fontSize: 13, color: row.value ? '#F2E6C8' : 'rgba(242,230,200,0.24)' }}>
                  {row.value ?? '—'}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* ── 6. 設定 ── */}
        <div style={{ margin: '32px 16px 0' }}>
          <p style={{ fontSize: 10, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.52)', textTransform: 'uppercase', fontFamily: SERIF, fontWeight: 700, marginBottom: 14 }}>
            設定
          </p>
          <div style={{ borderRadius: 16, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.07)' }}>
            {([
              { Icon: Bell,     label: '通知設定',       sub: '新着情報をお知らせします' },
              { Icon: User,     label: 'プロフィール編集', sub: '会員情報を管理' },
              { Icon: FileText, label: '利用規約',        sub: 'サービス利用について' },
            ] as const).map(({ Icon, label, sub }, i) => (
              <div
                key={label}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '14px 16px',
                  background: 'rgba(14,8,5,0.98)',
                  borderBottom: i < 2 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                }}
              >
                <div style={{ width: 34, height: 34, borderRadius: 10, background: 'rgba(201,162,74,0.07)', border: '1px solid rgba(201,162,74,0.13)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon size={15} strokeWidth={1.7} style={{ color: 'rgba(201,162,74,0.5)' }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 13, color: '#F2E6C8', fontWeight: 500, marginBottom: 1 }}>{label}</p>
                  <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.28)' }}>{sub}</p>
                </div>
                <ChevronRight size={14} strokeWidth={1.8} style={{ color: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />
              </div>
            ))}
          </div>
        </div>

        {/* Footer note */}
        <div style={{ padding: '28px 20px 10px' }}>
          <p style={{ fontSize: 9, textAlign: 'center', color: 'rgba(201,162,74,0.18)', letterSpacing: '0.1em' }}>
            ※ 会員情報の本格連携は近日公開予定です
          </p>
        </div>

        <div style={{ height: 20 }} />
      </div>
    </>
  )
}
