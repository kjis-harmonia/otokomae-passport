/**
 * 来店履歴ストア
 *
 * Phase1: localStorage のみ
 * Phase2: Firebase 移行時は loadVisitHistory / recordVisit / awardPointsToUser を差し替えるだけ。
 *         呼び出し側の変更は不要。
 *
 * getDaysRemaining の仕様：
 *   登録当日  → 14   （あと14日）
 *   翌日      → 13   （あと13日）
 *   14日後    →  0   （あと0日 / 本日まで）
 *   15日後    → -1   （期限切れ）
 *   毎日0:00 に自然に1減算。時刻単位ではなく日付単位で計算。
 */

import { getStoredValue, setStoredValue } from './storage'

export const VISIT_HISTORY_KEY = 'ginjiro_visit_history'

/** 14日以内優待の有効期間（日数） */
export const MAINTENANCE_CUT_WINDOW_DAYS = 14

export type VisitSyncSource = 'qr' | 'manual'

export interface VisitRecord {
  /** 対象ユーザーID（Phase2: Firebase UID or passport ID） */
  userId?: string
  /** ISO 8601 date string (YYYY-MM-DD) */
  visitedAt: string
  serviceType?: string
  syncSource: VisitSyncSource
  /** スタッフが付与したポイント（0以上、未付与時は 0） */
  awardedPoints?: number
}

// ── Storage helpers ───────────────────────────────────────────────────────────

export function loadVisitHistory(): VisitRecord[] {
  return getStoredValue<VisitRecord[]>(VISIT_HISTORY_KEY, [])
}

/** 来店記録を先頭に追加する（最新が [0]）。 */
export function recordVisit(record: VisitRecord): void {
  const history = loadVisitHistory()
  setStoredValue(VISIT_HISTORY_KEY, [record, ...history])
}

export function clearVisitHistory(): void {
  setStoredValue(VISIT_HISTORY_KEY, [])
}

// ── Derived helpers ───────────────────────────────────────────────────────────

/** 最新の来店記録を返す。なければ null。 */
export function getLastVisit(): VisitRecord | null {
  const history = loadVisitHistory()
  return history.length > 0 ? (history[0] ?? null) : null
}

/**
 * 前回来店日からの残り日数を返す。
 *   正数  → まだ有効（あとN日）
 *   0     → 今日が期限（あと0日）
 *   負数  → 期限切れ
 *
 * 計算は日付単位（時刻を 0:00 に正規化）。
 * 毎日0:00 を過ぎると自動的に1減る。
 */
export function getDaysRemaining(lastVisitDateStr: string): number {
  const base = new Date(lastVisitDateStr)
  base.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const elapsedDays = Math.floor((today.getTime() - base.getTime()) / 86_400_000)
  return MAINTENANCE_CUT_WINDOW_DAYS - elapsedDays
}

/** 14日以内優待が利用可能かどうか判定する。 */
export function isEligibleForMaintenanceCut(lastVisitDateStr: string): boolean {
  return getDaysRemaining(lastVisitDateStr) >= 0
}

/** YYYY-MM-DD → YYYY/MM/DD の表示用フォーマット */
export function formatVisitDate(dateStr: string): string {
  return dateStr.replace(/-/g, '/')
}

// ── Point award stub ──────────────────────────────────────────────────────────

/**
 * ユーザーへのポイント付与。
 *
 * Phase1: VisitRecord.awardedPoints に保存するのみ（localStorage）。
 * Phase2: この関数を Firebase/バックエンドへのAPI呼び出しに差し替える。
 *
 * @param userId    対象ユーザーID
 * @param points    付与ポイント（0以上）
 * @param visitedAt 来店日 YYYY-MM-DD（ログ・監査用）
 */
export function awardPointsToUser(
  userId: string,
  points: number,
  visitedAt: string,
): void {
  // Phase2: await db.collection('users').doc(userId).update({ points: increment(points) })
  console.debug(`[visitHistory] awardPoints userId=${userId} +${points}pt visitedAt=${visitedAt}`)
}
