// 店舗端末の会員QRの会計：どの予約の会計を開くか（SR-01・11/18）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickCheckoutReservation as pick } from '../src/utils/checkoutTarget.ts'

const me = (status, id = 'me') => ({ id, status, is_owner: true, starts_at: '2026-11-18T01:00:00Z' })
const mate = (status, id = 'mate') => ({ id, status, is_owner: false, starts_at: '2026-11-18T01:00:00Z' })

test('ご本人だけ1件：今までどおり、サーバーの予約を開く', () => {
  assert.deepEqual(pick({ fromServer: 'me', again: false, prefer: null, today: [me('confirmed')] }), { reservationId: 'me', needCheckIn: false })
  assert.deepEqual(pick({ fromServer: 'me', again: false, prefer: null, today: [me('checked_in')] }), { reservationId: 'me', needCheckIn: false })
})

test('お連れ様だけ受付：ご本人（未受付）ではなくお連れ様の会計', () => {
  assert.deepEqual(pick({ fromServer: 'me', again: false, prefer: 'mate', today: [me('confirmed'), mate('checked_in')] }), { reservationId: 'mate', needCheckIn: false })
  // 受付した ID が届かなくても、未受付のご本人は開かない
  assert.deepEqual(pick({ fromServer: 'me', again: false, prefer: null, today: [me('confirmed'), mate('checked_in')] }), { reservationId: 'mate', needCheckIn: false })
})

test('ご本人が受付済み・未会計で、お連れ様を受付：今回選んだお連れ様の会計', () => {
  assert.deepEqual(pick({ fromServer: 'me', again: false, prefer: 'mate', today: [me('checked_in'), mate('checked_in')] }), { reservationId: 'mate', needCheckIn: false })
})

test('ご本人だけ受付：ご本人の会計', () => {
  assert.deepEqual(pick({ fromServer: 'me', again: false, prefer: 'me', today: [me('checked_in'), mate('confirmed')] }), { reservationId: 'me', needCheckIn: false })
})

test('全員受付：ご本人が先。会計後の次はお連れ様', () => {
  assert.deepEqual(pick({ fromServer: 'me', again: false, prefer: null, today: [me('checked_in'), mate('checked_in')] }), { reservationId: 'me', needCheckIn: false })
  assert.deepEqual(pick({ fromServer: null, again: true, prefer: null, today: [me('completed'), mate('checked_in')] }), { reservationId: 'mate', needCheckIn: false })
})

test('まだ誰も受付していない・受付の通信失敗：開かずに受付してもらう', () => {
  assert.deepEqual(pick({ fromServer: 'me', again: false, prefer: null, today: [me('confirmed'), mate('confirmed')] }), { reservationId: null, needCheckIn: true })
  assert.deepEqual(pick({ fromServer: 'me', again: false, prefer: 'mate', today: [me('confirmed'), mate('confirmed')] }), { reservationId: null, needCheckIn: true })
})

test('お連れ様のご予約だけ（ご本人の予約なし）：受付していなければ開かない', () => {
  assert.deepEqual(pick({ fromServer: 'mate', again: false, prefer: null, today: [mate('confirmed')] }), { reservationId: null, needCheckIn: true })
  assert.deepEqual(pick({ fromServer: 'mate', again: false, prefer: null, today: [mate('checked_in')] }), { reservationId: 'mate', needCheckIn: false })
})

test('2件目（予約のない方）：予約なしの会計', () => {
  assert.deepEqual(pick({ fromServer: null, again: true, prefer: null, today: [me('completed')] }), { reservationId: null, needCheckIn: false })
})
