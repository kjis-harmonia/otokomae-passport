// お客様アプリの入口の回帰（ローカルで作った Staging 版・合成データ・模擬 RPC）
//   SR-05：古い初回案内（ginjiro_first_guide）が残っていても、新しい銀二郎で予約・変更が開く
//   SR-07：最初のメニュー取得だけ 503 でも、あとで読めた一覧を出す。続けて失敗したら「読み込み直す」
//   SR-10：次回予約を開いたまま戻ってきたら読み直す（ほかの端末で 10:00→11:00）。復帰の合図が重なっても照会は1回
//   SR-03：「お連れ様の予約をする」から入ったら、人の初めの選択は予約できるお連れ様（ご本人ではない）
//   SR-06：ログイン前にキャンセル待ちのお知らせを開いても行き先が消えず、ログインできたら1回だけ枠を聞く
//          端末に残ったログインが期限切れでも、ログインし直したら枠を聞く（再検査）
// 使い方：GACHA_CHROMIUM_CHANNEL=chrome node scripts/app-entry-regression.mjs
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const { chromium, devices } = require(process.env.GACHA_PLAYWRIGHT_MODULE || 'playwright')
const repo = fileURLToPath(new URL('../', import.meta.url))
const user = 'qa-entry-user'
const token = 'synthetic-entry-session-for-local-regression'
const staleToken = 'synthetic-entry-session-expired-on-this-device'
const holdId = '00000000-0000-4000-8000-0000000000a1'
const fixedTime = new Date('2026-11-12T03:00:00Z') // 日本時間 12:00
const ok = json => ({ status: 200, json })
const outage = { status: 503, json: { code: 'PGRST003', message: 'synthetic interruption' } }
const menus = [
  { code: 'cut-standard', name: '試験カット', duration_min: 60, price: 4000 },
  { code: 'perm-punch', name: '試験パンチパーマ', duration_min: 120, price: 9000 },
  { code: 'shave-face', name: '試験シェービング', duration_min: 30, price: 2500 },
  { code: 'set-blow', name: '試験セット', duration_min: 30, price: 2000 },
]
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

const resv = hm => ({
  id: '00000000-0000-4000-8000-0000000000b1', starts_at: `2026-11-14T${hm}:00+09:00`, ends_at: '2026-11-14T13:00:00+09:00',
  status: 'confirmed', staff_name: '試験担当', nominated: false, total_price: 4000,
  items: [{ menu_code: 'cut-standard', name: '試験カット', duration_min: 60, price: 4000 }],
})
const fixtureState = { up: false, chat: false, failNext: false, resv: 'off' }
function makeRpcFixture(scenario) {
  Object.assign(fixtureState, { up: false, chat: false, failNext: false, resv: 'off' })
  const calls = []
  const respond = (name, body) => {
    calls.push(name)
    // 端末に残った期限切れのログイン：サーバーはどの照会も断る
    if (body?.p_session === staleToken) return { status: 400, json: { code: 'P0001', message: 'customer_auth_required' } }
    if (scenario === 'mate') {
      if (name === 'customer_people') return ok({ owner: { id: null, name: '試験本人' }, companions: [{ id: 'c-a', name: '試験エー' }, { id: 'c-b', name: '試験ビー' }] })
      // お連れ様Aだけ予約済み。ご本人とBは予約なし
      if (name === 'customer_list_reservations') return ok([{ ...resv('10:00'), companion_id: 'c-a', companion_of: null, companion_name: '試験エー' }])
    }
    if (name === 'customer_list_reservations' && fixtureState.resv !== 'off') {
      return fixtureState.resv === 'down' ? outage : fixtureState.resv === 'none' ? ok([]) : ok([resv(fixtureState.resv)])
    }
    if (name === 'customer_booking_options') {
      // menuRecovers：銀ちゃんを開いた最初の1回だけ 503（アプリの起動時の分は数えない）。
      // menuDown：銀ちゃんを開いてからずっと 503 → 「読み込み直す」を押したら直る
      if (scenario === 'menuRecovers' && fixtureState.failNext) { fixtureState.failNext = false; return outage }
      if (scenario === 'menuDown' && fixtureState.chat && !fixtureState.up) return outage
      return ok({ menus, staff: [] })
    }
    // holdNetwork：最初の枠の照会だけ通信の失敗
    if (name === 'customer_get_hold' && scenario === 'holdNetwork' && !fixtureState.up) { fixtureState.up = true; return outage }
    if (name === 'customer_get_hold') return ok(scenario === 'holdExpired' ? { error: 'hold_expired' } : hold)
    return ok(shellReplies[name] ?? null)
  }
  return { calls, respond }
}

