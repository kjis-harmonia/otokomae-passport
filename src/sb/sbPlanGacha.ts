// SB の「お支払い予定」で、予約に付いたガチャ券が引く額（SR-12）。ほかを読み込まない小さな部品
//   前は無料券の対象を「メニューの記号 = 券の表示名」で探していたので見つからず、「金額は会計で」のまま
//   Black Monday の2,000円だけを引いた予定額が出ていた。会計（finalize_sale・gachaAmount）と同じく
//   menu_codes で対象の明細を探し、Black Monday を引いたあとの残りを無料券で引く
export type PlanGacha = { amount: number | null; free_menu: string | null; menu_codes?: string[] | null }
export type PlanItem = { menu_code: string; price: number | null }

/** 引く額。定額券はその額（今までどおり）。無料券で対象の明細が無い・料金が無いときは null（「金額は会計で」） */
export function planGachaOff(g: PlanGacha, items: readonly PlanItem[], bmCodes: readonly string[], bmUnit: number): number | null {
  if (g.amount !== null) return g.amount
  // menu_codes が無い古いサーバーは、前と同じ free_menu で探す
  const fits = (code: string) => (g.menu_codes ? g.menu_codes.includes(code) : code === g.free_menu)
  const item = items.find(i => fits(i.menu_code))
  if (!item || item.price == null) return null
  return Math.max(0, item.price - (bmCodes.includes(item.menu_code) ? bmUnit : 0))
}
