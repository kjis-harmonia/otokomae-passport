import { useRef, useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import type { PanInfo } from 'framer-motion'

type PScene = 'door' | 'flash' | 'shrine' | 'machine' | 'result'
type PRank = 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM'

const EASE = [0.22, 1, 0.36, 1] as const

const RANK_CARD: Record<PRank, string> = {
  BRONZE: '/images/ranks/rank-card-bronze.png',
  SILVER: '/images/ranks/rank-card-silver.png',
  GOLD: '/images/ranks/rank-card-gold.png',
  PLATINUM: '/images/ranks/rank-card-platinum.png',
}

const RANK_ACCENT: Record<PRank, string> = {
  BRONZE: 'rgba(176,130,80,0.85)',
  SILVER: 'rgba(180,185,195,0.85)',
  GOLD: 'rgba(232,199,122,0.9)',
  PLATINUM: 'rgba(200,220,240,0.9)',
}

const RANK_GLOW: Record<PRank, string> = {
  BRONZE: '0 0 36px rgba(176,130,80,0.28), 0 20px 48px rgba(0,0,0,0.56)',
  SILVER: '0 0 36px rgba(180,185,195,0.24), 0 20px 48px rgba(0,0,0,0.56)',
  GOLD: '0 0 44px rgba(232,199,122,0.36), 0 20px 48px rgba(0,0,0,0.56)',
  PLATINUM: '0 0 52px rgba(200,220,240,0.36), 0 0 80px rgba(122,13,18,0.22), 0 20px 48px rgba(0,0,0,0.56)',
}

function drawRank(): PRank {
  const r = Math.random()
  if (r < 0.07) return 'PLATINUM'
  if (r < 0.25) return 'GOLD'
  if (r < 0.55) return 'SILVER'
  return 'BRONZE'
}

// Stable particle data — generated once, outside component to avoid re-generation on re-render
const DOOR_PARTICLES = Array.from({ length: 22 }, (_, i) => ({
  id: i,
  x: 4 + (i * 4.3 + Math.sin(i * 1.7) * 18) % 92,
  y: 8 + (i * 3.9 + Math.cos(i * 1.3) * 22) % 84,
  size: 1.4 + (i % 5) * 0.5,
  delay: (i * 0.37) % 3.2,
  dur: 2.4 + (i % 7) * 0.4,
}))

const MACHINE_PARTICLES = Array.from({ length: 28 }, (_, i) => ({
  id: i,
  x: 4 + (i * 3.6 + Math.sin(i * 2.1) * 20) % 92,
  y: 10 + (i * 3.4 + Math.cos(i * 1.8) * 24) % 80,
  size: 1.6 + (i % 6) * 0.45,
  delay: (i * 0.29) % 2.8,
  dur: 2.0 + (i % 8) * 0.38,
}))

function GoldParticles({ data }: { data: typeof DOOR_PARTICLES }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {data.map((p) => (
        <motion.div
          key={p.id}
          className="absolute rounded-full"
          style={{
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: p.size,
            height: p.size,
            background: 'rgba(232,199,122,0.88)',
            boxShadow: '0 0 3px rgba(232,199,122,0.55)',
          }}
          animate={{ y: [-4, -44], opacity: [0, 0.88, 0], scale: [0.5, 1.1, 0.3] }}
          transition={{ duration: p.dur, delay: p.delay, repeat: Infinity, ease: 'easeOut' }}
        />
      ))}
    </div>
  )
}

interface Props {
  onClose: () => void
}

