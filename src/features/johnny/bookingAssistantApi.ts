// 予約アシスタントが使うお客様用の予約 RPC（顧客セッション必須）。空き枠・仮押さえ・確定はすべて DB の予約エンジンが決める。
// 開発用のデモ（?johnny=demo、開発ビルドのときだけ）は通信せず、端末の中だけで動く。
import { callCustomerRpc } from '../../utils/customerSession'
import { RpcError } from '../../utils/staffSession'
import { fetchContact, normalizePhone, saveContact, type CustomerContact } from '../../utils/customerContact'
import type { MenuOption } from './menuMatcher'
import type { Slot } from './slotPlanner'
import { consultStylist, type ConsultReply } from './consult'
import type { DayOverview } from './dayAdvisor'
import { askAgent, askAgentVoice, type AgentAnswer, type AgentShown, type AgentTurn, type VoiceAnswer } from './agentClient'

export interface BookingSettings { slot_minutes: number; booking_window_days: number; min_lead_minutes: number; hold_minutes: number }
export interface AssistantOptions { settings: BookingSettings; menus: MenuOption[]; staff?: { id: string; name: string }[] }

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
  /** その担当だけの空き（お連れ様の時間を決めるのに使う） */
  staffSlots(date: string, menuCode: string, staffId: string): Promise<Slot[]>
  /** その日の受付時間と、メニューごとの空き（空きのあるメニューだけ） */
  dayOverview(date: string): Promise<DayOverview>
  /** 近い日から空きを探す（早い順） */
  nextSlots(menuCode: string, from: string, limit?: number): Promise<Slot[]>
  /** staffId があればその担当で押さえる（指名） */
  hold(startsAt: string, menuCode: string, staffId?: string | null): Promise<Hold>
  /** note はお店に見えるメモ（お連れ様など） */
  confirm(holdId: string, note?: string | null): Promise<CustomerReservation>
  release(holdId: string): Promise<void>
  reservations(): Promise<CustomerReservation[]>
  cancel(reservationId: string): Promise<CustomerReservation>
  /** 予約の AI。使えないときは null（呼び出し側が決まった規則の JOHNNY に切り替える） */
  agent(message: string, history: readonly AgentTurn[], shown?: AgentShown): Promise<AgentAnswer | null>
  /** 録音した声を送る（サーバーで文字にする）。使えないときは null。voice が false の環境（デモ）は端末の音声認識を使う */
  agentVoice(audio: Blob, history: readonly AgentTurn[], shown: AgentShown | undefined, transcribeOnly: boolean): Promise<VoiceAnswer | null>
  serverVoice: boolean
  /** 連絡先（本名・電話番号）。サーバーに仕組みが無ければ null */
  contact(): Promise<CustomerContact | null>
  saveContact(name: string, phone: string): Promise<void>
  /** 髪型などの相談（AI）。使えないときは null（呼び出し側が店頭へのご案内に切り替える） */
  consult(message: string, menus: readonly MenuOption[]): Promise<ConsultReply | null>
}

