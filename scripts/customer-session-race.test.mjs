import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import { test } from 'node:test'

const source = await readFile(new URL('../src/utils/customerSession.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

function fixture() {
  const data = new Map(), events = []
  let reject
  class RpcError extends Error { constructor(code, message) { super(message ?? code); this.code = code } }
  const exports = {}, storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }
  const modules = {
    './staffSession': { RpcError, isMissingRpc: () => false, callRpc: () => new Promise((_resolve, no) => { reject = no }) },
    './storage': { setStoredValue: (key, value) => storage.setItem(key, JSON.stringify(value)) },
    './userId': { USER_ID_KEY: 'fixture-user' },
  }
  vm.runInNewContext(compiled, { exports, require: name => { assert.ok(modules[name], name); return modules[name] }, localStorage: storage, window: { dispatchEvent: event => { events.push(event.type); return true } }, Event, CustomEvent })
  return { session: exports, events, fail: () => reject(new RpcError('28000', 'customer_auth_required')) }
}

test('古い認証エラーはFace ID等で新しく取得したセッションを消さない', async () => {
  const f = fixture(), old = 'old-'.repeat(16), fresh = 'new-'.repeat(16)
  f.session.saveCustomerSession('fixture', old)
  const pending = f.session.callCustomerRpc('wallet').catch(error => error)
  f.session.saveCustomerSession('fixture', fresh)
  f.fail(); await pending
  assert.equal(f.session.getCustomerSession(), fresh)
  assert.equal(f.events.filter(e => e === 'ginjiro:customer-auth-required').length, 0)
})

test('同じセッションの認証エラーは従来どおり削除し、引き継ぎを案内する', async () => {
  const f = fixture(); f.session.saveCustomerSession('fixture', 'old-'.repeat(16))
  const pending = f.session.callCustomerRpc('wallet').catch(error => error)
  f.fail(); await pending
  assert.equal(f.session.getCustomerSession(), null)
  assert.equal(f.events.filter(e => e === 'ginjiro:customer-auth-required').length, 1)
})
