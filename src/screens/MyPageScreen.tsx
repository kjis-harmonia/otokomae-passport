import { useState, useEffect, useCallback, type ReactNode } from 'react'
import type { MemberStatus, MemberRank } from '../data/brand'
import { motion } from 'framer-motion'
import { Crown, Gift, User, Scissors, Bell, FileText, ChevronRight, Tag, Share2, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import {
  getStoredValue,
  loadCoupons,
  saveCoupons,
  saveMemberStatus,
  GACHA_RESULT_KEY,
  GACHA_DATE_KEY,
  TRYON_STYLE_KEY,
  RESERVE_MENU_KEY,
  RESERVE_TIME_KEY,
} from '../utils/storage'
import { getTodayDate, formatPoints } from '../utils/date'
import { getNextRankInfo, RANK_LABEL } from '../utils/rank'
import { getUserId } from '../utils/userId'
import type { TicketRow } from '../data/ticket'
import { TICKET_TYPE_LABELS, TICKET_TYPE_COLORS } from '../data/ticket'
import {
  getUserTickets,
  initiateTransfer,
  cancelTransfer,
  getActiveTicket,
  setActiveTicket,
  clearActiveTicket,
} from '../utils/ticketStore'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

const GACHA_LABELS: Record<string, string> = {
  discount: '100円OFF',
  stamp: 'スタンプ +1',
  exp: '男前ランク経験値 +1',
}

const STYLE_LABELS: Record<string, string> = {
  short: '男前ショート',
  fade: 'フェードスタイル',
  shichisan: '七三クラシック',
  perm: 'パーマ風スタイル',
}

const MENU_LABELS: Record<string, string> = {
  cut: 'カット',
  'cut-shave': 'カット＋シェービング',
  'cut-color': 'カット＋カラー',
}

const TIME_LABELS: Record<string, string> = {
  morning: '午前',
  noon: '昼',
  evening: '夕方',
}

const RANK_EN: Record<MemberRank, string> = {
  ブロンズ: 'BRONZE',
  シルバー: 'SILVER',
  ゴールド: 'GOLD',
  プラチナ: 'PLATINUM',
}

const RANK_COLOR: Record<MemberRank, string> = {
  ブロンズ: '#B8860B',
  シルバー: '#8A9BA8',
  ゴールド: '#C9A227',
  プラチナ: '#C8C8C8',
}

function ActivityCard({
  icon,
  title,
  value,
  placeholder,
}: {
  icon: ReactNode
  title: string
  value: string | null
  placeholder: string
}) {
  const hasValue = value !== null
  return (
    <div
      className="flex items-center gap-3 px-4 py-3.5 rounded-xl relative overflow-hidden"
      style={{
        background: hasValue
          ? 'linear-gradient(135deg, rgba(29,26,18,0.98) 0%, rgba(13,13,12,0.98) 58%, rgba(44,10,15,0.78) 100%)'
          : 'linear-gradient(135deg, rgba(24,24,22,0.96) 0%, rgba(12,12,11,0.98) 100%)',
        border: hasValue
          ? '1px solid rgba(201,162,39,0.28)'
          : '1px solid rgba(201,162,39,0.1)',
        boxShadow: hasValue
          ? 'inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 24px rgba(0,0,0,0.25)'
          : 'inset 0 1px 0 rgba(255,255,255,0.03)',
      }}
    >
      <div
        className="flex-shrink-0 p-2 rounded-lg"
        style={{
          background: hasValue ? 'rgba(201,162,39,0.12)' : 'rgba(255,255,255,0.03)',
          border: hasValue ? '1px solid rgba(201,162,39,0.2)' : '1px solid rgba(255,255,255,0.04)',
        }}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p
          className="text-[10px] tracking-[0.15em] uppercase mb-0.5"
          style={{ color: 'rgba(201,162,39,0.4)' }}
        >
          {title}
        </p>
        {hasValue ? (
          <p className="text-sm font-medium" style={{ color: '#F5F0E8' }}>{value}</p>
        ) : (
          <p className="text-sm" style={{ color: 'rgba(245,240,232,0.34)' }}>{placeholder}</p>
        )}
      </div>
    </div>
  )
}

function ListRow({ icon, label, sublabel }: { icon: ReactNode; label: string; sublabel?: string }) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-3.5 rounded-xl"
      style={{
        background: 'linear-gradient(135deg, rgba(24,24,22,0.98) 0%, rgba(12,12,11,0.98) 62%, rgba(35,11,15,0.72) 100%)',
        border: '1px solid rgba(201,162,39,0.13)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.035)',
      }}
    >
      <div
        className="flex-shrink-0 p-2 rounded-lg"
        style={{
          background: 'rgba(201,162,39,0.08)',
          border: '1px solid rgba(201,162,39,0.16)',
        }}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium" style={{ color: '#F5F0E8' }}>{label}</p>
        {sublabel !== undefined && (
          <p className="text-[11px] mt-0.5" style={{ color: '#8A8A7A' }}>{sublabel}</p>
        )}
      </div>
      <ChevronRight size={15} strokeWidth={1.8} style={{ color: 'rgba(255,255,255,0.12)' }} />
    </div>
  )
}

