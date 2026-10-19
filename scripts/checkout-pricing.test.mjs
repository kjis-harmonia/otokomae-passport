import assert from 'node:assert/strict'
import { test } from 'node:test'
import { priceServiceCatalog, reservationSaleLines } from '../src/utils/checkoutPricing.ts'

const row = (charge, normal = 9000) => ({ code: 'perm-punch', charge, normal_price: normal })
const reservation = [{ menu_code: 'perm-punch', name: 'パンチパーマ', price: 8000 }]

test('土日祝の時間外は予約に残る会員価格ではなくサーバーの通常料金になる', () => {
  const lines = reservationSaleLines(reservation, { items: [row(9000)] })
  assert.equal(lines[0].unit_price - lines[0].discount, 9000)
})
test('会員価格の時間は支払単価を採用し、数量を変えても会員料金を維持する', () => {
  const lines = reservationSaleLines([...reservation, { menu_code: 'brow', name: '眉', price: 0 }], { items: [row(8000), { code: 'brow', charge: 500, normal_price: null }] })
  assert.equal(lines[0].unit_price, 8000)
  assert.equal(lines[0].discount, 0)
  assert.equal(lines[0].unit_price * 2 - lines[0].discount, 16000)
  assert.equal(lines.reduce((sum, line) => sum + line.unit_price - line.discount, 0), 8500)
})
test('価格変更はサーバー見積だけに従い、見積欠落・不正値では固定価格へ戻さない', () => {
  assert.equal(reservationSaleLines(reservation, { items: [row(8800, 9900)] })[0].unit_price, 8800)
  for (const items of [[], [row(-1)], [row(NaN)], [row(9000, 8000)], [row(null)]]) assert.throws(() => reservationSaleLines(reservation, { items }), /料金を確認できません/)
  assert.throws(() => reservationSaleLines(reservation, null), /料金を確認できません/)
})
test('旧予約のコードなし明細は保存された価格を維持し、価格欠落を0円にはしない', () => {
  assert.equal(reservationSaleLines([{ menu_code: null, name: '旧メニュー', price: 3500 }], null)[0].unit_price, 3500)
  assert.throws(() => reservationSaleLines([{ menu_code: null, name: '不明', price: null }], null))
})
test('予約なしのメニューも20件ずつ見積し、2回目以降は最初のサーバー時刻を使う', async () => {
  const calls = [], startsAt = '2026-10-24T06:00:00Z'
  const items = Array.from({ length: 43 }, (_, i) => ({ id: `m${i}`, name: `Menu ${i}`, category: 'menu', price: 8000 }))
  const priced = await priceServiceCatalog(items, async (codes, at) => {
    calls.push({ codes, at })
    return { starts_at: startsAt, items: codes.map(code => ({ code, charge: 9000, normal_price: 9000 })) }
  }, null)
  assert.deepEqual(calls.map(call => call.codes.length), [20, 20, 3])
  assert.deepEqual(calls.map(call => call.at), [null, startsAt, startsAt])
  assert.equal(priced.length, 43)
  assert.ok(priced.every(item => item.price === 9000 && item.normal_price === 9000))
  assert.ok(items.every(item => item.price === 8000))
})
test('予約から追加するメニューには同じ予約開始時刻を渡し、失敗時は料金を返さない', async () => {
  const at = '2026-10-26T06:00:00Z'
  await priceServiceCatalog([{ id: 'perm-punch' }], async (codes, startsAt) => {
    assert.equal(startsAt, at)
    return { starts_at: at, items: [row(8000)] }
  }, at)
  await assert.rejects(priceServiceCatalog([{ id: 'perm-punch' }], async () => { throw Error('offline') }, null), /offline/)
})
