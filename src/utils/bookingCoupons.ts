// 予約と一緒に使うクーポン（JOHNNY の確認画面で選び、店では QR を読むだけでお会計が出る）。
//   プレミアムクーポン（GINJIRO CLASSICS・SPECIAL PERM・GINPARA）：対象メニューで、平日は終日・土日祝は 17:00〜19:00 開始なら
//     自動で会員価格（9,000 → 8,000 など）。料金の正本はサーバー（menu_price_rules：price＝会員価格・normal_price＝通常価格・祝日）。
//     サーバーの料金表を読むまでは、wallet.ts の料金で代わりに計算する（表示が空にならないように）
//   割引券・漢トク券：何枚でも、種類をまたいでも使える（2026-10-17 お店の決定）。メンテナンスカットのときは使えない
//   選んだ券は端末に覚え、予約の日の会員 QR に入れる（店舗端末が読み取って選んだ状態にする。使用の確定は店舗端末）
import type { TicketRow } from '../data/ticket'
import { GINJIRO_CLASSICS, GINPARA, SPECIAL_PERM, type CouponDefinition } from '../data/wallet'
import { isWelcomeCouponTicket } from './welcomeCoupon'
import { supabase } from '../lib/supabase'

/** プレミアムクーポンの対象メニュー（アプリのメニューの code） */
const PREMIUM_BY_MENU: Record<string, CouponDefinition> = {
  'perm-iper': GINJIRO_CLASSICS, 'perm-curl-iper': GINJIRO_CLASSICS, 'perm-punch': GINJIRO_CLASSICS,
  'perm-negro': GINJIRO_CLASSICS, 'perm-nurepan': GINJIRO_CLASSICS,
  'perm-twist': SPECIAL_PERM,
  'perm-ginpara-curly': GINPARA,
}

/** 祝日（土日以外で、土日祝ルールにする日）。毎年見直す */
const HOLIDAYS = new Set([
  '2026-11-03', '2026-11-23',
  '2027-01-01', '2027-01-11', '2027-02-11', '2027-02-23', '2027-03-22', '2027-04-29', '2027-05-03', '2027-05-04', '2027-05-05',
  '2027-07-19', '2027-08-11', '2027-09-20', '2027-09-23', '2027-10-11', '2027-11-03', '2027-11-23',
])

// ── サーバーの料金表（menu_price_rules）。読めたら、プレミアムの料金と祝日はこちらを使う ──
interface PriceRules {
  menus: { code: string; price: number | null; normal_price: number | null; member_label: string | null }[]
  holidays: string[]
}
const COUPON_BY_LABEL: Record<string, CouponDefinition> = { [GINJIRO_CLASSICS.title]: GINJIRO_CLASSICS, [SPECIAL_PERM.title]: SPECIAL_PERM, [GINPARA.title]: GINPARA }
let rules: PriceRules | null = null
let loading: Promise<void> | null = null

/** サーバーの料金表を読む（1回だけ。失敗したら次に呼ばれたときにもう一度） */
export function ensurePriceRules(): Promise<void> {
  if (rules) return Promise.resolve()
  loading ??= (async () => {
    try {
      const { data, error } = await supabase.rpc('menu_price_rules')
      if (!error && data && Array.isArray((data as PriceRules).menus)) rules = data as PriceRules
    } catch { /* 代わりの料金で計算を続ける */ }
    finally { loading = null }
  })()
  return loading
}
if (typeof window !== 'undefined') void ensurePriceRules()

const jst = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 3600000); return { date: d.toISOString().slice(0, 10), dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() } }
const isWeekendOrHoliday = (iso: string) => { const j = jst(iso); return j.dow === 0 || j.dow === 6 || (rules ? rules.holidays.includes(j.date) : HOLIDAYS.has(j.date)) }

export interface PremiumApplied {
  def: CouponDefinition
  normalPrice: number
  memberPrice: number
  /** その日時で使えるか（土日祝は 17:00〜19:00 開始だけ） */
  eligible: boolean
}

/** プレミアムクーポンの料金（サーバーの料金表を読めていればそちら。クーポン名＝member_label で照らし合わせる） */
export function livePremiumPrice(def: CouponDefinition): { normalPrice: number; memberPrice: number } | null {
  const m = rules?.menus.find(x => x.member_label === def.title && x.normal_price != null && x.price != null)
  return m ? { normalPrice: m.normal_price as number, memberPrice: m.price as number } : null
}

