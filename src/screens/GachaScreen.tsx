import { useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { Star, Tag, Trophy, Sparkles, Scissors } from 'lucide-react'
import type { MemberStatus } from '../data/brand'
import { getStoredValue, setStoredValue, saveMemberStatus, loadCoupons, saveCoupons, GACHA_DATE_KEY, GACHA_RESULT_KEY } from '../utils/storage'
import { getTodayDate, formatPoints } from '../utils/date'
import { getNextRankInfo, getRankByPoints, getSafeRank, RANK_LABEL } from '../utils/rank'

type AnimationPhase = 'idle' | 'charging' | 'opening' | 'reveal' | 'done'
type Rarity = 'N' | 'R' | 'SR' | 'SSR'

interface GachaPrize {
  id: string
  label: string
  sublabel: string
  accent: string
  rarity?: Rarity
}

const PRIZES: GachaPrize[] = [
  { id: 'discount', label: '100円OFF', sublabel: '次回来店時に使用可能', accent: '#B0182A', rarity: 'R' },
  { id: 'stamp', label: 'スタンプ +1', sublabel: 'スタンプカードに押印', accent: '#C9A961', rarity: 'SR' },
  { id: 'exp', label: '男前ランク経験値 +1', sublabel: 'ランクアップへ前進', accent: '#E8C77A', rarity: 'SSR' },
]

const MOTION_EASE = [0.22, 1, 0.36, 1] as const

const RARITY_GLOW: Record<Rarity, string> = {
  N: '0 10px 28px rgba(0,0,0,0.44)',
  R: '0 10px 28px rgba(0,0,0,0.44), 0 0 20px rgba(107,15,26,0.2)',
  SR: '0 10px 28px rgba(0,0,0,0.44), 0 0 24px rgba(201,169,97,0.16)',
  SSR: '0 12px 30px rgba(0,0,0,0.48), 0 0 28px rgba(176,24,42,0.24), 0 0 18px rgba(232,199,122,0.12)',
}

function getPrizeRarity(prize: GachaPrize): Rarity {
  if (prize.rarity) return prize.rarity
  if (prize.id === 'exp') return 'SSR'
  if (prize.id === 'stamp') return 'SR'
  if (prize.id === 'discount') return 'R'
  return 'N'
}

function PrizeIcon({ id, size }: { id: string; size: number }) {
  if (id === 'discount') return <Tag size={size} strokeWidth={1.8} style={{ color: '#B0182A' }} />
  if (id === 'stamp') return <Star size={size} strokeWidth={1.8} style={{ color: '#C9A961' }} />
  return <Trophy size={size} strokeWidth={1.8} style={{ color: '#E8C77A' }} />
}

interface Props {
  memberStatus: MemberStatus
  onMemberStatusChange: (next: MemberStatus) => void
}

export function GachaScreen({ memberStatus, onMemberStatusChange }: Props) {
  const prefersReducedMotion = useReducedMotion()
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
  const [animationPhase, setAnimationPhase] = useState<AnimationPhase>(initial ? 'done' : 'idle')
  const [revealedPoints, setRevealedPoints] = useState<number | null>(null)

  function handleSpin() {
    if (played || isSpinning) return
    setIsSpinning(true)
    setAnimationPhase('charging')
    setRankUpMessage(null)
    setStampFullMessage(null)
    setRevealedPoints(null)

    window.setTimeout(() => setAnimationPhase('opening'), prefersReducedMotion ? 180 : 2200)
    window.setTimeout(() => {
      const prize = PRIZES[Math.floor(Math.random() * PRIZES.length)]
      setStoredValue(GACHA_DATE_KEY, today)
      setStoredValue(GACHA_RESULT_KEY, prize.id)
      setResult(prize)
      setPlayed(true)
      setIsSpinning(false)
      setJustPlayed(true)

      const nextPoints = memberStatus.points + 10
      setRevealedPoints(nextPoints)
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
      setAnimationPhase('reveal')
      window.setTimeout(() => setAnimationPhase('done'), prefersReducedMotion ? 180 : 650)
    }, prefersReducedMotion ? 360 : 2800)
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
  const displayPoints = revealedPoints ?? memberStatus.points
  const nextRankInfo = getNextRankInfo(displayPoints)
  const resultRarity = result ? getPrizeRarity(result) : 'N'
  const isCharging = animationPhase === 'charging' || animationPhase === 'opening'
  const isOpening = animationPhase === 'opening' || animationPhase === 'reveal' || animationPhase === 'done'

  return (
    <div className="py-5 space-y-6" style={{ background: '#0A0606' }}>
      {/* Section header */}
      <div className="px-5">
        <p className="text-[10px] tracking-[0.2em] uppercase" style={{ color: 'rgba(201,169,97,0.48)' }}>
          Daily Gacha
        </p>
        <p className="text-xl font-bold tracking-wide mt-0.5" style={{ color: '#F2E6C8' }}>
          毎日ガチャ
        </p>
        <p className="text-sm mt-0.5" style={{ color: 'rgba(242,230,200,0.56)' }}>
          1日1回、男前の運試し。
        </p>
      </div>

      {/* Gacha machine card */}
      <div className="mx-4">
        <div
          className="rounded-2xl overflow-hidden"
          style={{
            background:
              'radial-gradient(circle at 50% 0%, rgba(107,15,26,0.2), transparent 44%), linear-gradient(135deg, #1A1212 0%, #0A0606 58%, #16080B 100%)',
            border: '1px solid rgba(201,169,97,0.42)',
            boxShadow:
              '0 14px 44px rgba(0,0,0,0.72), inset 0 1px 0 rgba(242,230,200,0.06), inset 0 0 24px rgba(107,15,26,0.12)',
          }}
        >
          <div
            className="h-1 w-full"
            style={{ background: 'linear-gradient(90deg, #6B0F1A, #C9A961, #B0182A)' }}
          />
          <div className="px-5 pt-6 pb-5 flex flex-col items-center gap-5">
            {/* Razor case ritual */}
            <div className="relative h-40 w-full max-w-[330px] overflow-hidden rounded-2xl">
              <motion.div
                aria-hidden
                animate={isSpinning ? { opacity: [0.28, 0.58, 0.38], scale: [1, 1.025, 1] } : { opacity: 0.24, scale: 1 }}
                transition={{ duration: prefersReducedMotion ? 0.2 : 1.4, repeat: isSpinning && !prefersReducedMotion ? Infinity : 0, ease: MOTION_EASE }}
                className="absolute inset-5 rounded-full"
                style={{
                  background: 'radial-gradient(circle, rgba(176,24,42,0.38), rgba(107,15,26,0.16) 42%, transparent 70%)',
                  filter: 'blur(10px)',
                }}
              />
              <motion.div
                className="absolute left-1/2 top-1/2 flex h-24 w-[250px] -translate-x-1/2 -translate-y-1/2 items-center justify-center overflow-hidden rounded-2xl"
                animate={isSpinning ? { y: [0, -1, 0] } : { y: 0 }}
                transition={{ duration: prefersReducedMotion ? 0.2 : 0.8, ease: MOTION_EASE }}
                style={{
                  background:
                    'linear-gradient(145deg, #1A1212, #0A0606 58%, rgba(107,15,26,0.42))',
                  border: '1px solid rgba(201,169,97,0.42)',
                  boxShadow:
                    '0 16px 30px rgba(0,0,0,0.48), inset 0 1px 0 rgba(242,230,200,0.06), inset 0 0 18px rgba(107,15,26,0.18)',
                  willChange: 'transform',
                }}
              >
                <motion.div
                  className="absolute inset-y-0 left-0 w-1/2 origin-left"
                  animate={{ rotateY: isOpening ? -58 : 0 }}
                  transition={{ duration: prefersReducedMotion ? 0.18 : 0.58, ease: MOTION_EASE }}
                  style={{
                    background: 'linear-gradient(90deg, #1A1212, #0A0606)',
                    borderRight: '1px solid rgba(201,169,97,0.24)',
                    willChange: 'transform',
                  }}
                />
                <motion.div
                  className="absolute inset-y-0 right-0 w-1/2 origin-right"
                  animate={{ rotateY: isOpening ? 58 : 0 }}
                  transition={{ duration: prefersReducedMotion ? 0.18 : 0.58, ease: MOTION_EASE }}
                  style={{
                    background: 'linear-gradient(270deg, #1A1212, #0A0606)',
                    borderLeft: '1px solid rgba(201,169,97,0.24)',
                    willChange: 'transform',
                  }}
                />
                <motion.div
                  className="absolute inset-0 rounded-2xl"
                  initial={false}
                  animate={isCharging ? { clipPath: 'inset(0% 0% 0% 0%)', opacity: 1 } : { clipPath: 'inset(0% 100% 0% 0%)', opacity: 0.35 }}
                  transition={{ duration: prefersReducedMotion ? 0.2 : 1.35, ease: MOTION_EASE }}
                  style={{
                    border: '1px solid #C9A961',
                    boxShadow: 'inset 0 0 12px rgba(232,199,122,0.12), 0 0 12px rgba(201,169,97,0.12)',
                  }}
                />
                <motion.div
                  className="absolute inset-0 rounded-2xl"
                  animate={animationPhase === 'reveal' ? { opacity: [0, 0.7, 0], scale: [0.88, 1.08, 1.12] } : { opacity: 0, scale: 0.9 }}
                  transition={{ duration: prefersReducedMotion ? 0.16 : 0.42, ease: MOTION_EASE }}
                  style={{ background: 'radial-gradient(circle, rgba(232,199,122,0.42), rgba(176,24,42,0.3) 42%, transparent 72%)' }}
                />
                <Scissors size={34} strokeWidth={1.4} style={{ color: '#E8C77A', transform: 'rotate(270deg)', opacity: 0.72 }} />
              </motion.div>
              {Array.from({ length: 8 }, (_, index) => (
                <motion.span
                  key={index}
                  className="absolute h-1 w-1 rounded-full"
                  animate={isCharging && !prefersReducedMotion ? { opacity: [0, 0.7, 0], y: [0, -18 - index * 2], x: [0, index % 2 === 0 ? 8 : -8] } : { opacity: 0 }}
                  transition={{ duration: 1.45, delay: index * 0.08, repeat: isSpinning && !prefersReducedMotion ? Infinity : 0, ease: MOTION_EASE }}
                  style={{
                    left: `${22 + index * 8}%`,
                    top: `${70 - (index % 3) * 10}%`,
                    background: '#E8C77A',
                    boxShadow: '0 0 8px rgba(232,199,122,0.45)',
                  }}
                />
              ))}
            </div>

            {/* Remaining count */}
            <div className="text-center">
              <p className="text-[10px] tracking-[0.18em] uppercase" style={{ color: 'rgba(201,169,97,0.48)' }}>
                本日の残り回数
              </p>
              <p
                className="text-3xl font-bold mt-1 leading-none"
                style={{ color: played ? '#4A4A4A' : '#E8C77A' }}
              >
                {played ? '0' : '1'}
                <span
                  className="text-sm font-normal ml-1"
                  style={{ color: played ? '#3A3A3A' : 'rgba(201,169,97,0.62)' }}
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
                  : 'linear-gradient(135deg, #6B0F1A 0%, #B0182A 72%, #6B0F1A 100%)',
                color: played ? '#4A4A4A' : '#F2E6C8',
                border: played
                  ? '1px solid rgba(74,74,74,0.22)'
                  : '1px solid rgba(176,32,53,0.58)',
                boxShadow: played
                  ? 'inset 0 0 14px rgba(0,0,0,0.16)'
                  : '0 10px 24px rgba(107,15,26,0.26), inset 0 1px 0 rgba(242,230,200,0.08)',
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
            initial={{ opacity: 0, y: 18, rotateX: -8 }}
            animate={{ opacity: animationPhase === 'reveal' || animationPhase === 'done' ? 1 : 0.72, y: 0, rotateX: 0 }}
            transition={{ duration: prefersReducedMotion ? 0.18 : 0.72, ease: MOTION_EASE }}
            className="mx-4"
          >
            <p
              className="text-[10px] tracking-[0.2em] uppercase mb-2"
              style={{ color: 'rgba(201,169,97,0.48)' }}
            >
              本日のガチャ結果
            </p>
            <div
              className="relative flex items-center gap-4 overflow-hidden rounded-xl px-4 py-4"
              style={{
                background:
                  'radial-gradient(circle at 0% 50%, rgba(201,169,97,0.12), transparent 38%), linear-gradient(145deg, #1A1212, #0A0606 58%, rgba(107,15,26,0.44))',
                border: '1px solid rgba(201,169,97,0.5)',
                boxShadow: `${RARITY_GLOW[resultRarity]}, inset 0 1px 0 rgba(242,230,200,0.05)`,
              }}
            >
              <motion.div
                className="pointer-events-none absolute inset-0 rounded-xl"
                initial={{ clipPath: 'inset(0% 100% 0% 0%)' }}
                animate={{ clipPath: 'inset(0% 0% 0% 0%)' }}
                transition={{ duration: prefersReducedMotion ? 0.18 : 0.9, ease: MOTION_EASE }}
                style={{ border: '1px solid #E8C77A' }}
              />
              {(resultRarity === 'SR' || resultRarity === 'SSR') && (
                <>
                  <motion.div
                    className="pointer-events-none absolute inset-y-0 w-px"
                    initial={{ left: '14%', opacity: 0 }}
                    animate={{ left: '42%', opacity: [0, 0.9, 0] }}
                    transition={{ duration: prefersReducedMotion ? 0.18 : 0.74, ease: MOTION_EASE }}
                    style={{ background: 'linear-gradient(180deg, transparent, #E8C77A, transparent)' }}
                  />
                  <motion.div
                    className="pointer-events-none absolute inset-y-0 w-px"
                    initial={{ right: '14%', opacity: 0 }}
                    animate={{ right: '42%', opacity: [0, 0.9, 0] }}
                    transition={{ duration: prefersReducedMotion ? 0.18 : 0.74, ease: MOTION_EASE }}
                    style={{ background: 'linear-gradient(180deg, transparent, #E8C77A, transparent)' }}
                  />
                </>
              )}
              {resultRarity === 'SSR' && (
                <motion.div
                  className="pointer-events-none absolute left-1/2 top-1/2 h-28 w-28 -translate-x-1/2 -translate-y-1/2 rounded-full"
                  initial={{ opacity: 0, scale: 0.2 }}
                  animate={{ opacity: [0, 0.48, 0], scale: [0.2, 1.15, 1.35] }}
                  transition={{ duration: prefersReducedMotion ? 0.18 : 0.78, ease: MOTION_EASE }}
                  style={{ border: '1px solid rgba(176,24,42,0.56)', boxShadow: '0 0 12px rgba(176,24,42,0.24)' }}
                />
              )}
              <div
                className="relative flex-shrink-0 p-3 rounded-xl"
                style={{
                  background: 'linear-gradient(145deg, rgba(176,24,42,0.15), rgba(201,169,97,0.08))',
                  border: '1px solid rgba(201,169,97,0.3)',
                  boxShadow: 'inset 0 0 12px rgba(107,15,26,0.18)',
                }}
              >
                <PrizeIcon id={result.id} size={26} />
              </div>
              <div className="relative flex-1 min-w-0">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[9px] font-bold tracking-[0.18em]" style={{ color: '#E8C77A' }}>
                    {resultRarity}
                  </span>
                  <span className="h-px flex-1" style={{ background: 'linear-gradient(90deg, rgba(201,169,97,0.5), transparent)' }} />
                </div>
                <p className="text-base font-bold" style={{ color: '#F2E6C8' }}>
                  {result.label}
                </p>
                <p className="text-[11px] mt-0.5" style={{ color: 'rgba(242,230,200,0.54)' }}>
                  {result.sublabel}
                </p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-[9px] tracking-[0.16em]" style={{ color: 'rgba(201,169,97,0.55)' }}>
                      POINT
                    </p>
                    <p className="text-[12px] font-bold" style={{ color: '#E8C77A' }}>
                      +10pt / {formatPoints(displayPoints)}pt
                    </p>
                  </div>
                  <div>
                    <p className="text-[9px] tracking-[0.16em]" style={{ color: 'rgba(201,169,97,0.55)' }}>
                      NEXT
                    </p>
                    <p className="text-[12px] font-bold" style={{ color: '#F2E6C8' }}>
                      {nextRankInfo.nextRank
                        ? `${RANK_LABEL[nextRankInfo.nextRank]} ${formatPoints(nextRankInfo.remainingPoints)}pt`
                        : 'PLATINUM'}
                    </p>
                  </div>
                </div>
                {rewardMessage && (
                  <p className="text-[11px] mt-1 font-medium" style={{ color: '#E8C77A' }}>
                    ※ {rewardMessage}
                  </p>
                )}
                {stampFullMessage && (
                  <p
                    className="text-[11px] mt-0.5 font-bold"
                    style={{
                      color: stampFullMessage === 'スタンプはすでに満了です'
                        ? 'rgba(201,169,97,0.45)'
                        : '#E8C77A',
                    }}
                  >
                    {stampFullMessage}
                  </p>
                )}
                {rankUpMessage && (
                  <p className="text-[11px] mt-0.5 font-bold" style={{ color: '#E8C77A' }}>
                    {rankUpMessage}
                  </p>
                )}
              </div>
              <Sparkles size={15} strokeWidth={1.8} className="flex-shrink-0" style={{ color: 'rgba(201,169,97,0.36)' }} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Prize list */}
      <div className="px-4">
        <p
          className="text-[10px] tracking-[0.2em] uppercase mb-3"
          style={{ color: 'rgba(201,169,97,0.48)' }}
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
                border: '1px solid rgba(201,169,97,0.18)',
                boxShadow: 'inset 0 1px 0 rgba(242,230,200,0.035)',
              }}
            >
              <div
                className="flex-shrink-0 p-2 rounded-lg"
                style={{
                  background: 'linear-gradient(145deg, rgba(176,24,42,0.12), rgba(201,169,97,0.06))',
                  border: '1px solid rgba(201,169,97,0.18)',
                }}
              >
                <PrizeIcon id={prize.id} size={17} />
              </div>
              <div>
                <p className="text-sm font-medium" style={{ color: '#F2E6C8' }}>
                  {prize.label}
                </p>
                <p className="text-[11px] mt-0.5" style={{ color: 'rgba(242,230,200,0.54)' }}>
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
