/**
 * Smart Wallet ロジック（純粋関数のみ・UI非依存）
 *
 *  - メンテナンスカット 14日判定
 *  - 漢前Premium 曜日・時間判定（Asia/Tokyo 基準）
 *  - 漢トク券 → WalletCard 変換
 *  - Smart Priority 並び替え / フィルタ
 */

import type { TicketRow } from '../data/ticket'
import { TICKET_TYPE_LABELS } from '../data/ticket'
import {
  MAINTENANCE_CUT, PREMIUM_COUPONS,
  type WalletCard, type WalletFilter, type WalletAccent, type WalletCategory,
} from '../data/wallet'
import { MAINTENANCE_CUT_WINDOW_DAYS } from './visitHistory'
import { getJapanDateString, addDaysToDateString } from './dateUtils'
import { isWelcomeCouponTicket } from './welcomeCoupon'

// ── Priority bands（小さいほど前面） ─────────────────────────────────────────
//  1. メンテナンス残り3日以内        10〜13（残りが少ないほど前）
//  2. 現在利用可能な漢前Premium       20
//  3. 通常状態のメンテナンスカット   30〜（残りが少ないほど前）
//  4. 保有している漢トク券           40〜（期限が近いほど前）
//     受付時間外の漢前Premium       46
//     来店記録なしのメンテナンス    48
//  5. 期限切れ・使用済み             90〜
export const PRIORITY = {
  maintenanceUrgent:  10,
  premiumAvailable:   20,
  maintenanceNormal:  30,
  otoku:              40,
  premiumWaiting:     46,
  maintenanceNoVisit: 48,
  expired:            90,
  used:               95,
} as const

export const URGENT_THRESHOLD_DAYS = 3

// ── Japan time helpers ───────────────────────────────────────────────────────

interface JapanClock { dateStr: string; weekday: number; minutes: number }

/** Asia/Tokyo の日付・曜日(0=日)・0:00からの分 */
export function getJapanClock(now = new Date()): JapanClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  return {
    dateStr: getJapanDateString(now),
    weekday,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  }
}

