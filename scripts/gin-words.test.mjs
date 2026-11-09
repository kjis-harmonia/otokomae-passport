import { test } from 'node:test'
import assert from 'node:assert/strict'
import { longestIn, namesIn } from '../src/v2/ginWords.ts'

const people = [{ name: '試験お連れ様' }, { name: '試験お連れ様太郎' }, { name: '朔耶' }]
const n = (p) => p.name.replace(/(さん|様|ちゃん|くん|君)$/, '')
const names = (t) => namesIn(t, people, n).map(p => p.name)

test('長い名前の人だけを選んだら、その人だけ（短い名前の別の人は入れない）', () => {
  assert.deepEqual(names('試験お連れ様太郎さんだけ'), ['試験お連れ様太郎'])
})

test('短い名前の人だけを選んだら、その人だけ', () => {
  assert.deepEqual(names('試験お連れ様さんだけ'), ['試験お連れ様'])
})

test('2人とも名前を書いたら、2人とも', () => {
  assert.deepEqual(names('試験お連れ様と試験お連れ様太郎'), ['試験お連れ様', '試験お連れ様太郎'])
})

test('関係ない名前は選ばない', () => {
  assert.deepEqual(names('朔耶だけ'), ['朔耶'])
  assert.deepEqual(names('こんにちは'), [])
})

test('メニューは、いちばん長く一致したものを選ぶ（セットを頼んだのに単品にしない）', () => {
  const menus = [{ name: 'スペインパーマ' }, { name: 'スペインパーマ&メッシュ' }, { name: '通常カット' }]
  assert.equal(longestIn('スペインパーマ&メッシュでお願い', menus, m => m.name)?.name, 'スペインパーマ&メッシュ')
  assert.equal(longestIn('スペインパーマにする', menus, m => m.name)?.name, 'スペインパーマ')
  assert.equal(longestIn('おまかせで', menus, m => m.name), null)
})
