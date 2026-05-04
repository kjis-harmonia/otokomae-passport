import { useState, type ReactNode } from 'react'
import type { MemberStatus, MemberRank } from '../data/brand'
import { motion } from 'framer-motion'
import { Crown, Gift, User, Scissors, Bell, FileText, ChevronRight, Tag } from 'lucide-react'
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
  const [coupons, setCoupons] = useState(() => loadCoupons())
  const today = getTodayDate()
  const gachaDate = getStoredValue<string>(GACHA_DATE_KEY, '')
  const gachaResult = getStoredValue<string>(GACHA_RESULT_KEY, '')
  const tryonStyle = getStoredValue<string>(TRYON_STYLE_KEY, '')
  const reserveMenu = getStoredValue<string>(RESERVE_MENU_KEY, '')
  const reserveTime = getStoredValue<string>(RESERVE_TIME_KEY, '')
  const nextRankInfo = getNextRankInfo(memberStatus.points)

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
          <div style={{ width: '1px', height: 32, background: 'linear-gradient(180deg, transparent, rgba(201,162,39,0.22), transparent)' }} />
          <div className="min-w-0">
            <p className="text-[9px] tracking-[0.18em] uppercase" style={{ color: 'rgba(201,162,39,0.45)' }}>
              累計ポイント
            </p>
            <p className="text-2xl font-bold leading-none mt-1" style={{ color: '#E8C547' }}>
              {formatPoints(memberStatus.points)}
              <span className="text-sm font-normal ml-0.5" style={{ color: 'rgba(201,162,39,0.5)' }}>pt</span>
            </p>
            <p className="text-[10px] mt-1" style={{ color: 'rgba(245,240,232,0.42)' }}>
              {nextRankInfo.nextRank
                ? `${RANK_LABEL[nextRankInfo.nextRank]}まであと${formatPoints(nextRankInfo.remainingPoints)}pt`
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
                  <p className="text-sm font-bold" style={{ color: '#F5F0E8' }}>{coupon.title}</p>
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
