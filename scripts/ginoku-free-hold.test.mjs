// 銀オクの無料券（その明細1つ分を引く・DB の finalize_sale と同じ割り当て）と、押さえ・券の決まりの言葉
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freeTicketAmounts, freeTicketLabel, freeTicketValue, isFreeTicket } from '../src/features/auction/freeTicket.ts'
import { holdNote, ticketRule } from '../src/features/auction/auctionLogic.ts'

const ginpara = (id) => ({ id, free_menu: '銀パラ', menu_codes: ['perm-ginpara-curly'] })
const line = (ref_id, unit_price, quantity = 1, discount = 0, source = 'service_menu') => ({ source, ref_id, unit_price, quantity, discount })

test('無料券かどうか・書き方', () => {
  assert.equal(isFreeTicket(ginpara('a')), true)
  assert.equal(isFreeTicket({ menu_codes: null }), false)
  assert.equal(isFreeTicket({ menu_codes: [] }), false)
  assert.equal(isFreeTicket({}), false)
  assert.equal(freeTicketLabel(ginpara('a')), '銀パラ無料')
})

test('お会計：そのメニューの明細1つ分（明細の値引きのあと）。メニューが無ければ使えない', () => {
  const lines = [line('perm-ginpara-curly', 15000), line(undefined, 1000, 1, 0, 'manual')]
  assert.equal(freeTicketAmounts(lines, [ginpara('a')]).get('a'), 15000)
  assert.equal(freeTicketAmounts([line('perm-ginpara-curly', 15000, 1, 2000)], [ginpara('a')]).get('a'), 13000)
  assert.equal(freeTicketAmounts([line('cut-basic', 4000)], [ginpara('a')]).get('a'), null)
  // 手入力の明細は対象にしない
  assert.equal(freeTicketAmounts([line('perm-ginpara-curly', 15000, 1, 0, 'manual')], [ginpara('a')]).get('a'), null)
})

test('1つの明細を2枚では引かない（数量2なら2枚とも）', () => {
  const two = freeTicketAmounts([line('perm-ginpara-curly', 15000)], [ginpara('b'), ginpara('a')])
  assert.equal(two.get('a'), 15000)
  assert.equal(two.get('b'), null)
  const qty2 = freeTicketAmounts([line('perm-ginpara-curly', 15000, 2)], [ginpara('b'), ginpara('a')])
  assert.deepEqual([qty2.get('a'), qty2.get('b')], [15000, 15000])
})

test('ガチャ券が同じ明細を使っていれば、その分を引いた残り', () => {
  const lines = [line('perm-ginpara-curly', 15000)]
  assert.equal(freeTicketAmounts(lines, [ginpara('a')], { lineIndex: 0, amount: 15000 }).get('a'), null)
  assert.equal(freeTicketAmounts(lines, [ginpara('a')], { lineIndex: 0, amount: 1000 }).get('a'), 14000)
})

test('予約の見込み：そのメニューなら料金ぶん、ほかは 0', () => {
  assert.equal(freeTicketValue(ginpara('a'), 'perm-ginpara-curly', 15000), 15000)
  assert.equal(freeTicketValue(ginpara('a'), 'cut-basic', 4000), 0)
  assert.equal(freeTicketValue({ menu_codes: null }, 'perm-ginpara-curly', 15000), 0)
})

test('券の決まりの一行と、押さえの一言', () => {
  assert.equal(ticketRule({ free_menu: '銀パラ', ticket_amount: null, weekday_only: true, ticket_days: 30 }), '銀パラのお会計が無料・平日のみ・30日間有効')
  assert.equal(ticketRule({ free_menu: null, ticket_amount: 500, weekday_only: true, ticket_days: 30 }), 'お会計から500円引き・平日のみ・30日間有効')
  assert.equal(ticketRule({ ticket_amount: 9000, weekday_only: false, ticket_days: 14 }), 'お会計から9,000円引き・曜日を問わず・14日間有効')
  assert.equal(holdNote(6300), '6,300 銀Payで入札中です')
})
