import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Html5Qrcode } from 'html5-qrcode'
import { supabase } from '../lib/supabase'
import { isInStoreModeActive, activateInStoreMode, clearInStoreMode } from '../utils/inStoreMode'
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
  getMaintenanceVisit,
  saveMaintenanceVisit,
  saveMaintenanceVisitFromScan,
  getNextRecommendedDate,
  getDaysUntilRecommended,
  shouldShowNotificationBanner,
  MAINTENANCE_CYCLE_DAYS,
  fmtDate,
} from '../utils/maintenanceSchedule'
import {
  isNotificationSupported,
  getNotificationPermission,
  requestNotificationPermission,
  triggerMaintenanceNotification,
} from '../utils/pushNotification'
import { getUserId } from '../utils/userId'
import { getUserTickets, getActiveTicket, setActiveTicket, clearActiveTicket, initiateTransfer, cancelTransfer } from '../utils/ticketStore'
import { loadMemberStatus, getStoredValue, ONBOARDING_NAME_KEY, loadCoupons, saveCoupons } from '../utils/storage'
import type { TicketRow, TicketType } from '../data/ticket'
import { TICKET_TYPE_LABELS, TICKET_TYPE_COLORS } from '../data/ticket'
import type { Coupon } from '../data/brand'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

// Easing curve used for stagger animations
const EASE_OUT = [0.25, 0.46, 0.45, 0.94] as const

const MAINTENANCE_LOCAL_KEY = 'ginjiro_maintenance_visits'
const CUSTOMER_QR_EL_ID = 'gj-customer-qr-reader'

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

