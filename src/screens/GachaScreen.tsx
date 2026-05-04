import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Gift, Star, Tag, Trophy, Sparkles } from 'lucide-react'
import type { MemberStatus } from '../data/brand'
import { getStoredValue, setStoredValue, saveMemberStatus, loadCoupons, saveCoupons, GACHA_DATE_KEY, GACHA_RESULT_KEY } from '../utils/storage'
import { getTodayDate } from '../utils/date'
import { getRankByPoints, getSafeRank, RANK_LABEL } from '../utils/rank'

interface GachaPrize {
  id: string
  label: string
  sublabel: string
  accent: string
}

const PRIZES: GachaPrize[] = [
  { id: 'discount', label: '100円OFF', sublabel: '次回来店時に使用可能', accent: '#8B1A2A' },
  { id: 'stamp', label: 'スタンプ +1', sublabel: 'スタンプカードに押印', accent: '#C9A227' },
  { id: 'exp', label: '男前ランク経験値 +1', sublabel: 'ランクアップへ前進', accent: '#4A8A4A' },
]

function PrizeIcon({ id, size }: { id: string; size: number }) {
  if (id === 'discount') return <Tag size={size} strokeWidth={1.8} style={{ color: '#8B1A2A' }} />
  if (id === 'stamp') return <Star size={size} strokeWidth={1.8} style={{ color: '#C9A227' }} />
  return <Trophy size={size} strokeWidth={1.8} style={{ color: '#4A8A4A' }} />
}

interface Props {
  memberStatus: MemberStatus
  onMemberStatusChange: (next: MemberStatus) => void
}

