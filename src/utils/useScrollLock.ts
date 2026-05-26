import { useEffect } from 'react'

/**
 * モーダル表示中に背景スクロールを完全ロックするフック。
 *
 * 対策1: .app-main に position:fixed を適用（iOS Safari scroll bleed 防止）
 * 対策2: document レベルで touchmove を非パッシブリスナーで封鎖し、
 *         [data-modal-scroll] 属性を持つ要素内のみスクロールを許可する
 *
 * 使い方:
 *   - モーダルコンポーネントの先頭で useScrollLock() を呼ぶ
 *   - モーダル内のスクロール担当要素に data-modal-scroll 属性を付与する
 *
 * クリーンアップ: コンポーネントアンマウント時に自動で元の状態へ戻す
 */
export function useScrollLock(): void {
  useEffect(() => {
    /* ── 1. app-main を position:fixed でフリーズ ─────────────────── */
    const appMain = document.querySelector<HTMLElement>('.app-main')

    let savedScrollTop = 0
    let savedOverflow = ''
    let savedPosition = ''
    let savedTop = ''
    let savedWidth = ''

    if (appMain) {
      savedScrollTop = appMain.scrollTop
      savedOverflow  = appMain.style.overflow
      savedPosition  = appMain.style.position
      savedTop       = appMain.style.top
      savedWidth     = appMain.style.width

      appMain.style.overflow = 'hidden'
      appMain.style.position = 'fixed'
      appMain.style.top      = `-${savedScrollTop}px`
      appMain.style.width    = '100%'
    }

    /* ── 2. document touchmove を非パッシブで封鎖 ─────────────────── */
    const preventScroll = (e: TouchEvent) => {
      const target = e.target as Element | null
      // [data-modal-scroll] 属性を持つ要素の内側からのスクロールは通す
      if (!target?.closest?.('[data-modal-scroll]')) {
        e.preventDefault()
      }
    }
    document.addEventListener('touchmove', preventScroll, { passive: false })

    /* ── クリーンアップ ────────────────────────────────────────────── */
    return () => {
      if (appMain) {
        appMain.style.overflow = savedOverflow
        appMain.style.position = savedPosition
        appMain.style.top      = savedTop
        appMain.style.width    = savedWidth
        // 元のスクロール位置を復元
        appMain.scrollTop = savedScrollTop
      }
      document.removeEventListener('touchmove', preventScroll)
    }
  }, [])
}
