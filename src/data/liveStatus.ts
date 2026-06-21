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

export const LIVE_STATUS_LABELS: Record<LiveStatusValue, string> = {
  ready:   '予約受付中',
  limited: '残りわずか',
  full:    '本日満員',
  closed:  '受付終了',
}

export const LIVE_STATUS_COLORS: Record<LiveStatusValue, {
  color: string
  glow: string
  border: string
}> = {
  ready:   { color: '#F0DC8C', glow: 'rgba(201,162,74,0.55)', border: 'rgba(201,162,74,0.65)' },
  limited: { color: '#E06050', glow: 'rgba(139,26,26,0.55)',  border: 'rgba(139,26,26,0.65)' },
  full:    { color: 'rgba(242,230,200,0.40)', glow: 'transparent', border: 'rgba(255,255,255,0.08)' },
  closed:  { color: 'rgba(242,230,200,0.30)', glow: 'transparent', border: 'rgba(255,255,255,0.06)' },
}

// 「フリー」だけ READY時のラベルが異なる
export function liveStatusLabel(seatId: string, status: LiveStatusValue): string {
  if (seatId === 'free' && status === 'ready') return '受付可能'
  return LIVE_STATUS_LABELS[status]
}
