// JOHNNY 予約アシスタントの回帰テスト（決まった規則の部分だけ。DB・ブラウザは使わない）
//   node scripts/johnny-booking-regression.mjs
import assert from 'node:assert/strict'
import { parseVisitRequest, parseYesNo, isEmptyRequest } from '../src/features/johnny/visitParser.ts'
import { matchMenu } from '../src/features/johnny/menuMatcher.ts'
import { planOffer } from '../src/features/johnny/slotPlanner.ts'
import { orderMenuSuggestions, presentMenuChoices } from '../src/features/johnny/menuPresentation.ts'

// 2026-10-15（木）10:00 日本時間
const NOW = new Date('2026-10-15T01:00:00Z')
let passed = 0
function check(name, fn) {
  try { fn(); passed++ } catch (err) { console.error(`✗ ${name}`); throw err }
}
const p = text => parseVisitRequest(text, NOW)

// ── 日付 ──
check('今日', () => assert.deepEqual(p('今日').dates, ['2026-10-15']))
check('明日の15:00', () => { const r = p('明日の15:00'); assert.deepEqual(r.dates, ['2026-10-16']); assert.equal(r.time, '15:00') })
check('今日、または明日の15:00', () => { const r = p('今日、または明日の15:00'); assert.deepEqual(r.dates, ['2026-10-15', '2026-10-16']); assert.equal(r.time, '15:00') })
check('あさって', () => assert.deepEqual(p('あさって').dates, ['2026-10-17']))
check('明後日は明日を含まない', () => assert.deepEqual(p('明後日の夕方').dates, ['2026-10-17']))
check('土曜（今週）', () => assert.deepEqual(p('土曜日の3時').dates, ['2026-10-17']))
check('木曜（今日）', () => assert.deepEqual(p('木曜').dates, ['2026-10-15']))
check('来週の土曜', () => assert.deepEqual(p('来週の土曜').dates, ['2026-10-24']))
check('来週の月曜', () => assert.deepEqual(p('来週の月曜').dates, ['2026-10-19']))
check('10月20日', () => assert.deepEqual(p('10月20日 14時').dates, ['2026-10-20']))
check('10/20', () => assert.deepEqual(p('10/20の15:30').dates, ['2026-10-20']))
check('20日（今月）', () => assert.deepEqual(p('20日').dates, ['2026-10-20']))
check('3日（過ぎたので来月）', () => assert.deepEqual(p('3日').dates, ['2026-11-03']))
check('9月1日（過ぎたので来年）', () => assert.deepEqual(p('9月1日').dates, ['2027-09-01']))
check('週末（土日）', () => assert.deepEqual(p('週末').dates, ['2026-10-17', '2026-10-18']))
check('土日', () => assert.deepEqual(p('土日の夕方').dates, ['2026-10-17', '2026-10-18']))
check('どにち（かな）', () => assert.deepEqual(p('どにち').dates, ['2026-10-17', '2026-10-18']))
check('来週末', () => assert.deepEqual(p('来週末').dates, ['2026-10-24', '2026-10-25']))
check('3日後（3日ではない）', () => assert.deepEqual(p('3日後の15時').dates, ['2026-10-18']))
check('今度の土曜', () => assert.deepEqual(p('今度の土曜').dates, ['2026-10-17']))
check('次の木曜（今日が木曜→来週）', () => assert.deepEqual(p('次の木曜').dates, ['2026-10-22']))
check('明日以降（1週間）', () => { const d = p('明日以降で').dates; assert.equal(d.length, 7); assert.equal(d[0], '2026-10-16'); assert.equal(d[6], '2026-10-22') })
check('10/20か21', () => assert.deepEqual(p('10/20か21の夕方').dates, ['2026-10-20', '2026-10-21']))
check('10月20日か21日', () => assert.deepEqual(p('10月20日か21日').dates, ['2026-10-20', '2026-10-21']))
check('15時台', () => { const r = p('明日の15時台'); assert.equal(r.time, null); assert.deepEqual(r.range, { from: '15:00', to: '15:59' }) })
check('15時から17時の間', () => assert.deepEqual(p('15時から17時の間').range, { from: '15:00', to: '17:00' }))
check('3時から5時（午後）', () => assert.deepEqual(p('3時から5時まで').range, { from: '15:00', to: '17:00' }))
check('午後イチ', () => { const r = p('明日の午後イチ'); assert.deepEqual(r.range, { from: '13:00', to: '14:00' }); assert.equal(r.earliest, true) })
check('ごごいち（かな）', () => assert.deepEqual(p('あしたのごごいち').range, { from: '13:00', to: '14:00' }))
check('朝イチ', () => assert.deepEqual(p('土曜の朝一').range, { from: '09:00', to: '11:00' }))
check('お昼過ぎ', () => assert.deepEqual(p('明日のお昼過ぎ').range, { from: '13:00', to: '15:00' }))
check('夕方以降', () => assert.deepEqual(p('夕方以降').range, { from: '15:00', to: '23:59' }))
check('はい（文の途中）', () => assert.equal(parseYesNo('えっと、はいお願いします'), true))
check('それでお願いします', () => assert.equal(parseYesNo('それでお願いします'), true))
check('間違いないです', () => assert.equal(parseYesNo('間違いないです'), true))
check('別の日（いいえ）', () => assert.equal(parseYesNo('いや、別の日がいい'), false))
check('違う時間で（いいえ）', () => assert.equal(parseYesNo('違う時間で'), false))
check('ひらがな あした', () => assert.deepEqual(p('あしたの さんじ').dates, ['2026-10-16']))
check('全角数字', () => assert.equal(p('明日の１５：００').time, '15:00'))

