// JOHNNY の試験用の決まった世界：いまは 2026-10-17（土）14:00。月曜は定休日。
// メニューは本番と同じ 41 件（2026-10-16 時点）。スタッフはテイテイ・銀二郎。
import type { AgentTools, DayOverview, MenuInfo, Reservation, StaffInfo } from '../../supabase/functions/johnny-agent/agent.ts'

export const NOW = '2026-10-17T14:00:00+09:00'
export const TEITEI = 'a0000000-0000-4000-8000-000000000001'
export const GINJIRO = 'a0000000-0000-4000-8000-000000000002'
export const STAFF: StaffInfo[] = [{ id: TEITEI, name: 'テイテイ' }, { id: GINJIRO, name: '銀二郎' }]

const M = (code: string, name: string, category: string, duration_min: number, price: number): MenuInfo => ({ code, name, category, duration_min, price })
export const MENUS: MenuInfo[] = [
  M('cut-regular', '通常カット', 'カット', 45, 4000), M('cut-skin-fade', 'スキンフェードカット', 'カット', 60, 5000),
  M('cut-skin-fade-plus', 'ワンランク上のスキンフェード', 'カット', 75, 6000), M('cut-buzz', '丸刈り', 'カット', 30, 1500),
  M('cut-elementary', '小学生', 'カット', 30, 2000), M('cut-kids-skin-fade', '子供スキンフェード', 'カット', 45, 3000), M('cut-bangs', '前髪', 'カット', 15, 500),
  M('color-gray', '白髪染め/ぼかし', 'カラー', 60, 3000), M('color-regular', 'ヘアカラー', 'カラー', 60, 4000), M('color-mesh', 'メッシュ', 'カラー', 60, 4000),
  M('color-double-mesh', 'ダブルメッシュ', 'カラー', 90, 6000), M('color-bleach-1', 'ブリーチ1回', 'カラー', 90, 5000), M('color-bleach-2', 'ブリーチ2回', 'カラー', 150, 7000),
  M('perm-nurepan', '濡れパン', 'パーマ', 120, 8000), M('perm-curl-iper', 'カールアイパー', 'パーマ', 120, 8000), M('perm-punch', 'パンチパーマ', 'パーマ', 120, 8000),
  M('perm-iper', 'アイパー', 'パーマ', 120, 8000), M('perm-spain', 'スペインパーマ', 'パーマ', 120, 8000), M('perm-curly', 'カーリーパーマ', 'パーマ', 120, 8000),
  M('perm-normal', 'ノーマルパーマ', 'パーマ', 120, 8000), M('perm-negro', 'ニグロパーマ', 'パーマ', 150, 9000), M('perm-afro', 'アフロ系', 'パーマ', 150, 9000),
  M('perm-twist', 'ツイスト系', 'パーマ', 150, 12000), M('perm-ginpara-curly', 'ギンパラカーリー', 'パーマ', 180, 15000),
  M('shave-men', '顔そり男性', 'シェービング', 30, 2000), M('shave-ladies', 'レディースシェービング', 'シェービング', 45, 3000),
  M('opt-brow', '眉手入れ', 'オプション', 15, 500), M('opt-shampoo', 'シャンプー', 'オプション', 15, 1000), M('opt-line', 'ライン1本', 'オプション', 15, 300),
  M('opt-gosso', 'ゴッソ', 'オプション', 10, 300), M('opt-face-pack', 'フェイスパック', 'オプション', 15, 500), M('opt-cool-shampoo', 'クールシャンプー', 'オプション', 15, 300),
  M('set-cut-color', '通常カット&カラー', 'セット', 90, 6500), M('set-fade-color', 'スキンフェード&カラー', 'セット', 120, 7500),
  M('set-punch-color', 'パンチ&カラー', 'セット', 150, 15000), M('set-punch-gray', 'パンチ&白髪染め', 'セット', 150, 12000), M('set-iper-gray', 'アイパー&白髪染め', 'セット', 150, 12000),
  M('set-twist-mesh', 'ツイスト&メッシュ', 'セット', 180, 15000), M('set-twist-double-mesh', 'ツイスト&ダブルメッシュ', 'セット', 210, 18000),
  M('set-spain-mesh', 'スペインパーマ&メッシュ', 'セット', 180, 13000), M('set-spain-double-mesh', 'スペインパーマ&ダブルメッシュ', 'セット', 210, 15000),
]

