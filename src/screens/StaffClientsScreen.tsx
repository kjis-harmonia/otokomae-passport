import { ClientList } from '../components/booking/ClientList'
import { ActorSheet } from '../components/booking/ActorSheet'
import { C, linkStyle } from '../components/booking/ledgerTheme'
import { useStaffActor } from './staffActor'

// 店舗端末の顧客一覧。顧客の編集・メモ・統合の記録に残る「操作者」は予約台帳と共通。
export function StaffClientsScreen() {
  const a = useStaffActor()
  return (
    <div style={{ background: C.bg, minHeight: 'calc(100dvh - 57px)' }}>
      <ClientList api={a.customerApi} ginpayApi={a.ginpayApi} ensureActor={a.ensureActor}
        toolbar={<button type="button" onClick={() => a.setPicking(true)} style={linkStyle}>操作者 {a.actor || '未選択'}</button>} />
      {a.picking && <ActorSheet api={a.bookingApi} actor={a.actor} onPick={a.choose} onClose={() => a.setPicking(false)} />}
    </div>
  )
}
