// 銀二郎SB「話して予約登録」の読み取りの回帰テスト（DB・ブラウザは使わない）
//   node scripts/sb-command-regression.mjs
import assert from 'node:assert/strict'
import { parseSbCommand } from '../src/sb/sbCommand.ts'

const NOW = new Date('2026-10-15T01:00:00Z') // 2026-10-15（木）10:00 日本時間
const STAFF = [{ id: 'g', name: '銀二郎' }, { id: 't', name: 'テイテイ' }]
const MENUS = [
  { code: 'cut', name: 'カット', duration_min: 60, price: 5500 },
  { code: 'shave', name: 'シェービング', duration_min: 30, price: 2200 },
  { code: 'punch', name: 'パンチパーマ', duration_min: 120, price: 12100 },
  { code: 'ginpara', name: '銀パラ', duration_min: 180, price: 15000 },
  { code: 'maint', name: 'メンテナンスカット', duration_min: 30, price: 3300 },
]
let passed = 0
function check(name, fn) { try { fn(); passed++ } catch (err) { console.error(`✗ ${name}`); throw err } }
const p = text => parseSbCommand(text, STAFF, MENUS, NOW)

check('基本の1文', () => {
  const d = p('明日15時 田中さん パンチ 銀二郎で')
  assert.equal(d.date, '2026-10-16'); assert.equal(d.minutes, 15 * 60); assert.equal(d.customerName, '田中')
  assert.deepEqual(d.menuCodes, ['punch']); assert.equal(d.staffId, 'g')
})
check('フルネーム（空白あり）', () => assert.equal(p('鈴木 次郎さん 明日10時 カット').customerName, '鈴木 次郎'))
check('前の語がメニューなら姓にしない', () => assert.equal(p('パンチ 田中さん').customerName, '田中'))
check('日付の語を姓にしない', () => assert.equal(p('明日 佐藤様 カット').customerName, '佐藤'))
check('担当の名前はお客様にしない', () => assert.equal(p('銀二郎さんで 明日 カット').customerName, null))
check('メニュー複数', () => assert.deepEqual(p('明日15時 山田さん カットとシェービング').menuCodes, ['cut', 'shave']))
check('担当名に引っぱられない（銀パラ）', () => { const d = p('土曜13時 木村さん 銀パラ テイテイ'); assert.deepEqual(d.menuCodes, ['ginpara']); assert.equal(d.staffId, 't') })
check('指名なし', () => { const d = p('明日 中村さん メンテ フリー'); assert.equal(d.staffId, null); assert.ok(d.understood.includes('担当')) })
check('担当を言わない', () => { const d = p('明日 中村さん メンテ'); assert.equal(d.staffId, null); assert.ok(!d.understood.includes('担当')) })
check('メンテ→メンテナンスカット', () => assert.deepEqual(p('明日 中村さん メンテ').menuCodes, ['maint']))
check('電話番号', () => assert.equal(p('明日15時 田中さん 090-1234-5678 カット').phone, '09012345678'))
check('日付なし→今日', () => { const d = p('15時 田中さん カット'); assert.equal(d.date, '2026-10-15'); assert.equal(d.minutes, 900) })
check('時間帯なら最初の時刻', () => assert.equal(p('明日の夕方 田中さん カット').minutes, 15 * 60))
check('時刻なし', () => assert.equal(p('明日 田中さん カット').minutes, null))
check('ホットペッパー＋予約番号', () => { const d = p('ホットペッパー BE12345678 明日11時 佐藤さん カット'); assert.equal(d.source, 'hotpepper'); assert.equal(d.externalRef, 'BE12345678') })
check('電話予約', () => assert.equal(p('電話で 明日11時 佐藤さん カット').source, 'phone'))
check('音声のかな', () => { const d = p('あしたのさんじ たなかさん ぱんち'); assert.equal(d.minutes, 15 * 60); assert.deepEqual(d.menuCodes, ['punch']); assert.equal(d.customerName, 'たなか') })
// 音声認識は空白なしで返す
check('空白なし：日付時刻メニュー名前', () => {
  const d = p('明日15時スキンフェード田中さん')
  assert.equal(d.customerName, '田中'); assert.equal(d.minutes, 15 * 60); assert.equal(d.date, '2026-10-16')
})
check('空白なし：名前の後ろにメニューと担当', () => {
  const d = p('明日15時田中さんパンチ銀二郎で')
  assert.equal(d.customerName, '田中'); assert.deepEqual(d.menuCodes, ['punch']); assert.equal(d.staffId, 'g')
})
check('空白なし：の・で が入る', () => assert.equal(p('明日の15時に銀二郎で田中さんのカット').customerName, '田中'))
check('空白なし：かなの時刻（さんじ）を敬称にしない', () => {
  const d = p('あしたのさんじたなかさんぱんち'); assert.equal(d.customerName, 'たなか'); assert.equal(d.minutes, 15 * 60)
})
check('空白なし：フルネーム', () => assert.equal(p('土曜日13時銀パラ鈴木太郎様').customerName, '鈴木太郎'))
check('読み取れた項目', () => assert.deepEqual(p('明日15時 田中さん パンチ 銀二郎で').understood, ['日付', '時刻', 'お客様', '担当', 'メニュー']))

console.log(`sb command regression: ${passed} checks ok`)
