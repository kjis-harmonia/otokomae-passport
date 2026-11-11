import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSbPendingStore, SB_PENDING_KEY } from '../src/sb/sbPending.ts'

// 11/11 監査：結果を何度確かめても進めない送信待ちで、SB が止まったままになる経路があった → 端末から消せるように
function fakeStorage() {
  const m = new Map()
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }
}
const locks = { request: async (_name, _opts, fn) => fn({}) }
const command = { kind: 'status', reservation_id: '00000000-0000-4000-8000-000000000001', expected_updated_at: '2026-11-11T05:00:00.000Z', status: 'checked_in' }

test('結果が分からない送信待ちを消すと、次の送信ができる', async () => {
  const st = fakeStorage()
  const store = createSbPendingStore(() => st, () => locks, () => {}, () => '00000000-0000-4000-8000-0000000000aa')
  // 送ったが結果が分からない（ok でも terminal でもない）→ 送信待ちが残る
  await store.start(command, 'テイテイ', async () => ({ ok: false, terminal: false })).catch(() => {})
  const p = store.read().pending
  assert.ok(p, '送信待ちが残っている')
  await store.discard(p.id)
  assert.equal(st.getItem(SB_PENDING_KEY), null)
  assert.equal(store.read().pending, null)
})

test('別の送信待ち（id が違う）は消さない', async () => {
  const st = fakeStorage()
  const store = createSbPendingStore(() => st, () => locks, () => {}, () => '00000000-0000-4000-8000-0000000000bb')
  await store.start(command, 'テイテイ', async () => ({ ok: false, terminal: false })).catch(() => {})
  await store.discard('00000000-0000-4000-8000-0000000000cc')
  assert.ok(store.read().pending)
})
