import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../src/audio/gachaSoundtrack.ts', import.meta.url), 'utf8')
const module = { exports: {} }
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: module.exports, setTimeout: fn => fn() })
const { GachaSoundtrack, INTRO_CROSSFADE, OPEN_CROSSFADE, RESULT_CUE_MAX } = module.exports
function fixture() {
  const nodes = []
  const param = () => ({ value: 1, events: [], setValueAtTime(v, t) { this.events.push(['set', v, t]) }, cancelScheduledValues(t) { this.events.push(['cancel', t]) }, linearRampToValueAtTime(v, t) { this.events.push(['ramp', v, t]) } })
  const ctx = { currentTime: 0, destination: {}, createGain() { return { gain: param(), connect() {}, disconnect() {} } }, createBufferSource() { const n = { loop: false, connect(g) { this.gain = g }, disconnect() {}, start(...a) { this.starts = a }, stop(t) { this.stopped = t } }; nodes.push(n); return n }, resume: async () => {} }
  return { ctx, nodes, audio: new GachaSoundtrack(ctx, { intro: { duration: 28 }, wait: { duration: 4 }, open: { duration: 16 }, result: { duration: 0.9 } }) }
}
test('wait is scheduled before the intro finishes and loops on the audio clock', () => {
  const { audio, nodes } = fixture(); audio.startIntro(1)
  assert.equal(nodes[1].loop, true)
  assert.equal(nodes[1].starts[0], 29 - INTRO_CROSSFADE)
  const down = nodes[0].gain.gain.events.filter(e => e[0] === 'ramp').map(e => e[1])
  const up = nodes[1].gain.gain.events.filter(e => e[0] === 'ramp').map(e => e[1])
  assert.equal(up.length, 128)
  for (let i = 0; i < up.length; i++) assert(Math.abs(up[i] ** 2 + down[i] ** 2 - 1) < 1e-6)
})
test('opening fades the waiting sound instead of pausing it at the visual timer', () => {
  const { audio, nodes } = fixture(); audio.startIntro(0); audio.open(33)
  assert.equal(nodes[1].stopped, 33 + OPEN_CROSSFADE)
  assert.equal(nodes[2].starts[0], 33)
  assert.equal(nodes[2].loop, false)
})
test('closing during intro stops the scheduled future loop as well as the current phrase', () => {
  const { audio, nodes } = fixture(); audio.startIntro(0); audio.stop(2)
  assert(nodes.every(n => n.stopped > 2 && n.stopped < 2.1))
})
test('restart releases previous voices and cannot leave two waiting loops playing', () => {
  const { audio, nodes } = fixture(); audio.startIntro(0); audio.startIntro(3)
  assert(nodes[0].stopped < 3.1); assert(nodes[1].stopped < 3.1)
  assert.equal(nodes.filter(n => n.loop && n.stopped === undefined).length, 1)
})

test('a successful result plays one non-looping cue even if the result renders repeatedly', () => {
  const { audio, nodes } = fixture()
  audio.startIntro(0); audio.open(30)
  audio.result(46); audio.result(46.1); audio.result(47)
  assert.equal(nodes.length, 4)
  assert.deepEqual(nodes[3].starts, [46, 0])
  assert.equal(nodes[3].loop, false)
  assert.equal(nodes[3].stopped, 46 + RESULT_CUE_MAX)
  assert.deepEqual(nodes[3].gain.gain.events.at(-1), ['ramp', 0, 46 + RESULT_CUE_MAX])
  assert(nodes.slice(0, 3).every(n => n.stopped > 46 && n.stopped < 46.1))
})

test('closing releases the result cue; only a new playback run resets its once guard', () => {
  const { audio, nodes } = fixture()
  audio.startIntro(0); audio.result(30); audio.stop(30.2); audio.result(31)
  assert.equal(nodes.length, 3)
  assert(nodes[2].stopped < 30.3)
  audio.startIntro(32); audio.result(60)
  assert.equal(nodes.length, 6)
  assert.deepEqual(nodes[5].starts, [60, 0])
})

test('themes without a result audio buffer keep their soundtrack unchanged', () => {
  const { ctx, nodes } = fixture()
  const audio = new GachaSoundtrack(ctx, { intro: { duration: 28 }, wait: { duration: 4 }, open: { duration: 16 } })
  audio.startIntro(0); audio.open(30); audio.result(46)
  assert.equal(nodes.length, 3)
  assert.equal(nodes[2].stopped, undefined)
})

