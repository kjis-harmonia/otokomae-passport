// メニューを予約に使った回数（この端末の中だけ）。「よく使う」タブの並び順に使う。予約や料金には関係しない
const USAGE_KEY = 'ginjiro_sb_menu_usage_v1'

export function readMenuUsage(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(USAGE_KEY) ?? '{}') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, number> : {}
  } catch { return {} }
}

/** 予約を送るときに呼ぶ：選んだメニューの使用回数を1つ増やす */
export function recordMenuUsage(codes: readonly string[]): void {
  const u = readMenuUsage()
  for (const c of codes) u[c] = (Number(u[c]) || 0) + 1
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)) } catch { /* 覚えられなくても予約には影響しない */ }
}
