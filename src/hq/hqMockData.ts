import { JOHNNY_UI_ENABLED } from '../utils/johnnyFlag'
// 銀二郎本部 — ナビゲーション定義。低頻度機能は「管理」配下へ集約する。

export type HqPrimaryTab = 'today' | 'customers' | 'sales' | 'johnny' | 'admin'
export type HqRoute =
  | HqPrimaryTab
  | 'ledger'
  | 'ginpay'
  | 'register'
  | 'menus'
  | 'booking'
  | 'inventory'
  | 'reports'
  | 'settings'
  | 'stylist'
  | 'members'
  | 'dashboard'

export type HqTab = HqRoute
export type HqSalesPreset = 'today' | 'month' | 'custom'
export type HqBookingTab = 'shifts' | 'staff' | 'hours' | 'settings'

export interface HqNavigationOptions {
  salesPreset?: HqSalesPreset
  bookingTab?: HqBookingTab
}

export type HqNavigate = (route: HqRoute, options?: HqNavigationOptions) => void

export interface HqNavItem {
  id: HqRoute
  label: string
  code: string
}

const BASE_PRIMARY_TABS: HqNavItem[] = [
  { id: 'today', label: '今日の営業', code: 'TODAY' },
  { id: 'customers', label: '顧客管理', code: 'CLIENTS' },
  { id: 'sales', label: '売上分析', code: 'SALES' },
  { id: 'admin', label: '管理', code: 'ADMIN' },
]

// JOHNNY は VITE_JOHNNY_ENABLED のビルドでだけ（Production では表示しない）
export const HQ_PRIMARY_TABS: HqNavItem[] = JOHNNY_UI_ENABLED
  ? BASE_PRIMARY_TABS.flatMap((t) => t.id === 'admin' ? [{ id: 'johnny' as const, label: 'JOHNNY', code: 'AI' }, t] : [t])
  : BASE_PRIMARY_TABS

export const HQ_ROUTE_LABELS: Record<HqRoute, string> = {
  today: '今日の営業',
  customers: '顧客管理',
  sales: '売上分析',
  johnny: 'JOHNNY',
  admin: '管理',
  ledger: '予約台帳',
  ginpay: 'GINPay管理',
  register: '会計履歴',
  menus: 'サービスマスター',
  booking: '予約設定',
  inventory: '在庫管理',
  reports: 'データ管理',
  settings: 'システム設定',
  stylist: 'スタッフ実績',
  members: '会員分析',
  dashboard: '旧ダッシュボード',
}

export const HQ_TABS = HQ_PRIMARY_TABS