/** YYYY-MM-DD 同士の日数差（to - from）。タイムゾーン非依存。 */
function diffDays(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

// ── メンテナンスカット 14日判定 ──────────────────────────────────────────────

export type MaintenanceTone = 'gold' | 'crimson' | 'expired' | 'none'

export interface MaintenanceState {
  lastVisitDate:  string | null
  /** 14 = 登録当日, 0 = 本日まで, 負数 = 期限切れ, null = 来店記録なし */
  daysRemaining:  number | null
  validUntil:     string | null
  label:          string
  tone:           MaintenanceTone
  isEligible:     boolean
}

/**
 * 来店登録日 = DAY 14。
 * 翌日 0:00 (JST) 以降 13, 以後毎日 0:00 に 1 ずつ減る。
 *   ≥4 → 金「あとN日」 / 3,2 → 深紅「あとN日」 / 1 →「明日まで」/ 0 →「本日まで」/ <0 →「期限切れ」
 */
export function getMaintenanceState(lastVisitDate: string | null, now = new Date()): MaintenanceState {
  if (!lastVisitDate) {
    return { lastVisitDate: null, daysRemaining: null, validUntil: null, label: '来店記録なし', tone: 'none', isEligible: false }
  }
  const today         = getJapanDateString(now)
  const daysRemaining = MAINTENANCE_CUT_WINDOW_DAYS - diffDays(lastVisitDate, today)
  const validUntil    = addDaysToDateString(lastVisitDate, MAINTENANCE_CUT_WINDOW_DAYS)

  let label: string
  let tone: MaintenanceTone
  if (daysRemaining < 0)       { label = '期限切れ'; tone = 'expired' }
  else if (daysRemaining === 0) { label = '本日まで'; tone = 'crimson' }
  else if (daysRemaining === 1) { label = '明日まで'; tone = 'crimson' }
  else if (daysRemaining <= URGENT_THRESHOLD_DAYS) { label = `あと${daysRemaining}日`; tone = 'crimson' }
  else                          { label = `あと${daysRemaining}日`; tone = 'gold' }

  return { lastVisitDate, daysRemaining, validUntil, label, tone, isEligible: daysRemaining >= 0 }
}

// ── 漢前Premium 曜日・時間判定 ───────────────────────────────────────────────

export type PremiumPhase = 'weekday' | 'before' | 'open' | 'closed'

export interface PremiumState {
  phase:       PremiumPhase
  label:       string
  hint?:       string
  /** 今この瞬間に電話予約を受け付けているか */
  isOpenNow:   boolean
}

const WEEKEND_OPEN_MIN  = 17 * 60
const WEEKEND_CLOSE_MIN = 19 * 60

/**
 * 平日 → 本日利用できます
 * 土日 17:00前 → 本日17:00より受付 / 17:00〜19:00 → 現在受付中 / 19:00以降 → 本日の受付終了
 * 判定は Asia/Tokyo。祝日は考慮しない（曜日のみ）。
 */
export function getPremiumState(now = new Date()): PremiumState {
  const { weekday, minutes } = getJapanClock(now)
  const isWeekend = weekday === 0 || weekday === 6
  if (!isWeekend) return { phase: 'weekday', label: '本日利用できます', isOpenNow: true }
  if (minutes < WEEKEND_OPEN_MIN)  return { phase: 'before', label: '本日17:00より受付', isOpenNow: false }
  if (minutes < WEEKEND_CLOSE_MIN) return { phase: 'open', label: '現在受付中', hint: '本日19:00まで', isOpenNow: true }
  return {
    phase: 'closed',
    label: '本日の受付終了',
    hint:  weekday === 6 ? '次回 明日 17:00〜' : '次回 明日（月）終日',
    isOpenNow: false,
  }
}

// ── Card builders ────────────────────────────────────────────────────────────

export function buildMaintenanceCard(state: MaintenanceState): WalletCard {
  const def = MAINTENANCE_CUT
  let priority: number
  let status: WalletCard['status']
  if (state.daysRemaining === null) {
    priority = PRIORITY.maintenanceNoVisit; status = 'waiting'
  } else if (state.daysRemaining < 0) {
    priority = PRIORITY.expired; status = 'expired'
  } else if (state.daysRemaining <= URGENT_THRESHOLD_DAYS) {
    priority = PRIORITY.maintenanceUrgent + state.daysRemaining; status = 'urgent'
  } else {
    priority = PRIORITY.maintenanceNormal + state.daysRemaining / 100; status = 'active'
  }
  return {
    id:           def.id,
    category:     def.category,
    eyebrow:      def.eyebrow,
    title:        def.title,
    subtitle:     def.subtitle,
    status,
    statusLabel:  state.label,
    statusHint:   state.daysRemaining === null ? 'QR来店登録で DAY 14 がスタート' : undefined,
    prices:       def.prices,
    validFrom:    state.lastVisitDate,
    validUntil:   state.validUntil,
    bookingType:  def.bookingType,
    isMemberOnly: def.isMemberOnly,
    priority,
    accent:       status === 'expired' ? 'muted' : 'crimson-gold',
    cycle:        { remaining: state.daysRemaining, total: MAINTENANCE_CUT_WINDOW_DAYS },
    source:       { kind: 'coupon', definition: def },
  }
}

function premiumAccent(category: WalletCategory): WalletAccent {
  switch (category) {
    case 'classic': return 'premium-classic'
    case 'special': return 'premium-special'
    case 'ginpara': return 'premium-ginpara'
    default:        return 'premium-classic'
  }
}

export function buildPremiumCards(state: PremiumState): WalletCard[] {
  return PREMIUM_COUPONS.map((def, index) => ({
    id:           def.id,
    category:     def.category,
    eyebrow:      def.eyebrow,
    title:        def.title,
    subtitle:     def.subtitle,
    status:       state.isOpenNow ? 'active' : 'waiting',
    statusLabel:  state.label,
    statusHint:   state.hint,
    prices:       def.prices,
    bookingType:  def.bookingType,
    phoneNumber:  def.phoneNumber,
    isMemberOnly: def.isMemberOnly,
    priority:     (state.isOpenNow ? PRIORITY.premiumAvailable : PRIORITY.premiumWaiting) + index / 100,
    accent:       premiumAccent(def.category),
    live:         state.isOpenNow,
    source:       { kind: 'coupon', definition: def },
  }))
}

function otokuAccent(amount: number): WalletAccent {
  if (amount >= 1000) return 'otoku-1000'
  if (amount >= 300)  return 'otoku-300'
  return 'otoku-default'
}

function isTicketExpired(t: TicketRow, now: Date): boolean {
  return !!t.expires_at && new Date(t.expires_at) < now
}

function fmtYmd(iso: string): string {
  return getJapanDateString(new Date(iso)).replace(/-/g, '/')
}

/** Wallet 対象の券種（旧 'cut-ticket' も漢トク券として扱う） */
const WALLET_TICKET_TYPES = new Set(['otoku', 'cut-ticket', 'discount'])

/**
 * 保有チケット → WalletCard。
 *   未使用・期限内 → 券種＋金額＋期限でグループ化（×N枚）
 *   期限切れ      → 同様にグループ化（status: expired）
 *   使用済み      → 1枚ずつ（status: used, USED 表示）
 */
export function buildTicketCards(tickets: TicketRow[], now = new Date()): WalletCard[] {
  const groups = new Map<string, TicketRow[]>()
  const cards: WalletCard[] = []

  for (const t of tickets) {
    const isWelcome = isWelcomeCouponTicket(t)
    if (!WALLET_TICKET_TYPES.has(t.type) && !isWelcome) continue
    if (t.used) {
      cards.push(ticketCard([t], 'used', now))
      continue
    }
    const expired = isTicketExpired(t, now)
    const ticketTypeKey = isWelcome ? 'welcome' : t.type === 'cut-ticket' ? 'otoku' : t.type
    const key = `${expired ? 'x' : 'a'}::${ticketTypeKey}::${t.amount}::${t.expires_at?.slice(0, 10) ?? ''}::${t.issued_by}::${t.title}`
    const list = groups.get(key)
    if (list) list.push(t)
    else groups.set(key, [t])
  }
  for (const list of groups.values()) {
    cards.push(ticketCard(list, isTicketExpired(list[0], now) ? 'expired' : 'active', now))
  }
  return cards
}

function hasWelcomeTicket(card: WalletCard): boolean {
  return card.source.kind === 'ticket' && card.source.tickets.some(isWelcomeCouponTicket)
}

function ticketCard(list: TicketRow[], status: 'active' | 'expired' | 'used', now: Date): WalletCard {
  const rep = list[0]
  const expiresAt = rep.expires_at
  const isWelcome = isWelcomeCouponTicket(rep)
  let statusLabel: string
  if (status === 'used')         statusLabel = rep.used_at ? `USED · ${fmtYmd(rep.used_at)}` : 'USED'
  else if (status === 'expired') statusLabel = '期限切れ'
  else if (expiresAt)            statusLabel = `有効期限 ${fmtYmd(expiresAt)}`
  else                           statusLabel = '有効期限なし'

  // 期限が近い券ほど前（期限なしは最後）
  let priority: number = PRIORITY.otoku
  if (status === 'active' && expiresAt) {
    const days = Math.max(0, (new Date(expiresAt).getTime() - now.getTime()) / 86_400_000)
    priority += Math.min(days, 365) / 1000
  } else if (status === 'active') {
    priority += 0.5
  } else if (status === 'expired') {
    priority = PRIORITY.expired + 1
  } else {
    priority = PRIORITY.used
  }

  const allPending = list.every(t => t.pending_transfer)
  return {
    id:           status === 'used' ? `ticket-${rep.id}` : `ticket-${status}-${rep.type}-${rep.amount}-${expiresAt ?? 'none'}-${rep.issued_by}-${rep.title}`,
    category:     'otoku',
    eyebrow:      isWelcome ? 'WELCOME COUPON' : rep.type === 'discount' ? 'DISCOUNT TICKET' : 'OTOKU TICKET',
    title:        rep.title || TICKET_TYPE_LABELS[rep.type],
    status,
    statusLabel,
    statusHint:   status === 'active' && allPending
      ? '譲渡手続き中'
      : status === 'active' && isWelcome
        ? '特殊パーマ対象 / 平日のみ（土日利用不可）'
        : undefined,
    prices:       rep.amount > 0 ? [{ memberPrice: rep.amount }] : [],
    validFrom:    rep.created_at,
    validUntil:   expiresAt,
    bookingType:  'in-store',
    isMemberOnly: false,
    priority,
    accent:       status === 'active' ? otokuAccent(rep.amount) : 'muted',
    count:        list.length,
    source:       { kind: 'ticket', ticketType: rep.type, tickets: list },
  }
}

// ── Smart Priority / Filter ──────────────────────────────────────────────────

export function isInactive(card: WalletCard): boolean {
  return card.status === 'expired' || card.status === 'used'
}

export function sortByPriority(cards: WalletCard[]): WalletCard[] {
  return [...cards].sort((a, b) => a.priority - b.priority)
}

export function filterCards(cards: WalletCard[], filter: WalletFilter): WalletCard[] {
  const sorted = sortByPriority(cards)
  switch (filter) {
    case 'cut':
      return sorted.filter(c => c.category === 'cut')
    case 'premium':
      return sorted.filter(c => c.category === 'classic' || c.category === 'special' || c.category === 'ginpara')
    case 'other':
      return sorted.filter(c => c.category === 'otoku' || hasWelcomeTicket(c))
  }
}

// ── 当日の割引利用ルール（店舗端末・サーバーと同一） ──────────────────────────

/**
 * usedType（当日すでに使用済みの割引種別。未使用なら null）に対して attemptedType が使えるか。
 *   - 異なる種別の併用は不可（1日どれか1種類）
 *   - メンテナンスクーポン(coupon)は1日1回
 *   - 漢トク券・割引券は同種なら1日に何枚でも可
 * 表示用。最終判定は店舗端末での使用確定時にサーバーが行う。
 */
export function canUseDiscountTypeToday(usedType: string | null, attemptedType: string): boolean {
  if (usedType === null) return true
  if (usedType !== attemptedType) return false
  return attemptedType !== 'coupon'
}
