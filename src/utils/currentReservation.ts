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

type ReservationPreset = Omit<CurrentReservation, 'reservedAt'>

const RESERVATION_PRESETS: Record<string, ReservationPreset> = {
  'cut-teitei-special': {
    kind: 'cut-special',
    id: 'cut-teitei-special',
    title: 'テイテイSpecialクーポン',
    menuLabel: '天空の髪ピチュ FULL COURSE',
    normalPrice: null,
    memberPrice: 6800,
    benefit: 'カット・ヘッドスパ・顔剃り・マッサージ',
    bookingMethod: 'phone',
  },
  'cut-ginjiro-special': {
    kind: 'cut-special',
    id: 'cut-ginjiro-special',
    title: '銀二郎Specialクーポン',
    menuLabel: 'スキンフェードカット',
    normalPrice: 4500,
    memberPrice: 4000,
    benefit: '顔剃り・シャンプー付き',
    bookingMethod: 'phone',
  },
}

export type CurrentReservationQrPayload = {
  /** reservation id */
  i: string
  /** reservedAt ISO timestamp */
  a?: string
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

function isCompactReservation(value: unknown): value is CurrentReservationQrPayload {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<CurrentReservationQrPayload>
  return typeof v.i === 'string'
}

export function normalizeCurrentReservation(value: unknown): CurrentReservation | null {
  if (isCompactReservation(value)) {
    const preset = RESERVATION_PRESETS[value.i]
    if (!preset) return null
    return {
      ...preset,
      reservedAt: typeof value.a === 'string' ? value.a : new Date(0).toISOString(),
    }
  }
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

export function toCurrentReservationQrPayload(reservation: CurrentReservation | null): CurrentReservationQrPayload | undefined {
  if (!reservation) return undefined
  return {
    i: reservation.id,
    a: reservation.reservedAt,
  }
}

export function loadCurrentReservation(): CurrentReservation | null {
  return normalizeCurrentReservation(getStoredValue<unknown>(CURRENT_RESERVATION_KEY, null))
}

export function saveCurrentReservation(reservation: CurrentReservation): void {
  setStoredValue(CURRENT_RESERVATION_KEY, reservation)
  window.dispatchEvent(new CustomEvent(CURRENT_RESERVATION_CHANGED_EVENT, { detail: reservation }))
}
