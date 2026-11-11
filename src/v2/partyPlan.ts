// 2人以上の予約の並べ方（GinChat から使う。試験 scripts/party-plan.test.mjs）
/** 2人以上の組み立て：全員そろってご来店できる並べ方。担当が違えば同じ時間、同じ担当なら前の方が終わってすぐ。
 *  free[人][担当] はその担当がその人のメニューで入れる開始時刻（ms）。pref[人] は担当のご希望（staff の番号・null＝どちらでも）。
 *  最初の方が T に始まり、最後の方が一番早く終わる並べ方を返す（人数は3人まで・担当は数人なので総当たりで足りる） */
export function planParty(T: number, dur: number[], pref: (number | null)[], free: Set<number>[][]): { staff: number[]; start: number[] } | null {
  const n = dur.length, m = free[0]?.length ?? 0
  let best: { staff: number[]; start: number[]; end: number } | null = null
  const staff: number[] = Array(n).fill(-1), start: number[] = Array(n).fill(0)
  const go = (placed: number) => {
    if (placed === n) {
      if (Math.min(...start) !== T) return
      const end = Math.max(...start.map((s, i) => s + dur[i] * 60_000))
      if (!best || end < best.end) best = { staff: [...staff], start: [...start], end }
      return
    }
    // 次に並べる人（まだの人を順に試す）
    for (let i = 0; i < n; i++) {
      if (staff[i] !== -1) continue
      // 始められる時刻：最初の時刻 T か、もう並べた方の終わり（続けて）
      const ends = staff.map((s, j) => (s === -1 ? null : start[j] + dur[j] * 60_000)).filter((x): x is number => x != null)
      for (const at of [...new Set([T, ...ends])]) {
        for (let s = 0; s < m; s++) {
          if (pref[i] != null && pref[i] !== s) continue
          if (!free[i][s].has(at)) continue
          // 同じ担当の重なりは不可
          const clash = staff.some((x, j) => x === s && at < start[j] + dur[j] * 60_000 && start[j] < at + dur[i] * 60_000)
          if (clash) continue
          staff[i] = s; start[i] = at
          go(placed + 1)
          staff[i] = -1; start[i] = 0
        }
      }
    }
  }
  go(0)
  const b = best as { staff: number[]; start: number[]; end: number } | null
  return b ? { staff: b.staff, start: b.start } : null
}
