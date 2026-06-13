const IN_STORE_KEY = 'ginjiro_in_store_mode'
const EXPIRE_MS = 2 * 60 * 60 * 1000 // 2 hours

interface InStoreState {
  activatedAt: string
}

export function isInStoreModeActive(): boolean {
  try {
    const s = localStorage.getItem(IN_STORE_KEY)
    if (!s) return false
    const { activatedAt } = JSON.parse(s) as InStoreState
    return Date.now() - new Date(activatedAt).getTime() < EXPIRE_MS
  } catch {
    return false
  }
}

export function activateInStoreMode(): void {
  localStorage.setItem(IN_STORE_KEY, JSON.stringify({ activatedAt: new Date().toISOString() }))
}

export function clearInStoreMode(): void {
  localStorage.removeItem(IN_STORE_KEY)
}
