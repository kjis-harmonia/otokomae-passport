// Reservation display only. Conversation/model logic is independent of this hook.
import { useEffect, useState } from 'react'
import { bookingAssistantApi, isDemoMode, type CustomerReservation } from './bookingAssistantApi'
import { getCustomerSession, hasCustomerSession } from '../../utils/customerSession'
import { getUserId } from '../../utils/userId'
const KEY = isDemoMode() ? 'ginjiro_next_reservation_demo' : 'ginjiro_next_reservation'
const EVENT = 'ginjiro:reservation-changed'
const ACTIVE: CustomerReservation['status'][] = ['confirmed', 'checked_in', 'in_service', 'awaiting_payment']
function isUpcoming(r: CustomerReservation, now = Date.now()): boolean {
  return ACTIVE.includes(r.status) && new Date(r.ends_at).getTime() > now
}
function readCached(): CustomerReservation | null {
  try {
    const cached = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    const r = cached?.owner === getUserId() ? cached.reservation as CustomerReservation : null
    return r && typeof r.starts_at === 'string' && isUpcoming(r) ? r : null
  } catch { return null }
}
function cache(r: CustomerReservation | null) {
  try { if (r) localStorage.setItem(KEY, JSON.stringify({ owner: getUserId(), reservation: r })); else localStorage.removeItem(KEY) } catch { /* optional display cache */ }
}
export function rememberReservation(r: CustomerReservation): void {
  cache(r); window.dispatchEvent(new Event(EVENT))
}
export function pickNext(list: readonly CustomerReservation[]): CustomerReservation | null {
  return [...list].filter(r => isUpcoming(r)).sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0] ?? null
}
export function useNextReservation(): CustomerReservation | null {
  const [next, setNext] = useState<CustomerReservation | null>(() => hasCustomerSession() || isDemoMode() ? readCached() : null)
  useEffect(() => {
    let alive = true, generation = 0
    const load = () => {
      const request = ++generation, owner = getUserId(), session = getCustomerSession()
      setNext(hasCustomerSession() || isDemoMode() ? readCached() : null)
      if (!session && !isDemoMode()) return
      bookingAssistantApi().reservations().then(list => {
        if (!alive || request !== generation || owner !== getUserId() || session !== getCustomerSession()) return
        const n = pickNext(list); cache(n); setNext(n)
      }).catch(() => { /* retain last confirmed snapshot while offline */ })
    }
    const visible = () => { if (document.visibilityState === 'visible') load() }
    load()
    const timer = window.setInterval(visible, 30_000)
    for (const e of [EVENT, 'focus', 'online', 'ginjiro:customer-session-changed', 'ginjiro:customer-auth-required']) window.addEventListener(e, load)
    document.addEventListener('visibilitychange', visible)
    return () => {
      alive = false; ++generation; clearInterval(timer)
      for (const e of [EVENT, 'focus', 'online', 'ginjiro:customer-session-changed', 'ginjiro:customer-auth-required']) window.removeEventListener(e, load)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])
  return next
}
const WD = ['日', '月', '火', '水', '木', '金', '土']
export function formatVisit(iso: string): { date: string; time: string; relative: string | null } {
  const t = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000)
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const day = (x: Date) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())
  const diff = Math.round((day(t) - day(now)) / 86400000)
  return { date: `${t.getUTCMonth() + 1}月${t.getUTCDate()}日（${WD[t.getUTCDay()]}）`,
    time: `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`,
    relative: diff === 0 ? '今日' : diff === 1 ? '明日' : diff === 2 ? '明後日' : null }
}
