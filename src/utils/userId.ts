import { getStoredValue, setStoredValue } from './storage'

export const USER_ID_KEY = 'ginjiro_user_id'

export function getUserId(): string {
  const existing = getStoredValue<string | null>(USER_ID_KEY, null)
  if (existing) return existing
  const id = `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  setStoredValue(USER_ID_KEY, id)
  return id
}
