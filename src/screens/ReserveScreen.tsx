import {useStoreAccess} from '../features/customerAccess/storeAccess'
import {CUSTOMER_ACCESS_ENABLED} from '../features/customerAccess/passkeys'
import {PasskeyLoginButton} from '../features/customerAccess/CustomerAccess'
import {useCustomerAccessSession} from '../features/customerAccess/useCustomerAccessSession'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence } from 'framer-motion'
import { MAINTENANCE_CUT_URL, getReserveUrl } from '../data/reserveLinks'
import { SHOP_PHONE_DISPLAY, SHOP_PHONE_TEL } from '../data/wallet'
import { JohnnyBookingAssistant } from '../features/johnny/JohnnyBookingAssistant'
import { takeJohnnyIntent } from '../features/johnny/bookingIntent'
import { formatVisit, useNextReservation } from '../features/johnny/nextReservation'

// 予約。開くとすぐ予約アシスタント（JOHNNY）が日時を聞く。
// アシスタントを閉じたあとは、次の予約・もう一度話して予約・電話・HOT PEPPER Beauty を表示する。
// アプリからの予約が無効（booking_disabled）の間は、アシスタントが電話・HOT PEPPER を案内する。

const SANS = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", sans-serif'

/** 既存のクーポン予約リンクがあるメニューだけ（reserveLinks のURLをそのまま使う） */
const HOTPEPPER_MENUS: { label: string; url: string }[] = [
  { label: 'メンテナンスカット（前回来店から14日以内）', url: MAINTENANCE_CUT_URL },
  ...['濡れパン', 'パンチパーマ', 'カールアイパー', 'ニグロパーマ', '銀パラ', 'テイテイ刈り']
    .map(label => ({ label, url: getReserveUrl(label) }))
    .filter(m => m.url),
]

export function ReserveScreen(props:{onShowQr?:()=>void}){
  const session=useCustomerAccessSession()
  const access=useStoreAccess()
  if(CUSTOMER_ACCESS_ENABLED&&access.mode!=='verified')return <StoreBookingGate session={session} access={access} onShowQr={props.onShowQr}/>
  return <ReservationContent key={CUSTOMER_ACCESS_ENABLED?session:'legacy'} {...props}/>
}

function StoreBookingGate({session,access,onShowQr}:{session:string|null;access:ReturnType<typeof useStoreAccess>;onShowQr?:()=>void}){
  useState(takeJohnnyIntent) // スタイルから来ても、本人確認の前はメニューの希望を持ち越さない
  return <section className="customer-access" style={{padding:'40px 24px 120px',maxWidth:440,margin:'auto'}} aria-label="Johnnyの来店認証">
    {/* 主な操作は1つ（QR を見せる）。Face ID は確認済みの人だけなので小さく下に */}
    <h1>はじめに、店頭で本人確認</h1>
    <p>次のご来店時に、会員QRをスタッフに見せてください。確認が済むと、AI予約（銀二郎専属AI Johnny）が使えます。</p>
    {access.mode==='checking'?<p role="status">会員情報を確認しています…</p>:onShowQr&&<button type="button" className="access-primary" onClick={onShowQr}>会員QRを表示する</button>}
    {!session&&<PasskeyLoginButton quiet label="確認済みの方：Face IDでログイン" onSignedIn={()=>{}}/>}
    {access.mode==='error'&&<>
      <p role="alert" className="access-error">確認できませんでした。通信を確認してお試しください。</p>
      <button type="button" className="access-text" onClick={access.refresh}>もう一度確認</button>
    </>}
    <a href={SHOP_PHONE_TEL} className="access-text">電話で予約する（{SHOP_PHONE_DISPLAY}）</a>
    <details style={{marginTop:24}}>
      <summary style={{minHeight:44,cursor:'pointer'}}>HOT PEPPER Beautyで予約</summary>
      {HOTPEPPER_MENUS.map(menu=><a key={menu.label} href={menu.url} target="_blank" rel="noopener noreferrer" style={{display:'block',padding:'12px 0',color:'#ccc',borderBottom:'1px solid #333'}}>{menu.label}</a>)}
    </details>
  </section>
}
function ReservationContent({ onShowQr }: { onShowQr?: () => void }) {
  const [assistantOpen, setAssistantOpen] = useState(true)
  // スタイルの「予約する」から来たとき：そのメニューを入れて Johnny を始める
  const [intent] = useState(takeJohnnyIntent)
  const next = useNextReservation()
  const visit = next ? formatVisit(next.starts_at) : null

  return (
    <div style={{ padding: '24px 16px 120px', color: '#F2F2F2', fontFamily: SANS }}>
      <h1 style={{ fontSize: 22, fontWeight: 600 }}>予約</h1>

      {next && visit && (
        <section aria-label="次のご予約" style={{ marginTop: 16, padding: '14px 16px', borderRadius: 12, background: '#1C1C1E' }}>
          <p style={{ fontSize: 13, color: '#A3A3A3' }}>次のご予約</p>
          <p style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>
            {visit.relative && <span style={{ marginRight: 8 }}>{visit.relative}</span>}
            {visit.date} {visit.time}
          </p>
          <p style={{ fontSize: 15, color: '#A3A3A3', marginTop: 2 }}>{next.items.map(i => i.name).join('・')}</p>
        </section>
      )}

      <button
        type="button"
        onClick={() => setAssistantOpen(true)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: 52, marginTop: 20, borderRadius: 10,
          border: 'none', background: '#F2F2F2', color: '#0B0B0B', fontSize: 16, fontWeight: 600, fontFamily: SANS, cursor: 'pointer',
        }}
      >
        日時を伝えて予約する
      </button>

      <a
        href={SHOP_PHONE_TEL}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', height: 52, marginTop: 10, borderRadius: 10,
          background: '#1C1C1E', color: '#F2F2F2', fontSize: 16, fontWeight: 500, textDecoration: 'none',
        }}
      >
        電話で予約する（{SHOP_PHONE_DISPLAY}）
      </a>

      <h2 style={{ fontSize: 13, fontWeight: 600, color: '#A3A3A3', marginTop: 32, marginBottom: 4 }}>HOT PEPPER Beauty で予約</h2>
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.09)' }}>
        {HOTPEPPER_MENUS.map(m => (
          <a
            key={m.label}
            href={m.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 52, padding: '0 2px',
              borderBottom: '1px solid rgba(255,255,255,0.09)', color: '#F2F2F2', fontSize: 15, textDecoration: 'none',
            }}
          >
            <span>{m.label}</span>
            <span aria-hidden="true" style={{ color: '#6E6E6E' }}>›</span>
          </a>
        ))}
      </div>
      <p style={{ fontSize: 13, color: '#6E6E6E', marginTop: 12 }}>HOT PEPPER Beauty のページが開きます。</p>

      {/* 画面の切り替えアニメーションの外（body 直下）に出して、下タブも含めて画面全体に重ねる */}
      {createPortal(
        <AnimatePresence>
          {assistantOpen && (
            <JohnnyBookingAssistant key="johnny-booking" initialMenuCode={intent?.menuCode ?? null} onClose={() => setAssistantOpen(false)} onShowQr={onShowQr} />
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}
