// ガチャ券とお金の同時操作の試験（Staging 専用・試験会員 u-v2qa-claude-1024 の予約 A/B を使う）
//   1本目が鍵を握ったまま20秒待つあいだに、2本目を割り込ませる。DB 側の時刻で本当に重なったかも確かめる
//   使い方（リポジトリの一番上で）：node supabase/tests/gacha_race/run.mjs
//   全部で8場面・数分かかる。最後に試験の予約をキャンセルし、試験用のログインを消す
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const REF = 'kfufxzmucjljjouzpumi' // Staging（本番では流さない）

function query(file) {
  return new Promise(res => {
    const p = spawn('npx', ['-y', 'supabase@2.121.0', 'db', 'query', '--linked', '--project-ref', REF, '--file', JSON.stringify(path.join(DIR, file).split(path.sep).join('/'))],
      { shell: true })
    let out = ''
    p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { out += d })
    p.on('close', () => {
      const m = out.match(/"r":\s*("(?:[^"\\]|\\.)*"|null)/)
      const err = out.match(/ERROR:[^"]*/)
      res(m ? String(JSON.parse(m[1])) : err ? err[0] : out.slice(-300))
    })
  })
}
const json = s => { try { return JSON.parse(s.split(' ｜')[0]) } catch { return null } }
const times = s => ((s.split(' ｜')[1] ?? '').match(/(\d\d:\d\d:\d\d\.\d+)/g) ?? []).map(t => { const [h, m, x] = t.split(':'); return (+h * 3600 + +m * 60 + +x) })

async function race(first, second) {
  const a = query(first)
  await new Promise(r => setTimeout(r, 8000))
  const b = query(second)
  const [ra, rb] = await Promise.all([a, b])
  // 2本目が始まったのは、1本目が処理してから鍵を離すまでのあいだか
  const [a0, a1] = times(ra), [b0] = times(rb)
  return { ra, rb, overlap: a0 !== undefined && b0 !== undefined && b0 > a0 && b0 < a1 }
}

const cases = [
  { name: 'R1 会計の確定中に、お客様が券を交換', prep: [], a: 's_sale_sleep.sql', b: 's_keep_new.sql',
    // 2本目は、1本目より先に見れば held_reserved、鍵を待って1本目のあとに進めば（券はもう使われたので）新しい券を受け取る。どちらでも会計は1回・券は1枚だけ使う
    want: (r, s) => (json(r.rb)?.error === 'held_reserved' || (times(r.rb)[1] >= times(r.ra)[1] && json(r.rb)?.held?.code === 'off500' && /^off500 used=false/.test(s.holding))) && s.sales_A === 1 && s.paid_A === 3700 && s.gacha_used_in_sales === 1 },
  { name: 'R2 同じ予約を2台の端末で同時に会計', prep: [], a: 's_sale_sleep.sql', b: 's_sale2.sql',
    want: (r, s) => json(r.rb)?.error === 'already_paid' && s.sales_A === 1 && s.paid_A === 3700 && s.gacha_used_in_sales === 1 },
  { name: 'R3 会計の確定中に、お客様が別の予約へ券を付ける', prep: [], a: 's_sale_sleep.sql', b: 's_attach_b.sql',
    want: (r, s) => json(r.rb)?.error === 'no_ticket' && s.sales_A === 1 && s.gacha_used_in_sales === 1 },
  { name: 'R4 2台のスマホで同時に券を別々の予約へ付ける', prep: ['prep_unattached.sql'], a: 's_attach_a_sleep.sql', b: 's_attach_b.sql',
    want: (r, s) => json(r.rb)?.error === 'held_reserved' && /res=ac3d008f/.test(s.holding) },
  { name: 'R5 2台のスマホで同時にガチャを回す', prep: ['prep_unattached.sql'], a: 's_draw_sleep.sql', b: 's_draw2.sql',
    want: (r, s) => s.draws_today === 1 && json(r.ra)?.today?.id === json(r.rb)?.today?.id },
  { name: 'R6 会計の確定中に、お客様が予約をキャンセル', prep: [], a: 's_sale_sleep.sql', b: 's_cancel_a.sql',
    want: (r, s) => json(r.rb)?.error === 'invalid_status' && s.sales_A === 1 && s.status_A === 'completed' },
  { name: 'R7 銀Pay の会計の確定中に、お客様が予約をキャンセル', prep: ['prep_hold.sql'], a: 's_gsale_sleep.sql', b: 's_cancel_a.sql', ginpay: true,
    want: (r, s, g0, g1) => json(r.rb)?.error === 'invalid_status' && s.sales_A === 1 && g0.balance - g1.balance === 3700 && /^closed/.test(g1.hold_A ?? '') },
  { name: 'R8 会計の取消中に、お客様がガチャの画面を開く', prep: ['s_sale2.sql'], a: 's_void_sleep.sql', b: 's_state.sql',
    want: (r, s, _g0, _g1, pend) => r.rb.startsWith('off300') && /off300 used=false/.test(s.holding) && pend === 'off500' },
]

let ng = 0
const only = process.argv[2]
for (const c of cases.filter(c => !only || c.name.startsWith(only + ' '))) {
  await query('setup.sql')
  const g0 = c.ginpay ? json(await query('gcheck.sql')) : null
  for (const f of c.prep) await query(f)
  const r = await race(c.a, c.b)
  const s = json(await query('check.sql')) ?? {}
  const g1 = c.ginpay ? json(await query('gcheck.sql')) : null
  const pend = await query('pend.sql')
  const ok = r.overlap && c.want(r, s, g0, g1, pend)
  if (!ok) ng++
  console.log(`${ok ? 'OK' : 'NG'}  ${c.name}${r.overlap ? '' : '（重ならなかった）'}`)
  if (!ok) console.log(`    1本目：${r.ra.slice(0, 160)}\n    2本目：${r.rb.slice(0, 160)}\n    時刻：1本目 ${times(r.ra).map(x=>x.toFixed(2)).join("〜")} ／ 2本目 ${times(r.rb).map(x=>x.toFixed(2)).join("〜")}
    状態：${JSON.stringify(s)} ${g1 ? JSON.stringify(g1) : ''} 保留=${pend}`)
}
await query('teardown.sql')
console.log(ng ? `NG ${ng} 件` : '全部 OK')
process.exitCode = ng ? 1 : 0
