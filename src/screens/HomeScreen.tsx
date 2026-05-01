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

function QuickAction({ icon, label, sublabel, onClick }: { icon: ReactNode; label: string; sublabel: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-2 p-4 rounded-xl w-full transition-opacity active:opacity-60"
      style={{
        background: '#1A1A1A',
        border: '1px solid rgba(201,162,39,0.13)',
      }}
    >
      <div
        className="p-2.5 rounded-lg"
        style={{ background: 'rgba(201,162,39,0.07)' }}
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
    <div className="py-5 space-y-6">
      {/* Greeting */}
      <div className="px-5">
        <p className="text-sm" style={{ color: '#8A8A7A' }}>
          {getGreeting()}
        </p>
        <p className="text-xl font-bold tracking-wide mt-0.5" style={{ color: '#F5F0E8' }}>
          {firstName} 様
        </p>
      </div>

      {/* Passport card */}
      <MemberPassportCard member={member} />

      {/* Next visit banner */}
      {member.nextVisit && (
        <div
          className="mx-4 rounded-xl px-4 py-3 flex items-center justify-between"
          style={{
            background: 'rgba(139,26,42,0.12)',
            border: '1px solid rgba(139,26,42,0.3)',
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
          className="text-[10px] tracking-[0.2em] uppercase mb-3"
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
          className="text-[10px] tracking-[0.2em] uppercase mb-3"
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
