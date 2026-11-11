/** お連れ様の予約なら、お連れ様のお名前（メモの「お連れ様：〇〇様」）。ご本人の予約・予約なしは null（11/11 店舗端末点検） */
export function companionNameOf(r: { note?: string | null } | null | undefined): string | null {
  const m = r?.note?.match(/^お連れ様：(.+?)様?$/m)
  return m ? m[1].trim() || null : null
}
