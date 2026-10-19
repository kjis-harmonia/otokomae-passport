import { ReservationLedger } from '../components/booking/ReservationLedger'
import { ActorSheet } from '../components/booking/ActorSheet'
import { C } from '../components/booking/ledgerTheme'
import { useStaffActor } from './staffActor'

// 店舗端末の予約台帳。予約の登録・変更の記録に残る「操作者」をこの端末で選んでおく。
export function StaffReservationsScreen() {
  const a = useStaffActor()
  return (
    <div style={{ background: C.bg }}>
      <ReservationLedger api={a.bookingApi} customers={a.customerApi} ginpay={a.ginpayApi} checkout={a.checkoutApi} actor={{ name: a.actor, pick: () => a.setPicking(true) }} />
      {a.picking && <ActorSheet api={a.bookingApi} actor={a.actor} onPick={a.choose} onClose={() => a.setPicking(false)} />}
    </div>
  )
}
