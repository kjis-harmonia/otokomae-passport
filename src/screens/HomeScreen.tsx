import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Html5Qrcode } from 'html5-qrcode'
import { supabase } from '../lib/supabase'
import { loadStyles } from '../utils/styleStorage'
import { StyleCardImage } from '../components/StyleCardPlaceholder'
import { StyleDetailModal } from '../components/StyleDetailModal'
import { PassportCard } from '../components/PassportCard'
import { HERO_SLIDE_IMAGES, resolveStyleImageUrl, resolveStyleImagePosition } from '../data/styleImages'
import type { StyleCard } from '../data/styleCard'
import type { Member, NavTab } from '../data/brand'
import { MAINTENANCE_CUT_URL } from '../data/reserveLinks'
import { QRCodeSVG } from 'qrcode.react'
import { getDaysRemaining, formatVisitDate, getLastVisit } from '../utils/visitHistory'
import {
  getNextRecommendedDate,
  getDaysUntilRecommended,
  MAINTENANCE_CYCLE_DAYS,
  fmtDate,
} from '../utils/maintenanceSchedule'
import { getJapanDateString } from '../utils/dateUtils'
import {
  isNotificationSupported,
  getNotificationPermission,
  requestNotificationPermission,
  triggerMaintenanceNotification,
} from '../utils/pushNotification'
import { getUserId } from '../utils/userId'
import { getUserTickets, clearActiveTicket, markLocalTicketUsed, initiateTransfer, cancelTransfer } from '../utils/ticketStore'
import { loadMemberStatus, getStoredValue, setStoredValue, ONBOARDING_NAME_KEY } from '../utils/storage'
import type { TicketRow, TicketType } from '../data/ticket'
import { TICKET_TYPE_LABELS, TICKET_TYPE_COLORS } from '../data/ticket'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

// Easing curve used for stagger animations
const EASE_OUT = [0.25, 0.46, 0.45, 0.94] as const

const MAINTENANCE_LOCAL_KEY = 'ginjiro_maintenance_visits'
const CUSTOMER_QR_EL_ID    = 'gj-customer-qr-reader'
const MAINT_SCHED_QR_EL_ID = 'gj-maint-sched-qr'

function playSuccessSound() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
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
  const date = new Date(`${normalized}T00:00:00`)
  if (Number.isNaN(date.getTime())) return null
  return normalized
}

/**
 * Days elapsed since isoDate (YYYY-MM-DD), using local calendar midnight.
 */
function daysSinceLocalMidnight(isoDate: string): number {
  const past = new Date(`${isoDate}T00:00:00`)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return Math.floor((today.getTime() - past.getTime()) / 86_400_000)
}

async function fetchLastVisitDateForUser(userId: string): Promise<string | null> {
  // Try Supabase first
  try {
    const { data, error } = await supabase
      .from('maintenance_visits')
      .select('last_visit_date')
      .eq('user_id', userId)
      .maybeSingle()
    if (!error && data?.last_visit_date) return normalizeVisitDate(String(data.last_visit_date))
  } catch { /* ignore */ }
  // Fallback: localStorage stored as Record<string, string> e.g. { "user-id": "2026-06-10" }
  // (Legacy shape was Record<string, { last_visit_date: string }> — handle both)
  try {
    const raw = localStorage.getItem(MAINTENANCE_LOCAL_KEY)
    if (!raw) return null
    const local = JSON.parse(raw) as Record<string, unknown>
    const val = local[userId]
    if (!val) return null
    if (typeof val === 'string') return normalizeVisitDate(val)
    if (typeof val === 'object') {
      const nested = (val as Record<string, unknown>).last_visit_date
      if (typeof nested === 'string') return normalizeVisitDate(nested)
    }
    return null
  } catch { return null }
}

// ── Card image helpers (HomeScreen preview row) ───────────────────────────────

function getThumbImgStyle(style: StyleCard): React.CSSProperties {
  if (style.title === 'トラック野郎御用達') {
    return { objectFit: 'contain', objectPosition: 'center center', transform: 'scale(0.94)' }
  }
  return { objectFit: 'cover', objectPosition: resolveStyleImagePosition(style) }
}

function getThumbOverlay(style: StyleCard): string {
  const base = style.title === 'トラック野郎御用達' ? 'rgba(0,0,0' : 'rgba(5,3,2'
  return (
    `linear-gradient(to top,` +
    `${base},0.98) 0%,${base},0.84) 22%,${base},0.44) 44%,${base},0.06) 64%,transparent 80%)`
  )
}


// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  member: Member
  onTabChange: (tab: NavTab) => void
  onModalChange?: (open: boolean) => void
}

// ── TicketWalletSection ───────────────────────────────────────────────────────

type WalletItem = { kind: 'ticket'; data: TicketRow }

// 券種＋金額でグループ化
interface HomeTicketGroup {
  key: string
  type: TicketType
  title: string
  amount: number
  activeItems: WalletItem[]   // 使用可能（期限内・非転送中）
  pendingItems: WalletItem[]  // 転送進行中
  expiredItems: WalletItem[]  // 期限切れ
}

function groupWalletTickets(ticketItems: WalletItem[]): HomeTicketGroup[] {
  const map = new Map<string, HomeTicketGroup>()
  for (const item of ticketItems) {
    if (item.kind !== 'ticket') continue
    const t   = item.data
    const key = `${t.type}::${t.amount}`
    if (!map.has(key)) {
      map.set(key, {
        key, type: t.type, title: t.title, amount: t.amount,
        activeItems: [], pendingItems: [], expiredItems: [],
      })
    }
    const g = map.get(key)!
    const isExpired = !!t.expires_at && new Date(t.expires_at) < new Date()
    if (isExpired)              g.expiredItems.push(item)
    else if (t.pending_transfer) g.pendingItems.push(item)
    else                        g.activeItems.push(item)
  }
  return Array.from(map.values())
}

