import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auctionErrorMessage, clampBid, endLabel, extendedEnd, maxBid, mineLabel, nextMinBid, timeLeft } from '../src/features/auction/auctionLogic.ts'

test('最低入札額：入札が無ければ開始価格、あれば現在価格＋100円', () => {
  assert.equal(nextMinBid(null, 100, 100), 100)
  assert.equal(nextMinBid(300, 100, 100), 400)
  assert.equal(nextMinBid(1500, 100, 500), 2000)
})

test('入札額は最低額〜即決価格の手前に、100円刻みで収める', () => {
  assert.equal(clampBid(50, 400, null, 100), 400)
  assert.equal(clampBid(460, 400, null, 100), 500)
  assert.equal(clampBid(2000, 400, 800, 100), 700)
  assert.equal(clampBid(Number.NaN, 400, 800, 100), 400)
  // 即決が最低額のすぐ上でも、最低額より下にはしない
  assert.equal(clampBid(900, 400, 450, 100), 400)
  assert.equal(maxBid(800, 100), 700)
  assert.equal(maxBid(null, 100), 1_000_000)
})

test('終了5分前からの入札で、終了を5分延ばす', () => {
  const end = Date.parse('2026-11-12T12:00:00Z')
  assert.equal(extendedEnd(end, end - 10 * 60_000), end)
  assert.equal(extendedEnd(end, end - 5 * 60_000), end + 5 * 60_000)
  assert.equal(extendedEnd(end, end - 30_000), end + 5 * 60_000)
})

test('残り時間の書き方', () => {
  const now = Date.parse('2026-11-12T00:00:00Z')
  assert.equal(timeLeft(now + (2 * 86400 + 3 * 3600 + 59) * 1000, now), '2日 3時間')
  assert.equal(timeLeft(now + (4 * 3600 + 12 * 60) * 1000, now), '4時間 12分')
  assert.equal(timeLeft(now + (12 * 60 + 5) * 1000, now), '12分 05秒')
  assert.equal(timeLeft(now + 999, now), '0分 00秒')
  assert.equal(timeLeft(now, now), null)
  assert.equal(timeLeft(now - 1, now), null)
})

test('終了の日時は日本時間', () => {
  assert.equal(endLabel(Date.parse('2026-11-13T11:58:00Z')), '11月13日（金）20:58')
  assert.equal(endLabel(Date.parse('2026-11-12T15:05:00Z')), '11月13日（金）00:05')
})

test('自分の状況と、断られたときの言葉', () => {
  assert.equal(mineLabel('leading'), '最高額で入札中です')
  assert.equal(mineLabel('won'), '落札しました')
  assert.equal(mineLabel(null), null)
  assert.match(auctionErrorMessage('insufficient_balance'), /残高が足りません/)
  assert.match(auctionErrorMessage('unknown_code'), /もう一度/)
})
