import type { BookingOptions, Ledger, NewReservationInput, Reservation } from '../utils/bookingApi'

export type TransferStatus = 'pending' | 'done' | 'not_required'
export type SbReservation = Reservation & { booking_lane: number; transfer_status: TransferStatus; updated_at: string }
export type SbOptions = Omit<BookingOptions, 'staff' | 'menus'> & {
  actors: { id: string; name: string }[]
  staff: (BookingOptions['staff'][number] & { capacity: number })[]
  menus: (BookingOptions['menus'][number] & { category: string | null })[]
}
export type SbLedger = Omit<Ledger, 'reservations' | 'staff'> & {
  reservations: SbReservation[]
  staff: (Ledger['staff'][number] & { capacity: number })[]
}
export type SbInput = NewReservationInput
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
