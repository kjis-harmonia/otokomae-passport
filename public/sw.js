/**
 * 銀二郎 男前パスポート — Service Worker
 *
 * 役割:
 *   1. push — JOHNNY のお知らせ（サーバーの johnny-notify から届く）を表示する
 *   2. notificationclick — お知らせを押したら、その URL（JOHNNY の予約画面など）を開く
 *
 * install/activate は即時に反映させるため skipWaiting + clients.claim を使用。
 */

// 版（中身を変えたら書きかえる。ファイルが変わると、スマホが新しい SW を入れ直す）: 2026-10-19a

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  // 確かめ用に使っていた記録を片づける
  event.waitUntil(Promise.all([clients.claim(), caches.delete('ginjiro-diag')]))
})

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { body: event.data ? event.data.text() : '' } }
  const title = data.title || '銀二郎 JOHNNY'
  // SB への「予約が入りました」：開いている SB にも知らせて、画面で音を鳴らし予約表を読み直す
  const sb = data.kind === 'sb-new-reservation' || data.kind === 'sb-final'
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: sb ? '/icons/sb-192.png' : '/assets/app-icon.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'ginjiro-johnny',
      renotify: true,
      vibrate: sb ? [120, 60, 220] : undefined,
      data: { url: data.url || '/?tab=reserve&johnny=1' },
    }),
    sb ? clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => list.forEach((c) => c.postMessage({ type: data.kind }))) : null,
  ]))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const url = event.notification.data?.url ?? '/'

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        // すでに開いているアプリがあれば、その画面で開いて前に出す
        for (const client of windowClients) {
          if ('focus' in client) {
            const go = 'navigate' in client ? client.navigate(url).catch(() => client) : Promise.resolve(client)
            return go.then((c) => (c || client).focus())
          }
        }
        // なければ新しく開く
        return clients.openWindow(url)
      }),
  )
})
