// 銀二郎本部 — ダミーデータ（UIプロトタイプ段階。実データ未接続）

export type HqTab = 'dashboard' | 'sales' | 'stylist' | 'members' | 'inventory' | 'reports' | 'settings'

export const HQ_TABS: { id: HqTab; label: string; code: string }[] = [
  { id: 'dashboard', label: 'ダッシュボード', code: 'DASH' },
  { id: 'sales',     label: '売上分析',       code: 'SALES' },
  { id: 'stylist',   label: 'スタイリスト分析', code: 'STAFF' },
  { id: 'members',   label: '会員分析',       code: 'MBRS' },
  { id: 'inventory', label: '在庫管理',       code: 'STOCK' },
  { id: 'reports',   label: '日報',           code: 'REPORT' },
  { id: 'settings',  label: '設定',           code: 'CFG' },
]

export const HQ_KPI = [
  { label: '本日売上', value: '¥284,500', delta: '+12.4%', positive: true, sub: '前日比' },
  { label: '来店数',   value: '38',       delta: '+6',     positive: true, sub: '前日比' },
  { label: '客単価',   value: '¥7,486',   delta: '-2.1%',  positive: false, sub: '前日比' },
  { label: '会員増加', value: '+14',      delta: '+3',     positive: true, sub: '今週' },
]

export const HQ_WEEKLY_SALES = [
  { day: '月', value: 198000 },
  { day: '火', value: 221000 },
  { day: '水', value: 176000 },
  { day: '木', value: 254000 },
  { day: '金', value: 312000 },
  { day: '土', value: 398000 },
  { day: '日', value: 284500 },
]

export const HQ_MONTHLY_SALES = [
  { day: '1週', value: 1620000 },
  { day: '2週', value: 1840000 },
  { day: '3週', value: 1710000 },
  { day: '4週', value: 1980000 },
]

export const HQ_YEARLY_SALES = [
  { day: '1月', value: 6200000 }, { day: '2月', value: 5800000 }, { day: '3月', value: 6900000 },
  { day: '4月', value: 7100000 }, { day: '5月', value: 6700000 }, { day: '6月', value: 7400000 },
]

export const HQ_PAYMENT_MIX = [
  { label: '現金',   ratio: 38, color: '#C9A24A' },
  { label: 'カード', ratio: 41, color: '#8C1F1A' },
  { label: 'QR決済', ratio: 21, color: '#6E6557' },
]

export const HQ_MENU_RANKING = [
  { rank: 1, name: 'カット＋シェービング', count: 142, sales: 1136000 },
  { rank: 2, name: 'プレミアムカット',     count: 98,  sales: 980000 },
  { rank: 3, name: 'パーマ＋カット',       count: 54,  sales: 810000 },
  { rank: 4, name: 'カットのみ',           count: 176, sales: 704000 },
  { rank: 5, name: 'カラー＋カット',       count: 41,  sales: 615000 },
]

export const HQ_STYLISTS = [
  { name: '銀二郎',   nominations: 86, sales: 1240000, unitPrice: 9100, repeatRate: 78, rating: 4.9, occupancy: 92 },
  { name: 'テイテイ', nominations: 64, sales: 812000,  unitPrice: 7600, repeatRate: 71, rating: 4.7, occupancy: 84 },
  { name: 'フリー',   nominations: 51, sales: 598000,  unitPrice: 6900, repeatRate: 63, rating: 4.6, occupancy: 76 },
]

export const HQ_MEMBER_RANKS = [
  { label: 'プラチナ', count: 42,  color: '#E5C063' },
  { label: 'ゴールド', count: 118, color: '#C9A24A' },
  { label: 'シルバー', count: 264, color: '#B8AC93' },
  { label: 'ブロンズ', count: 410, color: '#8A6E3C' },
]

export const HQ_MEMBER_TREND = [
  { month: '1月', newCount: 28, churnCount: 9 },
  { month: '2月', newCount: 31, churnCount: 11 },
  { month: '3月', newCount: 26, churnCount: 7 },
  { month: '4月', newCount: 39, churnCount: 12 },
  { month: '5月', newCount: 34, churnCount: 8 },
  { month: '6月', newCount: 42, churnCount: 10 },
]

export const HQ_TOP_MEMBERS = [
  { rank: 1, name: 'M.T 様', rankTier: 'プラチナ', ltv: 482000, visits: 61 },
  { rank: 2, name: 'K.S 様', rankTier: 'プラチナ', ltv: 451000, visits: 58 },
  { rank: 3, name: 'Y.H 様', rankTier: 'ゴールド', ltv: 398000, visits: 49 },
  { rank: 4, name: 'R.O 様', rankTier: 'ゴールド', ltv: 372000, visits: 44 },
  { rank: 5, name: 'A.N 様', rankTier: 'ゴールド', ltv: 340000, visits: 41 },
]

export const HQ_ALERTS = [
  { label: '本日の予約残数', value: '4枠', tone: 'warn' as const },
  { label: 'シャンプー在庫', value: '残り少', tone: 'warn' as const },
  { label: '会員カード発行待ち', value: '2件', tone: 'info' as const },
  { label: 'システム稼働状況', value: '正常', tone: 'ok' as const },
]
