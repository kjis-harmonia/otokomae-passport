#!/usr/bin/env node
// GINJIRO POS Phase B-2A：RPC エラーの出どころ（provenance）と結果不明（RESULT_UNKNOWN）の画面側チェック（DB・ネットワーク不要）。
// 本物の supabase-js / postgrest-js に偽の fetch を渡し、通信断・ゲートウェイ応答・SQLSTATE・壊れた応答が
// どう分類され、会計・チャージ・返金・チケット発行・本部取消・承認の各 API にどう伝わるかを確かめる。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { createClient } from '@supabase/supabase-js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const asModule = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`

/** TS を JS にして、import 先を map の data: URL に差し替える（未知の import は失敗にする）。instance で別インスタンス（再読み込み・別タブ）を作る */
function load(rel, map, instance = '') {
  const source = readFileSync(join(root, rel), 'utf8') + (instance ? `\n// instance ${instance}\n` : '')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
  return asModule(js.replace(/from\s+['"]([^'"]+)['"]/g, (_, spec) => {
    if (!(spec in map)) throw new Error(`${rel}: unmapped import ${spec}`)
    return `from '${map[spec]}'`
  }))
}

// ── 端末の保存領域と window（staff/hq セッションの読み書きだけ） ──
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)) },
  removeItem: (k) => { store.delete(k) },
}
const future = new Date(Date.now() + 3600_000).toISOString()
function resetSessions() {
  store.set('ginjiro_staff_session', JSON.stringify({ token: 'staff-token', expiresAt: future }))
  store.set('ginjiro_hq_session', JSON.stringify({ token: 'hq-token', expiresAt: future }))
}
globalThis.window = { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} }

// ── 端末内の排他（Web Locks）。同じ端末の別タブは同じロックを共有する ──
function createLockManager() {
  let tail = Promise.resolve()
  return {
    request(_name, _options, callback) {
      const run = tail.then(() => callback())
      tail = run.then(() => undefined, () => undefined)
      return run
    },
  }
}
const sharedLocks = createLockManager()
Object.defineProperty(globalThis, 'navigator', { value: { locks: sharedLocks }, configurable: true, writable: true })

// ── 本物の supabase-js。fetch だけ差し替える（外部への通信は一切しない） ──
const requests = []
let fetchImpl = () => { throw new Error('unexpected fetch') }
const realClient = createClient('http://127.0.0.1:9', 'test-anon-key', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: {
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
      return fetchImpl(url, init)
    },
  },
})
globalThis.__sb = realClient

const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const SCENARIOS = {
  transport: () => Promise.reject(new TypeError('fetch failed')),
  abort: () => Promise.reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })),
  html502: () => new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502, headers: { 'content-type': 'text/html' } }),
  sql400: () => json({ code: 'P0001', message: 'customer_not_found', details: null, hint: null }, 400),
  sql400Cancel: () => json({ code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null }, 400),
  sql500: () => json({ code: 'P0001', message: 'refund_failed', details: null, hint: null }, 500),
  conn503: () => json({ code: 'PGRST003', message: 'Timed out acquiring connection from connection pool.', details: null, hint: null }, 503),
  jwt401: () => json({ code: 'PGRST301', message: 'JWT expired', details: null, hint: null }, 401),
  missingFn404: () => json({ code: 'PGRST202', message: 'Could not find the function', details: null, hint: null }, 404),
  staffAuth400: () => json({ code: 'P0001', message: 'staff_auth_required', details: null, hint: null }, 400),
  malformed200: () => new Response('{"id": "s-1", "total":', { status: 200, headers: { 'content-type': 'application/json' } }),
  null200: () => json(null, 200),
  biz: () => json({ error: 'insufficient_balance' }, 200),
}
function use(name) {
  globalThis.__sb = realClient
  fetchImpl = SCENARIOS[name]
}
function useThrowingClient() {
  globalThis.__sb = { rpc: () => { throw new Error('client exploded before send') } }
}
/** 成功応答を返す。会計の顧客の統合確認（staff_checkout_context）には、統合の無い文脈（顧客 c-1 のまま）を返す */
function useOk(body, contextBody = { client: { id: 'c-1', name: '山田', app_linked: false } }) {
  globalThis.__sb = realClient
  fetchImpl = (url) => json(String(url).endsWith('/rpc/staff_checkout_context') ? contextBody : body, 200)
}

// ── 対象モジュール（本物）と最小の差し替え ──
const supabaseStub = asModule('export const supabase = { rpc: (...a) => globalThis.__sb.rpc(...a) }')
const operatorStub = asModule(`
export function clearCurrentOperator() { globalThis.__operatorCleared = (globalThis.__operatorCleared ?? 0) + 1 }
export function getCurrentOperator() { return null }
export function setCurrentOperator() {}
export function isCurrentOperatorValid() { return false }`)
const customerStub = asModule(`
export async function callCustomerRpc() { throw new Error('not used') }
export function hasCustomerSession() { return false }
export async function readAsCustomer() { throw new Error('not used') }
export function saveCustomerSession() {}`)
const storageStub = asModule('export function removeStoredValue() {}')

const staffRpcUrl = load('src/utils/staffRpc.ts', { '../lib/supabase': supabaseStub, './posOperatorSession': operatorStub })
const staffSessionUrl = load('src/utils/staffSession.ts', { '../lib/supabase': supabaseStub, './staffRpc': staffRpcUrl, './posOperatorSession': operatorStub })
const hqSessionUrl = load('src/hq/hqSession.ts', { '../lib/supabase': supabaseStub, '../utils/staffSession': staffSessionUrl })
const saleIdentityUrl = load('src/utils/saleIdentity.ts', {})
const checkoutUrl = load('src/utils/checkoutApi.ts', { './staffSession': staffSessionUrl, '../hq/hqSession': hqSessionUrl, './saleIdentity': saleIdentityUrl })
const ginpayUrl = load('src/utils/ginpayApi.ts', { './customerSession': customerStub, './staffSession': staffSessionUrl, '../hq/hqSession': hqSessionUrl })
const ticketUrl = load('src/utils/ticketStore.ts', { './storage': storageStub, '../lib/supabase': supabaseStub, './staffSession': staffSessionUrl, './customerSession': customerStub })
const approvalUrl = load('src/utils/posManagerApproval.ts', { './staffRpc': staffRpcUrl })

const rpc = await import(staffRpcUrl)
const session = await import(staffSessionUrl)
const checkout = await import(checkoutUrl)
const ginpay = await import(ginpayUrl)
const tickets = await import(ticketUrl)
const approval = await import(approvalUrl)

let failed = 0
let passed = 0
const check = (name, ok, extra) => {
  if (ok) passed += 1
  else failed += 1
  console.log(`[pos-b2a] ${ok ? 'PASS' : 'FAIL'} ${name}${!ok && extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`)
}
/** 例外になるか、値で返るかを判別する */
async function outcome(fn) {
  try { return { value: await fn() } } catch (error) { return { error } }
}
const isUnknownError = (o) => !!o.error && o.error instanceof rpc.RpcError && o.error.resultUnknown === true && rpc.isResultUnknown(o.error)
const isDefinitiveError = (o) => !!o.error && o.error instanceof rpc.RpcError && o.error.resultUnknown === false && !rpc.isResultUnknown(o.error)

const operator = { operatorToken: 'op-token', staffMemberId: 'm-1', memberName: '担当A', role: 'staff', expiresAt: future }
const saleInput = {
  stylist_id: 'st-1', items: [{ source: 'service_menu', ref_id: 'cut', name: 'カット', category: 'menu', unit_price: 5000, quantity: 1, discount: 0 }],
  ticket_ids: [], payment_method: 'cash', expected_total: 5000, quote_hash: 'QTE1.' + 'a'.repeat(64), idempotency_key: 'checkout:fixed-key-1',
}
const chargeInput = { clientId: 'c-1', accountId: 'a-1', amount: 3000, paymentMethod: 'cash', idempotencyKey: 'staff-store-charge:fixed-key-2' }
const refundInput = { transactionId: 't-1', accountId: 'a-1', clientId: 'c-1', amount: 1000, reason: '返品', idempotencyKey: 'staff-refund:fixed-key-3' }
const ticketInput = { userId: 'u-1', type: 'discount', amount: 500, quantity: 2, customerName: '山田', idempotencyKey: 'ticket-issue:fixed-key-4' }
// 実際の SQL の成功応答（sale_json / ginpay_tx_json / row_to_json(tickets)）に合わせた形
const saleOk = {
  id: 's-1', status: 'completed', completed_at: '2026-10-10T00:00:00Z', client: null, customer_name: '', reservation: null,
  stylist_name: '担当', operator: '担当A', subtotal: 5000, discount_total: 0, total: 5000, payment_method: 'cash', tax_mode: 'inclusive', tax_rate: 10,
  idempotency_key: saleInput.idempotency_key, quote_hash: saleInput.quote_hash, request_hash: 'x',
  items: [{ name: 'カット', category: 'menu', unit_price: 5000, quantity: 1, line_discount: 0, line_total: 5000, list_price: 5000, source: 'service_menu', tax_mode: 'inclusive', tax_rate: 10 }],
  discounts: [], payments: [{ method: 'cash', amount: 5000 }], ginpay: [], voided_at: null, voided_by: null, void_reason: null,
  events: [{ type: 'completed', actor_name: '担当A', reason: null, created_at: '2026-10-10T00:00:00Z' }],
}
const txBase = { account_id: 'a-1', client_id: 'c-1', root_client_id: 'c-1', status: 'posted', accounting_session_id: null, created_at: '2026-10-10T00:00:00Z' }
const chargeOk = { ...txBase, id: 'g-1', type: 'charge_store', amount: chargeInput.amount, idempotency_key: chargeInput.idempotencyKey, original_transaction_id: null }
const refundOk = { ...txBase, id: 'g-1', type: 'refund', amount: -refundInput.amount, idempotency_key: refundInput.idempotencyKey, original_transaction_id: refundInput.transactionId }
const ticketOk = { tickets: [{ id: 't-1', user_id: 'u-1', type: 'discount', amount: 500 }, { id: 't-2', user_id: 'u-1', type: 'discount', amount: 500 }] }

resetSessions()

