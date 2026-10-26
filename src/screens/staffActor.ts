import { useState } from 'react'
import { getStoredValue, setStoredValue } from '../utils/storage'
import { createStaffBookingApi } from '../utils/bookingApi'
import { createStaffCustomerApi } from '../utils/customerApi'
import { createStaffCheckoutApi } from '../utils/checkoutApi'
import { createStaffGinpayApi } from '../utils/ginpayApi'

// 店舗端末の「操作者」（予約・顧客の登録・変更の記録に残る名前）。端末に保存し、予約台帳・顧客一覧で共通に使う。
const ACTOR_KEY = 'ginjiro_staff_name' // 店舗端末の「担当者」と同じ値を使う
const readActor = () => getStoredValue<string>(ACTOR_KEY, '')

export function useStaffActor() {
  const [actor, setActor] = useState(readActor)
  const [picking, setPicking] = useState(false)
  // 操作者は選んだ時点で端末に保存しているので、記録時は保存値を読む
  const [bookingApi] = useState(() => createStaffBookingApi(readActor))
  const [customerApi] = useState(() => createStaffCustomerApi(readActor))
  const [checkoutApi] = useState(() => createStaffCheckoutApi(readActor))
  const [ginpayApi] = useState(() => createStaffGinpayApi(readActor))
  function choose(name: string) {
    setActor(name)
    setStoredValue(ACTOR_KEY, name)
    setPicking(false)
  }
  /** 操作者が未選択なら選択を求める（記録が必要な操作の前に呼ぶ） */
  function ensureActor(): boolean {
    if (readActor()) return true
    setPicking(true)
    return false
  }
  return { actor, picking, setPicking, choose, ensureActor, bookingApi, customerApi, checkoutApi, ginpayApi }
}
