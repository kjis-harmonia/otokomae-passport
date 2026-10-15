// 予約アシスタントが使うお客様用の予約 RPC（顧客セッション必須）。空き枠・仮押さえ・確定はすべて DB の予約エンジンが決める。
// 開発用のデモ（?johnny=demo、開発ビルドのときだけ）は通信せず、端末の中だけで動く。
import { callCustomerRpc } from '../../utils/customerSession'
import { RpcError } from '../../utils/staffSession'
import { fetchContact, normalizePhone, saveContact, type CustomerContact } from '../../utils/customerContact'
import type { MenuOption } from './menuMatcher'
import type { Slot } from './slotPlanner'

export interface BookingSettings { slot_minutes: number; booking_window_days: number; min_lead_minutes: number; hold_minutes: number }
export interface AssistantOptions { settings: BookingSettings; menus: MenuOption[] }

export interface CustomerReservation {
  id: string
  starts_at: string
  ends_at: string
  status: 'confirmed' | 'checked_in' | 'in_service' | 'awaiting_payment' | 'completed' | 'cancelled' | 'no_show'
  staff_name: string
  nominated: boolean
  total_price: number | null
  items: { menu_code: string; name: string; duration_min: number; price: number | null }[]
}

export interface Hold { hold_id: string; starts_at: string; ends_at: string; staff_name: string; total_price: number | null }

export interface BookingAssistantApi {
  options(): Promise<AssistantOptions>
  slots(date: string, menuCode: string): Promise<Slot[]>
  hold(startsAt: string, menuCode: string): Promise<Hold>
  confirm(holdId: string): Promise<CustomerReservation>
  release(holdId: string): Promise<void>
  reservations(): Promise<CustomerReservation[]>
  /** 連絡先（本名・電話番号）。サーバーに仕組みが無ければ null */
  contact(): Promise<CustomerContact | null>
  saveContact(name: string, phone: string): Promise<void>
}

export const customerBookingApi: BookingAssistantApi = {
  options: () => callCustomerRpc<AssistantOptions>('customer_booking_options'),
  slots: (date, menuCode) => callCustomerRpc<Slot[]>('customer_available_slots', { p_date: date, p_menu_codes: [menuCode], p_staff_id: null }),
  hold: (startsAt, menuCode) => callCustomerRpc<Hold>('customer_create_hold', { p_starts_at: startsAt, p_menu_codes: [menuCode], p_staff_id: null }),
  confirm: holdId => callCustomerRpc<CustomerReservation>('customer_confirm_reservation', { p_hold_id: holdId, p_note: null }),
  release: async holdId => { await callCustomerRpc('customer_release_hold', { p_hold_id: holdId }) },
  reservations: () => callCustomerRpc<CustomerReservation[]>('customer_list_reservations'),
  contact: () => fetchContact(),
  saveContact: async (name, phone) => { await saveContact(name, phone) },
}

// ── 開発用デモ ───────────────────────────────────────────────────

export function isDemoMode(): boolean {
  if (!import.meta.env.DEV) return false
  try { return new URLSearchParams(window.location.search).get('johnny') === 'demo' } catch { return false }
}

const DEMO_MENUS: MenuOption[] = [
  { code: 'maintenance_cut', name: 'メンテナンスカット', duration_min: 30, price: 3300 },
  { code: 'cut', name: 'カット', duration_min: 60, price: 5500 },
  { code: 'nurepan', name: '濡れパン', duration_min: 120, price: 13200 },
  { code: 'punch', name: 'パンチパーマ', duration_min: 120, price: 12100 },
  { code: 'curl_iper', name: 'カールアイパー', duration_min: 120, price: 12100 },
]

function demoSlotsFor(date: string): Slot[] {
  // 10:00〜19:00 の30分刻み。日付ごとに決まった枠を埋めておく（同じ日は毎回同じ結果）
  const seed = [...date].reduce((a, c) => a + c.charCodeAt(0), 0)
  const out: Slot[] = []
  for (let m = 10 * 60; m <= 19 * 60; m += 30) {
    if ((m / 30 + seed) % 3 === 0) continue
    const iso = `${date}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00+09:00`
    if (new Date(iso).getTime() > Date.now() + 30 * 60 * 1000) out.push({ starts_at: iso })
  }
  return out
}

const demoStore: CustomerReservation[] = []
/** デモは連絡先が未登録の状態から始める（登録の画面も確かめられるように） */
let demoContact: CustomerContact = { name: '銀二 太郎', phone: null, registered: false }
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

export const demoBookingApi: BookingAssistantApi = {
  async options() { await wait(250); return { settings: { slot_minutes: 30, booking_window_days: 60, min_lead_minutes: 30, hold_minutes: 2 }, menus: DEMO_MENUS } },
  async slots(date) { await wait(450); return demoSlotsFor(date) },
  async hold(startsAt, menuCode) {
    await wait(300)
    const menu = DEMO_MENUS.find(m => m.code === menuCode)
    if (!menu) throw new RpcError('menu_not_available', 'menu_not_available')
    const end = new Date(new Date(startsAt).getTime() + menu.duration_min * 60000).toISOString()
    return { hold_id: `demo-${startsAt}-${menuCode}`, starts_at: startsAt, ends_at: end, staff_name: '担当者', total_price: menu.price }
  },
  async confirm(holdId) {
    await wait(500)
    const [, startsAt, menuCode] = holdId.match(/^demo-(.+)-([a-z_]+)$/) ?? []
    const menu = DEMO_MENUS.find(m => m.code === menuCode)!
    const r: CustomerReservation = {
      id: crypto.randomUUID(), starts_at: startsAt, ends_at: new Date(new Date(startsAt).getTime() + menu.duration_min * 60000).toISOString(),
      status: 'confirmed', staff_name: '担当者', nominated: false, total_price: menu.price,
      items: [{ menu_code: menu.code, name: menu.name, duration_min: menu.duration_min, price: menu.price }],
    }
    demoStore.push(r)
    return r
  },
  async release() { /* nothing */ },
  async reservations() { await wait(200); return [...demoStore] },
  async contact() { await wait(150); return demoContact },
  async saveContact(name, phone) {
    await wait(300)
    const p = normalizePhone(phone)
    if (!p) throw new RpcError('invalid_phone', '電話番号を確認してください。')
    demoContact = { name: name.trim(), phone: p, registered: true }
  },
}

export function bookingAssistantApi(): BookingAssistantApi {
  return isDemoMode() ? demoBookingApi : customerBookingApi
}