export function PremiumGachaExperience({ onClose }: Props) {
  const prefersReducedMotion = useReducedMotion()
  const timers = useRef<number[]>([])
  const [scene, setScene] = useState<PScene>('door')
  const [rank, setRank] = useState<PRank | null>(null)
  const [tapped, setTapped] = useState(false)
  const [drag, setDrag] = useState(0)

  function clear() {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }

  function after(ms: number, fn: () => void) {
    timers.current.push(window.setTimeout(fn, ms))
  }

  function doFlash() {
    if (scene !== 'door') return
    clear()
    setDrag(0)
    setScene('flash')
    if (prefersReducedMotion) {
      after(100, () => setScene('shrine'))
      after(260, () => setScene('machine'))
      return
    }
    after(720, () => {
      setScene('shrine')
      after(1900, () => setScene('machine'))
    })
  }

  function doTap() {
    if (scene !== 'machine' || tapped) return
    setTapped(true)
    const drawn = drawRank()
    setRank(drawn)
    if (prefersReducedMotion) {
      after(150, () => setScene('result'))
      return
    }
    after(1250, () => setScene('result'))
  }

  function handlePlayAgain() {
    clear()
    setScene('door')
    setRank(null)
    setTapped(false)
    setDrag(0)
  }

  function handleDragEnd(_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) {
    if (Math.abs(info.offset.x) >= 80) {
      doFlash()
    } else {
      setDrag(0)
    }
  }

  const dragProg = Math.min(drag / 80, 1)
  const isMachineScene = scene === 'machine' || scene === 'result'

  return (
    <motion.div
      className="fixed inset-0 z-[9999] select-none overflow-hidden bg-black"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: prefersReducedMotion ? 0.08 : 0.22 }}
    >
      {/* ── SCENE: sealed door ── */}
      <AnimatePresence>
        {scene === 'door' && (
          <motion.div
            key="scene-door"
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <img
              src="/images/publicgacha01-sealed-door.png"
              alt=""
              draggable={false}
              className="absolute inset-0 h-full w-full object-cover"
              style={{ objectPosition: 'center bottom' }}
            />

            {/* crimson radial glow behind door center */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'radial-gradient(ellipse at 50% 60%, rgba(121,13,18,0.54) 0%, rgba(60,5,8,0.25) 36%, transparent 66%)',
              }}
            />
            {/* top/bottom vignette */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'linear-gradient(180deg, rgba(0,0,0,0.62) 0%, transparent 20%, transparent 64%, rgba(0,0,0,0.82) 100%)',
              }}
            />
            {/* drag progress flash */}
            {dragProg > 0 && (
              <div
                className="pointer-events-none absolute inset-0"
                style={{
                  opacity: dragProg * 0.68,
                  background:
                    'radial-gradient(ellipse at 50% 50%, rgba(176,24,30,0.78) 0%, rgba(201,160,40,0.3) 34%, transparent 64%)',
                }}
              />
            )}

            <GoldParticles data={DOOR_PARTICLES} />

            {/* swipe UI */}
            <div className="absolute inset-x-0 bottom-[8dvh] flex flex-col items-center gap-3 px-6">
              <motion.div
                className="touch-pan-y cursor-grab overflow-hidden rounded-lg px-8 py-3 active:cursor-grabbing"
                style={{
                  background: 'rgba(5,2,2,0.76)',
                  border: '1px solid rgba(201,169,97,0.3)',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                }}
                drag="x"
                dragConstraints={{ left: -120, right: 120 }}
                dragElastic={0.05}
                onDrag={(_, info: PanInfo) => setDrag(Math.min(Math.abs(info.offset.x), 120))}
                onDragEnd={handleDragEnd}
                animate={{ x: prefersReducedMotion ? 0 : [-8, 8, -8] }}
                transition={{ duration: 2.0, repeat: Infinity, ease: EASE }}
              >
                <div className="flex items-center gap-4">
                  <motion.span
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ duration: 1.5, repeat: Infinity }}
                    style={{ color: 'rgba(201,169,97,0.88)', fontSize: 17 }}
                  >
                    ←
                  </motion.span>
                  <span style={{ color: 'rgba(242,230,200,0.76)', fontSize: 11, letterSpacing: '0.18em' }}>
                    扉を開く
                  </span>
                  <motion.span
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ duration: 1.5, repeat: Infinity, delay: 0.75 }}
                    style={{ color: 'rgba(201,169,97,0.88)', fontSize: 17 }}
                  >
                    →
                  </motion.span>
                </div>
              </motion.div>
              <p style={{ color: 'rgba(242,230,200,0.44)', fontSize: 10, letterSpacing: '0.14em' }}>
                左右にスワイプして開門
              </p>
              <button
                type="button"
                onClick={doFlash}
                style={{
                  color: 'rgba(242,230,200,0.52)',
                  fontSize: 10,
                  letterSpacing: '0.12em',
                  border: '1px solid rgba(201,169,97,0.2)',
                  background: 'rgba(5,2,2,0.42)',
                  borderRadius: 4,
                  padding: '4px 14px',
                  cursor: 'pointer',
                }}
              >
                開く
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── FLASH overlay ── */}
      <AnimatePresence>
        {scene === 'flash' && (
          <motion.div
            key="scene-flash"
            className="pointer-events-none absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 0.65, 0] }}
            exit={{ opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0.1 : 0.78, ease: EASE }}
          >
            <div
              className="absolute inset-0"
              style={{
                background:
                  'radial-gradient(ellipse at 50% 50%, rgba(232,199,122,0.94) 0%, rgba(176,24,30,0.74) 30%, rgba(80,8,12,0.62) 56%, rgba(0,0,0,0.98) 100%)',
              }}
            />
            {/* vertical light beam */}
            <div
              className="absolute bottom-0 top-0 left-1/2 -translate-x-1/2"
              style={{
                width: '9vw',
                maxWidth: 64,
                background:
                  'linear-gradient(180deg, transparent, rgba(232,199,122,0.88) 35%, rgba(176,24,30,0.68) 65%, transparent)',
                filter: 'blur(5px)',
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── SCENE: shrine approach ── */}
      <AnimatePresence>
        {scene === 'shrine' && (
          <motion.div
            key="scene-shrine"
            className="absolute inset-0"
            initial={{ opacity: 0, scale: 1.0 }}
            animate={{ opacity: 1, scale: 1.1 }}
            exit={{ opacity: 0, scale: 1.12 }}
            transition={{ duration: prefersReducedMotion ? 0.15 : 2.0, ease: EASE }}
          >
            <img
              src="/images/publicgacha02-shrine-approach.png"
              alt=""
              draggable={false}
              className="absolute inset-0 h-full w-full object-cover"
              style={{ objectPosition: 'center bottom' }}
            />
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'linear-gradient(180deg, rgba(0,0,0,0.54) 0%, transparent 26%, transparent 62%, rgba(0,0,0,0.74) 100%)',
              }}
            />
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background: 'radial-gradient(ellipse at 50% 56%, rgba(121,13,18,0.3) 0%, transparent 52%)',
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── SCENE: gacha machine ── */}
      <AnimatePresence>
        {isMachineScene && (
          <motion.div
            key="scene-machine"
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0.1 : 0.52, ease: EASE }}
          >
            <motion.div
              className="absolute inset-0"
              animate={tapped ? { scale: [1, 1.06, 1.02] } : { scale: 1 }}
              transition={{ duration: 1.1, ease: EASE }}
            >
              <img
                src="/images/publicgacha03-gacha-machine.png"
                alt=""
                draggable={false}
                className="absolute inset-0 h-full w-full object-cover"
                style={{ objectPosition: 'center bottom' }}
              />
            </motion.div>

            {/* vignette */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'linear-gradient(180deg, rgba(0,0,0,0.56) 0%, transparent 24%, transparent 66%, rgba(0,0,0,0.74) 100%)',
              }}
            />

            {/* crimson glow (pulses on tap) */}
            <motion.div
              className="pointer-events-none absolute inset-0"
              animate={
                tapped
                  ? { opacity: [0.32, 0.78, 0.36] }
                  : { opacity: [0.24, 0.38, 0.24] }
              }
              transition={
                tapped
                  ? { duration: 1.1, ease: EASE }
                  : { duration: 2.2, repeat: Infinity, ease: EASE }
              }
              style={{
                background:
                  'radial-gradient(ellipse at 50% 70%, rgba(121,13,18,0.58) 0%, rgba(60,5,8,0.24) 44%, transparent 68%)',
              }}
            />

            {/* capsule horizontal shimmer (idle) */}
            {!tapped && (
              <motion.div
                className="pointer-events-none absolute inset-x-0"
                animate={{ opacity: [0.28, 0.72, 0.28], scaleX: [0.55, 1, 0.55] }}
                transition={{ duration: 1.7, repeat: Infinity, ease: EASE }}
                style={{
                  bottom: '30%',
                  height: 3,
                  background:
                    'linear-gradient(90deg, transparent, rgba(232,199,122,0.68), rgba(176,24,30,0.52), transparent)',
                  filter: 'blur(2px)',
                }}
              />
            )}

            <GoldParticles data={MACHINE_PARTICLES} />

            {/* spin burst overlay */}
            {tapped && (
              <motion.div
                className="pointer-events-none absolute inset-0"
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 0.62, 0] }}
                transition={{ duration: 1.1, ease: EASE }}
                style={{
                  background:
                    'radial-gradient(circle at 50% 54%, rgba(232,199,122,0.48) 0%, rgba(176,24,30,0.38) 28%, transparent 58%)',
                }}
              />
            )}

            {/* tap prompt */}
            {!tapped && (
              <motion.button
                type="button"
                onClick={doTap}
                className="absolute inset-x-0 bottom-[8dvh] flex flex-col items-center gap-1 cursor-pointer"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.38, delay: 0.45, ease: EASE }}
              >
                <motion.span
                  animate={{ opacity: [0.6, 1, 0.6], y: [0, -3, 0] }}
                  transition={{ duration: 1.9, repeat: Infinity }}
                  style={{
                    color: 'rgba(232,199,122,0.9)',
                    fontSize: 11,
                    letterSpacing: '0.22em',
                    textTransform: 'uppercase',
                  }}
                >
                  TAP TO DRAW
                </motion.span>
              </motion.button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── RESULT overlay ── */}
      <AnimatePresence>
        {scene === 'result' && rank && (
          <motion.div
            key="scene-result"
            className="absolute inset-0 z-10 flex items-end justify-center px-4"
            style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 5dvh)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0.1 : 0.26, ease: EASE }}
          >
            <div
              className="pointer-events-none absolute inset-0"
              style={{ backdropFilter: 'blur(2px)', background: 'rgba(0,0,0,0.46)' }}
            />

            <motion.div
              className="relative w-full max-w-[420px] overflow-hidden rounded-xl"
              initial={{ opacity: 0, y: 44, scale: 0.88 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: prefersReducedMotion ? 0.12 : 0.5, ease: EASE }}
              style={{
                background: 'linear-gradient(160deg, #100A08 0%, #070403 55%, #1A0608 100%)',
                border: `1px solid ${RANK_ACCENT[rank]}`,
                boxShadow: RANK_GLOW[rank],
              }}
            >
              {/* accent top line */}
              <div
                style={{
                  height: 2,
                  background: `linear-gradient(90deg, transparent, ${RANK_ACCENT[rank]}, transparent)`,
                }}
              />

              <div className="px-5 py-5">
                {/* rank label */}
                <p
                  style={{
                    color: RANK_ACCENT[rank],
                    fontSize: 10,
                    letterSpacing: '0.3em',
                    marginBottom: 14,
                    fontWeight: 700,
                  }}
                >
                  {rank}
                </p>

                {/* rank card image */}
                <div
                  className="relative mb-5 w-full overflow-hidden rounded-lg"
                  style={{
                    aspectRatio: '3 / 2',
                    background: 'rgba(0,0,0,0.52)',
                    border: `1px solid ${RANK_ACCENT[rank].replace('0.85', '0.32').replace('0.9', '0.32')}`,
                    boxShadow: `inset 0 0 24px rgba(0,0,0,0.52)`,
                  }}
                >
                  <motion.img
                    src={RANK_CARD[rank]}
                    alt={rank}
                    draggable={false}
                    className="absolute inset-0 h-full w-full object-contain"
                    initial={{ opacity: 0, scale: 0.92 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.42, delay: 0.14, ease: EASE }}
                  />
                  {/* card shimmer sweep */}
                  <motion.div
                    className="pointer-events-none absolute inset-0"
                    initial={{ x: '-110%', opacity: 0 }}
                    animate={{ x: '110%', opacity: [0, 0.45, 0] }}
                    transition={{ duration: 1.3, delay: 0.28, ease: 'easeInOut' }}
                    style={{
                      background:
                        'linear-gradient(108deg, transparent 30%, rgba(232,199,122,0.38) 50%, transparent 70%)',
                    }}
                  />
                </div>

                {/* action buttons */}
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={handlePlayAgain}
                    className="w-full rounded-lg py-3 text-sm font-bold tracking-widest transition-opacity active:opacity-75"
                    style={{
                      color: '#F2E6C8',
                      border: '1px solid rgba(232,199,122,0.68)',
                      background: 'linear-gradient(135deg, #050202 0%, #180708 50%, #5A0D12 100%)',
                    }}
                  >
                    もう一度引く
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    className="w-full rounded-lg py-3 text-sm tracking-widest transition-opacity active:opacity-75"
                    style={{
                      color: 'rgba(242,230,200,0.54)',
                      border: '1px solid rgba(201,169,97,0.22)',
                      background: 'rgba(5,2,2,0.42)',
                    }}
                  >
                    ホームへ戻る
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
