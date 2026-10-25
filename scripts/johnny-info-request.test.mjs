import assert from 'node:assert/strict'
import { test } from 'node:test'
import { infoRequest, isMaintenanceBookingRequest } from '../src/features/johnny/infoRequest.ts'

// Johnny V2.0 の「答えるだけ」：予約の言葉と取り違えない
test('会員QR', () => { for (const t of ['会員QRを出して', 'QR見せて', '会員証', '男前証出して']) assert.equal(infoRequest(t), 'qr', t) })
test('銀Pay の残高', () => { for (const t of ['銀Payの残高は？', '銀ペイいくら残っとる', '残高教えて']) assert.equal(infoRequest(t), 'ginpay', t) })
test('次のメンテナンス', () => { for (const t of ['次のメンテナンスはいつ？', 'メンテまで何日', 'そろそろメンテ？']) assert.equal(infoRequest(t), 'maintenance', t) })

test('メンテナンスの一言は、予約か次回の目安かを確認する', () => {
  for (const t of ['メンテナンス。', 'メンテナンス', ' メンテ？ ', 'めんてなんす！', 'メンテナンス…']) {
    assert.equal(infoRequest(t), 'maintenanceChoice', t)
    assert.equal(isMaintenanceBookingRequest(t), false, t)
  }
  for (const t of ['メンテナンス中なんですね', 'システムはメンテナンス中？', 'メンテナンス中', '今日は休み？']) assert.equal(infoRequest(t), null, t)
})

test('メンテナンスカットの予約先案内と、既存予約の取消・変更を区別する', () => {
  for (const t of ['メンテナンスカット', 'メンテカット', 'メンテナンスカットを予約したい', 'めんてなんすかっとを予約']) assert.equal(isMaintenanceBookingRequest(t), true, t)
  for (const t of ['メンテナンスはいつ？', 'メンテナンスの予約をキャンセル', 'メンテカットの予約を変更したい', 'メンテの予約を取り消して', '明日のカットを予約']) assert.equal(isMaintenanceBookingRequest(t), false, t)
})

test('確認の2択は声でも答えられる。通常の会話や予約の取消を横取りしない', () => {
  for (const t of ['目安', 'いつごろ？', '次の時期を教えて']) {
    assert.equal(infoRequest(t, true), 'maintenance', t)
    assert.equal(infoRequest(t), null, t)
  }
  for (const t of ['予約したい', 'カットで']) {
    assert.equal(isMaintenanceBookingRequest(t, true), true, t)
    assert.equal(isMaintenanceBookingRequest(t), false, t)
  }
  assert.equal(infoRequest('次の予約をキャンセル', true), null)
  assert.equal(isMaintenanceBookingRequest('次の予約をキャンセル', true), false)
})
test('使える券', () => { for (const t of ['使える割引券ある？', 'クーポン何がある', 'チケット見せて']) assert.equal(infoRequest(t), 'tickets', t) })
test('予約の頼みは予約の流れへ（ここでは受けない）', () => {
  for (const t of ['メンテナンスカットを予約したい', '割引券を使って予約', '明日の15時', '予約をキャンセルしたい', 'いつものカットで', 'メンテカット']) assert.equal(infoRequest(t), null, t)
})