async function fetchLastVisitDateForUser(userId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('maintenance_visits')
      .select('last_visit_date')
      .eq('user_id', userId)
      .maybeSingle()
    if (!error && data?.last_visit_date) return data.last_visit_date as string
  } catch { /* ignore */ }
  try {
    const local = JSON.parse(localStorage.getItem(MAINTENANCE_LOCAL_KEY) ?? '{}') as Record<string, { last_visit_date?: string }>
    return local[userId]?.last_visit_date ?? null
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

type WalletItem =
  | { kind: 'ticket'; data: TicketRow }
  | { kind: 'coupon'; data: Coupon & { amount: number } }

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

function walletCardStyle(item: WalletItem): { bg: string; accent: string; bar: string; label: string } {
  if (item.kind === 'ticket' && item.data.type === 'cut-ticket') {
    return {
      bg:     'linear-gradient(145deg, #050b18 0%, #030610 60%, #060810 100%)',
      accent: '#6AABF0',
      bar:    'linear-gradient(90deg, transparent, #1a3a6b 30%, #6AABF0 50%, #1a3a6b 70%, transparent)',
      label:  'rgba(106,171,240,0.65)',
    }
  }
  if (item.kind === 'coupon' && item.data.id === 'preset-otoku-1000') {
    return {
      bg:     'linear-gradient(145deg, #040e06 0%, #030a05 60%, #050e07 100%)',
      accent: '#80D060',
      bar:    'linear-gradient(90deg, transparent, #1a4820 30%, #80D060 50%, #1a4820 70%, transparent)',
      label:  'rgba(128,208,96,0.65)',
    }
  }
  return {
    bg:     'linear-gradient(145deg, #100608 0%, #080304 60%, #0e0508 100%)',
    accent: '#C9A24A',
    bar:    'linear-gradient(90deg, transparent, #6B0F12 30%, #C9A24A 50%, #6B0F12 70%, transparent)',
    label:  'rgba(201,162,74,0.65)',
  }
}

function TicketWalletSection() {
  const userId   = getUserId()
  const memberStatus = loadMemberStatus()
  const memberName   = getStoredValue<string>(ONBOARDING_NAME_KEY, memberStatus.memberName)

  const [items,         setItems]         = useState<WalletItem[]>([])
  const [confirmItem,   setConfirmItem]   = useState<WalletItem | null>(null)
  const [qrItem,        setQrItem]        = useState<WalletItem | null>(null)
  const [transferItem,  setTransferItem]  = useState<WalletItem | null>(null)
  const [transferToken, setTransferToken] = useState<string | null>(null)
  const [showXferQr,    setShowXferQr]    = useState(false)
  const [xferring,      setXferring]      = useState(false)
  const [copied,        setCopied]        = useState(false)

  function refreshItems() {
    getUserTickets(userId)
      .then(tickets => {
        const ti: WalletItem[] = tickets.filter(t => !t.used).map(t => ({ kind: 'ticket' as const, data: t }))
        const ci: WalletItem[] = loadCoupons()
          .filter(c => !c.used && typeof c.amount === 'number')
          .map(c => ({ kind: 'coupon' as const, data: c as Coupon & { amount: number } }))
        setItems([...ti, ...ci])
      })
      .catch(() => {
        const ci: WalletItem[] = loadCoupons()
          .filter(c => !c.used && typeof c.amount === 'number')
          .map(c => ({ kind: 'coupon' as const, data: c as Coupon & { amount: number } }))
        setItems(ci)
      })
  }

  useEffect(() => { refreshItems() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 券種グループと個別クーポンに分離
  const ticketItems  = items.filter(item => item.kind === 'ticket')
  const couponItems  = items.filter(item => item.kind === 'coupon')
  const ticketGroups = groupWalletTickets(ticketItems)

  const qrValue = qrItem
    ? qrItem.kind === 'ticket'
      ? JSON.stringify({ type: 'otokomae-passport', userId, name: memberName, rank: RANK_EN_MAP[memberStatus.rank] ?? 'BRONZE', points: memberStatus.points })
      : JSON.stringify({ type: 'otokomae-coupon', id: qrItem.data.id, title: qrItem.data.title, amount: qrItem.data.amount })
    : ''

  function handleUseConfirm() {
    if (!confirmItem) return
    if (confirmItem.kind === 'ticket') {
      const t = confirmItem.data
      const active = getActiveTicket()
      if (active && active !== t.id) {
        alert('他のチケットが使用中です。先にそちらを閉じてください。')
        setConfirmItem(null)
        return
      }
      if (t.pending_transfer) {
        alert('このチケットは渡し手続き中です。')
        setConfirmItem(null)
        return
      }
      setActiveTicket(t.id)
    }
    setQrItem(confirmItem)
    setConfirmItem(null)
  }

  function handleQrClose() {
    if (qrItem?.kind === 'ticket') {
      clearActiveTicket()
    } else if (qrItem?.kind === 'coupon') {
      const next = loadCoupons().map(c => c.id === qrItem.data.id ? { ...c, used: true } : c)
      saveCoupons(next)
    }
    setQrItem(null)
    refreshItems()
  }

  async function handleTransfer(item: WalletItem) {
    if (item.kind !== 'ticket') return
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
    if (transferItem?.kind !== 'ticket') return
    try { await cancelTransfer(transferItem.data.id, userId) } catch {}
    setTransferToken(null)
    setTransferItem(null)
    setShowXferQr(false)
    refreshItems()
  }

  const transferUrl = transferToken ? `${window.location.origin}?transfer=${transferToken}` : null

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
            {ticketGroups.length + couponItems.length}種 · {items.length}枚
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

              <div style={{ padding: '16px 18px 14px' }}>
                {/* 券種ラベル + 枚数バッジ */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
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
                  fontFamily: SERIF, fontSize: 22, fontWeight: 700,
                  color: '#F2E6C8', letterSpacing: '0.04em', lineHeight: 1.15,
                  marginBottom: group.amount > 0 ? 4 : 12,
                }}>
                  {group.title}
                </p>

                {/* 金額 */}
                {group.amount > 0 && (
                  <p style={{
                    fontFamily: SERIF, fontSize: 28, fontWeight: 700,
                    color: '#C9A24A', letterSpacing: '0.01em', lineHeight: 1, marginBottom: 8,
                  }}>
                    ¥{group.amount.toLocaleString()}
                  </p>
                )}

                {/* 内訳バッジ（渡し中 / 期限切れ） */}
                {(pendingCount > 0 || expiredCount > 0) && (
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 6 }}>
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
                <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.34)', marginBottom: 14, letterSpacing: '0.06em' }}>
                  {repTicket?.expires_at
                    ? `有効期限 ${repTicket.expires_at.slice(0, 10).replace(/-/g, '/')}`
                    : '有効期限なし'}
                </p>

                <div style={{ height: '0.5px', background: `linear-gradient(90deg, ${tc.border}22, transparent)`, marginBottom: 12 }} />

                {/* Primary: 使用する */}
                <button
                  type="button"
                  onClick={() => { if (canUse && group.activeItems[0]) setConfirmItem(group.activeItems[0]) }}
                  disabled={!canUse}
                  style={{
                    width: '100%', padding: '12px 0', borderRadius: 10,
                    background: canUse ? tc.btnBg : 'rgba(255,255,255,0.02)',
                    border: `1.5px solid ${canUse ? tc.border : 'rgba(255,255,255,0.07)'}`,
                    boxShadow: canUse ? `0 4px 18px ${tc.border}38` : 'none',
                    fontSize: 11, fontWeight: 700, letterSpacing: '0.12em',
                    color: canUse ? tc.text : 'rgba(242,230,200,0.2)',
                    fontFamily: SERIF, cursor: canUse ? 'pointer' : 'default',
                  }}
                >
                  使用する
                </button>

                {/* Secondary: 譲る */}
                <button
                  type="button"
                  onClick={() => { if (canGift && group.activeItems[0]) void handleTransfer(group.activeItems[0]) }}
                  disabled={!canGift || xferring}
                  style={{
                    display: 'block', width: '100%',
                    padding: '8px 0 2px',
                    background: 'none', border: 'none',
                    fontSize: 11,
                    color: canGift ? 'rgba(242,230,200,0.36)' : 'rgba(242,230,200,0.14)',
                    fontFamily: SERIF, letterSpacing: '0.12em',
                    cursor: canGift ? 'pointer' : 'default',
                    textDecoration: canGift ? 'underline' : 'none',
                    textUnderlineOffset: '3px',
                    textAlign: 'center',
                  }}
                >
                  譲る
                </button>
              </div>
            </motion.div>
          )
        })}

        {/* ── 個別クーポン（旧来型、グループ化しない） ── */}
        {couponItems.map((item, i) => {
          const cs     = walletCardStyle(item)
          const title  = item.data.title
          const amount = item.data.amount ?? 0

          return (
            <motion.div
              key={item.data.id}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: (ticketGroups.length + i) * 0.07, duration: 0.38 }}
              style={{
                flexShrink: 0,
                width: 'clamp(256px, 76vw, 284px)',
                borderRadius: 20,
                background: cs.bg,
                border: `1px solid ${cs.accent}38`,
                boxShadow: `0 16px 48px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.035)`,
                overflow: 'hidden',
              }}
            >
              <div style={{ height: 2, background: cs.bar }} />
              <div style={{ padding: '16px 18px 14px' }}>
                <div style={{ marginBottom: 12 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', color: cs.label, textTransform: 'uppercase' }}>
                    Specialクーポン
                  </span>
                </div>
                <p style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: '#F2E6C8', letterSpacing: '0.04em', lineHeight: 1.15, marginBottom: amount > 0 ? 4 : 14 }}>
                  {title}
                </p>
                {amount > 0 && (
                  <p style={{ fontFamily: SERIF, fontSize: 28, fontWeight: 700, color: cs.accent, letterSpacing: '0.01em', lineHeight: 1, marginBottom: 8 }}>
                    ¥{amount.toLocaleString()}
                  </p>
                )}
                <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.34)', marginBottom: 14, letterSpacing: '0.06em' }}>有効期限なし</p>
                <div style={{ height: '0.5px', background: `linear-gradient(90deg, ${cs.accent}22, transparent)`, marginBottom: 12 }} />
                <button
                  type="button"
                  onClick={() => setConfirmItem(item)}
                  style={{
                    width: '100%', padding: '12px 0', borderRadius: 10,
                    background: `${cs.accent}1a`, border: `1.5px solid ${cs.accent}44`,
                    boxShadow: `0 4px 18px ${cs.accent}30`,
                    fontSize: 11, fontWeight: 700, letterSpacing: '0.12em',
                    color: '#F2E6C8', fontFamily: SERIF, cursor: 'pointer',
                  }}
                >
                  使用する
                </button>
              </div>
            </motion.div>
          )
        })}

        <div style={{ width: 8, flexShrink: 0 }} />
      </div>

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
                {confirmItem.kind === 'ticket'
                  ? 'スタッフにQRコードを提示してください。'
                  : 'このクーポンを使用します。\nスタッフに確認してもらってください。'}
              </p>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="button" onClick={() => setConfirmItem(null)}
                  style={{ flex: 1, padding: '13px 0', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', fontSize: 13, color: 'rgba(242,230,200,0.52)', fontFamily: SERIF, letterSpacing: '0.14em', cursor: 'pointer' }}>
                  キャンセル
                </button>
                <button type="button" onClick={handleUseConfirm}
                  style={{ flex: 2, padding: '13px 0', borderRadius: 14, background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)', border: '1px solid rgba(201,162,74,0.44)', boxShadow: '0 4px 20px rgba(107,15,18,0.45)', fontSize: 13, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF, letterSpacing: '0.16em', cursor: 'pointer' }}>
                  はい、使用する
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── QR 表示モーダル ── */}
      <AnimatePresence>
        {qrItem && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <motion.div
              initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }}
              transition={{ duration: 0.24 }}
              style={{ width: '100%', maxWidth: 360, borderRadius: 24, background: 'linear-gradient(160deg, #160A07 0%, #0A0504 100%)', border: '1px solid rgba(201,162,74,0.28)', boxShadow: '0 24px 64px rgba(0,0,0,0.92)', padding: '28px 24px', textAlign: 'center' }}
            >
              <p style={{ fontSize: 9, letterSpacing: '0.28em', color: 'rgba(201,162,74,0.5)', marginBottom: 8 }}>TICKET QR</p>
              <p style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 700, color: '#F2E6C8', marginBottom: 2 }}>{qrItem.data.title}</p>
              {(qrItem.data.amount ?? 0) > 0 && (
                <p style={{ fontFamily: SERIF, fontSize: 14, color: '#C9A24A', marginBottom: 18 }}>¥{(qrItem.data.amount ?? 0).toLocaleString()}</p>
              )}
              <div style={{ display: 'inline-block', padding: 16, background: '#FFFFFF', borderRadius: 16, boxShadow: '0 8px 32px rgba(0,0,0,0.55)', marginBottom: 20 }}>
                <QRCodeSVG value={qrValue} size={200} level="M" />
              </div>
              <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.38)', lineHeight: 1.75, marginBottom: 20 }}>
                {qrItem.kind === 'ticket'
                  ? 'スタッフがスキャン後に使用確定されます。\n確定後「閉じる」を押してください。'
                  : 'スタッフに見せて確認してもらってください。\n確認後「使用済みにする」を押してください。'}
              </p>
              <button type="button" onClick={handleQrClose}
                style={{ width: '100%', padding: '13px 0', borderRadius: 14, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)', fontSize: 13, color: 'rgba(242,230,200,0.72)', fontFamily: SERIF, letterSpacing: '0.16em', cursor: 'pointer' }}>
                {qrItem.kind === 'ticket' ? '閉じる' : '使用済みにする'}
              </button>
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

const RANK_EN_MAP: Record<string, string> = {
  ブロンズ: 'BRONZE', シルバー: 'SILVER', ゴールド: 'GOLD', プラチナ: 'PLATINUM',
}

function MaintenanceCutSection({ onTabChange }: { onTabChange: (tab: NavTab) => void }) {
  const userId = getUserId()
  const [tickets, setTickets] = useState<TicketRow[]>([])
  const [ticketsLoaded, setTicketsLoaded] = useState(false)

  // In-store mode state (2-hour localStorage expiry)
  const [inStoreMode, setInStoreMode] = useState(() => isInStoreModeActive())
  const [showScanner, setShowScanner] = useState(false)
  const [scannerActive, setScannerActive] = useState(false)
  const [scanMsg, setScanMsg] = useState<string | null>(null)
  const [scanProcessing, setScanProcessing] = useState(false)
  const scannerRef = useRef<Html5Qrcode | null>(null)

  // 来店日・残り日数（参考表示用）
  const lastVisit = getLastVisit()
  const daysRemaining = lastVisit ? getDaysRemaining(lastVisit.visitedAt) : null
  const isEligible = daysRemaining !== null && daysRemaining >= 0

  async function fetchTickets() {
    try { setTickets(await getUserTickets(userId)) }
    catch { setTickets([]) }
    finally { setTicketsLoaded(true) }
  }

  useEffect(() => { fetchTickets() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 未使用のメンテナンスカット券
  const unusedCutTicket: TicketRow | undefined = tickets.find(t => t.type === 'cut-ticket' && !t.used)

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

    const lastVisitDate = await fetchLastVisitDateForUser(userId)
    setShowScanner(false)

    if (!lastVisitDate) {
      playWarningSound()
      setScanMsg('来店記録がありません。通常価格でのご予約をお願いします。')
      setScanProcessing(false)
      return
    }

    const daysDiff = Math.floor((Date.now() - new Date(lastVisitDate).getTime()) / (1000 * 60 * 60 * 24))

    if (daysDiff <= 14) {
      playSuccessSound()
      activateInStoreMode()
      setInStoreMode(true)
      setScanMsg(null)
    } else {
      playWarningSound()
      setScanMsg(`前回来店から${daysDiff}日が経過しています。メンテナンスカットはご利用いただけません。`)
    }
    setScanProcessing(false)
  }

  function handleCouponPageTap() {
    clearInStoreMode()
    setInStoreMode(false)
    onTabChange('mypage')
  }

  const showCouponBtn = inStoreMode && !!unusedCutTicket

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
                background: showCouponBtn
                  ? 'linear-gradient(135deg, #0a3d1a 0%, #145a2a 100%)'
                  : 'linear-gradient(135deg, #3d0608 0%, #6B0F12 100%)',
                border: `1px solid ${showCouponBtn ? 'rgba(100,200,100,0.36)' : 'rgba(201,162,74,0.36)'}`,
                fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
                color: showCouponBtn ? '#90E8A0' : '#F2E6C8', fontFamily: SERIF,
              }}
            >
              {showCouponBtn ? 'クーポン有効' : '14DAY CYCLE'}
            </span>
            {/* 店内QR読み取りボタン */}
            {!inStoreMode && (
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

          {/* 未使用クーポン情報 */}
          {unusedCutTicket && (
            <div style={{ borderRadius: 12, background: 'rgba(100,200,100,0.05)', border: '1px solid rgba(100,200,100,0.22)', padding: '10px 14px', marginBottom: 16 }}>
              <p style={{ fontSize: 9, letterSpacing: '0.16em', color: 'rgba(144,232,160,0.6)', marginBottom: 3 }}>メンテナンスカット券</p>
              <p style={{ fontSize: 13, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF }}>{unusedCutTicket.title}</p>
              {unusedCutTicket.expires_at && (
                <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.38)', marginTop: 3 }}>
                  有効期限 {unusedCutTicket.expires_at.slice(0, 10).replace(/-/g, '/')}
                </p>
              )}
            </div>
          )}

          {/* 来店日・残り日数（クーポン無し・来店記録あり） */}
          {!unusedCutTicket && ticketsLoaded && lastVisit && (
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

          {/* ボタン */}
          {!ticketsLoaded ? (
            <div style={{ height: 48, borderRadius: 14, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }} />
          ) : showCouponBtn ? (
            <button
              type="button"
              onClick={handleCouponPageTap}
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
                クーポンページへ
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

// ── StylesRow (horizontal scroll preview) ────────────────────────────────────

function StylesRow({
  styles,
  onStyleSelect,
}: {
  styles: StyleCard[]
  onStyleSelect: (s: StyleCard) => void
}) {
  if (styles.length === 0) return null

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center gap-3 px-5 mb-3">
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
        <p
          style={{
            fontSize: 8, letterSpacing: '0.22em',
            color: 'rgba(201,162,74,0.46)', flexShrink: 0,
          }}
        >
          ALL STYLES
        </p>
      </div>

      {/* Horizontal strip */}
      <div
        className="[&::-webkit-scrollbar]:hidden"
        style={{
          display: 'flex',
          gap: 10,
          overflowX: 'scroll',
          paddingLeft: 20,
          paddingRight: 32,
          scrollbarWidth: 'none',
          WebkitOverflowScrolling: 'touch',
        } as React.CSSProperties}
      >
        {styles.map((style, i) => (
          <motion.button
            key={style.id}
            type="button"
            onClick={() => onStyleSelect(style)}
            whileTap={{ scale: 0.92 }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04, duration: 0.3, ease: EASE_OUT }}
            style={{
              flexShrink: 0,
              width: 'clamp(108px, 34vw, 144px)',
              aspectRatio: '2/3',
              borderRadius: 10,
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
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '0 8px 9px' }}>
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
  const [visit, setVisit] = useState(() => getMaintenanceVisit())
  const [isEditing, setIsEditing] = useState(false)
  const [editDate, setEditDate] = useState('')
  const [notifPerm, setNotifPerm] = useState<NotificationPermission>(getNotificationPermission)

  // Trigger OS notification on mount if conditions are met
  useEffect(() => {
    if (visit) triggerMaintenanceNotification(visit.lastVisitDate)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 店舗端末でQRスキャン確定した usedAt を lastVisitDate へ自動反映（正式な14日起点）
  useEffect(() => {
    const userId = getUserId()
    getUserTickets(userId)
      .then(tickets => {
        const latest = tickets
          .filter(t => t.type === 'cut-ticket' && t.used && t.used_at)
          .sort((a, b) => (b.used_at ?? '').localeCompare(a.used_at ?? ''))[0]
        if (!latest?.used_at) return
        const usedDate = latest.used_at.slice(0, 10)
        const current = getMaintenanceVisit()
        // QRスキャン確定日が手入力の日付より新しい場合のみ上書き
        if (!current || usedDate > current.lastVisitDate) {
          saveMaintenanceVisitFromScan(usedDate, latest.used_at)
          setVisit(getMaintenanceVisit())
        }
      })
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const today = new Date().toISOString().slice(0, 10)

  function openEditor() {
    setEditDate(visit?.lastVisitDate ?? today)
    setIsEditing(true)
  }

  async function handleSave() {
    if (!editDate) return
    saveMaintenanceVisit(editDate)
    const saved = getMaintenanceVisit()
    setVisit(saved)
    setIsEditing(false)
    // 登録ボタンタップ = ユーザー操作なので、まだ未確認なら通知許可を自動リクエスト
    if (notifPerm === 'default') {
      const perm = await requestNotificationPermission()
      setNotifPerm(perm)
      if (perm === 'granted' && saved) triggerMaintenanceNotification(saved.lastVisitDate)
    } else if (saved) {
      triggerMaintenanceNotification(saved.lastVisitDate)
    }
  }

  async function handleRequestPermission() {
    const perm = await requestNotificationPermission()
    setNotifPerm(perm)
    if (perm === 'granted' && visit) triggerMaintenanceNotification(visit.lastVisitDate)
  }

  const daysLeft      = visit ? getDaysUntilRecommended(visit.lastVisitDate) : null
  const nextDate      = visit ? getNextRecommendedDate(visit.lastVisitDate) : null
  const isAlert       = daysLeft !== null && shouldShowNotificationBanner(visit!.lastVisitDate)
  const isOverdue     = daysLeft !== null && daysLeft < 0
  const elapsed       = daysLeft !== null
    ? Math.min(1, Math.max(0, (MAINTENANCE_CYCLE_DAYS - daysLeft) / MAINTENANCE_CYCLE_DAYS))
    : 0
  // QRスキャン確定済みの場合、ユーザーによる日付変更を禁止
  const isQrConfirmed = (visit?.source ?? 'manual') === 'qr'
  const notifSupported = isNotificationSupported()

  // ── Date editor ──

  if (isEditing) {
    return (
      <div className="px-4">
        <div className="mb-4 flex items-center gap-3 px-1">
          <p className="text-[17px] font-bold leading-none" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
            前回来店日を登録
          </p>
        </div>
        <div
          style={{
            borderRadius: 20,
            background: 'linear-gradient(145deg, rgba(22,9,7,0.96), rgba(10,5,4,0.98))',
            border: '1px solid rgba(201,162,74,0.22)',
            padding: '22px 20px',
          }}
        >
          <p style={{ fontSize: 10, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.52)', marginBottom: 14 }}>
            LAST VISIT DATE
          </p>
          <input
            type="date"
            value={editDate}
            max={today}
            onChange={(e) => setEditDate(e.target.value)}
            style={{
              width: '100%',
              background: 'rgba(201,162,74,0.06)',
              border: '1px solid rgba(201,162,74,0.28)',
              borderRadius: 12,
              padding: '12px 14px',
              fontSize: 16,
              color: '#F2E6C8',
              fontFamily: SERIF,
              outline: 'none',
              marginBottom: 16,
              colorScheme: 'dark',
            } as React.CSSProperties}
          />
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              onClick={() => setIsEditing(false)}
              style={{
                flex: 1, padding: '12px 0', borderRadius: 12,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.10)',
                fontSize: 13, color: 'rgba(242,230,200,0.52)',
                fontFamily: SERIF, letterSpacing: '0.14em',
              }}
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!editDate}
              style={{
                flex: 2, padding: '12px 0', borderRadius: 12,
                background: editDate
                  ? 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)'
                  : 'rgba(255,255,255,0.04)',
                border: `1px solid ${editDate ? 'rgba(201,162,74,0.44)' : 'rgba(255,255,255,0.08)'}`,
                boxShadow: editDate ? '0 4px 20px rgba(107,15,18,0.45)' : 'none',
                fontSize: 13, fontWeight: 700,
                color: editDate ? '#F2E6C8' : 'rgba(242,230,200,0.28)',
                fontFamily: SERIF, letterSpacing: '0.22em',
              }}
            >
              登録する
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── No visit registered ──

  if (!visit) {
    return (
      <div className="px-4">
        <div className="mb-4 flex items-center gap-3 px-1">
          <p className="text-[17px] font-bold leading-none" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
            メンテナンス予報
          </p>
          <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, rgba(201,162,74,0.3), transparent)' }} />
        </div>
        <div
          style={{
            borderRadius: 20,
            background: 'linear-gradient(145deg, rgba(22,9,7,0.96), rgba(10,5,4,0.98))',
            border: '1px solid rgba(201,162,74,0.14)',
            padding: '24px 20px',
            textAlign: 'center',
          }}
        >
          <p style={{ fontSize: 9, letterSpacing: '0.28em', color: 'rgba(201,162,74,0.42)', marginBottom: 14 }}>
            MAINTENANCE SCHEDULE
          </p>
          <p style={{ fontFamily: SERIF, fontSize: 14, color: 'rgba(242,230,200,0.56)', lineHeight: 1.8, marginBottom: 22 }}>
            前回来店日を登録して<br />
            次のカット時期をお知らせします。
          </p>
          <button
            type="button"
            onClick={openEditor}
            style={{
              width: '100%', padding: '13px 0', borderRadius: 14,
              background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
              border: '1px solid rgba(201,162,74,0.44)',
              boxShadow: '0 4px 20px rgba(107,15,18,0.45)',
              fontFamily: SERIF, fontSize: 13, fontWeight: 700,
              letterSpacing: '0.22em', color: '#F2E6C8',
            }}
          >
            前回来店日を登録する
          </button>
          {notifSupported && notifPerm === 'default' && (
            <button
              type="button"
              onClick={handleRequestPermission}
              style={{
                width: '100%', marginTop: 10, padding: '10px 0', borderRadius: 10,
                background: 'rgba(201,162,74,0.06)',
                border: '1px solid rgba(201,162,74,0.22)',
                fontSize: 11, letterSpacing: '0.14em',
                color: 'rgba(201,162,74,0.72)', fontFamily: SERIF,
              }}
            >
              カット時期になったら通知する
            </button>
          )}
          {notifSupported && notifPerm === 'granted' && (
            <p style={{ marginTop: 12, fontSize: 10, letterSpacing: '0.14em', color: 'rgba(201,162,74,0.44)' }}>
              通知ON — 来店日を登録すれば3日前にお知らせします
            </p>
          )}
        </div>
      </div>
    )
  }

  // ── Alert state (≤ NOTIFICATION_LEAD_DAYS) ──

  if (isAlert) {
    return (
      <div className="px-4">
        <div className="mb-4 flex items-center gap-3 px-1">
          <p className="text-[17px] font-bold leading-none flex-shrink-0" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
            メンテナンスアラート
          </p>
          <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, rgba(180,40,40,0.38), transparent)' }} />
          {!isQrConfirmed && (
            <button
              type="button"
              onClick={openEditor}
              style={{ fontSize: 10, color: 'rgba(201,162,74,0.54)', letterSpacing: '0.14em', flexShrink: 0 }}
            >
              変更
            </button>
          )}
        </div>
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3 }}
          style={{
            borderRadius: 20,
            background: 'linear-gradient(145deg, #2D0608, #1A0305)',
            border: '1px solid rgba(180,40,40,0.48)',
            boxShadow: '0 12px 40px rgba(120,10,10,0.42), inset 0 1px 0 rgba(255,80,60,0.06)',
            padding: '22px 20px 24px',
          }}
        >
          <p style={{ fontSize: 9, letterSpacing: '0.28em', color: 'rgba(200,60,50,0.68)', marginBottom: 8 }}>
            MAINTENANCE ALERT
          </p>
          <p
            style={{
              fontFamily: SERIF, fontSize: 20, fontWeight: 700,
              color: '#F2E6C8', lineHeight: 1.35, marginBottom: 4,
            }}
          >
            {isOverdue
              ? `男前崩壊中… ${Math.abs(daysLeft!)}日超過`
              : daysLeft === 0
                ? '今日が推奨日です。'
                : `男前崩壊まであと${daysLeft}日。`}
          </p>
          <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.50)', marginBottom: 18 }}>
            メンテナンスカットの時間です。
          </p>
          <div
            style={{
              display: 'flex', gap: 16, marginBottom: 18,
              padding: '12px 14px', borderRadius: 12,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <div>
              <p style={{ fontSize: 8, letterSpacing: '0.2em', color: 'rgba(201,162,74,0.44)', marginBottom: 3 }}>前回来店日</p>
              <p style={{ fontFamily: SERIF, fontSize: 13, color: 'rgba(242,230,200,0.72)' }}>{fmtDate(visit.lastVisitDate)}</p>
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
            style={{
              display: 'block', textAlign: 'center',
              padding: '14px 0', borderRadius: 14,
              background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
              border: '1px solid rgba(201,162,74,0.44)',
              boxShadow: '0 4px 24px rgba(107,15,18,0.55)',
              textDecoration: 'none', fontFamily: SERIF,
              fontSize: 14, fontWeight: 700,
              letterSpacing: '0.22em', color: '#F2E6C8',
            }}
          >
            今すぐ予約する
          </a>
          {notifSupported && notifPerm === 'default' && (
            <button
              type="button"
              onClick={handleRequestPermission}
              style={{
                width: '100%', marginTop: 10, padding: '10px 0', borderRadius: 10,
                background: 'rgba(201,162,74,0.06)',
                border: '1px solid rgba(201,162,74,0.22)',
                fontSize: 11, letterSpacing: '0.14em',
                color: 'rgba(201,162,74,0.72)', fontFamily: SERIF,
              }}
            >
              カット時期になったら通知する
            </button>
          )}
          {notifSupported && notifPerm === 'granted' && (
            <p style={{ marginTop: 10, fontSize: 10, letterSpacing: '0.14em', color: 'rgba(201,162,74,0.44)', textAlign: 'center' }}>
              通知ON — 次回以降も3日前にお知らせします
            </p>
          )}
        </motion.div>
      </div>
    )
  }

  // ── Normal schedule card ──

  return (
    <div className="px-4">
      <div className="mb-4 flex items-center gap-3 px-1">
        <p className="text-[17px] font-bold leading-none flex-shrink-0" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
          メンテナンス予報
        </p>
        <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, rgba(201,162,74,0.3), transparent)' }} />
        {!isQrConfirmed && (
          <button
            type="button"
            onClick={openEditor}
            style={{ fontSize: 10, color: 'rgba(201,162,74,0.54)', letterSpacing: '0.14em', flexShrink: 0 }}
          >
            変更
          </button>
        )}
      </div>

      <div
        style={{
          borderRadius: 20,
          background: 'linear-gradient(145deg, rgba(22,9,7,0.96), rgba(10,5,4,0.98))',
          border: '1px solid rgba(201,162,74,0.18)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
          padding: '20px 20px 22px',
        }}
      >
        {/* Dates row */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 8, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.48)', marginBottom: 5 }}>前回来店日</p>
            <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: '#F2E6C8' }}>{fmtDate(visit.lastVisitDate)}</p>
          </div>
          <div style={{ width: 1, background: 'rgba(201,162,74,0.12)' }} />
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 8, letterSpacing: '0.22em', color: 'rgba(201,162,74,0.48)', marginBottom: 5 }}>次回推奨日</p>
            <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: '#C9A24A' }}>{fmtDate(nextDate!)}</p>
          </div>
        </div>

        {/* Progress bar */}
        <div style={{ marginBottom: notifSupported ? 16 : 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
            <span style={{ fontSize: 8, letterSpacing: '0.18em', color: 'rgba(201,162,74,0.38)' }}>
              {MAINTENANCE_CYCLE_DAYS}DAY CYCLE
            </span>
            <span style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#C9A24A' }}>
              あと{Math.max(0, daysLeft!)}日
            </span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: 'rgba(201,162,74,0.10)', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${elapsed * 100}%`,
                borderRadius: 2,
                background: 'linear-gradient(90deg, rgba(201,162,74,0.45), rgba(201,162,74,0.88))',
                transition: 'width 0.6s ease',
              }}
            />
          </div>
        </div>

        {/* Notification opt-in */}
        {notifSupported && (
          notifPerm === 'granted' ? (
            <p style={{ fontSize: 10, letterSpacing: '0.14em', color: 'rgba(201,162,74,0.44)', textAlign: 'center', marginTop: 12 }}>
              通知ON — 来店3日前にお知らせします
            </p>
          ) : notifPerm === 'denied' ? (
            <p style={{ fontSize: 10, letterSpacing: '0.12em', color: 'rgba(200,80,60,0.52)', textAlign: 'center', marginTop: 12 }}>
              通知が拒否されています（設定から変更できます）
            </p>
          ) : (
            <button
              type="button"
              onClick={handleRequestPermission}
              style={{
                width: '100%', marginTop: 12, padding: '10px 0', borderRadius: 10,
                background: 'rgba(201,162,74,0.06)',
                border: '1px solid rgba(201,162,74,0.22)',
                fontSize: 11, letterSpacing: '0.14em',
                color: 'rgba(201,162,74,0.76)', fontFamily: SERIF,
              }}
            >
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
    <div>
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

        {/* ② メンテナンスカット */}
        <motion.div
          initial={{ opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.12, duration: 0.44, ease: EASE_OUT }}
        >
          <MaintenanceCutSection onTabChange={onTabChange} />
        </motion.div>

        {/* ③ 保有チケット */}
        <motion.div
          initial={{ opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.20, duration: 0.44, ease: EASE_OUT }}
        >
          <TicketWalletSection />
        </motion.div>

        {/* ④ 銀二郎スタイル */}
        <motion.div
          initial={{ opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.27, duration: 0.44, ease: EASE_OUT }}
        >
          <StylesRow styles={styles} onStyleSelect={setSelectedStyle} />
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
  )
}
