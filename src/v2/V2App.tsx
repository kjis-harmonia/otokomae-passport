// 銀二郎App V2.0 の外枠：上に正式ロゴと ☰、下に浮かぶガラスのタブ4つ（ホーム｜会員QR｜次回予約｜ガチャ）。
// チケット・ログインと引き継ぎは ☰ から開くページ、AI予約（Johnny）は全画面。どの機能も消さず、入口だけ整理する。
// 画面の切り替えは App の activeTab（お知らせのリンク ?tab=reserve・?tab=tickets もそのまま効く）。
import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarClock, ChevronLeft, CircleHelp, Home, Menu, QrCode, Sparkles } from 'lucide-react'
import { openCustomerGuide } from '../components/guide/guideEvents'
import type { NavTab } from '../data/brand'
import { JOHNNY_INTENT_EVENT } from '../features/johnny/bookingIntent'
import { ReserveScreen } from '../screens/ReserveScreen'
import { TicketWalletScreen } from '../screens/TicketWalletScreen'
import type { WalletFilter } from '../data/wallet'
import { V2Home } from './V2Home'
import { V2Qr } from './V2Qr'
import { V2Next } from './V2Next'
import { V2Gacha } from './V2Gacha'
import { V2Menu } from './V2Menu'
import { V2PeopleSheet } from './V2PeopleSheet'
import { ginFlow } from '../utils/env'
import { V2Account } from './V2Account'
import { V2Ginpay } from './V2Ginpay'
import { LaunchNotice } from './LaunchClock'
import { V2Campaign, hasCampaign } from './V2Campaign'
import './v2.css'

/** お知らせのリンクの ?hold=…（キャンセル待ちで押さえた枠）を1回だけ読む（読んだら URL から消す） */
function takeHoldParam(): string | null {
  try {
    const url = new URL(window.location.href)
    const id = url.searchParams.get('hold')
    url.searchParams.delete('hold')
    url.searchParams.delete('tab')
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null
  } catch { return null }
}

const TABS: { id: NavTab; label: string; icon: typeof Home }[] = [
  { id: 'home', label: 'ホーム', icon: Home },
  { id: 'qr', label: '会員QR', icon: QrCode },
  { id: 'next', label: '次回予約', icon: CalendarClock },
  { id: 'gacha', label: 'ガチャ', icon: Sparkles },
]

