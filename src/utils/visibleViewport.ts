/** Keep a fixed customer dialog above the software keyboard without following pinch zoom. */
export function observeVisibleViewport(target: Pick<HTMLElement, 'style'>, view: Window = window): () => void {
  const properties = ['--customer-visual-height', '--customer-visual-top'] as const
  const previous = properties.map(name => [name, target.style.getPropertyValue(name), target.style.getPropertyPriority(name)] as const)
  const restore = () => previous.forEach(([name, value, priority]) => {
    if (value) target.style.setProperty(name, value, priority)
    else target.style.removeProperty(name)
  })
  const viewport = view.visualViewport
  if (!viewport) return () => {}
  let frame = 0
  const update = () => {
    frame = 0
    if (!Number.isFinite(viewport.height) || viewport.height <= 0 || Math.abs(viewport.scale - 1) > .01) {
      restore()
      return
    }
    target.style.setProperty(properties[0], `${viewport.height}px`)
    target.style.setProperty(properties[1], `${Number.isFinite(viewport.offsetTop) ? Math.max(0, viewport.offsetTop) : 0}px`)
  }
  const schedule = () => { if (!frame) frame = view.requestAnimationFrame(update) }
  update()
  viewport.addEventListener('resize', schedule)
  viewport.addEventListener('scroll', schedule)
  view.addEventListener('resize', schedule)
  return () => {
    viewport.removeEventListener('resize', schedule)
    viewport.removeEventListener('scroll', schedule)
    view.removeEventListener('resize', schedule)
    if (frame) view.cancelAnimationFrame(frame)
    restore()
  }
}
