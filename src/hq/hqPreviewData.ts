// Imported only by the development-only headquarters preview. No network or persistence.
import { getJapanDateString } from '../utils/dateUtils'
import { shiftDate, summarizeInsights } from './hqInsights'
import type { HqSessionRow, HqSessionItemRow } from './hqDataStore'
import type { BookingMasters } from './hqBookingStore'
import type { Ledger, Reservation } from '../utils/bookingApi'
import type { Product } from './hqInventoryStore'

const today = getJapanDateString()
const names = ['佐藤 陽介', '田中 健太', '鈴木 翔', '高橋 悠人', '伊藤 拓海', '渡辺 陸', '山本 大輔', '中村 航', '小林 直樹', '加藤 涼', '吉田 蓮', '山田 光']
const staffNames = ['テイテイ', '銀二郎', 'ヨンピル', 'シルビア', 'リアン', 'キャンディ', 'ヒョウ']
const uid = (i: number) => '00000000-0000-4000-8000-' + String(i).padStart(12, '0')
const sessions: HqSessionRow[] = []
for (let day = 0; day < 65; day++) {
  const date = shiftDate(today, -day)
  const count = 16 + (day * 7 + 5) % 9
  for (let i = 0; i < count; i++) sessions.push({ id: uid(1000 + day * 30 + i), user_id: uid(i % names.length + 1), total: [4000, 5000, 8000, 15000, 6500, 3000, 12000][(i + day) % 7], stylist_name: i % 3 ? '銀二郎' : 'テイテイ', staff_name: 'テイテイ', payment_method: ['cash', 'credit', 'qr', 'credit', 'cash', 'ginpay'][i % 6], created_at: date + 'T' + String(9 + Math.floor(i / 3)).padStart(2, '0') + ':' + String(i % 3 * 20).padStart(2, '0') + ':00+09:00' })
}
const menuNames = ['通常カット', 'スキンフェードカット', '濡れパン', 'ギンパラカーリー', '通常カット＆カラー', '顔そり男性', 'ツイスト系']
const items: HqSessionItemRow[] = sessions.map((s, i) => ({ session_id: s.id, item_name: menuNames[i % menuNames.length], category: 'menu', quantity: 1 }))
const customers = names.map((name, i) => ({ id: uid(i + 1), user_id: uid(i + 1), name, phone_last4: String(1200 + i), created_at: shiftDate(today, -180 + i * 8) + 'T10:00:00+09:00' }))
const products: Product[] = [
  { id: uid(7001), name: 'スタイリンググリース', category: '店販', current_stock: 2, min_stock: 3, price: 2200, accounting_group: 'スタイリング剤', is_active: true, created_at: today, updated_at: today },
  { id: uid(7002), name: 'カラー剤 ナチュラル', category: 'カラー剤', current_stock: 8, min_stock: 3, price: 0, accounting_group: null, is_active: true, created_at: today, updated_at: today },
  { id: uid(7003), name: 'ケアシャンプー', category: '店販', current_stock: 12, min_stock: 3, price: 3300, accounting_group: 'シャンプー・ケア', is_active: true, created_at: today, updated_at: today },
  { id: uid(7004), name: 'ペーパータオル', category: '消耗品', current_stock: 20, min_stock: 5, price: 0, accounting_group: null, is_active: true, created_at: today, updated_at: today },
]
const masters: BookingMasters = {
  settings: { slot_minutes: 15, booking_window_days: 60, min_lead_minutes: 60, hold_minutes: 5, customer_cancel_deadline_minutes: 120, app_booking_enabled: false },
  staff: staffNames.map((display_name, i) => ({ id: uid(100 + i), display_name, is_active: true, is_bookable: i < 2, sort_order: i })),
  menus: menuNames.map((name, i) => ({ id: uid(200 + i), name, code: 'preview-menu-' + i, kind: 'service', category: i < 2 ? 'カット' : 'パーマ', price: [4000, 5000, 8000, 15000, 6500, 2000, 12000][i], normal_price: null, duration_min: i === 3 ? 180 : 60, buffer_after_min: 0, price_from: false, price_tax_included: true, reference_duration_min: null, reference_duration_note: null, is_active: true, booking_enabled: true, checkout_enabled: true, sort_order: i, staff: [{ staff_id: uid(100), duration_override_min: null }, { staff_id: uid(101), duration_override_min: null }] })),
  offers: [], business_hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, is_closed: weekday === 1, open_time: '09:00', close_time: '19:00' })),
  templates: [0, 1].flatMap(i => Array.from({ length: 7 }, (_, weekday) => ({ staff_id: uid(100 + i), weekday, start_time: '09:00', end_time: '19:00' }))),
}
function ledger(date: string): Ledger {
  const reservations: Reservation[] = Array.from({ length: 8 }, (_, i) => {
    const starts = date + 'T' + String(10 + i).padStart(2, '0') + ':00:00+09:00'
    const ends = date + 'T' + String(11 + i).padStart(2, '0') + ':00:00+09:00'
    return { id: uid(900 + i), staff_id: uid(100 + i % 2), staff_name: staffNames[i % 2], nominated: true, staff_confirmed: i !== 5, client_id: uid(i + 1), customer_id: uid(i + 1), user_id: uid(i + 1), customer_name: names[i], customer_phone: null, starts_at: starts, ends_at: ends, occupied_until: ends, status: i < 2 ? 'completed' : i === 2 ? 'in_service' : 'confirmed', source: i % 2 ? 'hotpepper' : 'phone', external_ref: null, total_price: 5000, note: null, created_by: 'テイテイ', cancel_reason: null, items: [{ menu_code: 'preview-menu-0', name: '通常カット', duration_min: 60, price: 5000 }] }
  })
  return { date, slot_minutes: 15, closure: null, business_hours: { is_closed: false, open_time: '09:00', close_time: '19:00' }, staff: masters.staff.filter(s => s.is_bookable).map(s => ({ id: s.id, name: s.display_name, shifts: [{ start: date + 'T09:00:00+09:00', end: date + 'T19:00:00+09:00' }] })), blocks: [], reservations }
}
function dateSessions(date: string) { return sessions.filter(s => s.created_at.startsWith(date)) }
function clientRows() {
  return customers.map(c => { const rows = sessions.filter(s => s.user_id === c.user_id), sum = summarizeInsights(rows); return { id: c.id, name: c.name, kana: null, phone: null, phone_last4: c.phone_last4, app_linked: true, visit_count: rows.length, last_visit: rows[0]?.created_at.slice(0, 10) ?? null, main_stylist: sum.staff[0]?.name ?? null, next_reservation: null, total_sales: sum.sales, created_via: 'app', created_at: c.created_at } })
}

