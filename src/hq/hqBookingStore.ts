// 本部：予約設定（スタッフ・メニュー・シフト・休み・設定）。すべて本部セッション付き RPC 経由
import { callHqRpc } from './hqSession'

export interface BookingSettings {
  slot_minutes: number
  booking_window_days: number
  min_lead_minutes: number
  hold_minutes: number
  customer_cancel_deadline_minutes: number
  app_booking_enabled: boolean
}
export interface StaffMember { id: string; display_name: string; is_bookable: boolean; is_active: boolean; sort_order: number }
export interface MenuStaff { staff_id: string; duration_override_min: number | null }
export interface ServiceMenu {
  id: string
  code: string
  name: string
  duration_min: number | null
  buffer_after_min: number
  price: number | null
  normal_price: number | null
  is_active: boolean
  sort_order: number
  staff: MenuStaff[]
}
export interface BusinessHour { weekday: number; is_closed: boolean; open_time: string | null; close_time: string | null }
export interface ShiftTemplate { staff_id: string; weekday: number; start_time: string; end_time: string }
export interface BookingMasters {
  settings: BookingSettings
  staff: StaffMember[]
  menus: ServiceMenu[]
  business_hours: BusinessHour[]
  templates: ShiftTemplate[]
}

/** その日の実際の勤務（source：template=通常週 / override=日付で変更 / off=日付で休み / none=勤務なし） */
export interface DaySchedule {
  staff_id: string
  date: string
  source: 'template' | 'override' | 'off' | 'none'
  ranges: { start: string; end: string }[]
}
export type BlockKind = 'break' | 'training' | 'store_event' | 'personal' | 'unavailable'
export interface TimeBlock { id: string; staff_id: string | null; starts_at: string; ends_at: string; kind: BlockKind; note: string | null }
export interface Schedule {
  days: DaySchedule[]
  blocks: TimeBlock[]
  closures: { date: string; reason: string | null }[]
  reservations: { staff_id: string; starts_at: string; occupied_until: string }[]
}

export const BLOCK_KIND_LABEL: Record<BlockKind, string> = {
  break: '休憩', training: '研修', store_event: '店内予定', personal: '個人的な予定', unavailable: '受付不可',
}

export const HQ_BOOKING_ERROR: Record<string, string> = {
  invalid_time: '開始・終了時刻を確認してください。',
  has_reservations: 'この時間に予約があるため変更・削除できません。先に予約を移動してください。',
  duration_required: '受付中にするには所要時間が必要です。',
  duplicate_code: 'このコードは使われています。',
  duplicate_name: '同じ名前のスタッフがいます。',
  invalid_value: '入力内容を確認してください。',
  not_found: '対象が見つかりません。',
  invalid_range: '表示期間が長すぎます。',
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土']

export function hqBookingErrorMessage(err: unknown): string {
  const e = err as { code?: string; detail?: { reservations?: { starts_at: string; customer_name: string; staff_name: string }[] } }
  const code = e?.code ?? ''
  const list = e?.detail?.reservations
  if (code === 'has_reservations' && list?.length) {
    const fmt = (iso: string) => {
      const d = new Date(iso)
      const p = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d)
      const get = (t: string) => p.find(x => x.type === t)?.value ?? ''
      const w = WEEK[new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(d) + 'T00:00:00Z').getUTCDay()]
      return `${get('month')}/${get('day')}（${w}）${get('hour')}:${get('minute')}`
    }
    const shown = list.slice(0, 5).map(r => `${fmt(r.starts_at)} ${r.customer_name}（${r.staff_name}）`).join('、')
    return `次の予約が勤務時間外になるため保存できません：${shown}${list.length > 5 ? ` ほか${list.length - 5}件` : ''}。先に予約を移動してください。`
  }
  return HQ_BOOKING_ERROR[code] ?? '保存に失敗しました。通信環境を確認して再度お試しください。'
}

export const getBookingMasters = () => callHqRpc<BookingMasters>('hq_booking_masters')
export const updateBookingSettings = (p: Partial<BookingSettings>) => callHqRpc<BookingSettings>('hq_update_booking_settings', { p })
export const upsertStaffMember = (p: Partial<StaffMember>) => callHqRpc<StaffMember>('hq_upsert_staff_member', { p })
export const upsertMenu = (p: Partial<Omit<ServiceMenu, 'staff'>> & { staff?: MenuStaff[] }) => callHqRpc<ServiceMenu>('hq_upsert_menu', { p })
export const getSchedule = (from: string, to: string) => callHqRpc<Schedule>('hq_list_schedule', { p_from: from, p_to: to })
/** 通常週を丸ごと保存（含まれない曜日は休み） */
export const setShiftTemplate = (staffId: string, days: { weekday: number; start_time: string; end_time: string }[]) =>
  callHqRpc<{ ok: true }>('hq_set_shift_template', { p_staff_id: staffId, p_days: days })
/** 日付ごとの上書き：work（その日の出勤時間）/ off（休み）/ template（通常週に戻す） */
export const setDaySchedule = (staffId: string, date: string, mode: 'work' | 'off' | 'template', start?: string, end?: string) =>
  callHqRpc<{ ok: true }>('hq_set_day_schedule', { p_staff_id: staffId, p_date: date, p_mode: mode, p_start: start ?? null, p_end: end ?? null })
/** 営業時間を丸ごと保存（含まれない曜日は制限なし） */
export const setBusinessHours = (days: BusinessHour[]) => callHqRpc<{ ok: true }>('hq_set_business_hours', { p_days: days })
export const createTimeBlock = (p: { staff_id: string | null; starts_at: string; ends_at: string; kind: BlockKind; note?: string }) =>
  callHqRpc<TimeBlock>('hq_create_time_block', { p })
export const deleteTimeBlock = (id: string) => callHqRpc<{ ok: true }>('hq_delete_time_block', { p_block_id: id })
export const setClosure = (date: string, reason: string) => callHqRpc<{ ok: true }>('hq_set_closure', { p_date: date, p_reason: reason })
export const deleteClosure = (date: string) => callHqRpc<{ ok: true }>('hq_delete_closure', { p_date: date })

/** JST の日付＋時刻（HH:MM）→ ISO（+09:00） */
export const jstIso = (date: string, hm: string) => `${date}T${hm}:00+09:00`
