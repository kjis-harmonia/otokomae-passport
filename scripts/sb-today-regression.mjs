// 銀二郎SB「今日の相棒」のまとめの回帰テスト（DB・ブラウザは使わない）
//   node scripts/sb-today-regression.mjs
import assert from 'node:assert/strict'
import { summarizeToday } from '../src/sb/sbTodaySummary.ts'

const at = hm => `2026-10-15T${hm}:00+09:00`
const NOW = Date.parse(at('12:00'))
const r = (id, staff, start, end, status = 'confirmed', price = 5000, extra = {}) => ({
  id, staff_id: staff, staff_name: staff === 'g' ? '銀二郎' : 'テイテイ', customer_name: `客${id}`, starts_at: at(start), ends_at: at(end),
  occupied_until: at(end), status, total_price: price, transfer_status: 'done', items: [{ name: 'カット' }], ...extra,
})
const ledger = {
  staff: [
    { id: 'g', name: '銀二郎', shifts: [{ start: at('10:00'), end: at('19:00') }] },
    { id: 't', name: 'テイテイ', shifts: [{ start: at('10:00'), end: at('19:00') }] },
  ],
  blocks: [{ staff_id: 't', starts_at: at('15:00'), ends_at: at('16:00') }],
  reservations: [
    r('a', 'g', '11:00', '12:30', 'in_service', 8000),
    r('b', 'g', '11:40', '12:40', 'confirmed', 4000),         // 20分過ぎて未来店 → 遅れ
    r('c', 'g', '12:10', '13:00', 'confirmed', 5000, { transfer_status: 'pending' }),
    r('d', 't', '13:00', '14:00', 'confirmed', 6000),
    r('e', 'g', '16:00', '17:00', 'confirmed', 5000),
    r('x', 't', '12:30', '13:00', 'cancelled', 9999),
  ],
}
let passed = 0
function check(name, fn) { try { fn(); passed++ } catch (err) { console.error(`✗ ${name}`); throw err } }
const s = summarizeToday(ledger, NOW)

check('次のお客様は予約済みで、今から先（早い順・最大3件）', () => assert.deepEqual(s.next.map(x => x.id), ['c', 'd', 'e']))
check('施術中', () => assert.deepEqual(s.inService.map(x => x.id), ['a']))
check('来店予定を10分以上過ぎた予約', () => assert.deepEqual(s.late.map(x => x.id), ['b']))
check('取消は数えない', () => { assert.equal(s.count, 5); assert.equal(s.expected, 8000 + 4000 + 5000 + 6000 + 5000) })
check('未転記', () => assert.equal(s.pendingTransfer, 1))
check('空き時間：予約も受付外も無い30分以上（今から先・早い順）', () => {
  const fmt = g => `${g.staffName} ${new Date(g.start + 9 * 3600e3).toISOString().slice(11, 16)}-${new Date(g.end + 9 * 3600e3).toISOString().slice(11, 16)}`
  assert.deepEqual(s.gaps.map(fmt), ['テイテイ 12:00-13:00', '銀二郎 13:00-16:00', 'テイテイ 14:00-15:00']) // 取消の予約（12:30）は空きをふさがない
})
check('空き時間は最大3件', () => assert.equal(s.gaps.length, 3))
check('閉店後は空きなし', () => assert.deepEqual(summarizeToday(ledger, Date.parse(at('19:00'))).gaps, []))

console.log(`sb today regression: ${passed} checks ok`)
