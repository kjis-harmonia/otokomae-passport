// お客様アプリの入口の回帰（ローカルで作った Staging 版・合成データ・模擬 RPC）
//   SR-05：古い初回案内（ginjiro_first_guide）が残っていても、新しい銀二郎で予約・変更が開く
//   SR-06：ログイン前にキャンセル待ちのお知らせを開いても行き先が消えず、ログインできたら1回だけ枠を聞く
// 使い方：GACHA_CHROMIUM_CHANNEL=chrome node scripts/app-entry-regression.mjs
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const { chromium, devices } = require(process.env.GACHA_PLAYWRIGHT_MODULE || 'playwright')
const repo = fileURLToPath(new URL('../', import.meta.url))
const user = 'qa-entry-user'
const token = 'synthetic-entry-session-for-local-regression'
const holdId = '00000000-0000-4000-8000-0000000000a1'
const fixedTime = new Date('2026-11-12T03:00:00Z') // 日本時間 12:00
const ok = json => ({ status: 200, json })
const hold = {
  hold_id: holdId, waitlist_id: null, starts_at: '2026-11-14T01:00:00Z', expires_at: '2026-11-12T03:30:00Z',
  menu_names: '試験カット', total_price: 4000,
}
const shellReplies = {
  customer_get_profile: { id: user, user_id: user, name: '試験会員', has_visited_before: true },
  customer_store_access_status: { verified: true },
  customer_list_reservations: [],
  customer_get_tickets: [],
  customer_ginpay_holds: { balance: 0, held: 0, available: 0, holds: [] },
  customer_ginpay_ledger: { balance: 0, consistent: true, accounts: [], transactions: [] },
}

function makeRpcFixture(scenario) {
  const calls = []
  const respond = name => {
    calls.push(name)
    if (name === 'customer_get_hold') return ok(scenario === 'holdExpired' ? { error: 'hold_expired' } : hold)
    return ok(shellReplies[name] ?? null)
  }
  return { calls, respond }
}

async function prepare(browser, origin, scenario, { signedIn, firstGuide, path, pendingAt }) {
  const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' })
  const rpc = makeRpcFixture(scenario)
  try {
    await context.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.origin !== origin) return route.abort()
      if (request.method() === 'POST' && url.pathname.startsWith('/rest/v1/rpc/')) {
        return route.fulfill(rpc.respond(url.pathname.split('/').at(-1)))
      }
      if (request.method() !== 'GET' && request.method() !== 'HEAD') return route.abort()
      return route.continue()
    })
    await context.addInitScript(({ user, token, signedIn, firstGuide, holdId, pendingAt }) => {
      if (sessionStorage.getItem('qa_entry_init')) return // 1回目の読み込みだけ整える
      sessionStorage.setItem('qa_entry_init', '1')
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: true })
      localStorage.setItem('ginjiro_user_id', JSON.stringify(user))
      if (signedIn) localStorage.setItem('ginjiro_customer_session', token)
      localStorage.setItem('ginjiro:onboarding_done', 'true')
      localStorage.setItem('ginjiro_campaign_hidden', JSON.stringify('black-monday-2026'))
      localStorage.setItem('ginjiro_launch_kaikin_seen', String(Date.parse('2026-11-11T12:00:00+09:00')))
      localStorage.setItem('ginjiro_launch_notice_seen', String(Date.parse('2026-11-11T12:00:00+09:00')))
      localStorage.setItem('ginjiro_guide_seen_customer', '1')
      localStorage.setItem('ginjiro_guide_seen', '1')
      sessionStorage.setItem('ginjiro_ginchat_later', '1')
      // 旧版で初回案内を閉じずに離れた方（SR-05）
      if (firstGuide) localStorage.setItem('ginjiro_first_guide', JSON.stringify({ visited: true }))
      // 前にログイン前で預かったままの枠（SR-06 の古い預かり）
      if (pendingAt) localStorage.setItem('ginjiro_pending_hold', JSON.stringify({ holdId, at: pendingAt }))
    }, { user, token, signedIn, firstGuide, holdId, pendingAt })
    const page = await context.newPage()
    await page.clock.setFixedTime(fixedTime)
    page.setDefaultTimeout(9000)
    const response = await page.goto(origin + path, { waitUntil: 'domcontentloaded', timeout: 25_000 })
    assert.equal(response?.status(), 200)
    return { ...rpc, page, close: () => context.close() }
  } catch (error) {
    await context.close()
    throw error
  }
}

const chat = page => page.locator('.gc-log')
const holdCalls = fixture => fixture.calls.filter(name => name === 'customer_get_hold').length
/** ログインできた時と同じ合図（saveCustomerSession が出すもの） */
const signIn = page => page.evaluate(token => {
  localStorage.setItem('ginjiro_customer_session', token)
  window.dispatchEvent(new Event('ginjiro:customer-session-changed'))
}, token)

