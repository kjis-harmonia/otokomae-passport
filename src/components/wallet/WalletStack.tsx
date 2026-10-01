import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import {
  AnimatePresence, LayoutGroup, motion,
  useMotionTemplate, useMotionValue, useReducedMotion, useTransform,
  type PanInfo,
} from 'framer-motion'
import type { WalletCard } from '../../data/wallet'
import { WalletCardFace, CARD_HEIGHT, CARD_STRIP } from './WalletCardFace'

const SPRING  = { type: 'spring', stiffness: 380, damping: 36, mass: 0.9 } as const
const INSTANT = { duration: 0 } as const

const SWIPE_DISTANCE = 70
const SWIPE_VELOCITY = 450

/**
 * Smart Wallet スタック。
 *   - 最上段：いま使うべきカードを大きく（左右スワイプで次/前へ、タップで詳細）
 *   - その下：残りのカードが上端だけ見える形で重なる（タップで最上段へ移動）
 * カードは layoutId で最上段とスタックの間をシームレスに移動する。
 * スタック自体がページの縦スクロールに乗るので、スワイプが分からなくても全カードに届く。
 */
export function WalletStack({
  cards,
  featuredId,
  featuredLabel,
  onFeature,
  onOpen,
  renderCta,
}: {
  cards: WalletCard[]
  featuredId: string | null
  featuredLabel: string
  onFeature: (id: string) => void
  onOpen: (card: WalletCard) => void
  renderCta: (card: WalletCard) => ReactNode
}) {
  const reduced    = useReducedMotion() ?? false
  const transition = reduced ? INSTANT : SPRING
  const topRef     = useRef<HTMLDivElement>(null)

  const featured = cards.find(c => c.id === featuredId) ?? cards[0]
  const rest     = cards.filter(c => c.id !== featured.id)

  function cycle(delta: number) {
    if (cards.length < 2) return
    const i = cards.indexOf(featured)
    onFeature(cards[(i + delta + cards.length) % cards.length].id)
  }

  /** スタックのカードを最上段へ。最上段が画面外ならまずスクロールしてから入れ替える */
  function bringToFront(card: WalletCard) {
    const el = topRef.current
    const main = el?.closest('.app-main')
    const minTop = main?.getBoundingClientRect().top ?? 0
    if (el && el.getBoundingClientRect().top < minTop) {
      el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
      window.setTimeout(() => onFeature(card.id), reduced ? 0 : 340)
    } else {
      onFeature(card.id)
    }
  }

  return (
    <LayoutGroup id="wallet-stack">
      <div ref={topRef} style={{ margin: '0 16px', scrollMarginTop: 12 }}>
        <SectionLabel>{featuredLabel}</SectionLabel>

        <div style={{ perspective: 1100 }}>
          <FeaturedCard
            key={featured.id}
            card={featured}
            reduced={reduced}
            transition={transition}
            canSwipe={cards.length > 1}
            onSwipe={cycle}
            onOpen={() => onOpen(featured)}
            cta={renderCta(featured)}
          />
        </div>

        {rest.length > 0 && (
          <>
            <SectionLabel count={rest.length} style={{ marginTop: 26 }}>ほかのカード</SectionLabel>
            <div style={{ position: 'relative' }}>
              <AnimatePresence mode="popLayout" initial={false}>
                {rest.map((card, i) => (
                  <motion.div
                    key={card.id}
                    layoutId={card.id}
                    layout
                    transition={transition}
                    initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduced ? { opacity: 0 } : { opacity: 0, y: 24, transition: { duration: 0.2 } }}
                    whileHover={reduced ? undefined : { y: -4 }}
                    whileTap={reduced ? undefined : { y: -8 }}
                    onTap={() => bringToFront(card)}
                    role="button"
                    tabIndex={0}
                    aria-label={`${card.title}（${card.statusLabel}）を前面に表示`}
                    onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bringToFront(card) }
                    }}
                    style={{
                      position: 'relative',
                      zIndex: i + 1,
                      marginTop: i === 0 ? 0 : -(CARD_HEIGHT - CARD_STRIP),
                      borderRadius: 24,
                      boxShadow: '0 -12px 28px rgba(0,0,0,0.5), 0 -1px 0 rgba(242,230,200,0.04)',
                      cursor: 'pointer',
                      outline: 'none',
                    }}
                  >
                    <WalletCardFace card={card} isFront={false} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </>
        )}
      </div>
    </LayoutGroup>
  )
}

