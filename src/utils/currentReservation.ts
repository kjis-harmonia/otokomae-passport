import { getStoredValue, setStoredValue, removeStoredValue } from './storage'
import { getJapanDateString } from './dateUtils'

export const CURRENT_RESERVATION_KEY = 'ginjiro_current_reservation'
export const CURRENT_RESERVATION_CHANGED_EVENT = 'ginjiro:current-reservation-changed'

/**
 * Specialクーポンの電話予約（端末内のみ・サーバーには保存しない）。
 *
 * - 予約日（visitDate, JST の YYYY-MM-DD）を必ず持つ。予約割引が有効なのは予約日当日だけ。
 * - 予約日を過ぎた予約は端末から自動で削除する（次回来店時に同じ予約で再割引されない）。
 * - 会員QRには予約ID と予約日だけを入れる。メニュー名・価格は店舗端末が下のマスタから復元し、
 *   QR に含まれる価格は新形式・旧形式とも一切使わない。
 */
export type CurrentReservation = {
  kind: 'cut-special'
  id: string
  title: string
  menuLabel: string
  normalPrice?: number | null
  memberPrice: number
  benefit: string
  bookingMethod: 'phone'
  /** 予約日（JST, YYYY-MM-DD）。この日だけ有効 */
  visitDate: string
  reservedAt: string
}

type ReservationPreset = Omit<CurrentReservation, 'visitDate' | 'reservedAt'>

/** Specialクーポンのマスタ（店舗端末の表示価格の正） */
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

/** 予約日に選べる範囲（今日から） */
export const RESERVATION_MAX_DAYS_AHEAD = 60

export type CurrentReservationQrPayload = {
  /** reservation id */
  i: string
  /** 予約日（JST, YYYY-MM-DD） */
  d: string
  /** reservedAt ISO timestamp（旧版との互換用） */
  a?: string
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

function isYmd(value: unknown): value is string {
  return typeof value === 'string' && YMD.test(value)
}

/** ISO 日時 → JST の日付。不正なら null */
function japanDateOf(iso: unknown): string | null {
  if (typeof iso !== 'string') return null
  const t = new Date(iso)
  return Number.isNaN(t.getTime()) ? null : getJapanDateString(t)
}

/** 予約ID と予約日から予約を作る（価格・メニューは必ずマスタから） */
export function createReservation(id: string, visitDate: string, reservedAt = new Date().toISOString()): CurrentReservation | null {
  const preset = RESERVATION_PRESETS[id]
  if (!preset || !isYmd(visitDate)) return null
  return { ...preset, visitDate, reservedAt }
}

/**
 * QR・端末保存の予約データを正規化する。
 *   新形式 { i, d, a? } / 旧形式（全文: kind, id, title, …, reservedAt）のどちらも読めるが、
 *   使うのは予約ID と日付だけ。価格・メニュー名など QR 側の値は無視してマスタから復元する。
 *   予約日が無い旧データは、予約した日（reservedAt の JST 日付）を予約日とみなす。
 */
export function normalizeCurrentReservation(value: unknown): CurrentReservation | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const id = typeof v.i === 'string' ? v.i : v.kind === 'cut-special' && typeof v.id === 'string' ? v.id : null
  if (!id) return null
  const reservedAt = typeof v.a === 'string' ? v.a : typeof v.reservedAt === 'string' ? v.reservedAt : null
  const visitDate = isYmd(v.d) ? v.d : isYmd(v.visitDate) ? v.visitDate : japanDateOf(reservedAt)
  if (!visitDate) return null
  return createReservation(id, visitDate, reservedAt ?? new Date(0).toISOString())
}

/** その予約が指定日（既定: 今日 JST）に有効か */
export function isReservationForDate(reservation: CurrentReservation | null, date = getJapanDateString()): boolean {
  return !!reservation && reservation.visitDate === date
}

/** 予約日を過ぎているか */
export function isReservationPast(reservation: CurrentReservation, today = getJapanDateString()): boolean {
  return reservation.visitDate < today
}

export function toCurrentReservationQrPayload(reservation: CurrentReservation | null): CurrentReservationQrPayload | undefined {
  if (!reservation || isReservationPast(reservation)) return undefined
  return { i: reservation.id, d: reservation.visitDate }
}

/** 端末に保存された予約。予約日を過ぎたものは削除して null */
export function loadCurrentReservation(): CurrentReservation | null {
  const reservation = normalizeCurrentReservation(getStoredValue<unknown>(CURRENT_RESERVATION_KEY, null))
  if (reservation && !isReservationPast(reservation)) return reservation
  if (getStoredValue<unknown>(CURRENT_RESERVATION_KEY, null) !== null) clearCurrentReservation()
  return null
}

export function saveCurrentReservation(reservation: CurrentReservation): void {
  setStoredValue(CURRENT_RESERVATION_KEY, reservation)
  window.dispatchEvent(new CustomEvent(CURRENT_RESERVATION_CHANGED_EVENT, { detail: reservation }))
}

export function clearCurrentReservation(): void {
  removeStoredValue(CURRENT_RESERVATION_KEY)
  window.dispatchEvent(new CustomEvent(CURRENT_RESERVATION_CHANGED_EVENT, { detail: null }))
}
