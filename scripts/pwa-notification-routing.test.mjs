import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const worker = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8')
const origin = 'http://localhost:43995'

async function clickNotification(url, paths, { navigationFails = false } = {}) {
  const handlers = new Map()
  const calls = []
  const windows = paths.map(path => ({
    url: new URL(path, origin).href,
    async navigate(destination) {
      calls.push(['navigate', path, destination])
      if (navigationFails) throw new Error('Window closed')
      return this
    },
    async focus() { calls.push(['focus', path]) },
    postMessage(message) { calls.push(['message', path, message.type, message.url]) },
  }))
  runInNewContext(worker, {
    URL,
    self: {
      location: new URL('/sw.js', origin),
      addEventListener: (name, handle) => handlers.set(name, handle),
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async destination => { calls.push(['open', destination]) },
    },
  })
  let completion
  handlers.get('notificationclick')({
    notification: { data: { url }, close: () => calls.push(['close']) },
    waitUntil: promise => { completion = promise },
  })
  await completion
  return calls
}

test('an SB notification reuses the SB window even if the terminal is listed first', async () => {
  assert.deepEqual(await clickNotification('/sb', ['/staff', '/sb', '/']), [
    ['close'], ['navigate', '/sb', origin + '/sb'], ['focus', '/sb'],
  ])
})

test('a customer notification preserves the full link and reuses the customer window', async () => {
  const url = '/?tab=next'
  assert.deepEqual(await clickNotification(url, ['/headquarters', '/?tab=tickets']), [
    ['close'], ['navigate', '/?tab=tickets', origin + url], ['focus', '/?tab=tickets'],
  ])
})

// 11/19 本番の実機：iPhone では裏で開いたアプリの読み込み直しが効かず、会員QRのままだった。枠は開いている画面へ直接渡す
test('a waitlist notification hands the full link to the open customer window instead of reloading it', async () => {
  const url = '/?tab=reserve&johnny=1&hold=test'
  assert.deepEqual(await clickNotification(url, ['/headquarters', '/?tab=tickets']), [
    ['close'], ['message', '/?tab=tickets', 'gin-hold', origin + url], ['focus', '/?tab=tickets'],
  ])
})

test('a notification opens its destination when only a different app is running', async () => {
  assert.deepEqual(await clickNotification('/sb', ['/staff']), [
    ['close'], ['open', origin + '/sb'],
  ])
})

test('a closed matching window falls back to opening the destination', async () => {
  assert.deepEqual(await clickNotification('/sb', ['/sb'], { navigationFails: true }), [
    ['close'], ['navigate', '/sb', origin + '/sb'], ['open', origin + '/sb'],
  ])
})

test('a notification with an external destination opens it in a separate window', async () => {
  const url = 'https://example.test/booking'
  assert.deepEqual(await clickNotification(url, ['/booking']), [
    ['close'], ['open', url],
  ])
})
