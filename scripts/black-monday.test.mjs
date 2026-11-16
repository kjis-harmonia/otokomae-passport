// Black Monday（11/17）：予約前の見込みと、お会計の明細ごとの値引き（サーバーの finalize_sale と同じ計算）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blackMondayAmount, blackMondayLineOffs, blackMondayOff, isBlackMondayDay } from '../src/utils/blackMonday.ts'

const rule = { starts_on: '2026-11-23', amount: 2000, menu_codes: ['perm-punch', 'perm-nurepan', 'perm-iper', 'perm-curly', 'perm-spain', 'perm-twist', 'perm-pin'] }
const line = (ref_id, unit_price, quantity = 1, discount = 0, source = 'reservation') => ({ source, ref_id, unit_price, quantity, discount })

test('月曜（日本時間）・開始日から。祝日の月曜（11/23）も対象', () => {
  assert.equal(isBlackMondayDay(rule, '2026-11-23T01:00:00Z'), true) // 11/23 10:00 JST（月・祝）
  assert.equal(isBlackMondayDay(rule, '2026-11-16T01:00:00Z'), false) // 開始日より前の月曜
  assert.equal(isBlackMondayDay(rule, '2026-11-29T16:00:00Z'), true) // UTC では日曜でも、日本時間は月曜 1:00
  assert.equal(isBlackMondayDay(rule, '2026-12-01T01:00:00Z'), false) // 火曜
})

test('予約前の見込み：対象メニューだけ ¥2,000（料金を超えない）', () => {
  assert.equal(blackMondayOff(rule, 'perm-punch', '2026-11-30T01:00:00Z', 8000), 2000)
  assert.equal(blackMondayOff(rule, 'perm-pin', '2026-11-30T01:00:00Z', 12000), 2000)
  assert.equal(blackMondayOff(rule, 'perm-curl-iper', '2026-11-30T01:00:00Z', 8000), 0) // カールアイパーは対象外
  assert.equal(blackMondayOff(rule, 'set-perm-color', '2026-11-30T01:00:00Z', 15000), 0) // セットも対象外
  assert.equal(blackMondayOff(rule, 'perm-punch', '2026-12-01T01:00:00Z', 8000), 0)
  assert.equal(blackMondayOff(rule, 'perm-punch', '2026-11-30T01:00:00Z', 1500), 1500)
  assert.equal(blackMondayOff(null, 'perm-punch', '2026-11-30T01:00:00Z', 8000), 0) // 料金表を読めていない
  assert.equal(blackMondayOff({ ...rule, amount: 0 }, 'perm-punch', '2026-11-30T01:00:00Z', 8000), 0) // 止めている
})

test('予約に出す額', () => {
  assert.equal(blackMondayAmount({ black_monday: { unit: 2000, amount: 4000, menu_codes: ['perm-punch', 'perm-pin'] } }), 4000)
  assert.equal(blackMondayAmount({ black_monday: { unit: 2000, amount: 0, menu_codes: ['perm-punch'], perm_coupon: true } }), 0)
  assert.equal(blackMondayAmount({ black_monday: null }), 0)
  assert.equal(blackMondayAmount({}), 0)
})

test('お会計：対象メニューの明細1つにつき ¥2,000。明細の残りを超えない。Welcome 等の券を使えば 0', () => {
  const bm = { eligible: true, unit: 2000, amount: 2000, menu_codes: rule.menu_codes }
  assert.deepEqual(blackMondayLineOffs([line('perm-punch', 8000), line('cut-regular', 4000, 1, 0, 'service_menu')], bm, false), [2000, 0])
  assert.deepEqual(blackMondayLineOffs([line('perm-punch', 8000), line('perm-pin', 12000, 1, 0, 'service_menu')], bm, false), [2000, 2000])
  assert.deepEqual(blackMondayLineOffs([line('perm-punch', 8000, 1, 7000)], bm, false), [1000])
  assert.deepEqual(blackMondayLineOffs([line('perm-punch', 8000, 1, 0, 'manual')], bm, false), [0]) // 手入力の明細は対象外
  assert.deepEqual(blackMondayLineOffs([line('perm-punch', 8000)], bm, true), [0])
  assert.deepEqual(blackMondayLineOffs([line('perm-punch', 8000)], { ...bm, eligible: false }, false), [0])
  assert.deepEqual(blackMondayLineOffs([line('perm-punch', 8000)], null, false), [0])
})

