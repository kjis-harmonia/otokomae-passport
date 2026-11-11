/** Keep the previous picture visible until the incoming video is playing and ready. */
export function afterPresentedFrame(video: HTMLVideoElement, reveal: () => void): () => void {
  let active = true
  let frame: number | undefined
  let fallback: number | undefined
  let startedAt = video.currentTime
  let seeking = video.seeking
  const playing = () => !video.paused && !seeking && !video.seeking && video.readyState >= video.HAVE_CURRENT_DATA
  const onSeeking = () => { seeking = true }
  const onSeeked = () => { seeking = false; startedAt = video.currentTime }
  const stop = () => {
    if (!active) return
    active = false
    video.removeEventListener('timeupdate', checkProgress)
    video.removeEventListener('seeking', onSeeking)
    video.removeEventListener('seeked', onSeeked)
    if (frame !== undefined) video.cancelVideoFrameCallback(frame)
    if (fallback !== undefined) cancelAnimationFrame(fallback)
  }
  const ready = () => {
    if (!active || !playing()) return
    stop()
    reveal()
  }
  // Some browsers expose the frame API but miss a notification. Wait until
  // the incoming video has decodable data and its playback clock has advanced.
  const checkProgress = () => {
    if (video.currentTime < startedAt) startedAt = video.currentTime
    if (video.currentTime - startedAt >= 0.15) ready()
  }
  video.addEventListener('timeupdate', checkProgress)
  video.addEventListener('seeking', onSeeking)
  video.addEventListener('seeked', onSeeked)
  if (typeof video.requestVideoFrameCallback === 'function') {
    frame = video.requestVideoFrameCallback(ready)
  } else {
    // Older WebKit: keep the old layer through two paint opportunities.
    fallback = requestAnimationFrame(() => { fallback = requestAnimationFrame(ready) })
  }
  return stop
}