function TicketWalletSection() {
  const userId   = getUserId()
  const memberStatus = loadMemberStatus()
  const memberName   = getStoredValue<string>(ONBOARDING_NAME_KEY, memberStatus.memberName)

  const [items,         setItems]         = useState<WalletItem[]>([])
  const [confirmItem,   setConfirmItem]   = useState<WalletItem | null>(null)
  const [transferItem,  setTransferItem]  = useState<WalletItem | null>(null)
  const [transferToken, setTransferToken] = useState<string | null>(null)
  const [showXferQr,    setShowXferQr]    = useState(false)
  const [xferring,      setXferring]      = useState(false)
  const [copied,        setCopied]        = useState(false)

  // 当日使用済み（種別を問わず1日1枚制限）
  const [todayUsed,  setTodayUsed]  = useState(false)
  const [useLoading, setUseLoading] = useState(false)
  const [useSuccess, setUseSuccess] = useState<{ title: string; amount: number } | null>(null)

  function refreshItems() {
    getUserTickets(userId)
      .then(tickets => {
        const walletTickets = tickets
          .filter(t => !t.used && (t.type === 'otoku' || t.type === 'discount'))
          .map(t => ({ kind: 'ticket' as const, data: t }))
        setItems(walletTickets)
      })
      .catch(() => setItems([]))
  }

  async function loadTodayUsed() {
    const today = getJapanDateString()
    try {
      const { data } = await supabase
        .from('ticket_usage_logs')
        .select('id')
        .eq('user_id', userId)
        .eq('usage_date', today)
        .eq('status', 'used')
        .limit(1)
      setTodayUsed((data?.length ?? 0) > 0)
    } catch {
      setTodayUsed(false)
    }
  }

  useEffect(() => {
    clearActiveTicket()  // 前セッションの残留 activeTicket をクリア
    refreshItems()
    void loadTodayUsed()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const ticketGroups = groupWalletTickets(items)

  const handleUseConfirm = async () => {
    if (!confirmItem || useLoading) return
    const t = confirmItem.data
    if (t.pending_transfer) { setConfirmItem(null); return }

    setUseLoading(true)
    const today = getJapanDateString()
    try {
      // Supabase に used=true を書き込む（anon key で RLS allow_all）
      const { error } = await supabase
        .from('tickets')
        .update({ used: true, used_at: new Date().toISOString() })
        .eq('id', t.id)
      if (error) throw error

      // 使用ログ
      await supabase.from('ticket_usage_logs').insert({
        usage_date:    today,
        staff_name:    'self',
        customer_name: memberName,
        user_id:       userId,
        ticket_id:     t.id,
        ticket_type:   t.type,
        amount:        t.amount,
        terminal:      'user-app',
        status:        'used',
        used_at:       new Date().toISOString(),
      })
    } catch {
      // Supabase 失敗時は localStorage のみ更新
      markLocalTicketUsed(t.id)
    }

    setTodayUsed(true)
    setUseSuccess({ title: t.title, amount: t.amount })
    setConfirmItem(null)
    refreshItems()
    setUseLoading(false)
    setTimeout(() => setUseSuccess(null), 3500)
  }

  async function handleTransfer(item: WalletItem) {
    const t = item.data
    if (t.used || t.pending_transfer) return
    setXferring(true)
    try {
      const token = await initiateTransfer(t.id, userId)
      setTransferToken(token)
      setTransferItem(item)
      setShowXferQr(true)
    } catch {
      alert('渡す処理が失敗しました。')
    } finally {
      setXferring(false)
    }
  }

  async function handleCancelTransfer() {
    if (!transferItem) return
    try { await cancelTransfer(transferItem.data.id, userId) } catch { /* ignore */ }
    setTransferToken(null)
    setTransferItem(null)
    setShowXferQr(false)
    refreshItems()
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
    } catch {}
  }

  if (items.length === 0) return null

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center gap-3 px-5 mb-4">
        <p className="text-[17px] font-bold leading-none flex-shrink-0" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
          保有チケット
        </p>
        <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, rgba(201,162,74,0.28), transparent)' }} />
        {items.length > 0 && (
          <span style={{ fontSize: 9, padding: '1px 7px', borderRadius: 99, background: 'rgba(201,162,74,0.10)', border: '1px solid rgba(201,162,74,0.24)', color: 'rgba(201,162,74,0.68)', flexShrink: 0 }}>
            {ticketGroups.length}種 · {items.length}枚
          </span>
        )}
        <p style={{ fontSize: 8, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.44)', flexShrink: 0 }}>WALLET</p>
      </div>

      {/* Horizontal scroll */}
      <div
        style={{
          display: 'flex', gap: 12,
          overflowX: 'scroll', scrollbarWidth: 'none',
          paddingLeft: 20, paddingRight: 20,
          WebkitOverflowScrolling: 'touch',
        } as React.CSSProperties}
        className="[&::-webkit-scrollbar]:hidden"
      >
        {/* ── 券種＋金額グループ（数量管理方式） ── */}
        {ticketGroups.map((group, i) => {
          const tc           = TICKET_TYPE_COLORS[group.type]
          const usableCount  = group.activeItems.length
          const pendingCount = group.pendingItems.length
          const expiredCount = group.expiredItems.length
          const displayCount = usableCount + pendingCount
          const canUse       = usableCount > 0
          const canGift      = usableCount > 0
          const repItem      = group.activeItems[0] ?? group.pendingItems[0] ?? group.expiredItems[0]
          const repTicket    = repItem?.kind === 'ticket' ? repItem.data : undefined

          return (
            <motion.div
              key={group.key}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.07, duration: 0.38 }}
              style={{
                flexShrink: 0,
                width: 'clamp(256px, 76vw, 284px)',
                borderRadius: 20,
                background: tc.cardBg,
                border: `1px solid ${canUse ? tc.border : 'rgba(255,255,255,0.07)'}`,
                boxShadow: [
                  '0 16px 48px rgba(0,0,0,0.65)',
                  'inset 0 1px 0 rgba(255,255,255,0.03)',
                  canUse ? `0 0 24px ${tc.border}20` : '',
                ].filter(Boolean).join(', '),
                overflow: 'hidden',
                opacity: canUse ? 1 : 0.65,
              }}
            >
              {/* 天面アクセントライン */}
              <div style={{ height: 2, background: `linear-gradient(90deg, ${tc.border} 0%, transparent 70%)` }} />

              <div style={{ padding: '13px 18px 10px' }}>
                {/* 券種ラベル + 枚数バッジ */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{
                    fontSize: 9, fontWeight: 700, letterSpacing: '0.10em',
                    padding: '2px 8px', borderRadius: 99,
                    background: tc.bg, border: `1px solid ${tc.border}`, color: tc.text,
                  }}>
                    {TICKET_TYPE_LABELS[group.type]}
                  </span>
                  {displayCount > 0 && (
                    <span style={{
                      fontSize: 12, fontWeight: 700,
                      color: tc.text, fontFamily: 'monospace', letterSpacing: '0.04em',
                    }}>
                      ×{displayCount}枚
                    </span>
                  )}
                </div>

                {/* タイトル */}
                <p style={{
                  fontFamily: SERIF, fontSize: 20, fontWeight: 700,
                  color: '#F2E6C8', letterSpacing: '0.04em', lineHeight: 1.15,
                  marginBottom: group.amount > 0 ? 3 : 8,
                }}>
                  {group.title}
                </p>

                {/* 金額 */}
                {group.amount > 0 && (
                  <p style={{
                    fontFamily: SERIF, fontSize: 26, fontWeight: 700,
                    color: '#C9A24A', letterSpacing: '0.01em', lineHeight: 1, marginBottom: 6,
                  }}>
                    ¥{group.amount.toLocaleString()}
                  </p>
                )}

                {/* 内訳バッジ（渡し中 / 期限切れ） */}
                {(pendingCount > 0 || expiredCount > 0) && (
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 5 }}>
                    {pendingCount > 0 && (
                      <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 99, background: 'rgba(255,180,0,0.10)', border: '1px solid rgba(255,180,0,0.34)', color: '#FFB400' }}>
                        渡し中 {pendingCount}枚
                      </span>
                    )}
                    {expiredCount > 0 && (
                      <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 99, background: 'rgba(224,96,80,0.10)', border: '1px solid rgba(224,96,80,0.30)', color: '#E06050' }}>
                        期限切れ {expiredCount}枚
                      </span>
                    )}
                  </div>
                )}

                {/* 有効期限 */}
                <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.34)', marginBottom: 10, letterSpacing: '0.06em' }}>
                  {repTicket?.expires_at
                    ? `有効期限 ${repTicket.expires_at.slice(0, 10).replace(/-/g, '/')}`
                    : '有効期限なし'}
                </p>

                <div style={{ height: '0.5px', background: `linear-gradient(90deg, ${tc.border}22, transparent)`, marginBottom: 10 }} />

                {/* Primary: 使用する */}
                <button
                  type="button"
                  onClick={() => { if (canUse && !todayUsed && group.activeItems[0]) setConfirmItem(group.activeItems[0]) }}
                  disabled={!canUse || todayUsed}
                  style={{
                    width: '100%', padding: '11px 0', borderRadius: 10,
                    background: (canUse && !todayUsed) ? tc.btnBg : 'rgba(255,255,255,0.02)',
                    border: `1.5px solid ${(canUse && !todayUsed) ? tc.border : 'rgba(255,255,255,0.07)'}`,
                    boxShadow: (canUse && !todayUsed) ? `0 4px 18px ${tc.border}38` : 'none',
                    fontSize: 12, fontWeight: 700, letterSpacing: '0.14em',
                    color: (canUse && !todayUsed) ? '#e6ca65' : 'rgba(242,230,200,0.2)',
                    fontFamily: SERIF, cursor: (canUse && !todayUsed) ? 'pointer' : 'default',
                  }}
                >
                  {todayUsed ? '本日使用済み' : '使用する'}
                </button>

                {/* Secondary: 譲る */}
                <button
                  type="button"
                  onClick={() => { if (canGift && group.activeItems[0]) void handleTransfer(group.activeItems[0]) }}
                  disabled={!canGift || xferring}
                  style={{
                    display: 'block', width: '100%',
                    padding: '5px 0 0',
                    background: 'none', border: 'none',
                    fontSize: 11,
                    color: canGift ? 'rgba(107,114,128,0.88)' : 'rgba(107,114,128,0.28)',
                    letterSpacing: '0.08em',
                    cursor: canGift ? 'pointer' : 'default',
                    textDecoration: 'none',
                    textAlign: 'center',
                  }}
                >
                  譲る
                </button>
              </div>
            </motion.div>
          )
        })}

        <div style={{ width: 8, flexShrink: 0 }} />
      </div>

      {/* ── 使用完了バナー ── */}
      <AnimatePresence>
        {useSuccess && (
          <motion.div
            initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
            style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 400, background: 'linear-gradient(135deg, rgba(10,40,18,0.97) 0%, rgba(6,26,12,0.99) 100%)', borderBottom: '1px solid rgba(100,200,100,0.32)', padding: '16px 20px', textAlign: 'center', boxShadow: '0 4px 32px rgba(0,0,0,0.7)' }}
          >
            <p style={{ fontSize: 9, letterSpacing: '0.34em', color: 'rgba(100,200,100,0.55)', marginBottom: 4 }}>USED</p>
            <p style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 700, color: '#80E060', marginBottom: 2 }}>使用完了</p>
            <p style={{ fontFamily: SERIF, fontSize: 13, color: 'rgba(242,230,200,0.7)', lineHeight: 1.6 }}>
              {useSuccess.title}{useSuccess.amount > 0 ? ` ¥${useSuccess.amount.toLocaleString()}` : ''} を1枚使用しました。
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── 確認モーダル ── */}
      <AnimatePresence>
        {confirmItem && (
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}
            onClick={() => setConfirmItem(null)}
          >
            <motion.div
              initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }}
              transition={{ duration: 0.24 }}
              onClick={e => e.stopPropagation()}
              style={{ width: '100%', maxWidth: 420, borderRadius: 24, background: 'linear-gradient(160deg, #160A07 0%, #0A0504 100%)', border: '1px solid rgba(201,162,74,0.28)', boxShadow: '0 24px 64px rgba(0,0,0,0.85)', padding: '28px 24px 24px' }}
            >
              <p style={{ fontSize: 9, letterSpacing: '0.28em', color: 'rgba(201,162,74,0.5)', marginBottom: 10, textAlign: 'center' }}>USE TICKET</p>
              <p style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 700, color: '#F2E6C8', textAlign: 'center', lineHeight: 1.45, marginBottom: 4 }}>
                {confirmItem.data.title}
              </p>
              {(confirmItem.data.amount ?? 0) > 0 && (
                <p style={{ fontFamily: SERIF, fontSize: 24, fontWeight: 700, color: '#C9A24A', textAlign: 'center', marginBottom: 10 }}>
                  ¥{(confirmItem.data.amount ?? 0).toLocaleString()}
                </p>
              )}
              <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.46)', textAlign: 'center', lineHeight: 1.75, marginBottom: 24 }}>
                この操作は取り消せません。<br />使用すると本日中に他のチケットは使えなくなります。
              </p>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="button" onClick={() => setConfirmItem(null)} disabled={useLoading}
                  style={{ flex: 1, padding: '13px 0', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', fontSize: 13, color: 'rgba(242,230,200,0.52)', fontFamily: SERIF, letterSpacing: '0.14em', cursor: 'pointer' }}>
                  キャンセル
                </button>
                <button type="button" onClick={() => { void handleUseConfirm() }} disabled={useLoading}
                  style={{ flex: 2, padding: '13px 0', borderRadius: 14, background: useLoading ? 'rgba(40,10,10,0.6)' : 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)', border: `1px solid ${useLoading ? 'rgba(201,162,74,0.18)' : 'rgba(201,162,74,0.44)'}`, boxShadow: useLoading ? 'none' : '0 4px 20px rgba(107,15,18,0.45)', fontSize: 13, fontWeight: 700, color: useLoading ? 'rgba(242,230,200,0.35)' : '#F2E6C8', fontFamily: SERIF, letterSpacing: '0.16em', cursor: useLoading ? 'default' : 'pointer' }}>
                  {useLoading ? '処理中…' : 'はい、使用する'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── 譲渡 QR モーダル ── */}
      <AnimatePresence>
        {showXferQr && transferUrl && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.90)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <motion.div
              initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }}
              transition={{ duration: 0.24 }}
              style={{ width: '100%', maxWidth: 360, borderRadius: 24, background: 'linear-gradient(160deg, #160A07 0%, #0A0504 100%)', border: '1px solid rgba(201,162,74,0.28)', padding: '24px 20px', textAlign: 'center' }}
            >
              <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: '#F2E6C8', marginBottom: 4 }}>
                {transferItem?.data.title ?? ''}
              </p>
              <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.40)', marginBottom: 18, letterSpacing: '0.06em' }}>
                受け取りたい人にQRを見せてください
              </p>
              <div style={{ display: 'inline-block', padding: 14, background: '#FFFFFF', borderRadius: 14, marginBottom: 18 }}>
                <QRCodeSVG value={transferUrl} size={180} level="M" />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                <button type="button" onClick={handleShareTransfer}
                  style={{ width: '100%', padding: '12px 0', borderRadius: 12, background: 'rgba(255,180,0,0.09)', border: '1px solid rgba(255,180,0,0.3)', fontSize: 12, fontWeight: 700, color: '#FFB400', fontFamily: SERIF, letterSpacing: '0.14em', cursor: 'pointer' }}>
                  {copied ? 'コピーしました' : 'リンクを送る'}
                </button>
                <button type="button" onClick={handleCancelTransfer}
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

