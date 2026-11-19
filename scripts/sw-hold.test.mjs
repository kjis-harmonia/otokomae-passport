// お知らせの係（public/sw.js）：キャンセル待ちのお知らせを、開いているアプリへ直接渡す（11/19 本番の実機）
//   使い方：node scripts/sw-hold.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const code = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
const ORIGIN = 'https://app.example'
const HOLD = '/?tab=reserve&johnny=1&hold=00000000-0000-4000-8000-0000000000a1'

function load(windows) {
  const handlers = {}
  const log = []
  const clients = {
    claim: async () => {},
    matchAll: async () => windows,
    openWindow: async url => { log.push(['open', url]); return null },
  }
  const self = {
    location: { href: `${ORIGIN}/sw.js` },
    addEventListener: (name, fn) => { handlers[name] = fn },
    skipWaiting: () => {},
    registration: { showNotification: async (title, opts) => { log.push(['show', opts.data.url]) } },
  }
  const caches = {
    delete: async () => true,
    open: async name => ({ put: async (key, res) => { log.push(['box', name, key, JSON.parse(await res.text()).url]) } }),
  }
  vm.runInNewContext(code, { self, clients, caches, Response, URL, Date, console })
  return { handlers, log }
}
function win(log, { url = `${ORIGIN}/`, visible = true, navigate = true } = {}) {
  const w = {
    url, visibilityState: visible ? 'visible' : 'hidden',
    postMessage: m => log.push(['message', m.type, m.url]),
    focus: async () => { log.push(['focus']); return w },
  }
  if (navigate) w.navigate = async u => { log.push(['navigate', u]); return w }
  return w
}
async function fire(handlers, name, event) {
  let p
  handlers[name]({ ...event, waitUntil: x => { p = x } })
  await p
}
const click = url => ({ notification: { close() {}, data: { url } } })
const push = data => ({ data: { json: () => data, text: () => '' } })

const cases = {
  // アプリが裏で開いたまま：枠を直接渡して前に出す（読み込み直し・新しい画面は使わない）
  async clickHoldWhileOpen() {
    const windows = []
    const { handlers, log } = load(windows)
    windows.push(win(log, { visible: false }))
    await fire(handlers, 'notificationclick', click(HOLD))
    assert.deepEqual(log, [['box', 'ginjiro-hold-box', '/__gin-hold', `${ORIGIN}${HOLD}`], ['message', 'gin-hold', `${ORIGIN}${HOLD}`], ['focus']])
  },
  // アプリが閉じている：今までどおり新しく開く
  async clickHoldClosed() {
    const { handlers, log } = load([])
    await fire(handlers, 'notificationclick', click(HOLD))
    assert.deepEqual(log, [['box', 'ginjiro-hold-box', '/__gin-hold', `${ORIGIN}${HOLD}`], ['open', `${ORIGIN}${HOLD}`]])
  },
  // キャンセル待ち以外（予約のお知らせなど）は今までどおり読み込み直す
  async clickOtherNavigates() {
    const windows = []
    const { handlers, log } = load(windows)
    windows.push(win(log))
    await fire(handlers, 'notificationclick', click('/?tab=next'))
    assert.deepEqual(log, [['navigate', `${ORIGIN}/?tab=next`], ['focus']])
  },
  // 読み込み直しの仕組みが無い端末：止まらずに新しく開く
  async clickOtherWithoutNavigate() {
    const windows = []
    const { handlers, log } = load(windows)
    windows.push(win(log, { navigate: false }))
    await fire(handlers, 'notificationclick', click('/?tab=next'))
    assert.deepEqual(log, [['open', `${ORIGIN}/?tab=next`]])
  },
  // アプリを画面に出している時に届いた：出している画面だけへ渡す（裏の画面へは押した時に）
  async pushHoldToVisible() {
    const windows = []
    const { handlers, log } = load(windows)
    windows.push(win(log, { url: `${ORIGIN}/a` }), win(log, { url: `${ORIGIN}/b`, visible: false }))
    await fire(handlers, 'push', push({ title: 't', body: 'b', url: HOLD, tag: 'x' }))
    assert.deepEqual(log.filter(x => x[0] === 'message'), [['message', 'gin-hold', HOLD]])
    assert.equal(log.filter(x => x[0] === 'show').length, 1)
    assert.deepEqual(log.filter(x => x[0] === 'box'), [['box', 'ginjiro-hold-box', '/__gin-hold', `${ORIGIN}${HOLD}`]])
  },
  // キャンセル待ち以外のお知らせは渡さない
  async pushOtherNoMessage() {
    const windows = []
    const { handlers, log } = load(windows)
    windows.push(win(log))
    await fire(handlers, 'push', push({ title: 't', body: 'b', url: '/?tab=next' }))
    assert.equal(log.filter(x => x[0] === 'message').length, 0)
    assert.equal(log.filter(x => x[0] === 'box').length, 0)
  },
}

let ok = 0
for (const [name, fn] of Object.entries(cases)) {
  try { await fn(); ok++; console.log(`PASS ${name}`) } catch (e) { console.log(`FAIL ${name} ${e.message}`); process.exitCode = 1 }
}
console.log(`${ok}/${Object.keys(cases).length} sw cases passed`)
