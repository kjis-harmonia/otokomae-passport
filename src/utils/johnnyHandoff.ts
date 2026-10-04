/** スタイルから予約相談への引き継ぎ。予約メニューは含めない（確認済みの対応表からサーバーが決める） */
export interface JohnnyHandoff {
  styleTitle?: string
  styleSlug?: string
  tryonStyleId?: string | null
}
/** 古い引き継ぎで予約相談を始めない */
const HANDOFF_TTL_MS = 30 * 60 * 1000

const JOHNNY_HANDOFF_KEY = 'ginjiro_johnny_handoff'

export function saveJohnnyHandoff(handoff: JohnnyHandoff): void {
  try {
    localStorage.setItem(JOHNNY_HANDOFF_KEY, JSON.stringify({ ...handoff, savedAt: new Date().toISOString() }))
  } catch {
    /* ignore */
  }
}

export function loadJohnnyHandoff(): JohnnyHandoff | null {
  try {
    const raw = localStorage.getItem(JOHNNY_HANDOFF_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as JohnnyHandoff & { savedAt?: string }
    if (!parsed.savedAt || Date.now() - new Date(parsed.savedAt).getTime() > HANDOFF_TTL_MS) { clearJohnnyHandoff(); return null }
    if (!parsed.styleTitle && !parsed.styleSlug && !parsed.tryonStyleId) return null
    return { styleTitle: parsed.styleTitle, styleSlug: parsed.styleSlug, tryonStyleId: parsed.tryonStyleId ?? null }
  } catch {
    return null
  }
}

export function clearJohnnyHandoff(): void {
  try {
    localStorage.removeItem(JOHNNY_HANDOFF_KEY)
  } catch {
    /* ignore */
  }
}