// ── 時刻 ──
check('15時', () => assert.equal(p('明日15時').time, '15:00'))
check('3時は午後', () => assert.equal(p('明日の3時').time, '15:00'))
check('3時半', () => assert.equal(p('3時半').time, '15:30'))
check('午前10時', () => assert.equal(p('午前10時').time, '10:00'))
check('10時は午前のまま', () => assert.equal(p('10時').time, '10:00'))
check('午後3時15分', () => assert.equal(p('午後3時15分').time, '15:15'))
check('十五時（漢数字）', () => assert.equal(p('明日の十五時').time, '15:00'))
check('三時半（漢数字）', () => assert.equal(p('三時半').time, '15:30'))
check('さんじ（ひらがな）', () => assert.equal(p('さんじ').time, '15:00'))
check('18時以降', () => { const r = p('明日の18時以降'); assert.equal(r.time, null); assert.deepEqual(r.range, { from: '18:00', to: '23:59' }) })
check('12時まで', () => assert.deepEqual(p('12時まで').range, { from: '00:00', to: '12:00' }))
check('夕方', () => assert.deepEqual(p('明日の夕方').range, { from: '15:00', to: '18:00' }))
check('夜', () => assert.deepEqual(p('今日の夜').range, { from: '18:00', to: '21:00' }))
check('一番早い', () => assert.equal(p('一番早いところで').earliest, true))
check('読めない', () => assert.equal(isEmptyRequest(p('うーん')), true))
check('「じゃあ」は時刻にならない', () => assert.equal(p('じゃあ明日').time, null))

// ── はい／いいえ ──
check('はい', () => assert.equal(parseYesNo('はい、お願いします'), true))
check('うん', () => assert.equal(parseYesNo('うん'), true))
check('いいえ', () => assert.equal(parseYesNo('いいえ'), false))
check('違います', () => assert.equal(parseYesNo('違います'), false))
check('どちらでもない', () => assert.equal(parseYesNo('明日'), null))

// ── メニュー ──
const MENUS = [
  { code: 'cut', name: 'カット', duration_min: 60, price: 5500 },
  { code: 'nurepan', name: '濡れパン', duration_min: 120, price: 12000 },
  { code: 'punch', name: 'パンチパーマ', duration_min: 120, price: 11000 },
  { code: 'maint', name: 'メンテナンスカット', duration_min: 30, price: 3300 },
]
check('ぬれぱん', () => assert.equal(matchMenu('ぬれぱんで', MENUS)?.code, 'nurepan'))
check('パンチ', () => assert.equal(matchMenu('パンチお願い', MENUS)?.code, 'punch'))
check('メンテ', () => assert.equal(matchMenu('メンテで', MENUS)?.code, 'maint'))
check('カット（メンテナンスカットより短い名前）', () => assert.equal(matchMenu('カットだけ', MENUS)?.code, 'cut'))
check('不明', () => assert.equal(matchMenu('なんでもいい', MENUS), null))