export function GachaScreen({ memberStatus, onMemberStatusChange }: Props) {
  const today = getTodayDate()
  const hasPlayedToday = getStoredValue<string>(GACHA_DATE_KEY, '') === today
  const savedId = getStoredValue<string>(GACHA_RESULT_KEY, '')
  const initial = hasPlayedToday ? (PRIZES.find((p) => p.id === savedId) ?? null) : null

  const [result, setResult] = useState<GachaPrize | null>(initial)
  const [played, setPlayed] = useState(hasPlayedToday)
  const [isSpinning, setIsSpinning] = useState(false)
  const [justPlayed, setJustPlayed] = useState(false)
  const [rankUpMessage, setRankUpMessage] = useState<string | null>(null)
  const [stampFullMessage, setStampFullMessage] = useState<string | null>(null)

  function handleSpin() {
    if (played || isSpinning) return
    setIsSpinning(true)
    setTimeout(() => {
      const prize = PRIZES[Math.floor(Math.random() * PRIZES.length)]
      setStoredValue(GACHA_DATE_KEY, today)
      setStoredValue(GACHA_RESULT_KEY, prize.id)
      setResult(prize)
      setPlayed(true)
      setIsSpinning(false)
      setJustPlayed(true)

      const nextPoints = memberStatus.points + 10
      const computedRank = getRankByPoints(nextPoints)
      const nextRank = getSafeRank(memberStatus.rank, computedRank)
      let nextStatus: MemberStatus = { ...memberStatus, points: nextPoints, rank: nextRank }

      if (prize.id === 'discount') {
        const couponId = `coupon-100off-${today}`
        const existing = loadCoupons()
        if (!existing.some((c) => c.id === couponId)) {
          saveCoupons([...existing, {
            id: couponId,
            title: '100円OFF',
            description: '次回来店時に使える100円OFFクーポン',
            createdAt: today,
            used: false,
          }])
        }
      } else if (prize.id === 'stamp') {
        if (memberStatus.stampCount >= 10) {
          setStampFullMessage('スタンプはすでに満了です')
        } else {
          const nextStamp = memberStatus.stampCount + 1
          nextStatus = { ...nextStatus, stampCount: nextStamp }
          if (nextStamp === 10) {
            setStampFullMessage('スタンプ満了。特典を獲得しました')
          }
        }
      } else if (prize.id === 'exp') {
        const nextExp = memberStatus.exp + 1
        nextStatus = { ...nextStatus, exp: nextExp }
      }

      onMemberStatusChange(nextStatus)
      saveMemberStatus(nextStatus)
      if (nextStatus.rank !== memberStatus.rank) {
        setRankUpMessage(`ランクアップ。${RANK_LABEL[nextStatus.rank]}になりました`)
      }
    }, 900)
  }

  const rewardMessage = justPlayed && result
    ? result.id === 'stamp'
      ? stampFullMessage === 'スタンプはすでに満了です'
        ? null
        : 'スタンプが1つ増えました'
      : result.id === 'exp'
      ? '男前ランク経験値が増えました'
      : '100円OFFクーポンを獲得しました'
    : null

  return (
    <div className="py-5 space-y-6">
      {/* Section header */}
      <div className="px-5">
        <p className="text-[10px] tracking-[0.2em] uppercase" style={{ color: 'rgba(201,162,39,0.45)' }}>
          Daily Gacha
        </p>
        <p className="text-xl font-bold tracking-wide mt-0.5" style={{ color: '#F5F0E8' }}>
          毎日ガチャ
        </p>
        <p className="text-sm mt-0.5" style={{ color: '#8A8A7A' }}>
          1日1回、男前の運試し。
        </p>
      </div>

      {/* Gacha machine card */}
      <div className="mx-4">
        <div
          className="rounded-2xl overflow-hidden"
          style={{
            background:
              'radial-gradient(circle at 50% 0%, rgba(139,26,42,0.18), transparent 44%), linear-gradient(135deg, #1C1C1A 0%, #0E0E0C 58%, #16080B 100%)',
            border: '1px solid rgba(201,162,39,0.36)',
            boxShadow:
              '0 14px 44px rgba(0,0,0,0.72), inset 0 1px 0 rgba(245,240,232,0.06), inset 0 0 24px rgba(201,162,39,0.055)',
          }}
        >
          <div
            className="h-1 w-full"
            style={{ background: 'linear-gradient(90deg, #8B1A2A, #C9A227, #8B1A2A)' }}
          />
          <div className="px-5 pt-6 pb-5 flex flex-col items-center gap-5">
            {/* Gacha orb */}
            <motion.div
              animate={isSpinning ? { rotate: [0, 14, -14, 14, 0], scale: [1, 1.1, 1.1, 1.1, 1] } : {}}
              transition={{ duration: 0.8, ease: 'easeInOut' }}
              className="relative flex items-center justify-center"
              style={{
                width: 108,
                height: 108,
                borderRadius: '50%',
                background:
                  'radial-gradient(circle at 38% 35%, rgba(201,162,39,0.18), #1C1C18 38%, #0D0D0B 100%)',
                border: '2px solid rgba(201,162,39,0.46)',
                boxShadow:
                  '0 0 34px rgba(201,162,39,0.13), 0 12px 34px rgba(0,0,0,0.42), inset 0 1px 0 rgba(245,240,232,0.08), inset 0 0 18px rgba(139,26,42,0.14)',
              }}
            >
              <Gift size={38} strokeWidth={1.5} style={{ color: 'rgba(201,162,39,0.72)' }} />
              <AnimatePresence>
                {isSpinning && (
                  <motion.div
                    key="glow"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: [0, 0.7, 0] }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.5, repeat: Infinity }}
                    className="absolute inset-0 rounded-full"
                    style={{ background: 'radial-gradient(circle, rgba(201,162,39,0.22), transparent 70%)' }}
                  />
                )}
              </AnimatePresence>
            </motion.div>

            {/* Remaining count */}
            <div className="text-center">
              <p className="text-[10px] tracking-[0.18em] uppercase" style={{ color: 'rgba(201,162,39,0.45)' }}>
                本日の残り回数
              </p>
              <p
                className="text-3xl font-bold mt-1 leading-none"
                style={{ color: played ? '#4A4A4A' : '#C9A227' }}
              >
                {played ? '0' : '1'}
                <span
                  className="text-sm font-normal ml-1"
                  style={{ color: played ? '#3A3A3A' : 'rgba(201,162,39,0.55)' }}
                >
                  回
                </span>
              </p>
            </div>

            {/* Spin button */}
            <button
              type="button"
              onClick={handleSpin}
              disabled={played || isSpinning}
              className="w-full py-3.5 rounded-xl font-semibold tracking-widest text-sm transition-opacity active:opacity-70 disabled:cursor-not-allowed"
              style={{
                background: played
                  ? 'rgba(74,74,74,0.2)'
                  : 'linear-gradient(135deg, #8B1A2A 0%, #B02035 72%, #7A1523 100%)',
                color: played ? '#4A4A4A' : '#F5F0E8',
                border: played
                  ? '1px solid rgba(74,74,74,0.22)'
                  : '1px solid rgba(176,32,53,0.58)',
                boxShadow: played
                  ? 'inset 0 0 14px rgba(0,0,0,0.16)'
                  : '0 10px 24px rgba(139,26,42,0.26), inset 0 1px 0 rgba(245,240,232,0.08)',
              }}
            >
              {isSpinning ? '抽選中...' : played ? '本日は終了しました' : 'ガチャを回す'}
            </button>
          </div>
        </div>
      </div>

      {/* Result card */}
      <AnimatePresence>
        {result && (
          <motion.div
            key="result"
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
            className="mx-4"
          >
            <p
              className="text-[10px] tracking-[0.2em] uppercase mb-2"
              style={{ color: 'rgba(201,162,39,0.45)' }}
            >
              本日のガチャ結果
            </p>
            <div
              className="flex items-center gap-4 rounded-xl px-4 py-4"
              style={{
                background:
                  'radial-gradient(circle at 0% 50%, rgba(201,162,39,0.12), transparent 38%), linear-gradient(145deg, rgba(34,30,24,0.98), rgba(17,17,16,0.98) 58%, rgba(45,14,20,0.5))',
                border: `1px solid ${result.accent}70`,
                boxShadow: `0 10px 28px rgba(0,0,0,0.44), 0 0 22px ${result.accent}1f, inset 0 1px 0 rgba(245,240,232,0.05)`,
              }}
            >
              <div
                className="flex-shrink-0 p-3 rounded-xl"
                style={{
                  background: `linear-gradient(145deg, ${result.accent}24, rgba(201,162,39,0.06))`,
                  border: `1px solid ${result.accent}44`,
                  boxShadow: `inset 0 0 12px ${result.accent}12`,
                }}
              >
                <PrizeIcon id={result.id} size={26} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-base font-bold" style={{ color: '#F5F0E8' }}>
                  {result.label}
                </p>
                <p className="text-[11px] mt-0.5" style={{ color: '#8A8A7A' }}>
                  {result.sublabel}
                </p>
                {rewardMessage && (
                  <p className="text-[11px] mt-1 font-medium" style={{ color: result.accent }}>
                    ※ {rewardMessage}
                  </p>
                )}
                {stampFullMessage && (
                  <p
                    className="text-[11px] mt-0.5 font-bold"
                    style={{
                      color: stampFullMessage === 'スタンプはすでに満了です'
                        ? 'rgba(201,162,39,0.45)'
                        : '#C9A227',
                    }}
                  >
                    {stampFullMessage}
                  </p>
                )}
                {rankUpMessage && (
                  <p className="text-[11px] mt-0.5 font-bold" style={{ color: '#C9A227' }}>
                    {rankUpMessage}
                  </p>
                )}
              </div>
              <Sparkles size={15} strokeWidth={1.8} className="flex-shrink-0" style={{ color: 'rgba(201,162,39,0.35)' }} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Prize list */}
      <div className="px-4">
        <p
          className="text-[10px] tracking-[0.2em] uppercase mb-3"
          style={{ color: 'rgba(201,162,39,0.45)' }}
        >
          景品一覧
        </p>
        <div className="space-y-2">
          {PRIZES.map((prize) => (
            <div
              key={prize.id}
              className="flex items-center gap-3 px-4 py-3 rounded-xl"
              style={{
                background:
                  'linear-gradient(145deg, rgba(30,28,24,0.96), rgba(17,17,16,0.98) 58%, rgba(41,14,19,0.42))',
                border: '1px solid rgba(201,162,39,0.18)',
                boxShadow: 'inset 0 1px 0 rgba(245,240,232,0.035)',
              }}
            >
              <div
                className="flex-shrink-0 p-2 rounded-lg"
                style={{
                  background: `linear-gradient(145deg, ${prize.accent}18, rgba(201,162,39,0.045))`,
                  border: `1px solid ${prize.accent}24`,
                }}
              >
                <PrizeIcon id={prize.id} size={17} />
              </div>
              <div>
                <p className="text-sm font-medium" style={{ color: '#F5F0E8' }}>
                  {prize.label}
                </p>
                <p className="text-[11px] mt-0.5" style={{ color: '#8A8A7A' }}>
                  {prize.sublabel}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="h-2" />
    </div>
  )
}