// ── MaintenanceCutSection ─────────────────────────────────────────────────────

const MAINT_ACTIVE_KEY  = 'ginjiro_maintenance_active'
const MAINT_USED_AT_KEY = 'ginjiro_maintenance_used_at'

function isMaintenanceActive(): boolean {
  try {
    const raw = localStorage.getItem(MAINT_ACTIVE_KEY)
    if (!raw) return false
    const { activatedAt } = JSON.parse(raw) as { activatedAt: string }
    return Date.now() - new Date(activatedAt).getTime() < 2 * 60 * 60 * 1000
  } catch { return false }
}

function activateMaintenance(): void {
  localStorage.setItem(MAINT_ACTIVE_KEY, JSON.stringify({ activatedAt: new Date().toISOString() }))
}

function clearMaintenance(): void {
  localStorage.removeItem(MAINT_ACTIVE_KEY)
  localStorage.setItem(MAINT_USED_AT_KEY, new Date().toISOString())
}

function MaintenanceCutSection() {
  const userId = getUserId()

  // Maintenance right state — set by in-store QR scan, expires in 2 hours
  const [maintenanceActive, setMaintenanceActive] = useState(isMaintenanceActive)
  const [showMaintenanceQr, setShowMaintenanceQr] = useState(false)

  const [showScanner, setShowScanner] = useState(false)
  const [scannerActive, setScannerActive] = useState(false)
  const [scanMsg, setScanMsg] = useState<string | null>(null)
  const [scanProcessing, setScanProcessing] = useState(false)
  const scannerRef = useRef<Html5Qrcode | null>(null)

  // 来店日・残り日数（参考表示用）
  const lastVisit = getLastVisit()
  const daysRemaining = lastVisit ? getDaysRemaining(lastVisit.visitedAt) : null
  const isEligible = daysRemaining !== null && daysRemaining >= 0

  // Maintenance coupon QR payload
  const memberStatus  = loadMemberStatus()
  const memberName    = getStoredValue<string>(ONBOARDING_NAME_KEY, memberStatus.memberName)
  const maintenanceQrValue = JSON.stringify({ type: 'ginjiro-maintenance-coupon', userId, name: memberName })

  // ── QR scanner helpers ──────────────────────────────────────────────────────

  const stopScanner = useCallback(async () => {
    const s = scannerRef.current
    if (!s) return
    try { if (s.isScanning) await s.stop(); s.clear() } catch { /* ignore */ }
    scannerRef.current = null
    setScannerActive(false)
  }, [])

  const startScanner = useCallback(async () => {
    if (scannerRef.current) return
    const scanner = new Html5Qrcode(CUSTOMER_QR_EL_ID)
    scannerRef.current = scanner
    try {
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (decoded) => { void handleStoreQrScan(decoded); void stopScanner() },
        undefined,
      )
      setScannerActive(true)
    } catch {
      scannerRef.current = null
      setScanMsg('カメラを起動できませんでした。設定を確認してください。')
      setShowScanner(false)
    }
  }, [stopScanner]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (showScanner) { void startScanner() }
    else { void stopScanner() }
  }, [showScanner, startScanner, stopScanner])

  async function handleStoreQrScan(text: string) {
    setScanProcessing(true)
    try {
      const data = JSON.parse(text) as { type?: string }
      if (data.type !== 'ginjiro-store-checkin') {
        playWarningSound()
        setScanMsg('店舗のQRコードを読み取ってください。')
        setShowScanner(false)
        return
      }
    } catch {
      playWarningSound()
      setScanMsg('QRコードを認識できませんでした。')
      setShowScanner(false)
      return
    }

    const rawLastVisitDate = await fetchLastVisitDateForUser(userId)
    const normalizedLastVisitDate = rawLastVisitDate ? normalizeVisitDate(rawLastVisitDate) : null
    const parsedDate = normalizedLastVisitDate ? new Date(`${normalizedLastVisitDate}T00:00:00`) : null
    const daysElapsed = normalizedLastVisitDate ? daysSinceLocalMidnight(normalizedLastVisitDate) : null
    const isWithin14Days = daysElapsed !== null && daysElapsed <= 14
    const maintenanceState = normalizedLastVisitDate === null
      ? 'no-record'
      : isWithin14Days
      ? 'eligible'
      : 'expired'

    console.debug('[MaintenanceCut] rawLastVisitDate:', rawLastVisitDate)
    console.debug('[MaintenanceCut] normalizedLastVisitDate:', normalizedLastVisitDate)
    console.debug('[MaintenanceCut] parsedDate:', parsedDate)
    console.debug('[MaintenanceCut] daysElapsed:', daysElapsed)
    console.debug('[MaintenanceCut] isWithin14Days:', isWithin14Days)
    console.debug('[MaintenanceCut] maintenanceState:', maintenanceState)

    setShowScanner(false)

    if (maintenanceState === 'no-record') {
      playWarningSound()
      setScanMsg('来店記録がありません。通常価格でのご予約をお願いします。')
      setScanProcessing(false)
      return
    }

    if (maintenanceState === 'eligible') {
      playSuccessSound()
      activateMaintenance()
      setMaintenanceActive(true)
      setScanMsg(null)
    } else {
      playWarningSound()
      setScanMsg(`前回来店から${daysElapsed}日が経過しています。メンテナンスカットはご利用いただけません。`)
    }
    setScanProcessing(false)
  }

  function handleMaintenanceQrClose() {
    clearMaintenance()
    setMaintenanceActive(false)
    setShowMaintenanceQr(false)
  }

  return (
    <div className="px-4">
      {/* Section header */}
      <div className="mb-4 flex items-center gap-3 px-1">
        <p className="text-[17px] font-bold leading-none flex-shrink-0" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
          期間限定クーポン
        </p>
        <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, rgba(201,162,74,0.3), transparent)' }} />
      </div>

      {/* Card */}
      <div
        style={{
          borderRadius: 24,
          border: '1px solid rgba(201,162,74,0.28)',
          background: 'linear-gradient(160deg, #120608 0%, #0A0404 60%, #080506 100%)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.65), 0 0 0 0.5px rgba(201,162,74,0.06), inset 0 1px 0 rgba(242,230,200,0.03)',
          overflow: 'hidden',
        }}
      >
        <div style={{ height: 2, background: 'linear-gradient(90deg, transparent 0%, #8B1A1A 30%, #C9A24A 50%, #8B1A1A 70%, transparent 100%)' }} />

        <div className="px-5 pt-4 pb-5">
          {/* Badge row */}
          <div className="flex items-center justify-between gap-2 mb-3">
            <span
              style={{
                display: 'inline-flex', alignItems: 'center',
                padding: '3px 10px', borderRadius: 99,
                background: maintenanceActive
                  ? 'linear-gradient(135deg, #0a3d1a 0%, #145a2a 100%)'
                  : 'linear-gradient(135deg, #3d0608 0%, #6B0F12 100%)',
                border: `1px solid ${maintenanceActive ? 'rgba(100,200,100,0.36)' : 'rgba(201,162,74,0.36)'}`,
                fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
                color: maintenanceActive ? '#90E8A0' : '#F2E6C8', fontFamily: SERIF,
              }}
            >
              {maintenanceActive ? 'クーポン有効' : '14DAY CYCLE'}
            </span>
            {/* 店内QR読み取りボタン（クーポン未有効時のみ） */}
            {!maintenanceActive && (
              <button
                type="button"
                onClick={() => { setScanMsg(null); setShowScanner(true) }}
                style={{
                  padding: '4px 10px', borderRadius: 99,
                  background: 'rgba(201,162,74,0.08)', border: '1px solid rgba(201,162,74,0.28)',
                  fontSize: 10, color: 'rgba(201,162,74,0.72)', fontFamily: SERIF, letterSpacing: '0.1em', cursor: 'pointer',
                }}
              >
                店内QRを読む
              </button>
            )}
          </div>

          {/* Title */}
          <h3 style={{ fontSize: 26, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF, letterSpacing: '0.06em', lineHeight: 1.2, marginBottom: 8 }}>
            メンテナンスカット
          </h3>
          <div style={{ height: '0.5px', background: 'linear-gradient(90deg, rgba(201,162,74,0.22), transparent)', marginBottom: 12 }} />

          <p style={{ fontSize: 12, lineHeight: 1.75, color: 'rgba(242,230,200,0.58)', marginBottom: 16 }}>
            前回来店から14日以内のお客様限定。{'\n'}
            フェード・刈り上げ・ラインを整えて男前をキープ。
          </p>

          {/* 来店日・残り日数（来店記録あり） */}
          {lastVisit && (
            <div style={{ borderRadius: 12, background: 'rgba(201,162,74,0.06)', border: `1px solid ${isEligible ? 'rgba(201,162,74,0.22)' : 'rgba(139,26,26,0.32)'}`, padding: '10px 14px', marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div>
                <p style={{ fontSize: 9, letterSpacing: '0.16em', color: 'rgba(242,230,200,0.36)', marginBottom: 2 }}>前回来店</p>
                <p style={{ fontSize: 13, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF }}>{formatVisitDate(lastVisit.visitedAt)}</p>
              </div>
              <div style={{ width: '0.5px', height: 32, background: 'rgba(201,162,74,0.18)' }} />
              <div style={{ textAlign: 'right' }}>
                <p style={{ fontSize: 9, letterSpacing: '0.16em', color: 'rgba(242,230,200,0.36)', marginBottom: 2 }}>利用期限まで</p>
                <p style={{ fontSize: 13, fontWeight: 700, fontFamily: SERIF, color: isEligible ? (daysRemaining !== null && daysRemaining <= 3 ? '#E06060' : '#C9A24A') : 'rgba(242,230,200,0.32)' }}>
                  {isEligible && daysRemaining !== null ? `あと${daysRemaining}日` : '期限切れ'}
                </p>
              </div>
            </div>
          )}

          {/* スキャン結果メッセージ */}
          {scanMsg && (
            <div style={{ borderRadius: 12, background: 'rgba(224,100,60,0.1)', border: '1px solid rgba(224,100,60,0.28)', padding: '10px 14px', marginBottom: 14 }}>
              <p style={{ fontSize: 12, color: '#E06040', lineHeight: 1.6 }}>{scanMsg}</p>
            </div>
          )}

          {/* 価格 */}
          <div style={{ marginBottom: 14 }}>
            <p style={{ fontSize: 9, letterSpacing: '0.16em', color: 'rgba(201,162,74,0.54)', marginBottom: 1 }}>優待価格</p>
            <p style={{ fontSize: 22, fontWeight: 700, color: '#C9A24A', fontFamily: SERIF, letterSpacing: '0.02em', lineHeight: 1 }}>¥3,000</p>
          </div>

          {/* ボタン：State B（クーポン有効） or State A/C（予約） */}
          {maintenanceActive ? (
            <button
              type="button"
              onClick={() => setShowMaintenanceQr(true)}
              style={{
                display: 'block', width: '100%', textAlign: 'center',
                padding: '14px 0', borderRadius: 14,
                background: 'linear-gradient(135deg, #0a3d1a 0%, #145a2a 60%, #1a7a38 100%)',
                border: '1px solid rgba(100,200,100,0.44)',
                boxShadow: '0 4px 20px rgba(20,90,42,0.45)',
                cursor: 'pointer',
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.18em', color: '#D0F4D8', fontFamily: SERIF }}>
                メンテナンスクーポンを使用する
              </span>
            </button>
          ) : (
            <a
              href={MAINTENANCE_CUT_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'block', textAlign: 'center',
                padding: '14px 0', borderRadius: 14,
                background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
                border: '1px solid rgba(201,162,74,0.44)',
                boxShadow: '0 4px 20px rgba(107,15,18,0.45)',
                textDecoration: 'none',
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.14em', color: '#F2E6C8', fontFamily: SERIF }}>
                メンテナンスカットを予約する
              </span>
            </a>
          )}
        </div>
      </div>

      {/* ── メンテナンスクーポン QRモーダル ── */}
      <AnimatePresence>
        {showMaintenanceQr && (
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
            onClick={handleMaintenanceQrClose}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }}
              transition={{ duration: 0.24 }}
              onClick={e => e.stopPropagation()}
              style={{ width: '100%', maxWidth: 360, borderRadius: 24, background: 'linear-gradient(160deg, #060e09 0%, #040a06 100%)', border: '1px solid rgba(100,200,100,0.28)', boxShadow: '0 24px 64px rgba(0,0,0,0.92)', padding: '28px 24px', textAlign: 'center' }}
            >
              <p style={{ fontSize: 9, letterSpacing: '0.28em', color: 'rgba(144,232,160,0.5)', marginBottom: 8 }}>MAINTENANCE COUPON</p>
              <p style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 700, color: '#F2E6C8', marginBottom: 18, lineHeight: 1.4 }}>メンテナンスクーポン</p>
              <div style={{ display: 'inline-block', padding: 16, background: '#FFFFFF', borderRadius: 16, boxShadow: '0 8px 32px rgba(0,0,0,0.55)', marginBottom: 20 }}>
                <QRCodeSVG value={maintenanceQrValue} size={200} level="M" />
              </div>
              <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.38)', lineHeight: 1.75, marginBottom: 20 }}>
                スタッフにQRを提示してください。{'\n'}確認後「使用済みにする」を押してください。
              </p>
              <button type="button" onClick={handleMaintenanceQrClose}
                style={{ width: '100%', padding: '13px 0', borderRadius: 14, background: 'rgba(100,200,100,0.08)', border: '1px solid rgba(100,200,100,0.30)', fontSize: 13, fontWeight: 700, color: '#D0F4D8', fontFamily: SERIF, letterSpacing: '0.16em', cursor: 'pointer' }}>
                使用済みにする
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── QRスキャナーモーダル ── */}
      {showScanner && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.92)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={() => setShowScanner(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.94 }}
            transition={{ duration: 0.22 }}
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 360, borderRadius: 24, background: 'linear-gradient(160deg, #100806 0%, #080504 100%)', border: '1px solid rgba(201,162,74,0.28)', boxShadow: '0 24px 64px rgba(0,0,0,0.9)', padding: '24px 20px', textAlign: 'center' }}
          >
            <p style={{ fontSize: 9, letterSpacing: '0.28em', color: 'rgba(201,162,74,0.5)', marginBottom: 8 }}>STORE CHECK-IN</p>
            <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: '#F2E6C8', marginBottom: 18, lineHeight: 1.4 }}>
              店内のQRコードを<br />カメラで読み取ってください
            </p>
            <div id={CUSTOMER_QR_EL_ID} style={{ width: '100%', minHeight: scannerActive ? 260 : 0, borderRadius: 16, overflow: 'hidden', marginBottom: scannerActive ? 14 : 0 }} />
            {scanProcessing && (
              <p style={{ fontSize: 12, color: 'rgba(201,162,74,0.6)', marginBottom: 12 }}>確認中…</p>
            )}
            <button
              type="button"
              onClick={() => setShowScanner(false)}
              style={{ width: '100%', padding: '13px 0', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', fontSize: 13, color: 'rgba(242,230,200,0.58)', fontFamily: SERIF, letterSpacing: '0.14em', cursor: 'pointer', marginTop: 8 }}
            >
              キャンセル
            </button>
          </motion.div>
        </div>
      )}
    </div>
  )
}