interface Props {
  memberStatus: MemberStatus
  onMemberStatusChange: (next: MemberStatus) => void
}

export function MyPageScreen({ memberStatus, onMemberStatusChange }: Props) {
  const [rewardUsedMessage, setRewardUsedMessage] = useState<string | null>(null)
  const [couponUsedMessage, setCouponUsedMessage] = useState<string | null>(null)
  const [coupons, setCoupons] = useState(() => {
    const stored = loadCoupons()
    const PRESET_IDS = ['preset-discount-300', 'preset-cut-1000']
    const missing = PRESET_IDS.filter(pid => !stored.some(c => c.id === pid))
    if (missing.length === 0) return stored
    const today = getTodayDate()
    const presets = [
      { id: 'preset-discount-300', title: '割引券',  description: '次回ご来店時にご利用いただけます', amount: 300,  createdAt: today, used: false },
      { id: 'preset-cut-1000',     title: 'カット券', description: '次回カット時にご利用いただけます',  amount: 1000, createdAt: today, used: false },
    ].filter(p => missing.includes(p.id))
    const next = [...presets, ...stored]
    saveCoupons(next)
    return next
  })
  const [tickets, setTickets] = useState<TicketRow[]>([])
  const [ticketsLoading, setTicketsLoading] = useState(true)

  // Ticket detail / transfer state
  const [selectedTicket, setSelectedTicket] = useState<TicketRow | null>(null)
  const [transferToken, setTransferToken]   = useState<string | null>(null)
  const [showTransferQr, setShowTransferQr] = useState(false)
  const [transferring, setTransferring]     = useState(false)
  const [copied, setCopied]                 = useState(false)

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

  useEffect(() => { fetchTickets() }, [fetchTickets])

  // ── Transfer handlers ────────────────────────────────────────────────────────

  async function handleInitiateTransfer(ticket: TicketRow) {
    if (ticket.used || ticket.pending_transfer) return
    // 期限切れチェック
    if (ticket.expires_at && new Date(ticket.expires_at) < new Date()) {
      alert('期限が切れているため渡せません。')
      return
    }
    setTransferring(true)
    try {
      const token = await initiateTransfer(ticket.id, userId)
      setTransferToken(token)
      setShowTransferQr(true)
      // 選択中チケットを譲渡中状態に更新
      setSelectedTicket(prev => prev ? { ...prev, pending_transfer: true, transfer_token: token } : prev)
      setTickets(prev => prev.map(t => t.id === ticket.id ? { ...t, pending_transfer: true, transfer_token: token } : t))
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
      setTickets(prev => prev.map(t => t.id === ticket.id ? { ...t, pending_transfer: false, transfer_token: null } : t))
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
    } catch {
      // ユーザーがシェアをキャンセルした場合など
    }
  }
  const today = getTodayDate()
  const gachaDate = getStoredValue<string>(GACHA_DATE_KEY, '')
  const gachaResult = getStoredValue<string>(GACHA_RESULT_KEY, '')
  const tryonStyle = getStoredValue<string>(TRYON_STYLE_KEY, '')
  const reserveMenu = getStoredValue<string>(RESERVE_MENU_KEY, '')
  const reserveTime = getStoredValue<string>(RESERVE_TIME_KEY, '')
  const totalPoints = typeof memberStatus.points === 'number' ? memberStatus.points : 4250
  const nextRankInfo = getNextRankInfo(totalPoints)

  const gachaValue =
    gachaDate === today && gachaResult
      ? GACHA_LABELS[gachaResult] || gachaResult
      : null
  const tryonValue = tryonStyle ? STYLE_LABELS[tryonStyle] || tryonStyle : null
  const reserveValue = reserveMenu
    ? `${MENU_LABELS[reserveMenu] || reserveMenu} ・ ${TIME_LABELS[reserveTime] || '時間帯未選択'}`
    : null

  const activeCoupons = coupons.filter((c) => !c.used)

  const gachaHistorySublabel =
    gachaDate === today && gachaResult
      ? `本日 ・ ${GACHA_LABELS[gachaResult] || gachaResult}`
      : '履歴なし'

  function handleUseReward() {
    if (!window.confirm('特典を使用してスタンプをリセットしますか？')) return

    const nextStatus = { ...memberStatus, stampCount: 0 }
    onMemberStatusChange(nextStatus)
    saveMemberStatus(nextStatus)
    setRewardUsedMessage('特典を使用しました。次の男前パスポートを育てましょう。')
  }

  function handleSetMaxStampsForDev() {
    const nextStatus = { ...memberStatus, stampCount: 10 }
    onMemberStatusChange(nextStatus)
    saveMemberStatus(nextStatus)
    setRewardUsedMessage(null)
  }

  function handleUseCoupon(couponId: string) {
    if (!window.confirm('このクーポンを使用済みにしますか？')) return

    const storedCoupons = loadCoupons()
    const nextCoupons = storedCoupons.map((coupon) =>
      coupon.id === couponId ? { ...coupon, used: true } : coupon,
    )
    saveCoupons(nextCoupons)
    setCoupons(nextCoupons)
    setCouponUsedMessage('クーポンを使用済みにしました')
  }

  return (
    <div className="py-5 space-y-6">
      {/* Section header */}
      <div className="px-5">
        <p className="text-[10px] tracking-[0.2em] uppercase" style={{ color: 'rgba(201,162,39,0.45)' }}>
          My Page
        </p>
        <p className="text-xl font-bold tracking-wide mt-0.5" style={{ color: '#F5F0E8' }}>
          マイページ
        </p>
        <p className="text-sm mt-0.5" style={{ color: '#8A8A7A' }}>
          あなたの男前履歴。
        </p>
      </div>

      {/* Member summary card */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
        className="mx-4 rounded-2xl overflow-hidden"
        style={{
          background:
            'radial-gradient(circle at 88% 12%, rgba(176,32,53,0.18) 0%, transparent 34%), linear-gradient(135deg, #241F15 0%, #0D0D0C 54%, #080807 100%)',
          border: '1px solid rgba(201,162,39,0.36)',
          boxShadow: '0 18px 44px rgba(0,0,0,0.72), inset 0 1px 0 rgba(245,240,232,0.08), inset 0 -1px 0 rgba(176,32,53,0.18)',
        }}
      >
        {/* Rank badge */}
        <div className="flex items-center gap-2 px-5 pt-4 pb-1">
          <Crown size={12} strokeWidth={2} style={{ color: RANK_COLOR[memberStatus.rank] }} />
          <span
            className="text-[11px] font-semibold tracking-wider"
            style={{ color: RANK_COLOR[memberStatus.rank] }}
          >
            {RANK_EN[memberStatus.rank]}
          </span>
          <span className="text-[10px]" style={{ color: 'rgba(245,240,232,0.3)' }}>会員</span>
        </div>

        {/* Name */}
        <div className="px-5 py-2">
          <p className="text-2xl font-bold tracking-wide" style={{ color: '#F5F0E8' }}>
            {memberStatus.memberName}
          </p>
          <p className="text-[11px] tracking-[0.22em] mt-0.5" style={{ color: 'rgba(245,240,232,0.3)' }}>
            {RANK_EN[memberStatus.rank]} MEMBER
          </p>
        </div>

        {/* Divider */}
        <div
          className="mx-5"
          style={{
            height: '1px',
            background: 'linear-gradient(90deg, transparent, rgba(201,162,39,0.34), rgba(176,32,53,0.24), transparent)',
          }}
        />

        {/* Stats */}
        <div className="flex flex-wrap items-center gap-4 px-5 py-3">
          <div>
            <p className="text-[9px] tracking-[0.18em] uppercase" style={{ color: 'rgba(201,162,39,0.45)' }}>
              来店回数
            </p>
            <p className="text-2xl font-bold leading-none mt-1" style={{ color: '#F5F0E8' }}>
              {memberStatus.visitCount}
              <span className="text-sm font-normal ml-0.5" style={{ color: 'rgba(245,240,232,0.4)' }}>回</span>
            </p>
          </div>
          <div style={{ width: '1px', height: 32, background: 'linear-gradient(180deg, transparent, rgba(201,162,39,0.22), transparent)' }} />
          <div>
            <p className="text-[9px] tracking-[0.18em] uppercase" style={{ color: 'rgba(201,162,39,0.45)' }}>
              スタンプ
            </p>
            <p className="text-2xl font-bold leading-none mt-1" style={{ color: '#C9A227' }}>
              {memberStatus.stampCount}
              <span className="text-base font-normal" style={{ color: 'rgba(201,162,39,0.5)' }}>/10</span>
            </p>
          </div>
        </div>

        <div
          className="mx-5 mb-4 rounded-xl px-4 py-3"
          style={{
            background:
              'linear-gradient(135deg, rgba(201,162,39,0.105), rgba(10,10,9,0.78) 58%, rgba(139,26,42,0.12))',
            border: '1px solid rgba(201,162,39,0.22)',
            boxShadow: 'inset 0 1px 0 rgba(245,240,232,0.045), inset 0 0 18px rgba(201,162,39,0.045)',
          }}
        >
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-[10px] tracking-[0.18em] uppercase" style={{ color: 'rgba(201,162,39,0.55)' }}>
                累計ポイント
              </p>
              <p className="mt-1 text-xl font-bold leading-none" style={{ color: '#E8C547' }}>
                {formatPoints(totalPoints)}
                <span className="ml-1 text-sm font-normal" style={{ color: 'rgba(201,162,39,0.62)' }}>
                  pt
                </span>
              </p>
            </div>
            <p className="text-right text-[11px] font-medium" style={{ color: 'rgba(245,240,232,0.68)' }}>
              {nextRankInfo.nextRank
                ? `${RANK_LABEL[nextRankInfo.nextRank]}まであと ${formatPoints(nextRankInfo.remainingPoints)}pt`
                : '最高ランク到達'}
            </p>
          </div>
        </div>

        {/* Stamp dots */}
        <div className="px-5 pb-4">
          <div className="flex gap-1.5">
            {Array.from({ length: 10 }, (_, i) => (
              <div
                key={i}
                className="rounded-full"
                style={{
                  width: 8,
                  height: 8,
                  background: i < memberStatus.stampCount ? 'linear-gradient(135deg, #E0C46A 0%, #9E7820 100%)' : 'rgba(255,255,255,0.07)',
                  border: i < memberStatus.stampCount ? '1px solid rgba(245,240,232,0.18)' : '1px solid rgba(201,162,39,0.08)',
                  boxShadow: i < memberStatus.stampCount ? '0 0 10px rgba(201,162,39,0.22)' : 'none',
                }}
              />
            ))}
          </div>
          {memberStatus.stampCount >= 10 && (
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <div
                className="px-2 py-0.5 rounded-full"
                style={{
                  background: 'rgba(201,162,39,0.12)',
                  border: '1px solid rgba(201,162,39,0.35)',
                }}
              >
                <p className="text-[9px] font-bold tracking-widest" style={{ color: '#C9A227' }}>
                  特典獲得可能
                </p>
              </div>
              <button
                type="button"
                onClick={handleUseReward}
                className="px-3 py-1.5 rounded-lg text-[10px] font-bold tracking-wider transition-opacity active:opacity-70"
                style={{
                  background: 'rgba(139,26,42,0.18)',
                  border: '1px solid rgba(176,32,53,0.45)',
                  color: '#F5F0E8',
                }}
              >
                特典を使用する
              </button>
            </div>
          )}
          {rewardUsedMessage && (
            <p className="text-[11px] mt-2" style={{ color: 'rgba(201,162,39,0.8)' }}>
              {rewardUsedMessage}
            </p>
          )}
          <button
            type="button"
            onClick={handleSetMaxStampsForDev}
            className="mt-3 text-[10px] underline underline-offset-2 transition-opacity active:opacity-70"
            style={{ color: 'rgba(245,240,232,0.28)' }}
          >
            開発用：スタンプを10個にする
          </button>
        </div>
      </motion.div>

      {/* Recent activity */}
      <div className="px-4">
        <p
          className="text-[10px] tracking-[0.2em] uppercase mb-3"
          style={{ color: 'rgba(201,162,39,0.45)' }}
        >
          最近のアクティビティ
        </p>
        <div className="space-y-2">
          <ActivityCard
            icon={
              <Gift
                size={16}
                strokeWidth={1.8}
                style={{ color: gachaValue ? '#C9A227' : 'rgba(245,240,232,0.28)' }}
              />
            }
            title="本日のガチャ"
            value={gachaValue}
            placeholder="本日のガチャはまだです"
          />
          <ActivityCard
            icon={
              <User
                size={16}
                strokeWidth={1.8}
                style={{ color: tryonValue ? '#C9A227' : 'rgba(245,240,232,0.28)' }}
              />
            }
            title="試着中スタイル"
            value={tryonValue}
            placeholder="まだ髪型は選択されていません"
          />
          <ActivityCard
            icon={
              <Scissors
                size={16}
                strokeWidth={1.8}
                style={{
                  color: reserveValue ? '#C9A227' : 'rgba(245,240,232,0.28)',
                  transform: 'rotate(270deg)',
                }}
              />
            }
            title="予約相談内容"
            value={reserveValue}
            placeholder="予約相談はまだありません"
          />
        </div>
      </div>

      {/* Coupon section */}
      <div className="px-4">
        <p
          className="text-[10px] tracking-[0.2em] uppercase mb-3"
          style={{ color: 'rgba(201,162,39,0.45)' }}
        >
          保有クーポン
        </p>
        {activeCoupons.length === 0 ? (
          <div
            className="px-4 py-3.5 rounded-xl"
            style={{
              background: 'linear-gradient(135deg, rgba(24,24,22,0.98) 0%, rgba(12,12,11,0.98) 100%)',
              border: '1px solid rgba(201,162,39,0.1)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
            }}
          >
            <p className="text-sm" style={{ color: 'rgba(245,240,232,0.34)' }}>
              保有クーポンはまだありません
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {activeCoupons.map((coupon) => (
              <div
                key={coupon.id}
                className="flex items-center gap-3 px-4 py-3.5 rounded-xl"
                style={{
                  background:
                    'radial-gradient(circle at 92% 16%, rgba(176,32,53,0.16) 0%, transparent 30%), linear-gradient(135deg, rgba(32,28,19,0.98) 0%, rgba(12,12,11,0.98) 62%, rgba(27,8,11,0.88) 100%)',
                  border: '1px solid rgba(201,162,39,0.3)',
                  boxShadow: '0 12px 28px rgba(0,0,0,0.28), inset 0 1px 0 rgba(245,240,232,0.055)',
                }}
              >
                <div
                  className="flex-shrink-0 p-2 rounded-lg"
                  style={{
                    background: 'rgba(139,26,42,0.16)',
                    border: '1px solid rgba(201,162,39,0.18)',
                  }}
                >
                  <Tag size={16} strokeWidth={1.8} style={{ color: '#B02035' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <p className="text-sm font-bold" style={{ color: '#F5F0E8' }}>{coupon.title}</p>
                    {coupon.amount != null && (
                      <p className="text-sm font-bold" style={{ color: '#C9A24A', fontFamily: SERIF }}>¥{coupon.amount.toLocaleString()}</p>
                    )}
                  </div>
                  <p className="text-[11px] mt-0.5" style={{ color: '#8A8A7A' }}>{coupon.description}</p>
                  <p className="text-[10px] mt-0.5" style={{ color: 'rgba(201,162,39,0.45)' }}>
                    取得日 {coupon.createdAt}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleUseCoupon(coupon.id)}
                  className="flex-shrink-0 px-3 py-1.5 rounded-lg text-[10px] font-bold tracking-wider transition-opacity active:opacity-70"
                  style={{
                    background: 'rgba(139,26,42,0.18)',
                    border: '1px solid rgba(176,32,53,0.45)',
                    color: '#F5F0E8',
                  }}
                >
                  使用する
                </button>
              </div>
            ))}
          </div>
        )}
        {couponUsedMessage && (
          <p className="text-[11px] mt-2" style={{ color: 'rgba(201,162,39,0.8)' }}>
            {couponUsedMessage}
          </p>
        )}
      </div>

      {/* Staff-issued tickets */}
      <div className="px-4">
        <p className="text-[10px] tracking-[0.2em] uppercase mb-3" style={{ color: 'rgba(201,162,39,0.45)' }}>
          スタッフ発行チケット
        </p>
        {ticketsLoading ? (
          <div className="px-4 py-3.5 rounded-xl" style={{ background: 'rgba(24,24,22,0.98)', border: '1px solid rgba(74,127,201,0.1)' }}>
            <p className="text-sm" style={{ color: 'rgba(245,240,232,0.28)' }}>読込中…</p>
          </div>
        ) : tickets.filter(t => !t.used).length === 0 ? (
          <div className="px-4 py-3.5 rounded-xl" style={{ background: 'rgba(24,24,22,0.98)', border: '1px solid rgba(74,127,201,0.1)' }}>
            <p className="text-sm" style={{ color: 'rgba(245,240,232,0.34)' }}>有効なチケットはありません</p>
            <p className="text-[10px] mt-1" style={{ color: 'rgba(245,240,232,0.2)' }}>スタッフが来店時にチケットを発行します</p>
          </div>
        ) : (
          <div className="space-y-2">
            {tickets.filter(t => !t.used).map((ticket) => {
              const tc = TICKET_TYPE_COLORS[ticket.type]
              const isPending = !!ticket.pending_transfer
              return (
                <button
                  key={ticket.id}
                  type="button"
                  onClick={() => setSelectedTicket(ticket)}
                  className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl text-left"
                  style={{
                    background: `linear-gradient(135deg, rgba(12,12,11,0.98) 0%, ${tc.bg} 100%)`,
                    border: `1px solid ${isPending ? 'rgba(255,180,0,0.4)' : tc.border}`,
                    boxShadow: '0 8px 20px rgba(0,0,0,0.22)',
                    cursor: 'pointer',
                  }}
                >
                  <div className="flex-shrink-0 px-2 py-1 rounded-lg" style={{ background: tc.bg, border: `1px solid ${tc.border}` }}>
                    <p className="text-[10px] font-bold tracking-wider" style={{ color: tc.text }}>{TICKET_TYPE_LABELS[ticket.type]}</p>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-bold" style={{ color: '#F5F0E8' }}>{ticket.title}</p>
                      {isPending && (
                        <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 99, background: 'rgba(255,180,0,0.15)', border: '1px solid rgba(255,180,0,0.4)', color: '#FFB400', fontWeight: 700 }}>
                          渡し中
                        </span>
                      )}
                    </div>
                    {ticket.amount > 0 && <p className="text-[13px] font-bold mt-0.5" style={{ color: '#C9A227' }}>¥{ticket.amount.toLocaleString()}</p>}
                    <p className="text-[10px] mt-0.5" style={{ color: 'rgba(245,240,232,0.32)' }}>
                      発行日 {new Date(ticket.created_at).toLocaleDateString('ja-JP')}
                      {ticket.expires_at && ` ・ 期限 ${new Date(ticket.expires_at).toLocaleDateString('ja-JP')}`}
                    </p>
                  </div>
                  <ChevronRight size={15} strokeWidth={1.8} style={{ color: 'rgba(255,255,255,0.18)', flexShrink: 0 }} />
                </button>
              )
            })}
          </div>
        )}
        {tickets.filter(t => t.used).length > 0 && (
          <p className="text-[10px] mt-2" style={{ color: 'rgba(245,240,232,0.22)' }}>
            使用済み {tickets.filter(t => t.used).length}件
          </p>
        )}
      </div>

      {/* ── Ticket detail modal ── */}
      {selectedTicket && (() => {
        const t = selectedTicket
        const tc = TICKET_TYPE_COLORS[t.type]
        const isPending = !!t.pending_transfer
        const isExpired = !!t.expires_at && new Date(t.expires_at) < new Date()
        const canTransfer = !t.used && !isExpired
        const transferUrl = transferToken
          ? `${window.location.origin}${window.location.pathname}?transfer=${transferToken}`
          : t.transfer_token
            ? `${window.location.origin}${window.location.pathname}?transfer=${t.transfer_token}`
            : null
        return (
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.82)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: '0 0 0' }}
            onClick={() => { setSelectedTicket(null); setShowTransferQr(false); setTransferToken(null) }}
          >
            <motion.div
              initial={{ opacity: 0, y: 60 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 60 }}
              transition={{ duration: 0.26 }}
              onClick={e => e.stopPropagation()}
              style={{
                width: '100%', maxWidth: 480,
                borderRadius: '24px 24px 0 0',
                background: 'linear-gradient(180deg, #160a07 0%, #0a0504 100%)',
                border: '1px solid rgba(201,162,74,0.22)',
                borderBottom: 'none',
                padding: '20px 20px 36px',
                maxHeight: '90dvh', overflowY: 'auto',
              }}
            >
              {/* Handle bar */}
              <div style={{ width: 40, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.12)', margin: '0 auto 20px' }} />

              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
                <div>
                  <span style={{ display: 'inline-block', fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: tc.bg, border: `1px solid ${tc.border}`, color: tc.text, marginBottom: 6 }}>
                    {TICKET_TYPE_LABELS[t.type]}
                  </span>
                  <p style={{ fontSize: 20, fontWeight: 700, color: '#F2E6C8', fontFamily: SERIF, lineHeight: 1.3 }}>{t.title}</p>
                  {t.amount > 0 && <p style={{ fontSize: 18, fontWeight: 700, color: '#C9A24A', fontFamily: SERIF, marginTop: 4 }}>¥{t.amount.toLocaleString()}</p>}
                </div>
                <button type="button" onClick={() => { setSelectedTicket(null); setShowTransferQr(false); setTransferToken(null) }}
                  style={{ padding: 8, borderRadius: 99, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(242,230,200,0.5)', cursor: 'pointer' }}>
                  <X size={16} />
                </button>
              </div>

              {/* Info */}
              <div style={{ borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', padding: '12px 14px', marginBottom: 16 }}>
                {[
                  { label: '発行日', value: new Date(t.created_at).toLocaleDateString('ja-JP') },
                  t.expires_at ? { label: '有効期限', value: new Date(t.expires_at).toLocaleDateString('ja-JP') } : null,
                  t.memo ? { label: 'メモ', value: t.memo } : null,
                  isPending ? { label: '状態', value: '渡し手続き中' } : null,
                ].filter(Boolean).map((row, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: i < 2 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                    <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.38)' }}>{row!.label}</p>
                    <p style={{ fontSize: 11, color: isExpired && row!.label === '有効期限' ? '#E06060' : isPending && row!.label === '状態' ? '#FFB400' : '#F2E6C8', fontWeight: 600 }}>{row!.value}</p>
                  </div>
                ))}
              </div>

              {/* 使用ルール */}
              <p style={{ fontSize: 10, color: 'rgba(242,230,200,0.28)', lineHeight: 1.6, marginBottom: 16 }}>
                ※ 1回のお会計で使えるチケットは1枚です。
              </p>

              {/* Transfer QR display (inside detail modal) */}
              {showTransferQr && transferUrl && (
                <div style={{ borderRadius: 16, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,180,0,0.22)', padding: '16px', marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
                    <div style={{ padding: 12, background: '#FFFFFF', borderRadius: 12 }}>
                      <QRCodeSVG value={transferUrl} size={180} level="M" />
                    </div>
                  </div>
                  <p style={{ fontSize: 11, color: 'rgba(242,230,200,0.42)', textAlign: 'center', lineHeight: 1.7, marginBottom: 12 }}>
                    QRを読み取ってもらうか、リンクを送ってください。{'\n'}
                    受け取ったらあなたの一覧から消えます。
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
                    onClick={() => handleCancelTransfer(t)}
                    style={{ width: '100%', padding: '11px 0', borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(242,230,200,0.46)', fontFamily: SERIF, fontSize: 12, letterSpacing: '0.14em', cursor: 'pointer' }}
                  >
                    取りやめる
                  </button>
                </div>
              )}

              {/* Pending — show QR again / cancel */}
              {isPending && !showTransferQr && transferUrl && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                  <button type="button" onClick={() => setShowTransferQr(true)}
                    style={{ width: '100%', padding: '13px 0', borderRadius: 14, background: 'rgba(255,180,0,0.1)', border: '1px solid rgba(255,180,0,0.3)', color: '#FFB400', fontFamily: SERIF, fontSize: 12, fontWeight: 700, letterSpacing: '0.14em', cursor: 'pointer' }}>
                    QRを再表示する
                  </button>
                  <button type="button" onClick={() => handleCancelTransfer(t)}
                    style={{ width: '100%', padding: '13px 0', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(242,230,200,0.46)', fontFamily: SERIF, fontSize: 12, letterSpacing: '0.14em', cursor: 'pointer' }}>
                    取りやめる
                  </button>
                </div>
              )}

              {/* Transfer button (only when not pending, not expired, not used) */}
              {canTransfer && !isPending && !showTransferQr && (
                <button
                  type="button"
                  onClick={() => handleInitiateTransfer(t)}
                  disabled={transferring}
                  style={{ width: '100%', padding: '14px 0', borderRadius: 14, background: transferring ? 'rgba(255,255,255,0.04)' : 'rgba(255,180,0,0.08)', border: `1px solid ${transferring ? 'rgba(255,255,255,0.08)' : 'rgba(255,180,0,0.36)'}`, color: transferring ? 'rgba(242,230,200,0.28)' : '#FFB400', fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.16em', cursor: transferring ? 'default' : 'pointer' }}
                >
                  {transferring ? '処理中…' : '家族・友達に渡す'}
                </button>
              )}

              {isExpired && (
                <p style={{ fontSize: 11, color: '#E06060', textAlign: 'center', marginTop: 8 }}>期限が切れているため渡せません</p>
              )}
            </motion.div>
          </div>
        )
      })()}

      {/* History section */}
      <div className="px-4">
        <p
          className="text-[10px] tracking-[0.2em] uppercase mb-3"
          style={{ color: 'rgba(201,162,39,0.45)' }}
        >
          履歴
        </p>
        <div className="space-y-2">
          <ListRow
            icon={
              <Scissors
                size={17}
                strokeWidth={1.7}
                style={{ color: 'rgba(201,162,39,0.55)', transform: 'rotate(270deg)' }}
              />
            }
            label="来店履歴"
            sublabel="直近3回の記録"
          />
          <ListRow
            icon={<Tag size={17} strokeWidth={1.7} style={{ color: 'rgba(201,162,39,0.55)' }} />}
            label="クーポン利用履歴"
            sublabel="利用済みクーポン"
          />
          <ListRow
            icon={<Gift size={17} strokeWidth={1.7} style={{ color: 'rgba(201,162,39,0.55)' }} />}
            label="ガチャ履歴"
            sublabel={gachaHistorySublabel}
          />
        </div>
      </div>

      {/* Settings section */}
      <div className="px-4">
        <p
          className="text-[10px] tracking-[0.2em] uppercase mb-3"
          style={{ color: 'rgba(201,162,39,0.45)' }}
        >
          設定
        </p>
        <div className="space-y-2">
          <ListRow
            icon={<Bell size={17} strokeWidth={1.7} style={{ color: 'rgba(201,162,39,0.55)' }} />}
            label="通知設定"
            sublabel="新着情報をお知らせします"
          />
          <ListRow
            icon={<User size={17} strokeWidth={1.7} style={{ color: 'rgba(201,162,39,0.55)' }} />}
            label="プロフィール編集"
            sublabel="会員情報を管理"
          />
          <ListRow
            icon={<FileText size={17} strokeWidth={1.7} style={{ color: 'rgba(201,162,39,0.55)' }} />}
            label="利用規約"
            sublabel="サービス利用について"
          />
        </div>
      </div>

      <div className="px-4">
        <button
          type="button"
          className="w-full py-3.5 rounded-xl font-semibold tracking-widest text-sm transition-opacity active:opacity-70"
          style={{
            background: 'linear-gradient(135deg, #8B1A2A 0%, #B02035 100%)',
            color: '#F5F0E8',
            border: '1px solid rgba(176,32,53,0.45)',
          }}
        >
          男前ランクを確認する
        </button>
      </div>

      <div className="px-5 pb-1">
        <p className="text-[10px] text-center" style={{ color: 'rgba(138,138,122,0.4)' }}>
          ※ 会員情報の本格連携は近日公開予定です
        </p>
      </div>

      <div className="h-2" />
    </div>
  )
}
