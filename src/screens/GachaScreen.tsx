import { useRef, useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import type { PanInfo } from 'framer-motion'
import { Star, Tag, Trophy, Sparkles } from 'lucide-react'
import type { MemberStatus } from '../data/brand'
import { getStoredValue, setStoredValue, saveMemberStatus, loadCoupons, saveCoupons, GACHA_DATE_KEY, GACHA_RESULT_KEY } from '../utils/storage'
import { getTodayDate, formatPoints } from '../utils/date'
import { getNextRankInfo, getRankByPoints, getSafeRank, RANK_LABEL } from '../utils/rank'
import { PremiumGachaExperience } from '../components/PremiumGachaExperience'

type Scene = 'idle' | 'gateReady' | 'gateOpening' | 'flash' | 'entering' | 'approach' | 'reveal' | 'result'
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
const IS_DEV_GACHA_UNLIMITED = import.meta.env.DEV

const GACHA_ASSETS = {
  gateClosed: '/images/gacha/gacha-gate-closed.png',
  gateOpening: '/images/gacha/gacha-gate-opening.png',
  swipeGuide: '/images/gacha/gacha-swipe-guide.png',
  releaseFlash: '/images/gacha/gacha-release-flash.png',
  enterLounge: '/images/gacha/gacha-enter-lounge.png',
  ginjiroRunning: '/images/gacha/gacha-ginjiro-running.png',
  machine: '/images/gacha/gacha-machine.png',
  capsuleOpen: '/images/gacha/gacha-capsule-open.png',
  resultBg: '/images/gacha/gacha-result-bg.png',
} as const

const RARITY_STYLE: Record<Rarity, { glow: string; flashOpacity: number; verticalLight: boolean }> = {
  N: { glow: '0 22px 54px rgba(0,0,0,0.54)', flashOpacity: 0.12, verticalLight: false },
  R: { glow: '0 22px 54px rgba(0,0,0,0.54), 0 0 24px rgba(122,13,18,0.28)', flashOpacity: 0.22, verticalLight: false },
  SR: { glow: '0 24px 58px rgba(0,0,0,0.56), 0 0 28px rgba(122,13,18,0.32), 0 0 18px rgba(232,199,122,0.18)', flashOpacity: 0.34, verticalLight: false },
  SSR: { glow: '0 26px 62px rgba(0,0,0,0.58), 0 0 34px rgba(122,13,18,0.42), 0 0 26px rgba(232,199,122,0.24)', flashOpacity: 0.44, verticalLight: true },
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

function SceneImage({
  src,
  fallback,
  className,
}: {
  src: string
  fallback?: string
  className?: string
}) {
  const [imageSrc, setImageSrc] = useState(src)

  return (
    <img
      src={imageSrc}
      alt=""
      draggable={false}
      className={className ?? 'absolute inset-0 h-full w-full object-cover object-center'}
      onError={() => {
        if (fallback && imageSrc !== fallback) {
          setImageSrc(fallback)
        }
      }}
    />
  )
}

function OptionalSceneImage({
  src,
  className,
}: {
  src: string
  className: string
}) {
  const [visible, setVisible] = useState(true)
  if (!visible) return null

  return <img src={src} alt="" draggable={false} className={className} onError={() => setVisible(false)} />
}

interface Props {
  memberStatus: MemberStatus
  onMemberStatusChange: (next: MemberStatus) => void
}

export function GachaScreen({ memberStatus, onMemberStatusChange }: Props) {
  const prefersReducedMotion = useReducedMotion()
  const today = getTodayDate()
  const storedDate = getStoredValue<string>(GACHA_DATE_KEY, '')
  const isAlreadyPlayedToday = !IS_DEV_GACHA_UNLIMITED && storedDate === today
  const savedId = getStoredValue<string>(GACHA_RESULT_KEY, '')
  const initial = isAlreadyPlayedToday ? (PRIZES.find((p) => p.id === savedId) ?? null) : null
  const timersRef = useRef<number[]>([])

  const [result, setResult] = useState<GachaPrize | null>(initial)
  const [played, setPlayed] = useState(isAlreadyPlayedToday)
  const [isSpinning, setIsSpinning] = useState(false)
  const [justPlayed, setJustPlayed] = useState(false)
  const [rankUpMessage, setRankUpMessage] = useState<string | null>(null)
  const [stampFullMessage, setStampFullMessage] = useState<string | null>(null)
  const [scene, setScene] = useState<Scene>('idle')
  const [revealedPoints, setRevealedPoints] = useState<number | null>(null)
  const [isOverlayOpen, setIsOverlayOpen] = useState(false)
  const [dragDistance, setDragDistance] = useState(0)
  const [isPremiumOpen, setIsPremiumOpen] = useState(false)

  function clearSceneTimers() {
    timersRef.current.forEach((timer) => window.clearTimeout(timer))
    timersRef.current = []
  }

  function queueScene(delay: number, next: () => void) {
    const timer = window.setTimeout(next, delay)
    timersRef.current.push(timer)
  }

  function runGacha() {
    const prize = PRIZES[Math.floor(Math.random() * PRIZES.length)]
    setStoredValue(GACHA_DATE_KEY, today)
    setStoredValue(GACHA_RESULT_KEY, prize.id)
    setResult(prize)
    setPlayed(!IS_DEV_GACHA_UNLIMITED)
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
    setScene('result')
  }

  function startGateOpening() {
    if (played || isSpinning) return
    clearSceneTimers()
    setIsOverlayOpen(true)
    setIsSpinning(true)
    setDragDistance(0)
    setResult(null)
    setScene('gateOpening')
    setRankUpMessage(null)
    setStampFullMessage(null)
    setRevealedPoints(null)

    if (prefersReducedMotion) {
      queueScene(120, () => setScene('flash'))
      queueScene(240, () => setScene('reveal'))
      queueScene(320, runGacha)
      return
    }

    queueScene(700, () => setScene('flash'))
    queueScene(1120, () => setScene('entering'))
    queueScene(1920, () => setScene('approach'))
    queueScene(2520, () => setScene('reveal'))
    queueScene(2920, runGacha)
  }

  function openOverlay() {
    if (played || isSpinning) return
    clearSceneTimers()
    setIsOverlayOpen(true)
    setScene('gateReady')
    setDragDistance(0)
    setResult(null)
  }

  function closeOverlay() {
    clearSceneTimers()
    setIsOverlayOpen(false)
    setScene('idle')
    setDragDistance(0)
  }

  function handleDragStart() {
    if (played || isSpinning) return
    setDragDistance(0)
  }

  function handleDrag(_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) {
    setDragDistance(Math.min(Math.abs(info.offset.x), 120))
  }

  function handleDragEnd(_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) {
    if (Math.abs(info.offset.x) >= 80) {
      startGateOpening()
      return
    }
    setDragDistance(0)
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
  const rarityStyle = RARITY_STYLE[resultRarity]
  const dragProgress = Math.min(dragDistance / 80, 1)
  const remainingCount = played ? 0 : 1
  const gateIsOpen = scene === 'gateOpening' || scene === 'flash' || scene === 'entering' || scene === 'approach' || scene === 'reveal' || scene === 'result'
  const showGuide = scene === 'gateReady' && !played && !isSpinning
  const showFlash = scene === 'flash' || scene === 'reveal'
  const backgroundScale =
    scene === 'gateOpening'
      ? 1.06
      : scene === 'entering'
      ? 1.16
      : scene === 'approach'
      ? 1.2
      : scene === 'reveal' || scene === 'result'
      ? 1.08
      : dragDistance > 0
      ? 1.02
      : 1

  return (
    <div className="min-h-full overflow-x-hidden bg-[#070403] px-4 pb-6 pt-4">
      <section
        className="mx-auto max-w-[430px] overflow-hidden rounded-lg px-4 py-5"
        style={{
          background: 'linear-gradient(145deg, #160B09 0%, #090504 52%, #250A0C 100%)',
          border: '1px solid rgba(201,169,97,0.36)',
          boxShadow: '0 16px 34px rgba(0,0,0,0.38), inset 0 1px 0 rgba(242,230,200,0.06)',
        }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em]" style={{ color: 'rgba(201,169,97,0.58)' }}>
          Ginjiro Daily Ritual
        </p>
        <h2 className="mt-2 text-2xl font-bold tracking-wide" style={{ color: '#F2E6C8' }}>
          男前ガチャ
        </h2>
        <div className="mt-4 rounded-lg bg-black/30 px-4 py-3" style={{ border: '1px solid rgba(201,169,97,0.18)' }}>
          <p className="text-[10px] tracking-[0.18em] uppercase" style={{ color: 'rgba(201,169,97,0.64)' }}>
            本日の残り回数
          </p>
          <p className="mt-1 text-3xl font-bold leading-none" style={{ color: played ? '#6C6258' : '#E8C77A' }}>
            {remainingCount}
            <span className="ml-1 text-sm font-normal" style={{ color: played ? '#6C6258' : 'rgba(201,169,97,0.72)' }}>
              回
            </span>
          </p>
        </div>
        {result && (
          <p className="mt-3 text-[12px]" style={{ color: 'rgba(242,230,200,0.58)' }}>
            本日の結果: {result.label}
          </p>
        )}
        <button
          type="button"
          onClick={openOverlay}
          disabled={played || isSpinning}
          className="mt-4 w-full rounded-lg px-4 py-4 text-sm font-bold tracking-widest transition-opacity active:opacity-75 disabled:cursor-not-allowed"
          style={{
            color: played ? 'rgba(201,169,97,0.36)' : '#F2E6C8',
            border: played ? '1px solid rgba(201,169,97,0.18)' : '1px solid rgba(232,199,122,0.78)',
            background: played
              ? 'linear-gradient(135deg, #120B0A, #070403)'
              : 'linear-gradient(135deg, #050202 0%, #180708 48%, #5A0D12 100%)',
            boxShadow: played ? 'none' : 'inset 0 1px 0 rgba(242,230,200,0.12), 0 10px 22px rgba(0,0,0,0.36)',
          }}
        >
          {played ? '本日は終了しました' : '男前ガチャを開く'}
        </button>

        {/* premium gacha divider */}
        <div className="mt-5 flex items-center gap-3">
          <div className="h-px flex-1" style={{ background: 'linear-gradient(90deg, transparent, rgba(201,169,97,0.28))' }} />
          <span className="text-[9px] tracking-[0.22em]" style={{ color: 'rgba(201,169,97,0.42)' }}>PREMIUM</span>
          <div className="h-px flex-1" style={{ background: 'linear-gradient(270deg, transparent, rgba(201,169,97,0.28))' }} />
        </div>

        <button
          type="button"
          onClick={() => setIsPremiumOpen(true)}
          className="mt-3 w-full rounded-lg px-4 py-3 text-sm font-bold tracking-widest transition-opacity active:opacity-75"
          style={{
            color: '#E8C77A',
            border: '1px solid rgba(232,199,122,0.52)',
            background: 'linear-gradient(135deg, #0A0604 0%, #160A04 50%, #3A1A04 100%)',
            boxShadow: '0 0 18px rgba(232,199,122,0.1), inset 0 1px 0 rgba(242,230,200,0.08)',
          }}
        >
          プレミアムガチャを体験する
        </button>
      </section>

      <AnimatePresence>
        {isPremiumOpen && (
          <PremiumGachaExperience
            key="premium-gacha"
            onClose={() => setIsPremiumOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isOverlayOpen && (
          <motion.div
            key="gacha-overlay"
            className="fixed inset-0 z-[9999] overflow-hidden bg-[#050202]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0.08 : 0.18, ease: MOTION_EASE }}
          >
            <motion.div
              className="absolute inset-0 bg-[#050202]"
              animate={{ scale: backgroundScale }}
              transition={{ duration: prefersReducedMotion ? 0.08 : scene === 'gateOpening' ? 0.7 : 0.8, ease: MOTION_EASE }}
            >
              <SceneImage
                src={scene === 'entering' ? GACHA_ASSETS.enterLounge : scene === 'result' ? GACHA_ASSETS.resultBg : GACHA_ASSETS.gateClosed}
                fallback={gateIsOpen ? GACHA_ASSETS.gateOpening : GACHA_ASSETS.gateClosed}
              />
              <AnimatePresence>
                {gateIsOpen && scene !== 'entering' && scene !== 'result' && (
                  <motion.img
                    key="gate-opening"
                    src={GACHA_ASSETS.gateOpening}
                    alt=""
                    draggable={false}
                    className="absolute inset-0 h-full w-full object-cover object-center"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: prefersReducedMotion ? 0.1 : 0.7, ease: MOTION_EASE }}
                  />
                )}
              </AnimatePresence>
            </motion.div>

            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'linear-gradient(180deg, rgba(0,0,0,0.58) 0%, rgba(30,4,5,0.18) 30%, rgba(40,5,7,0.2) 56%, rgba(0,0,0,0.82) 100%)',
              }}
            />
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                opacity: scene === 'entering' ? 0.85 : scene === 'approach' ? 0.62 : dragProgress,
                background:
                  'radial-gradient(circle at 50% 52%, rgba(121,13,18,0.62) 0%, rgba(70,7,9,0.28) 28%, rgba(5,2,2,0) 58%)',
              }}
            />

            <AnimatePresence>
              {showFlash && (
                <motion.div key={`flash-${scene}`} className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <motion.img
                    src={GACHA_ASSETS.releaseFlash}
                    alt=""
                    draggable={false}
                    className="h-full w-full object-cover object-center mix-blend-screen"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: [0, scene === 'reveal' ? 0.82 : 1, 0], scale: [0.9, 1.1, 1.18] }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: prefersReducedMotion ? 0.12 : scene === 'reveal' ? 0.4 : 0.38, ease: MOTION_EASE }}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {scene === 'approach' && (
              <motion.div
                className="pointer-events-none absolute inset-0 flex items-center justify-center px-8"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.42, ease: MOTION_EASE }}
              >
                <div
                  className="relative h-[38dvh] w-full max-w-[330px] overflow-hidden rounded-lg"
                  style={{
                    border: '1px solid rgba(232,199,122,0.44)',
                    background: 'linear-gradient(145deg, rgba(10,6,5,0.82), rgba(65,10,12,0.24))',
                    boxShadow: 'inset 0 0 28px rgba(0,0,0,0.58), 0 18px 48px rgba(0,0,0,0.44)',
                  }}
                >
                  <OptionalSceneImage
                    src={GACHA_ASSETS.ginjiroRunning}
                    className="absolute inset-x-0 bottom-0 mx-auto max-h-full max-w-full object-contain"
                  />
                  <OptionalSceneImage
                    src={GACHA_ASSETS.machine}
                    className="absolute inset-x-0 bottom-0 mx-auto max-h-full max-w-full object-contain"
                  />
                  <div
                    className="absolute inset-0"
                    style={{
                      background:
                        'radial-gradient(circle at 50% 45%, transparent 0%, rgba(232,199,122,0.08) 18%, rgba(5,2,2,0.48) 58%, rgba(5,2,2,0.86) 100%)',
                    }}
                  />
                  <motion.div
                    className="absolute inset-x-8 top-1/2 h-px"
                    animate={{ opacity: [0.22, 0.58, 0.22], scaleX: [0.72, 1, 0.72] }}
                    transition={{ duration: 0.9, repeat: Infinity, ease: MOTION_EASE }}
                    style={{ background: 'linear-gradient(90deg, transparent, rgba(232,199,122,0.78), transparent)' }}
                  />
                </div>
              </motion.div>
            )}

            <AnimatePresence>
              {showGuide && (
                <motion.div
                  key="swipe-guide"
                  className="absolute inset-x-0 bottom-[7dvh] z-10 flex flex-col items-center px-6"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  transition={{ duration: 0.24, ease: MOTION_EASE }}
                >
                  <motion.div
                    className="w-[min(54vw,220px)] touch-pan-y overflow-hidden rounded-lg bg-black/72 px-4 py-3"
                    style={{
                      border: '1px solid rgba(201,169,97,0.24)',
                      boxShadow: '0 12px 28px rgba(0,0,0,0.42)',
                    }}
                    drag="x"
                    dragConstraints={{ left: -110, right: 110 }}
                    dragElastic={0.04}
                    onDragStart={handleDragStart}
                    onDrag={handleDrag}
                    onDragEnd={handleDragEnd}
                    animate={{ x: prefersReducedMotion ? 0 : [-7, 7, -7] }}
                    transition={{ duration: 1.9, repeat: Infinity, ease: MOTION_EASE }}
                    whileDrag={{ opacity: 0.94 }}
                  >
                    <img
                      src={GACHA_ASSETS.swipeGuide}
                      alt="左右にスワイプ"
                      draggable={false}
                      className="mx-auto block h-auto max-h-10 w-full object-contain"
                      style={{ filter: 'contrast(1.04) brightness(0.92)' }}
                    />
                  </motion.div>
                  <p className="mt-3 text-center text-[11px] tracking-[0.14em]" style={{ color: 'rgba(242,230,200,0.72)' }}>
                    左右にスワイプして開門
                  </p>
                  <button
                    type="button"
                    onClick={startGateOpening}
                    className="mt-3 rounded px-3 py-1 text-[11px] tracking-[0.1em] opacity-60 transition-opacity active:opacity-80"
                    style={{
                      color: '#F2E6C8',
                      border: '1px solid rgba(201,169,97,0.24)',
                      background: 'rgba(5,2,2,0.38)',
                    }}
                  >
                    開く
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {scene === 'result' && result && (
                <motion.div
                  key="overlay-result"
                  className="absolute inset-0 z-20 flex items-center justify-center px-4 py-8"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: prefersReducedMotion ? 0.1 : 0.22, ease: MOTION_EASE }}
                >
                  <div className="pointer-events-none absolute inset-0 backdrop-blur-[2px]" />
                  {rarityStyle.verticalLight && (
                    <motion.div
                      className="pointer-events-none absolute inset-y-0 left-1/2 w-[18vw] max-w-[110px] -translate-x-1/2"
                      initial={{ opacity: 0, scaleY: 0.78 }}
                      animate={{ opacity: [0, 0.72, 0], scaleY: [0.78, 1, 1.08] }}
                      transition={{ duration: prefersReducedMotion ? 0.1 : 0.42, ease: MOTION_EASE }}
                      style={{
                        background: 'linear-gradient(90deg, transparent, rgba(232,199,122,0.72), rgba(122,13,18,0.58), transparent)',
                        filter: 'blur(8px)',
                      }}
                    />
                  )}
                  <motion.div
                    className="w-full max-w-[390px] rounded-lg px-4 py-5"
                    initial={{ opacity: 0, scale: 0.86, y: 24 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    transition={{ duration: prefersReducedMotion ? 0.12 : 0.5, ease: MOTION_EASE }}
                    style={{
                      background: 'linear-gradient(145deg, rgba(18,12,10,0.98), rgba(7,5,4,0.98) 58%, rgba(62,12,14,0.94))',
                      border: '1px solid rgba(232,199,122,0.62)',
                      boxShadow: `${rarityStyle.glow}, inset 0 1px 0 rgba(242,230,200,0.08)`,
                    }}
                  >
                    <div
                      className="pointer-events-none -mx-4 -mt-5 mb-4 h-1 rounded-t-lg"
                      style={{
                        opacity: rarityStyle.flashOpacity,
                        background: 'linear-gradient(90deg, transparent, #E8C77A, #7A0D12, transparent)',
                      }}
                    />
                    <div className="flex items-start gap-4">
                      <div
                        className="relative flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-lg"
                        style={{
                          background: 'linear-gradient(145deg, rgba(15,12,10,0.96), rgba(45,25,20,0.72))',
                          border: '1px solid rgba(201,169,97,0.52)',
                          boxShadow: 'inset 0 0 16px rgba(0,0,0,0.5), 0 10px 20px rgba(0,0,0,0.32)',
                        }}
                      >
                        <OptionalSceneImage
                          src={GACHA_ASSETS.capsuleOpen}
                          className="absolute inset-1 h-[calc(100%-0.5rem)] w-[calc(100%-0.5rem)] object-contain"
                        />
                        <div className="absolute inset-2 rounded-md" style={{ border: '1px solid rgba(201,169,97,0.18)' }} />
                        <PrizeIcon id={result.id} size={30} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="mb-2 flex items-center gap-2">
                          <span className="text-[10px] font-bold tracking-[0.22em]" style={{ color: '#E8C77A' }}>
                            {resultRarity}
                          </span>
                          <span className="h-px flex-1" style={{ background: 'linear-gradient(90deg, rgba(201,169,97,0.58), transparent)' }} />
                          <Sparkles size={15} strokeWidth={1.8} className="flex-shrink-0" style={{ color: 'rgba(201,169,97,0.48)' }} />
                        </div>
                        <p className="text-lg font-bold leading-tight" style={{ color: '#F2E6C8' }}>
                          {result.label}
                        </p>
                        <p className="mt-1 text-[12px]" style={{ color: 'rgba(242,230,200,0.62)' }}>
                          {result.sublabel}
                        </p>
                      </div>
                    </div>

                    <div className="mt-5 grid grid-cols-1 gap-2">
                      <div className="rounded-lg bg-black/24 px-3 py-2" style={{ border: '1px solid rgba(201,169,97,0.16)' }}>
                        <p className="text-[10px] tracking-[0.16em]" style={{ color: 'rgba(201,169,97,0.58)' }}>
                          POINT
                        </p>
                        <p className="mt-1 text-sm font-bold" style={{ color: '#E8C77A' }}>
                          +10pt / 累計 {formatPoints(displayPoints)}pt
                        </p>
                      </div>
                      <div className="rounded-lg bg-black/24 px-3 py-2" style={{ border: '1px solid rgba(201,169,97,0.16)' }}>
                        <p className="text-[10px] tracking-[0.16em]" style={{ color: 'rgba(201,169,97,0.58)' }}>
                          NEXT RANK
                        </p>
                        <p className="mt-1 text-sm font-bold" style={{ color: '#F2E6C8' }}>
                          {nextRankInfo.nextRank
                            ? `${RANK_LABEL[nextRankInfo.nextRank]}まで ${formatPoints(nextRankInfo.remainingPoints)}pt`
                            : '最高ランク到達'}
                        </p>
                      </div>
                    </div>

                    {rewardMessage && (
                      <p className="mt-3 text-[12px] font-medium" style={{ color: '#E8C77A' }}>
                        {rewardMessage}
                      </p>
                    )}
                    {stampFullMessage && (
                      <p
                        className="mt-2 text-[12px] font-bold"
                        style={{
                          color: stampFullMessage === 'スタンプはすでに満了です'
                            ? 'rgba(201,169,97,0.5)'
                            : '#E8C77A',
                        }}
                      >
                        {stampFullMessage}
                      </p>
                    )}
                    {rankUpMessage && (
                      <p className="mt-2 text-[12px] font-bold" style={{ color: '#E8C77A' }}>
                        {rankUpMessage}
                      </p>
                    )}

                    <button
                      type="button"
                      onClick={closeOverlay}
                      className="mt-5 w-full rounded-lg px-4 py-3 text-sm font-bold tracking-widest transition-opacity active:opacity-75"
                      style={{
                        color: '#F2E6C8',
                        border: '1px solid rgba(232,199,122,0.72)',
                        background: 'linear-gradient(135deg, #050202 0%, #180708 48%, #5A0D12 100%)',
                      }}
                    >
                      閉じる
                    </button>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