export const customerBookingApi: BookingAssistantApi = {
  options: () => callCustomerRpc<AssistantOptions>('customer_booking_options'),
  slots: (date, menuCode) => callCustomerRpc<Slot[]>('customer_available_slots', { p_date: date, p_menu_codes: [menuCode], p_staff_id: null }),
  staffSlots: (date, menuCode, staffId) => callCustomerRpc<Slot[]>('customer_available_slots', { p_date: date, p_menu_codes: [menuCode], p_staff_id: staffId }),
  dayOverview: date => callCustomerRpc<DayOverview>('customer_day_overview', { p_date: date }),
  nextSlots: (menuCode, from, limit = 10) => callCustomerRpc<Slot[]>('customer_next_slots', { p_menu_codes: [menuCode], p_from: from, p_limit: limit }),
  hold: (startsAt, menuCode, staffId = null) => callCustomerRpc<Hold>('customer_create_hold', { p_starts_at: startsAt, p_menu_codes: [menuCode], p_staff_id: staffId }),
  confirm: (holdId, note = null) => callCustomerRpc<CustomerReservation>('customer_confirm_reservation', { p_hold_id: holdId, p_note: note }),
  release: async holdId => { await callCustomerRpc('customer_release_hold', { p_hold_id: holdId }) },
  reservations: () => callCustomerRpc<CustomerReservation[]>('customer_list_reservations'),
  cancel: id => callCustomerRpc<CustomerReservation>('customer_cancel_reservation', { p_reservation_id: id }),
  agent: (message, history, shown) => askAgent(message, history, shown),
  agentVoice: (audio, history, shown, transcribeOnly) => askAgentVoice(audio, history, shown, transcribeOnly),
  serverVoice: true,
  contact: () => fetchContact(),
  saveContact: async (name, phone) => { await saveContact(name, phone) },
  consult: (message, menus) => consultStylist(message, menus),
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

// デモ：2時間以上のメニューは 17 時までに始まる枠だけ（今日は入れない＝「長いメニューは空きなし」を確かめられる）
function demoSlotsForMenu(date: string, menu: MenuOption): Slot[] {
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)
  if (menu.duration_min >= 120 && date === today) return []
  return demoSlotsFor(date).filter(s => menu.duration_min < 120 || s.starts_at.slice(11, 16) <= '17:00')
}
const addDays = (date: string, n: number) => new Date(new Date(date + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10)

const demoStore: CustomerReservation[] = []
/** デモは連絡先が未登録の状態から始める（登録の画面も確かめられるように） */
let demoContact: CustomerContact = { name: '銀二 太郎', phone: null, registered: false }
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

export const demoBookingApi: BookingAssistantApi = {
  async options() { await wait(250); return { settings: { slot_minutes: 30, booking_window_days: 60, min_lead_minutes: 30, hold_minutes: 2 }, menus: DEMO_MENUS, staff: [{ id: 'demo-a', name: 'テイテイ' }, { id: 'demo-b', name: '銀二郎' }] } },
  async slots(date, menuCode) { await wait(450); const m = DEMO_MENUS.find(x => x.code === menuCode); return m ? demoSlotsForMenu(date, m) : [] },
  async staffSlots(date, menuCode, staffId) { await wait(300); const m = DEMO_MENUS.find(x => x.code === menuCode); return m ? demoSlotsForMenu(date, m).filter((_, i) => staffId === 'demo-b' ? i % 2 === 0 : true) : [] },
  async dayOverview(date) {
    await wait(500)
    return { date, open: true, hours: { start: '10:00', end: '19:30' },
      groups: DEMO_MENUS.map(m => ({ codes: [m.code], slots: demoSlotsForMenu(date, m).map(s => s.starts_at) })).filter(g => g.slots.length > 0) }
  },
  async nextSlots(menuCode, from, limit = 10) {
    await wait(400)
    const m = DEMO_MENUS.find(x => x.code === menuCode)
    const out: Slot[] = []
    for (let i = 0; m && i < 14 && out.length < limit; i++) out.push(...demoSlotsForMenu(addDays(from, i), m).slice(0, limit - out.length))
    return out
  },
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
  async cancel(id) {
    await wait(300)
    const r = demoStore.find(x => x.id === id)
    if (!r) throw new RpcError('not_found', 'not_found')
    r.status = 'cancelled'
    return r
  },
  // デモは AI を使わない（決まった規則の JOHNNY で動く）
  async agent() { return null },
  async agentVoice() { return null },
  serverVoice: false,
  async contact() { await wait(150); return demoContact },
  async saveContact(name, phone) {
    await wait(300)
    const p = normalizePhone(phone)
    if (!p) throw new RpcError('invalid_phone', '電話番号を確認してください。')
    demoContact = { name: name.trim(), phone: p, registered: true }
  },
  // デモ：AI の代わりに決まった答え（パーマの相談ならパンチ・カールアイパーを勧める）
  async consult(message) {
    await wait(700)
    if (/パーマ|ぱーま|くせ|ボリューム/.test(message)) {
      return { reply: '今の長さなら、パンチパーマかカールアイパーがおすすめです。どちらも約2時間です。', menuCodes: ['punch', 'curl_iper'] }
    }
    return { reply: '髪型のご相談なら、まずはカットで今の長さを整えるのがおすすめです。', menuCodes: ['cut'] }
  },
}

export function bookingAssistantApi(): BookingAssistantApi {
  return isDemoMode() ? demoBookingApi : customerBookingApi
}
