import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { BarChart3, CalendarDays, Menu, MessageSquare, Search, Settings, Users, X } from 'lucide-react'
import { HQ_PRIMARY_TABS, HQ_ROUTE_LABELS, type HqNavigate, type HqPrimaryTab, type HqRoute, type HqSalesPreset, type HqBookingTab } from './hqMockData'
import { HQ_COLORS, HQ_MONO, HQ_SANS } from './hqTheme'
import { useIsMobile } from './useIsMobile'
import { HqTodayScreen } from './screens/HqTodayScreen'
import { HqSalesScreen } from './screens/HqSalesScreen'
import { HqStylistScreen } from './screens/HqStylistScreen'
import { HqClientsScreen } from './screens/HqClientsScreen'
import { HqSalesLedgerScreen } from './screens/HqSalesLedgerScreen'
import { HqGinpayScreen } from './screens/HqGinpayScreen'
import { HqBookingScreen } from './screens/HqBookingScreen'
import { HqServiceMasterScreen } from './screens/HqServiceMasterScreen'
import { HqJohnnyScreen } from './screens/HqJohnnyScreen'
import { HqInventoryScreen } from './screens/HqInventoryScreen'
import { HqDailyReportScreen } from './screens/HqDailyReportScreen'
import { HqSettingsScreen } from './screens/HqSettingsScreen'
import { HqManagementScreen } from './screens/HqManagementScreen'
import { JOHNNY_UI_ENABLED } from '../utils/johnnyFlag'
import { ReservationLedger } from '../components/booking/ReservationLedger'
import { hqBookingApi } from '../utils/bookingApi'
import { hqCustomerApi } from '../utils/customerApi'
import { hqGinpayApi } from '../utils/ginpayApi'

function fmtClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtDate(d: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).format(d)
}

function primaryFor(route: HqRoute): HqPrimaryTab {
  if (route === 'today' || route === 'customers' || route === 'sales' || route === 'johnny' || route === 'admin') return route
  if (route === 'ledger') return 'today'
  if (route === 'stylist') return 'sales'
  return 'admin'
}

const ICONS: Record<HqPrimaryTab, typeof CalendarDays> = {
  today: CalendarDays,
  customers: Users,
  sales: BarChart3,
  johnny: MessageSquare,
  admin: Settings,
}

export function HeadquartersApp() {
  const [route, setRoute] = useState<HqRoute>('today')
  const [salesPreset, setSalesPreset] = useState<HqSalesPreset>('today')
  const [bookingTab, setBookingTab] = useState<HqBookingTab>('shifts')
  const [now, setNow] = useState(() => new Date())
  const [menuOpen, setMenuOpen] = useState(false)
  const isMobile = useIsMobile()
  const safeRoute: HqRoute = route === 'johnny' && !JOHNNY_UI_ENABLED ? 'today' : route
  const activePrimary = primaryFor(safeRoute)

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  const navigate = useCallback<HqNavigate>((next, options) => {
    if (options?.salesPreset) setSalesPreset(options.salesPreset)
    if (options?.bookingTab) setBookingTab(options.bookingTab)
    setRoute(next)
    setMenuOpen(false)
  }, [])

  const screen = useMemo(() => {
    switch (safeRoute) {
      case 'today':
        return <HqTodayScreen onNavigate={navigate} />
      case 'customers':
        return <HqClientsScreen />
      case 'sales':
        return <HqSalesScreen key={salesPreset} initialPreset={salesPreset} onNavigate={navigate} />
      case 'johnny':
        return JOHNNY_UI_ENABLED ? <HqJohnnyScreen /> : <HqTodayScreen onNavigate={navigate} />
      case 'admin':
        return <HqManagementScreen onNavigate={navigate} />
      case 'ledger':
        return <ReservationLedger api={hqBookingApi} customers={hqCustomerApi} ginpay={hqGinpayApi} bottomGap={isMobile ? 32 : 28} />
      case 'ginpay':
        return <HqGinpayScreen />
      case 'register':
        return <HqSalesLedgerScreen />
      case 'menus':
        return <HqServiceMasterScreen />
      case 'booking':
        return <HqBookingScreen key={bookingTab} initialTab={bookingTab} />
      case 'inventory':
        return <HqInventoryScreen />
      case 'reports':
        return <HqDailyReportScreen />
      case 'settings':
        return <HqSettingsScreen />
      case 'stylist':
        return <HqStylistScreen />
      default:
        return <HqManagementScreen onNavigate={navigate} />
    }
  }, [bookingTab, isMobile, navigate, safeRoute, salesPreset])

  const nav = (
    <nav style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '0 12px' }} aria-label="本部ナビゲーション">
      {HQ_PRIMARY_TABS.map((item) => {
        const active = item.id === activePrimary
        const Icon = ICONS[item.id as HqPrimaryTab]
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => navigate(item.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              minHeight: 42,
              padding: '0 12px',
              border: 'none',
              borderRadius: 7,
              background: active ? '#2563EB' : 'transparent',
              color: active ? '#FFFFFF' : '#B8C4D4',
              fontFamily: HQ_SANS,
              fontSize: 14,
              fontWeight: active ? 700 : 500,
              cursor: 'pointer',
              textAlign: 'left',
              width: '100%',
            }}
          >
            <Icon size={18} strokeWidth={2} aria-hidden="true" />
            <span style={{ flex: '1 1 auto' }}>{item.label}</span>
          </button>
        )
      })}
    </nav>
  )

  if (isMobile) {
    return (
      <div style={appStyle}>
        <header style={mobileHeaderStyle}>
          <button type="button" onClick={() => setMenuOpen(true)} aria-label="メニューを開く" style={mobileIconButtonStyle}>
            <Menu size={20} />
          </button>
          <div style={{ minWidth: 0 }}>
            <p style={smallLabelStyle}>GINJIRO HQ</p>
            <h1 style={mobileTitleStyle}>{HQ_ROUTE_LABELS[safeRoute]}</h1>
          </div>
          <span style={{ fontFamily: HQ_MONO, fontSize: 12, color: HQ_COLORS.textSecondary }}>{fmtClock(now)}</span>
        </header>

        <main style={{ flex: '1 1 auto', overflowY: 'auto', padding: 14 }}>
          {screen}
        </main>

        {menuOpen && (
          <div role="presentation" onClick={() => setMenuOpen(false)} style={drawerBackdropStyle}>
            <aside onClick={(e) => e.stopPropagation()} style={drawerStyle}>
              <div style={brandBlockStyle}>
                <div>
                  <p style={sidebarEyebrowStyle}>GINJIRO HQ</p>
                  <h2 style={sidebarTitleStyle}>銀二郎 本部</h2>
                </div>
                <button type="button" onClick={() => setMenuOpen(false)} aria-label="メニューを閉じる" style={closeButtonStyle}>
                  <X size={18} />
                </button>
              </div>
              {nav}
            </aside>
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={appStyle}>
      <aside style={sidebarStyle}>
        <div style={brandBlockStyle}>
          <div>
            <p style={sidebarEyebrowStyle}>GINJIRO HQ</p>
            <h1 style={sidebarTitleStyle}>銀二郎 本部</h1>
          </div>
        </div>
        {nav}
        <div style={{ marginTop: 'auto', padding: '18px 22px 0' }}>
          <p style={{ margin: 0, color: '#8EA0B8', fontSize: 12, lineHeight: 1.6 }}>
            単店舗運営用の本部画面です。日常操作は上の5分類から開始します。
          </p>
        </div>
      </aside>

      <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header style={topbarStyle}>
          <button type="button" onClick={() => navigate('customers')} style={searchButtonStyle}>
            <Search size={17} aria-hidden="true" />
            <span>顧客検索を開く</span>
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, color: HQ_COLORS.textSecondary, fontSize: 13 }}>
            <span>{fmtDate(now)}</span>
            <span style={{ fontFamily: HQ_MONO }}>{fmtClock(now)}</span>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: 30,
              padding: '0 10px',
              borderRadius: 999,
              background: '#EEF2F6',
              color: HQ_COLORS.textSecondary,
              fontWeight: 700,
            }}>
              管理者
            </span>
          </div>
        </header>
        <main style={mainStyle}>
          {screen}
        </main>
      </div>
    </div>
  )
}

