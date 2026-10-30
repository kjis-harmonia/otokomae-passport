import test from 'node:test'
import assert from 'node:assert/strict'
import { observeVisibleViewport } from '../src/utils/visibleViewport.ts'

function fixture() {
  const values = new Map()
  const target = { style: {
    getPropertyValue: name => values.get(name)?.value ?? '',
    getPropertyPriority: name => values.get(name)?.priority ?? '',
    setProperty: (name, value, priority = '') => values.set(name, { value, priority }),
    removeProperty: name => values.delete(name),
  } }
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 })
  const frames = new Map()
  let id = 0
  const view = Object.assign(new EventTarget(), {
    visualViewport: viewport,
    requestAnimationFrame: fn => { frames.set(++id, fn); return id },
    cancelAnimationFrame: handle => frames.delete(handle),
  })
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()) }
  return { target, viewport, view, frames, flush, value: name => target.style.getPropertyValue(name) }
}

test('keyboard resize and Safari panning keep the fixed dialog inside the visible area', () => {
  const f = fixture()
  const stop = observeVisibleViewport(f.target, f.view)
  assert.equal(f.value('--customer-visual-height'), '800px')
  f.viewport.height = 320
  f.viewport.offsetTop = 180
  f.viewport.dispatchEvent(new Event('resize'))
  f.viewport.dispatchEvent(new Event('scroll'))
  assert.equal(f.frames.size, 1)
  f.flush()
  assert.equal(f.value('--customer-visual-height'), '320px')
  assert.equal(f.value('--customer-visual-top'), '180px')
  f.viewport.height = 800
  f.viewport.offsetTop = 0
  f.view.dispatchEvent(new Event('resize'))
  f.flush()
  assert.equal(f.value('--customer-visual-height'), '800px')
  assert.equal(f.value('--customer-visual-top'), '0px')
  stop()
})

test('pinch zoom uses the normal layout rather than pinning the dialog to a magnified slice', () => {
  const f = fixture()
  f.target.style.setProperty('--customer-visual-top', '12px', 'important')
  const stop = observeVisibleViewport(f.target, f.view)
  f.viewport.scale = 2
  f.viewport.dispatchEvent(new Event('resize'))
  f.flush()
  assert.equal(f.value('--customer-visual-height'), '')
  assert.equal(f.value('--customer-visual-top'), '12px')
  assert.equal(f.target.style.getPropertyPriority('--customer-visual-top'), 'important')
  stop()
})

test('invalid viewport metrics cannot collapse or move the dialog outside the screen', () => {
  const f = fixture()
  const stop = observeVisibleViewport(f.target, f.view)
  f.viewport.height = 0
  f.viewport.dispatchEvent(new Event('resize'))
  f.flush()
  assert.equal(f.value('--customer-visual-height'), '')
  f.viewport.height = 500
  f.viewport.offsetTop = -40
  f.viewport.dispatchEvent(new Event('scroll'))
  f.flush()
  assert.equal(f.value('--customer-visual-top'), '0px')
  stop()
})

test('closing restores inline styles and removes pending frames and all resize listeners', () => {
  const f = fixture()
  const stop = observeVisibleViewport(f.target, f.view)
  f.viewport.dispatchEvent(new Event('resize'))
  stop()
  assert.equal(f.frames.size, 0)
  assert.equal(f.value('--customer-visual-height'), '')
  f.viewport.dispatchEvent(new Event('resize'))
  f.viewport.dispatchEvent(new Event('scroll'))
  f.view.dispatchEvent(new Event('resize'))
  assert.equal(f.frames.size, 0)
})

test('browsers without VisualViewport retain the existing full-screen CSS fallback', () => {
  const f = fixture()
  f.view.visualViewport = null
  f.target.style.setProperty('--customer-visual-height', '90vh')
  const stop = observeVisibleViewport(f.target, f.view)
  assert.equal(f.value('--customer-visual-height'), '90vh')
  stop()
  assert.equal(f.value('--customer-visual-height'), '90vh')
})

test('when nothing is being typed, the dialog goes back to full height even if Safari keeps the shrunken viewport', () => {
  const f = fixture()
  const doc = Object.assign(new EventTarget(), { activeElement: { tagName: 'INPUT', isContentEditable: false } })
  f.view.document = doc
  f.view.setTimeout = fn => fn()
  const stop = observeVisibleViewport(f.target, f.view)
  f.viewport.height = 320
  f.viewport.dispatchEvent(new Event('resize'))
  f.flush()
  assert.equal(f.value('--customer-visual-height'), '320px')
  doc.activeElement = { tagName: 'BODY', isContentEditable: false }
  f.view.dispatchEvent(new Event('focusout'))
  f.flush()
  assert.equal(f.value('--customer-visual-height'), '')
  stop()
})
