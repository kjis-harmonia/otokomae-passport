import { useEffect, useState, type ReactNode } from 'react'
import type { WalletCard } from '../../data/wallet'
import { CARD_THEMES, SERIF, IVORY, cardCategoryLabel, isOtokuTicketCard, statusColor, yen, type CardTheme } from './walletTheme'

export const CARD_HEIGHT = 304
/** スタック時に見えるカード上端の高さ（ヘッダー部分） */
export const CARD_STRIP = 78

// 漢前Premium の Sweep は「受付開始のタイミングで一度だけ」— セッション内で同じ状態では再生しない
const sweptKeys = new Set<string>()

function isPremiumCategory(category: WalletCard['category']): boolean {
  return category === 'classic' || category === 'special' || category === 'ginpara'
}

function useSweepOnce(key: string | null): string | null {
  const [sweepKey, setSweepKey] = useState<string | null>(null)
  useEffect(() => {
    if (!key || sweptKeys.has(key)) return
    sweptKeys.add(key)
    setSweepKey(key) // eslint-disable-line react-hooks/set-state-in-effect
  }, [key])
  return sweepKey
}

/**
 * カード本体。
 * 上端 CARD_STRIP px にカテゴリ・タイトル・状態を集約し、スタック時もそこだけで判別できる。
 * 前面（isFront）のときは状態を本文のヒーロー表示に任せ、ヘッダーのピルを省く。
 */
export function WalletCardFace({
  card,
  isFront,
  cta,
}: {
  card: WalletCard
  isFront: boolean
  cta?: ReactNode
}) {
  const theme     = CARD_THEMES[card.accent]
  const sc        = statusColor(card)
  const inactive  = card.status === 'expired' || card.status === 'used'
  const isTicket  = card.category === 'otoku'
  const isPremium = isPremiumCategory(card.category)
  const tag       = card.subtitle ?? card.eyebrow
  const heroCarriesStatus = isFront && !inactive && (card.category === 'cut' || isPremium)
  const sweep = useSweepOnce(isFront && isPremium && card.live ? `${card.id}:${card.statusLabel}` : null)

  return (
    <div
      className={`wallet-grain${isTicket ? ' wallet-ticket-notch' : ''}`}
      style={{
        position: 'relative',
        height: CARD_HEIGHT,
        borderRadius: 24,
        background: theme.background,
        border: `1px solid ${isFront ? theme.frontBorder : theme.border}`,
        boxShadow: isFront && !inactive
          ? `inset 0 1px 0 rgba(242,230,200,0.08), inset 0 0 48px ${theme.glow}`
          : 'inset 0 1px 0 rgba(242,230,200,0.05)',
        overflow: 'hidden',
        filter: inactive ? 'saturate(0.2) brightness(0.8)' : undefined,
        display: 'flex',
        flexDirection: 'column',
        padding: '16px 20px 16px',
        boxSizing: 'border-box',
        transition: 'border-color 240ms ease',
      }}
    >
      {/* 透かし */}
      <span aria-hidden="true" style={{
        position: 'absolute', right: isTicket ? '30%' : -18, bottom: -64,
        fontFamily: SERIF, fontSize: 220, fontWeight: 700, lineHeight: 1,
        color: theme.accent, opacity: 0.045, pointerEvents: 'none', userSelect: 'none',
      }}>銀</span>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: isPremium ? 2 : 1.5, background: theme.hairline, opacity: inactive ? 0.4 : 1 }} />
      {sweep && <span key={sweep} className="wallet-sweep" aria-hidden="true" />}

      {/* ── Header (CARD_STRIP) ── */}
      <div style={{ position: 'relative', height: CARD_STRIP - 16, flexShrink: 0, paddingRight: isTicket ? '28%' : 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, height: 24 }}>
          <p style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, fontSize: 11, letterSpacing: '0.16em', whiteSpace: 'nowrap' }}>
            <span style={{ fontWeight: 700, color: theme.accent }}>{cardCategoryLabel(card)}</span>
            <span style={{ width: 3, height: 3, borderRadius: 9, background: 'rgba(242,230,200,0.3)', flexShrink: 0 }} />
            <span style={{ color: 'rgba(242,230,200,0.56)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tag}</span>
          </p>
          {!heroCarriesStatus && (
            <span style={{
              flexShrink: 0, fontSize: 12, fontWeight: 700, letterSpacing: '0.04em',
              padding: '4px 11px', borderRadius: 999,
              color: sc.fg, background: sc.bg, border: `1px solid ${sc.border}`, whiteSpace: 'nowrap',
            }}>
              {card.statusLabel}
            </span>
          )}
        </div>
        <h3 style={{
          marginTop: 6,
          fontFamily: SERIF, fontSize: 24, fontWeight: 700, color: IVORY,
          letterSpacing: '0.05em', lineHeight: 1.2,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {card.title}
        </h3>
      </div>

      {/* ── Hero ── */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', paddingRight: isTicket ? '28%' : 0 }}>
        {card.category === 'cut' && <CutHero card={card} theme={theme} />}
        {isPremium && <PermHero card={card} theme={theme} />}
        {card.category === 'otoku' && <TicketHero card={card} theme={theme} />}
      </div>

      {/* ── Footer ── */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 12, minHeight: 40, paddingRight: isTicket ? '28%' : 0 }}>
        <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.5)', letterSpacing: '0.04em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
          {isFront && !isTicket ? '詳細  ›' : ''}
        </p>
        {isFront && cta}
      </div>

      {isTicket && <TicketStub card={card} theme={theme} />}
      {card.status === 'used' && <UsedStamp />}
    </div>
  )
}

// ── Heroes ────────────────────────────────────────────────────────────────────

function PriceRows({ card, accent }: { card: WalletCard; accent: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {card.prices.map(p => (
        <div key={p.label ?? p.memberPrice} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 'clamp(12px, 3.6vw, 13.5px)', color: 'rgba(242,230,200,0.78)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
            {p.shortLabel ?? p.label}
          </span>
          <span aria-hidden="true" style={{ flex: 1, minWidth: 10, borderBottom: '1px dotted rgba(242,230,200,0.14)', transform: 'translateY(-4px)' }} />
          {p.normalPrice !== undefined && (
            <span style={{ fontSize: 12, color: 'rgba(242,230,200,0.4)', textDecoration: 'line-through', flexShrink: 0 }}>{yen(p.normalPrice)}</span>
          )}
          <span style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: accent, flexShrink: 0, lineHeight: 1.1 }}>{yen(p.memberPrice)}</span>
        </div>
      ))}
    </div>
  )
}