export async function previewHqRpc(fn: string, params: Record<string, unknown>): Promise<unknown> {
  if (!import.meta.env.DEV) throw new Error('Preview is unavailable')
  switch (fn) {
    case 'hq_accounting_sessions': return sessions.filter(s => (!params.p_from || Date.parse(s.created_at) >= Date.parse(String(params.p_from))) && (!params.p_to || Date.parse(s.created_at) < Date.parse(String(params.p_to))) && (!params.p_user_id || s.user_id === params.p_user_id))
    case 'hq_accounting_session_items': return items.filter(it => (params.p_session_ids as string[]).includes(it.session_id!))
    case 'hq_products_list': return products
    case 'hq_list_customers': return customers
    case 'hq_get_customer': return customers.find(c => c.user_id === params.p_user_id) ?? null
    case 'hq_day_ledger': return ledger(String(params.p_date))
    case 'hq_booking_masters': return masters
    case 'hq_booking_options': return { settings: masters.settings, menus: masters.menus.map(m => ({ code: m.code, name: m.name, duration_min: m.duration_min, price: m.price, staff_ids: m.staff.map(s => s.staff_id) })), staff: masters.staff.filter(s => s.is_bookable).map(s => ({ id: s.id, name: s.display_name })) }
    case 'hq_available_slots': return []
    case 'hq_list_schedule': {
      const days = []
      for (let date = String(params.p_from), n = 0; date <= String(params.p_to) && n < 62; date = shiftDate(date, 1), n++) for (const staff of masters.staff.filter(s => s.is_bookable)) days.push({ staff_id: staff.id, date, source: 'template', ranges: [{ start: '09:00', end: '19:00' }] })
      return { days, blocks: [], closures: [], reservations: [] }
    }
    case 'hq_daily_reports': return Array.from({ length: 5 }, (_, i) => { const date = shiftDate(today, -i - 1), summary = summarizeInsights(dateSessions(date)); return { id: uid(8000 + i), report_date: date, total_sales: summary.sales, customer_count: summary.count, average_spend: summary.unitPrice, stylist_summary: summary.staff.map(s => ({ name: s.name, sales: s.sales, visitors: s.count, unitPrice: s.unitPrice })), menu_summary: [], retail_summary: [], inventory_alerts: [], payment_summary: summary.payments, created_at: date + 'T19:30:00+09:00' } })
    case 'hq_list_clients': { const rows = clientRows().filter(c => !params.p_query || c.name.includes(String(params.p_query))); const filtered = params.p_app === 'non_app' ? [] : rows; const offset = Number(params.p_offset ?? 0); return { total: filtered.length, offset, rows: filtered.slice(offset, offset + 50) } }
    case 'hq_client_ledger':
    case 'hq_reservation_client': {
      const c = clientRows().find(c => c.id === params.p_client_id) ?? clientRows()[0]
      return { client: { id: c.id, name: c.name, kana: null, phone_last4: c.phone_last4, created_via: 'app', created_at: c.created_at, phones: [] }, app: { members: [{ name: c.name, phone_last4: c.phone_last4, created_at: c.created_at }], coupons: [] }, stats: { visit_count: c.visit_count, last_visit: c.last_visit, avg_interval_days: null, total_sales: c.total_sales, sales_count: c.visit_count }, stylists: [], item_usage: [], next_reservation: null, reservations: [], treatments: [], notes: [], merges: [] }
    }
    case 'hq_customer_notes':
    case 'hq_reservation_events':
    case 'hq_reassign_candidates':
    case 'hq_client_candidates':
    case 'hq_ginpay_audit': return []
    case 'hq_ginpay_reconcile': return { consistent: true, total_cached_balance: 0, total_ledger_balance: 0, accounts: [] }
    case 'hq_ginpay_ledger': return { accounts: [], transactions: [], merged_accounts: [], total_balance: 0 }
    case 'hq_sales': { const rows = dateSessions(String(params.p_date)); return { date: params.p_date, count: rows.length, total: summarizeInsights(rows).sales, voided: 0, rows: rows.map((s, i) => ({ id: s.id, status: 'completed', completed_at: s.created_at, customer_name: names[i % names.length], stylist_name: s.stylist_name, payment_method: s.payment_method, total: s.total, items: menuNames[i % menuNames.length], has_reservation: false })) } }
    case 'hq_sale_detail': { const s = sessions.find(s => s.id === params.p_id) ?? sessions[0]; return { id: s.id, status: 'completed', completed_at: s.created_at, client: null, customer_name: names[0], reservation: null, stylist_name: s.stylist_name, operator: s.staff_name, subtotal: s.total, discount_total: 0, total: s.total, payment_method: s.payment_method, tax_mode: null, tax_rate: null, items: [], discounts: [], payments: [{ method: s.payment_method, amount: s.total }], voided_at: null, voided_by: null, void_reason: null, events: [] } }
    case 'hq_messages_list': return []
    default: throw Object.assign(new Error('プレビューでは変更・保存できません。'), { code: 'preview_read_only' })
  }
}
