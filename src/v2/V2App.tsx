// 銀二郎App V2.0 の外枠：上に正式ロゴと ☰、下に浮かぶガラスのタブ3つ（ホーム｜会員QR｜次回予約）。
// チケット・ログインと引き継ぎは ☰ から開くページ、AI予約（Johnny）は全画面。どの機能も消さず、入口だけ整理する。
// 画面の切り替えは App の activeTab（お知らせのリンク ?tab=reserve・?tab=tickets もそのまま効く）。
import { useEffect, useRef, useState } from 'react'
import { CalendarClock, ChevronLeft, Home, Menu, QrCode } from 'lucide-react'
import type { NavTab } from '../data/brand'
import { JOHNNY_INTENT_EVENT } from '../features/johnny/bookingIntent'
import { ReserveScreen } from '../screens/ReserveScreen'
import { TicketWalletScreen } from '../screens/TicketWalletScreen'
import type { WalletFilter } from '../data/wallet'
import { V2Home } from './V2Home'
import { V2Qr } from './V2Qr'
import { V2Next } from './V2Next'
import { V2Menu } from './V2Menu'
import { V2Account } from './V2Account'
import './v2.css'

const TABS: { id: NavTab; label: string; icon: typeof Home }[] = [
  { id: 'home', label: 'ホーム', icon: Home },
  { id: 'qr', label: '会員QR', icon: QrCode },
  { id: 'next', label: '次回予約', icon: CalendarClock },
]

export function V2App({ activeTab, setActiveTab, ticketFilter, ticketKey, onModalChange }: {
  activeTab: NavTab; setActiveTab: (t: NavTab) => void
  ticketFilter: WalletFilter; ticketKey: number; onModalChange: (open: boolean) => void
}) {
  const [menu, setMenu] = useState(false)
  // Johnny・チケットなどを閉じたら、開く前のタブへ戻る
  const lastTab = useRef<NavTab>(activeTab === 'qr' || activeTab === 'next' ? activeTab : 'home')
  const tab: NavTab = activeTab === 'qr' || activeTab === 'next' ? activeTab : 'home'
  useEffect(() => { if (activeTab === 'home' || activeTab === 'qr' || activeTab === 'next') lastTab.current = activeTab }, [activeTab])

  // スタイルの「この髪型でAI予約する」：メニューは ReserveScreen が受け取る
  useEffect(() => {
    const open = () => setActiveTab('reserve')
    window.addEventListener(JOHNNY_INTENT_EVENT, open)
    return () => window.removeEventListener(JOHNNY_INTENT_EVENT, open)
  }, [setActiveTab])

  const back = () => setActiveTab(lastTab.current)

  if (activeTab === 'reserve') {
    return <div className="v2"><ReserveScreen onShowQr={() => setActiveTab('qr')} onClose={back} /></div>
  }
  if (activeTab === 'tickets') {
    return (
      <div className="v2" style={{ background: '#0b0605' }}>
        <div className="v2-head" style={{ background: 'none', gridTemplateColumns: 'auto 1fr' }}>
          <button type="button" className="v2-back" style={{ color: 'rgba(242,230,200,0.75)' }} onClick={back}><ChevronLeft size={18} />戻る</button>
        </div>
        <TicketWalletScreen key={`tickets-${ticketFilter}-${ticketKey}`} onModalChange={onModalChange} initialFilter={ticketFilter} />
      </div>
    )
  }

  return (
    <div className="v2">
      <header className="v2-head">
        <span />
        <img className="v2-logo" src="/images/logo-ginjiro.png" alt="二代目 銀二郎" />
        <button type="button" className="v2-round v2-glass" aria-label="メニュー" onClick={() => setMenu(true)}><Menu size={20} /></button>
      </header>

      <main className={`v2-main${tab === 'home' ? ' has-cta' : ''}`}>
        {activeTab === 'mypage'
          ? <V2Account onBack={back} />
          : tab === 'home' ? <V2Home onGinpay={() => setActiveTab('qr')} />
          : tab === 'qr' ? <V2Qr onTickets={() => setActiveTab('tickets')} />
          : <V2Next onJohnny={() => setActiveTab('reserve')} />}
      </main>

      <nav className="v2-nav v2-glass" aria-label="メインナビゲーション">
        {TABS.map(t => {
          const Icon = t.icon
          return (
            <button key={t.id} type="button" aria-current={activeTab === t.id ? 'page' : undefined} onClick={() => setActiveTab(t.id)}>
              <Icon size={22} strokeWidth={1.8} />{t.label}
            </button>
          )
        })}
      </nav>

      <V2Menu open={menu} onClose={() => setMenu(false)} onTickets={() => setActiveTab('tickets')} onAccount={() => setActiveTab('mypage')} />
    </div>
  )
}
