// 銀オクの無料券（Staging だけ・11/12 慶一郎さん）：「銀パラ無料券」など。そのメニューのお会計だけで使え、
// 値引きはそのメニューの明細1つ分の料金（来店の日の料金）。券の額（amount）は 0。
// 正はサーバー（supabase/staging-only/20261112_ginoku_free_and_hold.sql の finalize_sale）。ここは同じ計算で画面に出すだけ。
// 本番には無料券が無い（menu_codes の無い券だけ）ので、ここの分かれ道は通らない

export interface FreeMenuInfo {
  free_menu?: string | null
  menu_codes?: string[] | null
}

/** 無料券か（使えるメニューが決まっている券） */
export const isFreeTicket = (t: FreeMenuInfo): t is FreeMenuInfo & { menu_codes: string[] } =>
  Array.isArray(t.menu_codes) && t.menu_codes.length > 0

/** 券の値打ちの書き方：「銀パラ無料」 */
export const freeTicketLabel = (t: FreeMenuInfo): string => `${t.free_menu || '対象のメニュー'}無料`

/** 予約の料金の見込みでの値引き（そのメニューの予約なら、そのメニューの料金。ほかのメニューなら 0） */
export function freeTicketValue(t: FreeMenuInfo, menuCode: string, base: number): number {
  return isFreeTicket(t) && t.menu_codes.includes(menuCode) ? Math.max(0, base) : 0
}

export interface FreeLine {
  source: string
  ref_id?: string
  unit_price: number
  quantity: number
  discount: number
}

/**
 * お会計で、選んだ無料券それぞれの値引き額（サーバーの finalize_sale と同じ割り当て）。
 *   ・明細の残り＝単価×数量 − 明細の値引き（メニューの明細だけ）。ガチャ券がその明細を使っていれば、その分も引く
 *   ・券の ID の順に、明細の順で最初に残りのある対象の明細へ。値引き＝min(単価, 残り)。1つの明細を2枚で引かない
 *   ・対象の明細が無い券は null（使えない）
 */
export function freeTicketAmounts(
  lines: readonly FreeLine[],
  tickets: readonly (FreeMenuInfo & { id: string })[],
  gacha?: { lineIndex: number; amount: number } | null,
): Map<string, number | null> {
  const isMenu = (l: FreeLine) => (l.source === 'reservation' || l.source === 'service_menu') && !!l.ref_id
  const rem = lines.map(l => (isMenu(l) ? l.unit_price * l.quantity - l.discount : 0))
  if (gacha && gacha.lineIndex >= 0 && gacha.lineIndex < rem.length) rem[gacha.lineIndex] = Math.max(rem[gacha.lineIndex] - gacha.amount, 0)
  const out = new Map<string, number | null>()
  // uuid は小文字の16進なので、文字の順＝DB の uuid の順
  const free = tickets.filter((t): t is FreeMenuInfo & { id: string; menu_codes: string[] } => isFreeTicket(t))
  for (const t of [...free].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const k = lines.findIndex((l, i) => isMenu(l) && t.menu_codes.includes(l.ref_id!) && rem[i] > 0)
    if (k < 0) { out.set(t.id, null); continue }
    const take = Math.min(lines[k].unit_price, rem[k])
    rem[k] -= take
    out.set(t.id, take)
  }
  return out
}
