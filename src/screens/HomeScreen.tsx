import type { ReactNode } from 'react'
import { Gift, Shirt, CalendarDays, ChevronRight, Scissors } from 'lucide-react'
import type { Member, NavTab } from '../data/brand'
import { MemberPassportCard } from '../components/MemberPassportCard'
import { getGreeting, formatDate, getTodayDate } from '../utils/date'
import { getStoredValue, loadCoupons, GACHA_DATE_KEY, GACHA_RESULT_KEY, TRYON_STYLE_KEY, RESERVE_MENU_KEY, RESERVE_TIME_KEY } from '../utils/storage'

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

const RANK_CARD = {
  ブロンズ: {
    image: '/images/ranks/rank-card-bronze.png',
  },
  シルバー: {
    image: '/images/ranks/rank-card-silver.png',
  },
  ゴールド: {
    image: '/images/ranks/rank-card-gold.png',
  },
  プラチナ: {
    image: '/images/ranks/rank-card-platinum.png',
  },
} as const

function getRankCard(rank: string) {
  return RANK_CARD[rank as keyof typeof RANK_CARD] ?? RANK_CARD.ブロンズ
}

function QuickAction({ icon, label, sublabel, onClick }: { icon: ReactNode; label: string; sublabel: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-2 p-4 rounded-xl w-full transition-opacity active:opacity-60"
      style={{
        background:
          'linear-gradient(145deg, rgba(30,28,24,0.96), rgba(17,17,16,0.98) 58%, rgba(41,14,19,0.48))',
        border: '1px solid rgba(201,162,39,0.22)',
        boxShadow:
          'inset 0 1px 0 rgba(245,240,232,0.04), inset 0 0 16px rgba(201,162,39,0.035)',
      }}
    >
      <div
        className="p-2.5 rounded-lg"
        style={{
          background: 'linear-gradient(145deg, rgba(201,162,39,0.12), rgba(139,26,42,0.06))',
          boxShadow: 'inset 0 0 12px rgba(201,162,39,0.05)',
        }}
      >
        {icon}
      </div>
      <div className="text-center">
        <p className="text-xs font-medium leading-none" style={{ color: '#F5F0E8' }}>
          {label}
        </p>
        <p className="text-[9px] mt-0.5" style={{ color: '#8A8A7A' }}>
          {sublabel}
        </p>
      </div>
    </button>
  )
}

interface Props {
  member: Member
  onTabChange: (tab: NavTab) => void
}

