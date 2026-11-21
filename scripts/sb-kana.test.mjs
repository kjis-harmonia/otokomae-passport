// SB に出すお客様のフリガナ（11/21）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kanaOf, toKatakana } from '../src/sb/sbParty.ts'

test('ひらがな・半角カナは全角カタカナに', () => {
  assert.equal(toKatakana('たなか　たろう'), 'タナカ タロウ')
  assert.equal(toKatakana('ﾀﾅｶ ﾀﾛｳ'), 'タナカ タロウ')
})
test('台帳・HOT PEPPER のフリガナを出す', () => {
  assert.equal(kanaOf({ customer_name: '田中 太郎', customer_kana: 'タナカ タロウ', note: null }), 'タナカ タロウ')
})
test('分からない人・名前がカナの人は出さない', () => {
  assert.equal(kanaOf({ customer_name: '田中 太郎', customer_kana: null }), null)
  assert.equal(kanaOf({ customer_name: '田中 太郎', customer_kana: '  ' }), null)
  assert.equal(kanaOf({ customer_name: 'タナカ', customer_kana: 'たなか' }), null)
})
test('お連れ様の枠は出さない（台帳はご本人のもの）', () => {
  assert.equal(kanaOf({ customer_name: '田中 太郎', customer_kana: 'タナカ タロウ', note: 'お連れ様：鈴木様' }), null)
})
