import type { ReactNode } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { X } from 'lucide-react'
import { useScrollLock } from '../../utils/useScrollLock'
import type { WalletCard } from '../../data/wallet'
import { CARD_THEMES, SERIF, IVORY, cardCategoryLabel, statusColor, yen } from './walletTheme'

const BOOKING_LABEL: Record<WalletCard['bookingType'], string> = {
  phone:      '電話予約限定',
  web:        'Web予約（HotPepper）／店頭でクーポンQRを提示',
  'in-store': '店頭でスタッフにQRを提示してご利用ください',
}

function fmtDate(value: string): string {
  return value.slice(0, 10).replace(/-/g, '/')
}

export function WalletDetailSheet({
  card,
  onClose,
  actions,
}: {
  card: WalletCard
  onClose: () => void
  actions: ReactNode
}) {
  useScrollLock()
  const reduced = useReducedMotion() ?? false
  const theme = CARD_THEMES[card.accent]
  const sc = statusColor(card)
  const def = card.source.kind === 'coupon' ? card.source.definition : null

  const conditions: string[] = def ? def.conditions : []
  const notes: string[] = def
    ? def.notes
    : [
        '割引の併用は1日1種類までです（同じ種類のチケットは複数枚使えます）。',
        'ご利用時はスタッフに使用QRをご提示ください。',
        '使用確定は店舗端末でのみ行われます。',
      ]

  return (
    <>
      <motion.div
        className="fixed inset-0 z-50"
        style={{ background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduced ? 0 : 0.2 }}
        onClick={onClose}
      />

      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={card.title}
        className="fixed inset-x-0 bottom-0 z-50 mx-auto"
        style={{
          maxWidth: 480,
          maxHeight: 'calc(100svh - env(safe-area-inset-top, 0px) - 24px)',
          background: 'linear-gradient(180deg, #120807 0%, #0A0504 40%)',
          borderRadius: '24px 24px 0 0',
          border: `1px solid ${theme.border}`,
          borderBottom: 'none',
          boxShadow: '0 -24px 60px rgba(0,0,0,0.7)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        initial={reduced ? { opacity: 0 } : { y: '100%' }}
        animate={reduced ? { opacity: 1 } : { y: 0 }}
        exit={reduced ? { opacity: 0 } : { y: '100%' }}
        transition={reduced ? { duration: 0 } : { type: 'spring', damping: 32, stiffness: 340 }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: theme.hairline }} />

        {/* Grabber + close */}
        <div style={{ position: 'relative', flexShrink: 0, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ width: 38, height: 4, borderRadius: 99, background: 'rgba(242,230,200,0.18)' }} />
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            style={{
              position: 'absolute', right: 10, top: 4,
              width: 40, height: 40, borderRadius: 999,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
              color: 'rgba(242,230,200,0.75)', cursor: 'pointer',
            }}
          >
            <X size={16} />
          </button>
        </div>

        <div data-modal-scroll style={{ overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '0 20px 8px', overscrollBehavior: 'contain' } as React.CSSProperties}>
          {/* Header */}
          <p style={{ fontSize: 10, letterSpacing: '0.2em', color: theme.accent, marginBottom: 6 }}>
            {cardCategoryLabel(card)} · {card.eyebrow}
          </p>
          {def?.memberBadge && (
            <span style={{
              display: 'inline-block', marginBottom: 8,
              fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
              padding: '3px 10px', borderRadius: 99,
              color: '#1A0E04', background: 'linear-gradient(135deg, #F3D98A 0%, #C9A24A 100%)',
            }}>
              {def.memberBadge.en}｜{def.memberBadge.ja}
            </span>
          )}
          {card.subtitle && (
            <p style={{ fontFamily: SERIF, fontSize: 13, color: 'rgba(242,230,200,0.6)', letterSpacing: '0.12em' }}>{card.subtitle}</p>
          )}
          <h2 style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, color: IVORY, letterSpacing: '0.05em', lineHeight: 1.25 }}>
            {card.title}
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700, padding: '4px 12px', borderRadius: 99, color: sc.fg, background: sc.bg, border: `1px solid ${sc.border}` }}>
              {card.statusLabel}
            </span>
            {card.statusHint && <span style={{ fontSize: 12, color: 'rgba(242,230,200,0.5)' }}>{card.statusHint}</span>}
            {card.count !== undefined && card.count > 1 && (
              <span style={{ fontSize: 12, color: 'rgba(242,230,200,0.6)' }}>保有 {card.count}枚</span>
            )}
          </div>
          {def && (
            <p style={{ fontSize: 14, lineHeight: 1.8, color: 'rgba(242,230,200,0.78)', marginTop: 14 }}>{def.description}</p>
          )}

          {/* 価格 */}
          {card.prices.length > 0 && (
            <Section title="価格">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {card.prices.map((p, i) => (
                  <div key={p.label ?? i} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                    <span style={{ fontSize: 13, color: 'rgba(242,230,200,0.72)' }}>
                      {p.label ?? (card.category === 'otoku' ? '額面' : 'アプリ会員価格')}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexShrink: 0 }}>
                      {p.normalPrice !== undefined && (
                        <span style={{ fontSize: 12, color: 'rgba(242,230,200,0.4)', textDecoration: 'line-through' }}>通常 {yen(p.normalPrice)}</span>
                      )}
                      <span style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: theme.accent }}>{yen(p.memberPrice)}</span>
                    </span>
                  </div>
                ))}
                {def?.extras && (
                  <p style={{ fontSize: 12, color: 'rgba(242,230,200,0.66)', lineHeight: 1.7 }}>
                    {def.extras.appliesTo}：{def.extras.items.join('＋')} 付き
                  </p>
                )}
              </div>
            </Section>
          )}

          {/* 利用条件 */}
          <Section title="利用条件">
            <ul style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {conditions.map(c => <Bullet key={c}>{c}</Bullet>)}
              {card.validFrom && card.category === 'cut' && <Bullet>前回来店：{fmtDate(card.validFrom)}</Bullet>}
              {card.validUntil
                ? <Bullet>有効期限：{fmtDate(card.validUntil)}{card.category === 'cut' ? ' まで' : ''}</Bullet>
                : card.category === 'otoku' && <Bullet>有効期限なし</Bullet>}
            </ul>
          </Section>

          {/* 予約方法 */}
          <Section title="予約方法">
            <p style={{ fontSize: 13, lineHeight: 1.7, color: 'rgba(242,230,200,0.8)' }}>{BOOKING_LABEL[card.bookingType]}</p>
            {card.phoneNumber && (
              <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: 15, color: IVORY, marginTop: 4, letterSpacing: '0.06em' }}>
                TEL {card.phoneNumber}
              </p>
            )}
          </Section>

          {/* 注意事項 */}
          <Section title="注意事項">
            <ul style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {notes.map(n => <Bullet key={n}>{n}</Bullet>)}
            </ul>
          </Section>
        </div>

        {/* CTA */}
        <div style={{
          flexShrink: 0,
          padding: '12px 20px calc(env(safe-area-inset-bottom, 0px) + 16px)',
          borderTop: '1px solid rgba(255,255,255,0.05)',
          background: 'rgba(10,5,4,0.96)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {actions}
        </div>
      </motion.div>
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <p style={{ fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.16em', color: 'rgba(242,230,200,0.9)', flexShrink: 0 }}>{title}</p>
        <span style={{ flex: 1, height: 1, background: 'linear-gradient(90deg, rgba(201,162,74,0.26), transparent)' }} />
      </div>
      {children}
    </section>
  )
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li style={{ display: 'flex', gap: 8, fontSize: 13, lineHeight: 1.7, color: 'rgba(242,230,200,0.76)' }}>
      <span style={{ color: 'rgba(201,162,74,0.7)', flexShrink: 0 }}>・</span>
      <span>{children}</span>
    </li>
  )
}
