// Node 24+。DB・決済・OpenAIには接続しない。実際の会計再試行コントローラを検査する。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readCheckoutAttempt, settleCheckout, sameCheckout, startNextCheckout, withCheckoutLock, CHECKOUT_ATTEMPT_KEY } from '../src/utils/checkoutAttempt.ts'
import { resolveMemberQr } from '../src/utils/memberQrIdentity.ts'

class MemoryStorage {
  values = new Map()
  getItem(k) { return this.values.get(k) ?? null }
  setItem(k, v) { this.values.set(k, v) }
  removeItem(k) { this.values.delete(k) }
}
const backend = 'https://fixture.invalid'
const attempt = (key = 'checkout:original', client = 'member-a') => ({ version: 1, backend, customerLabel: '検証会員', operator: '検証担当', createdAt: '2026-10-19T01:00:00Z', input: { client_id: client, stylist_id: 'staff-a', items: [{ source: 'manual', name: 'カット', category: 'menu', unit_price: 5000, quantity: 1, discount: 0 }], ticket_ids: ['fixture-ticket'], payment_method: 'ginpay', expected_total: 4000, idempotency_key: key, ginpay_account_id: 'fixture-account' } })
function fixture() {
  const storage = new MemoryStorage(), sales = new Map(), calls = []
  const api = { backend, lookup: async key => sales.get(key) ?? null, finalize: async (input, operator) => {
    calls.push({ input: structuredClone(input), operator })
    if (sales.has(input.idempotency_key)) return sales.get(input.idempotency_key)
    const sale = { id: 'sale-' + (sales.size + 1), status: 'completed', total: input.expected_total, payment_method: input.payment_method }
    sales.set(input.idempotency_key, sale)
    return sale
  } }
  return { storage, sales, calls, api }
}

test('応答消失後に画面を開き直しても、既存会計を返し二度目の決済を送らない', async () => {
  const f = fixture(), finalize = f.api.finalize
  f.api.finalize = async (...args) => { await finalize(...args); throw Error('response lost') }
  await assert.rejects(settleCheckout(f.api, attempt(), f.storage), /response lost/)
  assert.equal(readCheckoutAttempt(f.storage).input.idempotency_key, 'checkout:original')
  const changed = attempt('checkout:different'); changed.input.expected_total = 9999
  const sale = await settleCheckout(f.api, changed, f.storage)
  assert.equal(sale.total, 4000); assert.equal(f.calls.length, 1); assert.equal(f.sales.size, 1)
})

test('最初の送信が届かなかった場合、元の内容・キー・担当者でのみ再送する', async () => {
  const f = fixture(), finalize = f.api.finalize
  f.api.finalize = async () => { throw Error('offline') }
  await assert.rejects(settleCheckout(f.api, attempt(), f.storage), /offline/)
  f.api.finalize = finalize
  const changed = attempt('checkout:new'); changed.input.items[0].unit_price = 8000; changed.operator = '別の担当'
  await settleCheckout(f.api, changed, f.storage)
  assert.equal(f.calls[0].input.items[0].unit_price, 5000)
  assert.equal(f.calls[0].input.idempotency_key, 'checkout:original')
  assert.equal(f.calls[0].operator, '検証担当'); assert.equal(f.sales.size, 1)
})

test('保存失敗時と壊れた記録がある時は、照合も決済も送らない', async () => {
  const f = fixture(); let lookups = 0; f.api.lookup = async () => { lookups++; return null }
  const blocked = { getItem: () => null, setItem: () => { throw Error('quota') }, removeItem() {} }
  await assert.rejects(settleCheckout(f.api, attempt(), blocked), /quota/)
  f.storage.setItem(CHECKOUT_ATTEMPT_KEY, '{invalid')
  await assert.rejects(settleCheckout(f.api, attempt(), f.storage), /前の会計記録/)
  assert.equal(lookups, 0); assert.equal(f.calls.length, 0)
})

test('照合RPC未配置なら決済を送らず、記録を維持する', async () => {
  const f = fixture(); f.api.lookup = async () => { throw Error('RPC missing') }
  await assert.rejects(settleCheckout(f.api, attempt(), f.storage), /RPC missing/)
  assert.equal(f.calls.length, 0); assert.ok(readCheckoutAttempt(f.storage))
})

