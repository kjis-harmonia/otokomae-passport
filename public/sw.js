/**
 * 銀二郎 男前パスポート — Service Worker
 *
 * 役割:
 *   1. notificationclick — 通知タップでメンテナンスカット予約 URL を開く
 *
 * install/activate は即時に反映させるため skipWaiting + clients.claim を使用。
 */

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const url = event.notification.data?.url ?? '/'

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        // すでに開いているウィンドウがあればフォーカス
        for (const client of windowClients) {
          if ('focus' in client) return client.focus()
        }
        // なければ新規タブで開く
        return clients.openWindow(url)
      }),
  )
})
