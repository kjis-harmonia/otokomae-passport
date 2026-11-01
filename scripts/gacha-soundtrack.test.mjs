import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../src/audio/gachaSoundtrack.ts', import.meta.url), 'utf8')
const module = { exports: {} }
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: module.exports, setTimeout: fn => fn() })
const { GachaSoundtrack, INTRO_CROSSFADE, OPEN_CROSSFADE } = module.exports
function fixture() {
  const nodes = []
  const param = () => ({ value: 1, events: [], setValueAtTime(v, t) { this.events.push(['set', v, t]) }, cancelScheduledValues(t) { this.events.push(['cancel', t]) }, linearRampToValueAtTime(v, t) { this.events.push(['ramp', v, t]) } })
  const ctx = { currentTime: 0, destination: {}, createGain() { return { gain: param(), connect() {}, disconnect() {} } }, createBufferSource() { const n = { loop: false, connect(g) { this.gain = g }, disconnect() {}, start(...a) { this.starts = a }, stop(t) { this.stopped = t } }; nodes.push(n); return n }, resume: async () => {} }
  return { ctx, nodes, audio: new GachaSoundtrack(ctx, { intro: { duration: 28 }, wait: { duration: 4 }, open: { duration: 16 } }) }
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
    const bytes = fs.readFileSync(new URL(`../public/gacha/gacha-${name}.mp4`, import.meta.url))
    const avc = bytes.indexOf(Buffer.from('avcC'))
    assert(avc >= 0, `${name}: missing AVC configuration`)
    assert.equal(bytes[avc + 4], 1)
    assert.equal(bytes[avc + 5], 100, `${name}: expected H.264 High (8-bit 4:2:0)`)
  }
})
