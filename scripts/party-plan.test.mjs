import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planParty } from '../src/v2/partyPlan.ts'

// 担当 0＝テイテイ・1＝銀二郎。時刻は分（ms に直す）
const M = 60_000
const at = (...min) => new Set(min.map(x => x * M))
const T = 600 * M // 10:00

test('担当が違う：同じ時間に並んで', () => {
  const free = [[at(600, 660), at(600, 660)], [at(600, 660), at(600, 660)]]
  const r = planParty(T, [50, 50], [0, 1], free)
  assert.deepEqual(r, { staff: [0, 1], start: [T, T] })
})

test('同じ担当：前の方が終わったらすぐ続けて', () => {
  const free = [[at(600, 650, 700), at()], [at(600, 650, 700), at()]]
  const r = planParty(T, [50, 60], [0, 0], free)
  assert.deepEqual(r, { staff: [0, 0], start: [T, T + 50 * M] })
})

test('どちらでも：空いている担当で、全員が一番早く終わる並べ方', () => {
  const free = [[at(600), at(600)], [at(600), at(600)]]
  const r = planParty(T, [50, 50], [null, null], free)
  assert.deepEqual(r.start, [T, T])
  assert.notEqual(r.staff[0], r.staff[1])
})

test('選んだ担当がその日いない（空きが無い）：入れない', () => {
  const free = [[at(600, 650), at()], [at(), at(600, 650)]]
  assert.equal(planParty(T, [50, 50], [1, null], free), null)
})

test('1人目が T に始まれない時刻は案内しない', () => {
  const free = [[at(650), at()], [at(650), at()]]
  assert.equal(planParty(T, [50, 50], [0, 0], free), null)
})

test('同じ担当の続きの時間が埋まっていたら入れない（重ねない）', () => {
  const free = [[at(600), at()], [at(600), at()]]
  assert.equal(planParty(T, [50, 50], [0, 0], free), null)
})

test('3人：2人は同じ担当で続けて・1人はもう1人の担当で同じ時間', () => {
  const free = [[at(600, 650), at()], [at(600, 650), at()], [at(), at(600)]]
  const r = planParty(T, [50, 50, 50], [0, 0, 1], free)
  assert.deepEqual(r, { staff: [0, 0, 1], start: [T, T + 50 * M, T] })
})
