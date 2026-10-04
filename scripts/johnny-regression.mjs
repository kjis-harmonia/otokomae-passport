#!/usr/bin/env node
// JOHNNY Phase 1 regression checks that do not require Production/Staging or a live DB.
// DB behavior is also covered by supabase/tests/preflight_johnny.sql; this runner catches
// Edge handler and UI flag regressions early.

import { webcrypto } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const handlerPath = join(root, 'supabase', 'functions', 'johnny-operator', 'handler.ts')
const migrationPath = join(root, 'supabase', 'migrations', '20261008000000_johnny_phase1.sql')
const sqlTestPath = join(root, 'supabase', 'tests', 'preflight_johnny.sql')

if (!globalThis.crypto) globalThis.crypto = webcrypto

const checks = []
const auditWriteRpcs = new Set([
  'johnny_record_session',
  'johnny_record_message',
  'johnny_record_tool_call',
  'johnny_create_action_intent',
  'johnny_transition_action_intent',
])

function check(name, fn) {
  checks.push({ name, fn })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertIncludes(text, needle, label) {
  assert(text.includes(needle), `${label} missing: ${needle}`)
}

function readRel(path) {
  const full = join(root, path)
  assert(existsSync(full), `missing file: ${path}`)
  return readFileSync(full, 'utf8')
}

async function loadHandler() {
  assert(existsSync(handlerPath), `missing handler: ${relative(root, handlerPath)}`)
  const source = readFileSync(handlerPath, 'utf8')
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      isolatedModules: true,
      verbatimModuleSyntax: true,
    },
    fileName: handlerPath,
  }).outputText
  const url = `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`
  return import(url)
}

function fixedUuidFactory() {
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
  ]
  let i = 0
  return () => ids[i++] ?? `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`
}

function makeRequest(body, method = 'POST') {
  return new Request('http://localhost/johnny-operator', {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  })
}

function makeDeps(rpc, env = { JOHNNY_ENABLED: 'true' }) {
  const calls = []
  return {
    calls,
    deps: {
      env: (name) => env[name],
      now: () => new Date('2026-10-04T03:00:00.000Z'),
      uuid: fixedUuidFactory(),
      rpc: async (name, args) => {
        calls.push({ name, args })
        return rpc(name, args)
      },
    },
  }
}

async function jsonOf(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`response is not JSON: ${text}`)
  }
}

function ok(data) {
  return { data, error: null }
}

function rpcError(code, message = code) {
  return { data: null, error: { code, message } }
}

const { handleJohnny } = await loadHandler()

check('JOHNNY_ENABLED=false stops before every RPC', async () => {
  const { calls, deps } = makeDeps(
    async () => {
      throw new Error('RPC must not be called while JOHNNY is disabled')
    },
    { JOHNNY_ENABLED: 'false' },
  )
  const res = await handleJohnny(makeRequest({ mode: 'style', message: '似合う髪型ある？', sessionToken: 'customer-token' }), deps)
  const body = await jsonOf(res)
  assert(res.status === 404, `expected 404, got ${res.status}`)
  assert(body.error === 'johnny_disabled', `expected johnny_disabled, got ${JSON.stringify(body)}`)
  assert(calls.length === 0, `expected 0 RPC calls, got ${calls.map((c) => c.name).join(', ')}`)
})

check('invalid HQ token writes no audit rows', async () => {
  const { calls, deps } = makeDeps(async (name) => {
    if (name === 'hq_johnny_snapshot') return rpcError('invalid_authorization_specification')
    return ok(null)
  })
  const res = await handleJohnny(makeRequest({ mode: 'hq', message: '今月どう？', hqToken: 'bad-token' }), deps)
  const body = await jsonOf(res)
  assert(res.status === 401, `expected 401, got ${res.status}`)
  assert(body.error === 'hq_auth_required', `expected hq_auth_required, got ${JSON.stringify(body)}`)
  const auditWrites = calls.filter((c) => auditWriteRpcs.has(c.name))
  assert(auditWrites.length === 0, `expected 0 audit writes, got ${auditWrites.map((c) => c.name).join(', ')}`)
})

