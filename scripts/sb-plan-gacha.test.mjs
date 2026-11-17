// SR-12：SB のお支払い予定に、ガチャの無料券が会計と同じ額で入る
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planGachaOff } from '../src/sb/sbPlanGacha.ts'

const perm = { menu_code: 'perm-punch', price: 9000 }
const bmCodes = ['perm-punch', 'perm-iper']
const free = { amount: null, free_menu: 'パンチパーマ無料', menu_codes: ['perm-punch'] }

test('月曜の対象パーマ＋そのメニューの無料券：Black Monday 2,000円のあとの残り 7,000円 → 予定額 0円', () => {
  const off = planGachaOff(free, [perm], bmCodes, 2000)
  assert.equal(off, 7000)
  assert.equal(9000 - 2000 - off, 0)
})

test('通常日（Black Monday なし）：無料券で 9,000円 → 予定額 0円', () => {
  assert.equal(planGachaOff(free, [perm], bmCodes, 0), 9000)
})

test('定額券は今までどおりその額。対象外の明細だけなら金額は会計で（null）', () => {
  assert.equal(planGachaOff({ amount: 500, free_menu: null, menu_codes: ['perm-punch'] }, [perm], bmCodes, 2000), 500)
  assert.equal(planGachaOff(free, [{ menu_code: 'cut-standard', price: 4000 }], bmCodes, 2000), null)
})

test('Black Monday の対象外メニューの無料券は、そのメニューの料金をそのまま引く', () => {
  const shave = { amount: null, free_menu: '顔そり無料', menu_codes: ['shave-face'] }
  assert.equal(planGachaOff(shave, [perm, { menu_code: 'shave-face', price: 2500 }], bmCodes, 2000), 2500)
})

test('menu_codes の無い古いサーバーは、前と同じ free_menu で探す', () => {
  assert.equal(planGachaOff({ amount: null, free_menu: 'perm-punch' }, [perm], bmCodes, 2000), 7000)
})