async function prepare(browser, origin, scenario, { signedIn, firstGuide, path, pendingAt, noUser = false, stale = false }) {
  const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' })
  const rpc = makeRpcFixture(scenario)
  try {
    await context.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.origin !== origin) return route.abort()
      if (request.method() === 'POST' && url.pathname.startsWith('/rest/v1/rpc/')) {
        let body = null
        try { body = request.postDataJSON() } catch { /* 本文なし */ }
        return route.fulfill(rpc.respond(url.pathname.split('/').at(-1), body))
      }
      if (request.method() !== 'GET' && request.method() !== 'HEAD') return route.abort()
      return route.continue()
    })
    await context.addInitScript(({ user, token, staleToken, stale, signedIn, firstGuide, holdId, pendingAt, noUser }) => {
      if (sessionStorage.getItem('qa_entry_init')) return // 1回目の読み込みだけ整える
      sessionStorage.setItem('qa_entry_init', '1')
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: true })
      if (!noUser) localStorage.setItem('ginjiro_user_id', JSON.stringify(user))
      if (signedIn) localStorage.setItem('ginjiro_customer_session', token)
      if (stale) localStorage.setItem('ginjiro_customer_session', staleToken)
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
    }, { user, token, staleToken, stale, signedIn, firstGuide, holdId, pendingAt, noUser })
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
/** 会員が変わった時に端末から消すもの（customerSession.ts の MEMBER_LOCAL_KEYS をそのまま読む） */
const memberLocalKeys = [...(/MEMBER_LOCAL_KEYS = \[([\s\S]*?)\]/.exec(fs.readFileSync(new URL('../src/utils/customerSession.ts', import.meta.url), 'utf8'))?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1])
if (memberLocalKeys.length < 10) throw new Error('MEMBER_LOCAL_KEYS を読めませんでした')
/** Face ID のログインと同じ順（adoptMember → saveCustomerSession の合図 → 画面の読み込み直し）。
 *  newMember：端末に会員情報が無い・別の会員だった時は、会員ごとの保存を消す */
const passkeyLogin = (page, newMember = false) => page.evaluate(({ token, user, keys, newMember }) => {
  if (newMember) for (const k of keys) localStorage.removeItem(k)
  localStorage.setItem('ginjiro_user_id', JSON.stringify(user))
  localStorage.setItem('ginjiro_customer_session', token)
  window.dispatchEvent(new Event('ginjiro:customer-session-changed'))
  window.location.reload()
}, { token, user, keys: memberLocalKeys, newMember })
/** 枠の案内がちょうど1つ出ている */
async function offeredOnce(page) {
  await chat(page).getByText(/キャンセルが出ました/).waitFor()
  await page.waitForTimeout(500)
  assert.equal(await chat(page).getByText(/キャンセルが出ました/).count(), 1)
}
/** 【今回は見送る】と答えたら、預かりは消える */
async function answerOffer(page) {
  await page.getByRole('button', { name: '今回は見送る', exact: true }).click()
  await chat(page).getByText(/キャンセル待ちを外しておきました/).waitFor()
  assert.equal(await page.evaluate(() => localStorage.getItem('ginjiro_pending_hold')), null)
}
/** お知らせの係（sw.js）からの「キャンセル待ちの枠」（アプリを開いたまま、お知らせが来た・押した） */
const swHold = (page, id = holdId) => page.evaluate(url => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'gin-hold', url } })), `/?tab=reserve&johnny=1&hold=${id}`)
/** お知らせの係が受け箱に置いた枠（sw.js keepHold と同じ形） */
const putHoldBox = (page, at = 0) => page.evaluate(async ({ url, at }) => {
  const box = await caches.open('ginjiro-hold-box')
  await box.put('/__gin-hold', new Response(JSON.stringify({ url, at: Date.now() - at })))
}, { url: `${new URL('/', 'http://x').pathname}?tab=reserve&johnny=1&hold=${holdId}`, at })
/** ログインできた時と同じ合図（saveCustomerSession が出すもの） */
const signIn = page => page.evaluate(token => {
  localStorage.setItem('ginjiro_customer_session', token)
  window.dispatchEvent(new Event('ginjiro:customer-session-changed'))
}, token)