const cases = {
  // SR-05：旧値が残ったまま「次回予約」→「AI予約する」で銀ちゃんが開く
  async staleFirstGuideBook(browser, origin) {
    const f = await prepare(browser, origin, 'book', { signedIn: true, firstGuide: true, path: '/' })
    try {
      await f.page.getByRole('button', { name: '次回予約', exact: true }).click()
      await f.page.getByRole('button', { name: 'AI予約する', exact: true }).click()
      await chat(f.page).waitFor()
    } finally { await f.close() }
  },
  // SR-05：変更の入口（gin-change）も同じ条件で開く
  async staleFirstGuideChange(browser, origin) {
    const f = await prepare(browser, origin, 'change', { signedIn: true, firstGuide: true, path: '/' })
    try {
      await f.page.getByRole('button', { name: '次回予約', exact: true }).waitFor()
      await f.page.evaluate(() => window.dispatchEvent(new CustomEvent('ginjiro:gin-change', { detail: {} })))
      await chat(f.page).waitFor()
    } finally { await f.close() }
  },
  // SR-06：ログイン前 → ログインの画面に残る（ホームへ戻らない）→ ログインできたら1回だけ枠を聞く
  async holdSignedOut(browser, origin) {
    const f = await prepare(browser, origin, 'hold', { signedIn: false, path: `/?tab=reserve&johnny=1&hold=${holdId}` })
    try {
      await f.page.getByRole('heading', { name: 'ログインと引き継ぎ' }).waitFor()
      await f.page.waitForTimeout(600)
      await f.page.getByRole('heading', { name: 'ログインと引き継ぎ' }).waitFor() // 上書きされていない
      assert.equal(new URL(f.page.url()).searchParams.get('hold'), null)
      assert.equal(holdCalls(f), 0)
      assert.equal(await chat(f.page).count(), 0)
      await signIn(f.page)
      await chat(f.page).getByText(/キャンセルが出ました/).waitFor()
      assert.equal(holdCalls(f), 1)
      // もう一度ログインの合図が来ても、2回は聞かない
      await signIn(f.page)
      await f.page.waitForTimeout(500)
      assert.equal(holdCalls(f), 1)
      assert.equal(await f.page.evaluate(() => localStorage.getItem('ginjiro_pending_hold')), null)
    } finally { await f.close() }
  },
  // SR-06：ログイン済みは今までどおり、すぐ枠を聞く（1回）
  async holdSignedIn(browser, origin) {
    const f = await prepare(browser, origin, 'hold', { signedIn: true, path: `/?tab=reserve&johnny=1&hold=${holdId}` })
    try {
      await chat(f.page).getByText(/キャンセルが出ました/).waitFor()
      await f.page.waitForTimeout(500)
      assert.equal(holdCalls(f), 1)
    } finally { await f.close() }
  },
  // SR-06：期限切れ（別の会員の枠もサーバーは同じく断る）→ ログイン後に「お時間が過ぎました」。予約はしない
  async holdExpired(browser, origin) {
    const f = await prepare(browser, origin, 'holdExpired', { signedIn: false, path: `/?tab=reserve&johnny=1&hold=${holdId}` })
    try {
      await f.page.getByRole('heading', { name: 'ログインと引き継ぎ' }).waitFor()
      await signIn(f.page)
      await chat(f.page).getByText(/お時間が過ぎてしまいました/).waitFor()
      assert.equal(f.calls.filter(name => name === 'customer_confirm_hold' || name.startsWith('customer_confirm')).length, 0)
    } finally { await f.close() }
  },
  // SR-06：3時間前に預かった古い枠は、ログインしても聞かない
  async holdTooOld(browser, origin) {
    const f = await prepare(browser, origin, 'hold', { signedIn: false, path: '/?tab=mypage', pendingAt: fixedTime.getTime() - 3 * 3600e3 })
    try {
      await f.page.getByRole('heading', { name: 'ログインと引き継ぎ' }).waitFor()
      await signIn(f.page)
      await f.page.waitForTimeout(800)
      assert.equal(holdCalls(f), 0)
      assert.equal(await chat(f.page).count(), 0)
    } finally { await f.close() }
  },
}

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.wav': 'audio/wave', '.m4a': 'audio/mp4',
}
const temp = await mkdtemp(join(tmpdir(), 'ginjiro-entry-'))
const build = join(temp, 'build')
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname
    const file = resolve(build, pathname === '/' ? 'index.html' : '.' + pathname)
    if (!file.startsWith(build + sep)) return res.writeHead(404).end()
    const content = await readFile(file)
    res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream')
    res.setHeader('Content-Length', content.length)
    res.setHeader('Date', fixedTime.toUTCString())
    res.end(req.method === 'HEAD' ? undefined : content)
  } catch {
    res.writeHead(404).end()
  }
})
let browser
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + server.address().port
  await promisify(execFile)(process.execPath,
    [join(repo, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--mode', 'staging', '--outDir', build], {
      cwd: repo, windowsHide: true, env: {
        ...process.env, VITE_APP_ENV: 'staging', VITE_GIN_FLOW: 'true', VITE_SUPABASE_URL: origin, VITE_SUPABASE_ANON_KEY: 'synthetic-entry-local',
      },
    })
  browser = await chromium.launch({ headless: true, channel: process.env.GACHA_CHROMIUM_CHANNEL || undefined })
  const only = process.argv.slice(2)
  const names = Object.keys(cases).filter(name => !only.length || only.includes(name))
  let passed = 0
  for (const name of names) {
    try {
      await cases[name](browser, origin)
      passed++
      console.log('PASS ' + name)
    } catch (error) {
      console.error('FAIL ' + name, error.message)
    }
  }
  console.log(`${passed}/${names.length} entry cases passed`)
  if (passed !== names.length) process.exitCode = 1
} finally {
  await browser?.close()
  if (server.listening) await new Promise(done => server.close(done))
  const testRoot = resolve(tmpdir()) + sep + 'ginjiro-entry-'
  if (!resolve(temp).startsWith(testRoot)) throw new Error('Unexpected temporary build location')
  await rm(temp, { recursive: true, force: true })
}