// ── 空き枠からの提案 ──
const at = hm => `2026-10-16T${hm}:00+09:00`
const slots = { '2026-10-16': ['10:00', '14:30', '16:00', '18:00'].map(hm => ({ starts_at: at(hm) })) }
check('ちょうど空いている', () => {
  const o = planOffer({ dates: ['2026-10-16'], time: '14:30', range: null, earliest: false }, slots)
  assert.equal(o.kind, 'exact'); assert.equal(o.slots[0].starts_at, at('14:30'))
})
check('埋まっていれば近い順（後ろ優先）', () => {
  const o = planOffer({ dates: ['2026-10-16'], time: '15:00', range: null, earliest: false }, slots)
  assert.equal(o.kind, 'nearby'); assert.deepEqual(o.slots.map(s => s.starts_at), [at('14:30'), at('16:00'), at('18:00')])
})
check('時間帯の中の最初', () => {
  const o = planOffer({ dates: ['2026-10-16'], time: null, range: { from: '15:00', to: '18:00' }, earliest: false }, slots)
  assert.equal(o.kind, 'choices'); assert.equal(o.slots[0].starts_at, at('16:00'))
})
check('候補日の2日目で一致', () => {
  const two = { '2026-10-15': [], '2026-10-16': slots['2026-10-16'] }
  const o = planOffer({ dates: ['2026-10-15', '2026-10-16'], time: '16:00', range: null, earliest: false }, two)
  assert.equal(o.kind, 'exact'); assert.equal(o.slots[0].starts_at, at('16:00'))
})
check('空きなし', () => assert.equal(planOffer({ dates: ['2026-10-15'], time: '15:00', range: null, earliest: false }, { '2026-10-15': [] }).kind, 'none'))

// ── 電話番号 ──
const { normalizePhone, formatPhone } = await import('../src/utils/phone.ts')
check('携帯（ハイフン）', () => assert.equal(normalizePhone('090-1234-5678'), '09012345678'))
check('全角', () => assert.equal(normalizePhone('０８０ １２３４ ５６７８'), '08012345678'))
check('+81', () => assert.equal(normalizePhone('+81 90 1234 5678'), '09012345678'))
check('固定電話10桁', () => assert.equal(normalizePhone('092-123-4567'), '0921234567'))
check('桁不足', () => assert.equal(normalizePhone('090-1234'), null))
check('0始まりでない', () => assert.equal(normalizePhone('9012345678'), null))
check('表示形式', () => assert.equal(formatPhone('09012345678'), '090-1234-5678'))

console.log(`johnny booking regression: ${passed} checks ok`)

// ── 質問・相談の見分け ──
const { detectAsk, answerMenuInfo } = await import('../src/features/johnny/askIntent.ts')
const M2 = [
  { code: 'punch', name: 'パンチパーマ', duration_min: 120, price: 8000 },
  { code: 'color', name: 'ヘアカラー', duration_min: 60, price: 4000 },
  { code: 'fade', name: 'スキンフェードカット', duration_min: 60, price: 5000 },
]
check('パンチ何分', () => { const a = detectAsk('パンチって何分かかる？', M2); assert.equal(a.kind, 'menu_info'); assert.equal(answerMenuInfo(a), 'パンチパーマは、だいたい120分です。') })
check('カラーいくら', () => assert.equal(answerMenuInfo(detectAsk('カラーいくら', M2)), 'ヘアカラーは4,000円です。'))
check('時間と料金', () => assert.equal(answerMenuInfo(detectAsk('スキンフェードの値段と何分くらい', M2)), 'スキンフェードカットは、だいたい60分、5,000円です。'))
check('似合うパーマは相談', () => assert.equal(detectAsk('今こんな感じだけど、どんなパーマが似合うかな', M2).kind, 'consult'))
check('おすすめは相談', () => assert.equal(detectAsk('おすすめは？', M2).kind, 'consult'))
check('メニュー不明の時間質問は相談', () => assert.equal(detectAsk('どのくらいかかる？', M2).kind, 'consult'))
check('普通の予約は質問ではない', () => assert.equal(detectAsk('明日の15時でパンチ', M2), null))
check('「はい」は質問ではない', () => assert.equal(detectAsk('はい、お願いします', M2), null))
console.log(`ask intent: ok (total ${passed})`)

