import assert from 'node:assert/strict'
import test from 'node:test'
import { insightRange, insightSeries, insightsCsv, percentageChange, shiftDate, summarizeInsights } from '../src/hq/hqInsights.ts'

const row = (overrides = {}) => ({ id: 'accounting-1', total: 5000, stylist_name: '銀二郎', payment_method: 'cash', created_at: '2026-10-15T10:00:00+09:00', ...overrides })

test('periods end after the selected JST date and compare equal day counts', () => {
  assert.deepEqual(insightRange('week', '2026-10-15'), { start: '2026-10-12', end: '2026-10-16', previousStart: '2026-10-08', previousEnd: '2026-10-12', days: 4, comparison: '直前4日間比' })
  assert.equal(insightRange('week', '2026-10-18').days, 7)
  assert.equal(insightRange('month', '2026-03-01').previousStart, '2026-02-28')
  assert.equal(shiftDate('2028-03-01', -1), '2028-02-29')
})

test('all payment methods reconcile to total sales, including card aliases and unknown methods', () => {
  const rows = [row(), row({ payment_method: 'credit', total: 7000 }), row({ payment_method: 'card', total: 3000 }), row({ payment_method: 'qr', total: 2000 }), row({ payment_method: 'ginpay', total: 8000 }), row({ payment_method: 'other', total: 1000 }), row({ payment_method: null, total: 4000 })]
  const summary = summarizeInsights(rows)
  assert.equal(summary.sales, 30000)
  assert.equal(summary.payments.reduce((sum, p) => sum + p.total, 0), summary.sales)
  assert.equal(summary.payments.find(p => p.method === 'credit').total, 10000)
  assert.equal(summary.payments.find(p => p.method === 'ginpay').total, 8000)
  assert.equal(summary.payments.find(p => p.method === 'other').total, 5000)
})

test('staff are derived from recorded sales instead of a hardcoded name list', () => {
  const summary = summarizeInsights([row({ stylist_name: '新しい担当者', total: 9000 }), row({ stylist_name: null, total: 1000 })])
  assert.equal(summary.staff[0].name, '新しい担当者')
  assert.equal(summary.staff[1].name, '未設定')
  assert.equal(summary.staff.reduce((n, s) => n + s.sales, 0), summary.sales)
})

test('no previous sales produces no invented percentage', () => {
  assert.equal(percentageChange(10000, 0), null)
  assert.equal(percentageChange(0, 0), null)
  assert.equal(percentageChange(8000, 10000), -20)
})

test('JST boundaries put UTC previous-day evening into the correct date', () => {
  const range = insightRange('week', '2026-10-15')
  const points = insightSeries([row({ total: 3000, created_at: '2026-10-11T15:00:00Z' }), row({ total: 6000, created_at: '2026-10-15T14:59:59Z' })], [], range)
  assert.equal(points[0].current, 3000)
  assert.equal(points.at(-1).current, 9000)
  assert.deepEqual(points.map(p => p.label), ['10/12', '10/13', '10/14', '10/15'])
})

test('hourly cumulative chart includes early and late records and preserves the total', () => {
  const points = insightSeries([row({ total: 500, created_at: '2026-10-14T15:00:00Z' }), row({ total: 4500, created_at: '2026-10-15T14:59:59Z' })], [row({ total: 6000 })], insightRange('today', '2026-10-15'))
  assert.equal(points.length, 24)
  assert.equal(points[0].current, 500)
  assert.equal(points.at(-1).current, 5000)
})

test('empty data stays empty and CSV contains the observed values', () => {
  const summary = summarizeInsights([])
  assert.equal(summary.sales, 0)
  assert.equal(summary.unitPrice, 0)
  assert.deepEqual(summary.staff, [])
  const csv = insightsCsv([{ label: '10/15', current: 12000, previous: 8000 }])
  assert.ok(csv.startsWith('\uFEFF'))
  assert.ok(csv.includes('10/15,12000,8000'))
})
