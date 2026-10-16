/** Owns an async camera start until it has either failed or been stopped. */
export interface CameraDevice {
  isScanning: boolean
  start: (onDecode: (text: string) => void) => Promise<unknown>
  stop: () => Promise<unknown>
  clear: () => void
}

export function startCameraLease(device: CameraDevice, callbacks: {
  onReady: () => void
  onScan: (text: string) => void
  onError: () => void
  onStopped: () => void
}) {
  let cancelled = false
  let decoded = false
  let stopping: Promise<void> | undefined
  const stop = () => {
    if (!stopping) stopping = (async () => {
      try { await started } catch { /* Failed starts still need clear(). */ }
      try { if (device.isScanning) await device.stop() } finally {
        device.clear()
      }
    })().catch(() => { /* html5-qrcode may already have cleared its DOM. */ })
    return stopping
  }
  const started = Promise.resolve().then(() => device.start(text => {
    if (cancelled || decoded) return
    decoded = true
    void stop().then(() => {
      if (!cancelled) { callbacks.onStopped(); callbacks.onScan(text) }
    })
  }))
  void started.then(() => {
    if (cancelled || decoded) { void stop(); return }
    callbacks.onReady()
  }, () => {
    void stop().then(() => { if (!cancelled) { callbacks.onStopped(); callbacks.onError() } })
  })
  return { cancel() { cancelled = true; return stop() } }
}
