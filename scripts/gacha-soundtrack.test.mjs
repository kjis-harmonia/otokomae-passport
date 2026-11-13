import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../src/audio/gachaSoundtrack.ts', import.meta.url), 'utf8')
const module = { exports: {} }
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: module.exports, setTimeout, clearTimeout })
const { GachaSoundtrack, INTRO_CROSSFADE, OPEN_CROSSFADE, RESULT_CUE_MAX } = module.exports
function fixture() {
  const nodes = []
  const param = () => ({ value: 1, events: [], setValueAtTime(v, t) { this.events.push(['set', v, t]) }, cancelScheduledValues(t) { this.events.push(['cancel', t]) }, linearRampToValueAtTime(v, t) { this.events.push(['ramp', v, t]) } })
  const ctx = { state: 'running', currentTime: 0, destination: {}, addEventListener() {}, removeEventListener() {}, createGain() { return { gain: param(), connect() {}, disconnect() {} } }, createBufferSource() { const n = { loop: false, connect(g) { this.gain = g }, disconnect() {}, start(...a) { this.starts = a }, stop(t) { this.stopped = t } }; nodes.push(n); return n }, resume: async () => {} }
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
  const mediaEvents = new Map()
  const listeners = new Set()
  mediaEvents.set('timeupdate', listeners)
  const video = {
    currentTime: 0, paused: false, seeking: false, readyState: 2, HAVE_CURRENT_DATA: 2,
    addEventListener(type, listener) {
      if (!mediaEvents.has(type)) mediaEvents.set(type, new Set())
      mediaEvents.get(type).add(listener)
    },
    removeEventListener(type, listener) { mediaEvents.get(type)?.delete(listener) },
  }
  if (native) Object.assign(video, {
    requestVideoFrameCallback(fn) { const id = next++; frames.set(id, fn); return id },
    cancelVideoFrameCallback(id) { cancelled.push(id); frames.delete(id) },
  })
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports: module.exports, requestAnimationFrame(fn) { const id = next++; paints.set(id, fn); return id }, cancelAnimationFrame(id) { cancelled.push(id); paints.delete(id) } })
  const paint = () => { const batch = [...paints.values()]; paints.clear(); batch.forEach(fn => fn()) }
  const emit = type => mediaEvents.get(type)?.forEach(listener => listener())
  const progress = time => { video.currentTime = time; emit('timeupdate') }
  return { after: module.exports.afterPresentedFrame, video, frames, paints, paint, cancelled, progress, listeners, emit }
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

test('a missing frame notification falls back only after a playing video advances', () => {
  const { after, video, frames, progress, listeners } = frameFixture()
  let shown = 0
  progress(2)
  after(video, () => shown++)
  const late = [...frames.values()][0]
  progress(2.1)
  video.paused = true
  progress(2.2)
  video.paused = false
  video.seeking = true
  progress(2.3)
  video.seeking = false
  video.readyState = 1
  progress(2.4)
  assert.equal(shown, 0)
  video.readyState = 2
  progress(2.5)
  late()
  assert.equal(shown, 1)
  assert.equal(frames.size, 0)
  assert.equal(listeners.size, 0)
})

test('closing also removes the media-clock fallback', () => {
  const { after, video, progress, listeners } = frameFixture()
  let shown = 0
  const cancel = after(video, () => shown++)
  cancel()
  progress(0.3)
  assert.equal(shown, 0)
  assert.equal(listeners.size, 0)
})

