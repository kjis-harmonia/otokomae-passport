// Black Monday（2026-11-17 オーナー決定）：毎週月曜（祝日の月曜も）に来店する、アプリで取った予約だけ。
//   対象のパーマ1メニューにつき ¥2,000 引き（開始日・額・対象メニューはサーバーの設定 app_private.black_monday_settings）。
//   Welcome・再来店パーマクーポンとは併用しない（券を優先）。ガチャ券・ほかの割引券・漢トク券は併用できる。
// 正はサーバー（予約の印・finalize_sale）。ここは同じ計算で画面に出すだけ（このファイルはほかを読み込まない＝試験からそのまま使える）

export const BLACK_MONDAY_LABEL = 'Black Monday'

/** 料金表（menu_price_rules）の black_monday：予約前の見込みに使う */
export interface BlackMondayRule { starts_on: string; amount: number; menu_codes: string[] }

/** 予約（reservation_json）の black_monday：その予約の値引きの見込み。amount は予約に Welcome 等の券を付けていれば 0 */
export interface BlackMondayInfo { label?: string; unit: number; amount: number; menu_codes: string[]; perm_coupon?: boolean }

/** 会計の情報（checkout_context_json）の black_monday：この予約が対象か・1メニューの額・対象メニュー */
export interface BlackMondayCheckout { eligible: boolean; unit: number; amount: number; menu_codes: string[]; label?: string }

/** 来店の日時（日本時間）が、開始日以降の月曜か */
export function isBlackMondayDay(rule: Pick<BlackMondayRule, 'starts_on'>, startsAt: string): boolean {
  const t = Date.parse(startsAt)
  if (!Number.isFinite(t)) return false
  const d = new Date(t + 9 * 3600_000)
  return d.getUTCDay() === 1 && d.toISOString().slice(0, 10) >= rule.starts_on
}

/** 予約前の見込み：そのメニュー・日時の値引き（対象外は 0）。price を渡すと、その料金を超えない */
export function blackMondayOff(rule: BlackMondayRule | null | undefined, menuCode: string, startsAt: string, price?: number | null): number {
  if (!rule || !(rule.amount > 0) || !rule.menu_codes.includes(menuCode) || !isBlackMondayDay(rule, startsAt)) return 0
  return price == null ? rule.amount : Math.max(0, Math.min(rule.amount, price))
}

/** 予約に出す額（0 なら出さない） */
export const blackMondayAmount = (r: { black_monday?: BlackMondayInfo | null } | null | undefined): number =>
  Math.max(0, r?.black_monday?.amount ?? 0)

export interface BlackMondayLine { source: string; ref_id?: string; unit_price: number; quantity: number; discount: number }

/**
 * お会計：明細ごとの値引き（明細の順。サーバーの finalize_sale と同じ）。
 *   対象の予約で、メニューの明細（予約・メニュー）の対象メニュー1つにつき1メニューの額。明細の残り（単価×数量−明細の値引き）を超えない。
 *   Welcome・再来店パーマクーポンを使うときは 0（券を優先）
 */
export function blackMondayLineOffs(lines: readonly BlackMondayLine[], bm: BlackMondayCheckout | null | undefined, permCoupon: boolean): number[] {
  if (!bm?.eligible || permCoupon) return lines.map(() => 0)
  return lines.map(l => (l.source === 'reservation' || l.source === 'service_menu') && !!l.ref_id && bm.menu_codes.includes(l.ref_id)
    ? Math.max(0, Math.min(bm.unit, l.unit_price * l.quantity - l.discount)) : 0)
}
