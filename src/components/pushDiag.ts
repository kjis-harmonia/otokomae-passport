// お知らせが届かないときの確かめ（QR 画面の小さな表示）。sw.js が Cache に書いた版・最後の受信時刻を読む。
export interface PushDiagInfo { version: string; active: string; lastPush: string; shown: string }

async function read(key: string): Promise<string> {
  try {
    const res = await (await caches.open('ginjiro-diag')).match(key)
    return res ? await res.text() : ''
  } catch { return '' }
}

export async function pushDiag(): Promise<PushDiagInfo> {
  const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined)
  const [version, push, shown] = await Promise.all([read('/diag/version'), read('/diag/push'), read('/diag/shown')])
  const lastPush = push ? new Date(push).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'まだ無し'
  return { version: version || '古い', active: reg?.active?.state ?? 'なし', lastPush, shown: shown || '—' }
}

/** この端末だけで通知を出してみる（サーバーを通さない） */
export async function localTestNotification(): Promise<boolean> {
  const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined)
  if (!reg) return false
  await reg.showNotification('銀二郎 JOHNNY', { body: 'この端末での表示テストです。', tag: 'johnny-local-test' })
  return true
}
