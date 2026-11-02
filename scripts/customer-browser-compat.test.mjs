import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const homeSource = await readFile(new URL('../src/v2/V2Home.tsx', import.meta.url), 'utf8')
const passkeySource = (await readFile(new URL('../src/features/customerAccess/passkeys.ts', import.meta.url), 'utf8'))
  .replaceAll('import.meta.env.VITE_SUPABASE_URL', "'https://kfufxzmucjljjouzpumi.supabase.co'")
  .replaceAll('import.meta.env.VITE_CUSTOMER_ACCESS_ENABLED', "'true'")
  .replaceAll('import.meta.env.VITE_SUPABASE_ANON_KEY', "'local-fake-public-key'")
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText

function homeFixture(empty = false) {
  const context = vm.createContext({ exports: {} })
  const data = vm.runInContext(`
    Array.prototype.at = undefined;
    ({ styles: ${empty ? '[]' : "[{id:'style-1',title:'パンチパーマ',price:8000,isPublished:true}]"},
       categories: [{id:'昭和の漢',titles:['パンチパーマ']}] })`, context)
  const jsx = (type, props) => ({ type, props })
  const modules = {
    'react': { useMemo: fn => fn(), useEffect: () => {}, useLayoutEffect: () => {}, useState: value => [value, () => {}], useRef: () => ({ current: null }) },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'framer-motion': { motion: { div: 'div', article: 'article' }, AnimatePresence: 'presence', useReducedMotion: () => true },
    'lucide-react': { ArrowRight: 'arrow', Sparkle: 'spark' },
    '../utils/styleStorage': { loadStyles: () => data.styles },
    '../data/styleLibraryImages': { resolveStyleLibraryImageUrl: () => '/local-photo.jpg' },
    '../data/styleCategories': { UI_CATEGORIES: data.categories },
    '../data/reserveLinks': { getReserveUrl: () => '', getStyleMenuCode: () => 'perm-punch' },
    '../utils/bookingCoupons': { ensurePriceRules: async () => {}, menuPrice: () => ({ price: 8000, normal: 9000 }) },
    '../features/johnny/bookingIntent': { requestJohnny: () => {} },
    './V2GinpayBar': { V2GinpayBar: 'ginpay' },
    './usualPicks': { loadUsual: async () => null },
    '../utils/customerSession': { getCustomerSession: () => null },
  }
  context.require = name => { assert.ok(modules[name], name); return modules[name] }
  vm.runInContext(compile(homeSource), context)
  return context.exports.V2Home
}

test('actual home renders its selected style when Array.at is unavailable', () => {
  const tree = homeFixture()({ onGinpay: () => {} })
  const content = JSON.stringify(tree)
  assert.match(content, /この髪型でAI予約する/)
  assert.match(content, /¥8,000/)
})

test('an empty style library still opens the Johnny consultation entry on older browsers', () => {
  const content = JSON.stringify(homeFixture(true)({ onGinpay: () => {} }))
  assert.match(content, /AI予約/)
})

function passkeyFixture(fetcher) {
  const timers = new Map(), calls = []
  let next = 0
  const modules = {
    '../../utils/customerSession': { getCustomerSession: () => 'fake-session-'.repeat(4), clearCustomerSession: () => {}, saveCustomerSession: () => {} },
    '../../utils/storage': {},
    '../../utils/userId': { USER_ID_KEY: 'local-user' },
    '../../../supabase/functions/_shared/customer-environment.ts': {
      customerAccessEnabled: () => true,
      customerEnvironment: () => ({ base: 'https://kfufxzmucjljjouzpumi.supabase.co' }),
    },
  }
  const context = vm.createContext({
    exports: {}, AbortSignal: {}, AbortController,
    setTimeout: (fn, delay) => { assert.equal(delay, 20000); timers.set(++next, fn); return next },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => { calls.push({ url, options }); return fetcher(options) },
    require: name => { assert.ok(modules[name], name); return modules[name] },
  })
  vm.runInContext(compile(passkeySource), context)
  return { client: context.exports, timers, calls }
}

test('actual passkey status requests work without AbortSignal.timeout and release their timer', async () => {
  const f = passkeyFixture(async () => Response.json({ registered: true }))
  assert.equal((await f.client.passkeyStatus()).registered, true)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, 'https://kfufxzmucjljjouzpumi.supabase.co/functions/v1/customer-passkeys')
  assert.equal(f.calls[0].options.signal.aborted, false)
  assert.equal(f.timers.size, 0)
})

test('a stalled passkey request aborts after its deadline on browsers without the new timeout API', async () => {
  const f = passkeyFixture(({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const request = f.client.passkeyStatus()
  assert.equal(f.timers.size, 1)
  for (const expire of f.timers.values()) expire()
  await assert.rejects(request, error => error.name === 'AbortError')
  assert.equal(f.timers.size, 0)
})

test('network and invalid JSON failures also release the passkey request timer', async () => {
  for (const response of [async () => { throw new Error('offline') }, async () => ({ ok: true, json: async () => { throw new Error('invalid JSON') } })]) {
    const f = passkeyFixture(response)
    await assert.rejects(f.client.passkeyStatus())
    assert.equal(f.timers.size, 0)
  }
})