check('unconfirmed style handoff returns no booking menu/service code', async () => {
  const styles = [
    {
      slug: 'truck-yaro',
      title: 'トラック野郎御用達',
      category: 'classic',
      catch_copy: null,
      description: null,
      image_url: '/assets/truck-yaro.png',
      tags: ['硬派'],
      tryon_style_id: 'truck',
      booking_menu: null,
    },
  ]
  const { calls, deps } = makeDeps(async (name) => {
    if (name === 'customer_johnny_profile') return ok({ user_id: 'user-1', client_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
    if (name === 'customer_johnny_style_catalog') return ok(styles)
    if (name === 'customer_johnny_booking_options') return ok({
      menus: [{ code: 'perm-ginpara-curly', name: 'ギンパラカーリー', duration_min: 180, price: 15000, staff_ids: [] }],
    })
    if (name === 'customer_johnny_available_slots') return ok([{ starts_at: '2026-10-05T09:00:00+09:00' }])
    if (name === 'johnny_record_session') return ok('99999999-9999-4999-8999-999999999999')
    return ok(1)
  })
  const res = await handleJohnny(makeRequest({
    mode: 'booking',
    message: '明日の夕方で',
    sessionToken: 'customer-token',
    handoff: { styleSlug: 'truck-yaro', tryonStyleId: 'truck' },
  }), deps)
  const body = await jsonOf(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`)
  assert(body.menu_status === 'unconfirmed', `expected unconfirmed, got ${body.menu_status}`)
  assert(body.matched_menu == null, `unconfirmed style leaked matched_menu: ${JSON.stringify(body.matched_menu)}`)
  assert(!JSON.stringify(body).includes('perm-ginpara-curly'), `unconfirmed response leaked service code: ${JSON.stringify(body)}`)
  assert(!calls.some((c) => c.name === 'customer_johnny_available_slots'), 'unconfirmed style must not query availability')
})

check('frontend flag OFF hides JOHNNY UI surfaces', () => {
  const flag = readRel('src/utils/johnnyFlag.ts')
  const app = readRel('src/App.tsx')
  const reserve = readRel('src/screens/ReserveScreen.tsx')
  const styles = readRel('src/screens/StyleLibraryScreen.tsx')
  const hq = readRel('src/hq/HeadquartersApp.tsx')
  const hqTabs = readRel('src/hq/hqMockData.ts')
  assertIncludes(flag, "import.meta.env.VITE_JOHNNY_ENABLED === 'true'", 'johnnyFlag')
  assertIncludes(app, "JOHNNY_UI_ENABLED ? () => handleTabChange('reserve') : undefined", 'App TryOn gate')
  assertIncludes(reserve, 'JOHNNY_UI_ENABLED &&', 'Reserve JOHNNY gate')
  assertIncludes(styles, 'JOHNNY_UI_ENABLED &&', 'StyleLibrary JOHNNY gate')
  assertIncludes(hq, "route === 'johnny' && !JOHNNY_UI_ENABLED", 'HQ JOHNNY gate')
  assertIncludes(hq, 'JOHNNY_UI_ENABLED ? <HqJohnnyScreen />', 'HQ JOHNNY screen gate')
  assertIncludes(hqTabs, 'HQ_TABS', 'HQ tab export')
  assertIncludes(hqTabs, 'JOHNNY_UI_ENABLED', 'HQ tab flag gate')
  assertIncludes(hqTabs, '? BASE_PRIMARY_TABS.flatMap', 'HQ JOHNNY tab must be added only when flag is ON')
})

check('frontend flag OFF keeps TryOn HOT PEPPER path', () => {
  const tryon = readRel('src/screens/TryOnScreen.tsx')
  assertIncludes(tryon, 'getReserveUrl(selectedStyle.name)', 'TryOn reserve URL')
  assertIncludes(tryon, 'window.open(reserveUrl', 'TryOn HOT PEPPER opener')
  assert(tryon.includes('reserveUrl &&'), 'TryOn HOT PEPPER button must be guarded by reserveUrl, not JOHNNY only')
  assert(!/JOHNNY_UI_ENABLED\s*&&\s*reserveUrl/.test(tryon), 'TryOn reserve URL must not depend on JOHNNY_UI_ENABLED')
})

check('frontend flag ON exposes JOHNNY entrypoints', () => {
  const tryon = readRel('src/screens/TryOnScreen.tsx')
  const reserve = readRel('src/screens/ReserveScreen.tsx')
  const styles = readRel('src/screens/StyleLibraryScreen.tsx')
  const hqTabs = readRel('src/hq/hqMockData.ts')
  assertIncludes(tryon, 'JOHNNYに予約相談', 'TryOn JOHNNY entry')
  assertIncludes(reserve, '<JohnnyPanel', 'Reserve JOHNNY panel')
  assertIncludes(styles, '<JohnnyPanel', 'StyleLibrary JOHNNY panel')
  assertIncludes(hqTabs, "'johnny'", 'HQ JOHNNY tab')
})

check('HQ sales aggregation avoids staff/reservation fan-out', () => {
  const migration = readRel('supabase/migrations/20261008000000_johnny_phase1.sql')
  const sqlTest = readRel('supabase/tests/preflight_johnny.sql')
  assert(/left join\s*\(\s*select\s+s\.stylist_id[\s\S]*?group by\s+s\.stylist_id/i.test(migration), 'staff sales must be pre-aggregated by stylist_id')
  assert(/left join\s*\(\s*select\s+r\.staff_id[\s\S]*?group by\s+r\.staff_id/i.test(migration), 'reservations must be pre-aggregated by staff_id')
  assertIncludes(sqlTest, 'hq_snapshot_fanout', 'JOHNNY SQL fan-out regression')
  assertIncludes(sqlTest, "(v_snap->'sales'->>'gross_sales')::int <> 1000", 'JOHNNY SQL sales total regression')
})

check('unapproved action intent cannot execute', () => {
  const migration = readRel('supabase/migrations/20261008000000_johnny_phase1.sql')
  const sqlTest = readRel('supabase/tests/preflight_johnny.sql')
  assertIncludes(migration, "if v.status <> 'approved' then return json_build_object('error', 'not_approved'", 'intent transition not_approved guard')
  assertIncludes(sqlTest, 'unapproved_intent_executed', 'SQL unapproved execution regression')
})

check('expired intent rejects approval/execution', () => {
  const migration = readRel('supabase/migrations/20261008000000_johnny_phase1.sql')
  const sqlTest = readRel('supabase/tests/preflight_johnny.sql')
  assertIncludes(migration, "if v.expires_at <= now() and p_action <> 'reject' then", 'intent expiry guard')
  assertIncludes(migration, "return json_build_object('error', 'expired'", 'intent expired error')
  assertIncludes(sqlTest, 'expired_intent_approved', 'SQL expired intent regression')
})

check('idempotency mismatch returns error', () => {
  const migration = readRel('supabase/migrations/20261008000000_johnny_phase1.sql')
  const sqlTest = readRel('supabase/tests/preflight_johnny.sql')
  assertIncludes(migration, 'johnny_action_intents_idempotency_uidx', 'intent idempotency unique index')
  assertIncludes(migration, "return json_build_object('error', 'idempotency_conflict')", 'intent idempotency mismatch error')
  assertIncludes(sqlTest, 'idempotency_mismatch_accepted', 'SQL idempotency mismatch regression')
})

check('fact change requires re-approval before execution', () => {
  const migration = readRel('supabase/migrations/20261008000000_johnny_phase1.sql')
  const sqlTest = readRel('supabase/tests/preflight_johnny.sql')
  assertIncludes(migration, 'approved_fact_version', 'intent approved fact version')
  assertIncludes(migration, 'p_fact_version is distinct from v.approved_fact_version', 'intent fact version comparison')
  assertIncludes(migration, "facts_changed_reapproval_required", 'intent fact change error')
  assertIncludes(sqlTest, 'changed_facts_executed', 'SQL changed-facts regression')
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`[johnny-regression] PASS ${name}`)
  } catch (error) {
    failed += 1
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[johnny-regression] FAIL ${name}: ${message}`)
  }
}

if (failed > 0) {
  console.error(`[johnny-regression] ${failed}/${checks.length} checks failed`)
  process.exit(1)
}

console.log(`[johnny-regression] PASS all ${checks.length} checks`)
