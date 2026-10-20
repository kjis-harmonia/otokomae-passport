import { useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence } from 'framer-motion'
import { SHOP_PHONE_DISPLAY, SHOP_PHONE_TEL } from '../data/wallet'
import { JohnnyBookingAssistant } from '../features/johnny/JohnnyBookingAssistant'
import { formatVisit, useNextReservation } from '../features/johnny/nextReservation'

// 予約。開くとすぐ予約アシスタント（JOHNNY）が日時を聞く。
// アシスタントを閉じたあとは、次の予約・もう一度話して予約・電話を表示する。
// アプリからの予約が無効（booking_disabled）の間は、アシスタントが電話・HOT PEPPER を案内する。

const SANS = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", sans-serif'

export function ReserveScreen({ onShowQr }: { onShowQr?: () => void }) {
  const [assistantOpen, setAssistantOpen] = useState(true)
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

      {/* 画面の切り替えアニメーションの外（body 直下）に出して、下タブも含めて画面全体に重ねる */}
      {createPortal(
        <AnimatePresence>
          {assistantOpen && (
            <JohnnyBookingAssistant key="johnny-booking" onClose={() => setAssistantOpen(false)} onShowQr={onShowQr} />
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}
