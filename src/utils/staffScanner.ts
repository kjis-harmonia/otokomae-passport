// 店舗端末のQR・来店確認の補助処理。画面の再描画に依存しない。
import { callStaffRpc } from './staffSession'
import { normalizeCurrentReservation, type CurrentReservation } from './currentReservation'
import { PREMIUM_COUPONS } from '../data/wallet'
import type { VisitInfo } from '../components/VisitMenuPicker'

/**
 * usedType（当日すでに使用済みの割引種別。未使用ならnull）に対して、
 * attemptedType（これから使おうとしている割引種別）が使用可能か判定する。
 */
export function canUseDiscountType(usedType: string | null, attemptedType: string): boolean {
  if (usedType === null) return true
  if (usedType === 'coupon') return false   // メンテナンスクーポンを使った日は、ほかの券は使えない
  if (attemptedType === 'coupon') return false // ほかの券を使った日は、メンテナンスクーポンは使えない（1日1回）
  return true                                // 割引券・漢トク券は何枚でも、種類をまたいでも使える
}

// ── Sound ─────────────────────────────────────────────────────────────────────

export function playSuccessSound() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator(); const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    osc.type = 'sine'; osc.frequency.value = 880
    gain.gain.setValueAtTime(0.35, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5)
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.5)
    setTimeout(() => ctx.close(), 700)
  } catch { /* AudioContext unavailable */ }
}

export function playWarningSound() {
  try {
    const ctx = new AudioContext()
    ;[0, 0.22, 0.44].forEach(offset => {
      const osc = ctx.createOscillator(); const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = 'square'; osc.frequency.value = 440
      gain.gain.setValueAtTime(0.25, ctx.currentTime + offset)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.16)
      osc.start(ctx.currentTime + offset); osc.stop(ctx.currentTime + offset + 0.16)
    })
    setTimeout(() => ctx.close(), 900)
  } catch { /* AudioContext unavailable */ }
}


/** 来店チェックイン（来店日＝本日JST）。staff_check_in RPC。今日のメニュー（予約から分かれば）と最近の来店も返る。失敗時は例外。 */
export async function checkInVisit(userId: string): Promise<{ date: string; info: VisitInfo }> {
  const r = await callStaffRpc<{ visit_date: string } & Partial<VisitInfo>>('staff_check_in', { p_user_id: userId })
  return {
    date: String(r.visit_date).slice(0, 10),
    info: { menu_code: r.menu_code ?? null, menu_name: r.menu_name ?? null, menu_source: r.menu_source ?? null, recent: Array.isArray(r.recent) ? r.recent : [],
      reservation_starts_at: r.reservation_starts_at ?? null, reservation_price: typeof r.reservation_price === 'number' ? r.reservation_price : null },
  }
}

export interface MaintenanceCouponPreview {
  valid:          boolean
  reason:         string | null
  user_id:        string
  customer_name:  string | null
  days_remaining: number | null
  qr_expires_at:  string
  menu:           { name: string; stylist: string; normal_price: number; member_price: number }
}

/** メンテナンスクーポンQRの確認（消費しない）。通信失敗は例外。 */
export async function previewMaintenanceCoupon(token: string): Promise<MaintenanceCouponPreview> {
  return callStaffRpc<MaintenanceCouponPreview>('staff_preview_maintenance_coupon', { p_token: token })
}

/**
 * メンテナンスクーポンの使用確定（サーバー側で 5分有効・未使用・14日以内・当日ルールを再検証し、
 * トークン消費・使用ログ・来店日更新を1トランザクションで行う）。失敗時は RpcError。
 */
export async function redeemMaintenanceCoupon(token: string, staffName: string): Promise<{ user_id: string; customer_name: string | null }> {
  return callStaffRpc('staff_redeem_maintenance_coupon', { p_token: token, p_staff_name: staffName })
}

/** 旧形式（userId のみ・トークン無し）のクーポンQR */
export function isLegacyMaintenanceQr(d: MaintenanceCouponQRData): boolean {
  return !d.token
}

export const LEGACY_MAINTENANCE_QR_MESSAGE =
  '旧形式のクーポンQRです。お客様にアプリを最新にしてクーポンQRを再表示してもらってください。'


// ── QR payload ────────────────────────────────────────────────────────────────

export interface PassportQRData {
  type: string
  userId: string
  name: string
  reservation?: CurrentReservation | null
  /** JOHNNY の予約で選んだ券（予約の日の会員 QR） */
  ticketIds?: string[]
  storeRequestId?: string
}

export interface TicketUseQRData {
  type: 'ginjiro-ticket-use'
  userId: string
  selectedTicketId: string
  issuedAt: string
  expiresAt: string
}

export interface MaintenanceCouponQRData {
  type: 'ginjiro-maintenance-coupon'
  /** v2: サーバー発行の使い捨てトークン（5分有効） */
  v?: number
  token?: string
  /** 旧形式（v1）のみ。v2 では含まれない */
  userId?: string
  name?: string
}

export interface PremiumCouponQRData {
  type: 'ginjiro-premium-coupon'
  userId: string
  name: string
  couponId: string
  category: 'classic' | 'special' | 'ginpara'
  title: string
  menuLabel: string
  normalPrice?: number | null
  memberPrice: number
  issuedAt?: string
  expiresAt?: string
}

export type AnyQRData = PassportQRData | TicketUseQRData | MaintenanceCouponQRData | PremiumCouponQRData

export function isQrPayloadExpired(expiresAt?: string): boolean {
  if (!expiresAt) return false
  const expiry = new Date(expiresAt)
  if (Number.isNaN(expiry.getTime())) return true
  return new Date() > expiry
}

export function parseQR(text: string): AnyQRData | null {
  try {
    const d = JSON.parse(text)
    if (d.type === 'ginjiro-ticket-use' && d.userId && d.selectedTicketId) return d as TicketUseQRData
    if (d.type === 'ginjiro-maintenance-coupon' && (d.token || d.userId)) return d as MaintenanceCouponQRData
    if (d.type === 'ginjiro-premium-coupon' && d.userId && d.couponId) {
      // QR からは会員・クーポンID・期限だけを使い、メニュー名・価格は店舗側のマスタから復元する（QR内の価格は使わない）
      const def = PREMIUM_COUPONS.find(c => c.id === d.couponId)
      const price = def?.prices[0]
      if (!def || !price || (def.category !== 'classic' && def.category !== 'special' && def.category !== 'ginpara')) return null
      return {
        type: 'ginjiro-premium-coupon',
        userId: String(d.userId),
        name: typeof d.name === 'string' && d.name ? d.name : '名前未設定',
        couponId: def.id,
        category: def.category,
        title: def.title,
        menuLabel: price.label ?? def.subtitle ?? def.title,
        normalPrice: price.normalPrice ?? null,
        memberPrice: price.memberPrice,
        issuedAt: typeof d.issuedAt === 'string' ? d.issuedAt : undefined,
        expiresAt: typeof d.expiresAt === 'string' ? d.expiresAt : undefined,
      }
    }
    if ((d.type === 'ginjiro-member' || d.type === 'otokomae-passport') && d.userId) {
      return {
        type: d.type,
        userId: d.userId,
        name: d.name || '名前未設定',
        reservation: normalizeCurrentReservation(d.reservation),
        storeRequestId: typeof d.a==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d.a)?d.a:undefined,
        ticketIds: Array.isArray(d.t) ? (d.t as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 30) : undefined,
      }
    }
    return null
  } catch { return null }
}