/** そのメニュー・日時のプレミアムクーポン（対象外なら null） */
export function premiumFor(menuCode: string, startsAt: string): PremiumApplied | null {
  const m = jst(startsAt).min
  const eligible = !isWeekendOrHoliday(startsAt) || (m >= 17 * 60 && m <= 19 * 60)
  if (rules) {
    // サーバーの料金表：通常価格（normal_price）があるメニューだけがプレミアム
    const menu = rules.menus.find(x => x.code === menuCode)
    if (!menu || menu.normal_price == null || menu.price == null) return null
    const def = (menu.member_label && COUPON_BY_LABEL[menu.member_label]) || PREMIUM_BY_MENU[menuCode]
    if (!def) return null
    return { def, normalPrice: menu.normal_price, memberPrice: menu.price, eligible }
  }
  const def = PREMIUM_BY_MENU[menuCode]
  const price = def?.prices[0]
  if (!def || !price?.normalPrice) return null
  return { def, normalPrice: price.normalPrice, memberPrice: price.memberPrice, eligible }
}

/** 予約の日に使える割引券・漢トク券（未使用・期限内・譲渡中でない。Welcome は平日だけ） */
export function usableTickets(tickets: readonly TicketRow[], startsAt: string): TicketRow[] {
  const visit = Date.parse(startsAt)
  return tickets.filter(t => (t.type === 'discount' || t.type === 'otoku') && !t.used && !t.pending_transfer
    && (!t.expires_at || Date.parse(t.expires_at) > visit)
    && !(isWelcomeCouponTicket(t) && isWeekendOrHoliday(startsAt)))
}

export interface PriceBreakdown {
  /** ふつうの料金（プレミアムが使えるときだけ。消し線で出す） */
  normal: number | null
  /** クーポン適用後の料金（プレミアムの会員価格、または通常の料金） */
  base: number
  premium: PremiumApplied | null
  ticketsTotal: number
  total: number
}

/** お会計：メニューの料金（menuPrice＝アプリの料金）・プレミアム・選んだ券から */
export function priceFor(menuCode: string, menuPrice: number | null, startsAt: string, selected: readonly TicketRow[]): PriceBreakdown | null {
  const premium = premiumFor(menuCode, startsAt)
  // プレミアム対象で使えない時間帯は、ふつうの料金
  const base = premium ? (premium.eligible ? premium.memberPrice : premium.normalPrice) : menuPrice
  if (base == null) return null
  const ticketsTotal = selected.reduce((a, t) => a + t.amount, 0)
  return { normal: premium?.eligible ? premium.normalPrice : null, base, premium, ticketsTotal, total: Math.max(0, base - ticketsTotal) }
}

// ── 選んだ券を端末に覚える（予約の日まで） ──
const PLAN_KEY = 'ginjiro_booking_coupons'
export interface CouponPlan { date: string; reservationId: string; ticketIds: string[] }

export function saveCouponPlan(plan: CouponPlan): void {
  try { localStorage.setItem(PLAN_KEY, JSON.stringify(plan)) } catch { /* QR に入らないだけ */ }
  window.dispatchEvent(new Event('ginjiro:coupon-plan-changed'))
}

/** 今日以降の予約の券（過ぎていれば消す） */
export function loadCouponPlan(): CouponPlan | null {
  try {
    const v = JSON.parse(localStorage.getItem(PLAN_KEY) ?? 'null') as CouponPlan | null
    if (!v || typeof v.date !== 'string' || !Array.isArray(v.ticketIds)) return null
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)
    if (v.date < today) { localStorage.removeItem(PLAN_KEY); return null }
    return v
  } catch { return null }
}

export function clearCouponPlan(reservationId?: string): void {
  const p = loadCouponPlan()
  if (reservationId && p && p.reservationId !== reservationId) return
  try { localStorage.removeItem(PLAN_KEY) } catch { /* ignore */ }
  window.dispatchEvent(new Event('ginjiro:coupon-plan-changed'))
}

/** 会員 QR に入れる：予約の日だけ、選んだ券の id */
export function couponPlanForQr(): string[] | undefined {
  const p = loadCouponPlan()
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)
  return p && p.date === today && p.ticketIds.length ? p.ticketIds : undefined
}

export const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`
