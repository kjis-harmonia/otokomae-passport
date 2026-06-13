import { getStoredValue, setStoredValue } from './storage'

export const USER_ID_KEY          = 'ginjiro_user_id'
export const MEMBER_ISSUED_AT_KEY = 'ginjiro_member_issued_at'

export function getUserId(): string {
  const existing = getStoredValue<string | null>(USER_ID_KEY, null)
  if (existing) return existing
  const id = `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  setStoredValue(USER_ID_KEY, id)
  return id
}

/** 男前証発行日時。初回呼び出し時に確定し、以後は同値を返す。 */
export function getMemberIssuedAt(): string {
  const existing = getStoredValue<string | null>(MEMBER_ISSUED_AT_KEY, null)
  if (existing) return existing
  const now = new Date().toISOString()
  setStoredValue(MEMBER_ISSUED_AT_KEY, now)
  return now
}

/** 会員QRに埋め込むペイロードを JSON 文字列で返す。 */
export function getMemberQrPayload(name: string): string {
  return JSON.stringify({
    type:     'ginjiro-member',
    userId:   getUserId(),
    name,
    issuedAt: getMemberIssuedAt(),
  })
}
