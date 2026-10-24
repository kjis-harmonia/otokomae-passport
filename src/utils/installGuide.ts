// ホーム画面に追加：端末の見分けと、Android の追加の合図（画面より先に受け取っておく）。案内のシートは components/InstallGuide.tsx
export const SHOW_INSTALL_GUIDE_EVENT = 'ginjiro:show-install-guide'
export const INSTALL_GUIDE_KEY = 'ginjiro_install_guide'
export const WAIT_DAYS = 7
export const MAX_AUTO = 3


export type InstallKind = 'ios' | 'inapp' | 'ios-other' | 'android' | null

export interface InstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
// Android の Chrome：追加できるようになったときの合図を、画面より先に受け取っておく
let deferred: InstallPromptEvent | null = null
export const installPrompt = { get: () => deferred, clear: () => { deferred = null } }
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e as InstallPromptEvent })
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true
}

export function detect(): InstallKind {
  if (typeof navigator === 'undefined' || isStandalone()) return null
  // 開発中だけ：?install=ios などで見た目を確かめる
  if (import.meta.env.DEV) { const p = new URLSearchParams(window.location.search).get('install'); if (p === 'ios' || p === 'inapp' || p === 'ios-other' || p === 'android') return p }
  const ua = navigator.userAgent
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (/Line\/|Instagram|FBAN|FBAV|FB_IAB|Twitter|TikTok/i.test(ua)) return 'inapp'
  if (ios) return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'ios-other' : 'ios'
  if (/Android/.test(ua)) return 'android'
  return null
}

/** LINE のアプリ内ブラウザで開いたら、自動で Safari（外部ブラウザ）で開き直す（?openExternalBrowser=1 は LINE の決まり）。
 *  一度付けて開き直しても LINE のままなら、それ以上は繰り返さない */
export function openInSafariIfLine(): void {
  if (typeof window === 'undefined' || !/Line\//i.test(navigator.userAgent)) return
  const u = new URL(window.location.href)
  if (u.searchParams.has('openExternalBrowser')) return
  u.searchParams.set('openExternalBrowser', '1')
  window.location.replace(u.toString())
}

/** マイページに「ホーム画面に追加」を出すか（ホーム画面から開いていない、案内できる端末） */
export function canShowInstallGuide(): boolean {
  return detect() !== null
}

/** 初めて登録する前に「ホーム画面に追加」が要るか（iPhone の Safari・アプリ内ブラウザ）。
 *  iPhone は Safari とホーム画面のアプリで保存場所が別：Safari で登録してから追加すると、アプリでもう一度登録になる（会員が二重になる） */
export function needsInstallFirst(): boolean {
  const k = detect()
  return k === 'ios' || k === 'ios-other' || k === 'inapp'
}