function CycleRing({ remaining, total, color }: { remaining: number | null; total: number; color: string }) {
  const r = 26
  const c = 2 * Math.PI * r
  const ratio = remaining === null ? 0 : Math.max(0, Math.min(1, remaining / total))
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(242,230,200,0.08)" strokeWidth="3" />
      <circle
        cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round"
        strokeDasharray={`${c * ratio} ${c}`} transform="rotate(-90 32 32)"
        style={{ transition: 'stroke-dasharray 600ms cubic-bezier(0.2,0,0,1)' }}
      />
      <text x="32" y="29" textAnchor="middle" fontSize="7.5" letterSpacing="1.5" fill="rgba(242,230,200,0.45)">DAY</text>
      <text x="32" y="43" textAnchor="middle" fontSize="14" fontWeight="700" fill="rgba(242,230,200,0.88)" fontFamily={SERIF}>
        {remaining === null ? '–' : Math.max(remaining, 0)}
      </text>
    </svg>
  )
}

function CutHero({ card, theme }: { card: WalletCard; theme: CardTheme }) {
  const remaining = card.cycle?.remaining ?? null
  const color = card.status === 'urgent' ? '#E0626A' : theme.accent

  let big: ReactNode
  if (remaining === null) {
    big = <p style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: 'rgba(242,230,200,0.7)' }}>来店登録で開始</p>
  } else if (remaining < 0) {
    big = <p style={{ fontFamily: SERIF, fontSize: 24, fontWeight: 700, color: 'rgba(242,230,200,0.55)' }}>期限切れ</p>
  } else {
    big = (
      <p style={{ display: 'flex', alignItems: 'baseline', gap: 6, lineHeight: 1 }}>
        <span style={{ fontSize: 12, letterSpacing: '0.12em', color: 'rgba(242,230,200,0.6)' }}>
          {remaining === 0 ? '本日まで' : remaining === 1 ? '明日まで' : '残り'}
        </span>
        <span style={{ fontFamily: SERIF, fontSize: 52, fontWeight: 700, color, letterSpacing: '-0.01em' }}>{remaining}</span>
        <span style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color }}>日</span>
      </p>
    )
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        {big}
        <CycleRing remaining={remaining} total={card.cycle?.total ?? 14} color={color} />
      </div>
      <PriceRows card={card} accent={theme.accent} />
    </>
  )
}

