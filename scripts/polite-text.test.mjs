import { test } from 'node:test'
import assert from 'node:assert/strict'
import { politeText } from '../src/v2/politeText.ts'

test('広島弁の語尾をていねい語にする', () => {
  assert.equal(politeText('短めがええですね。お店で確認しますけぇね。'), '短めがいいですね。お店で確認しますね。')
  assert.equal(politeText('空いとります'), '空いています')
  assert.equal(politeText('パーマもできるけぇ、安心してください'), 'パーマもできるから、安心してください')
})

test('ふつうの文は変えない', () => {
  const s = 'アイパー ¥8,000 はいかがですか？'
  assert.equal(politeText(s), s)
})
