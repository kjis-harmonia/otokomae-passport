import type { WalletAccent, WalletCard } from '../../data/wallet'
import { isWelcomeCouponTicket } from '../../utils/welcomeCoupon'

export const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

export const IVORY     = '#F2E6C8'
export const GOLD      = '#C9A24A'
export const GOLD_HI   = '#E5C063'
export const CRIMSON   = '#B8323A'

export interface CardTheme {
  background: string
  border:     string
  frontBorder: string
  hairline:   string
  accent:     string   // 価格・強調色
  glow:       string
}

export const CARD_THEMES: Record<WalletAccent, CardTheme> = {
  // CUT：黒 × 深紅 × 静かな金
  'crimson-gold': {
    background: 'radial-gradient(120% 90% at 100% 0%, rgba(120,18,28,0.34) 0%, transparent 55%), linear-gradient(158deg, #170709 0%, #0C0405 55%, #070405 100%)',
    border:     'rgba(201,162,74,0.20)',
    frontBorder:'rgba(214,176,92,0.62)',
    hairline:   'linear-gradient(90deg, transparent 0%, #7A1620 25%, rgba(201,162,74,0.8) 50%, #7A1620 75%, transparent 100%)',
    accent:     GOLD,
    glow:       'rgba(201,162,74,0.10)',
  },
  // GINJIRO CLASSICS：王道の深紅 × 金
  'premium-classic': {
    background: 'radial-gradient(90% 70% at 88% 0%, rgba(229,192,99,0.20) 0%, transparent 60%), radial-gradient(90% 80% at 0% 100%, rgba(139,26,42,0.42) 0%, transparent 62%), linear-gradient(160deg, #1B0B08 0%, #0E0605 50%, #080404 100%)',
    border:     'rgba(229,192,99,0.30)',
    frontBorder:'rgba(240,206,120,0.86)',
    hairline:   'linear-gradient(90deg, transparent 0%, #9A7B1C 18%, #F3D98A 50%, #9A7B1C 82%, transparent 100%)',
    accent:     GOLD_HI,
    glow:       'rgba(229,192,99,0.20)',
  },
  // SPECIAL PERM：少し攻めた赤黒
  'premium-special': {
    background: 'radial-gradient(90% 80% at 85% 5%, rgba(185,42,64,0.30) 0%, transparent 58%), radial-gradient(85% 75% at 0% 100%, rgba(229,192,99,0.16) 0%, transparent 62%), linear-gradient(160deg, #1A070B 0%, #100507 55%, #070303 100%)',
    border:     'rgba(214,86,90,0.28)',
    frontBorder:'rgba(229,192,99,0.78)',
    hairline:   'linear-gradient(90deg, transparent 0%, rgba(184,50,58,0.9) 20%, #F3D98A 50%, rgba(184,50,58,0.9) 80%, transparent 100%)',
    accent:     '#F0C66C',
    glow:       'rgba(184,50,58,0.18)',
  },
  // GINPARA：黒 × 銀 × 金
  'premium-ginpara': {
    background: 'radial-gradient(90% 75% at 90% 0%, rgba(216,208,190,0.18) 0%, transparent 60%), radial-gradient(80% 70% at 0% 100%, rgba(201,162,74,0.18) 0%, transparent 62%), linear-gradient(160deg, #151515 0%, #090909 56%, #050505 100%)',
    border:     'rgba(216,208,190,0.24)',
    frontBorder:'rgba(232,220,190,0.72)',
    hairline:   'linear-gradient(90deg, transparent 0%, rgba(216,208,190,0.8) 25%, #F3D98A 50%, rgba(216,208,190,0.8) 75%, transparent 100%)',
    accent:     '#E6D8B8',
    glow:       'rgba(216,208,190,0.14)',
  },
  // 漢トク券 ¥300：ブロンズ
  'otoku-300': {
    background: 'radial-gradient(100% 80% at 100% 0%, rgba(176,110,58,0.20) 0%, transparent 60%), linear-gradient(158deg, #140D08 0%, #0A0706 60%, #070505 100%)',
    border:     'rgba(176,110,58,0.28)',
    frontBorder:'rgba(206,140,84,0.72)',
    hairline:   'linear-gradient(90deg, transparent 0%, rgba(206,140,84,0.85) 50%, transparent 100%)',
    accent:     '#D39A62',
    glow:       'rgba(206,140,84,0.12)',
  },
  // 漢トク券 ¥1,000：金
  'otoku-1000': {
    background: 'radial-gradient(100% 80% at 100% 0%, rgba(229,192,99,0.18) 0%, transparent 60%), linear-gradient(158deg, #110E06 0%, #090805 60%, #060504 100%)',
    border:     'rgba(229,192,99,0.28)',
    frontBorder:'rgba(236,200,110,0.80)',
    hairline:   'linear-gradient(90deg, transparent 0%, rgba(243,217,138,0.9) 50%, transparent 100%)',
    accent:     GOLD_HI,
    glow:       'rgba(229,192,99,0.14)',
  },
  'otoku-default': {
    background: 'radial-gradient(100% 80% at 100% 0%, rgba(200,196,180,0.12) 0%, transparent 60%), linear-gradient(158deg, #11100D 0%, #090908 60%, #060606 100%)',
    border:     'rgba(200,196,180,0.20)',
    frontBorder:'rgba(214,208,190,0.62)',
    hairline:   'linear-gradient(90deg, transparent 0%, rgba(214,208,190,0.7) 50%, transparent 100%)',
    accent:     '#D8D0BA',
    glow:       'rgba(214,208,190,0.08)',
  },
  // 期限切れ・使用済み：彩度を落とす / Glow なし
  muted: {
    background: 'linear-gradient(158deg, #121110 0%, #0B0A0A 100%)',
    border:     'rgba(255,255,255,0.06)',
    frontBorder:'rgba(255,255,255,0.16)',
    hairline:   'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.12) 50%, transparent 100%)',
    accent:     'rgba(242,230,200,0.42)',
    glow:       'transparent',
  },
}

