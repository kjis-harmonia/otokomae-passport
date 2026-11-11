import { test } from 'node:test'
import assert from 'node:assert/strict'
import { companionNameOf } from '../src/utils/companionName.ts'

// 11/11 店舗端末点検：お連れ様の会計の見出し・Welcome 券・お客様ごとの料金の判定
test('お連れ様の予約のメモからお名前', () => {
  assert.equal(companionNameOf({ note: 'お連れ様：次郎様' }), '次郎')
  assert.equal(companionNameOf({ note: 'メモ\nお連れ様：花子様' }), '花子')
})
test('ご本人の予約・予約なしは null', () => {
  assert.equal(companionNameOf({ note: '駐車場あり' }), null)
  assert.equal(companionNameOf({ note: null }), null)
  assert.equal(companionNameOf(null), null)
})