test('late frame and paint callbacks do not reveal a paused or seeking video', () => {
  for (const native of [true, false]) {
    const { after, video, frames, paint, progress, emit } = frameFixture(native)
    let shown = 0
    after(video, () => shown++)
    video.paused = true
    if (native) [...frames.values()][0]()
    else { paint(); paint() }
    assert.equal(shown, 0)
    video.paused = false
    emit('seeking')
    progress(8)
    assert.equal(shown, 0)
    emit('seeked')
    progress(8.1)
    assert.equal(shown, 0)
    progress(8.2)
    assert.equal(shown, 1)
  }
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


// Permission recovery uses the production coordinator, not a duplicate implementation.
const playbackModule = { exports: {} }
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/audio/gachaAudioPlayback.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: playbackModule.exports })
const { GachaAudioPlayback } = playbackModule.exports
const { requestGachaPlaybackSession } = module.exports
function playbackFixture() {
  const f = fixture(), statuses = []
  let position = { phase: 'intro', offset: 3, presented: true }
  const listeners = new Set()
  f.ctx.addEventListener = (_, fn) => listeners.add(fn)
  f.ctx.removeEventListener = (_, fn) => listeners.delete(fn)
  const playback = new GachaAudioPlayback(() => f.audio, () => position, status => statuses.push(status))
  return { ...f, playback, statuses, setPosition: p => { position = p },
    interrupt: () => { f.ctx.state = 'suspended'; listeners.forEach(fn => fn()) }, listeners }
}
test('resume rejection is exposed by the soundtrack and produces a blocked status with no voice', async () => {
  const f = playbackFixture()
  f.ctx.resume = async () => { throw new Error('NotAllowedError') }
  await assert.rejects(f.audio.unlock(), /NotAllowedError/)
  await f.playback.unlock(); f.playback.sync()
  assert.equal(f.statuses.at(-1), 'blocked')
  assert.equal(f.nodes.length, 0)
  f.playback.dispose()
})
test('resolved resume with a still-suspended context is not reported as audible', async () => {
  const f = playbackFixture(); f.ctx.state = 'suspended'
  await f.playback.unlock()
  assert.equal(f.statuses.at(-1), 'blocked')
  assert.equal(f.nodes.length, 0)
  f.playback.dispose()
})
test('a never-settling resume reaches the recovery state rather than waiting forever', async () => {
  const tasks = new Map(); let id = 0
  const mod = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports: mod.exports, setTimeout: (fn, ms) => { tasks.set(++id, { fn, ms }); return id }, clearTimeout: key => tasks.delete(key) })
  const f = fixture(); f.ctx.resume = () => new Promise(() => {})
  const sound = new mod.exports.GachaSoundtrack(f.ctx, { intro: { duration: 28 }, wait: { duration: 4 }, open: { duration: 16 } })
  const attempt = sound.unlock()
  const timeout = [...tasks.values()][0]
  assert.equal(timeout.ms, mod.exports.AUDIO_UNLOCK_TIMEOUT_MS)
  timeout.fn()
  await assert.rejects(attempt, /audio_resume_timeout/)
  assert.equal(tasks.size, 0)
})
test('retry uses the latest presented intro position, once, without restarting the movie', async () => {
  const f = playbackFixture(); f.ctx.resume = async () => { throw new Error('blocked') }
  await f.playback.unlock()
  f.ctx.resume = async () => { f.ctx.state = 'running' }
  f.setPosition({ phase: 'intro', offset: 12, presented: true })
  await f.playback.unlock(); f.playback.sync(); f.playback.sync()
  assert.equal(f.statuses.at(-1), 'ready')
  assert.equal(f.nodes.length, 2)
  assert.equal(f.nodes[0].starts[1], 12)
  f.playback.dispose()
})
test('permission success waits for a presented frame before scheduling audio', async () => {
  const f = playbackFixture(); f.setPosition({ phase: 'intro', offset: 0, presented: false })
  await f.playback.unlock()
  assert.equal(f.nodes.length, 0)
  f.setPosition({ phase: 'intro', offset: .4, presented: true }); f.playback.sync()
  assert.equal(f.nodes[0].starts[1], .4)
  f.playback.dispose()
})
test('permission resolved after intro ends starts the waiting loop, not stale intro audio', async () => {
  const f = playbackFixture(); let resolve
  f.ctx.resume = () => new Promise(r => { resolve = r })
  const attempt = f.playback.unlock()
  f.setPosition({ phase: 'tap', offset: 2, presented: true }); resolve()
  await attempt
  assert.equal(f.nodes.length, 1)
  assert.equal(f.nodes[0].loop, true)
  assert.equal(f.nodes[0].starts[1], 2)
  f.playback.dispose()
})
test('late audio permission waits for the waiting video to be ready', async () => {
  const f = playbackFixture()
  f.setPosition({ phase: 'tap', offset: 0, presented: false })
  await f.playback.unlock()
  assert.equal(f.nodes.length, 0)
  f.setPosition({ phase: 'tap', offset: 0.2, presented: true })
  f.playback.sync()
  assert.equal(f.nodes.length, 1)
  assert.equal(f.nodes[0].loop, true)
  assert.equal(f.nodes[0].starts[1], 0.2)
  f.playback.dispose()
})
test('normal intro to waiting does not create another waiting loop', async () => {
  const f = playbackFixture(); await f.playback.unlock()
  f.setPosition({ phase: 'tap', offset: 2, presented: true }); f.playback.sync(); f.playback.sync()
  assert.equal(f.nodes.length, 2)
  f.playback.dispose()
})
test('retry in opening uses current opening position and cannot create duplicate opening voices', async () => {
  const f = playbackFixture(); await f.playback.unlock(); f.interrupt()
  f.ctx.resume = async () => { f.ctx.state = 'running' }
  f.setPosition({ phase: 'open', offset: 7.2, presented: true })
  await f.playback.unlock(); f.playback.sync(); f.playback.sync()
  assert.equal(f.nodes.length, 3)
  assert.equal(f.nodes[2].starts[1], 7.2)
  assert(f.nodes.slice(0, 2).every(n => n.stopped !== undefined))
  f.playback.dispose()
})
test('double tapping audio recovery performs only one resume', async () => {
  const f = playbackFixture(); let resolve; let resumes = 0
  f.ctx.resume = () => { resumes++; return new Promise(r => { resolve = r }) }
  const first = f.playback.unlock(), second = f.playback.unlock()
  assert.equal(resumes, 1); resolve(); await Promise.all([first, second])
  assert.equal(f.nodes.length, 2)
  f.playback.dispose()
})
test('late permission response after close/unmount cannot report ready or start sound', async () => {
  const f = playbackFixture(); let resolve
  f.ctx.resume = () => new Promise(r => { resolve = r })
  const attempt = f.playback.unlock(); f.playback.dispose(); resolve(); await attempt
  assert.equal(f.statuses.includes('ready'), false)
  assert.equal(f.nodes.length, 0)
  assert.equal(f.listeners.size, 0)
})
test('blocked result does not consume its once cue and recovery does not restart intro/open', async () => {
  const f = playbackFixture(); await f.playback.unlock(); f.interrupt()
  f.setPosition({ phase: 'result', offset: 16, presented: true })
  assert.equal(f.playback.result(), false)
  f.ctx.resume = async () => { f.ctx.state = 'running' }; await f.playback.unlock()
  assert.equal(f.nodes.length, 2)
  assert.equal(f.playback.result(), true); assert.equal(f.playback.result(), true)
  assert.equal(f.nodes.length, 3)
  f.playback.dispose()
})
test('closed contexts are replaced on recovery and the old observer is removed', async () => {
  const old = fixture(), fresh = fixture(), observers = new Set(), statuses = []
  old.ctx.addEventListener = (_, fn) => observers.add(fn); old.ctx.removeEventListener = (_, fn) => observers.delete(fn)
  let creates = 0
  const p = new GachaAudioPlayback(() => ++creates === 1 ? old.audio : fresh.audio,
    () => ({ phase: 'open', offset: 5, presented: true }), s => statuses.push(s))
  old.ctx.state = 'closed'; observers.forEach(fn => fn())
  await p.unlock()
  assert.equal(creates, 2); assert.equal(observers.size, 0)
  assert.equal(fresh.nodes.length, 1); assert.equal(fresh.nodes[0].starts[1], 5)
  assert.equal(statuses.at(-1), 'ready'); p.dispose()
})
test('supported AudioSession requests playback and restores the previous mode on release', () => {
  const session = { type: 'auto' }
  const restore = requestGachaPlaybackSession({ audioSession: session })
  assert.equal(session.type, 'playback'); restore(); assert.equal(session.type, 'auto')
})
test('AudioSession cleanup respects another screen changing the session mode', () => {
  const session = { type: 'auto' }, restore = requestGachaPlaybackSession({ audioSession: session })
  session.type = 'play-and-record'; restore(); assert.equal(session.type, 'play-and-record')
})
test('missing or read-only AudioSession remains compatible with ordinary Web Audio', () => {
  assert.doesNotThrow(() => requestGachaPlaybackSession({})())
  const session = { get type() { return 'auto' }, set type(_) { throw new Error('unsupported') } }
  assert.doesNotThrow(() => requestGachaPlaybackSession({ audioSession: session })())
})

