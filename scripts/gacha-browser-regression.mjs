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
const user = 'qa-gacha-user'
const token = 'synthetic-gacha-session-for-local-regression'
const drawId = '00000000-0000-4000-8000-000000000004'
const nextDrawId = '00000000-0000-4000-8000-000000000005'
const fixedTime = new Date('2026-11-12T03:00:00Z')
const prize = (amount, title = `試験${amount}円引き`) => ({
  code: `qa-${amount}`, title, amount, free_menu: null, weekday_only: false, rank: 'normal',
})
const held = amount => ({ ...prize(amount), expires_at: '2026-12-01T00:00:00+09:00' })
const empty = { today: null, held: null, repeat: false, gauge: { open: false } }
const pending = { ...empty, today: { id: drawId, prize: prize(200), choice: null }, held: held(100) }
const laterPending = { id: nextDrawId, prize: prize(400, '試験別日の400円引き'), choice: null }
const won = { ...empty, today: { ...pending.today, choice: 'auto' }, held: held(200) }
const received = { ...won, today: { ...won.today, choice: 'new' } }
const ok = json => ({ status: 200, json })
const outage = { status: 503, json: { code: 'PGRST003', message: 'synthetic interruption' } }
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
  const counts = { state: 0, draw: 0, keep: 0 }
  const respond = (name, args) => {
    calls.push({ name, args })
    if (name === 'customer_gacha_state' || name === 'customer_gacha_peek') {
      counts.state++
      if (scenario === 'keepStale') return ok(counts.keep ? { ...pending, today: laterPending } : pending)
      if (scenario === 'keepNoHeld') return ok({ ...pending, held: null })
      if (scenario === 'keepLost') return ok(counts.keep ? received : pending)
      if (scenario === 'keep503' || scenario === 'keepOldReplay') return ok(pending)
      if (scenario === 'malformed' && counts.state === 1) return ok({ today: { ...pending.today, prize: {} }, held: [] })
      if (scenario === 'drawUnconfirmed' && counts.draw) return outage
      return ok(counts.draw ? won : empty)
    }
    if (name === 'customer_gacha_draw') {
      counts.draw++
      return scenario === 'drawLost' || scenario === 'drawUnconfirmed' ? outage : ok(won)
    }
    if (name === 'customer_gacha_keep_checked') {
      counts.keep++
      if (scenario === 'keepStale') return ok({ error: 'stale_draw' })
      if (scenario === 'keepOldReplay') return ok({ ...received, current_today: laterPending, replayed: true })
      if (scenario === 'keepNoHeld' || (scenario === 'keep503' && counts.keep === 2)) return ok(received)
      return outage
    }
    if (name === 'customer_gacha_keep') throw new Error('Client called the old decision RPC')
    return ok(shellReplies[name] ?? null)
  }
  return { calls, counts, respond }
}

const stage = '.v2-gacha-stage'
const intro = stage + ' video:nth-of-type(2)'
const openVideo = stage + ' .v2-gacha-burst'

