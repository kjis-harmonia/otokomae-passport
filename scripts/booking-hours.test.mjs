// アプリの新しい予約は毎日 8:00〜21:00（日本時間）だけ（11/19 慶一郎さん）。境目を確かめる
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appBookingOpen } from '../src/v2/bookingHours.ts'

const jst = (hm) => Date.parse(`2026-11-20T${hm}:00+09:00`)

test('8:00 から 20:59 まで受け付ける', () => {
  for (const hm of ['08:00', '12:00', '20:59']) assert.equal(appBookingOpen(jst(hm)), true, hm)
})
test('21:00 から 翌7:59 までは受け付けない', () => {
  for (const hm of ['21:00', '23:59', '00:00', '07:59']) assert.equal(appBookingOpen(jst(hm)), false, hm)
})
