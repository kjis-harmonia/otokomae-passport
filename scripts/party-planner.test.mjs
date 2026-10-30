import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planPartyDay } from '../src/features/johnny/partyPlanner.ts'

const at = (hm) => `2026-11-01T${hm}:00+09:00`
const minutes = (iso) => { const d = new Date(Date.parse(iso) + 9 * 3600000); return d.getUTCHours() * 60 + d.getUTCMinutes() }

test('ほかの日に移すとき、もとの希望の時刻に近い時刻でお二人とも入れる案を返す', () => {
  const staff = [
    { staffId: 'a', primary: [at('10:00'), at('16:30')], companion: [at('10:00'), at('16:30')] },
    { staffId: 'b', primary: [at('16:30')], companion: [at('16:30')] },
  ]
  const p = planPartyDay(17 * 60, 120, 'a', staff, minutes)
  assert.equal(Date.parse(p.primary), Date.parse(at('16:30')))
  assert.equal(Date.parse(p.companion), Date.parse(at('16:30')))
  assert.equal(p.together, true)
})

test('お連れ様が入れない日は null', () => {
  const staff = [{ staffId: 'a', primary: [at('17:00')], companion: [at('17:00')] }]
  assert.equal(planPartyDay(17 * 60, 120, 'a', staff, minutes), null)
})
