import { useState } from 'react'
import { Checkout } from '../components/booking/Checkout'
import { ActorSheet } from '../components/booking/ActorSheet'
import { C } from '../components/booking/ledgerTheme'
import { yen } from '../utils/bookingApi'
import { useStaffActor } from './staffActor'

// 店頭会計：会員QRが無いお客様（ホットペッパー・電話のお客様など）の会計。お名前・電話番号で探すか、匿名で。
// 予約表は SB に一本化したので、店舗端末のメニューから直接ここを開く（会員QRのお客様は「店舗端末」から）。
export function StaffWalkInScreen({ onBack }: { onBack: () => void }) {
  const a = useStaffActor()
  const [round, setRound] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  return (
    <div style={{ background: C.bg, minHeight: '100%' }}>
      {notice && <p role="status" style={{ margin: 0, padding: '12px 20px', fontSize: 14, color: C.text, background: '#F1F6EF', borderBottom: `1px solid ${C.line}` }}>{notice}</p>}
      <Checkout key={round} api={a.checkoutApi} customers={a.customerApi} reservationId={null} ensureActor={a.ensureActor}
        onClose={onBack}
        onDone={sale => { setNotice(`会計を確定しました ${sale.client?.name ?? sale.customer_name ?? ''} ${yen(sale.total)}`); setRound(r => r + 1) }} />
      {a.picking && <ActorSheet actor={a.actor} onPick={a.choose} onClose={() => a.setPicking(false)} />}
    </div>
  )
}
