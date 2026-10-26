// 店舗端末：会員QR → 来店チェックイン → そのままお会計（銀Pay・現金・カードほか）。
//   今日の予約があれば予約から会計（メニュー・担当・料金を引き継ぎ、確定で予約は完了）、無ければ顧客を選んだ店頭会計。
//   会員QRでお客様が選んだ券は、会計の中で最初から選んでおく（確定のときに使用済みになる）。
import { useEffect, useRef, useState } from 'react'
import { Checkout } from './booking/Checkout'
import { createStaffCheckoutApi, PAYMENT_LABEL, type Sale } from '../utils/checkoutApi'
import { createStaffCustomerApi } from '../utils/customerApi'
import { yen } from '../utils/bookingApi'
import { callStaffRpc, rpcErrorMessage } from '../utils/staffSession'
import { getStoredValue } from '../utils/storage'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

type Target = { reservationId: string | null; clientId: string }
// 店舗端末の「担当者」（AdminScreen が端末に保存する）。会計の記録には確定した時点の名前を残す
const readActor = () => getStoredValue<string>('ginjiro_staff_name', '')

export function MemberCheckout({ userId, staffName, ticketIds, onPaid }: {
  userId: string
  /** 店舗端末の「担当者」。会計の記録に残る操作者 */
  staffName: string
  /** お客様が会員QRで選んだ券 */
  ticketIds: readonly string[]
  onPaid: (sale: Sale) => void
}) {
  const [target, setTarget] = useState<Target | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paid, setPaid] = useState<Sale | null>(null)
  const opening = useRef(false)
  const [api] = useState(() => createStaffCheckoutApi(readActor))
  const [customers] = useState(() => createStaffCustomerApi(readActor))

  async function open() {
    if (opening.current) return
    if (!staffName.trim()) { setError('上の「担当者」を選んでからお会計に進んでください。'); return }
    opening.current = true
    setLoading(true); setError(null)
    try {
      const r = await callStaffRpc<{ client_id?: string; reservation_id?: string | null; error?: string }>('staff_client_for_member', { p_user_id: userId })
      if (!r.client_id) { setError('このお客様の顧客台帳が見つかりません。予約台帳の「店頭会計」から顧客を選んで会計してください。'); return }
      setTarget({ reservationId: r.reservation_id ?? null, clientId: r.client_id })
    } catch (err) {
      setError(rpcErrorMessage(err))
    } finally {
      opening.current = false
      setLoading(false)
    }
  }

  // 会員QRを読んだら、そのまま金額を入れる会計を出す（10/26 慶一郎さん：担当で料金が変わるので、店で金額を入れて確定）
  // 開いたときに1回だけ顧客台帳を読む（担当者を選び直したら、下の「お会計に進む」から）
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { if (staffName.trim()) void open() }, [])

  if (paid) {
    return (
      <div style={{ marginTop: 16, padding: '14px 16px', borderRadius: 14, textAlign: 'left', background: 'rgba(36,107,82,0.06)', border: '1px solid rgba(36,107,82,0.35)' }}>
        <p style={{ fontSize: 9, letterSpacing: '0.26em', color: '#246b52', marginBottom: 6 }}>完了</p>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
          <span style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: '#1c1f1d' }}>お会計済み（{PAYMENT_LABEL[paid.payment_method ?? ''] ?? paid.payment_method}）</span>
          <span style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, color: '#1c1f1d' }}>{yen(paid.total)}</span>
        </div>
      </div>
    )
  }

  if (target) {
    return (
      <Checkout
        quick
        api={api}
        customers={customers}
        reservationId={target.reservationId}
        clientId={target.clientId}
        initialTicketIds={ticketIds}
        ensureActor={() => !!readActor().trim()}
        onClose={() => setTarget(null)}
        onDone={sale => { setTarget(null); setPaid(sale); onPaid(sale) }}
      />
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void open()}
        disabled={loading}
        style={{
          width: '100%', marginTop: 16, minHeight: 56, borderRadius: 14,
          background: '#97732b', border: 'none', boxShadow: '0 4px 18px rgba(151,115,43,0.28)',
          color: '#ffffff', fontFamily: SERIF, fontSize: 16, fontWeight: 700, letterSpacing: '0.16em',
          cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? '準備しています…' : 'お会計に進む'}
        <span style={{ display: 'block', fontSize: 10, fontWeight: 400, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.8)', marginTop: 2 }}>
          銀Pay・現金・カード・QR
        </span>
      </button>
      {error && <p role="alert" style={{ marginTop: 8, fontSize: 13, color: '#b23a3a', textAlign: 'left' }}>{error}</p>}
    </>
  )
}
