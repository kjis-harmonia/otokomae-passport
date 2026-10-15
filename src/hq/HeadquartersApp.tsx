import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, CalendarDays, ChartNoAxesCombined, ChevronRight, CircleHelp, CreditCard, House, LayoutDashboard, LogOut, Menu, Package, Search, Settings2, SlidersHorizontal, Store, Users, UserRound, Wallet, X, FileText } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { HQ_TABS, type HqTab } from './hqMockData'
import { HqDashboardScreen } from './screens/HqDashboardScreen'
import { HqStoresScreen } from './screens/HqStoresScreen'
import { HqCommandMenu } from './components/HqCommandMenu'
import { hqLogout, HQ_AUTH_REQUIRED_EVENT } from './hqSession'
import { isHqPreview } from './hqPreview'
import './headquarters.css'

const HqSalesScreen = lazy(() => import('./screens/HqSalesScreen').then(m => ({ default: m.HqSalesScreen })))
const HqStylistScreen = lazy(() => import('./screens/HqStylistScreen').then(m => ({ default: m.HqStylistScreen })))
const HqMembersScreen = lazy(() => import('./screens/HqMembersScreen').then(m => ({ default: m.HqMembersScreen })))
const HqClientsScreen = lazy(() => import('./screens/HqClientsScreen').then(m => ({ default: m.HqClientsScreen })))
const HqSalesLedgerScreen = lazy(() => import('./screens/HqSalesLedgerScreen').then(m => ({ default: m.HqSalesLedgerScreen })))
const HqGinpayScreen = lazy(() => import('./screens/HqGinpayScreen').then(m => ({ default: m.HqGinpayScreen })))
const HqBookingScreen = lazy(() => import('./screens/HqBookingScreen').then(m => ({ default: m.HqBookingScreen })))
const HqServiceMasterScreen = lazy(() => import('./screens/HqServiceMasterScreen').then(m => ({ default: m.HqServiceMasterScreen })))
const HqInventoryScreen = lazy(() => import('./screens/HqInventoryScreen').then(m => ({ default: m.HqInventoryScreen })))
const HqDailyReportScreen = lazy(() => import('./screens/HqDailyReportScreen').then(m => ({ default: m.HqDailyReportScreen })))
const HqSettingsScreen = lazy(() => import('./screens/HqSettingsScreen').then(m => ({ default: m.HqSettingsScreen })))
const HqReservationScreen = lazy(() => import('./screens/HqReservationScreen').then(m => ({ default: m.HqReservationScreen })))

const ICONS: Record<HqTab, LucideIcon> = { dashboard: LayoutDashboard, stores: Store, sales: ChartNoAxesCombined, stylist: UserRound, members: Users, customers: Users, ledger: CalendarDays, ginpay: Wallet, register: CreditCard, menus: SlidersHorizontal, booking: CalendarDays, inventory: Package, reports: FileText, settings: Settings2 }
const GROUPS: { label: string; tabs: HqTab[] }[] = [
  { label: '全体をみる', tabs: ['dashboard', 'stores', 'sales', 'stylist'] },
  { label: 'お客様', tabs: ['customers', 'members'] },
  { label: '店舗の運営', tabs: ['ledger', 'register', 'ginpay', 'inventory', 'reports'] },
  { label: '管理', tabs: ['menus', 'booking', 'settings'] },
]
const DESCRIPTIONS: Record<HqTab, string> = {
  dashboard: '売上・予約・店舗運営の状況。', stores: '接続されている店舗の状況を確認。', sales: '確定した会計から、売上の動きを知る。',
  stylist: '一人ひとりの仕事を、同じ基準で。', members: '会員と店舗のつながりを見渡す。', customers: 'お客様の情報と、これまでの来店。',
  ledger: '予約と来店の流れを確認。', register: '確定した会計と取消の記録。', ginpay: '残高と取引を、台帳から確認。', inventory: '在庫数と発注が必要な商品。',
  reports: '一日の記録を、振り返りやすく。', menus: '予約と会計で使う、共通のメニュー。', booking: 'スタッフ・シフト・営業時間を管理。', settings: '本部の表示と接続情報。',
}

function currentTab(): HqTab {
  return HQ_TABS.find(t => t.id === window.location.hash.slice(1))?.id ?? 'dashboard'
}

