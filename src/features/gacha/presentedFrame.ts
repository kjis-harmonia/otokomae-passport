/** Keep the previous picture visible until the next decoder has presented a frame.
 * `playing` alone can fire before that frame reaches the compositor.
 */
export function afterPresentedFrame(video: HTMLVideoElement, reveal: () => void): () => void {
  let active = true
  let frame = 0
  let fallback = 0
  const ready = () => { if (active) { active = false; reveal() } }
  if (typeof video.requestVideoFrameCallback === 'function') {
    frame = video.requestVideoFrameCallback(ready)
  } else {
    // Older WebKit: keep the old layer through two paint opportunities.
    fallback = requestAnimationFrame(() => { fallback = requestAnimationFrame(ready) })
  }
  return () => {
    active = false
    if (frame) video.cancelVideoFrameCallback(frame)
    if (fallback) cancelAnimationFrame(fallback)
  }
}
