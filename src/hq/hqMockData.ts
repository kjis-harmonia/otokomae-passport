// Headquarters navigation metadata. Business values come from authenticated RPCs.
export type HqTab = 'johnny' | 'dashboard' | 'stores' | 'sales' | 'stylist' | 'members' | 'customers' | 'ledger' | 'ginpay' | 'register' | 'menus' | 'booking' | 'inventory' | 'reports' | 'settings'

const ALL_HQ_TABS: { id: HqTab; label: string; code: string }[] = [
  { id: 'johnny', label: 'JOHNNY', code: 'JOHNNY' },
  { id: 'dashboard', label: '概況', code: 'DASH' },
  { id: 'stores', label: '店舗', code: 'STORE' },
  { id: 'sales',     label: '売上分析',       code: 'SALES' },
  { id: 'stylist',   label: 'スタッフ', code: 'STAFF' },
  { id: 'members',   label: '会員分析',       code: 'MBRS' },
  { id: 'customers', label: '顧客',           code: 'CUSTOMERS' },
  { id: 'ledger',    label: '予約台帳',       code: 'LEDGER' },
  { id: 'ginpay',    label: 'GINPay',         code: 'PAY' },
  { id: 'register',  label: '会計',           code: 'REGISTER' },
  { id: 'menus',     label: 'メニュー・価格', code: 'MENU' },
  { id: 'booking',   label: '予約設定',       code: 'BOOKING' },
  { id: 'inventory', label: '在庫管理',       code: 'STOCK' },
  { id: 'reports',   label: '日報',           code: 'REPORT' },
  { id: 'settings',  label: '設定',           code: 'CFG' },
]

// 公開用ブランチ。会計・GINPayを含め、認証後の全メニューを両環境で表示する。
export const hqTabEnabled = (id: HqTab) => ALL_HQ_TABS.some(t => t.id === id)
export const HQ_TABS = ALL_HQ_TABS