export function V2App({ activeTab, setActiveTab, ticketFilter, ticketKey, onModalChange, showCampaign }: {
  activeTab: NavTab; setActiveTab: (t: NavTab) => void
  ticketFilter: WalletFilter; ticketKey: number; onModalChange: (open: boolean) => void; showCampaign: boolean
}) {
  const [menu, setMenu] = useState(false)
  // 公開の告知が出たアプリでは、ほかのお知らせ（キャンペーン）は出さない（重ねない・11/11）
  const [launchNotice, setLaunchNotice] = useState(false)
  const [noticeShown, setNoticeShown] = useState(false)
  const onLaunchNotice = useCallback((open: boolean) => { setLaunchNotice(open); if (open) setNoticeShown(true) }, [])
  const [people, setPeople] = useState(false)
  // 銀Pay のページ（ホームの帯から開く）。タブを切り替えたら閉じる
  const [pay, setPay] = useState(false)
  const go = (t: NavTab) => { setPay(false); setActiveTab(t) }
  // Johnny・チケットなどを閉じたら、開く前のタブへ戻る
  const isTab = (t: NavTab) => t === 'qr' || t === 'next' || t === 'gacha'
  const lastTab = useRef<NavTab>(isTab(activeTab) ? activeTab : 'home')
  const tab: NavTab = isTab(activeTab) ? activeTab : 'home'
  useEffect(() => { if (activeTab === 'home' || isTab(activeTab)) lastTab.current = activeTab }, [activeTab])
  // 銀ちゃんの「会員QRを表示」（本人確認がまだの方）
  useEffect(() => { const show = () => setActiveTab('qr'); window.addEventListener('ginjiro:show-qr', show); return () => window.removeEventListener('ginjiro:show-qr', show) }, [setActiveTab])

  // スタイルの「この髪型でAI予約する」：メニューは ReserveScreen が受け取る
  useEffect(() => {
    const open = () => setActiveTab('reserve')
    window.addEventListener(JOHNNY_INTENT_EVENT, open)
    return () => window.removeEventListener(JOHNNY_INTENT_EVENT, open)
  }, [setActiveTab])

  const back = () => setActiveTab(lastTab.current)

  // Staging：予約タブ（?tab=reserve・ショートカット・店頭確認のあと）はすべて銀ちゃんの会話（11/9）。
  //   キャンセル待ちのお知らせ（?hold=…）は、押さえた枠を銀ちゃんが「予約しますか？」と聞く
  const ginReserve = activeTab === 'reserve' && ginFlow()
  useEffect(() => {
    if (!ginReserve) return
    // 起動直後は App の受け口（親の effect）がまだ無いので、1拍おいて送る（タブも同じときに戻す）
    const t = setTimeout(() => {
      const holdId = takeHoldParam()
      if (holdId) window.dispatchEvent(new CustomEvent('ginjiro:gin-offer', { detail: { holdId } }))
      else window.dispatchEvent(new CustomEvent('ginjiro:gin-book', { detail: { menuCode: null, label: '' } }))
      setActiveTab(lastTab.current === 'reserve' ? 'home' : lastTab.current)
    }, 0)
    return () => clearTimeout(t)
  }, [ginReserve, setActiveTab])

  if (ginReserve) return null
  if (activeTab === 'reserve') {
    return <div className="v2"><ReserveScreen onShowQr={() => setActiveTab('qr')} onClose={back} /></div>
  }
  if (activeTab === 'tickets') {
    // チケットも白の画面（ほかのページと同じ上のロゴ・戻る）。券の絵柄（黒いカード・クーポン画像）はそのまま
    return (
      <div className="v2 v2-wallet" data-guide="wallet">
        <header className="v2-head" style={{ gridTemplateColumns: '80px 1fr 80px' }}>
          <button type="button" className="v2-back" onClick={back}><ChevronLeft size={18} />戻る</button>
          <img className="v2-logo" src="/images/logo-ginjiro.png" alt="二代目 銀二郎" />
          <span />
        </header>
        <TicketWalletScreen key={`tickets-${ticketFilter}-${ticketKey}`}onModalChange={onModalChange} initialFilter={ticketFilter} />
      </div>
    )
  }


  // ホーム・会員QR・次回予約は1画面に収めて固定（上下にスワイプしない）
  const isHome = tab === 'home' && !pay && activeTab !== 'mypage'
  const fixed = isHome || (activeTab !== 'mypage' && (tab === 'qr' || tab === 'next' || tab === 'gacha'))
  return (
    <div className={isHome ? 'v2 v2-fixed v2-home' : fixed ? 'v2 v2-fixed' : 'v2'}>
      <header className="v2-head">
        {/* 使い方ガイド（押す場所を順番に案内する） */}
        <button type="button" className="v2-round v2-glass" aria-label="使い方" data-guide="guide-open" onClick={openCustomerGuide}><CircleHelp size={20} /></button>
        <img className="v2-logo" src="/images/logo-ginjiro.png" alt="二代目 銀二郎" />
        <button type="button" className="v2-round v2-glass" aria-label="メニュー" data-guide="menu-open" onClick={() => setMenu(true)}><Menu size={20} /></button>
      </header>

      <main className={`v2-main${activeTab === 'home' && !pay ? ' has-cta' : ''}`}>
        {activeTab === 'mypage'
          ? <V2Account onBack={back} />
          : tab === 'home' && pay ? <V2Ginpay onBack={() => setPay(false)} onShowQr={() => go('qr')} />
          : tab === 'home' ? <V2Home onGinpay={() => setPay(true)} />
          : tab === 'qr' ? <V2Qr onTickets={() => setActiveTab('tickets')} />
          : tab === 'gacha' ? <V2Gacha />
          : <V2Next onJohnny={() => setActiveTab('reserve')} />}
      </main>

      <nav className="v2-nav v2-glass" aria-label="メインナビゲーション">
        {TABS.map(t => {
          const Icon = t.icon
          return (
            <button key={t.id} type="button" data-guide={`tab-${t.id}`} aria-current={activeTab === t.id ? 'page' : undefined} onClick={() => go(t.id)}>
              <Icon size={22} strokeWidth={1.8} />{t.label}
            </button>
          )
        })}
      </nav>

      {isHome && showCampaign && <LaunchNotice onOpenChange={onLaunchNotice} />}
      {isHome && showCampaign && hasCampaign && !launchNotice && !noticeShown && <V2Campaign onGacha={() => go('gacha')} />}
      <V2Menu open={menu} onClose={() => setMenu(false)} onTickets={() => setActiveTab('tickets')} onAccount={() => setActiveTab('mypage')} onPeople={ginFlow() ? () => setPeople(true) : undefined} />
      {/* ☰ の「いつもの・お連れ様」（Staging） */}
      <V2PeopleSheet open={people} onClose={() => setPeople(false)} ownerMenu={null} manage />
    </div>
  )
}
