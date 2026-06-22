export type LiveStatusValue = 'ready' | 'limited' | 'full' | 'closed'

export type LiveStatusRow = {
  id: string
  name: string
  status: LiveStatusValue
  updated_at: string
}

export const LIVE_STATUS_ORDER: LiveStatusValue[] = ['ready', 'limited', 'full', 'closed']

export function nextLiveStatus(current: LiveStatusValue): LiveStatusValue {
  const i = LIVE_STATUS_ORDER.indexOf(current)
  return LIVE_STATUS_ORDER[(i + 1) % LIVE_STATUS_ORDER.length]
}

// 英字コード表示（READY / LIMITED / FULL / CLOSED）
export const LIVE_STATUS_CODES: Record<LiveStatusValue, string> = {
  ready:   'READY',
  limited: 'LIMITED',
  full:    'FULL',
  closed:  'CLOSED',
}

export const LIVE_STATUS_LABELS: Record<LiveStatusValue, string> = {
  ready:   '予約受付中',
  limited: '残りわずか',
  full:    '本日満員',
  closed:  '受付終了',
}

// 「フリー」だけ READY時のラベルが異なる
export function liveStatusLabel(seatId: string, status: LiveStatusValue): string {
  if (seatId === 'free' && status === 'ready') return '受付可能'
  return LIVE_STATUS_LABELS[status]
}

export type LiveStatusTheme = {
  codeColor: string
  descColor: string
  border: string
  glow: string   // box-shadow value, '' for none
  ctaBg: string
  ctaBorder: string
  ctaColor: string
  dim: boolean
}

// READY: 真鍮ゴールド／LIMITED: 銀二郎らしい深紅・ワインレッド／FULL・CLOSED: 暗く沈める
export const LIVE_STATUS_THEME: Record<LiveStatusValue, LiveStatusTheme> = {
  ready: {
    codeColor: '#F6E27A',
    descColor: 'rgba(246,224,160,0.88)',
    border: 'rgba(201,162,74,0.75)',
    glow: '0 0 32px rgba(201,162,74,0.46), 0 0 64px rgba(201,162,74,0.18)',
    ctaBg: 'linear-gradient(135deg, #8B6218 0%, #D4A030 50%, #8B6218 100%)',
    ctaBorder: 'rgba(246,224,160,0.55)',
    ctaColor: '#1A0E06',
    dim: false,
  },
  limited: {
    codeColor: '#E2667A',
    descColor: 'rgba(232,180,170,0.82)',
    border: 'rgba(139,20,42,0.72)',
    glow: '0 0 32px rgba(139,20,42,0.50), 0 0 60px rgba(139,20,42,0.22)',
    ctaBg: 'linear-gradient(135deg, #4A0A14 0%, #8B1A2E 55%, #4A0A14 100%)',
    ctaBorder: 'rgba(232,180,170,0.45)',
    ctaColor: '#F2E6C8',
    dim: false,
  },
  full: {
    codeColor: 'rgba(242,230,200,0.42)',
    descColor: 'rgba(242,230,200,0.34)',
    border: 'rgba(255,255,255,0.08)',
    glow: '',
    ctaBg: '',
    ctaBorder: '',
    ctaColor: '',
    dim: true,
  },
  closed: {
    codeColor: 'rgba(242,230,200,0.30)',
    descColor: 'rgba(242,230,200,0.26)',
    border: 'rgba(255,255,255,0.06)',
    glow: '',
    ctaBg: '',
    ctaBorder: '',
    ctaColor: '',
    dim: true,
  },
}

export const LIVE_STATUS_TEL = '09028005425'

// READY/LIMITEDのみTEL CTAを出す。FULL/CLOSEDはnull（CTA非表示）。
export function liveStatusCtaLabel(status: LiveStatusValue): string | null {
  if (status === 'ready') return '今すぐTEL'
  if (status === 'limited') return '空きを確認'
  return null
}

// カード背面の「Cyber Digital Signpole」ストライプ演出（見た目のみ。liveStatusSignpole.css参照）
export function liveStatusSignpoleClass(status: LiveStatusValue): string {
  if (status === 'ready') return 'gj-signpole--ready'
  if (status === 'limited') return 'gj-signpole--limited'
  return 'gj-signpole--dim'
}

// LIMITEDのみ、枠グローにクリムゾンパルスを重ねる
export function liveStatusPulseClass(status: LiveStatusValue): string {
  return status === 'limited' ? 'gj-card-pulse-limited' : ''
}