test('別顧客の未確認会計を上書きせず、違う接続先にも再送しない', async () => {
  const f = fixture(); f.storage.setItem(CHECKOUT_ATTEMPT_KEY, JSON.stringify(attempt()))
  await assert.rejects(settleCheckout(f.api, attempt('checkout:b', 'member-b'), f.storage), /別のお客様/)
  await assert.rejects(settleCheckout({ ...f.api, backend: 'https://other.invalid' }, attempt(), f.storage), /接続先/)
  assert.equal(f.calls.length, 0)
})

test('明確な業務エラーは確定せず編集に戻れる。通信エラーとの扱いを分ける', async () => {
  const f = fixture(); f.api.finalize = async () => ({ error: 'insufficient_balance' })
  assert.deepEqual(await settleCheckout(f.api, attempt(), f.storage), { error: 'insufficient_balance' })
  assert.equal(readCheckoutAttempt(f.storage), null)
})

test('取消済みの会計を読み取っても再度請求しない', async () => {
  const f = fixture(); f.sales.set('checkout:original', { id: 'old', status: 'voided', total: 4000 })
  const result = await settleCheckout(f.api, attempt(), f.storage)
  assert.equal(result.status, 'voided'); assert.equal(f.calls.length, 0)
})

test('完了後の保存失敗でも取引キーが残り、再照合で重複請求しない', async () => {
  const f = fixture(); let writes = 0; const write = f.storage.setItem.bind(f.storage)
  f.storage.setItem = (key, value) => { if (++writes === 2) throw Error('quota after charge'); write(key, value) }
  await assert.rejects(settleCheckout(f.api, attempt(), f.storage), /quota after charge/)
  await settleCheckout(f.api, attempt('checkout:new'), f.storage)
  assert.equal(f.calls.length, 1); assert.equal(f.sales.size, 1)
})

test('同じブラウザの別タブによる同時送信を待ち行列へ入れず拒否する', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let locked = false
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name, _options, fn) => {
    if (locked) return fn(null)
    locked = true; try { return await fn({ name: 'fixture' }) } finally { locked = false }
  } } } })
  try {
    const f = fixture(); let release; const gate = new Promise(r => { release = r })
    const first = withCheckoutLock(async () => { await gate; return settleCheckout(f.api, attempt(), f.storage) })
    await assert.rejects(withCheckoutLock(() => settleCheckout(f.api, attempt('checkout:second'), f.storage)), /ほかの画面/)
    release(); await first; assert.equal(f.calls.length, 1)
    await startNextCheckout('checkout:original', f.storage)
    await withCheckoutLock(() => settleCheckout(f.api, attempt('checkout:next'), f.storage))
    assert.equal(f.sales.size, 2)
    f.storage.setItem(CHECKOUT_ATTEMPT_KEY, JSON.stringify(attempt('checkout:unknown')))
    await assert.rejects(startNextCheckout('checkout:unknown', f.storage), /未確認/)
  } finally { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator }
})

test('会員QRはサーバー名を維持し、通信失敗を初回登録と扱わない', async () => {
  let registrations = 0
  const api = { lookup: async () => ({ customer: { name: '訂正済み氏名' } }), register: async () => { registrations++; return { customer: { name: '古い氏名' } } } }
  const existing = await resolveMemberQr('member-a', '古い氏名', false, api)
  assert.equal(existing.customer.name, '訂正済み氏名'); assert.equal(registrations, 0)
  await assert.rejects(resolveMemberQr('member-a', '古い氏名', false, { ...api, lookup: async () => { throw Error('offline') } }), /offline/)
  assert.equal(registrations, 0)
  await assert.rejects(resolveMemberQr('member-a', '古い氏名', true, { ...api, lookup: async () => ({ customer: null }) }), /会員情報/)
  assert.equal(registrations, 0)
  await resolveMemberQr('new-member', '初回氏名', false, { ...api, lookup: async () => ({ customer: null }) })
  assert.equal(registrations, 1)
})

test('会計の復帰先を予約ID・顧客IDで照合する', () => {
  const a = attempt(); assert.equal(sameCheckout(a, null, 'member-a'), true)
  assert.equal(sameCheckout(a, null, 'member-b'), false)
  assert.equal(sameCheckout(a, 'reservation-a', null), false)
})