// ── StylesRow (home carousel preview — max 6 priority styles) ────────────────

const HOME_PRIORITY_TITLES = [
  '海軍御用達',
  '俺は濡れパン',
  'バチバチパンチパーマ',
  '昭和のアイパー',
  'カールアイパー',
  '銀パラ',
] as const

function StylesRow({
  styles,
  onStyleSelect,
  onSeeAll,
}: {
  styles: StyleCard[]
  onStyleSelect: (s: StyleCard) => void
  onSeeAll: () => void
}) {
  const byTitle = new Map(styles.map(s => [s.title, s]))
  const featured = HOME_PRIORITY_TITLES
    .map(t => byTitle.get(t))
    .filter((s): s is StyleCard => s !== undefined)
  const displayStyles = featured.length > 0 ? featured : styles.slice(0, 6)

  if (displayStyles.length === 0) return null

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center gap-3 px-5 mb-4">
        <p
          className="text-[17px] font-bold leading-none flex-shrink-0"
          style={{ color: '#F2E6C8', fontFamily: SERIF }}
        >
          銀二郎スタイル
        </p>
        <div
          style={{
            height: 1, flex: 1,
            background: 'linear-gradient(90deg, rgba(201,162,74,0.28), transparent)',
          }}
        />
        <button
          type="button"
          onClick={onSeeAll}
          style={{
            flexShrink: 0,
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            fontSize: 9, letterSpacing: '0.18em',
            color: 'rgba(201,162,74,0.58)',
          }}
        >
          全て見る →
        </button>
      </div>

      {/* Horizontal carousel */}
      <div
        className="[&::-webkit-scrollbar]:hidden"
        style={{
          display: 'flex',
          gap: 10,
          overflowX: 'scroll',
          paddingLeft: 20,
          paddingRight: 20,
          paddingBottom: 4,
          scrollbarWidth: 'none',
          WebkitOverflowScrolling: 'touch',
        } as React.CSSProperties}
      >
        {displayStyles.map((style, i) => (
          <motion.button
            key={style.id}
            type="button"
            onClick={() => onStyleSelect(style)}
            whileTap={{ scale: 0.94 }}
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.05, duration: 0.3, ease: EASE_OUT }}
            style={{
              flexShrink: 0,
              width: 'clamp(140px, 44vw, 162px)',
              aspectRatio: '3/4',
              borderRadius: 12,
              overflow: 'hidden',
              position: 'relative',
              background: '#0A0504',
              border: '1px solid rgba(201,162,74,0.13)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
              cursor: 'pointer',
            }}
          >
            <StyleCardImage
              src={resolveStyleImageUrl(style)}
              alt={style.title}
              className="absolute inset-0 w-full h-full"
              imgStyle={getThumbImgStyle(style)}
              size="md"
            />
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ background: getThumbOverlay(style) }}
            />
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '0 10px 10px' }}>
              <p
                style={{
                  fontFamily: SERIF, fontSize: 11, fontWeight: 700,
                  color: '#F2E6C8', lineHeight: 1.22,
                  textShadow: '0 1px 8px rgba(0,0,0,0.95)',
                }}
              >
                {style.title}
              </p>
              <p style={{ fontSize: 10, color: 'rgba(201,162,74,0.84)', marginTop: 2 }}>
                ¥{style.price.toLocaleString()}
              </p>
            </div>
          </motion.button>
        ))}
      </div>
    </div>
  )
}

