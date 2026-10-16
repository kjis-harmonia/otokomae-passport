/* Foreground maintenance notifications. No background push subscription is configured. */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(clients.claim()))
self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url ?? '/', self.location.origin)
    if (!['https:', 'http:'].includes(target.protocol)) return
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    const matching = windows.find(client => client.url === target.href)
    if (matching) return matching.focus()
    if (target.origin === self.location.origin) {
      const current = windows.find(client => new URL(client.url).origin === target.origin && 'navigate' in client)
      if (current) {
        try {
          const navigated = await current.navigate(target.href)
          if (navigated) return navigated.focus()
        } catch { /* Open a new window if navigation failed. */ }
      }
    }
    return clients.openWindow(target.href)
  })())
})
