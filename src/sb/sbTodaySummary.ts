// 「今日の相棒」：今日の予約表（DB の台帳）から、今やることをまとめる。計算だけで、予約は変えない。
//   次のお客様 / 施術中 / 来店予定を過ぎたお客様 / 予約が1件も入っていない空き時間 / 未転記 / 今日の件数と見込み
// 型は台帳の形だけに依存する（テストから素のデータで呼べるように）

export interface TodayReservation {
  id: string
  staff_id: string
  staff_name: string
  customer_name: string
  starts_at: string
  ends_at: string
  occupied_until: string
  status: string
  total_price: number | null
  transfer_status?: string
  items: { name: string }[]
}
export interface TodayStaff { id: string; name: string; shifts: { start: string; end: string }[] }
export interface TodayBlock { staff_id: string | null; starts_at: string; ends_at: string }
export interface TodayLedger { staff: TodayStaff[]; blocks: TodayBlock[]; reservations: TodayReservation[] }

export interface TodayGap { staffId: string; staffName: string; start: number; end: number }
export interface TodaySummary {
  next: TodayReservation[]
  inService: TodayReservation[]
  late: TodayReservation[]
  gaps: TodayGap[]
  pendingTransfer: number
  count: number
  expected: number
}

const OCCUPYING = new Set(['confirmed', 'checked_in', 'in_service', 'awaiting_payment', 'completed'])
const IN_SERVICE = new Set(['checked_in', 'in_service', 'awaiting_payment'])
const STEP = 15 * 60 * 1000
/** 来店予定を過ぎたとみなすまでの猶予 */
const LATE_AFTER = 10 * 60 * 1000
/** 空き時間として見せる最短の長さ */
const MIN_GAP = 30 * 60 * 1000

const t = (iso: string) => Date.parse(iso)

export function summarizeToday(ledger: TodayLedger, now: number): TodaySummary {
  const active = ledger.reservations.filter(r => OCCUPYING.has(r.status))
  const confirmed = active.filter(r => r.status === 'confirmed').sort((a, b) => t(a.starts_at) - t(b.starts_at))

  const next = confirmed.filter(r => t(r.starts_at) >= now - LATE_AFTER).slice(0, 3)
  const late = confirmed.filter(r => t(r.starts_at) < now - LATE_AFTER && t(r.ends_at) > now)
  const inService = active.filter(r => IN_SERVICE.has(r.status)).sort((a, b) => t(a.starts_at) - t(b.starts_at))

  // 予約が1件も入っていない時間（勤務中・受付外の時間を除く・今から先）。15分刻みで見て、30分以上続くところ
  const gaps: TodayGap[] = []
  for (const s of ledger.staff) {
    const busy = [
      ...active.filter(r => r.staff_id === s.id).map(r => [t(r.starts_at), t(r.occupied_until)] as const),
      ...ledger.blocks.filter(b => b.staff_id === null || b.staff_id === s.id).map(b => [t(b.starts_at), t(b.ends_at)] as const),
    ]
    for (const shift of s.shifts) {
      const from = Math.max(t(shift.start), Math.ceil(now / STEP) * STEP)
      let open: number | null = null
      for (let x = from; x < t(shift.end); x += STEP) {
        const free = !busy.some(([a, b]) => a < x + STEP && b > x)
        if (free && open === null) open = x
        if (!free && open !== null) { if (x - open >= MIN_GAP) gaps.push({ staffId: s.id, staffName: s.name, start: open, end: x }); open = null }
      }
      if (open !== null && t(shift.end) - open >= MIN_GAP) gaps.push({ staffId: s.id, staffName: s.name, start: open, end: t(shift.end) })
    }
  }
  gaps.sort((a, b) => a.start - b.start || a.staffName.localeCompare(b.staffName))

  return {
    next,
    inService,
    late,
    gaps: gaps.slice(0, 3),
    pendingTransfer: ledger.reservations.filter(r => r.transfer_status === 'pending').length,
    count: active.length,
    expected: active.reduce((sum, r) => sum + (r.total_price ?? 0), 0),
  }
}
