import assert from 'node:assert/strict'
import { test } from 'node:test'
import { infoRequest } from '../src/features/johnny/infoRequest.ts'

// Johnny V2.0 の「答えるだけ」：予約の言葉と取り違えない
test('会員QR', () => { for (const t of ['会員QRを出して', 'QR見せて', '会員証', '男前証出して']) assert.equal(infoRequest(t), 'qr', t) })
test('銀Pay の残高', () => { for (const t of ['銀Payの残高は？', '銀ペイいくら残っとる', '残高教えて']) assert.equal(infoRequest(t), 'ginpay', t) })
test('次のメンテナンス', () => { for (const t of ['次のメンテナンスはいつ？', 'メンテまで何日', 'そろそろメンテ？']) assert.equal(infoRequest(t), 'maintenance', t) })
test('使える券', () => { for (const t of ['使える割引券ある？', 'クーポン何がある', 'チケット見せて']) assert.equal(infoRequest(t), 'tickets', t) })
test('予約の頼みは予約の流れへ（ここでは受けない）', () => {
  for (const t of ['メンテナンスカットを予約したい', '割引券を使って予約', '明日の15時', '予約をキャンセルしたい', 'いつものカットで', 'メンテカット']) assert.equal(infoRequest(t), null, t)
})
