/** Keep the previous picture visible until the next decoder has presented a frame.
 * `playing` alone can fire before that frame reaches the compositor.
 */
// 11/11 本番の iPhone でガチャの音が鳴らなかった：requestVideoFrameCallback が来ない端末（省電力モード など）があり、
// 音の開始（sync）と画面の切り替えがそこで止まっていた。来なくても一定時間で進める（保険）
export const PRESENTED_FALLBACK_MS = 500
export function afterPresentedFrame(video: HTMLVideoElement, reveal: () => void): () => void {
  let active = true
  let frame = 0
  let fallback = 0
  let timer = 0
  const ready = () => { if (active) { active = false; if (timer) clearTimeout(timer); timer = 0; reveal() } }
  if (typeof video.requestVideoFrameCallback === 'function') {
    frame = video.requestVideoFrameCallback(ready)
  } else {
    // Older WebKit: keep the old layer through two paint opportunities.
    fallback = requestAnimationFrame(() => { fallback = requestAnimationFrame(ready) })
  }
  // タイマーの無い環境（試験の箱など）では保険を置かない
  const hasTimer = typeof setTimeout === 'function' && typeof clearTimeout === 'function'
  if (hasTimer) timer = setTimeout(ready, PRESENTED_FALLBACK_MS) as unknown as number
  return () => {
    active = false
    if (frame) video.cancelVideoFrameCallback(frame)
    if (fallback) cancelAnimationFrame(fallback)
    if (timer && hasTimer) clearTimeout(timer)
  }
}
