// 予約台帳・予約操作のクライアント。店舗端末（スタッフセッション）と本部（本部セッション）で同じ画面を使い、
// 呼び出す RPC だけを差し替える。テーブルへは直接アクセスしない。予約の可否判定はすべて DB 側の予約エンジン。
import { callStaffRpc } from './staffSession'
import { callHqRpc } from '../hq/hqSession'

export type ReservationStatus = 'confirmed' | 'checked_in' | 'in_service' | 'awaiting_payment' | 'completed' | 'cancelled' | 'no_show'
export type ReservationSource = 'app' | 'hotpepper' | 'phone' | 'staff'

export interface ReservationItem { menu_code: string; name: string; duration_min: number; price: number | null }
export interface Reservation {
  id: string
  staff_id: string
  staff_name: string
  /** お客様の指名あり（false＝フリー） */
  nominated: boolean
  /** 担当の確定。フリー予約は実在のスタッフに仮で割り当てられ、店舗が後で確定する */
  staff_confirmed: boolean
  /** 顧客（必ずある。App 会員でなくても） */
  client_id: string
  /** App からの予約の App 会員 */
  customer_id: string | null
  user_id: string | null
  customer_name: string
  customer_phone: string | null
  starts_at: string
  ends_at: string
  occupied_until: string
  status: ReservationStatus
  source: ReservationSource
  external_ref: string | null
  total_price: number | null
  note: string | null
  created_by: string | null
  cancel_reason: string | null
  items: ReservationItem[]
}

export interface BookingMenu { code: string; name: string; duration_min: number; price: number | null; staff_ids: string[] }
export interface BookingStaff { id: string; name: string }
export interface BookingOptions {
  settings: { slot_minutes: number; booking_window_days: number; min_lead_minutes: number }
  menus: BookingMenu[]
  staff: BookingStaff[]
}
export interface AvailableSlot { starts_at: string; staff_id: string; staff_name: string }
export interface ReservationEvent {
  event_type: 'created' | 'rescheduled' | 'staff_changed' | 'staff_confirmed' | 'cancelled' | 'checked_in' | 'in_service' | 'awaiting_payment' | 'completed' | 'no_show'
  actor_type: string
  actor_name: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  note: string | null
  created_at: string
}

/** 予約台帳（1日分） */
export interface Ledger {
  date: string
  slot_minutes: number
  closure: { reason: string | null } | null
  business_hours: { is_closed: boolean; open_time: string | null; close_time: string | null } | null
  staff: { id: string; name: string; shifts: { start: string; end: string }[] }[]
  blocks: { id: string; staff_id: string | null; starts_at: string; ends_at: string; kind: string }[]
  reservations: Reservation[]
}

export interface NewReservationInput {
  starts_at: string
  menu_codes: string[]
  staff_id: string | null
  customer_name: string
  customer_phone?: string
  source: 'phone' | 'hotpepper' | 'staff'
  external_ref?: string
  note?: string
  /** 既存の顧客を選んだとき（なければ新しい顧客として登録） */
  client_id?: string
}

export type Result<T> = T | { error: string }
export type StoreStatus = 'checked_in' | 'in_service' | 'awaiting_payment' | 'completed' | 'no_show' | 'cancelled'

/** 店舗端末・本部で共通の操作。中身は各セッションの RPC */
export interface BookingApi {
  ledger(date: string): Promise<Ledger>
  options(): Promise<BookingOptions>
  slots(date: string, menuCodes: string[], staffId: string | null, excludeReservationId?: string): Promise<AvailableSlot[]>
  create(input: NewReservationInput): Promise<Result<Reservation>>
  reschedule(id: string, startsAt: string, staffId: string | null): Promise<Result<Reservation>>
  setStatus(id: string, status: StoreStatus, reason?: string): Promise<Result<Reservation>>
  events(id: string): Promise<ReservationEvent[]>
  /** 同じ時間のまま担当を代われるスタッフ（来店後も可。判定は日時・担当変更と同じ） */
  reassignCandidates(id: string): Promise<BookingStaffCandidate[]>
}
export interface BookingStaffCandidate { staff_id: string; staff_name: string }

export const SOURCE_LABEL: Record<ReservationSource, string> = {
  app: 'アプリ', hotpepper: 'HOT PEPPER', phone: '電話', staff: '店舗入力',
}
export const STATUS_LABEL: Record<ReservationStatus, string> = {
  confirmed: '予約済み', checked_in: '来店済み', in_service: '施術中', awaiting_payment: '会計待ち',
  completed: '完了', no_show: '無断キャンセル', cancelled: 'キャンセル',
}
export const BLOCK_LABEL: Record<string, string> = {
  break: '休憩', training: '研修', store_event: '店内予定', personal: '予定', unavailable: '受付不可',
}