export function HeadquartersApp() {
  const [tab, setTab] = useState<HqTab>(currentTab)
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const mobileDialog = useRef<HTMLDialogElement>(null)
  const helpDialog = useRef<HTMLDialogElement>(null)
  const preview = isHqPreview()
  const label = HQ_TABS.find(t => t.id === tab)?.label ?? ''
  const isSb = tab === 'ledger'

  useEffect(() => {
    const onHash = () => { if (window.location.hash === '#hq-content') return; setTab(currentTab()); setMenuOpen(false); window.scrollTo(0, 0) }
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(p => !p) }
    }
    window.addEventListener('hashchange', onHash)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('keydown', onKey) }
  }, [])
  useEffect(() => { document.title = label + ' · 銀二郎本部' }, [label])
  useEffect(() => { try { document.documentElement.dataset.hqTextScale = localStorage.getItem('ginjiro_hq_text_scale') ?? 'standard' } catch { /* Optional display preference. */ } }, [])
  useEffect(() => { if (menuOpen) mobileDialog.current?.showModal(); else mobileDialog.current?.close() }, [menuOpen])
  useEffect(() => { if (helpOpen) helpDialog.current?.showModal(); else helpDialog.current?.close() }, [helpOpen])

  function navigate(next: HqTab) { setTab(next); setMenuOpen(false); window.location.hash = next; window.scrollTo(0, 0) }
  async function lock() { await hqLogout(); window.dispatchEvent(new Event(HQ_AUTH_REQUIRED_EVENT)) }

  function navigation() {
    return <>
      <a className="hq-brand" href="#dashboard" onClick={() => navigate('dashboard')} aria-label="銀二郎本部の概況へ"><span className="hq-brand-mark" aria-hidden="true">銀</span><span>銀二郎<span className="hq-brand-sub">本部</span></span></a>
      <div className="hq-workspace"><Store size={17} strokeWidth={1.7} /><span>銀二郎<span>店舗ワークスペース</span></span><span className="hq-workspace-dot" title="接続店舗" /></div>
      <nav className="hq-nav" aria-label="本部メニュー">{GROUPS.map(group => <div className="hq-nav-group" key={group.label}><p>{group.label}</p>{group.tabs.map(id => {
        const item = HQ_TABS.find(t => t.id === id)!
        const Icon = ICONS[id]
        return <a key={id} href={'#' + id} className={'hq-nav-item' + (tab === id ? ' is-active' : '')} aria-current={tab === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={18} strokeWidth={1.7} /><span>{item.label}</span></a>
      })}</div>)}</nav>
      <div className="hq-sidebar-footer"><span className="hq-avatar">本</span><div><strong>本部ワークスペース</strong><span>{preview ? 'サンプルを表示中' : '本部セッション'}</span></div>{!preview && <button className="hq-icon-button" onClick={() => void lock()} aria-label="本部をロック"><LogOut size={17} /></button>}</div>
    </>
  }
  function screen() {
    switch (tab) {
      case 'dashboard': return <HqDashboardScreen onNavigate={navigate} />
      case 'stores': return <HqStoresScreen onNavigate={navigate} />
      case 'sales': return <HqSalesScreen />
      case 'stylist': return <HqStylistScreen />
      case 'members': return <HqMembersScreen />
      case 'customers': return <HqClientsScreen />
      case 'ledger': return <HqReservationScreen />
      case 'register': return <HqSalesLedgerScreen />
      case 'ginpay': return <HqGinpayScreen />
      case 'menus': return <HqServiceMasterScreen />
      case 'booking': return <HqBookingScreen />
      case 'inventory': return <HqInventoryScreen />
      case 'reports': return <HqDailyReportScreen />
      case 'settings': return <HqSettingsScreen />
    }
  }
  return <div className={'hq-app' + (isSb ? ' hq-app-sb' : '')}>
    <a href="#hq-content" className="hq-skip-link">本文へ移動</a>
    <aside className="hq-sidebar">{navigation()}</aside>
    <div className="hq-main-column">
      <header className="hq-topbar"><button className="hq-icon-button hq-menu-toggle" onClick={() => setMenuOpen(true)} aria-label="本部メニューを開く"><Menu size={21} /></button><div className="hq-breadcrumb"><House size={15} /><span>本部</span><ChevronRight size={12} /><strong>{label}</strong></div><div className="hq-topbar-actions"><button className="hq-search-trigger" aria-label="本部のページを検索" onClick={() => setSearchOpen(true)}><Search size={16} /><span>ページを検索</span><kbd>⌘ K</kbd></button><button className="hq-icon-button" onClick={() => setHelpOpen(true)} aria-label="本部の使い方"><CircleHelp size={19} strokeWidth={1.7} /></button><span className="hq-topbar-avatar" aria-label="本部">本</span></div></header>
      {preview && <div className="hq-preview-banner"><span>画面プレビュー · サンプルデータ</span><span>実データへの接続・保存は行いません</span></div>}
      <main className="hq-content" id="hq-content" tabIndex={-1}>{!isSb && <div className="hq-page-heading"><div><h1>{label}</h1><p>{DESCRIPTIONS[tab]}</p></div><button className="hq-button hq-button-quiet" onClick={() => setRefreshKey(n => n + 1)}>再読み込み</button></div>}<Suspense fallback={<div className="hq-loading" role="status">データを読み込んでいます…</div>}><div key={tab + '-' + refreshKey} className="hq-screen">{screen()}</div></Suspense>{!isSb && <footer className="hq-content-footer"><span>GINJIRO HEADQUARTERS</span><span>日本標準時（JST）</span></footer>}</main>
    </div>
    <dialog ref={mobileDialog} className="hq-mobile-drawer" onClose={() => setMenuOpen(false)} onClick={event => { if (event.target === event.currentTarget) setMenuOpen(false) }}><div className="hq-mobile-drawer-inner"><button className="hq-icon-button hq-drawer-close" onClick={() => setMenuOpen(false)} aria-label="本部メニューを閉じる"><X size={20} /></button>{navigation()}</div></dialog>
    <HqCommandMenu open={searchOpen} onClose={() => setSearchOpen(false)} onNavigate={navigate} />
    <dialog ref={helpDialog} className="hq-help-dialog" onClose={() => setHelpOpen(false)}><button className="hq-icon-button hq-dialog-close" onClick={() => setHelpOpen(false)} aria-label="使い方を閉じる"><X size={19} /></button><span className="hq-eyebrow">銀二郎本部</span><h2>必要な情報に、すぐ。</h2><p>「概況」で店舗のいまを確認し、各項目から詳しい情報へ進めます。</p><ul><li>売上は確定した会計だけを集計します。</li><li>期間と日付を切り替えて振り返れます。</li><li>検索ボタン、または ⌘ / Ctrl + K でページを探せます。</li></ul><button className="hq-button hq-button-primary" onClick={() => { setHelpOpen(false); navigate('dashboard') }}>概況をみる<ArrowUpRight size={15} /></button></dialog>
  </div>
}
