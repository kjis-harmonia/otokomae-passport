/**
 * 銀二郎 男前パスポート — Service Worker
 *
 * 役割:
 *   1. push — JOHNNY のお知らせ（サーバーの johnny-notify から届く）を表示する
 *   2. notificationclick — お知らせを押したら、その URL（JOHNNY の予約画面など）を開く
 *
 * install/activate は即時に反映させるため skipWaiting + clients.claim を使用。
 */

// 版（中身を変えたら書きかえる。ファイルが変わると、スマホが新しい SW を入れ直す）: 2026-11-19a

/** キャンセル待ちのお知らせ（?hold=…）か */
const isHoldUrl = (url) => { try { return new URL(url, self.location.href).searchParams.has('hold') } catch { return false } }

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  // 確かめ用に使っていた記録を片づける
  event.waitUntil(Promise.all([clients.claim(), caches.delete('ginjiro-diag')]))
})

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { body: event.data ? event.data.text() : '' } }
  const title = data.title || '銀二郎 JOHNNY'
  // SB への「予約が入りました」「キャンセルが入りました」：開いている SB にも知らせて、画面で音を鳴らし予約表を読み直す
  const sb = data.kind === 'sb-new-reservation' || data.kind === 'sb-cancel' || data.kind === 'sb-final' || data.kind === 'sb-intrusion'
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: sb ? '/icons/sb-192.png' : '/assets/app-icon.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'ginjiro-johnny',
      renotify: true,
      // 銀二郎SB の予約・キャンセルのお知らせは、押すまで消さない（パソコン・Android。iPad は 設定→通知→バナースタイル「持続的」・10/27）
      requireInteraction: !!sb,
      vibrate: sb ? [120, 60, 220] : undefined,
      data: { url: data.url || '/?tab=reserve&johnny=1' },
    }),
    sb ? clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => list.forEach((c) => c.postMessage({ type: data.kind }))) : null,
    // キャンセル待ち：アプリを画面に出している時は、iPhone がお知らせを出さないことがある（11/19 本番の実機）。
    //   出している画面へ直接渡して、銀ちゃんがその場で枠を聞く（同じ枠は1回だけ・アプリ側で見る）
    data.url && isHoldUrl(data.url)
      ? clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => list.filter((c) => c.visibilityState === 'visible').forEach((c) => c.postMessage({ type: 'gin-hold', url: data.url })))
      : null,
  ]))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const destination = new URL(event.notification.data?.url ?? '/', self.location.href)

  event.waitUntil((async () => {
    // 同じ入口の画面を再利用する。予約表の通知で店舗端末やお客様アプリを置き換えない。
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows.find(client => {
      const current = new URL(client.url)
      return current.origin === destination.origin && current.pathname === destination.pathname
    })
    // キャンセル待ち：アプリが裏で開いたままだと、iPhone では画面の読み込み直し（navigate）が効かず、
    //   前の画面（会員QR など）のままだった（11/19 本番の実機）。開いている画面へ直接渡して、前に出す
    if (existing && destination.searchParams.has('hold')) {
      existing.postMessage({ type: 'gin-hold', url: destination.href })
      try { return await existing.focus() } catch { return clients.openWindow(destination.href) }
    }
    if (existing && typeof existing.navigate === 'function') {
      const navigated = await existing.navigate(destination.href).catch(() => null)
      if (navigated) return navigated.focus()
    }
    return clients.openWindow(destination.href)
  })())
})