test('context recreation failure remains recoverable instead of escaping the button handler', async () => {
  const f = fixture(), statuses = []; let creates = 0
  const p = new GachaAudioPlayback(() => { if (++creates === 2) throw new Error('no audio device'); return f.audio },
    () => ({ phase: 'intro', offset: 5, presented: true }), s => statuses.push(s))
  f.ctx.state = 'closed'
  await p.unlock()
  assert.equal(statuses.at(-1), 'blocked'); assert.equal(f.nodes.length, 0)
  f.ctx.state = 'running'; await p.unlock()
  assert.equal(statuses.at(-1), 'ready'); p.dispose()
})

test('interruption discards frozen old voices immediately instead of replaying an 80ms old-scene tail', async () => {
  const f = playbackFixture(); await f.playback.unlock(); f.ctx.currentTime = 5; f.interrupt()
  for (const n of f.nodes) {
    assert.equal(n.stopped, 5)
    assert.deepEqual(n.gain.gain.events.at(-1), ['set', 0, 5])
  }
  f.ctx.state = 'running'; f.setPosition({ phase: 'intro', offset: 8, presented: true }); await f.playback.unlock()
  assert.equal(f.nodes[0].stopped, 5); assert.equal(f.nodes[1].stopped, 5)
  assert.equal(f.nodes[2].starts[1], 8)
  f.playback.dispose()
})