async function prepare(browser, origin, scenario) {
  const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' })
  const rpc = makeRpcFixture(scenario)
  try {
    await context.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.origin !== origin) return route.abort()
      if (request.method() === 'POST' && url.pathname.startsWith('/rest/v1/rpc/')) {
        return route.fulfill(rpc.respond(url.pathname.split('/').at(-1), request.postDataJSON()))
      }
      if (request.method() !== 'GET' && request.method() !== 'HEAD') return route.abort()
      return route.continue()
    })
    await context.addInitScript(({ user, token, scenario, intro }) => {
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: true })
      localStorage.setItem('ginjiro_customer_session', token)
      localStorage.setItem('ginjiro_user_id', JSON.stringify(user))
      localStorage.setItem('ginjiro:onboarding_done', 'true')
      localStorage.setItem('ginjiro_campaign_hidden', JSON.stringify('gacha-2026-11-open'))
      localStorage.setItem('ginjiro_launch_notice_seen', String(Date.parse('2026-11-11T12:00:00+09:00')))
      localStorage.setItem('ginjiro_guide_seen_customer', '1')
      localStorage.setItem('ginjiro_guide_seen', '1')
      sessionStorage.setItem('ginjiro_ginchat_later', '1')

      window.gachaProbe = { starts: [], suppressed: 0 }
      const start = AudioBufferSourceNode.prototype.start
      AudioBufferSourceNode.prototype.start = function (...args) {
        window.gachaProbe.starts.push({ seconds: this.buffer?.duration, loop: this.loop, state: this.context.state })
        return start.apply(this, args)
      }
      if (scenario !== 'frameMissing' && scenario !== 'frameAll') return
      const requestFrame = HTMLVideoElement.prototype.requestVideoFrameCallback
      const cancelFrame = HTMLVideoElement.prototype.cancelVideoFrameCallback
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
        if (!this.matches(scenario === 'frameAll' ? '.v2-gacha-stage video' : intro)) {
          return requestFrame.call(this, callback)
        }
        window.gachaProbe.suppressed++
        return -window.gachaProbe.suppressed
      }
      HTMLVideoElement.prototype.cancelVideoFrameCallback = function (id) {
        if (id >= 0) cancelFrame.call(this, id)
      }
    }, { user, token, scenario, intro })
    const page = await context.newPage()
    await page.clock.setFixedTime(fixedTime)
    page.setDefaultTimeout(9000)
    const response = await page.goto(origin + '/?gacha=deep', { waitUntil: 'domcontentloaded', timeout: 25_000 })
    assert.equal(response?.status(), 200)
    await page.getByRole('button', { name: 'ガチャ', exact: true }).click()
    return { ...rpc, page, close: () => context.close() }
  } catch (error) {
    await context.close()
    throw error
  }
}

async function finishClip(page, selector, minimumTime) {
  await page.waitForFunction(({ selector, minimumTime }) => {
    const video = document.querySelector(selector)
    if (!video || video.paused || video.currentTime < minimumTime) return false
    video.currentTime = video.duration - 0.25
    return true
  }, { selector, minimumTime }, { timeout: 12_000 })
}

function assertChoice(fixture, count) {
  assert.equal(fixture.counts.draw, 0)
  const requests = fixture.calls.filter(call => call.name === 'customer_gacha_keep_checked')
  assert.equal(requests.length, count)
  assert(requests.every(({ args }) => args.p_draw_id === drawId && args.p_choice === 'new'))
  assert(!fixture.calls.some(call => call.name === 'customer_gacha_keep'))
}

