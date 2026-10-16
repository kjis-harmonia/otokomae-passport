import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { callStaffRpc, rpcErrorMessage } from '../../utils/staffSession'
import { createStaffCheckoutApi, type Sale } from '../../utils/checkoutApi'
import { createStaffCustomerApi } from '../../utils/customerApi'
import { jstTime, STATUS_LABEL, type Reservation } from '../../utils/bookingApi'
import { Checkout } from './Checkout'

interface Context { client_id: string; reservations: Reservation[] }
/** Resolve today's bookings using the authenticated member, then let the operator choose. */
export function MemberBookingActions({ userId, staffName, ticketIds = [], onDone }: {
  userId: string; staffName: string; ticketIds?: readonly string[]; onDone?: (sale: Sale) => void
}) {
  const checkout = useMemo(() => createStaffCheckoutApi(() => staffName), [staffName])
  const customers = useMemo(() => createStaffCustomerApi(() => staffName), [staffName])
  const [context, setContext] = useState<Context | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pay, setPay] = useState<{ reservationId: string | null } | null>(null)
  const generation = useRef(0)
  const load = useCallback(async () => {
    const request = ++generation.current
    try { const next = await callStaffRpc<Context>('staff_member_booking_context', { p_user_id: userId }); if (request === generation.current) { setContext(next); setError(null) } }
    catch (e) { if (request === generation.current) setError(rpcErrorMessage(e, '当日の予約を確認できませんでした。')) }
  }, [userId])
  const invalidate = useCallback(() => { ++generation.current }, [])
  useEffect(() => { void Promise.resolve().then(load); return invalidate }, [load, invalidate])
  const ensureActor = () => {
    if (staffName.trim()) return true
    setError('担当者を選択してください。'); return false
  }
  async function checkIn(r: Reservation) {
    if (!ensureActor() || busy) return
    setBusy(true)
    try {
      await callStaffRpc('staff_check_in_reservation', { p_user_id: userId, p_reservation_id: r.id, p_staff_name: staffName })
      await load()
    } catch (e) { setError(rpcErrorMessage(e, '予約の来店登録ができませんでした。')) }
    finally { setBusy(false) }
  }
  return <section style={{ padding: 16, background: '#fff', color: '#202321', borderRadius: 12, margin: '16px 0', textAlign: 'left', fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif' }}>
    <h2 style={{ fontSize: 17, fontWeight: 600, margin: '0 0 8px' }}>本日の予約・会計</h2>
    {!context && !error && <p>予約を確認中…</p>}
    {error && <p role="alert" style={{ color: '#b22d25', fontSize: 14 }}>{error}<button style={buttonStyle} onClick={() => void load()}>再確認</button></p>}
    {context && <>
      {context.reservations.length === 0 && <p style={{ fontSize: 14, color: '#646862' }}>本日の予約はありません。</p>}
      {context.reservations.map(r => <div key={r.id} style={{ padding: '12px 0', borderBottom: '1px solid #e3e5df' }}>
        <p style={{ margin: 0, fontWeight: 600 }}>{jstTime(r.starts_at)}{' '}{r.customer_name}</p>
        <p style={{ margin: '4px 0 8px', fontSize: 14 }}>{r.items.map(i => i.name).join('・')} / {r.staff_name} / {STATUS_LABEL[r.status]}</p>
        {r.status === 'confirmed' && <button style={buttonStyle} disabled={busy} onClick={() => void checkIn(r)}>{busy ? '登録中…' : 'この予約を来店済みにする'}</button>}
        {['checked_in', 'in_service', 'awaiting_payment', 'completed'].includes(r.status) && <button style={buttonStyle} disabled={busy} onClick={() => { if (ensureActor()) setPay({ reservationId: r.id }) }}>{r.status === 'completed' ? '会計を確認' : 'この予約の会計へ'}</button>}
      </div>)}
      <button style={buttonStyle} disabled={busy} onClick={() => { if (ensureActor()) setPay({ reservationId: null }) }}>予約なしで会計</button>
      {ticketIds.length > 0 && <p style={{ fontSize: 13, color: '#646862' }}>選んだ割引券は会計に引き継ぎます。会計の確定までは使用されません。</p>}
    </>}
    {pay && context && <Checkout api={checkout} customers={customers} reservationId={pay.reservationId} clientId={context.client_id} initialTicketIds={ticketIds} ensureActor={ensureActor}
      onClose={() => setPay(null)} onDone={sale => { setPay(null); void load(); onDone?.(sale) }} />}
  </section>
}
const buttonStyle = { minHeight: 44, padding: '8px 14px', marginTop: 8, border: '1px solid #cdd0c8', borderRadius: 8, background: '#fff', color: '#202321', fontSize: 14, cursor: 'pointer' } as const
