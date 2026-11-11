import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.window ??= globalThis
globalThis.requestAnimationFrame ??= f => setTimeout(f, 16)
globalThis.cancelAnimationFrame ??= id => clearTimeout(id)
const { afterPresentedFrame, PRESENTED_FALLBACK_MS } = await import('../src/features/gacha/presentedFrame.ts')
const wait = ms => new Promise(r => setTimeout(r, ms))

// 11/11 本番の iPhone：映像のコマの知らせ（requestVideoFrameCallback）が来ず、ガチャの音が始まらなかった
test('コマの知らせが来なくても、一定時間で進む（音が始まる）', async () => {
  const video = { requestVideoFrameCallback: () => 1, cancelVideoFrameCallback: () => {} }
  let n = 0
  afterPresentedFrame(video, () => n++)
  await wait(PRESENTED_FALLBACK_MS + 80)
  assert.equal(n, 1)
})

test('知らせが先に来たら、そのとき1回だけ（保険で2回目は呼ばない）', async () => {
  let cb
  const video = { requestVideoFrameCallback: f => { cb = f; return 1 }, cancelVideoFrameCallback: () => {} }
  let n = 0
  afterPresentedFrame(video, () => n++)
  cb()
  await wait(PRESENTED_FALLBACK_MS + 80)
  assert.equal(n, 1)
})

test('取り消したら呼ばない（画面を閉じたとき）', async () => {
  const video = { requestVideoFrameCallback: () => 1, cancelVideoFrameCallback: () => {} }
  let n = 0
  const cancel = afterPresentedFrame(video, () => n++)
  cancel()
  await wait(PRESENTED_FALLBACK_MS + 80)
  assert.equal(n, 0)
})
