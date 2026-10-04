#!/usr/bin/env node
// GINJIRO POS Phase 0 の画面側チェック（DB 不要）。
// お客様提示 QR：GJC1 形式でない読み取り（他社 QR・会員証 QR・誤読）はサーバーに送らない。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const file = join(root, 'src', 'utils', 'presenceTokenApi.ts')
const IMPORT = "import { callStaffRpc } from './staffSession'"

const source = readFileSync(file, 'utf8')
if (!source.includes(IMPORT)) throw new Error('presenceTokenApi: staff RPC import not found')
// RPC を記録するだけの差し替え（ネットワークには出ない）
const stubbed = source.replace(IMPORT, 'const callStaffRpc = async (fn, params) => { globalThis.__posRpcCalls.push({ fn, params }); return { error: "invalid_token" } }')
const js = ts.transpileModule(stubbed, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
globalThis.__posRpcCalls = []
const api = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

let failed = 0
const check = (name, ok) => { console.log(`[pos-regression] ${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed += 1 }

const valid = 'GJC1.' + 'A'.repeat(21) + '_-' + 'b'.repeat(20)
const notTokens = [
  '', 'GJC1.', 'GJC1.short', 'gjc1.' + 'A'.repeat(43), 'GJC1.' + 'A'.repeat(44), 'GJC1.' + 'A'.repeat(42) + '=',
  JSON.stringify({ type: 'ginjiro-member', userId: 'u-1', name: 'x' }), 'https://example.com/qr', 'GJC2.' + 'A'.repeat(43),
]
check('valid GJC1 token is recognised', api.isPresenceToken(valid) && api.isPresenceToken(`  ${valid}\n`))
check('non-GJC1 strings are not tokens', notTokens.every((t) => !api.isPresenceToken(t)))

for (const t of notTokens) {
  const r = await api.resolvePresenceToken(t)
  if (r.ok || r.error !== 'not_presence_token') { check(`rejects locally: ${t.slice(0, 20)}`, false) }
}
check('non-GJC1 reads never call the server', globalThis.__posRpcCalls.length === 0)

await api.resolvePresenceToken(`  ${valid} `)
const call = globalThis.__posRpcCalls[0]
check('valid token calls staff_resolve_presence_token once with the trimmed token',
  globalThis.__posRpcCalls.length === 1 && call.fn === 'staff_resolve_presence_token' && call.params.p_token === valid && Object.keys(call.params).length === 1)
check('every error code has a message', ['not_presence_token', 'invalid_token', 'expired', 'revoked', 'already_used', 'scan_session_expired',
  'customer_session_revoked', 'customer_not_found', 'rate_limited'].every((k) => typeof api.PRESENCE_ERROR_MESSAGES[k] === 'string'))

if (failed) { console.error(`[pos-regression] ${failed} checks failed`); process.exit(1) }
console.log('[pos-regression] PASS all checks')
