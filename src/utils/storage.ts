import type { MemberStatus, Coupon } from '../data/brand'
import { DEFAULT_MEMBER_STATUS } from '../data/brand'
import { getRankByPoints, getSafeRank } from './rank'

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
  const stored = getStoredValue<Partial<MemberStatus>>(MEMBER_STATUS_KEY, DEFAULT_MEMBER_STATUS)
  const points = typeof stored.points === 'number' ? stored.points : DEFAULT_MEMBER_STATUS.points
  const currentRank = stored.rank ?? DEFAULT_MEMBER_STATUS.rank
  const computedRank = getRankByPoints(points)

  return {
    ...DEFAULT_MEMBER_STATUS,
    ...stored,
    points,
    rank: getSafeRank(currentRank, computedRank),
  }
}

export function saveMemberStatus(status: MemberStatus): void {
  setStoredValue(MEMBER_STATUS_KEY, status)
}

export const ONBOARDING_DONE_KEY = 'ginjiro:onboarding_done'
export const ONBOARDING_NAME_KEY = 'ginjiro:member_name'

export const COUPONS_KEY = 'otokomae_coupons'

const COUPON_TITLE_MAP: Record<string, string> = {
  'preset-discount-300': '夏ガチャ割引券',
  'preset-cut-1000':     '漢トク券',
  'preset-otoku-1000':   '漢トク券',
}

export function loadCoupons(): Coupon[] {
  const raw = getStoredValue<Coupon[]>(COUPONS_KEY, [])
  const migrated = raw.map(c =>
    c.id === 'preset-cut-1000'
      ? { ...c, id: 'preset-otoku-1000', title: '漢トク券' }
      : COUPON_TITLE_MAP[c.id] ? { ...c, title: COUPON_TITLE_MAP[c.id] } : c
  )
  if (JSON.stringify(migrated) !== JSON.stringify(raw)) {
    setStoredValue(COUPONS_KEY, migrated)
  }
  return migrated
}

export function saveCoupons(coupons: Coupon[]): void {
  setStoredValue(COUPONS_KEY, coupons)
}
