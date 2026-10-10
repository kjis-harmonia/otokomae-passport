// 確認ダイアログのフォーカス管理（ManagerApprovalModal と同じ考え方。あちらは変えずに残す）。
//   - 開いたら、ダイアログの中の安全な操作（キャンセル）へフォーカスを移す。
//   - Tab / Shift+Tab はダイアログの中だけを回る。外側（祖先の兄弟要素）は inert にして操作させない。
//   - Escape で閉じる（閉じてよいかは呼び出し元が onEscape で決める）。
//   - 閉じたら inert を戻し（元から inert だった要素は触らない）、開く前にフォーカスがあった要素へ戻す。

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** el の外（祖先の兄弟要素）を inert にする。元から inert だった要素は触らない。戻す関数を返す */
export function inertOutside(el: HTMLElement): () => void {
  const changed: HTMLElement[] = []
  for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
    const parent: HTMLElement | null = node.parentElement
    if (!parent) break
    for (const sib of Array.from(parent.children) as HTMLElement[]) {
      if (sib === node || sib.inert) continue
      sib.inert = true
      changed.push(sib)
    }
  }
  return () => { for (const sib of changed) sib.inert = false }
}

/**
 * overlay（背景を含むダイアログ全体）と panel（tabIndex=-1 の中身）にフォーカスを閉じ込める。
 * initial があればそこへ、なければ panel へフォーカスを移す。後始末の関数を返す（閉じたとき・アンマウント時に呼ぶ）。
 */
export function trapModalFocus(overlay: HTMLElement, panel: HTMLElement, initial: HTMLElement | null, onEscape: () => void): () => void {
  const active = document.activeElement as HTMLElement | null
  const returnTo = active && active !== document.body && typeof active.focus === 'function' ? active : null
  const restoreInert = inertOutside(overlay)
  ;(initial ?? panel).focus({ preventScroll: true })

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onEscape()
      return
    }
    if (e.key !== 'Tab') return
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (items.length === 0) { e.preventDefault(); panel.focus({ preventScroll: true }); return }
    const first = items[0]
    const last = items[items.length - 1]
    const now = document.activeElement
    const inside = !!now && panel.contains(now) && now !== panel
    if (e.shiftKey ? (!inside || now === first) : (!inside || now === last)) {
      e.preventDefault()
      if (e.shiftKey) last.focus()
      else first.focus()
    }
  }
  // inert の付いていない要素（後から追加された要素など）へ移ったときもダイアログへ戻す
  function onFocusIn(e: FocusEvent) {
    const t = e.target as Node | null
    if (t && !overlay.contains(t)) (initial && initial.isConnected ? initial : panel).focus({ preventScroll: true })
  }
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('focusin', onFocusIn)
  return () => {
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('focusin', onFocusIn)
    restoreInert()
    if (returnTo && returnTo.isConnected) returnTo.focus({ preventScroll: true })
  }
}