// 深海編：開く音が急に切れる前に、きれいに消す（11/12）
test('open fade-out lowers the open sound smoothly to zero before the hard cut', () => {
  const { ctx, nodes } = fixture()
  const gains = []; const make = ctx.createGain.bind(ctx); ctx.createGain = () => { const g = make(); gains.push(g); return g }
  const audio = new GachaSoundtrack(ctx, { intro: { duration: 28 }, wait: { duration: 4 }, open: { duration: 14.25 } }, INTRO_CROSSFADE, null, { from: 7.6, to: 9.4 })
  audio.startIntro(0); audio.open(30)
  assert.equal(nodes.length, 3) // 音は増やさない
  const tail = gains.at(-1).gain.events.filter(e => e[0] === 'ramp')
  assert.equal(tail.length, 64)
  assert.equal(tail.at(-1)[1], 0); assert(Math.abs(tail.at(-1)[2] - 39.4) < 1e-9)
  for (let i = 1; i < tail.length; i++) assert(tail[i][1] <= tail[i - 1][1] + 1e-12)
})
test('resuming the open sound after the fade starts at the faded level', () => {
  const { ctx } = fixture()
  const gains = []; const make = ctx.createGain.bind(ctx); ctx.createGain = () => { const g = make(); gains.push(g); return g }
  const audio = new GachaSoundtrack(ctx, { intro: { duration: 28 }, wait: { duration: 4 }, open: { duration: 14.25 } }, INTRO_CROSSFADE, null, { from: 7.6, to: 9.4 })
  audio.open(0, 10)
  assert.deepEqual(gains.at(-1).gain.events[0], ['set', 0, 0])
})