/** カード状態ラベルの色 */
export function statusColor(card: WalletCard): { fg: string; bg: string; border: string } {
  const isPremium = card.accent.startsWith('premium-')
  switch (card.status) {
    case 'urgent':
      return { fg: '#F4B7B0', bg: 'rgba(139,26,42,0.34)', border: 'rgba(200,60,70,0.55)' }
    case 'active':
      return isPremium
        ? { fg: '#1A0E04', bg: 'linear-gradient(135deg, #F3D98A 0%, #C9A24A 100%)', border: 'rgba(243,217,138,0.9)' }
        : { fg: GOLD_HI, bg: 'rgba(201,162,74,0.10)', border: 'rgba(201,162,74,0.38)' }
    case 'waiting':
      return { fg: 'rgba(242,230,200,0.72)', bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.12)' }
    case 'expired':
    case 'used':
      return { fg: 'rgba(242,230,200,0.42)', bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.08)' }
  }
}

export const CATEGORY_LABEL: Record<WalletCard['category'], string> = {
  cut:     'CUT',
  classic: 'CLASSICS',
  special: 'SPECIAL',
  ginpara: 'GINPARA',
  otoku:   '漢トク券',
}

export function yen(n: number): string {
  return `¥${n.toLocaleString()}`
}

/** 券が「漢トク券」本体か（固有名詞のため、割引券・Welcomeクーポンには付けない） */
export function isOtokuTicketCard(card: WalletCard): boolean {
  return card.source.kind === 'ticket' && (card.source.ticketType === 'otoku' || card.source.ticketType === 'cut-ticket')
}

/** カード左上のカテゴリ表記。チケットは券種に応じて 漢トク券 / Welcomeクーポン / 割引券 */
export function cardCategoryLabel(card: WalletCard): string {
  if (card.source.kind !== 'ticket') return CATEGORY_LABEL[card.category]
  if (isOtokuTicketCard(card)) return '漢トク券'
  if (card.source.tickets.some(isWelcomeCouponTicket)) return 'Welcomeクーポン'
  return '割引券'
}
