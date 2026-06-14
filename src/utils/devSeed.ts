import { getUserId } from './userId'
import { getStoredValue, setStoredValue } from './storage'
import type { TicketRow } from '../data/ticket'

const DEV_SEED_KEY          = 'ginjiro_dev_seeded_v2'
const LOCAL_TICKETS_KEY     = 'ginjiro_local_tickets'
const MAINTENANCE_LOCAL_KEY = 'ginjiro_maintenance_visits'

/**
 * テスト用データをlocalStorageに1度だけ投入する。
 * DEV_SEED_KEY が立っていたら何もしない（冪等）。
 */
export function seedDevData(): void {
  if (getStoredValue<boolean>(DEV_SEED_KEY, false)) return

  const userId = getUserId()
  const now    = new Date().toISOString()

  // ── 最終来店日 ──────────────────────────────────────────────────────────────
  const visits = getStoredValue<Record<string, string>>(MAINTENANCE_LOCAL_KEY, {})
  setStoredValue(MAINTENANCE_LOCAL_KEY, { ...visits, [userId]: '2026-06-10' })

  // ── チケット ────────────────────────────────────────────────────────────────
  const existing = getStoredValue<TicketRow[]>(LOCAL_TICKETS_KEY, [])
  const tickets: TicketRow[] = []

  // 割引券 × 15（¥300 × 5, ¥500 × 5, ¥1,000 × 5）
  const discountAmounts = [300, 500, 1000]
  for (let i = 0; i < 15; i++) {
    tickets.push({
      id: `dev-discount-${i + 1}`,
      user_id:    userId,
      type:       'discount',
      title:      '割引券',
      amount:     discountAmounts[Math.floor(i / 5)],
      memo:       null,
      used:       false,
      issued_by:  'dev',
      created_at: now,
      used_at:    null,
      expires_at: null,
    })
  }

  // 漢トク券 × 15（¥1,000 × 5, ¥2,000 × 5, ¥3,000 × 5）
  const otokuAmounts = [1000, 2000, 3000]
  for (let i = 0; i < 15; i++) {
    tickets.push({
      id: `dev-otoku-${i + 1}`,
      user_id:    userId,
      type:       'otoku',
      title:      '漢トク券',
      amount:     otokuAmounts[Math.floor(i / 5)],
      memo:       null,
      used:       false,
      issued_by:  'dev',
      created_at: now,
      used_at:    null,
      expires_at: null,
    })
  }

  // dev- プレフィックス付きを一旦クリアして再投入
  const filtered = existing.filter(t => !t.id.startsWith('dev-'))
  setStoredValue(LOCAL_TICKETS_KEY, [...filtered, ...tickets])

  setStoredValue(DEV_SEED_KEY, true)
}