// ── MaintenanceScheduleSection ────────────────────────────────────────────────

function MaintenanceScheduleSection() {
  const userId = getUserId()
  // undefined = loading, null = no record, string = YYYY-MM-DD
  const [lastVisitDate, setLastVisitDate] = useState<string | null | undefined>(undefined)
  const [notifPerm, setNotifPerm] = useState<NotificationPermission>(getNotificationPermission)
  const [showScanner, setShowScanner] = useState(false)
  const [scannerActive, setScannerActive] = useState(false)
  const [scanMsg, setScanMsg] = useState<string | null>(null)
  const scannerRef = useRef<Html5Qrcode | null>(null)

  // Fetch last_visit_date from Supabase (localStorage fallback)
  async function fetchVisit() {
    try {
      const { data, error } = await supabase
        .from('maintenance_visits')
        .select('last_visit_date')
        .eq('user_id', userId)
        .maybeSingle()
      if (!error && data?.last_visit_date) {
        setLastVisitDate(data.last_visit_date as string)
        return
      }
    } catch { /* ignore */ }
    const local = getStoredValue<Record<string, string>>(MAINTENANCE_LOCAL_KEY, {})
    setLastVisitDate(local[userId] ?? null)
  }

  useEffect(() => { void fetchVisit() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (lastVisitDate) triggerMaintenanceNotification(lastVisitDate)
  }, [lastVisitDate])

  // QR scanner for "店内QRを読む"
  const stopScanner = useCallback(async () => {
    const s = scannerRef.current
    if (!s) return
    try { if (s.isScanning) await s.stop(); s.clear() } catch { /* ignore */ }
    scannerRef.current = null
    setScannerActive(false)
  }, [])

  const startScanner = useCallback(async () => {
    if (scannerRef.current) return
    const scanner = new Html5Qrcode(MAINT_SCHED_QR_EL_ID)
    scannerRef.current = scanner
    try {
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (decoded) => { void handleStoreQrScan(decoded); void stopScanner() },
        undefined,
      )
      setScannerActive(true)
    } catch {
      scannerRef.current = null
      setScanMsg('カメラを起動できませんでした。設定を確認してください。')
      setShowScanner(false)
    }
  }, [stopScanner]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (showScanner) { void startScanner() }
    else { void stopScanner() }
  }, [showScanner, startScanner, stopScanner])

  async function handleStoreQrScan(text: string) {
    try {
      const data = JSON.parse(text) as { type?: string }
      if (data.type !== 'ginjiro-store-checkin') {
        playWarningSound()
        setScanMsg('店舗のQRコードを読み取ってください。')
        setShowScanner(false)
        return
      }
    } catch {
      playWarningSound()
      setScanMsg('QRコードを認識できませんでした。')
      setShowScanner(false)
      return
    }
    const today = getJapanDateString()
    try {
      await supabase
        .from('maintenance_visits')
        .upsert({ user_id: userId, last_visit_date: today, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    } catch { /* ignore — fallback below */ }
    const local = getStoredValue<Record<string, string>>(MAINTENANCE_LOCAL_KEY, {})
    setStoredValue(MAINTENANCE_LOCAL_KEY, { ...local, [userId]: today })
    setLastVisitDate(today)
    setScanMsg(null)
    setShowScanner(false)
    playSuccessSound()
  }

  async function handleRequestPermission() {
    const perm = await requestNotificationPermission()
    setNotifPerm(perm)
    if (perm === 'granted' && lastVisitDate) triggerMaintenanceNotification(lastVisitDate)
  }

  if (lastVisitDate === undefined) return null // loading

  const daysLeft      = lastVisitDate ? getDaysUntilRecommended(lastVisitDate) : null
  const nextDate      = lastVisitDate ? getNextRecommendedDate(lastVisitDate) : null
  const isOverdue     = daysLeft !== null && daysLeft <= 0
  const elapsed       = daysLeft !== null
    ? Math.min(1, Math.max(0, (MAINTENANCE_CYCLE_DAYS - daysLeft) / MAINTENANCE_CYCLE_DAYS))
    : 0
  const notifSupported = isNotificationSupported()

  // Shared QR scanner modal
  const scannerModal = showScanner ? (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.92)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={() => setShowScanner(false)}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 360, borderRadius: 24, background: 'linear-gradient(160deg, #100806 0%, #080504 100%)', border: '1px solid rgba(201,162,74,0.28)', boxShadow: '0 24px 64px rgba(0,0,0,0.9)', padding: '24px 20px', textAlign: 'center' }}
      >
        <p style={{ fontSize: 9, letterSpacing: '0.28em', color: 'rgba(201,162,74,0.5)', marginBottom: 8 }}>STORE CHECK-IN</p>
        <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: '#F2E6C8', marginBottom: 18, lineHeight: 1.4 }}>
          店内のQRコードを<br />カメラで読み取ってください
        </p>
        <div id={MAINT_SCHED_QR_EL_ID} style={{ width: '100%', minHeight: scannerActive ? 260 : 0, borderRadius: 16, overflow: 'hidden', marginBottom: scannerActive ? 14 : 0 }} />
        <button
          type="button"
          onClick={() => setShowScanner(false)}
          style={{ width: '100%', padding: '13px 0', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', fontSize: 13, color: 'rgba(242,230,200,0.58)', fontFamily: SERIF, letterSpacing: '0.14em', cursor: 'pointer', marginTop: 8 }}
        >
          キャンセル
        </button>
      </div>
    </div>
  ) : null

  // ── No visit date ──
  if (!lastVisitDate) {
    return (
      <div className="px-4">
        <div className="mb-4 flex items-center gap-3 px-1">
          <p className="text-[17px] font-bold leading-none" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
            メンテナンス予報
          </p>
          <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, rgba(201,162,74,0.3), transparent)' }} />
        </div>
        <div style={{ borderRadius: 20, background: 'linear-gradient(145deg, rgba(22,9,7,0.96), rgba(10,5,4,0.98))', border: '1px solid rgba(201,162,74,0.14)', padding: '24px 20px', textAlign: 'center' }}>
          <p style={{ fontSize: 9, letterSpacing: '0.28em', color: 'rgba(201,162,74,0.42)', marginBottom: 14 }}>
            MAINTENANCE SCHEDULE
          </p>
          <p style={{ fontFamily: SERIF, fontSize: 14, color: 'rgba(242,230,200,0.56)', lineHeight: 1.8, marginBottom: 22 }}>
            店内QRを読み込むと<br />
            次回カット時期を自動でお知らせします。
          </p>
          {scanMsg && (
            <div style={{ borderRadius: 12, background: 'rgba(224,100,60,0.1)', border: '1px solid rgba(224,100,60,0.28)', padding: '10px 14px', marginBottom: 14 }}>
              <p style={{ fontSize: 12, color: '#E06040', lineHeight: 1.6 }}>{scanMsg}</p>
            </div>
          )}
          <button
            type="button"
            onClick={() => { setScanMsg(null); setShowScanner(true) }}
            style={{ width: '100%', padding: '13px 0', borderRadius: 14, background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)', border: '1px solid rgba(201,162,74,0.44)', boxShadow: '0 4px 20px rgba(107,15,18,0.45)', fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.22em', color: '#F2E6C8', cursor: 'pointer' }}
          >
            店内QRを読む
          </button>
        </div>
        {scannerModal}
      </div>
    )
  }

  // ── Overdue: 14日超過 ──
  if (isOverdue) {
    return (
      <div className="px-4">
        <div className="mb-4 flex items-center gap-3 px-1">
          <p className="text-[17px] font-bold leading-none flex-shrink-0" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
            メンテナンス予報
          </p>
          <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, rgba(180,40,40,0.38), transparent)' }} />
        </div>
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3 }}
          style={{ borderRadius: 20, background: 'linear-gradient(145deg, #2D0608, #1A0305)', border: '1px solid rgba(180,40,40,0.48)', boxShadow: '0 12px 40px rgba(120,10,10,0.42), inset 0 1px 0 rgba(255,80,60,0.06)', padding: '22px 20px 24px' }}
        >
          <p style={{ fontSize: 9, letterSpacing: '0.28em', color: 'rgba(200,60,50,0.68)', marginBottom: 8 }}>MAINTENANCE ALERT</p>
          <p style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#F2E6C8', lineHeight: 1.35, marginBottom: 4 }}>
            {daysLeft! < 0 ? `男前崩壊中… ${Math.abs(daysLeft!)}日超過` : 'メンテナンス時期です。'}
          </p>
          <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.50)', marginBottom: 18 }}>メンテナンスカットの時間です。</p>
          <div style={{ display: 'flex', gap: 16, marginBottom: 18, padding: '12px 14px', borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div>
              <p style={{ fontSize: 8, letterSpacing: '0.2em', color: 'rgba(201,162,74,0.44)', marginBottom: 3 }}>前回来店日</p>
              <p style={{ fontFamily: SERIF, fontSize: 13, color: 'rgba(242,230,200,0.72)' }}>{fmtDate(lastVisitDate)}</p>
            </div>
            <div style={{ width: 1, background: 'rgba(255,255,255,0.06)' }} />
            <div>
              <p style={{ fontSize: 8, letterSpacing: '0.2em', color: 'rgba(201,162,74,0.44)', marginBottom: 3 }}>次回推奨日</p>
              <p style={{ fontFamily: SERIF, fontSize: 13, color: '#C9A24A' }}>{fmtDate(nextDate!)}</p>
            </div>
          </div>
          <a
            href={MAINTENANCE_CUT_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'block', textAlign: 'center', padding: '14px 0', borderRadius: 14, background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)', border: '1px solid rgba(201,162,74,0.44)', boxShadow: '0 4px 24px rgba(107,15,18,0.55)', textDecoration: 'none', fontFamily: SERIF, fontSize: 14, fontWeight: 700, letterSpacing: '0.22em', color: '#F2E6C8' }}
          >
            メンテナンスカットを予約する
          </a>
          {notifSupported && notifPerm === 'default' && (
            <button type="button" onClick={handleRequestPermission} style={{ width: '100%', marginTop: 10, padding: '10px 0', borderRadius: 10, background: 'rgba(201,162,74,0.06)', border: '1px solid rgba(201,162,74,0.22)', fontSize: 11, letterSpacing: '0.14em', color: 'rgba(201,162,74,0.72)', fontFamily: SERIF, cursor: 'pointer' }}>
              カット時期になったら通知する
            </button>
          )}
          {notifSupported && notifPerm === 'granted' && (
            <p style={{ marginTop: 10, fontSize: 10, letterSpacing: '0.14em', color: 'rgba(201,162,74,0.44)', textAlign: 'center' }}>通知ON — 次回以降も3日前にお知らせします</p>
          )}
        </motion.div>
      </div>
    )
  }

  // ── Active: 14日以内 ──
  return (
    <div className="px-4">
      <div className="mb-4 flex items-center gap-3 px-1">
        <p className="text-[17px] font-bold leading-none flex-shrink-0" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
          メンテナンス予報
        </p>
        <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, rgba(201,162,74,0.3), transparent)' }} />
      </div>
      <div style={{ borderRadius: 20, background: 'linear-gradient(145deg, rgba(22,9,7,0.96), rgba(10,5,4,0.98))', border: '1px solid rgba(201,162,74,0.18)', boxShadow: '0 12px 40px rgba(0,0,0,0.55)', padding: '20px 20px 22px' }}>
        <div style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 8, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.48)', marginBottom: 5 }}>前回来店日</p>
            <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: '#F2E6C8' }}>{fmtDate(lastVisitDate)}</p>
          </div>
          <div style={{ width: 1, background: 'rgba(201,162,74,0.12)' }} />
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 8, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.48)', marginBottom: 5 }}>次回推奨日</p>
            <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: '#C9A24A' }}>{fmtDate(nextDate!)}</p>
          </div>
        </div>
        <div style={{ marginBottom: notifSupported ? 16 : 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
            <span style={{ fontSize: 8, letterSpacing: '0.18em', color: 'rgba(201,162,74,0.38)' }}>{MAINTENANCE_CYCLE_DAYS}DAY CYCLE</span>
            <span style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#C9A24A' }}>あと{Math.max(0, daysLeft!)}日</span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: 'rgba(201,162,74,0.10)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${elapsed * 100}%`, borderRadius: 2, background: 'linear-gradient(90deg, rgba(201,162,74,0.45), rgba(201,162,74,0.88))', transition: 'width 0.6s ease' }} />
          </div>
        </div>
        {notifSupported && (
          notifPerm === 'granted' ? (
            <p style={{ fontSize: 10, letterSpacing: '0.14em', color: 'rgba(201,162,74,0.44)', textAlign: 'center', marginTop: 12 }}>通知ON — 来店3日前にお知らせします</p>
          ) : notifPerm === 'denied' ? (
            <p style={{ fontSize: 10, letterSpacing: '0.12em', color: 'rgba(200,80,60,0.52)', textAlign: 'center', marginTop: 12 }}>通知が拒否されています（設定から変更できます）</p>
          ) : (
            <button type="button" onClick={handleRequestPermission} style={{ width: '100%', marginTop: 12, padding: '10px 0', borderRadius: 10, background: 'rgba(201,162,74,0.06)', border: '1px solid rgba(201,162,74,0.22)', fontSize: 11, letterSpacing: '0.14em', color: 'rgba(201,162,74,0.76)', fontFamily: SERIF, cursor: 'pointer' }}>
              カット時期になったら通知する
            </button>
          )
        )}
      </div>
    </div>
  )
}

