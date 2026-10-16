// Edge Function のAPI境界をモックで検証。DBやOpenAIには接続しない。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../supabase/functions/johnny-style-advice/index.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
let handler
let calls = 0
let payload
let allowed = true
const values = { SUPABASE_URL: 'https://local.invalid', SUPABASE_ANON_KEY: 'test-public', OPENAI_API_KEY: 'test-only', OPENAI_MODEL: 'configured-model' }
runInNewContext(code, {
  Deno: { env: { get: key => values[key] }, serve: fn => { handler = fn } },
  Response,
  fetch: async (url, options) => {
    if (url === 'https://local.invalid/rest/v1/rpc/customer_get_tickets') return new Response('{}', { status: allowed ? 200 : 401 })
    assert.equal(url, 'https://api.openai.com/v1/chat/completions')
    calls++
    payload = JSON.parse(options.body)
    return Response.json({ choices: [{ message: { content: JSON.stringify({ reply: '相談への短い返事です。', menu_codes: ['cut', 'made-up'] }) } }] })
  },
})
const body = { session: 'a'.repeat(32), message: '似合う髪型を相談したい', menus: [{ code: 'cut', name: 'カット', duration_min: 60, price: 5500, price_from: true }], name: '送らない名前', phone: '09000000000', history: ['送らない過去の会話'] }
const post = value => handler(new Request('https://local.invalid/functions/v1/johnny-style-advice', { method: 'POST', body: JSON.stringify(value) }))
assert.equal((await post({ ...body, message: '' })).status, 400)
assert.equal((await post({ ...body, session: '' })).status, 401)
assert.equal(calls, 0, '空の相談や無効セッションでGPTを呼ばない')
allowed = false
assert.equal((await post(body)).status, 401)
assert.equal(calls, 0, 'セッション確認が失敗したときもGPTを呼ばない')
allowed = true
const response = await post(body)
assert.equal(response.status, 200)
assert.deepEqual(await response.json(), { reply: '相談への短い返事です。', menu_codes: ['cut'] })
assert.equal(calls, 1)
assert.equal(payload.model, 'configured-model', '既存モデル設定を使う')
assert.equal(payload.max_completion_tokens, 300, '出力上限を固定')
assert.equal(payload.messages.length, 2, '会話履歴を追加しない')
const sent = JSON.stringify(payload)
for (const privateValue of [body.name, body.phone, ...body.history, body.session]) assert.equal(sent.includes(privateValue), false)
assert.ok(payload.messages[1].content.includes('["cut","カット",60,5500,true]'), '最低料金フラグを落とさない')
console.log('johnny edge: request bounds, session check, menu validation and privacy ok; real OpenAI calls: 0')