/** 銀ちゃんの予約を開いて、メニューの一覧を開くところまで進める */
async function openMenuList(page) {
  await page.getByRole('button', { name: '次回予約', exact: true }).click()
  fixtureState.chat = true
  fixtureState.failNext = true
  await page.getByRole('button', { name: 'AI予約する', exact: true }).click()
  await chat(page).waitFor()
  const list = page.getByRole('button', { name: '一覧から選ぶ', exact: true })
  try { await list.waitFor({ timeout: 6000 }) } catch {
    // 途中で別の質問が出たら、何を聞いているかを出して止める（試験の作り直し用）
    throw new Error('一覧から選ぶ が出ない: ' + (await chat(page).innerText()).slice(-300))
  }
  await list.click()
  return page.getByRole('dialog', { name: 'メニューを選ぶ' })
}

const lists = f => f.calls.filter(name => name === 'customer_list_reservations').length
/** 画面を離れて戻ってきた時の合図を、重ねて送る（iPhone はまとめて来ることがある） */
const goAway = page => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('pagehide'))
})
const showAgain = page => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  document.dispatchEvent(new Event('visibilitychange'))
})
const pageShow = page => page.evaluate(() => { const e = new Event('pageshow'); Object.defineProperty(e, 'persisted', { value: true }); window.dispatchEvent(e) })
const comeBack = async page => { await goAway(page); await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  document.dispatchEvent(new Event('visibilitychange'))
  document.dispatchEvent(new Event('visibilitychange'))
  const e = new Event('pageshow'); Object.defineProperty(e, 'persisted', { value: true }); window.dispatchEvent(e)
}) }