export function HomeScreen({ member, onTabChange }: Props) {
  const firstName = member.name.split(' ')[1] ?? member.name

  const today = getTodayDate()
  const gachaDate = getStoredValue<string>(GACHA_DATE_KEY, '')
  const gachaResult = getStoredValue<string>(GACHA_RESULT_KEY, '')
  const tryonStyle = getStoredValue<string>(TRYON_STYLE_KEY, '')
  const reserveMenu = getStoredValue<string>(RESERVE_MENU_KEY, '')
  const reserveTime = getStoredValue<string>(RESERVE_TIME_KEY, '')
  const activeCoupons = loadCoupons().filter((c) => !c.used)
  const rankCard = getRankCard(member.rank)

  const activities: { label: string; sublabel: string; badge: string }[] = []
  if (gachaDate === today && gachaResult) {
    activities.push({ label: `本日のガチャ：${GACHA_LABELS[gachaResult] ?? gachaResult}`, sublabel: '本日', badge: 'ガチャ' })
  }
  if (tryonStyle) {
    activities.push({ label: `髪型試着：${STYLE_LABELS[tryonStyle] ?? tryonStyle}`, sublabel: '選択中', badge: '試着' })
  }
  if (reserveMenu) {
    const timeLabel = reserveTime ? (TIME_LABELS[reserveTime] ?? reserveTime) : '時間帯未選択'
    activities.push({ label: `予約相談：${MENU_LABELS[reserveMenu] ?? reserveMenu}`, sublabel: timeLabel, badge: '予約' })
  }
  if (activeCoupons.length > 0) {
    activities.push({ label: `保有クーポン：${activeCoupons.length}件`, sublabel: '未使用', badge: 'クーポン' })
  }

  return (
    <div className="py-4 space-y-5">
      {/* Greeting */}
      <div className="px-5">
        <p className="text-sm" style={{ color: '#8A8A7A' }}>
          {getGreeting()}
        </p>
        <p className="text-xl font-bold tracking-wide mt-0.5" style={{ color: '#F5F0E8' }}>
          {firstName} 様
        </p>
      </div>

      {/* Current rank */}
      <section className="px-4">
        <p
          className="text-[10px] tracking-[0.2em] uppercase mb-2.5"
          style={{ color: 'rgba(201,162,39,0.48)' }}
        >
          現在のランク
        </p>
        <div
          className="relative w-full overflow-hidden rounded-xl"
          style={{
            background: 'rgba(5,5,5,0.9)',
            border: '1px solid rgba(201,162,39,0.34)',
            boxShadow:
              '0 12px 30px rgba(0,0,0,0.36), inset 0 1px 0 rgba(245,240,232,0.05), inset 0 0 22px rgba(201,162,39,0.075)',
          }}
        >
          <img
            src={rankCard.image}
            alt="現在のランク"
            className="block h-auto w-full"
          />
        </div>
      </section>

      {/* Passport card */}
      <MemberPassportCard member={member} />

      {/* Next visit banner */}
      {member.nextVisit && (
        <div
          className="mx-4 rounded-xl px-4 py-3 flex items-center justify-between"
          style={{
            background: 'rgba(139,26,42,0.105)',
            border: '1px solid rgba(139,26,42,0.28)',
          }}
        >
          <div className="flex items-center gap-3">
            <Scissors
              size={15}
              strokeWidth={2}
              style={{ color: '#B02035', transform: 'rotate(270deg)' }}
            />
            <div>
              <p className="text-[9px] tracking-widest" style={{ color: 'rgba(176,32,53,0.75)' }}>
                NEXT VISIT
              </p>
              <p className="text-sm font-medium mt-0.5" style={{ color: '#F5F0E8' }}>
                {formatDate(member.nextVisit)}
              </p>
            </div>
          </div>
          <ChevronRight size={15} strokeWidth={2} style={{ color: '#8B1A2A' }} />
        </div>
      )}

      {/* Quick actions */}
      <div className="px-4">
        <p
          className="text-[10px] tracking-[0.2em] uppercase mb-2.5"
          style={{ color: 'rgba(201,162,39,0.45)' }}
        >
          Quick Access
        </p>
        <div className="grid grid-cols-3 gap-3">
          <QuickAction
            icon={<Gift size={20} strokeWidth={1.8} style={{ color: '#C9A227' }} />}
            label="ガチャ"
            sublabel="運試し"
            onClick={() => onTabChange('gacha')}
          />
          <QuickAction
            icon={<Shirt size={20} strokeWidth={1.8} style={{ color: '#C9A227' }} />}
            label="試着"
            sublabel="髪型を選ぶ"
            onClick={() => onTabChange('tryon')}
          />
          <QuickAction
            icon={<CalendarDays size={20} strokeWidth={1.8} style={{ color: '#C9A227' }} />}
            label="予約"
            sublabel="相談する"
            onClick={() => onTabChange('reserve')}
          />
        </div>
      </div>

      {/* Recent activity */}
      <div className="px-4">
        <p
          className="text-[10px] tracking-[0.2em] uppercase mb-2.5"
          style={{ color: 'rgba(201,162,39,0.45)' }}
        >
          Recent Activity
        </p>
        <div className="space-y-2">
          {activities.length > 0 ? activities.map((item, i) => (
            <div
              key={i}
              className="flex items-center justify-between px-4 py-3 rounded-xl"
              style={{ background: '#1A1A1A', border: '1px solid rgba(255,255,255,0.04)' }}
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium" style={{ color: '#F5F0E8' }}>
                  {item.label}
                </p>
                <p className="text-[11px] mt-0.5" style={{ color: '#8A8A7A' }}>
                  {item.sublabel}
                </p>
              </div>
              <span className="text-xs font-semibold ml-2 flex-shrink-0" style={{ color: 'rgba(201,162,39,0.6)' }}>
                {item.badge}
              </span>
            </div>
          )) : (
            <div
              className="px-4 py-3 rounded-xl"
              style={{ background: '#1A1A1A', border: '1px solid rgba(255,255,255,0.04)' }}
            >
              <p className="text-sm" style={{ color: 'rgba(245,240,232,0.22)' }}>
                最近の活動はまだありません
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="h-2" />
    </div>
  )
}