function FeaturedCard({
  card, reduced, transition, canSwipe, onSwipe, onOpen, cta,
}: {
  card: WalletCard
  reduced: boolean
  transition: typeof SPRING | typeof INSTANT
  canSwipe: boolean
  onSwipe: (delta: number) => void
  onOpen: () => void
  cta: ReactNode
}) {
  // スワイプ量に連動してカードが奥へ傾き、光の反射が流れる
  const x       = useMotionValue(0)
  const rotateY = useTransform(x, [-200, 0, 200], [-14, 0, 14])
  const rotateZ = useTransform(x, [-200, 200], [-2, 2])
  const glareX  = useTransform(x, [-200, 200], [95, 5])
  const glare   = useMotionTemplate`radial-gradient(110% 70% at ${glareX}% 0%, rgba(255,236,190,0.13) 0%, rgba(255,236,190,0.03) 35%, transparent 60%)`

  function handleDragEnd(_: unknown, info: PanInfo) {
    if (info.offset.x < -SWIPE_DISTANCE || info.velocity.x < -SWIPE_VELOCITY) onSwipe(1)
    else if (info.offset.x > SWIPE_DISTANCE || info.velocity.x > SWIPE_VELOCITY) onSwipe(-1)
  }

  const inactive = card.status === 'expired' || card.status === 'used'

  return (
    <motion.div
      layoutId={card.id}
      layout
      transition={transition}
      className={card.status === 'urgent' ? 'wallet-urgent-glow' : undefined}
      drag={canSwipe ? 'x' : false}
      dragSnapToOrigin
      dragElastic={0.6}
      dragMomentum={false}
      onDragEnd={handleDragEnd}
      whileTap={reduced ? undefined : { scale: 0.985 }}
      onTap={(e: PointerEvent | MouseEvent | TouchEvent) => {
        // カード内 CTA のタップは詳細を開かない
        if ((e.target as Element | null)?.closest?.('[data-wallet-cta]')) return
        onOpen()
      }}
      role="button"
      tabIndex={0}
      aria-label={`${card.title}（${card.statusLabel}）の詳細を開く。左右キーでカードを切り替え`}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() }
        if (e.key === 'ArrowRight') { e.preventDefault(); onSwipe(1) }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); onSwipe(-1) }
      }}
      style={{
        x,
        rotateY: reduced ? 0 : rotateY,
        rotateZ: reduced ? 0 : rotateZ,
        position: 'relative',
        zIndex: 50,
        borderRadius: 24,
        boxShadow: '0 24px 48px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.5)',
        cursor: 'pointer',
        outline: 'none',
      }}
    >
      <WalletCardFace card={card} isFront cta={cta} />
      {!inactive && (
        <motion.div
          aria-hidden="true"
          style={{ position: 'absolute', inset: 0, borderRadius: 24, background: glare, pointerEvents: 'none' }}
        />
      )}
    </motion.div>
  )
}

function SectionLabel({ children, count, style }: { children: ReactNode; count?: number; style?: React.CSSProperties }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '0 4px 10px', ...style }}>
      <p style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.12em', color: 'rgba(242,230,200,0.86)' }}>{children}</p>
      {count !== undefined && (
        <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.42)', fontFamily: 'ui-monospace, monospace' }}>{count}</p>
      )}
    </div>
  )
}
