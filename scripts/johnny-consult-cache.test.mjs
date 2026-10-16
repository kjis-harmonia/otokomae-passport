// 実際の OpenAI/Supabase を呼ばず、課金リクエスト数をカウンタで検証。
import assert from 'node:assert/strict'
import { createConsultCache } from '../src/features/johnny/consultCache.ts'

const menus = [{ code: 'cut', name: 'カット', duration_min: 60, price: 5500 }]
const request = { session: 'customer-a', message: '髪型の相談', menus }
let clock = 0
let calls = 0
let release
const consult = createConsultCache(async () => {
  calls++
  await new Promise(resolve => { release = resolve })
  return { reply: '髪型のご相談ですね。', menuCodes: ['cut'] }
}, () => clock)
const a = consult(request)
const b = consult({ ...request, message: ' 髪型の相談 ' })
await Promise.resolve()
assert.equal(calls, 1, '同時に同じ相談を送っても外部リクエストは1回')
release()
const [first, second] = await Promise.all([a, b])
assert.deepEqual(first, second)
first.menuCodes.push('mutation')
assert.deepEqual((await consult(request)).menuCodes, ['cut'], '返事の変更でキャッシュが壊れない')
assert.equal(calls, 1, '5分以内の再質問はキャッシュ')

async function runChanged(next) {
  const task = consult(next)
  await Promise.resolve()
  release()
  return task
}
await runChanged({ ...request, session: 'customer-b' })
assert.equal(calls, 2, '顧客が違えば返事を共有しない')
await runChanged({ ...request, menus: [{ ...menus[0], price: 6000 }] })
assert.equal(calls, 3, 'マスターの更新を反映')
clock = 5 * 60_000
await runChanged(request)
assert.equal(calls, 4, '5分後は古い返事を使わない')

let failures = 0
const retry = createConsultCache(async () => { failures++; return null })
await retry(request); await retry(request)
assert.equal(failures, 2, '失敗はキャッシュせず次の明示操作で再試行できる')
await retry({ ...request, message: '  ' })
assert.equal(failures, 2, '空の相談は外部に送らない')
const throwing = createConsultCache(async () => { throw new Error('offline') })
assert.equal(await throwing(request), null, '通信例外はローカルの案内に切り替える')

let boundedCalls = 0
const bounded = createConsultCache(async () => { boundedCalls++; return { reply: '返事', menuCodes: [] } })
for (let i = 0; i < 11; i++) await bounded({ ...request, message: `相談${i}` })
await bounded({ ...request, message: '相談0' })
assert.equal(boundedCalls, 12, '最大10件を超えた返事は保持しない')
console.log('johnny consult cache: 11 checks ok; real OpenAI calls: 0')