async function checkScenario(scenario, fixture) {
  const { page, counts } = fixture
  const button = name => page.getByRole('button', { name, exact: true })
  const result = page.locator('.v2-gacha-result')
  const resultButton = name => result.getByRole('button', { name, exact: typeof name === 'string' })
  const issued = () => result.getByText(/ガチャ券をお渡ししました/).waitFor()

  if (scenario === 'malformed') {
    await page.getByText(/今日のガチャの状態を確かめられませんでした/).waitFor()
    assert.equal(await button('本日のガチャを回す').count(), 0)
    await button('読み込み直す').click()
    await button('本日のガチャを回す').waitFor({ timeout: 25_000 })
    assert.equal(counts.draw, 0)
    return
  }
  if (scenario.startsWith('keep')) {
    await button('当選した券を選ぶ').click({ timeout: 25_000 })
    if (scenario === 'keepNoHeld') {
      await resultButton('この券を受け取る').click()
    } else {
      await resultButton(/新しいガチャ券/).click()
      await resultButton('決定する').click()
    }
    if (scenario === 'keep503') {
      const retry = resultButton('新しい券を受け取る操作を再試行')
      await retry.waitFor()
      assert.equal(await resultButton(/現在お持ちのガチャ券/).count(), 0)
      await retry.click()
      await issued()
      assertChoice(fixture, 2)
    } else if (scenario === 'keepStale') {
      await result.getByText(/表示していた当選が変わりました/).waitFor()
      await result.getByText(laterPending.prize.title, { exact: true }).first().waitFor()
      assert(await resultButton('決定する').isDisabled())
      assertChoice(fixture, 1)
    } else if (scenario === 'keepOldReplay') {
      await result.getByText(/確定済み/).waitFor()
      assert.equal(await result.getByText(/ガチャ券をお渡ししました/).count(), 0)
      await resultButton('閉じる').click()
      await button('当選した券を選ぶ').click()
      await result.getByText(laterPending.prize.title, { exact: true }).first().waitFor()
      assertChoice(fixture, 1)
    } else {
      await issued()
      assertChoice(fixture, 1)
    }
    if (['keep503', 'keepLost', 'keepStale'].includes(scenario)) {
      assert(fixture.calls.some(call => call.name === 'customer_gacha_peek'))
    }
    return
  }

  await button('本日のガチャを回す').click({ timeout: 25_000 })
  if (scenario === 'frameMissing') {
    await page.waitForFunction(selector => document.querySelector(selector)?.currentTime > 1.2, intro)
    const probe = await page.evaluate(() => window.gachaProbe)
    assert(probe.suppressed > 0)
    assert.equal(probe.starts.length, 2)
    assert.equal(probe.starts[0].state, 'running')
    assert.equal(counts.draw, 1)
    return
  }

  // Seek close to clip ends after playback starts to keep recovery tests short.
  await finishClip(page, intro, 0.4)
  await page.locator('.v2-gacha-tap').waitFor({ timeout: 12_000 })
  if (scenario === 'frameAll') await page.locator(intro + '.is-off').waitFor()
  await page.locator(stage).click({ position: { x: 140, y: 285 } })
  if (scenario === 'frameAll') await page.locator(openVideo + '.is-on').waitFor({ timeout: 12_000 })
  await finishClip(page, openVideo, 0.5)
  if (scenario === 'frameAll') {
    await issued()
    const probe = await page.evaluate(() => window.gachaProbe)
    assert(probe.suppressed >= 3)
    // 深海編の結果の決定音（0.1秒）は鳴らさない（11/12「最後のプツッ」）：始まる音は intro・wait・open の3つ
    assert.equal(probe.starts.length, 3)
    assert(Math.abs(probe.starts[2].seconds - 14.25) < 0.03)
  } else {
    assert(fixture.calls.some(call => call.name === 'customer_gacha_peek'))
    if (scenario === 'drawLost') await issued()
    else {
      await resultButton('結果を確認する').waitFor()
      await resultButton('閉じる').click()
      await button('読み込み直す').waitFor()
      assert.equal(await button('本日のガチャを回す').count(), 0)
    }
  }
  assert.equal(counts.draw, 1)
}

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.wav': 'audio/wave', '.m4a': 'audio/mp4',
}
const temp = await mkdtemp(join(tmpdir(), 'ginjiro-gacha-'))
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
        ...process.env, VITE_APP_ENV: 'staging', VITE_SUPABASE_URL: origin, VITE_SUPABASE_ANON_KEY: 'synthetic-gacha-local',
      },
    })
  browser = await chromium.launch({ headless: true, channel: process.env.GACHA_CHROMIUM_CHANNEL || undefined })
  const scenarios = ['keep503', 'keepLost', 'keepStale', 'keepNoHeld', 'keepOldReplay',
    'malformed', 'frameAll', 'frameMissing', 'drawLost', 'drawUnconfirmed']
  let passed = 0
  for (const scenario of scenarios) {
    let fixture
    try {
      fixture = await prepare(browser, origin, scenario)
      await checkScenario(scenario, fixture)
      passed++
      console.log('PASS ' + scenario)
    } catch (error) {
      console.error('FAIL ' + scenario, error.message)
      if (fixture) console.error('RPCs:', fixture.calls.map(call => call.name).join(', '))
    } finally {
      await fixture?.close()
    }
  }
  console.log(`${passed}/${scenarios.length} browser cases passed`)
  if (passed !== scenarios.length) process.exitCode = 1
} finally {
  await browser?.close()
  if (server.listening) await new Promise(done => server.close(done))
  const testRoot = resolve(tmpdir()) + sep + 'ginjiro-gacha-'
  if (!resolve(temp).startsWith(testRoot)) throw new Error('Unexpected temporary build location')
  await rm(temp, { recursive: true, force: true })
}
