import { test } from 'node:test'
import assert from 'node:assert/strict'
import { phrasesOf } from '../src/v2/phrases.ts'

const has = (t, chunk) => assert.ok(phrasesOf(t).includes(chunk), `${JSON.stringify(phrasesOf(t))} に「${chunk}」が無い`)

test('語の途中で割らない（11/11 iPhone の「よろ／しいですか」）', () => {
  has('いつ頃がよろしいですか？', 'よろしいですか？')
  has('いつ頃がよろしいですか？', 'いつ頃が')
})

test('数と単位・金額・カタカナの名前はひとつのまとまり', () => {
  has('10月27日はパンチパーマでしたね！', '10月')
  has('10月27日はパンチパーマでしたね！', 'パンチパーマでしたね！')
  has('ご本人：通常カット ¥4,000（担当：テイテイ）', 'テイテイ）')
  assert.ok(phrasesOf('通常カット ¥4,000').some(p => p.includes('¥4,000')))
})

test('つなげても元の文と同じ（文字を足したり消したりしない）', () => {
  for (const t of ['ご来店は、', 'こちらでよろしければ【この内容で予約する】を押してください。', '※ガチャ券（100円引き）は、平日のご予約で使えます。', ''])
    assert.equal(phrasesOf(t).join(''), t)
})

test('時刻と金額は途中で割らない（11/18 iPhone の「10:／00」）', () => {
  const t = '変更前：11月21日（土） 10:00 濡れパン ¥8,000'
  assert.ok(phrasesOf(t).some(p => p.includes('10:00')), JSON.stringify(phrasesOf(t)))
  assert.ok(phrasesOf(t).some(p => p.includes('¥8,000')), JSON.stringify(phrasesOf(t)))
  assert.ok(phrasesOf('Black Monday割引（−2,000円）を適用します。').some(p => p.includes('2,000円')))
  assert.equal(phrasesOf(t).join(''), t)
})