// ── 1. 分類（callRpc） ──
{
  use('transport'); const o = await outcome(() => rpc.callRpc('staff_finalize_sale', {}))
  check('transport status 0 -> supabase_error / unknown / httpStatus 0 / code normalized', isUnknownError(o) && o.error.source === 'supabase_error' && o.error.httpStatus === 0 && o.error.code === 'result_unknown', o.error && { code: o.error.code, status: o.error.httpStatus })
}
{
  use('abort'); const o = await outcome(() => rpc.callRpc('staff_finalize_sale', {}))
  check('timeout/abort -> unknown, code not empty', isUnknownError(o) && o.error.code !== '')
}
{
  use('html502'); const o = await outcome(() => rpc.callRpc('staff_finalize_sale', {}))
  check('HTTP 502 HTML -> unknown, httpStatus 502', isUnknownError(o) && o.error.httpStatus === 502 && o.error.code === 'result_unknown')
}
{
  use('sql400'); const o = await outcome(() => rpc.callRpc('staff_issue_tickets', {}))
  check('HTTP 400 SQLSTATE P0001 -> definitive (rolled back), code kept', isDefinitiveError(o) && o.error.source === 'supabase_error' && o.error.code === 'P0001' && o.error.httpStatus === 400)
}
{
  use('sql400Cancel'); const o = await outcome(() => rpc.callRpc('staff_finalize_sale', {}))
  check('HTTP 400 SQLSTATE 57014 (cancel) -> unknown (not proven)', isUnknownError(o) && o.error.code === '57014')
}
{
  use('sql500'); const o = await outcome(() => rpc.callRpc('staff_ginpay_refund', {}))
  check('HTTP 500 with SQLSTATE -> unknown (5xx never proven)', isUnknownError(o))
}
{
  use('conn503'); const o = await outcome(() => rpc.callRpc('staff_finalize_sale', {}))
  check('HTTP 503 PGRST003 (connection) -> unknown', isUnknownError(o))
}
{
  use('jwt401'); const o = await outcome(() => rpc.callRpc('staff_finalize_sale', {}))
  check('HTTP 401 PGRST301 (rejected before execution) -> definitive', isDefinitiveError(o))
}
{
  use('missingFn404'); const o = await outcome(() => rpc.callRpc('staff_finalize_sale', {}))
  check('HTTP 404 PGRST202 (function missing) -> definitive', isDefinitiveError(o) && session.isMissingRpc(o.error))
}
{
  use('malformed200'); const o = await outcome(() => rpc.callRpc('staff_finalize_sale', {}))
  check('HTTP 200 malformed body -> unknown', isUnknownError(o) && o.error.httpStatus === 200)
}
{
  useThrowingClient(); const o = await outcome(() => rpc.callRpc('staff_finalize_sale', {}))
  check('Supabase client exception -> unknown', isUnknownError(o) && o.error.code === 'result_unknown')
}
{
  use('biz'); const o = await outcome(() => rpc.callRpc('staff_finalize_sale', {}))
  check('business error {error} -> rpc_result, not unknown', isDefinitiveError(o) && o.error.source === 'rpc_result' && o.error.code === 'insufficient_balance')
}
{
  use('staffAuth400'); const o = await outcome(() => rpc.callRpc('staff_finalize_sale', {}))
  check('staff_auth_required raise -> definitive, session cleared', isDefinitiveError(o) && o.error.code === 'staff_auth_required' && localStorage.getItem('ginjiro_staff_session') === null)
  resetSessions()
}
{
  store.delete('ginjiro_staff_session')
  const o = await outcome(() => rpc.callStaffRpc('staff_finalize_sale', {}))
  check('missing staff token -> local_precondition, definitive', isDefinitiveError(o) && o.error.source === 'local_precondition')
  resetSessions()
}
check('isResultUnknown(non-RpcError) is true (unproven)', rpc.isResultUnknown(new TypeError('x')) === true)
check('staffSession re-exports isResultUnknown / expectRpcObject', session.isResultUnknown === rpc.isResultUnknown && typeof session.expectRpcObject === 'function')

// ── 2. 会計確定（checkoutApi.asResult が通信断を業務エラーにしない） ──
const staffCheckout = checkout.createStaffCheckoutApi()
for (const name of ['transport', 'html502', 'malformed200', 'null200']) {
  use(name); const o = await outcome(() => staffCheckout.finalize(saleInput, operator, null))
  check(`checkout finalize ${name} -> throws RESULT_UNKNOWN (not {error})`, isUnknownError(o), o.value)
}
{
  useThrowingClient(); const o = await outcome(() => staffCheckout.finalize(saleInput, operator, null))
  check('checkout finalize client exception -> throws RESULT_UNKNOWN', isUnknownError(o))
}
{
  use('sql400'); const o = await outcome(() => staffCheckout.finalize(saleInput, operator, null))
  check('checkout finalize SQLSTATE 400 -> throws definitive supabase_error (not converted)', isDefinitiveError(o) && o.error.source === 'supabase_error')
}
{
  use('biz'); const o = await outcome(() => staffCheckout.finalize(saleInput, operator, null))
  check('checkout finalize business error -> {error} (existing contract)', o.value && o.value.error === 'insufficient_balance')
}
{
  useOk(saleOk); const o = await outcome(() => staffCheckout.finalize(saleInput, operator, null))
  check('checkout finalize success -> sale', o.value && o.value.id === 's-1')
}
{
  use('transport'); const o = await outcome(() => staffCheckout.quote({ items: [] }, operator, null))
  check('checkout quote transport -> throws (no empty error code result)', isUnknownError(o))
}
{
  store.delete('ginjiro_staff_session')
  const o = await outcome(() => staffCheckout.finalize(saleInput, operator, null))
  check('checkout finalize without staff token -> {error: staff_auth_required} (local_precondition)', o.value && o.value.error === 'staff_auth_required')
  resetSessions()
}

// ── 3. GINPay チャージ・返金 ──
const staffGinpay = ginpay.createStaffGinpayApi(() => '担当A')
for (const [label, call] of [['charge', () => staffGinpay.chargeStore(chargeInput, operator, null)], ['refund', () => staffGinpay.refund(refundInput, operator, null)]]) {
  for (const name of ['transport', 'html502', 'malformed200', 'null200']) {
    use(name); const o = await outcome(call)
    check(`ginpay ${label} ${name} -> throws RESULT_UNKNOWN`, isUnknownError(o), o.value)
  }
  use('biz'); const b = await outcome(call)
  check(`ginpay ${label} business error -> {ok:false,error}`, b.value && b.value.ok === false && b.value.error === 'insufficient_balance')
  use('sql400'); const d = await outcome(call)
  check(`ginpay ${label} SQLSTATE 400 -> definitive throw`, isDefinitiveError(d))
  useOk(label === 'charge' ? chargeOk : refundOk); const s = await outcome(call)
  check(`ginpay ${label} success -> {ok:true}`, s.value && s.value.ok === true && s.value.value.id === 'g-1')
}

// ── 4. チケット発行 ──
for (const name of ['transport', 'html502', 'malformed200', 'null200']) {
  use(name); const o = await outcome(() => tickets.issueTickets(ticketInput, operator, null))
  check(`ticket issue ${name} -> throws RESULT_UNKNOWN`, isUnknownError(o), o.value)
}
{
  use('sql400'); const o = await outcome(() => tickets.issueTickets(ticketInput, operator, null))
  check('ticket issue raise (customer_not_found) -> definitive, not unknown', isDefinitiveError(o))
  useOk(ticketOk); const s = await outcome(() => tickets.issueTickets(ticketInput, operator, null))
  check('ticket issue success -> tickets', s.value && s.value.tickets.length === 2)
}

// ── 5. 本部の会計取消 ──
for (const name of ['transport', 'html502', 'malformed200', 'null200']) {
  use(name); const o = await outcome(() => checkout.hqSalesApi.void('s-1', '誤会計', 5000))
  check(`hq void ${name} -> throws RESULT_UNKNOWN (not shown as failure)`, isUnknownError(o), o.value)
}
{
  globalThis.__sb = realClient; fetchImpl = () => json({ error: 'invalid_status' }, 200)
  const o = await outcome(() => checkout.hqSalesApi.void('s-1', '誤会計', 5000))
  check('hq void business error -> {error}', o.value && o.value.error === 'invalid_status')
  fetchImpl = () => json({ error: 'hq_auth_required' }, 200)
  const a = await outcome(() => checkout.hqSalesApi.void('s-1', '誤会計', 5000))
  check('hq void hq_auth_required -> {error} (rewrap keeps rpc_result)', a.value && a.value.error === 'hq_auth_required')
  resetSessions()
  use('html502'); fetchImpl = () => new Response('<html>hq_auth_required</html>', { status: 502 })
  const u = await outcome(() => checkout.hqSalesApi.void('s-1', '誤会計', 5000))
  check('hq void rewrap keeps resultUnknown', isUnknownError(u) && u.error.code === 'hq_auth_required')
  resetSessions()
}

// ── 6. 管理者承認 API ──
{
  use('transport'); const o = await outcome(() => approval.approvePosOperation({ managerStaffId: 'm-2', managerPin: '1234', action: 'refund', requestHash: 'AUTH1.' + 'b'.repeat(64) }, 'op-token'))
  check('approval transport -> throws (not converted to business error)', isUnknownError(o), o.value)
  use('transport'); const c = await outcome(() => approval.getStaffManagerCandidates('op-token'))
  check('manager candidates transport -> throws', isUnknownError(c), c.value)
  globalThis.__sb = realClient; fetchImpl = () => json({ error: 'invalid_pin', remaining_attempts: 2 }, 200)
  const p = await outcome(() => approval.approvePosOperation({ managerStaffId: 'm-2', managerPin: '1234', action: 'refund', requestHash: 'x' }, 'op-token'))
  check('approval invalid_pin -> {ok:false, remaining_attempts}', p.value && p.value.ok === false && p.value.error === 'invalid_pin' && p.value.remaining_attempts === 2)
  use('staffAuth400'); const s = await outcome(() => approval.approvePosOperation({ managerStaffId: 'm-2', managerPin: '1234', action: 'refund', requestHash: 'x' }, 'op-token'))
  check('approval staff_auth_required raise -> {ok:false} (definitive)', s.value && s.value.ok === false && s.value.error === 'staff_auth_required')
  resetSessions()
}

// ── 7. 同じキー・同じ内容での再送（結果不明 → 確認） ──
async function sameKey(label, call, keyOf) {
  requests.length = 0
  use('transport'); await outcome(call)
  useOk(label === 'ticket' ? { tickets: [] } : { id: 'x-1' }); await outcome(call)
  const [first, second] = requests
  check(`${label}: retry after RESULT_UNKNOWN sends identical body and key`, requests.length === 2 && JSON.stringify(first.body) === JSON.stringify(second.body) && keyOf(first.body) !== undefined && keyOf(first.body) === keyOf(second.body), requests.map((r) => keyOf(r.body)))
  check(`${label}: no approval/operator secret is dropped into a new key`, !JSON.stringify(second.body).includes('APR1.'))
}
await sameKey('checkout', () => staffCheckout.finalize(saleInput, operator, null), (b) => b?.p?.idempotency_key)
await sameKey('charge', () => staffGinpay.chargeStore(chargeInput, operator, null), (b) => b?.p_idempotency_key)
await sameKey('refund', () => staffGinpay.refund(refundInput, operator, null), (b) => b?.p_idempotency_key)
await sameKey('ticket', () => tickets.issueTickets(ticketInput, operator, null), (b) => b?.p_idempotency_key)

