// お連れ様の時間を決める（予約者の時間から一番早く入れる時間）。DB から担当ごとの空き時刻をもらって、ここで組み合わせる。
//   ・予約者の時刻 S に、予約者を担当できる人 a がいる
//   ・お連れ様は、S 以降で一番早い時刻 C に、担当 b が入れる（b が a と同じなら、予約者が終わってから）
//   ・C が S と同じなら「お二人同時」。違うときは、その日にお二人同時に入れる一番早い時刻も探して案内する
// 実際に押さえるのは「はい」のあと（DB の仮押さえが最終判断）。

export interface StaffSlots { staffId: string; primary: string[]; companion: string[] }

export interface PartyPlan {
  /** お連れ様の開始時刻（ISO）。無ければ null（その日は入れない） */
  companion: string | null
  /** 予約者と同じ時刻か */
  together: boolean
  /** 同じ時刻でないとき：お二人同時に入れる一番早い時刻（予約者の時刻を変える案）。無ければ null */
  togetherAt: string | null
}

const ms = (iso: string) => Date.parse(iso)

export function planCompanion(primaryAt: string, primaryMin: number, primaryStaff: string | null, staff: readonly StaffSlots[]): PartyPlan {
  const S = ms(primaryAt)
  const has = (list: string[], t: number) => list.some(x => ms(x) === t)
  // 予約者を担当できる人（指名があればその人だけ）
  const aCands = staff.filter(s => (!primaryStaff || s.staffId === primaryStaff) && has(s.primary, S))
  const compTimes = [...new Set(staff.flatMap(s => s.companion.map(ms)))].filter(t => t >= S).sort((x, y) => x - y)
  let companion: number | null = null
  for (const C of compTimes) {
    const ok = aCands.some(a => staff.some(b => has(b.companion, C) && (b.staffId !== a.staffId || C >= S + primaryMin * 60000)))
    if (ok) { companion = C; break }
  }
  const together = companion === S
  let togetherAt: number | null = null
  if (!together) {
    // お二人同時：予約者の時刻を変えてよい案（指名があればその人で）。予約者の時刻より後を先に、無ければその日の前の時間も
    const times = [...new Set(staff.flatMap(s => s.primary.map(ms)))].sort((x, y) => x - y)
    const both = times.filter(T => staff.some(a => (!primaryStaff || a.staffId === primaryStaff) && has(a.primary, T)
      && staff.some(b => b.staffId !== a.staffId && has(b.companion, T))))
    togetherAt = both.find(T => T >= S) ?? both[both.length - 1] ?? null
  }
  const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString())
  return { companion: iso(companion), together, togetherAt: iso(togetherAt) }
}

/** 予約者の時刻ごと試して、お連れ様も入れる案を返す（ほかの日に移すとき）。
 *  時刻は「もとの希望と同じ時刻か、そのあと」を早い順に、無ければその前を遅い順に。無ければ null */
export function planPartyDay(clockMin: number, primaryMin: number, primaryStaff: string | null, staff: readonly StaffSlots[], minutesOf: (iso: string) => number): (PartyPlan & { primary: string }) | null {
  const times = [...new Set(staff.filter(s => !primaryStaff || s.staffId === primaryStaff).flatMap(s => s.primary))]
    .sort((x, y) => ms(x) - ms(y))
  const after = times.filter(t => minutesOf(t) >= clockMin)
  const before = times.filter(t => minutesOf(t) < clockMin).reverse()
  for (const t of [...after, ...before]) {
    const plan = planCompanion(t, primaryMin, primaryStaff, staff)
    if (plan.companion) return { ...plan, primary: new Date(ms(t)).toISOString() }
  }
  return null
}