// ── HeroSlider ────────────────────────────────────────────────────────────────

function HeroSlider() {
  const [current, setCurrent] = useState(0)
  const touchStartX = useRef<number | null>(null)

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrent((i) => (i + 1) % HERO_SLIDE_IMAGES.length)
    }, 7000)
    return () => clearInterval(timer)
  }, [])

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0]?.clientX ?? null
  }

  function handleTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return
    const endX = e.changedTouches[0]?.clientX
    if (endX === undefined) return
    const diff = endX - touchStartX.current
    touchStartX.current = null
    if (Math.abs(diff) < 40) return
    if (diff < 0) {
      setCurrent((i) => (i + 1) % HERO_SLIDE_IMAGES.length)
    } else {
      setCurrent((i) => (i - 1 + HERO_SLIDE_IMAGES.length) % HERO_SLIDE_IMAGES.length)
    }
  }

  return (
    <div
      className="relative w-full overflow-hidden select-none"
      style={{ aspectRatio: '1440 / 2200', maxHeight: '88dvh' }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div className="absolute inset-0" style={{ background: '#050302' }} />
      <AnimatePresence mode="sync">
        {HERO_SLIDE_IMAGES.map((img, i) =>
          i === current ? (
            <motion.div
              key={`slide-${i}`}
              className="absolute inset-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.6, ease: [0.25, 0, 0.25, 1] }}
            >
              <motion.img
                src={img.src}
                alt={img.alt}
                className="absolute inset-0 w-full h-full"
                style={{ objectFit: 'cover', objectPosition: img.position }}
                initial={{ scale: 1 }}
                animate={{ scale: 1.04 }}
                transition={{ duration: 9, ease: [0.22, 0, 0.36, 1] }}
                onError={(e) => { ;(e.target as HTMLImageElement).style.display = 'none' }}
              />
            </motion.div>
          ) : null,
        )}
      </AnimatePresence>
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          zIndex: 2,
          background: [
            'linear-gradient(90deg, rgba(5,3,2,0.40) 0%, rgba(5,3,2,0.0) 42%)',
            'linear-gradient(180deg, rgba(5,3,2,0.82) 0%, rgba(5,3,2,0.0) 22%, rgba(5,3,2,0.0) 48%, rgba(5,3,2,0.60) 68%, rgba(5,3,2,0.97) 100%)',
          ].join(', '),
        }}
      />
      <div className="absolute bottom-5 left-0 right-0 flex justify-center gap-1.5" style={{ zIndex: 3 }}>
        {HERO_SLIDE_IMAGES.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setCurrent(i)}
            aria-label={`スライド ${i + 1}`}
            style={{
              width: i === current ? 18 : 6,
              height: 6,
              borderRadius: 3,
              background: i === current ? '#C9A24A' : 'rgba(242,230,200,0.26)',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              flexShrink: 0,
              transition: 'width 0.35s ease, background 0.35s ease',
            }}
          />
        ))}
      </div>
    </div>
  )
}

