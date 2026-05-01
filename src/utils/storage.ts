import type { MemberStatus, Coupon } from '../data/brand'
import { DEFAULT_MEMBER_STATUS } from '../data/brand'

export const MEMBER_KEY = 'otokomae_member'
export const GACHA_DATE_KEY = 'otokomae_gacha_date'
export const GACHA_RESULT_KEY = 'otokomae_gacha_result'
export const TRYON_STYLE_KEY = 'otokomae_tryon_style'
export const RESERVE_MENU_KEY = 'otokomae_reserve_menu'
export const RESERVE_TIME_KEY = 'otokomae_reserve_time'

export function getStoredValue<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function setStoredValue<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // localStorage unavailable (private browsing, storage quota exceeded)
  }
}

export function removeStoredValue(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // localStorage unavailable
  }
}

export const MEMBER_STATUS_KEY = 'otokomae_member_status'

export function loadMemberStatus(): MemberStatus {
  return getStoredValue<MemberStatus>(MEMBER_STATUS_KEY, DEFAULT_MEMBER_STATUS)
}

export function saveMemberStatus(status: MemberStatus): void {
  setStoredValue(MEMBER_STATUS_KEY, status)
}

export const COUPONS_KEY = 'otokomae_coupons'

export function loadCoupons(): Coupon[] {
  return getStoredValue<Coupon[]>(COUPONS_KEY, [])
}

export function saveCoupons(coupons: Coupon[]): void {
  setStoredValue(COUPONS_KEY, coupons)
}