const appStyle: CSSProperties = {
  minHeight: '100dvh',
  background: HQ_COLORS.bg,
  color: HQ_COLORS.textPrimary,
  display: 'flex',
  fontFamily: HQ_SANS,
}

const sidebarStyle: CSSProperties = {
  width: 224,
  flexShrink: 0,
  background: HQ_COLORS.sidebar,
  display: 'flex',
  flexDirection: 'column',
  padding: '22px 0',
  boxShadow: '1px 0 0 rgba(15,23,42,0.12)',
}

const brandBlockStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  padding: '0 22px',
  marginBottom: 28,
}

const sidebarEyebrowStyle: CSSProperties = {
  margin: 0,
  color: '#8EA0B8',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0,
}

const sidebarTitleStyle: CSSProperties = {
  margin: '4px 0 0',
  color: '#FFFFFF',
  fontSize: 18,
  fontWeight: 800,
  letterSpacing: 0,
}

const topbarStyle: CSSProperties = {
  flexShrink: 0,
  minHeight: 62,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  padding: '0 24px',
  background: '#FFFFFF',
  borderBottom: `1px solid ${HQ_COLORS.panelBorder}`,
}

const searchButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 38,
  padding: '0 14px',
  borderRadius: 7,
  border: `1px solid ${HQ_COLORS.panelBorder}`,
  background: '#FFFFFF',
  color: HQ_COLORS.textSecondary,
  fontFamily: HQ_SANS,
  fontSize: 13,
  cursor: 'pointer',
}

const mainStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflowY: 'auto',
  padding: 24,
}

const mobileHeaderStyle: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 100,
  minHeight: 58,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '0 14px',
  background: '#FFFFFF',
  borderBottom: `1px solid ${HQ_COLORS.panelBorder}`,
}

const mobileIconButtonStyle: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 7,
  border: `1px solid ${HQ_COLORS.panelBorder}`,
  background: '#FFFFFF',
  color: HQ_COLORS.textPrimary,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
}

const smallLabelStyle: CSSProperties = {
  margin: 0,
  color: HQ_COLORS.textMute,
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: 0,
}

const mobileTitleStyle: CSSProperties = {
  margin: '2px 0 0',
  fontSize: 16,
  lineHeight: 1.2,
  fontWeight: 800,
  letterSpacing: 0,
}

const drawerBackdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 300,
  background: 'rgba(15,23,42,0.38)',
}

const drawerStyle: CSSProperties = {
  width: 292,
  maxWidth: '86vw',
  height: '100%',
  background: HQ_COLORS.sidebar,
  padding: '22px 0',
  boxShadow: '12px 0 30px rgba(15,23,42,0.22)',
}

const closeButtonStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 7,
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(255,255,255,0.06)',
  color: '#FFFFFF',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
}
