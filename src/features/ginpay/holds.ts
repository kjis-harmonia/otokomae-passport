// 銀Pay の仮支払い（予約のときに残高を押さえる。本当の支払いはレジで会員QR を読んで会計を確定したとき）。
// 予約をキャンセルすると押さえは消える（全額戻る）。台帳・残高は DB の customer_ginpay_* が正。
import { useEffect, useState } from 'react'
import { callCustomerRpc, getCustomerSession } from '../../utils/customerSession'

export interface GinpayHoldSummary {
  balance: number
  held: number
  /** 使える額（残高 − ほかの予約で押さえている分） */
  available: number
  holds: { reservation_id: string; amount: number }[]
}

const EVENT = 'ginjiro:ginpay-holds-changed'

export function fetchGinpayHolds(): Promise<GinpayHoldSummary> {
  return callCustomerRpc<GinpayHoldSummary>('customer_ginpay_holds')
}

export async function holdGinpay(reservationId: string, amount: number): Promise<void> {
  await callCustomerRpc('customer_ginpay_hold', { p_reservation_id: reservationId, p_amount: amount })
  window.dispatchEvent(new Event(EVENT))
}

export async function releaseGinpay(reservationId: string): Promise<void> {
  await callCustomerRpc('customer_ginpay_release', { p_reservation_id: reservationId })
  window.dispatchEvent(new Event(EVENT))
}

/** 予約が変わった（キャンセル・変更）ときも読み直す */
export function notifyGinpayHoldsChanged(): void {
  window.dispatchEvent(new Event(EVENT))
}

/** 仮支払いの状況。口座が無い・ログイン前は null */
export function useGinpayHolds(): GinpayHoldSummary | null {
  const [summary, setSummary] = useState<GinpayHoldSummary | null>(null)
  useEffect(() => {
    let alive = true
    let gen = 0
    const load = () => {
      // いちばん新しい頼みで、同じ会員の応答だけ使う（古い応答で上書きしない・10/30 監査 R2）
      const my = ++gen
      const owner = getCustomerSession()
      if (!owner) { setSummary(null); return }
      const current = () => alive && my === gen && getCustomerSession() === owner
      fetchGinpayHolds().then(s => { if (current()) setSummary(s) }).catch(() => { if (current()) setSummary(null) })
    }
    load()
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    window.addEventListener(EVENT, load)
    window.addEventListener('ginjiro:reservation-changed', load)
    window.addEventListener('ginjiro:customer-session-changed', load)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      window.removeEventListener(EVENT, load)
      window.removeEventListener('ginjiro:reservation-changed', load)
      window.removeEventListener('ginjiro:customer-session-changed', load)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  return summary
}

/** その予約の仮支払い額（無ければ null） */
export function heldFor(summary: GinpayHoldSummary | null, reservationId: string | undefined | null): number | null {
  if (!summary || !reservationId) return null
  return summary.holds.find(h => h.reservation_id === reservationId)?.amount ?? null
}