// ── 8. 画面の文言：結果不明で「再度お試しください」と案内しない ──
{
  const files = ['src/components/booking/Checkout.tsx', 'src/components/ginpay/GinpayPanel.tsx', 'src/screens/AdminScreen.tsx', 'src/hq/screens/HqSalesLedgerScreen.tsx', 'src/utils/pendingOps.ts', 'src/utils/pendingConfirm.ts']
  const unknownBlocks = files.map((f) => readFileSync(join(root, f), 'utf8'))
    .flatMap((src) => src.split(/\r?\n/).filter((l) => /isResultUnknown|UNKNOWN_MESSAGE|処理結果を確認|まだ結果を確認|return '.*(確認|確定)/.test(l)))
  check('result-unknown messages never say 再度お試しください', unknownBlocks.length > 0 && unknownBlocks.every((l) => !l.includes('再度お試しください')))
  const checkoutSrc = readFileSync(join(root, 'src/components/booking/Checkout.tsx'), 'utf8')
  check('checkout keeps one sale key per screen (no key regeneration path)', (checkoutSrc.match(/idempotencyKey\('checkout'\)/g) ?? []).length === 1)
  check('checkout locks editing and confirm while a pending record blocks it', /<fieldset disabled=\{locked\}/.test(checkoutSrc) && /!needsFreshQuote && !locked/.test(checkoutSrc) && /beginPendingOp\(draftCheckout/.test(checkoutSrc))
  const ginpaySrc = readFileSync(join(root, 'src/components/ginpay/GinpayPanel.tsx'), 'utf8')
  check('charge form is disabled while a pending record blocks the client', /<fieldset disabled=\{locked\}/.test(ginpaySrc) && /if \(locked \|\| !api\.chargeStore/.test(ginpaySrc) && /beginPendingOp\(draftCharge/.test(ginpaySrc))
}


// ── 9. 未解決の金銭操作の記録（監査 H1〜H4・M1） ──
const pendingUrlFor = (instance) => load('src/utils/pendingOps.ts', { './saleIdentity': saleIdentityUrl }, instance)
const confirmUrlFor = (instance) => load('src/utils/pendingConfirm.ts', { './pendingOps': pendingUrlFor(instance), './ginpayApi': ginpayUrl, './saleIdentity': saleIdentityUrl }, instance)
const P = await import(pendingUrlFor('tab-a'))
const PC = await import(confirmUrlFor('tab-a'))
const KEY = P.PENDING_OPS_KEY
const resetPending = () => { store.delete(KEY) }
const storedRaw = () => store.get(KEY) ?? ''
const has = (mod, id) => mod.readPendingOps().some((o) => o.id === id)
const calls = (fn) => requests.filter((r) => r.url.endsWith(`/rpc/${fn}`)).length
/** RPC 名ごとに応答を返す偽の fetch（登録の無い RPC は通信断） */
function route(handlers) {
  globalThis.__sb = realClient
  fetchImpl = (url, init) => {
    const fn = String(url).split('/rpc/')[1]
    const h = handlers[fn]
    return h ? h(init?.body ? JSON.parse(init.body) : null) : Promise.reject(new TypeError('fetch failed'))
  }
}
const operatorB = { ...operator, operatorToken: 'op-token-b', staffMemberId: 'm-9', memberName: '担当B' }
const hqRefundInput = { transactionId: 't-9', accountId: 'a-1', clientId: 'c-1', amount: 800, reason: '本部返金', idempotencyKey: 'hq-refund:fixed-key-9' }
const hqRefundOk = { ...txBase, id: 'g-9', type: 'refund', amount: -800, idempotency_key: hqRefundInput.idempotencyKey, original_transaction_id: 't-9' }
/** 画面と同じ順序：記録 → 送信 → 結果不明なら記録を残す */
async function unknownOp(draft, input, secrets = [operator.operatorToken]) {
  const rec = await P.beginPendingOp(draft, input, secrets)
  await P.markPendingUnknown(rec.id)
  return rec
}

// 9-1. 送信前の保存失敗・読み戻し不一致・破損・排他なし → 送信しない（fail closed）
{
  resetPending(); requests.length = 0
  const orig = localStorage.setItem
  localStorage.setItem = () => { throw new Error('QuotaExceededError') }
  const o = await outcome(() => P.beginPendingOp(PC.draftCharge(chargeInput, operator), chargeInput, [operator.operatorToken]))
  localStorage.setItem = () => {} // 書いたつもりで保存されない
  const v = await outcome(() => P.beginPendingOp(PC.draftCharge(chargeInput, operator), chargeInput, [operator.operatorToken]))
  localStorage.setItem = orig
  check('persist failure before send -> begin throws (unavailable), nothing stored, no RPC sent', o.error instanceof P.PendingStoreError && o.error.reason === 'unavailable' && !store.has(KEY) && requests.length === 0)
  check('read-back mismatch -> begin throws (verify_failed)', v.error instanceof P.PendingStoreError && v.error.reason === 'verify_failed')
}
{
  store.set(KEY, '{"v":1,"ops":[{"id":1}]}')
  const o = await outcome(() => P.beginPendingOp(PC.draftCharge(chargeInput, operator), chargeInput, []))
  check('corrupt store (bad record) -> begin throws corrupt, view fails closed', o.error instanceof P.PendingStoreError && o.error.reason === 'corrupt' && P.getPendingView().failure === 'corrupt')
  store.set(KEY, '{"v":1,"ops":[')
  check('corrupt store (broken JSON) -> view fails closed', P.getPendingView().failure === 'corrupt')
  const extra = { v: 1, ops: [{ ...PC.draftCharge(chargeInput, operator), id: `ginpay_charge:${chargeInput.idempotencyKey}`, state: 'unknown', createdAt: new Date().toISOString(), approval_token: 'APR1.x' }] }
  store.set(KEY, JSON.stringify(extra))
  check('record with a field outside the allowlist -> corrupt (fail closed)', P.getPendingView().failure === 'corrupt')
  resetPending()
}
{
  const saved = globalThis.navigator
  globalThis.navigator = {}
  const o = await outcome(() => P.beginPendingOp(PC.draftCharge(chargeInput, operator), chargeInput, []))
  check('no cross-tab lock (Web Locks unavailable) -> begin throws, view fails closed', o.error instanceof P.PendingStoreError && o.error.reason === 'lock_unavailable' && P.getPendingView().failure === 'lock_unavailable' && !store.has(KEY))
  globalThis.navigator = saved
}

// 9-2. 保存する情報は許可リストだけ（APR1・QTE1・操作者トークン・PIN・自由入力を保存しない）
{
  resetPending()
  const chargeWithMemo = { ...chargeInput, memo: 'メモ本文' }
  const recs = [
    await P.beginPendingOp(PC.draftCheckout(saleInput, operator), saleInput, [saleInput.quote_hash, 'APR1.' + 'c'.repeat(64), operator.operatorToken]),
    await P.beginPendingOp(PC.draftCharge(chargeWithMemo, operator), chargeWithMemo, [operator.operatorToken]),
    await P.beginPendingOp(PC.draftRefund('ginpay_refund', 'c-5', { ...refundInput, accountId: 'a-5', clientId: 'c-5' }, operator), { ...refundInput, accountId: 'a-5', clientId: 'c-5' }, [operator.operatorToken]),
    await P.beginPendingOp(PC.draftTicketIssue(ticketInput, operator), ticketInput, [operator.operatorToken]),
  ]
  const raw = storedRaw()
  check('stored records exclude QTE1 / APR1 / AUTH1 / operator token', !/QTE1|APR1|AUTH1/.test(raw) && !raw.includes(operator.operatorToken))
  check('stored records exclude free text (memo, refund reason, customer name, item names)', !raw.includes('メモ本文') && !raw.includes(refundInput.reason) && !raw.includes(ticketInput.customerName) && !raw.includes('カット'))
  check('stored record keeps key, kind, target, amount, operator id (not token)', recs.every((r) => has(P, r.id)) && raw.includes(saleInput.idempotency_key) && raw.includes('"operatorId":"m-1"') && raw.includes('"amount":5000'))
  check('memory keeps the full input (incl. QTE1) only in this process', P.getPendingInput(recs[0].id)?.quote_hash === saleInput.quote_hash)
  const leaked = await outcome(() => P.beginPendingOp({ ...PC.draftCharge({ ...chargeInput, clientId: 'c-8', idempotencyKey: 'k-leak' }, operator), snapshot: { clientId: 'c-8', accountId: 'a-1', amount: 3000, paymentMethod: 'op-token' } }, {}, [operator.operatorToken]))
  check('secret value inside a snapshot -> begin refuses (secret_detected)', leaked.error instanceof P.PendingStoreError && leaked.error.reason === 'secret_detected')
  for (const r of recs) await P.settlePendingOp(r.id, 'not_executed')
  check('records that never became unknown can be dropped after a definitive failure', P.readPendingOps().length === 0)
}

// 9-3. 結果不明の後：画面を閉じる・顧客を切り替える・新しいキー
const chargeRec = await (async () => {
  resetPending()
  route({}) // 通信断
  const rec = await P.beginPendingOp(PC.draftCharge(chargeInput, operator), chargeInput, [operator.operatorToken])
  const sent = await outcome(() => staffGinpay.chargeStore(chargeInput, operator, null))
  if (isUnknownError(sent)) await P.markPendingUnknown(rec.id)
  return rec
})()
{
  check('RESULT_UNKNOWN keeps the record after the screen is gone (no component state needed)', has(P, chargeRec.id) && P.readPendingOps()[0].state === 'unknown')
  const again = await outcome(() => P.beginPendingOp(PC.draftCharge({ ...chargeInput, idempotencyKey: 'staff-store-charge:new-key' }, operator), {}, []))
  check('reopened screen cannot start the same client with a new key', again.error instanceof P.PendingBlockedError && again.error.op.id === chargeRec.id)
  const sale = await outcome(() => P.beginPendingOp(PC.draftCheckout({ ...saleInput, reservation_id: 'r-1', idempotency_key: 'checkout:other' }, operator, 'c-1'), {}, []))
  check('a checkout for the same client is also blocked', sale.error instanceof P.PendingBlockedError)
  const other = await outcome(() => P.beginPendingOp(PC.draftCharge({ ...chargeInput, clientId: 'c-2', accountId: 'a-2', idempotencyKey: 'k-c2' }, operator), {}, []))
  check('customer switch: another client is not blocked', !other.error && other.value.targets[0] === 'client:c-2')
  await P.settlePendingOp(other.value.id, 'not_executed')
  check('customer switch back: the unresolved client is still blocked', P.findBlockingOp(P.readPendingOps(), 'ginpay_charge', ['client:c-1'])?.id === chargeRec.id)
  const drop = await outcome(() => P.settlePendingOp(chargeRec.id, 'not_executed'))
  check('an unknown record cannot be dropped as not_executed', !!drop.error && has(P, chargeRec.id))
}

// 9-4. 業務エラー・approval_required が返っても解除しない（H2）
{
  requests.length = 0
  route({ staff_ginpay_ledger: () => json({ transactions: [] }, 200), staff_ginpay_charge_store: () => json({ error: 'insufficient_balance' }, 200) })
  const out = await PC.confirmPendingOp(chargeRec, { operator, ginpay: staffGinpay })
  check('charge confirm: business error keeps the lock', out.status === 'unresolved' && out.reason === 'business' && has(P, chargeRec.id))
  const body = requests.find((r) => r.url.endsWith('/rpc/staff_ginpay_charge_store'))?.body
  check('charge confirm resends the same key, amount and no approval', body?.p_idempotency_key === chargeInput.idempotencyKey && body?.p_amount === chargeInput.amount && body?.p_approval_token === null)
  route({ staff_ginpay_ledger: () => json({ transactions: [] }, 200), staff_ginpay_charge_store: () => json({ error: 'idempotency_conflict' }, 200) })
  const c = await PC.confirmPendingOp(chargeRec, { operator, ginpay: staffGinpay })
  check('charge confirm: idempotency_conflict keeps the lock', c.status === 'unresolved' && has(P, chargeRec.id))
  route({ staff_ginpay_ledger: () => json({ transactions: [] }, 200), staff_ginpay_charge_store: () => json({ error: 'approval_required', action: 'ginpay_charge', request_hash: 'AUTH1.' + 'd'.repeat(64) }, 200) })
  const a = await PC.confirmPendingOp(chargeRec, { operator, ginpay: staffGinpay })
  check('charge confirm: approval_required keeps the lock and returns the same input', a.status === 'approval_required' && a.input.idempotencyKey === chargeInput.idempotencyKey && a.input.amount === chargeInput.amount && has(P, chargeRec.id))
  route({ staff_ginpay_charge_store: () => json({ error: 'approval_expired' }, 200) })
  const e = await PC.sendPendingWithApproval(chargeRec, a.input, 'APR1.' + 'e'.repeat(64), { operator, ginpay: staffGinpay })
  check('approved resend: business error (approval_expired) keeps the lock', e.status === 'unresolved' && has(P, chargeRec.id))
  route({})
  const t = await PC.sendPendingWithApproval(chargeRec, a.input, 'APR1.' + 'e'.repeat(64), { operator, ginpay: staffGinpay })
  check('approved resend: transport failure keeps the lock', t.status === 'unresolved' && t.reason === 'transport' && has(P, chargeRec.id))
  requests.length = 0
  route({ staff_ginpay_charge_store: () => json(chargeOk, 200) })
  const ok = await PC.sendPendingWithApproval(chargeRec, a.input, 'APR1.' + 'e'.repeat(64), { operator, ginpay: staffGinpay })
  const sent = requests[0]?.body
  check('approved resend keeps the original intent (same key, amount, client) and resolves on success', ok.status === 'confirmed' && sent?.p_idempotency_key === chargeInput.idempotencyKey && sent?.p_amount === chargeInput.amount && sent?.p_client_id === chargeInput.clientId && !has(P, chargeRec.id))
}
{
  resetPending()
  const rec = await unknownOp(PC.draftCharge(chargeInput, operator), chargeInput)
  requests.length = 0
  route({ staff_ginpay_ledger: () => json({ transactions: [chargeOk] }, 200) })
  const out = await PC.confirmPendingOp(rec, { operator, ginpay: staffGinpay })
  check('charge confirm: ledger read finds the same key -> resolved without resending', out.status === 'confirmed' && calls('staff_ginpay_charge_store') === 0 && !has(P, rec.id))
}
{
  resetPending()
  const rec = await unknownOp(PC.draftCheckout(saleInput, operator), saleInput, [saleInput.quote_hash, operator.operatorToken])
  check('anonymous checkout unknown blocks every new checkout on this device', P.findBlockingOp(P.readPendingOps(), 'checkout', P.checkoutTargets({ reservation_id: 'r-9' }, 'c-9'))?.id === rec.id)
  for (const code of ['quote_mismatch', 'idempotency_conflict', 'invalid_quote', 'insufficient_balance']) {
    route({ staff_finalize_sale: () => json({ error: code }, 200) })
    const out = await PC.confirmPendingOp(rec, { operator, checkout: staffCheckout })
    check(`checkout confirm: ${code} keeps the lock`, out.status === 'unresolved' && has(P, rec.id))
  }
  route({ staff_finalize_sale: () => json({ error: 'approval_required', action: 'checkout_pricing_override', request_hash: 'AUTH1.x' }, 200) })
  const ap = await PC.confirmPendingOp(rec, { operator, checkout: staffCheckout })
  check('checkout confirm: approval_required keeps the lock', ap.status !== 'confirmed' && has(P, rec.id))
}

// 9-5. 操作者の失効・別の操作者
{
  resetPending(); requests.length = 0
  const rec = await unknownOp(PC.draftTicketIssue(ticketInput, operator), ticketInput)
  const none = await PC.confirmPendingOp(rec, { operator: null, issueTickets: tickets.issueTickets })
  const other = await PC.confirmPendingOp(rec, { operator: operatorB, issueTickets: tickets.issueTickets })
  check('operator expired -> operator_required, lock kept, nothing sent', none.status === 'operator_required' && has(P, rec.id) && requests.length === 0)
  check('different operator -> operator_required (server hashes the operator), lock kept', other.status === 'operator_required' && other.operatorName === '担当A' && has(P, rec.id) && requests.length === 0)
}

// 9-6. 再読み込み・PWA 再起動（同じ端末の保存領域・新しいメモリ）
{
  resetPending()
  const sale = await unknownOp(PC.draftCheckout(saleInput, operator), saleInput, [saleInput.quote_hash, operator.operatorToken])
  const ticket = await P.beginPendingOp(PC.draftTicketIssue(ticketInput, operator), ticketInput, [operator.operatorToken]) // 送信中に再読み込み
  const R = await import(pendingUrlFor('reload-1'))
  const RC = await import(confirmUrlFor('reload-1'))
  check('reload keeps unresolved records (sending and unknown)', has(R, sale.id) && has(R, ticket.id) && R.getPendingView().ops.length === 2)
  check('reload loses the in-memory input (QTE1 was never stored)', R.getPendingInput(sale.id) === null && !storedRaw().includes('QTE1'))
  requests.length = 0
  const saleOut = await RC.confirmPendingOp(R.readPendingOps().find((o) => o.id === sale.id), { operator, checkout: staffCheckout })
  check('after reload checkout cannot be confirmed by resend -> stays locked, nothing sent', saleOut.status === 'unresolved' && saleOut.reason === 'no_snapshot' && requests.length === 0 && has(R, sale.id))
  route({ staff_issue_tickets: (b) => json(b.p_approval_token === null && b.p_idempotency_key === ticketInput.idempotencyKey && b.p_amount === 500 && b.p_quantity === 2 && b.p_user_id === 'u-1' ? { ...ticketOk, idempotent: true } : { error: 'unexpected' }, 200) })
  const tOut = await RC.confirmPendingOp(R.readPendingOps().find((o) => o.id === ticket.id), { operator, issueTickets: tickets.issueTickets })
  check('after reload ticket confirm resends without approval (cannot issue new) and resolves', tOut.status === 'confirmed' && !has(R, ticket.id))
  globalThis.navigator = { locks: createLockManager() }
  const W = await import(pendingUrlFor('pwa-restart-1'))
  const blocked = await outcome(() => W.beginPendingOp(PC.draftCheckout({ ...saleInput, idempotency_key: 'checkout:after-restart' }, operator), {}, []))
  check('PWA restart equivalent: record survives and still blocks a new checkout', blocked.error instanceof W.PendingBlockedError && blocked.error.op.id === sale.id)
  globalThis.navigator = { locks: sharedLocks }
}

// 9-7. 本部の GINPay 返金（H3）
{
  requests.length = 0
  route({})
  await outcome(() => ginpay.hqGinpayApi.refund(hqRefundInput, operator, null))
  await outcome(() => ginpay.hqGinpayApi.refund(hqRefundInput, operator, null))
  const keys = requests.filter((r) => r.url.endsWith('/rpc/hq_ginpay_refund')).map((r) => r.body.p_idempotency_key)
  check('HQ refund sends the caller key (same key on every send, no new hq-refund key)', keys.length === 2 && keys.every((k) => k === hqRefundInput.idempotencyKey))
  check('HQ refund no longer generates its own key', !/idempotencyKey\('hq-refund'\)/.test(readFileSync(join(root, 'src/utils/ginpayApi.ts'), 'utf8')))
  resetPending()
  const rec = await unknownOp(PC.draftRefund('hq_ginpay_refund', 'c-1', hqRefundInput, null), hqRefundInput, [])
  requests.length = 0
  route({ hq_ginpay_ledger: () => json({ transactions: [] }, 200), hq_ginpay_refund: () => json(hqRefundOk, 200) })
  const miss = await PC.confirmPendingOp(rec, { operator, ginpay: ginpay.hqGinpayApi })
  check('HQ refund confirm never resends the mutation (replay not guaranteed) and keeps the lock when absent', miss.status === 'unresolved' && miss.reason === 'not_found' && calls('hq_ginpay_refund') === 0 && has(P, rec.id))
  route({ hq_ginpay_ledger: () => json({ transactions: [{ ...hqRefundOk, amount: -500 }] }, 200) })
  const bad = await PC.confirmPendingOp(rec, { operator, ginpay: ginpay.hqGinpayApi })
  check('HQ refund confirm: same key with different amount is not accepted', bad.status === 'unresolved' && has(P, rec.id))
  route({ hq_ginpay_ledger: () => json({ transactions: [hqRefundOk] }, 200) })
  const hit = await PC.confirmPendingOp(rec, { operator, ginpay: ginpay.hqGinpayApi })
  check('HQ refund confirm: read-only ledger match resolves', hit.status === 'confirmed' && calls('hq_ginpay_refund') === 0 && !has(P, rec.id))
}

// 9-8. 本部の会計取消（H4）
{
  resetPending()
  const rec = await unknownOp(PC.draftHqVoid({ id: 's-7', total: 5000 }), { id: 's-7' }, [])
  route({ hq_sale_detail: () => json({ id: 's-7', status: 'completed', total: 5000 }, 200) })
  const c = await PC.confirmPendingOp(rec, { operator: null, sales: checkout.hqSalesApi })
  check('HQ void: completed read keeps the unresolved record', c.status === 'unresolved' && c.reason === 'not_voided' && has(P, rec.id))
  const again = await outcome(() => P.beginPendingOp(PC.draftHqVoid({ id: 's-7', total: 5000 }), {}, []))
  check('HQ void: another void of the same sale cannot start while unresolved', again.error instanceof P.PendingBlockedError)
  route({})
  const t = await PC.confirmPendingOp(rec, { operator: null, sales: checkout.hqSalesApi })
  check('HQ void: unreadable detail keeps the record', t.status === 'unresolved' && t.reason === 'transport' && has(P, rec.id))
  route({ hq_sale_detail: () => json({ id: 's-7', status: 'voided', total: 5000 }, 200) })
  const v = await PC.confirmPendingOp(rec, { operator: null, sales: checkout.hqSalesApi })
  check('HQ void: voided read resolves', v.status === 'confirmed' && !has(P, rec.id))
}

// 9-9. 成功応答の必須項目（M1）：欠けていれば結果不明。空配列・null で補わない
{
  const cases = [
    ['sale without idempotency_key', () => staffCheckout.finalize(saleInput, operator, null), { id: 's-1', status: 'completed', total: 5000 }],
    ['sale with another key', () => staffCheckout.finalize(saleInput, operator, null), { ...saleOk, idempotency_key: 'checkout:other' }],
    ['sale without id', () => staffCheckout.finalize(saleInput, operator, null), { ...saleOk, id: undefined }],
    ['charge without idempotency_key', () => staffGinpay.chargeStore(chargeInput, operator, null), { ...chargeOk, idempotency_key: undefined }],
    ['charge with another amount', () => staffGinpay.chargeStore(chargeInput, operator, null), { ...chargeOk, amount: 1 }],
    ['charge of another type', () => staffGinpay.chargeStore(chargeInput, operator, null), { ...chargeOk, type: 'adjustment' }],
    ['refund without original transaction', () => staffGinpay.refund(refundInput, operator, null), { ...refundOk, original_transaction_id: null }],
    ['refund without id', () => staffGinpay.refund(refundInput, operator, null), { ...refundOk, id: undefined }],
    ['HQ refund with another key', () => ginpay.hqGinpayApi.refund(hqRefundInput, operator, null), { ...hqRefundOk, idempotency_key: 'hq-refund:other' }],
    ['ticket with empty tickets', () => tickets.issueTickets(ticketInput, operator, null), { tickets: [] }],
    ['ticket without tickets', () => tickets.issueTickets(ticketInput, operator, null), { idempotent: true }],
    ['ticket with fewer tickets than requested', () => tickets.issueTickets(ticketInput, operator, null), { tickets: [ticketOk.tickets[0]] }],
    ['ticket for another member', () => tickets.issueTickets(ticketInput, operator, null), { tickets: ticketOk.tickets.map((t) => ({ ...t, user_id: 'u-x' })) }],
    ['void still completed', () => checkout.hqSalesApi.void('s-1', '誤会計', 5000), { id: 's-1', status: 'completed', total: 5000 }],
    ['void of another sale', () => checkout.hqSalesApi.void('s-1', '誤会計', 5000), { id: 's-2', status: 'voided', total: 5000 }],
  ]
  for (const [label, call, body] of cases) {
    useOk(body); const o = await outcome(call)
    check(`incomplete response (${label}) -> RESULT_UNKNOWN`, isUnknownError(o), o.value)
  }
  useOk({ id: 's-1', status: 'voided', total: 5000 }); const v = await outcome(() => checkout.hqSalesApi.void('s-1', '誤会計', 5000))
  check('complete void response (voided, same id) is accepted', v.value && v.value.status === 'voided')
  useOk({ ...saleOk, idempotent: true }); const r = await outcome(() => staffCheckout.finalize(saleInput, operator, null))
  check('complete sale replay (idempotent) is accepted', r.value && r.value.id === 's-1')
  useOk({ ...ticketOk, idempotent: true }); const tr = await outcome(() => tickets.issueTickets(ticketInput, operator, null))
  check('complete ticket replay (idempotent) is accepted', tr.value && tr.value.tickets.length === 2)
}

// 9-10. 同時クリック・複数タブ
{
  resetPending()
  const draft = PC.draftCharge(chargeInput, operator)
  const [a, b] = await Promise.allSettled([
    P.beginPendingOp(draft, chargeInput, []),
    P.beginPendingOp(PC.draftCharge({ ...chargeInput, idempotencyKey: 'staff-store-charge:double' }, operator), {}, []),
  ])
  check('simultaneous clicks -> exactly one send is recorded, the other is blocked', a.status === 'fulfilled' && b.status === 'rejected' && b.reason instanceof P.PendingBlockedError && P.readPendingOps().length === 1)
  const same = await outcome(() => P.beginPendingOp(draft, chargeInput, []))
  check('second click with the same key is blocked too', same.error instanceof P.PendingBlockedError)
  const B = await import(pendingUrlFor('tab-b'))
  const fromB = await outcome(() => B.beginPendingOp(PC.draftRefund('ginpay_refund', 'c-1', refundInput, operator), {}, []))
  check('second tab sees the record and cannot start a mutation for the same client', fromB.error instanceof B.PendingBlockedError && B.getPendingView().ops.length === 1 && !B.isPendingInFlight(a.value.id))
  resetPending()
  const [x, y] = await Promise.allSettled([
    P.beginPendingOp(PC.draftHqVoid({ id: 's-5', total: 100 }), {}, []),
    B.beginPendingOp(PC.draftHqVoid({ id: 's-5', total: 100 }), {}, []),
  ])
  check('two tabs racing on the same target -> only one is recorded (shared lock)', [x, y].filter((r) => r.status === 'fulfilled').length === 1 && P.readPendingOps().length === 1)
  resetPending()
}

// 9-11. 画面：送信の前に記録する（記録に失敗したら送らない）
{
  const order = (file, before, after) => {
    const src = readFileSync(join(root, file), 'utf8')
    const i = src.indexOf(before)
    const j = src.indexOf(after, i)
    return i >= 0 && j > i
  }
  check('Checkout records before finalize', order('src/components/booking/Checkout.tsx', 'beginPendingOp(draftCheckout', 'api.finalize(input, current, approvedToken, expect)'))
  check('GINPay charge records before sending', order('src/components/ginpay/GinpayPanel.tsx', 'beginPendingOp(draftCharge', 'api.chargeStore(input, operator, approvalToken)'))
  check('GINPay refund records before sending', order('src/components/ginpay/GinpayPanel.tsx', 'beginPendingOp(draftRefund', 'api.refund(input, operator, approvalToken)'))
  check('Ticket issue records before sending', order('src/screens/AdminScreen.tsx', 'beginPendingOp(draftTicketIssue', 'issueTickets(input, current, approvalToken)'))
  check('HQ void records before sending', order('src/hq/screens/HqSalesLedgerScreen.tsx', 'beginPendingOp(draftHqVoid', 'hqSalesApi.void(id'))
}

// ── 10. R1：未解決の会計は、サーバーが決める顧客（resolve_pos_client_context）で止める ──
const SI = await import(saleIdentityUrl)
const anon = (key, clientId) => PC.draftCheckout({ ...saleInput, ...(clientId ? { client_id: clientId } : {}), idempotency_key: key }, operator)
{
  const raw = SI.resolveSaleIdentity({ client_id: 'c-1' })
  check('R1 raw client_id without trusted context -> anonymous, sale:anonymous only (client ignored like the server)', raw.context === 'anonymous' && raw.clientId === null && raw.targets.join() === 'sale:anonymous')
  const none = SI.resolveSaleIdentity({})
  check('R1 no client_id -> anonymous with sale:anonymous', none.context === 'anonymous' && none.targets.join() === 'sale:anonymous')
  const resv = SI.resolveSaleIdentity({ reservation_id: 'r-1' }, 'c-1')
  const resvNoClient = SI.resolveSaleIdentity({ reservation_id: 'r-2' }, null)
  const resvMismatch = SI.resolveSaleIdentity({ reservation_id: 'r-1', client_id: 'c-2' }, 'c-1')
  const resvUnknown = SI.resolveSaleIdentity({ reservation_id: 'r-1' })
  check('R1 reservation -> reservation + canonical reservation client', resv.context === 'reservation' && resv.clientId === 'c-1' && resv.targets.join() === 'reservation:r-1,client:c-1' && resvNoClient.clientId === null && resvNoClient.targets.join() === 'reservation:r-2')
  check('R1 reservation identity vs client mismatch or unknown reservation client -> anonymous (fail closed) and still locks the reservation', resvMismatch.context === 'anonymous' && resvMismatch.targets.includes('sale:anonymous') && resvMismatch.targets.includes('reservation:r-1') && resvUnknown.context === 'anonymous' && resvUnknown.targets.includes('sale:anonymous'))
  const scan = SI.resolveSaleIdentity({ scan_session_id: 'ss-1', client_id: 'c-3' })
  const scanOnly = SI.resolveSaleIdentity({ scan_session_id: 'ss-1' })
  check('R1 scan context with client -> scan identity on that client (no new verification)', scan.context === 'scan' && scan.clientId === 'c-3' && scan.targets.join() === 'client:c-3')
  check('R1 scan-only without client (B-1 limitation) -> anonymous (fail closed)', scanOnly.context === 'anonymous' && scanOnly.targets.includes('sale:anonymous'))
  const odd = [{ reservation_id: '' }, { reservation_id: ' r-1' }, { reservation_id: 42 }, { scan_session_id: {} }, { reservation_id: 'r-1', client_id: '' }]
  check('R1 unknown/malformed trusted context -> anonymous (fail closed)', odd.every((i) => { const x = SI.resolveSaleIdentity(i, 'c-1'); return x.context === 'anonymous' && x.targets.includes('sale:anonymous') }))
}
{
  resetPending()
  const draft = anon('checkout:anon-a', 'c-1')
  check('R1 draft with raw client_id records the server identity (anonymous), not client:c-1', draft.targets.join() === 'sale:anonymous' && draft.snapshot.context === 'anonymous' && draft.snapshot.clientId === null)
  const rec = await unknownOp(draft, { ...saleInput, client_id: 'c-1', idempotency_key: 'checkout:anon-a' }, [saleInput.quote_hash, operator.operatorToken])
  const otherClient = await outcome(() => P.beginPendingOp(anon('checkout:anon-b', 'c-2'), {}, []))
  const resvSale = await outcome(() => P.beginPendingOp(PC.draftCheckout({ ...saleInput, reservation_id: 'r-2', idempotency_key: 'checkout:resv-b' }, operator, 'c-2'), {}, []))
  check('R1 anonymous unknown -> selecting another customer cannot start a new anonymous checkout', otherClient.error instanceof P.PendingBlockedError && otherClient.error.op.id === rec.id)
  check('R1 anonymous unknown also blocks reservation checkouts on this device', resvSale.error instanceof P.PendingBlockedError && resvSale.error.op.id === rec.id)
  const T = await import(pendingUrlFor('tab-r1'))
  const fromT = await outcome(() => T.beginPendingOp(anon('checkout:anon-tab', 'c-3'), {}, []))
  check('R1 multi-tab: another tab cannot start an anonymous checkout while one is unresolved', fromT.error instanceof T.PendingBlockedError && fromT.error.op.id === rec.id)
  resetPending()
  const [x, y] = await Promise.allSettled([P.beginPendingOp(anon('checkout:race-a', 'c-1'), {}, []), T.beginPendingOp(anon('checkout:race-b', 'c-2'), {}, [])])
  check('R1 multi-tab: two tabs racing anonymous checkouts for different customers -> only one is recorded', [x, y].filter((r) => r.status === 'fulfilled').length === 1 && P.readPendingOps().length === 1)
  resetPending()
}
{
  // 旧形式：context が無く、送った client_id を client: として持つ（予約なし＝サーバーでは匿名だった会計）
  const legacySnapshot = { reservationId: null, clientId: 'c-1', stylistId: 'st-1', paymentMethod: 'cash', expectedTotal: 5000, ginpayAccountId: null, ticketIds: [], items: [{ source: 'service_menu', refId: 'cut', category: 'menu', unitPrice: 5000, quantity: 1, discount: 0 }], manualDiscount: 0 }
  const legacy = { id: 'checkout:legacy-1', kind: 'checkout', key: 'legacy-1', targets: ['client:c-1'], amount: 5000, snapshot: legacySnapshot, operatorId: 'm-1', operatorName: '担当A', state: 'unknown', createdAt: new Date().toISOString() }
  const legacyResv = { ...legacy, id: 'checkout:legacy-2', key: 'legacy-2', targets: ['reservation:r-5'], snapshot: { ...legacySnapshot, reservationId: 'r-5', clientId: null } }
  store.set(KEY, JSON.stringify({ v: 1, ops: [legacy, legacyResv] }))
  const before = storedRaw()
  check('R1 legacy records (no context, client:A only) are read, not treated as corrupt', P.getPendingView().failure === null && has(P, legacy.id) && has(P, legacyResv.id))
  const blocked = await outcome(() => P.beginPendingOp(anon('checkout:after-legacy', 'c-2'), {}, []))
  check('R1 legacy client:A-only record is treated as anonymous: a new anonymous sale for another customer does not slip through', blocked.error instanceof P.PendingBlockedError && blocked.error.op.id === legacy.id)
  check('R1 legacy records are kept as they are (not rewritten or deleted)', storedRaw() === before)
  const legacyExpect = PC.checkoutExpectation(legacy)
  check('R1 legacy anonymous record is confirmed only as anonymous; legacy reservation record cannot be confirmed (client unknown)', legacyExpect && legacyExpect.clientId === null && legacyExpect.reservationId === null && PC.checkoutExpectation(legacyResv) === null)
  store.set(KEY, JSON.stringify({ v: 1, ops: [{ ...legacy, id: 'checkout:bad', key: 'bad', snapshot: { ...legacySnapshot, context: 'anonymous' } }] }))
  check('R1 new-format record whose identity contradicts its targets -> corrupt (fail closed, record kept)', P.getPendingView().failure === 'corrupt' && store.has(KEY))
  resetPending()
}

// ── 11. R2：成功応答を記録した内容と照合する（実際の SQL 応答の項目だけを使う） ──
const resvInput = { ...saleInput, reservation_id: 'r-1', idempotency_key: 'checkout:resv-1' }
const resvExpect = checkout.saleExpectation(resvInput, 'c-1')
const resvOk = { ...saleOk, idempotency_key: resvInput.idempotency_key, client: { id: 'c-1', name: '山田' }, reservation: { id: 'r-1', starts_at: '2026-10-10T01:00:00Z', customer_name: '山田' } }
const gpInput = { ...resvInput, payment_method: 'ginpay', ginpay_account_id: 'a-1', idempotency_key: 'checkout:gp-1' }
const gpExpect = checkout.saleExpectation(gpInput, 'c-1')
const gpOk = { ...resvOk, idempotency_key: gpInput.idempotency_key, payment_method: 'ginpay', payments: [{ method: 'ginpay', amount: 5000 }], ginpay: [{ id: 'g-5', type: 'payment', amount: -5000, account_id: 'a-1', original_transaction_id: null, created_at: '2026-10-10T00:00:00Z' }] }
{
  const finalizeAnon = () => staffCheckout.finalize(saleInput, operator, null, checkout.saleExpectation(saleInput))
  const finalizeResv = () => staffCheckout.finalize(resvInput, operator, null, resvExpect)
  const cases = [
    ['sale total mismatch', finalizeAnon, { ...saleOk, total: 4000 }],
    ['sale key mismatch (another sale replayed)', finalizeAnon, { ...saleOk, idempotency_key: 'checkout:someone-else' }],
    ['sale identity mismatch: anonymous sale returned with a client', finalizeAnon, { ...saleOk, client: { id: 'c-1', name: '山田' } }],
    ['sale identity mismatch: reservation sale for another client', finalizeResv, { ...resvOk, client: { id: 'c-9', name: '別人' } }],
    ['sale identity mismatch: another reservation', finalizeResv, { ...resvOk, reservation: { ...resvOk.reservation, id: 'r-9' } }],
    ['sale payment mismatch: other method', finalizeAnon, { ...saleOk, payment_method: 'credit', payments: [{ method: 'credit', amount: 5000 }] }],
    ['sale payment identity mismatch: GINPay from another account', () => staffCheckout.finalize(gpInput, operator, null, gpExpect), { ...gpOk, ginpay: [{ ...gpOk.ginpay[0], account_id: 'a-2' }] }],
    ['sale status voided (staff_finalize_sale never replays voided)', finalizeAnon, { ...saleOk, status: 'voided' }],
    ['charge account mismatch', () => staffGinpay.chargeStore({ ...chargeInput, accountId: 'a-1' }, operator, null), { ...chargeOk, account_id: 'a-2' }],
    ['charge amount mismatch', () => staffGinpay.chargeStore(chargeInput, operator, null), { ...chargeOk, amount: 30000 }],
    ['charge client mismatch', () => staffGinpay.chargeStore(chargeInput, operator, null), { ...chargeOk, client_id: 'c-9', root_client_id: 'c-9' }],
    ['refund original transaction mismatch', () => staffGinpay.refund(refundInput, operator, null), { ...refundOk, original_transaction_id: 't-other' }],
    ['refund account mismatch', () => staffGinpay.refund(refundInput, operator, null), { ...refundOk, account_id: 'a-2' }],
    ['ticket type mismatch', () => tickets.issueTickets(ticketInput, operator, null), { tickets: ticketOk.tickets.map((t) => ({ ...t, type: 'otoku' })) }],
    ['ticket price mismatch', () => tickets.issueTickets(ticketInput, operator, null), { tickets: ticketOk.tickets.map((t) => ({ ...t, amount: 400 })) }],
    ['duplicate ticket ID', () => tickets.issueTickets(ticketInput, operator, null), { tickets: [ticketOk.tickets[0], ticketOk.tickets[0]] }],
    ['HQ void total mismatch', () => checkout.hqSalesApi.void('s-1', '誤会計', 5000), { id: 's-1', status: 'voided', total: 4000 }],
  ]
  for (const [label, call, body] of cases) {
    useOk(body); const o = await outcome(call)
    check(`R2 ${label} -> RESULT_UNKNOWN (response_mismatch), not success`, isUnknownError(o) && o.error.code === 'response_mismatch', o.value)
  }
  const fixtures = [
    ['anonymous cash sale (sale_json)', finalizeAnon, saleOk],
    ['reservation sale (sale_json)', finalizeResv, resvOk],
    ['GINPay reservation sale (sale_json with ginpay payment)', () => staffCheckout.finalize(gpInput, operator, null, gpExpect), gpOk],
    ['store charge (ginpay_tx_json, family account)', () => staffGinpay.chargeStore(chargeInput, operator, null), { ...chargeOk, client_id: 'c-1-family', root_client_id: 'c-1', balance: 3000, idempotent: false }],
    ['refund (ginpay_tx_json)', () => staffGinpay.refund(refundInput, operator, null), { ...refundOk, balance: 2000, idempotent: false }],
    ['ticket issue (row_to_json(tickets))', () => tickets.issueTickets(ticketInput, operator, null), { tickets: ticketOk.tickets.map((t) => ({ ...t, title: '割引券', used: false, issued_by: '担当A', created_at: '2026-10-10T00:00:00Z' })) }],
    ['HQ void (sale_json voided)', () => checkout.hqSalesApi.void('s-1', '誤会計', 5000), { ...saleOk, status: 'voided', voided_at: '2026-10-10T02:00:00Z', voided_by: '本部', void_reason: '誤会計' }],
  ]
  for (const [label, call, body] of fixtures) {
    useOk(body); const o = await outcome(call)
    check(`R2 real SQL response fixture accepted: ${label}`, !o.error && o.value && (o.value.ok !== false) && !('error' in o.value), o.error && o.error.code)
  }
}
{
  // 確認（confirm）経路でも、合わない応答では記録を消さない
  resetPending()
  const rec = await unknownOp(PC.draftCheckout(resvInput, operator, 'c-1'), resvInput, [saleInput.quote_hash, operator.operatorToken])
  route({ staff_finalize_sale: () => json({ ...resvOk, client: { id: 'c-9', name: '別人' } }, 200) })
  const bad = await PC.confirmPendingOp(rec, { operator, checkout: staffCheckout })
  check('R2 checkout confirm: identity mismatch keeps the record (response_mismatch)', bad.status === 'unresolved' && bad.reason === 'response_mismatch' && has(P, rec.id))
  route({ staff_finalize_sale: () => json(resvOk, 200) })
  const ok = await PC.confirmPendingOp(rec, { operator, checkout: staffCheckout })
  check('R2 checkout confirm: matching reservation/client response resolves', ok.status === 'confirmed' && !has(P, rec.id))
  const v = await unknownOp(PC.draftHqVoid({ id: 's-8', total: 5000 }), { id: 's-8' }, [])
  route({ hq_sale_detail: () => json({ ...saleOk, id: 's-8', status: 'voided', total: 4000 }, 200) })
  const vb = await PC.confirmPendingOp(v, { operator: null, sales: checkout.hqSalesApi })
  check('R2 HQ void confirm: voided with another total keeps the record', vb.status === 'unresolved' && vb.reason === 'response_mismatch' && has(P, v.id))
  resetPending()
  // 口座を記録していない旧形式の本部返金の記録（再読み込み後でメモリにも送信内容が無い）
  const legacyRefund = { id: `hq_ginpay_refund:${hqRefundInput.idempotencyKey}`, kind: 'hq_ginpay_refund', key: hqRefundInput.idempotencyKey, targets: ['client:c-1', 'gtx:t-9'], amount: 800, snapshot: { clientId: 'c-1', transactionId: 't-9', amount: 800 }, operatorId: null, operatorName: null, state: 'unknown', createdAt: new Date().toISOString() }
  store.set(KEY, JSON.stringify({ v: 1, ops: [legacyRefund] }))
  const r = legacyRefund
  const R2 = await import(pendingUrlFor('reload-r2'))
  const RC2 = await import(confirmUrlFor('reload-r2'))
  route({ hq_ginpay_ledger: () => json({ transactions: [hqRefundOk] }, 200) })
  const noOrig = await RC2.confirmPendingOp(R2.readPendingOps().find((o) => o.id === r.id), { operator, ginpay: ginpay.hqGinpayApi })
  check('R2 refund confirm after reload: original transaction not in ledger -> account cannot be verified, record kept', noOrig.status === 'unresolved' && noOrig.reason === 'identity_unverified' && has(R2, r.id))
  route({ hq_ginpay_ledger: () => json({ transactions: [hqRefundOk, { ...txBase, id: 't-9', type: 'charge_store', amount: 800, idempotency_key: 'k-orig', original_transaction_id: null }] }, 200) })
  const withOrig = await RC2.confirmPendingOp(R2.readPendingOps().find((o) => o.id === r.id), { operator, ginpay: ginpay.hqGinpayApi })
  check('R2 refund confirm after reload: account taken from the original transaction in the ledger -> resolves', withOrig.status === 'confirmed' && !has(R2, r.id))
  resetPending()
}

// ── 12. R3 / L1：チケット発行中の顧客切替（canResetCustomer は端末の記録も見る） ──
const guardUrl = load('src/utils/ticketIssueGuard.ts', { './pendingOps': pendingUrlFor('tab-a') })
const G = await import(guardUrl)
const emptyView = { ops: [], failure: null }
const adminSrc = readFileSync(join(root, 'src/screens/AdminScreen.tsx'), 'utf8').replace(/\r\n/g, '\n')
{
  check('R3 ticket in flight -> "次のお客様" (customer reset) is disabled', !G.canResetCustomer({ sending: true, displayedUserId: 'u-1', view: emptyView }) && !G.canResetCustomer({ sending: true, displayedUserId: null, view: emptyView }) && G.canResetCustomer({ sending: false, displayedUserId: 'u-1', view: emptyView }))
  check('R3 switch A -> B: a response issued for A is never added to B (or to an empty screen)', G.ticketsForDisplayed('u-2', 'u-1', ticketOk.tickets) === null && G.ticketsForDisplayed(null, 'u-1', ticketOk.tickets) === null)
  check('R3 stale callback: only the displayed member\'s own tickets are shown', G.ticketsForDisplayed('u-1', 'u-1', ticketOk.tickets)?.length === 2 && G.ticketsForDisplayed('u-1', 'u-1', [{ ...ticketOk.tickets[0], user_id: 'u-x' }]) === null)
  const guardCall = 'canResetCustomer({ sending: issueSendingRef.current, displayedUserId: displayedUserRef.current, view: getPendingView() })'
  check('R3 AdminScreen wiring: every reset path uses canResetCustomer with the stored records, tickets only via ticketsForDisplayed, records settled before the displayed-user check',
    adminSrc.includes(`function handleReset() {\n    // 発行の送信・確認中、表示中の会員の発行が未解決（送信中・結果不明。画面を開き直す前の送信を含む）のあいだは切り替えない\n    if (!${guardCall}) return`)
    && adminSrc.includes(`const handleScanned = useCallback(async (text: string) => {\n    // 新しい読み取りも顧客の切り替え。表示中の会員の発行が未解決なら受け付けない（読み取りは scan 画面だけだが念のため）\n    if (!${guardCall}) return`)
    && /ticketsForDisplayed\(displayedUserRef\.current, input\.userId, issued\)/.test(adminSrc) && (adminSrc.match(/setUserTickets\(prev =>/g) ?? []).length === 1
    && adminSrc.includes("await settlePendingOp(rec.id, 'not_executed').catch(() => undefined)\n        if (!isDisplayed(input.userId)) return"))
}
{
  resetPending()
  route({})
  const rec = await P.beginPendingOp(PC.draftTicketIssue(ticketInput, operator), ticketInput, [operator.operatorToken])
  const sent = await outcome(() => tickets.issueTickets(ticketInput, operator, null))
  if (isUnknownError(sent)) await P.markPendingUnknown(rec.id)
  const again = await outcome(() => P.beginPendingOp(PC.draftTicketIssue({ ...ticketInput, idempotencyKey: 'ticket-issue:new-key' }, operator), {}, []))
  check('R3 RESULT_UNKNOWN -> a new issue for the same user_id is refused', isUnknownError(sent) && again.error instanceof P.PendingBlockedError && again.error.op.id === rec.id)
  const U = await import(pendingUrlFor('unmount-r3'))
  check('R3 after unmount (new screen instance) the pending ticket record is kept and still blocks the same user', has(U, rec.id) && U.findBlockingOp(U.readPendingOps(), 'ticket_issue', ['user:u-1'])?.id === rec.id && !U.findBlockingOp(U.readPendingOps(), 'ticket_issue', ['user:u-2']))
  resetPending()
}

// ── 13. H1：GINPay は口座（gpaccount:）でも止める。顧客の統合後も同じ口座の別キーの操作を通さない ──
const mergedCharge = (clientId, accountId, key) => ({ ...chargeInput, clientId, accountId, idempotencyKey: key })
const mergedRefund = (clientId, accountId, key, transactionId = 't-7') => ({ ...refundInput, clientId, accountId, transactionId, idempotencyKey: key })
/** GinpayPanel と同じ順序：記録 → 送る直前の確認 → 送信。確認で止まれば送らずに記録を消す */
async function panelSend(input, kind, sendAccountId = input.accountId) {
  const draft = kind === 'charge' ? PC.draftCharge(input, operator) : PC.draftRefund(kind, input.clientId, input, operator)
  const rec = await P.beginPendingOp(draft, input, [operator.operatorToken])
  try {
    await P.assertPendingSendable(rec.id, sendAccountId)
  } catch (error) {
    await P.settlePendingOp(rec.id, 'not_executed')
    return { blocked: error, rec }
  }
  return { sent: kind === 'charge' ? await staffGinpay.chargeStore(input, operator, null) : await staffGinpay.refund(input, operator, null), rec }
}
{
  resetPending()
  // A の口座 a-1 へのチャージが結果不明 → A を B に統合 → B の画面には同じ口座 a-1 が出る
  const recA = await unknownOp(PC.draftCharge(mergedCharge('c-A', 'a-1', 'k-merge-a'), operator), mergedCharge('c-A', 'a-1', 'k-merge-a'))
  const chargeB = await outcome(() => P.beginPendingOp(PC.draftCharge(mergedCharge('c-B', 'a-1', 'k-merge-b'), operator), {}, []))
  check('H1 A->B merge: a charge from B to the same account with another key is refused', chargeB.error instanceof P.PendingBlockedError && chargeB.error.op.id === recA.id)
  const refundB = await outcome(() => P.beginPendingOp(PC.draftRefund('ginpay_refund', 'c-B', mergedRefund('c-B', 'a-1', 'k-merge-r'), operator), {}, []))
  check('H1 A->B merge: a refund from B on the same account is refused', refundB.error instanceof P.PendingBlockedError && refundB.error.op.id === recA.id)
  const hqB = await outcome(() => P.beginPendingOp(PC.draftRefund('hq_ginpay_refund', 'c-B', mergedRefund('c-B', 'a-1', 'k-merge-hq'), null), {}, []))
  const hqOther = await outcome(() => P.beginPendingOp(PC.draftRefund('hq_ginpay_refund', 'c-B', mergedRefund('c-B', 'a-3', 'k-other-hq', 't-8'), null), {}, []))
  check('H1 HQ refund on the same account is refused; another account is not', hqB.error instanceof P.PendingBlockedError && hqB.error.op.id === recA.id && !hqOther.error)
  const panelLock = P.findBlockingOp(P.readPendingOps(), 'ginpay_charge', ['client:c-B', 'gpaccount:a-1', 'gpaccount:a-3'])
  check('H1 panel lock for B (client + its accounts incl. merged ones) shows the unresolved charge from A', panelLock?.id === recA.id)
  resetPending()
}
{
  resetPending(); requests.length = 0
  const noAccount = await outcome(() => P.beginPendingOp(PC.draftCharge({ ...chargeInput, accountId: undefined }, operator), chargeInput, []))
  const emptyAccount = await outcome(() => P.beginPendingOp(PC.draftRefund('ginpay_refund', 'c-1', { ...refundInput, accountId: '' }, operator), refundInput, []))
  check('H1 missing account_id -> not recorded, not sent (account_unknown); client id alone is never enough',
    noAccount.error instanceof P.PendingStoreError && noAccount.error.reason === 'account_unknown' && emptyAccount.error instanceof P.PendingStoreError && emptyAccount.error.reason === 'account_unknown' && !store.has(KEY) && requests.length === 0)
}
{
  // 旧形式：口座を持たない GINPay の記録（チャージは accountId null、返金は accountId 自体が無い）
  const legacyCharge = { id: 'ginpay_charge:legacy-c', kind: 'ginpay_charge', key: 'legacy-c', targets: ['client:c-L'], amount: 3000, snapshot: { clientId: 'c-L', accountId: null, amount: 3000, paymentMethod: 'cash' }, operatorId: 'm-1', operatorName: '担当A', state: 'unknown', createdAt: new Date().toISOString() }
  const legacyRefund = { id: 'ginpay_refund:legacy-r', kind: 'ginpay_refund', key: 'legacy-r', targets: ['client:c-L', 'gtx:t-L'], amount: 500, snapshot: { clientId: 'c-L', transactionId: 't-L', amount: 500 }, operatorId: 'm-1', operatorName: '担当A', state: 'unknown', createdAt: new Date().toISOString() }
  for (const legacy of [legacyCharge, legacyRefund]) {
    store.set(KEY, JSON.stringify({ v: 1, ops: [legacy] }))
    const before = storedRaw()
    const charge = await outcome(() => P.beginPendingOp(PC.draftCharge(mergedCharge('c-Z', 'a-9', `k-after-${legacy.key}`), operator), {}, []))
    const hq = await outcome(() => P.beginPendingOp(PC.draftRefund('hq_ginpay_refund', 'c-Z', mergedRefund('c-Z', 'a-9', `k-hq-${legacy.key}`), null), {}, []))
    const ticket = await outcome(() => P.beginPendingOp(PC.draftTicketIssue({ ...ticketInput, idempotencyKey: `k-t-${legacy.key}` }, operator), {}, []))
    check(`H1 legacy ${legacy.kind} without account_id: read (not corrupt), kept as is, and every GINPay mutation fails closed (other mutations unaffected)`,
      P.getPendingView().failure === null && charge.error instanceof P.PendingBlockedError && charge.error.op.id === legacy.id
      && hq.error instanceof P.PendingBlockedError && !ticket.error && P.readPendingOps().some((o) => o.id === legacy.id)
      && P.pendingErrorMessage(charge.error).includes('口座の記録が無い'))
    await P.settlePendingOp(ticket.value.id, 'not_executed')
    check(`H1 legacy ${legacy.kind} record is not rewritten or migrated`, storedRaw() === before)
  }
  resetPending()
}
{
  resetPending(); requests.length = 0
  route({ staff_ginpay_charge_store: () => json(chargeOk, 200) })
  const changed = await panelSend(chargeInput, 'charge', 'a-2')
  check('H1 account identity changed before sending (send account != recorded) -> not sent, record removed', changed.blocked instanceof P.PendingStoreError && changed.blocked.reason === 'account_mismatch' && calls('staff_ginpay_charge_store') === 0 && P.readPendingOps().length === 0)
  // 記録の後に、保存領域の記録が別の口座に書き換えられた
  const rec = await P.beginPendingOp(PC.draftCharge(chargeInput, operator), chargeInput, [])
  const tampered = JSON.parse(storedRaw())
  tampered.ops[0].snapshot.accountId = 'a-2'; tampered.ops[0].targets = ['client:c-1', 'gpaccount:a-2']
  store.set(KEY, JSON.stringify(tampered))
  const t = await outcome(() => P.assertPendingSendable(rec.id, 'a-1'))
  check('H1 stored record re-resolved to another account -> refuses to send (account_mismatch)', t.error instanceof P.PendingStoreError && t.error.reason === 'account_mismatch' && calls('staff_ginpay_charge_store') === 0)
  resetPending()
  // 結果不明の確認（再送）も、送る口座が記録と違えば送らない
  const unk = await unknownOp(PC.draftCharge(chargeInput, operator), { ...chargeInput, accountId: 'a-2' })
  route({ staff_ginpay_ledger: () => json({ transactions: [] }, 200), staff_ginpay_charge_store: () => json(chargeOk, 200) })
  const conf = await PC.confirmPendingOp(unk, { operator, ginpay: staffGinpay })
  check('H1 confirm resend with a different account than recorded -> not resent, record kept', conf.status === 'unresolved' && conf.reason === 'identity_unverified' && calls('staff_ginpay_charge_store') === 0 && has(P, unk.id))
  resetPending()
}
{
  resetPending()
  const T = await import(pendingUrlFor('tab-h1'))
  const [x, y] = await Promise.allSettled([
    P.beginPendingOp(PC.draftCharge(mergedCharge('c-A', 'a-1', 'k-race-a'), operator), {}, []),
    T.beginPendingOp(PC.draftCharge(mergedCharge('c-B', 'a-1', 'k-race-b'), operator), {}, []),
  ])
  check('H1 Web Locks cross-tab: two tabs charging the same account for different (merged) clients -> only one is recorded', [x, y].filter((r) => r.status === 'fulfilled').length === 1 && P.readPendingOps().length === 1)
  resetPending()
}
{
  resetPending(); requests.length = 0
  route({ staff_ginpay_charge_store: () => json(chargeOk, 200) })
  const rec = await P.beginPendingOp(PC.draftCharge(chargeInput, operator), chargeInput, [])
  // 記録から送信までの間に、ロックを使わない別の画面（旧版など）が同じ口座の返金を保存領域へ書いた
  const other = { id: 'ginpay_refund:k-sneak', kind: 'ginpay_refund', key: 'k-sneak', targets: ['client:c-B', 'gtx:t-7', 'gpaccount:a-1'], amount: 100, snapshot: { clientId: 'c-B', transactionId: 't-7', accountId: 'a-1', amount: 100 }, operatorId: null, operatorName: null, state: 'sending', createdAt: new Date().toISOString() }
  const raw = JSON.parse(storedRaw()); raw.ops.push(other); store.set(KEY, JSON.stringify(raw))
  const race = await outcome(() => P.assertPendingSendable(rec.id, 'a-1'))
  check('H1 register->send race: a same-account record that appeared after registration stops the send', race.error instanceof P.PendingBlockedError && race.error.op.id === other.id && calls('staff_ginpay_charge_store') === 0)
  resetPending()
  const rec2 = await P.beginPendingOp(PC.draftCharge(chargeInput, operator), chargeInput, [])
  store.set(KEY, JSON.stringify({ v: 1, ops: [] })) // 別タブが記録を消した
  const gone = await outcome(() => P.assertPendingSendable(rec2.id, 'a-1'))
  check('H1 register->send race: own record removed by another tab -> not sent (verify_failed)', gone.error instanceof P.PendingStoreError && gone.error.reason === 'verify_failed')
  resetPending()
  const okSend = await panelSend(chargeInput, 'charge')
  check('H1 no conflict: recorded -> checked -> sent once with the recorded account', okSend.sent?.ok === true && calls('staff_ginpay_charge_store') === 1 && requests.find((r) => r.url.endsWith('/rpc/staff_ginpay_charge_store'))?.body.p_account_id === 'a-1')
  await P.settlePendingOp(okSend.rec.id, 'server_confirmed')
  resetPending()
}

// ── 14. M1：顧客統合後の会計の再照合（読み取りで統合を確かめたときだけ） ──
{
  const merged = { ...resvOk, client: { id: 'c-2', name: '統合先' } }
  useOk(merged, { client: { id: 'c-2', name: '統合先', app_linked: false } }); requests.length = 0
  const ok = await outcome(() => staffCheckout.finalize(resvInput, operator, null, resvExpect))
  const lookup = requests.find((r) => r.url.endsWith('/rpc/staff_checkout_context'))?.body
  check('M1 customer merge replay: sale_json returns the current root (c-2) and the read-only context proves c-1 now resolves to c-2 -> accepted', !ok.error && ok.value?.id === 's-1' && lookup?.p_client_id === 'c-1' && lookup?.p_reservation_id === null)
  useOk({ ...resvOk, client: { id: 'c-9', name: '別人' } }, { client: { id: 'c-2', name: '統合先', app_linked: false } })
  const unrelated = await outcome(() => staffCheckout.finalize(resvInput, operator, null, resvExpect))
  check('M1 unrelated client (not the proven merge target) -> response_mismatch', isUnknownError(unrelated) && unrelated.error.code === 'response_mismatch')
  route({ staff_finalize_sale: () => json(merged, 200) }) // 統合の確認が読めない
  const unreadable = await outcome(() => staffCheckout.finalize(resvInput, operator, null, resvExpect))
  check('M1 merge cannot be proven (read-only lookup fails) -> response_mismatch, not success', isUnknownError(unreadable) && unreadable.error.code === 'response_mismatch')
  useOk({ ...saleOk, client: { id: 'c-2', name: '統合先' } }, { client: { id: 'c-2', name: '統合先', app_linked: false } })
  const anonClient = await outcome(() => staffCheckout.finalize(saleInput, operator, null, checkout.saleExpectation(saleInput)))
  check('M1 a different client id alone is never success (anonymous sale returned with a client)', isUnknownError(anonClient) && anonClient.error.code === 'response_mismatch')
}
{
  resetPending()
  const rec = await unknownOp(PC.draftCheckout(resvInput, operator, 'c-1'), resvInput, [saleInput.quote_hash, operator.operatorToken])
  route({ staff_finalize_sale: () => json({ ...resvOk, client: { id: 'c-2', name: '統合先' } }, 200), staff_checkout_context: () => json({ client: { id: 'c-1', name: '山田' } }, 200) })
  const notMerged = await PC.confirmPendingOp(rec, { operator, checkout: staffCheckout })
  check('M1 confirm: client changed without a merge -> record kept (response_mismatch)', notMerged.status === 'unresolved' && notMerged.reason === 'response_mismatch' && has(P, rec.id))
  route({ staff_finalize_sale: () => json({ ...resvOk, client: { id: 'c-2', name: '統合先' } }, 200), staff_checkout_context: () => json({ client: { id: 'c-2', name: '統合先' } }, 200) })
  const mergedOut = await PC.confirmPendingOp(rec, { operator, checkout: staffCheckout })
  check('M1 confirm: sale replay after a proven A->B merge resolves the record', mergedOut.status === 'confirmed' && !has(P, rec.id))
  resetPending()
}

// ── 15. L1：顧客を切り替える導線は、画面の状態ではなく端末の記録で止める ──
{
  resetPending()
  const rec = await P.beginPendingOp(PC.draftTicketIssue(ticketInput, operator), ticketInput, [operator.operatorToken])
  // 画面を開き直した（新しい画面は issueLoading も送信中フラグも false）
  const remount = await import(pendingUrlFor('remount-l1'))
  const fresh = { sending: false, displayedUserId: 'u-1', view: remount.getPendingView() }
  check('L1 component remount while issuing: the new screen still cannot reset (record is sending)', remount.getPendingView().ops[0]?.state === 'sending' && !G.canResetCustomer(fresh))
  check('L1 ticket issue sending: reset blocked for that member only', !G.canResetCustomer({ sending: false, displayedUserId: 'u-1', view: P.getPendingView() }) && G.canResetCustomer({ sending: false, displayedUserId: 'u-2', view: P.getPendingView() }))
  await P.markPendingUnknown(rec.id)
  check('L1 ticket issue unknown: reset still blocked, record kept', !G.canResetCustomer({ sending: false, displayedUserId: 'u-1', view: P.getPendingView() }) && has(P, rec.id))
  const buttons = (label) => {
    const i = adminSrc.indexOf(label)
    const start = adminSrc.lastIndexOf('<button', i)
    return adminSrc.slice(start, i)
  }
  const nextButtons = adminSrc.split('次のお客様\n').slice(0, -1).map((_, k, arr) => arr.slice(0, k + 1).join('次のお客様\n')).map((pre) => pre.slice(pre.lastIndexOf('<button')))
  check('L1 "次のお客様" (all 4 buttons) go through handleReset and are disabled by the same canResetCustomer result',
    nextButtons.length === 4 && nextButtons.every((b) => b.includes('onClick={handleReset}') && b.includes('disabled={!canReset}'))
    && !G.canResetCustomer({ sending: false, displayedUserId: 'u-1', view: P.getPendingView() }))
  const visitDone = buttons(`\n${' '.repeat(20)}来店完了\n`)
  check('L1 "来店完了" goes through handleReset, disabled by canResetCustomer (not only the local issueLoading)',
    visitDone.includes('onClick={handleReset}') && visitDone.includes('disabled={!canReset}') && !visitDone.includes('disabled={issueLoading}'))
  check('L1 bottom state uses the stored records (usePendingView) for canReset', adminSrc.includes('const canReset = canResetCustomer({ sending: issueLoading, displayedUserId: scannedData?.userId ?? null, view: pendingView })'))
  // 遅れて返った応答：本物の発行関数の応答を、切り替え後の会員の画面には反映しない
  route({ staff_issue_tickets: () => json(ticketOk, 200) })
  const late = await tickets.issueTickets(ticketInput, operator, null)
  check('L1 stale callback: a late issue response for u-1 is not applied to u-2, only to u-1', G.ticketsForDisplayed('u-2', ticketInput.userId, late.tickets) === null && G.ticketsForDisplayed('u-1', ticketInput.userId, late.tickets)?.length === 2)
  check('L1 store failure while a member is displayed -> reset fails closed; no member displayed -> allowed', !G.canResetCustomer({ sending: false, displayedUserId: 'u-3', view: { ops: [], failure: 'corrupt' } }) && G.canResetCustomer({ sending: false, displayedUserId: null, view: { ops: [], failure: 'corrupt' } }))
  resetPending()
}

console.log(`[pos-b2a] ${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
console.log('[pos-b2a] PASS all checks')
