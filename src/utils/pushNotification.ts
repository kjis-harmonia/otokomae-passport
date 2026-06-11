/**
 * PWA プッシュ通知ユーティリティ
 *
 * iOS PWA 要件:
 *   - iOS 16.4 以降 + ホーム画面追加 が必要
 *   - requestNotificationPermission はユーザー操作（タップ）イベント内から呼ぶこと
 *
 * 通知クリック時の URL 遷移は public/sw.js の notificationclick で処理される。
 */

import { MAINTENANCE_CUT_URL } from '../data/reserveLinks'
import {
  shouldShowNotificationBanner,
  hasNotifiedToday,
  markNotifiedToday,
} from './maintenanceSchedule'

const NOTIF_TITLE = '銀二郎 男前パスポート'
const NOTIF_BODY  = '男前崩壊まであと3日。メンテナンスカットの時間です。'
const NOTIF_ICON  = '/assets/app-icon.png'

/** Notification API が利用可能かどうか。 */
export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

/** 現在の通知許可状態を返す。 */
export function getNotificationPermission(): NotificationPermission {
  if (!isNotificationSupported()) return 'denied'
  return Notification.permission
}

/**
 * 通知許可をリクエストする。
 * 必ずユーザーの操作イベント（onClick 等）から呼び出すこと。
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!isNotificationSupported()) return 'denied'
  if (Notification.permission !== 'default') return Notification.permission
  return Notification.requestPermission()
}

/**
 * 条件が揃っていれば OS 通知を発火する。
 *   - 通知許可済み
 *   - 今日まだ通知していない
 *   - 次回推奨日まで NOTIFICATION_LEAD_DAYS 日以内
 */
export function triggerMaintenanceNotification(lastVisitDate: string): void {
  if (getNotificationPermission() !== 'granted') return
  if (hasNotifiedToday()) return
  if (!shouldShowNotificationBanner(lastVisitDate)) return

  try {
    const notif = new Notification(NOTIF_TITLE, {
      body: NOTIF_BODY,
      icon: NOTIF_ICON,
      tag:  'ginjiro-maintenance', // 同 tag は重複しない
      data: { url: MAINTENANCE_CUT_URL },
    })
    // フォールバック: SW が notificationclick を処理できない場合
    notif.onclick = () => {
      window.open(MAINTENANCE_CUT_URL, '_blank', 'noopener,noreferrer')
      notif.close()
    }
    markNotifiedToday()
  } catch {
    // 一部の環境で Notification() が失敗する場合は無視
  }
}
