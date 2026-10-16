// JOHNNY の試験：会話の例を本物の AI に流して、画面に出すもの（ui）が正しいかを採点する。
//   node --experimental-strip-types scripts/johnny-eval/run.ts [id の一部で絞る]
// API キーは supabase/functions/.env の OPENAI_API_KEY（画面には出さない）。結果は scripts/johnny-eval/out/ に保存。
import fs from 'node:fs'
import path from 'node:path'
import { runAgent, type AgentUi } from '../../supabase/functions/johnny-agent/agent.ts'
import { CASES as BASE, type Case } from './corpus.ts'
import { MORE } from './corpus2.ts'
import { MENUS, NOW, RESERVATIONS, STAFF, fixtureTools } from './fixture.ts'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../..')
const env = Object.fromEntries(fs.readFileSync(path.join(root, 'supabase/functions/.env'), 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const llm = { apiKey: env.OPENAI_API_KEY, model: process.env.JOHNNY_MODEL || env.OPENAI_MODEL || 'gpt-6-luna' }
if (!llm.apiKey) { console.error('OPENAI_API_KEY がありません'); process.exit(1) }

const jst = (iso: string) => { const d = new Date(new Date(iso).getTime() + 9 * 3600000).toISOString(); return { date: d.slice(0, 10), time: d.slice(11, 16) } }
const staffName = (id: string | null) => (id ? STAFF.find(s => s.id === id)?.name ?? '?' : null)

function score(c: Case, ui: AgentUi): string[] {
  const e = c.expect, bad: string[] = []
  if (!e.types.includes(ui.type)) bad.push(`type ${ui.type}（期待 ${e.types.join('/')}）`)
  const menu = 'menu_code' in ui ? ui.menu_code : null
  if (e.menu && menu && ![e.menu].flat().includes(menu)) bad.push(`menu ${menu}（期待 ${[e.menu].flat().join('/')}）`)
  if (e.menu && !menu && (ui.type === 'slots' || ui.type.startsWith('confirm_b'))) bad.push('menu なし')
  const at = ui.type === 'confirm_booking' || ui.type === 'confirm_change' ? ui.starts_at : ui.type === 'slots' ? ui.times[0] : null
  if (e.date) {
    const d = at ? jst(at).date : ui.type === 'menus' ? ui.date : null
    if (d && d !== e.date) bad.push(`date ${d}（期待 ${e.date}）`)
  }
  if (e.time && at && jst(at).time !== e.time) bad.push(`time ${jst(at).time}（期待 ${e.time}）`)
  if (e.staff !== undefined && 'staff_id' in ui && staffName(ui.staff_id) !== e.staff) bad.push(`staff ${staffName(ui.staff_id)}（期待 ${e.staff}）`)
  if (e.reservation && 'reservation_id' in ui && ui.reservation_id !== e.reservation) bad.push(`reservation ${ui.reservation_id}（期待 ${e.reservation}）`)
  if (e.menusExclude && ui.type === 'menus' && ui.items.some(i => i.menu_code === e.menusExclude)) bad.push(`menus に ${e.menusExclude} が入っている（空きが無いはず）`)
  return bad
}

const CASES = [...BASE, ...MORE]
const filter = process.argv[2]
const cases = CASES.filter(c => !filter || c.id.includes(filter))
const results: { id: string; say: string; ok: boolean; bad: string[]; reply?: string; ui?: AgentUi; calls?: string[]; error?: string; ms: number }[] = []
let next = 0
async function worker() {
  while (next < cases.length) {
    const c = cases[next++]
    const tools = fixtureTools(RESERVATIONS[c.reservations ?? 'none'])
    const t0 = Date.now()
    try {
      const r = await runAgent({ now: NOW, menus: MENUS, staff: STAFF, lastMenuCode: c.lastMenu ?? null, shown: c.shown }, c.history ?? [], c.say, tools, llm)
      const bad = score(c, r.ui)
      results.push({ id: c.id, say: c.say, ok: bad.length === 0, bad, reply: r.say, ui: r.ui, calls: tools.calls, ms: Date.now() - t0 })
      process.stdout.write(bad.length ? 'x' : '.')
    } catch (err) {
      results.push({ id: c.id, say: c.say, ok: false, bad: ['error'], error: String((err as Error).message), calls: tools.calls, ms: Date.now() - t0 })
      process.stdout.write('E')
    }
  }
}
await Promise.all(Array.from({ length: Number(process.env.JOHNNY_CONCURRENCY ?? 6) }, worker))
results.sort((a, b) => a.id.localeCompare(b.id))
const pass = results.filter(r => r.ok).length
const ms = results.map(r => r.ms).sort((a, b) => a - b)
console.log(`\n\n${pass}/${results.length} 合格（${Math.round(pass / results.length * 100)}%）  モデル ${llm.model}  かかった時間 中央 ${ms[Math.floor(ms.length / 2)]}ms・最大 ${ms[ms.length - 1]}ms`)
for (const r of results.filter(r => !r.ok)) console.log(`✗ ${r.id}「${r.say}」 ${r.bad.join('、')}${r.error ? ` ${r.error.slice(0, 160)}` : ''}\n    → ${r.reply ?? ''}  [${(r.calls ?? []).join(' / ')}]`)
const outDir = path.join(root, 'scripts/johnny-eval/out')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, `result-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(results, null, 1))