// ── HomeScreen ────────────────────────────────────────────────────────────────

export function HomeScreen({ onTabChange, onModalChange }: Props) {
  const [styles] = useState(() =>
    loadStyles()
      .filter((s) => s.isPublished)
      .sort((a, b) => a.sortOrder - b.sortOrder),
  )
  const [selectedStyle, setSelectedStyle] = useState<StyleCard | null>(null)

  useEffect(() => {
    onModalChange?.(selectedStyle !== null)
  }, [selectedStyle, onModalChange])

  return (
    <div className="ginjiro-luxury-bg ginjiro-luxury-bg--home">
      <div className="relative z-10">
        <HeroSlider />

        <div className="space-y-12 pt-7 pb-16">

          {/* ① 男前証 */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.04, duration: 0.42, ease: EASE_OUT }}
          >
            <PassportCard />
          </motion.div>

          {/* ② 銀二郎スタイル */}
          <motion.div
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12, duration: 0.44, ease: EASE_OUT }}
          >
            <StylesRow
              styles={styles}
              onStyleSelect={setSelectedStyle}
              onSeeAll={() => onTabChange('styles')}
            />
          </motion.div>

          {/* ③ 保有チケット */}
          <motion.div
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.20, duration: 0.44, ease: EASE_OUT }}
          >
            <TicketWalletSection />
          </motion.div>

          {/* ④ 期間限定クーポン */}
          <motion.div
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.27, duration: 0.44, ease: EASE_OUT }}
          >
            <MaintenanceCutSection />
          </motion.div>

          {/* ⑤ メンテナンス予報 */}
          <motion.div
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.34, duration: 0.44, ease: EASE_OUT }}
          >
            <MaintenanceScheduleSection />
          </motion.div>
        </div>

        <AnimatePresence>
          {selectedStyle && (
            <StyleDetailModal
              key={selectedStyle.id}
              style={selectedStyle}
              onClose={() => setSelectedStyle(null)}
              onReserve={() => {
                setSelectedStyle(null)
                onTabChange('reserve')
              }}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
