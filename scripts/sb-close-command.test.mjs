import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSbCommand } from '../src/sb/sbCommand.ts'

// SB の「時間を閉める（クローズ）」：電話予約などで AI 予約を止める言い方と、ふつうの予約の言い方を取り違えない
const staff = [{ id: 'tt', name: 'テイテイ' }, { id: 'gin', name: '銀二郎' }]
const menus = [
  { code: 'punch', name: 'パンチパーマ', duration_min: 90, price: 8000 },
  { code: 'cut', name: 'カット', duration_min: 60, price: 4000 },
]
const now = new Date('2026-10-24T01:00:00Z') // 10/24 10:00 JST
const p = text => parseSbCommand(text, staff, menus, now)

test('「今日の15時から16時半までclose」：今日 15:00〜16:30 を閉める・担当は選ばせる', () => {
  const d = p('今日の15時から16時半までclose')
  assert.equal(d.close, true)
  assert.equal(d.date, '2026-10-24')
  assert.equal(d.minutes, 15 * 60)
  assert.equal(d.endMinutes, 16 * 60 + 30)
  assert.equal(d.staffId, null)
})

test('担当とクローズ：「テイテイ 明日14時から15時 クローズ」', () => {
  const d = p('テイテイ 明日14時から15時 クローズ')
  assert.deepEqual([d.close, d.date, d.minutes, d.endMinutes, d.staffId], [true, '2026-10-25', 14 * 60, 15 * 60, 'tt'])
})

test('「閉めて」「押さえて」「ブロック」も閉める', () => {
  for (const t of ['銀二郎 15時半から17時まで閉めて', '15時から16時 押さえて', '16時から17時ブロック']) assert.equal(p(t).close, true, t)
  assert.equal(p('銀二郎 15時半から17時まで閉めて').staffId, 'gin')
})

test('声のかな・「3時」は営業時間に合わせて午後：「きょうのさんじからよじはんまで」', () => {
  const d = p('きょうのさんじからよじはんまで')
  assert.deepEqual([d.close, d.minutes, d.endMinutes], [true, 15 * 60, 16 * 60 + 30])
})

test('範囲だけ（お客様・メニューなし）は閉める', () => {
  assert.equal(p('銀二郎 3時から4時半').close, true)
})

test('ふつうの予約は閉めない：お客様・メニューがある', () => {
  for (const t of ['明日15時 田中さん パンチ 銀二郎で', '今日14時 カット', '銀二郎 今日14時 パンチパーマ']) {
    const d = p(t)
    assert.equal(d.close, false, t)
  }
  assert.equal(p('明日15時 田中さん パンチ 銀二郎で').endMinutes, null)
})

test('「クローズ」で終わりを言わないときは、終わりは画面で選ぶ', () => {
  const d = p('テイテイ 今日16時 クローズ')
  assert.deepEqual([d.close, d.minutes, d.endMinutes], [true, 16 * 60, null])
})
