import type { CSSProperties } from 'react'
import type { HqBookingTab, HqNavigate, HqRoute } from '../hqMockData'
import { HQ_COLORS, HQ_SANS } from '../hqTheme'

interface ManagementItem {
  title: string
  description: string
  route: HqRoute
  bookingTab?: HqBookingTab
}

const ITEMS: ManagementItem[] = [
  { title: 'スタッフ管理', description: '予約担当者・受付可否・出勤設定', route: 'booking', bookingTab: 'staff' },
  { title: 'サービスマスター', description: 'メニュー・価格・所要時間の管理', route: 'menus' },
  { title: '予約設定', description: 'シフト、営業時間、店休日、受付条件', route: 'booking', bookingTab: 'shifts' },
  { title: 'GINPay管理', description: '台帳、残高整合性、監査確認', route: 'ginpay' },
  { title: '会計履歴', description: '確定会計とvoid履歴の確認', route: 'register' },
  { title: '監査ログ', description: 'GINPay取引監査とreconciliation', route: 'ginpay' },
  { title: 'データ管理', description: '日報・エクスポート・集計確認', route: 'reports' },
  { title: 'システム設定', description: '本部画面の基本設定', route: 'settings' },
  { title: '予約台帳', description: '当日以外の予約検索・操作', route: 'ledger' },
  { title: '在庫管理', description: '店販・備品の在庫確認', route: 'inventory' },
  { title: 'スタッフ実績', description: '担当者別の売上・客単価', route: 'stylist' },
]

export function HqManagementScreen({ onNavigate }: { onNavigate: HqNavigate }) {
  return (
    <div style={{ display: 'grid', gap: 20, fontFamily: HQ_SANS, color: HQ_COLORS.textPrimary }}>
      <header>
        <h1 style={{ margin: 0, fontSize: 28, lineHeight: 1.2, letterSpacing: 0 }}>管理</h1>
        <p style={{ margin: '8px 0 0', color: HQ_COLORS.textSecondary, fontSize: 14, lineHeight: 1.7 }}>
          日常の入口は左ナビに集約し、低頻度の設定・監査・マスター管理はここから開きます。
        </p>
      </header>
      <section style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 12,
      }}>
        {ITEMS.map((item) => (
          <button
            key={`${item.route}-${item.title}`}
            type="button"
            onClick={() => onNavigate(item.route, item.bookingTab ? { bookingTab: item.bookingTab } : undefined)}
            style={cardStyle}
          >
            <span style={{ display: 'block', fontSize: 16, fontWeight: 700, color: HQ_COLORS.textPrimary }}>{item.title}</span>
            <span style={{ display: 'block', marginTop: 8, fontSize: 13, lineHeight: 1.6, color: HQ_COLORS.textSecondary }}>
              {item.description}
            </span>
            <span style={{ display: 'block', marginTop: 14, fontSize: 12, fontWeight: 700, color: HQ_COLORS.goldHi }}>
              開く
            </span>
          </button>
        ))}
      </section>
    </div>
  )
}

const cardStyle: CSSProperties = {
  minHeight: 132,
  padding: 16,
  borderRadius: 8,
  border: `1px solid ${HQ_COLORS.panelBorder}`,
  background: HQ_COLORS.panel,
  boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
  textAlign: 'left',
  fontFamily: HQ_SANS,
  cursor: 'pointer',
}