function PermHero({ card, theme }: { card: WalletCard; theme: CardTheme }) {
  const badge = card.source.kind === 'coupon' ? card.source.definition.memberBadge : undefined
  return (
    <>
      {badge && (
        <p style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, whiteSpace: 'nowrap' }}>
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '0.16em', color: '#1A0E04',
            padding: '3px 8px', borderRadius: 4, background: 'linear-gradient(135deg, #F3D98A 0%, #C9A24A 100%)',
          }}>{badge.en}</span>
          <span style={{ fontSize: 12, color: 'rgba(242,230,200,0.7)' }}>{badge.ja}</span>
        </p>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, minWidth: 0 }}>
        <span className={card.live ? 'wallet-live-dot' : undefined} style={{
          width: 8, height: 8, borderRadius: 99, flexShrink: 0,
          background: card.live ? '#F3D98A' : 'rgba(242,230,200,0.3)',
        }} />
        <p style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 700, color: card.live ? IVORY : 'rgba(242,230,200,0.72)', whiteSpace: 'nowrap' }}>
          {card.statusLabel}
        </p>
        {card.statusHint && (
          <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.5)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
            {card.statusHint}
          </p>
        )}
      </div>
      <PriceRows card={card} accent={theme.accent} />
    </>
  )
}

function TicketHero({ card, theme }: { card: WalletCard; theme: CardTheme }) {
  const amount = card.prices[0]?.memberPrice
  return (
    <div>
      {isOtokuTicketCard(card) && (
        <p style={{ fontSize: 11, letterSpacing: '0.2em', color: 'rgba(242,230,200,0.46)', marginBottom: 6 }}>おとくけん</p>
      )}
      {amount !== undefined && (
        <p style={{ fontFamily: SERIF, fontSize: 46, fontWeight: 700, color: theme.accent, lineHeight: 1, letterSpacing: '0.01em' }}>
          {yen(amount)}
        </p>
      )}
    </div>
  )
}

/** 漢トク券の半券（切り取り線の右側） */
function TicketStub({ card, theme }: { card: WalletCard; theme: CardTheme }) {
  return (
    <div style={{
      position: 'absolute', top: 0, bottom: 0, right: 0, width: '26%',
      borderLeft: '1.5px dashed rgba(242,230,200,0.16)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
    }}>
      <span style={{ fontSize: 10, letterSpacing: '0.2em', color: 'rgba(242,230,200,0.42)' }}>保有</span>
      <span style={{ fontFamily: SERIF, fontSize: 34, fontWeight: 700, color: theme.accent, lineHeight: 1 }}>{card.count ?? 1}</span>
      <span style={{ fontSize: 11, color: 'rgba(242,230,200,0.5)' }}>枚</span>
    </div>
  )
}

function UsedStamp() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute', right: '32%', top: '50%',
        transform: 'rotate(-12deg)',
        padding: '4px 14px',
        border: '2px solid rgba(242,230,200,0.32)',
        borderRadius: 6,
        fontSize: 20, fontWeight: 800, letterSpacing: '0.3em',
        color: 'rgba(242,230,200,0.32)',
        fontFamily: 'ui-monospace, monospace',
      }}
    >
      USED
    </div>
  )
}