export const BOOKING_ERROR_MESSAGE: Record<string, string> = {
  slot_taken: 'その時間は埋まっています。別の時間を選んでください。',
  too_late: 'その時間は受付を締め切りました。',
  date_not_open: 'その日は予約を受け付けていません（店休日または受付期間外）。',
  menu_not_available: 'この担当者ではそのメニューを受けられません。',
  invalid_starts_at: '開始時刻が正しくありません。',
  invalid_customer_name: 'お客様の名前を入力してください。',
  invalid_phone: '電話番号が長すぎます。',
  invalid_note: 'メモが長すぎます（500文字まで）。',
  duplicate_external_ref: 'この HOT PEPPER 予約番号はすでに登録されています。',
  invalid_status: 'この予約はその操作ができない状態です。',
  not_started: '開始時刻を過ぎてから「無断キャンセル」にできます。',
  not_found: '予約が見つかりません。',
  try_again: 'ほかの操作と重なりました。もう一度お試しください。',
}

export function bookingErrorMessage(code: string): string {
  return BOOKING_ERROR_MESSAGE[code] ?? '処理に失敗しました。通信環境を確認して再度お試しください。'
}

/** RPC は { error } を例外として投げる。予約の業務エラーは画面で扱いやすいようにコードで返す */
async function asResult<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return await fn()
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code && BOOKING_ERROR_MESSAGE[code]) return { error: code }
    throw err
  }
}

/** 店舗端末用。予約の登録・変更の記録に残る操作者名（担当者）を都度渡す */
export function createStaffBookingApi(actor: () => string): BookingApi {
  return {
    ledger: date => callStaffRpc<Ledger>('staff_day_ledger', { p_date: date }),
    options: () => callStaffRpc<BookingOptions>('staff_booking_options', {}),
    slots: async (date, menuCodes, staffId, excludeId) => (await callStaffRpc<AvailableSlot[] | null>('staff_available_slots', {
      p_date: date, p_menu_codes: menuCodes, p_staff_id: staffId, p_exclude_reservation: excludeId ?? null,
    })) ?? [],
    create: input => asResult(() => callStaffRpc<Reservation>('staff_create_reservation', { p: input, p_staff_name: actor() })),
    reschedule: (id, startsAt, staffId) => asResult(() => callStaffRpc<Reservation>('staff_reschedule_reservation', {
      p_reservation_id: id, p_starts_at: startsAt, p_staff_id: staffId, p_staff_name: actor(),
    })),
    setStatus: (id, status, reason) => asResult(() => callStaffRpc<Reservation>('staff_set_reservation_status', {
      p_reservation_id: id, p_status: status, p_staff_name: actor(), p_reason: reason ?? null,
    })),
    events: async id => (await callStaffRpc<ReservationEvent[] | null>('staff_reservation_events', { p_reservation_id: id })) ?? [],
    reassignCandidates: async id => (await callStaffRpc<BookingStaffCandidate[] | null>('staff_reassign_candidates', { p_reservation_id: id })) ?? [],
  }
}

/** 本部用。記録上の操作者は「本部」 */
export const hqBookingApi: BookingApi = {
  ledger: date => callHqRpc<Ledger>('hq_day_ledger', { p_date: date }),
  options: () => callHqRpc<BookingOptions>('hq_booking_options'),
  slots: async (date, menuCodes, staffId, excludeId) => (await callHqRpc<AvailableSlot[] | null>('hq_available_slots', {
    p_date: date, p_menu_codes: menuCodes, p_staff_id: staffId, p_exclude_reservation: excludeId ?? null,
  })) ?? [],
  create: input => asResult(() => callHqRpc<Reservation>('hq_create_reservation', { p: input })),
  reschedule: (id, startsAt, staffId) => asResult(() => callHqRpc<Reservation>('hq_reschedule_reservation', {
    p_reservation_id: id, p_starts_at: startsAt, p_staff_id: staffId,
  })),
  setStatus: (id, status, reason) => asResult(() => callHqRpc<Reservation>('hq_set_reservation_status', {
    p_reservation_id: id, p_status: status, p_reason: reason ?? null,
  })),
  events: async id => (await callHqRpc<ReservationEvent[] | null>('hq_reservation_events', { p_reservation_id: id })) ?? [],
  reassignCandidates: async id => (await callHqRpc<BookingStaffCandidate[] | null>('hq_reassign_candidates', { p_reservation_id: id })) ?? [],
}

// ── 日付・時刻（JST） ──────────────────────────────────────────────────────────

const JST = 'Asia/Tokyo'

export function jstTime(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: JST, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))
}

export function jstDateLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const w = ['日', '月', '火', '水', '木', '金', '土'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${m}月${d}日（${w}）`
}

/** JST の日付＋分（0:00 からの分）→ ISO */
export function jstIsoFromMinutes(ymd: string, minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0')
  const m = String(minutes % 60).padStart(2, '0')
  return new Date(`${ymd}T${h}:${m}:00+09:00`).toISOString()
}

/** ISO → その日の JST 0:00 からの分 */
export function jstMinutesOf(iso: string, ymd: string): number {
  return Math.round((new Date(iso).getTime() - new Date(`${ymd}T00:00:00+09:00`).getTime()) / 60000)
}

export function yen(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : `¥${n.toLocaleString()}`
}
