// 2人以上の予約（ご本人＋お連れ様）を SB でひと組に見せる（11/11 監査：お連れ様の枠にも予約した人の名前が出て、二重予約に見えた）
//   お連れ様の予約はメモの「お連れ様：〇〇様」で分かる。ご本人とは予約した会員（user_id）と日が同じ
//   台帳の形は変えず、画面の側で組を作る（DB の変更なし）
type Row = { id: string; note?: string | null; customer_name: string; user_id?: string | null; starts_at: string; status: string }

/** お連れ様の予約なら、お連れ様のお名前。ご本人・電話・HOT PEPPER の予約は null */
export function companionOf(r: { note?: string | null }): string | null {
  const m = r.note?.match(/^お連れ様：(.+?)様?$/m)
  return m ? m[1].trim() || null : null
}

/** その枠で来られる方のお名前（お連れ様の枠はお連れ様のお名前） */
export const personName = (r: { note?: string | null; customer_name: string }) => companionOf(r) ?? r.customer_name

const LIVE = new Set(['confirmed', 'checked_in', 'in_service', 'awaiting_payment', 'completed'])
const dayOf = (iso: string) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10)

/** 組の印（何名の組の何番目か）。お連れ様を含む組だけ。取消・不来店は数えない */
export function partyOf(list: readonly Row[]): Map<string, { size: number; index: number }> {
  const groups = new Map<string, Row[]>()
  for (const r of list) {
    if (!r.user_id || !LIVE.has(r.status)) continue
    const k = `${r.user_id}|${dayOf(r.starts_at)}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const out = new Map<string, { size: number; index: number }>()
  for (const g of groups.values()) {
    if (g.length < 2 || !g.some(r => companionOf(r))) continue
    // ご本人が先、そのあと始まりの早い順
    const sorted = [...g].sort((a, b) => (companionOf(a) ? 1 : 0) - (companionOf(b) ? 1 : 0) || a.starts_at.localeCompare(b.starts_at))
    sorted.forEach((r, i) => out.set(r.id, { size: g.length, index: i + 1 }))
  }
  return out
}
