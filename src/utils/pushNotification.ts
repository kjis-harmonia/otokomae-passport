import { MAINTENANCE_CUT_URL } from '../data/reserveLinks'
import { shouldShowNotificationBanner, hasNotifiedToday, markNotifiedToday } from './maintenanceSchedule'

export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}
export function getNotificationPermission(): NotificationPermission {
  return isNotificationSupported() ? Notification.permission : 'denied'
}
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!isNotificationSupported()) return 'denied'
  return Notification.permission === 'default' ? Notification.requestPermission() : Notification.permission
}

let sending: Promise<boolean> | null = null
/** Foreground reminder only. A background push subscription/scheduler is not configured. */
export function triggerMaintenanceNotification(lastVisitDate: string): Promise<boolean> {
  if (sending) return sending
  if (getNotificationPermission() !== 'granted' || hasNotifiedToday() || !shouldShowNotificationBanner(lastVisitDate)) return Promise.resolve(false)
  sending = (async () => {
    const options = {
      body: '男前キープのメンテナンス時期です。次のカットをご確認ください。',
      icon: '/assets/app-icon.png', tag: 'ginjiro-maintenance', data: { url: MAINTENANCE_CUT_URL },
    }
    try {
      const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined
      if (registration?.active && typeof registration.showNotification === 'function') {
        // Required by mobile browsers, including installed iOS PWAs.
        await registration.showNotification('銀二郎 男前パスポート', options)
      } else {
        const notification = new Notification('銀二郎 男前パスポート', options)
        notification.onclick = () => {
          window.open(MAINTENANCE_CUT_URL, '_blank', 'noopener,noreferrer')
          notification.close()
        }
      }
      markNotifiedToday()
      return true
    } catch { return false } // Never mark a failed notification as delivered.
  })().finally(() => { sending = null })
  return sending
}
