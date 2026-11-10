import assert from 'node:assert/strict'
import test from 'node:test'
import { ReservationMutationClient, reservationMenuCodes } from '../src/features/johnny/reservationMutation.ts'

const oldId = '00000000-0000-4000-8000-000000000001'
const newId = '00000000-0000-4000-8000-000000000002'
const companionId = '00000000-0000-4000-8000-000000000003'
const items = [{ menu_code: 'cut', name: 'カット' }, { menu_code: 'perm', name: 'パーマ' }]
const startsAt = '2026-11-10T03:00:00.000Z'
const change = {
  kind: 'change', reservation_id: oldId, starts_at: startsAt,
  menu_codes: reservationMenuCodes({ items }),
  confirmation: { version: 'RESERVATION_REVIEW_V1', old: { id: oldId, companion_id: null, starts_at: startsAt, items }, new: { total_price: 9000 } },
}
const changed = { id: newId, changed_from: oldId, starts_at: startsAt, companion_id: null, status: 'confirmed', items }
const cancel = { ...change, kind: 'cancel', starts_at: null, menu_codes: [] }
const cancelled = { id: oldId, companion_id: null, status: 'cancelled', ginpay_released: 3000, items }
const completed = (request, result) => ({ state: 'completed', request, result })

function fixture() {
  const entries = new Map()
  const store = { getItem: k => entries.get(k) ?? null, setItem: (k, v) => entries.set(k, v), removeItem: k => entries.delete(k) }
  let owner = 'fixture-owner'
  return {
    client: rpc => new ReservationMutationClient(rpc, store, () => owner),
    switchAccount: next => { owner = next },
  }
}

test('lost response: a same-time, same-menu companion or unrelated lineage cannot count as success', async () => {
  for (const result of [{ ...changed, companion_id: companionId }, { ...changed, changed_from: companionId }]) {
    const calls = []
    const client = fixture().client(async (name) => {
      calls.push(name)
      if (name === 'customer_change_reservation') throw new Error('connection reset')
      return completed(change, result)
    })
    const saved = client.begin(change)
    assert.equal((await client.send()).state, 'unknown')
    assert.deepEqual(client.pending(), saved)
    assert.deepEqual(calls, ['customer_change_reservation', 'customer_reservation_mutation_result'])
  }
})

test('cancel recovery only accepts the explicit cancelled result for the exact target', async () => {
  let result = { ...cancelled, status: 'checked_in' }
  const client = fixture().client(async () => completed(cancel, result))
  client.begin(cancel)
  assert.equal((await client.check()).state, 'unknown')
  result = { ...cancelled, id: newId }
  assert.equal((await client.check()).state, 'unknown')
  result = { ...cancelled, companion_id: companionId }
  assert.equal((await client.check()).state, 'unknown')
  assert.ok(client.pending())
  result = cancelled
  assert.deepEqual(await client.check(), completed(cancel, cancelled))
  assert.equal(client.pending(), null)
})

test('reload: retry uses the original key, confirmation, and every ordered menu', async () => {
  const f = fixture()
  const args = []
  const rpc = async (name, data) => {
    if (name === 'customer_reservation_mutation_result') return { state: 'unknown' }
    args.push(data)
    if (args.length === 1) throw new Error('lost response')
    return completed(change, changed)
  }
  const first = f.client(rpc)
  const p = first.begin(change)
  assert.equal((await first.send()).state, 'unknown')
  const reopened = f.client(rpc)
  assert.equal((await reopened.check()).state, 'unknown')
  assert.throws(() => reopened.begin({ ...change, menu_codes: ['cut'] }), /pending_other_request/)
  assert.deepEqual(await reopened.send(), completed(change, changed))
  assert.deepEqual(args, Array(2).fill({
    p_idem_key: p.key, p_reservation_id: oldId, p_starts_at: startsAt,
    p_confirmation: change.confirmation, p_menu_codes: ['cut', 'perm'],
  }))
})

test('changed terms only release pending on a matching terminal rejection', async () => {
  const updated = { ...change, confirmation: { ...change.confirmation, new: { total_price: 9500 } } }
  let response = { state: 'rejected', request: updated, code: 'conditions_changed' }
  const client = fixture().client(async () => response)
  const first = client.begin(change)
  assert.equal((await client.send()).state, 'unknown')
  assert.deepEqual(client.pending(), first)
  response = { ...response, request: change }
  assert.deepEqual(await client.check(), response)
  assert.equal(client.pending(), null)
  assert.notEqual(client.begin(updated).key, first.key)
})

test('conflict is retained and cannot become a new operation on the same account', async () => {
  const f = fixture()
  const rpc = async () => ({ state: 'conflict', code: 'idempotency_conflict' })
  const client = f.client(rpc)
  const pending = client.begin(change)
  assert.equal((await client.send()).state, 'conflict')
  assert.deepEqual(client.pending(), pending)
  f.switchAccount('other-fixture')
  assert.throws(() => client.pending(), /account_changed/)
  assert.equal(f.client(rpc).pending(), null)
})

test('while a submit is in flight a second call cannot send another mutation', async () => {
  let resolve
  let calls = 0
  const client = fixture().client(() => {
    calls++
    return new Promise(r => { resolve = r })
  })
  client.begin(change)
  const first = client.send()
  assert.equal((await client.send()).state, 'unknown')
  resolve(completed(change, changed))
  assert.equal((await first).state, 'completed')
  assert.equal(calls, 1)
})