const OPEN = 10 * 60, CLOSE = 20 * 60, STEP = 15
/** 埋まっている時間（担当ごと・日付ごと、[開始分, 終了分]） */
const BUSY: Record<string, Record<string, [number, number][]>> = {
  '2026-10-17': { [TEITEI]: [[14 * 60, 17 * 60 + 30]], [GINJIRO]: [[13 * 60, 16 * 60], [17 * 60, 19 * 60]] },
  '2026-10-18': { [TEITEI]: [[10 * 60, 12 * 60]], [GINJIRO]: [[11 * 60, 13 * 60], [15 * 60, 16 * 60]] },
  '2026-10-20': { [TEITEI]: [[15 * 60, 16 * 60]], [GINJIRO]: [] },
  '2026-10-21': { [TEITEI]: [[10 * 60, 20 * 60]], [GINJIRO]: [[10 * 60, 20 * 60]] }, // 水曜は終日埋まっている
}
const pad = (n: number) => String(n).padStart(2, '0')
const iso = (date: string, min: number) => new Date(`${date}T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00+09:00`).toISOString()
const isMonday = (date: string) => new Date(date + 'T12:00:00+09:00').getUTCDay() === 1
const today = '2026-10-17', nowMin = 14 * 60, lead = 30

export function staffSlots(date: string, code: string, staffId: string): string[] {
  const menu = MENUS.find(m => m.code === code)
  if (!menu || isMonday(date) || date < today || date > '2026-12-15') return []
  const busy = BUSY[date]?.[staffId] ?? []
  const out: string[] = []
  for (let t = OPEN; t + menu.duration_min <= CLOSE; t += STEP) {
    if (date === today && t < nowMin + lead) continue
    if (busy.some(([a, b]) => t < b && t + menu.duration_min > a)) continue
    out.push(iso(date, t))
  }
  return out
}
export function anySlots(date: string, code: string): string[] {
  return [...new Set(STAFF.flatMap(s => staffSlots(date, code, s.id)))].sort()
}
const addDays = (date: string, n: number) => new Date(new Date(date + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10)

export const RESERVATIONS: Record<string, Reservation[]> = {
  none: [],
  one: [{ id: 'r-1020', starts_at: '2026-10-20T15:00:00+09:00', status: 'confirmed', staff_name: 'テイテイ', menu: '通常カット', menu_code: 'cut-regular' }],
  two: [
    { id: 'r-1020', starts_at: '2026-10-20T15:00:00+09:00', status: 'confirmed', staff_name: 'テイテイ', menu: '通常カット', menu_code: 'cut-regular' },
    { id: 'r-1025', starts_at: '2026-10-25T11:00:00+09:00', status: 'confirmed', staff_name: '銀二郎', menu: 'パンチパーマ', menu_code: 'perm-punch' },
  ],
}

export function fixtureTools(reservations: Reservation[]): AgentTools & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async dayOverview(date) {
      calls.push(`day_overview ${date}`)
      if (isMonday(date)) return { date, open: false, hours: null, groups: [] } satisfies DayOverview
      const groups = new Map<string, { codes: string[]; slots: string[] }>()
      for (const m of MENUS) {
        const slots = anySlots(date, m.code)
        if (!slots.length) continue
        const key = slots.join(',')
        const g = groups.get(key) ?? { codes: [], slots }
        g.codes.push(m.code); groups.set(key, g)
      }
      return { date, open: true, hours: { start: '10:00', end: '20:00' }, groups: [...groups.values()] }
    },
    async nextSlots(code, from, staffId) {
      calls.push(`next_slots ${code} ${from}${staffId ? ' ' + staffId : ''}`)
      const out: string[] = []
      for (let d = from < today ? today : from, i = 0; i < 30 && out.length < 10; d = addDays(d, 1), i++) out.push(...(staffId ? staffSlots(d, code, staffId) : anySlots(d, code)).slice(0, 10 - out.length))
      return out
    },
    async slots(date, code, staffId) {
      calls.push(`slots ${date} ${code} ${staffId ?? 'any'}`)
      return staffId ? staffSlots(date, code, staffId) : anySlots(date, code)
    },
    async reservations() { calls.push('my_reservations'); return reservations },
  }
}
