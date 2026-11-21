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

// アプリ会員のフリガナ（会員登録・銀ちゃん）
import { isKana } from '../src/utils/kana.ts'
test('フリガナとして受け取れるのはカタカナ（ひらがなはカタカナにしてから）', () => {
  assert.equal(isKana(toKatakana('たなか たろう')), true)
  assert.equal(isKana(toKatakana('ヴォーン・ジョー')), true)
  assert.equal(isKana(toKatakana('田中 たろう')), false)
  assert.equal(isKana(toKatakana('tanaka')), false)
  assert.equal(isKana(''), false)
  assert.equal(isKana('ア'.repeat(41)), false)
})
