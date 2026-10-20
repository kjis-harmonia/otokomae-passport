import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import { test } from 'node:test'

const bgmSource = await readFile(new URL('../src/audio/bgm.ts', import.meta.url), 'utf8')
const hookSource = await readFile(new URL('../src/hooks/useBgm.ts', import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

class AudioFixture extends EventTarget {
  paused = true
  ended = false
  muted = false
  currentTime = 17
  playCalls = 0
  play() { this.playCalls++; this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve() }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
}

function fixture() {
  const exports = {}, window = new EventTarget(), document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vm.runInNewContext(compile(bgmSource), { exports, window })
  const registered = (playing = false) => { const audio = exports.registerBgmAudio(new AudioFixture()); if (playing) void audio.play(); return audio }
  return { bgm: exports, registered, window, document }
}

function mountHook(f) {
  const slots = [], effects = [], store = new Map(), audios = []
  let cursor = 0
  const react = {
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value } },
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((d, j) => !Object.is(d, slots[i].deps[j]))) { const old = slots[i]; slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = fn() }) } },
  }
  class HookAudio extends AudioFixture { constructor() { super(); audios.push(this) } }
  const exports = {}, localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  vm.runInNewContext(compile(hookSource), { exports, require: name => { if (name === 'react') return react; assert.equal(name, '../audio/bgm'); return f.bgm }, Audio: HookAudio, window: f.window, document: f.document, localStorage })
  const render = () => { cursor = 0; const value = exports.useBgm(); while (effects.length) effects.shift()(); return value }
  return { render, store, audios }
}

test('Johnny stops onboarding BGM even when the normal BGM hook owns no audio', () => {
  const f = fixture(); mountHook(f).render()
  const intro = f.registered(true), time = intro.currentTime
  const close = f.bgm.suspendBgm()
  assert.equal(intro.paused, true); assert.equal(intro.muted, true); assert.equal(intro.currentTime, time)
  close(); assert.equal(intro.paused, false); assert.equal(intro.muted, false)
})

test('all registered tracks pause and only previously playing tracks resume', () => {
  const f = fixture(), intro = f.registered(true), track = f.registered(true), stopped = f.registered()
  const close = f.bgm.suspendBgm()
  for (const audio of [intro, track, stopped]) assert.equal(audio.paused, true)
  close()
  assert.equal(intro.paused, false); assert.equal(track.paused, false); assert.equal(stopped.playCalls, 0)
})

test('a delayed play request is silent and paused again while Johnny stays open', async () => {
  const f = fixture(), track = f.registered(true), close = f.bgm.suspendBgm()
  assert.equal(track.muted, true)
  await track.play()
  assert.equal(track.paused, true); assert.equal(track.muted, true)
  // Some media engines emit playing after the earlier play event.
  track.paused = false; track.dispatchEvent(new Event('playing'))
  assert.equal(track.paused, true)
  close(); assert.equal(track.muted, false)
})

test('audio created after Johnny opens is also blocked, without starting it on close', async () => {
  const f = fixture(), close = f.bgm.suspendBgm(), late = f.registered()
  await late.play(); assert.equal(late.paused, true); assert.equal(late.muted, true)
  const calls = late.playCalls
  close(); assert.equal(late.muted, false); assert.equal(late.playCalls, calls); assert.equal(late.paused, true)
})

test('overlapping suspension owners and duplicate cleanup do not resume early', () => {
  const f = fixture(), track = f.registered(true), first = f.bgm.suspendBgm(), second = f.bgm.suspendBgm()
  first(); first(); assert.equal(track.paused, true); assert.equal(f.bgm.isBgmSuspended(), true)
  second(); second(); assert.equal(track.paused, false); assert.equal(track.playCalls, 2)
})

test('stopping or replacing a track during the conversation never resurrects it', () => {
  const f = fixture(), old = f.registered(true), close = f.bgm.suspendBgm()
  f.bgm.stopAllBgmAudio()
  const replacement = f.registered()
  close(); assert.equal(old.paused, true); assert.equal(old.playCalls, 1); assert.equal(replacement.playCalls, 0)
})

test('preexisting mute is preserved and Johnny speech audio is untouched', () => {
  const f = fixture(), track = f.registered(true), speech = new AudioFixture()
  track.muted = true; void speech.play()
  const close = f.bgm.suspendBgm()
  assert.equal(speech.paused, false); assert.equal(speech.muted, false)
  close(); assert.equal(track.muted, true)
})

test('a rejected resume does not cause an unhandled rejection or automatic retry', async () => {
  const f = fixture(), track = f.registered(true), close = f.bgm.suspendBgm()
  track.play = () => { track.playCalls++; return Promise.reject(new Error('autoplay blocked')) }
  close(); await Promise.resolve()
  assert.equal(f.bgm.isBgmSuspended(), false); assert.equal(track.playCalls, 2)
})

test('actual BGM hook cannot replay on foreground or stalled media while suspended', async () => {
  const f = fixture(), hook = mountHook(f)
  hook.render().playTrack('theme'); await Promise.resolve(); hook.render()
  const track = hook.audios[0], close = f.bgm.suspendBgm(), before = track.playCalls
  f.document.dispatchEvent(new Event('visibilitychange')); f.window.dispatchEvent(new Event('pageshow'))
  for (const event of ['waiting', 'stalled', 'suspend', 'ended']) track.dispatchEvent(new Event(event))
  assert.equal(track.playCalls, before); assert.equal(hook.render().isPlaying, false)
  assert.equal(hook.store.get('ginjiro_bgm_on'), 'true')
  close(); await Promise.resolve(); assert.equal(hook.render().isPlaying, true)
})

test('actual hook stop while Johnny is open keeps the user preference OFF after closing', async () => {
  const f = fixture(), hook = mountHook(f)
  hook.render().playTrack('theme'); await Promise.resolve(); hook.render()
  const track = hook.audios[0], close = f.bgm.suspendBgm()
  hook.render().stop(); close(); await Promise.resolve()
  assert.equal(track.paused, true); assert.equal(hook.store.get('ginjiro_bgm_on'), 'false'); assert.equal(hook.render().isOn, false)
})

test('opening Johnny before hook listeners mount and switching tracks cannot bypass silence', async () => {
  const f = fixture(), close = f.bgm.suspendBgm(), hook = mountHook(f)
  hook.render().playTrack('theme'); await Promise.resolve()
  assert.equal(hook.audios[0].playCalls, 0)
  hook.render().playTrack('hiroshima'); await Promise.resolve()
  assert.equal(hook.audios[1].playCalls, 0)
  close(); assert.equal(hook.render().isPlaying, false)
})
