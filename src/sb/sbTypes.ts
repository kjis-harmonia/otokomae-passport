import type { BookingOptions, Ledger, NewReservationInput, Reservation } from '../utils/bookingApi'

export type TransferStatus = 'pending' | 'done' | 'not_required'
/** ginpay_paid：銀Pay で前もって支払い済み（仮支払い中・会計で確定済み） */
export type SbReservation = Reservation & { booking_lane: number; transfer_status: TransferStatus; updated_at: string; ginpay_paid?: boolean
  /** お客様のフリガナ（顧客台帳・HOT PEPPER のメール）。分からなければ null（11/21） */
  customer_kana?: string | null }
export type SbOptions = Omit<BookingOptions, 'staff' | 'menus'> & {
  actors: { id: string; name: string }[]
  staff: (BookingOptions['staff'][number] & { capacity: number })[]
  menus: (BookingOptions['menus'][number] & { category: string | null })[]
}
export type SbLedger = Omit<Ledger, 'reservations' | 'staff'> & {
  reservations: SbReservation[]
  staff: (Ledger['staff'][number] & { capacity: number })[]
}
/** customer_kana：フォームで入れたフリガナ。予約の DB には送らず、登録のあとで顧客台帳に入れる（11/21） */
export type SbInput = NewReservationInput & { customer_kana?: string }
export interface SbPlanItem { menu_code: string; name: string; duration_min: number; price: number | null }
export interface SbPreview {
  staff_id: string
  duration_min: number
  buffer_min: number
  total_price: number | null
  items: SbPlanItem[]
  plan_hash: string
}
export type SbCommand =
  | { kind: 'create'; input: SbInput; plan_hash: string }
  | { kind: 'edit'; reservation_id: string; expected_updated_at: string; input: SbInput; plan_hash: string }
  | { kind: 'cancel'; reservation_id: string; expected_updated_at: string; reason: string }
  | { kind: 'transfer'; reservation_id: string; expected_updated_at: string; transfer_status: TransferStatus }
  | { kind: 'status'; reservation_id: string; expected_updated_at: string; status: 'checked_in' | 'completed' | 'no_show' }

export interface SbPending { version: 1; id: string; actor: string; command: SbCommand; saved_at: string }