const cases = {
  async mateIntent(browser, origin) {
    const f = await prepare(browser, origin, 'mate', { signedIn: true, path: '/' })
    try {
      await f.page.getByRole('button', { name: '次回予約', exact: true }).waitFor()
      await f.page.evaluate(() => window.dispatchEvent(new CustomEvent('ginjiro:gin-book', { detail: { menuCode: null, label: '' } })))
      await f.page.getByRole('button', { name: 'お連れ様の予約をする', exact: true }).click()
      const group = f.page.getByRole('group', { name: 'ご予約の方' })
      await group.waitFor()
      const btn = name => group.getByRole('button', { name: new RegExp(name) })
      assert.equal(await btn('試験ビー').getAttribute('aria-pressed'), 'true')
      assert.equal(await btn('ご本人').getAttribute('aria-pressed'), 'false')
      assert(await btn('試験エー').isDisabled()) // 予約済み
      await f.page.getByRole('button', { name: /次へ（1名）/ }).waitFor()
    } finally { await f.close() }
  },

  async nextResume(browser, origin) {
    fixtureState.resv = '10:00'
    const f = await prepare(browser, origin, 'next', { signedIn: true, path: '/?tab=next' })
    fixtureState.resv = '10:00'
    try {
      const panel = f.page.getByRole('region', { name: '次のご予約' })
      await panel.getByText('10:00〜').waitFor()
      await f.page.waitForTimeout(400)
      const before = lists(f)
      fixtureState.resv = '11:00' // ほかの端末で変更された
      await comeBack(f.page)
      await panel.getByText('11:00〜').waitFor()
      assert.equal(await panel.getByText('10:00〜').count(), 0)
      await f.page.waitForTimeout(400)
      assert.equal(lists(f) - before, 1)
    } finally { await f.close() }
  },
  // SR-10（再検査）：1回の復帰で visibilitychange の応答が返ったあとに pageshow が来ても、照会は1回。
  //   しばらくして本当にもう一度戻ってきた時は、また読み直す
  async nextResumeSequential(browser, origin) {
    fixtureState.resv = '10:00'
    const f = await prepare(browser, origin, 'next', { signedIn: true, path: '/?tab=next' })
    fixtureState.resv = '10:00'
    try {
      const panel = f.page.getByRole('region', { name: '次のご予約' })
      await panel.getByText('10:00〜').waitFor()
      await f.page.waitForTimeout(400)
      const before = lists(f)
      fixtureState.resv = '11:00'
      await goAway(f.page)
      await showAgain(f.page)
      await panel.getByText('11:00〜').waitFor()
      await f.page.waitForTimeout(300) // 応答が返ったあと
      await pageShow(f.page)
      await f.page.waitForTimeout(500)
      assert.equal(lists(f) - before, 1)
      // 1分後にまた戻ってきた（取り消されていた）
      fixtureState.resv = '12:00'
      await f.page.clock.setFixedTime(new Date(fixedTime.getTime() + 60_000))
      await goAway(f.page)
      await showAgain(f.page)
      await panel.getByText('12:00〜').waitFor()
      assert.equal(lists(f) - before, 2)
    } finally { await f.close() }
  },
  // SR-10（再検査2）：3秒以内でも、一度離れてまた戻ってきたら別の復帰。もう一度読み直す
  async nextResumeTwiceQuickly(browser, origin) {
    fixtureState.resv = '10:00'
    const f = await prepare(browser, origin, 'next', { signedIn: true, path: '/?tab=next' })
    fixtureState.resv = '10:00'
    try {
      const panel = f.page.getByRole('region', { name: '次のご予約' })
      await panel.getByText('10:00〜').waitFor()
      await f.page.waitForTimeout(400)
      const before = lists(f)
      fixtureState.resv = '11:00'
      await comeBack(f.page)
      await panel.getByText('11:00〜').waitFor()
      fixtureState.resv = '12:00' // すぐ離れて、ほかの端末で変更されてから戻った（時計は進めない＝3秒以内）
      await comeBack(f.page)
      await panel.getByText('12:00〜').waitFor()
      await f.page.waitForTimeout(400)
      assert.equal(lists(f) - before, 2)
    } finally { await f.close() }
  },
  // SR-10（再検査2）：別の読み直しで取消を反映した直後に、同じ復帰の pageshow が来ても、古い応答で予約を戻さない
  async nextResumeNoStaleOverwrite(browser, origin) {
    fixtureState.resv = '10:00'
    const f = await prepare(browser, origin, 'next', { signedIn: true, path: '/?tab=next' })
    fixtureState.resv = '10:00'
    try {
      const panel = f.page.getByRole('region', { name: '次のご予約' })
      await panel.getByText('10:00〜').waitFor()
      await f.page.waitForTimeout(400)
      fixtureState.resv = '11:00'
      await goAway(f.page)
      await showAgain(f.page)
      await panel.getByText('11:00〜').waitFor()
      fixtureState.resv = 'none' // 取り消された → 別の読み直し
      await f.page.evaluate(() => window.dispatchEvent(new Event('ginjiro:reservation-changed')))
      await f.page.waitForFunction(() => !document.body.innerText.includes('11:00〜'))
      await pageShow(f.page)
      await f.page.waitForTimeout(600)
      assert.equal(await panel.getByText('11:00〜').count(), 0)
      assert.equal(await panel.getByText('ご予約確定').count(), 0)
    } finally { await f.close() }
  },
  async nextResumeFailed(browser, origin) {
    fixtureState.resv = '10:00'
    const f = await prepare(browser, origin, 'next', { signedIn: true, path: '/?tab=next' })
    fixtureState.resv = '10:00'
    try {
      const panel = f.page.getByRole('region', { name: '次のご予約' })
      await panel.getByText('ご予約確定').waitFor()
      fixtureState.resv = 'down'
      await comeBack(f.page)
      await panel.getByText(/前に確認した内容を表示しています/).waitFor()
      assert.equal(await panel.getByText('ご予約確定').count(), 0)
    } finally { await f.close() }
  },

  async menuRecovers(browser, origin) {
    const f = await prepare(browser, origin, 'menuRecovers', { signedIn: true, path: '/' })
    try {
      const sheet = await openMenuList(f.page)
      await sheet.getByRole('button', { name: /試験パンチパーマ/ }).waitFor()
      assert.equal(await sheet.locator('.mp-row').count(), 4)
      assert.equal(await sheet.getByText('見つかりませんでした', { exact: false }).count(), 0)
    } finally { await f.close() }
  },
  async menuDown(browser, origin) {
    const f = await prepare(browser, origin, 'menuDown', { signedIn: true, path: '/' })
    try {
      const sheet = await openMenuList(f.page)
      await sheet.getByText(/メニューを読み込めませんでした/).waitFor()
      if (process.env.ENTRY_SHOTS) await f.page.screenshot({ path: process.env.ENTRY_SHOTS + '/sr07-failed.png' })
      assert.equal(await sheet.getByText('見つかりませんでした', { exact: false }).count(), 0)
      fixtureState.up = true
      await sheet.getByRole('button', { name: '読み込み直す' }).click()
      await sheet.getByRole('button', { name: /試験カット/ }).waitFor()
      assert.equal(await sheet.locator('.mp-row').count(), 4)
    } finally { await f.close() }
  },

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
  // 11/19 本番の実機：アプリを開いたまま（会員QR）お知らせを押すと、何も出なかった。
  //   お知らせの係から枠を受け取ったら、その場で1回だけ聞く（来た時と押した時の2回届いても1回）
  async holdWhileOpen(browser, origin) {
    const f = await prepare(browser, origin, 'hold', { signedIn: true, path: '/' })
    try {
      await f.page.getByRole('button', { name: '会員QR' }).first().click()
      await f.page.waitForTimeout(400)
      assert.equal(await chat(f.page).count(), 0)
      await swHold(f.page)
      await swHold(f.page)
      await offeredOnce(f.page)
      assert.equal(holdCalls(f), 1)
      await answerOffer(f.page)
      await swHold(f.page) // 答えたあとに、もう一度押しても聞き直さない
      await f.page.waitForTimeout(500)
      assert.equal(holdCalls(f), 1)
    } finally { await f.close() }
  },
  // 11/19 Staging の実機：iPhone では直接の受け渡しも届かない。受け箱に置かれた枠を、前に出た時に拾って1回だけ聞く
  async holdBoxOnResume(browser, origin) {
    const f = await prepare(browser, origin, 'hold', { signedIn: true, path: '/' })
    try {
      await f.page.getByRole('button', { name: '会員QR' }).first().click()
      await goAway(f.page)
      await putHoldBox(f.page)
      await showAgain(f.page)
      await offeredOnce(f.page)
      assert.equal(holdCalls(f), 1)
      assert.equal(await f.page.evaluate(async () => (await caches.open('ginjiro-hold-box')).match('/__gin-hold').then(r => !!r)), false)
      await answerOffer(f.page)
      await f.page.waitForTimeout(4500) // 数秒ごとの見回りでも、もう聞かない
      assert.equal(holdCalls(f), 1)
    } finally { await f.close() }
  },
  // 画面に出したまま届いた（前に出る合図が無い）：数秒ごとの見回りで拾う
  async holdBoxWhileVisible(browser, origin) {
    const f = await prepare(browser, origin, 'hold', { signedIn: true, path: '/' })
    try {
      await f.page.waitForTimeout(500)
      await putHoldBox(f.page)
      await chat(f.page).getByText(/キャンセルが出ました/).waitFor({ timeout: 8000 })
      await offeredOnce(f.page)
      await answerOffer(f.page)
    } finally { await f.close() }
  },
  // 古い枠（15分より前）は拾わない
  async holdBoxTooOld(browser, origin) {
    const f = await prepare(browser, origin, 'hold', { signedIn: true, path: '/' })
    try {
      await putHoldBox(f.page, 16 * 60e3)
      await goAway(f.page)
      await showAgain(f.page)
      await f.page.waitForTimeout(1000)
      assert.equal(holdCalls(f), 0)
      assert.equal(await chat(f.page).count(), 0)
    } finally { await f.close() }
  },
  // 同じく、ログインしていない時：ログインの画面へ。ログインできたら1回だけ聞く。関係ない合図・壊れた枠IDは何もしない
  async holdWhileOpenSignedOut(browser, origin) {
    const f = await prepare(browser, origin, 'hold', { signedIn: false, path: '/' })
    try {
      await f.page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'gin-hold', url: '/?hold=not-a-hold' } })))
      await f.page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'sb-cancel' } })))
      await f.page.waitForTimeout(300)
      assert.equal(await f.page.evaluate(() => localStorage.getItem('ginjiro_pending_hold')), null)
      await swHold(f.page)
      await f.page.getByRole('heading', { name: 'ログインと引き継ぎ' }).waitFor()
      assert.equal(holdCalls(f), 0)
      await signIn(f.page)
      await offeredOnce(f.page)
      assert.equal(holdCalls(f), 1)
      await answerOffer(f.page)
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
      await answerOffer(f.page)
    } finally { await f.close() }
  },
  // SR-06（再検査）：Face ID のログインは成功のあと読み込み直す。同じ会員の端末・会員情報の無い端末の両方で、読み込み直したあとに枠を1回聞く
  async holdPasskeySameMember(browser, origin) {
    const f = await prepare(browser, origin, 'hold', { signedIn: false, path: `/?tab=reserve&johnny=1&hold=${holdId}` })
    try {
      await f.page.getByRole('heading', { name: 'ログインと引き継ぎ' }).waitFor()
      await Promise.all([f.page.waitForEvent('load'), passkeyLogin(f.page)])
      await offeredOnce(f.page)
      await answerOffer(f.page)
    } finally { await f.close() }
  },
  async holdPasskeyNewMember(browser, origin) {
    const f = await prepare(browser, origin, 'hold', { signedIn: false, noUser: true, path: `/?tab=reserve&johnny=1&hold=${holdId}` })
    try {
      await f.page.getByRole('heading', { name: 'ログインと引き継ぎ' }).waitFor()
      await Promise.all([f.page.waitForEvent('load'), passkeyLogin(f.page, true)])
      await offeredOnce(f.page)
      await answerOffer(f.page)
      // 答えたあとに読み込み直しても、もう聞かない
      const n = holdCalls(f)
      await f.page.reload()
      await f.page.getByRole('button', { name: '次回予約', exact: true }).waitFor()
      await f.page.waitForTimeout(800)
      assert.equal(holdCalls(f), n)
      assert.equal(await chat(f.page).count(), 0)
    } finally { await f.close() }
  },
  // SR-06：通信が速く、読み込み直しの前に枠の答えが届いても、読み込み直したあとにもう一度聞ける
  async holdAnsweredBeforeReload(browser, origin) {
    const f = await prepare(browser, origin, 'hold', { signedIn: false, path: `/?tab=reserve&johnny=1&hold=${holdId}` })
    try {
      await f.page.getByRole('heading', { name: 'ログインと引き継ぎ' }).waitFor()
      await signIn(f.page)
      await chat(f.page).getByText(/キャンセルが出ました/).waitFor()
      await f.page.reload()
      await offeredOnce(f.page)
      await answerOffer(f.page)
    } finally { await f.close() }
  },
  // SR-06（再検査2）：端末に残ったログインが期限切れ。お知らせを開いても枠IDは残り、ログインし直したら1回聞く
  async holdStaleSession(browser, origin) {
    const f = await prepare(browser, origin, 'hold', { signedIn: false, stale: true, path: `/?tab=reserve&johnny=1&hold=${holdId}` })
    const pending = () => f.page.evaluate(() => JSON.parse(localStorage.getItem('ginjiro_pending_hold') ?? 'null')?.holdId ?? null)
    try {
      await f.page.waitForFunction(() => localStorage.getItem('ginjiro_customer_session') === null) // 期限切れでログインが外れた
      await f.page.waitForTimeout(1000)
      assert.equal(await pending(), holdId)
      // 銀ちゃんが開いていたら閉じる（ログインが外れたまま閉じても、預かりは消えない）
      if (await chat(f.page).count()) await f.page.locator('.lc-close').click()
      await f.page.waitForTimeout(300)
      assert.equal(await pending(), holdId)
      const n = holdCalls(f)
      await Promise.all([f.page.waitForEvent('load'), passkeyLogin(f.page)])
      await offeredOnce(f.page)
      assert(holdCalls(f) > n)
      await answerOffer(f.page)
    } finally { await f.close() }
  },
  // SR-06（再検査2）：枠の照会が通信の失敗（読み込み直しで切れた時も同じ）なら預かりは消さず、開き直したら聞ける
  async holdNetwork(browser, origin) {
    const f = await prepare(browser, origin, 'holdNetwork', { signedIn: true, path: `/?tab=reserve&johnny=1&hold=${holdId}` })
    try {
      await chat(f.page).getByText(/通信の具合で確認できませんでした/).waitFor()
      assert.equal(await f.page.evaluate(() => JSON.parse(localStorage.getItem('ginjiro_pending_hold') ?? 'null')?.holdId ?? null), holdId)
      await f.page.reload()
      await offeredOnce(f.page)
      await answerOffer(f.page)
    } finally { await f.close() }
  },
  // SR-06（再検査3）：通信の失敗の案内から【ホームへ】で閉じても預かりは残り、ログインし直したら1回聞く
  async holdNetworkGoHome(browser, origin) {
    const f = await prepare(browser, origin, 'holdNetwork', { signedIn: true, path: `/?tab=reserve&johnny=1&hold=${holdId}` })
    const pending = () => f.page.evaluate(() => JSON.parse(localStorage.getItem('ginjiro_pending_hold') ?? 'null')?.holdId ?? null)
    try {
      await chat(f.page).getByText(/通信の具合で確認できませんでした/).waitFor()
      await f.page.getByRole('button', { name: 'ホームへ', exact: true }).click()
      await chat(f.page).waitFor({ state: 'detached' })
      assert.equal(await pending(), holdId)
      const n = holdCalls(f)
      await Promise.all([f.page.waitForEvent('load'), passkeyLogin(f.page)])
      await offeredOnce(f.page)
      assert.equal(holdCalls(f) - n, 1)
      await answerOffer(f.page)
    } finally { await f.close() }
  },
  // SR-06（再検査4）：枠が取れてから案内文が出るまでの間（入力中の表示）に【あとで】で閉じても、預かりは残る
  async holdClosedBeforeShown(browser, origin) {
    const f = await prepare(browser, origin, 'hold', { signedIn: true, path: '/' })
    try {
      await f.page.getByRole('button', { name: '次回予約', exact: true }).waitFor()
      await f.page.evaluate(id => localStorage.setItem('ginjiro_pending_hold', JSON.stringify({ holdId: id, at: Date.now() })), holdId)
      // 枠の照会の応答が届いて 0.2 秒後（案内文の入力中の表示 0.46 秒の間）に【あとで】を押す
      await f.page.evaluate(() => {
        const orig = window.fetch
        window.fetch = async (...args) => {
          const res = await orig(...args)
          if (String(args[0] instanceof Request ? args[0].url : args[0]).endsWith('/rpc/customer_get_hold')) {
            setTimeout(() => { window.__closedBeforeShown = !document.querySelector('.gc-log')?.innerText.includes('キャンセルが出ました'); document.querySelector('.lc-close')?.click() }, 200)
          }
          return res
        }
      })
      await f.page.evaluate(id => window.dispatchEvent(new CustomEvent('ginjiro:gin-offer', { detail: { holdId: id } })), holdId)
      await chat(f.page).waitFor({ state: 'detached' })
      assert.equal(await f.page.evaluate(() => window.__closedBeforeShown), true) // 案内文が出る前に閉じた
      assert.equal(holdCalls(f), 1)
      assert.equal(await f.page.evaluate(() => JSON.parse(localStorage.getItem('ginjiro_pending_hold') ?? 'null')?.holdId ?? null), holdId)
      // 次に開いた時（ログインし直し・読み込み直し）に聞ける
      await f.page.reload()
      await offeredOnce(f.page)
      await answerOffer(f.page)
    } finally { await f.close() }
  },
  // SR-06（再検査3）：枠をお見せしてから答えずに閉じたら、預かりは消える（次に開いた時にくり返し聞かない）
  async holdShownThenClosed(browser, origin) {
    const f = await prepare(browser, origin, 'hold', { signedIn: true, path: `/?tab=reserve&johnny=1&hold=${holdId}` })
    try {
      await offeredOnce(f.page)
      await f.page.locator('.lc-close').click()
      await chat(f.page).waitFor({ state: 'detached' })
      assert.equal(await f.page.evaluate(() => localStorage.getItem('ginjiro_pending_hold')), null)
      const n = holdCalls(f)
      await f.page.reload()
      await f.page.getByRole('button', { name: '次回予約', exact: true }).waitFor()
      await f.page.waitForTimeout(800)
      assert.equal(holdCalls(f), n)
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