test('a short result sound ends at its own length without padding or a looping tail', () => {
  const { ctx, nodes } = fixture()
  const audio = new GachaSoundtrack(ctx, { intro: { duration: 28 }, wait: { duration: 4 }, open: { duration: 16 }, result: { duration: .04 } })
  audio.startIntro(0); audio.result(40); audio.result(40.02)
  assert.equal(nodes.length, 3)
  assert.equal(nodes[2].stopped, 40.04)
  assert.equal(nodes[2].loop, false)
  assert.deepEqual(nodes[2].gain.gain.events.at(-1), ['ramp', 0, 40.04])
})
test('all video tags stay muted and hidden/closed playback is cleaned up', () => {
  const s = fs.readFileSync(new URL('../src/v2/V2Gacha.tsx', import.meta.url), 'utf8')
  const tags = s.match(/<video\b[^>]+\/>/g)
  assert.equal(tags.length, 3)
  assert(tags.every(t => /\bmuted\b/.test(t)))
  assert(s.includes("window.addEventListener('pagehide', close)"))
  assert(s.includes('sound.current?.dispose()'))
})
test('all gacha MP4s use the mobile-compatible H.264 High profile, not High 4:4:4', () => {
  for (const name of ['intro', 'wait', 'open']) {
    for (const path of [`gacha-${name}.mp4`, `dino/${name}.mp4`]) {
    const bytes = fs.readFileSync(new URL(`../public/gacha/${path}`, import.meta.url))
    const avc = bytes.indexOf(Buffer.from('avcC'))
    assert(avc >= 0, `${name}: missing AVC configuration`)
    assert.equal(bytes[avc + 4], 1)
    assert.equal(bytes[avc + 5], 100, `${name}: expected H.264 High (8-bit 4:2:0)`)
    }
  }
})

function frameFixture(native = true) {
  const source = fs.readFileSync(new URL('../src/features/gacha/presentedFrame.ts', import.meta.url), 'utf8')
  const module = { exports: {} }
  let next = 1
  const frames = new Map()
  const paints = new Map()
  const cancelled = []
  const video = native ? {
    requestVideoFrameCallback(fn) { const id = next++; frames.set(id, fn); return id },
    cancelVideoFrameCallback(id) { cancelled.push(id); frames.delete(id) },
  } : {}
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports: module.exports, requestAnimationFrame(fn) { const id = next++; paints.set(id, fn); return id }, cancelAnimationFrame(id) { cancelled.push(id); paints.delete(id) } })
  const paint = () => { const batch = [...paints.values()]; paints.clear(); batch.forEach(fn => fn()) }
  return { after: module.exports.afterPresentedFrame, video, frames, paints, paint, cancelled }
}

test('next video stays hidden until an actual decoder frame is presented', () => {
  const { after, video, frames } = frameFixture()
  let shown = 0
  after(video, () => shown++)
  assert.equal(shown, 0)
  const callback = [...frames.values()][0]
  callback()
  assert.equal(shown, 1)
  callback()
  assert.equal(shown, 1)
})

test('closing cancels a pending reveal and a late callback cannot reopen it', () => {
  const { after, video, frames, cancelled } = frameFixture()
  let shown = 0
  const cancel = after(video, () => shown++)
  const late = [...frames.values()][0]
  cancel()
  assert.equal(frames.size, 0)
  assert.equal(cancelled.length, 1)
  late()
  assert.equal(shown, 0)
})

test('older WebKit keeps the outgoing picture for two paint opportunities', () => {
  const { after, video, paint } = frameFixture(false)
  let shown = 0
  after(video, () => shown++)
  paint()
  assert.equal(shown, 0)
  paint()
  assert.equal(shown, 1)
})

test('fallback reveal is cancellable between its two paints', () => {
  const { after, video, paint, paints } = frameFixture(false)
  let shown = 0
  const cancel = after(video, () => shown++)
  paint()
  cancel()
  paint()
  assert.equal(shown, 0)
  assert.equal(paints.size, 0)
})

test('a cancelled previous run cannot reveal over the next run', () => {
  const { after, video, frames } = frameFixture()
  const shown = []
  const cancel = after(video, () => shown.push('old'))
  const old = [...frames.values()][0]
  cancel()
  after(video, () => shown.push('new'))
  old()
  assert.deepEqual(shown, [])
  ;[...frames.values()][0]()
  assert.deepEqual(shown, ['new'])
})
