/**
 * メンテナンスカット スケジュール管理
 *
 * Phase1: localStorage のみ
 * Phase2: Supabase 移行時の差し替え箇所
 *   - getMaintenanceVisit  → supabase.from('maintenance_visits').select().eq('user_id', uid).single()
 *   - saveMaintenanceVisit → supabase.from('maintenance_visits').upsert({ user_id, last_visit_date })
 *   - clearMaintenanceVisit → supabase.from('maintenance_visits').delete().eq('user_id', uid)
 *   型定義・計算関数はそのまま使用可能。
 */

import { getStoredValue, setStoredValue, removeStoredValue } from './storage'

export const MAINTENANCE_VISIT_KEY     = 'ginjiro_maintenance_visit'
export const MAINTENANCE_NOTIF_DATE_KEY = 'ginjiro_maintenance_last_notif'

/** メンテナンスサイクル（日数）。次回推奨日 = 前回来店日 + この日数。 */
export const MAINTENANCE_CYCLE_DAYS = 14

/** 通知リードタイム（推奨日の何日前から通知するか）。 */
export const NOTIFICATION_LEAD_DAYS = 3

// ── 型定義 ──────────────────────────────────────────────────────────────────

export interface MaintenanceVisit {
  /** 前回来店日 YYYY-MM-DD */
  lastVisitDate: string
  /** 登録日時 ISO 8601 */
  savedAt: string
  // Phase2 (Supabase): userId: string
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/** 登録済みのメンテナンス来店情報を返す。未登録なら null。 */
export function getMaintenanceVisit(): MaintenanceVisit | null {
  return getStoredValue<MaintenanceVisit | null>(MAINTENANCE_VISIT_KEY, null)
}

/** 前回来店日を保存する。 */
export function saveMaintenanceVisit(lastVisitDate: string): void {
  // Phase2: await supabase.from('maintenance_visits').upsert({ user_id: uid, last_visit_date: lastVisitDate })
  setStoredValue<MaintenanceVisit>(MAINTENANCE_VISIT_KEY, {
    lastVisitDate,
    savedAt: new Date().toISOString(),
  })
}

/** 登録情報を削除する。 */
export function clearMaintenanceVisit(): void {
  removeStoredValue(MAINTENANCE_VISIT_KEY)
}

// ── 日付計算 ─────────────────────────────────────────────────────────────────

function toMidnight(dateStr: string): Date {
  const d = new Date(dateStr)
  d.setHours(0, 0, 0, 0)
  return d
}

function todayMidnight(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

/** 次回推奨日を返す（YYYY-MM-DD）。前回来店日 + MAINTENANCE_CYCLE_DAYS 日。 */
export function getNextRecommendedDate(lastVisitDate: string): string {
  const base = toMidnight(lastVisitDate)
  base.setDate(base.getDate() + MAINTENANCE_CYCLE_DAYS)
  return base.toISOString().slice(0, 10)
}

/**
 * 次回推奨日まで何日あるかを返す（日付単位）。
 *   正数  → 推奨日まで N 日
 *   0     → 今日が推奨日
 *   負数  → 推奨日を N 日超過
 */
export function getDaysUntilRecommended(lastVisitDate: string): number {
  const recommended = toMidnight(getNextRecommendedDate(lastVisitDate))
  const today = todayMidnight()
  return Math.round((recommended.getTime() - today.getTime()) / 86_400_000)
}

/** 通知表示条件：推奨日まで NOTIFICATION_LEAD_DAYS 日以内（0・マイナス含む）。 */
export function shouldShowNotificationBanner(lastVisitDate: string): boolean {
  return getDaysUntilRecommended(lastVisitDate) <= NOTIFICATION_LEAD_DAYS
}

/** 今日すでに OS 通知を送信済みかどうか。 */
export function hasNotifiedToday(): boolean {
  const last = getStoredValue<string | null>(MAINTENANCE_NOTIF_DATE_KEY, null)
  return last === new Date().toISOString().slice(0, 10)
}

/** 今日 OS 通知済みとしてマーク。 */
export function markNotifiedToday(): void {
  setStoredValue(MAINTENANCE_NOTIF_DATE_KEY, new Date().toISOString().slice(0, 10))
}

/** YYYY-MM-DD → YYYY/MM/DD（表示用） */
export function fmtDate(dateStr: string): string {
  return dateStr.replace(/-/g, '/')
}
