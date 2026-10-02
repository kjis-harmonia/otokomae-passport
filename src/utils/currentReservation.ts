import { getStoredValue, setStoredValue } from './storage'

export const CURRENT_RESERVATION_KEY = 'ginjiro_current_reservation'
export const CURRENT_RESERVATION_CHANGED_EVENT = 'ginjiro:current-reservation-changed'

export type CurrentReservation = {
  kind: 'cut-special'
  id: string
  title: string
  menuLabel: string
  normalPrice?: number | null
  memberPrice: number
  benefit: string
  bookingMethod: 'phone'
  reservedAt: string
}

function isReservation(value: unknown): value is CurrentReservation {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<CurrentReservation>
  return (
    v.kind === 'cut-special' &&
    typeof v.id === 'string' &&
    typeof v.title === 'string' &&
    typeof v.menuLabel === 'string' &&
    typeof v.memberPrice === 'number' &&
    v.bookingMethod === 'phone' &&
    typeof v.reservedAt === 'string'
  )
}

export function normalizeCurrentReservation(value: unknown): CurrentReservation | null {
  if (!isReservation(value)) return null
  return {
    kind: value.kind,
    id: value.id,
    title: value.title,
    menuLabel: value.menuLabel,
    normalPrice: typeof value.normalPrice === 'number' ? value.normalPrice : null,
    memberPrice: value.memberPrice,
    benefit: typeof value.benefit === 'string' ? value.benefit : '',
    bookingMethod: value.bookingMethod,
    reservedAt: value.reservedAt,
  }
}

export function loadCurrentReservation(): CurrentReservation | null {
  return normalizeCurrentReservation(getStoredValue<unknown>(CURRENT_RESERVATION_KEY, null))
}

export function saveCurrentReservation(reservation: CurrentReservation): void {
  setStoredValue(CURRENT_RESERVATION_KEY, reservation)
  window.dispatchEvent(new CustomEvent(CURRENT_RESERVATION_CHANGED_EVENT, { detail: reservation }))
}
