// SR-08：日時だけ変える時、元の時刻を外してから間引く（10:20 が消えて「空きなし」にならない）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changeTimes } from '../src/features/johnny/spreadSlots.ts'

const at = hm => `2026-11-20T${hm}:00+09:00`
const iso = hm => new Date(at(hm)).toISOString()

test('元が 10:00・空きが 10:00 と 10:20：日時だけの変更では 10:20 を出す', () => {
  const got = changeTimes([at('10:00'), at('10:20')], at('10:00'), true, 6).map(t => new Date(t).toISOString())
  assert.deepEqual(got, [iso('10:20')])
})

test('メニューも変える時は、元の 10:00 も選べる（今までどおり）', () => {
  const got = changeTimes([at('10:00'), at('10:20')], at('10:00'), false, 6).map(t => new Date(t).toISOString())
  assert.deepEqual(got, [iso('10:00')])
})

test('元の時刻を外したあとも1時間おきに間引く', () => {
  const got = changeTimes([at('10:00'), at('10:20'), at('10:40'), at('11:20'), at('12:00')], at('10:00'), true, 6)
    .map(t => new Date(t).toISOString())
  assert.deepEqual(got, [iso('10:20'), iso('11:20')])
})

test('時刻の書き方が違っても（Z と +09:00）同じ時刻なら外す', () => {
  const got = changeTimes([iso('10:00'), at('11:00')], at('10:00'), true, 6).map(t => new Date(t).toISOString())
  assert.deepEqual(got, [iso('11:00')])
})