// Exercise the actual input callbacks without a browser, DB, or AI request.
const { readFileSync } = await import('node:fs')
const vm = await import('node:vm')
const ts = await import('typescript')
const componentSource = readFileSync(new URL('../src/features/johnny/JohnnyBookingAssistant.tsx', import.meta.url), 'utf8')
const componentAst = ts.createSourceFile('JohnnyBookingAssistant.tsx', componentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function initializer(name) {
  let found
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(componentAst)
  assert.ok(found, `missing production declaration: ${name}`)
  return found
}
function voiceHarness(heard, initial = { k: 'askWhen' }, hasAnswer = true) {
  const state = { step: initial, converted: 0, legacy: 0, bookings: 0 }
  const skinStep = { k: 'ai', say: 'スキンフェードの空き', view: { kind: 'slots', menu: { code: 'skin' }, slots: [] } }
  const context = vm.createContext({
    stepRef: { current: initial }, aiOnRef: { current: true }, turnsRef: { current: [] },
    setStep: step => { state.step = step }, setHeard: () => {}, setVoiceNote: () => {},
    takeAiTurn: () => true, shownFor: () => undefined,
    api: { agentVoice: async () => ({ heard, answer: hasAnswer ? { say: '元のAIの案内' } : null }) },
    stepFromAgent: async () => { state.converted++; return skinStep },
    legacyRef: { current: () => { state.legacy++ } },
    parseYesNo, COMPANION_WORDS: /お連れ|息子/,
    book: () => { state.bookings++ }, cancelReservation: () => { throw new Error('unexpected cancellation') },
  })
  const declarations = ['AI_STEPS', 'handleText', 'handleAudio'].map(name => {
    const node = initializer(name)
    const expression = name === 'AI_STEPS' ? node : node.arguments[0]
    return `globalThis.${name} = ${expression.getText(componentAst)};`
  }).join('\n')
  const compiled = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInContext(compiled, context)
  return { state, context, run: () => context.handleAudio({}) }
}
for (const heard of ['メンテナンス。', 'メンテナンスカットで', 'めんてで']) {
  const h = voiceHarness(heard)
  await h.run()
  check(`voice maintenance route: ${heard}`, () => {
    assert.equal(h.state.step.view.kind, 'maintenance')
    assert.match(h.state.step.say, /メンテナンスカット/)
    assert.equal(h.state.converted, 0)
    assert.equal(h.state.legacy, 0)
    assert.equal(h.state.bookings, 0)
    assert.equal(h.context.turnsRef.current.length, 0)
    const text = voiceHarness(heard)
    text.context.handleText(heard)
    assert.equal(JSON.stringify(h.state.step), JSON.stringify(text.state.step))
  })
}
const maintenanceWithoutAi = voiceHarness('メンテナンスカット', { k: 'askWhen' }, false)
await maintenanceWithoutAi.run()
check('voice maintenance still routes when AI answer is absent', () => {
  assert.equal(maintenanceWithoutAi.state.step.view.kind, 'maintenance')
  assert.equal(maintenanceWithoutAi.state.legacy, 0)
})
const ordinaryVoice = voiceHarness('スキンフェードで')
await ordinaryVoice.run()
check('ordinary voice keeps the AI response path and the displayed conversation', () => {
  assert.equal(ordinaryVoice.state.converted, 1)
  assert.equal(ordinaryVoice.context.turnsRef.current.at(-1).text, ordinaryVoice.state.step.say)
})
const confirmationVoice = voiceHarness('はい', { k: 'confirm', menu: { code: 'skin' }, slot: {}, req: {} })
await confirmationVoice.run()
check('voice confirmation still uses the explicit confirmation handler', () => {
  assert.equal(confirmationVoice.state.bookings, 1)
  assert.equal(confirmationVoice.state.converted, 0)
})
console.log(`voice routing: ok (total ${passed})`)

const suggestedMenus = [
  { code: 'shave', name: '顔そり男性', duration_min: 30, price: 2000 },
  { code: 'nurepan', name: '濡れパン', duration_min: 120, price: 8000 },
  { code: 'cut-regular', name: '通常カット', duration_min: 45, price: 4000 },
  { code: 'fade', name: 'スキンフェードカット', duration_min: 60, price: 5000 },
  { code: 'cut-shave', name: 'カット＋顔そり', duration_min: 60, price: 5000 },
]
const codes = menus => menus.map(m => m.code)
const originalMenus = JSON.stringify(suggestedMenus)
check('no history: haircut leads, standalone shaving is not promoted', () => {
  assert.deepEqual(codes(orderMenuSuggestions(suggestedMenus, null)), ['cut-regular', 'fade', 'nurepan', 'cut-shave', 'shave'])
  assert.equal(JSON.stringify(suggestedMenus), originalMenus)
})
check('previous hair menu leads without selecting it automatically', () => {
  assert.equal(orderMenuSuggestions(suggestedMenus, 'nurepan')[0].code, 'nurepan')
})
check('previous standalone shave does not displace hair menus', () => {
  assert.equal(orderMenuSuggestions(suggestedMenus, 'shave')[0].code, 'cut-regular')
})
const choices = suggestedMenus.map(menu => ({ menu, first: menu.code === 'nurepan' ? '2026-10-21T11:30:00+09:00' : '2026-10-21T08:00:00+09:00' }))
const label = iso => `明日${iso.slice(11, 16)}`
check('narration and visible choices use the same ranking and returned times', () => {
  const reply = presentMenuChoices(choices, 'fade', label)
  assert.equal(reply.items[0].menu.code, 'fade')
  assert.ok(reply.say.startsWith('スキンフェードカットなら明日08:00から'))
  assert.match(reply.say, /濡れパンなら明日11:30から/)
  assert.doesNotMatch(reply.say, /顔そり/)
  assert.equal(reply.items.at(-1).menu.code, 'shave')
  assert.equal(reply.items.find(item => item.menu.code === 'nurepan').first, choices[1].first)
})
check('absent or invalid slot evidence is not narrated as available', () => {
  const reply = presentMenuChoices([{ menu: suggestedMenus[2], first: null }, { menu: suggestedMenus[3], first: 'invalid' }], null, () => { throw new Error('invalid slot narrated') })
  assert.doesNotMatch(reply.say, /空き|から|ご案内できます/)
})
const menuContext = vm.createContext({
  options: { menus: suggestedMenus }, lastMenuCode: 'fade', myReservations: [],
  presentMenuChoices, dayWord: () => '明日', slotDate: iso => iso.slice(0, 10), spokenTime: iso => iso.slice(11, 16),
})
const converter = ts.transpileModule(`globalThis.convert = ${initializer('stepFromAgent').arguments[0].getText(componentAst)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
vm.runInContext(converter, menuContext)
const overviewStep = await menuContext.convert({ say: '顔そり男性がおすすめです', ui: { type: 'menus', date: '2026-10-21', items: choices.map(item => ({ menu_code: item.menu.code, first_time: item.first })) } })
check('actual menu-response handler replaces the unsolicited shaving recommendation', () => {
  assert.equal(overviewStep.view.items[0].menu.code, 'fade')
  assert.doesNotMatch(overviewStep.say, /顔そり/)
  assert.ok(overviewStep.say.startsWith('スキンフェードカット'))
})
const shavingStep = await menuContext.convert({ say: '顔そりの空きです', ui: { type: 'slots', menu_code: 'shave', staff_id: null, times: [choices[0].first] } })
check('explicit shaving requests keep their own slot and confirmation flow', () => {
  assert.equal(shavingStep.view.menu.code, 'shave')
  assert.equal(shavingStep.say, '顔そりの空きです')
})
const emptyStep = await menuContext.convert({ say: '空いています', ui: { type: 'menus', date: '2026-10-21', items: [] } })
check('empty AI choices are rejected instead of claiming availability', () => assert.equal(emptyStep, null))
console.log(`menu presentation: ok (total ${passed})`)
