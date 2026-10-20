import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

async function pngSize(path) {
  const data = await readFile(new URL(`public${path}`, root))
  assert.deepEqual(data.subarray(0, 8), pngSignature, `${path} must be a PNG`)
  return `${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`
}

for (const [label, app, name] of [['HQ', 'headquarters', '銀二郎本部'], ['SB', 'sb', '銀二郎SB'], ['Terminal', 'staff', '銀二郎 店舗端末']]) {
  test(`${label} manifest uses dedicated icons at their declared sizes`, async () => {
    const manifest = JSON.parse(await readFile(new URL(`public/manifest-${app}.webmanifest`, root), 'utf8'))
    assert.equal(manifest.start_url, `/${app}`)
    assert.equal(manifest.name, name)
    assert.equal(manifest.icons.length, 3)
    for (const icon of manifest.icons) {
      assert.ok(icon.src.startsWith(`/icons/${app}-`))
      assert.equal(icon.type, 'image/png')
      assert.equal(await pngSize(icon.src), icon.sizes)
    }
    assert.deepEqual(manifest.icons.map(icon => icon.purpose), ['any', 'any', 'maskable'])
  })

  test(`${label} favicon and Apple touch icon exist at their declared sizes`, async () => {
    const html = await readFile(new URL(`${app}.html`, root), 'utf8')
    for (const [path, size] of [
      [`/icons/${app}-32.png`, '32x32'],
      [`/icons/${app}-192.png`, '192x192'],
      [`/icons/${app}-apple-touch-icon.png`, '180x180'],
    ]) {
      assert.ok(html.includes(`href="${path}"`))
      assert.equal(await pngSize(path), size)
    }
  })

}

for (const [label, app] of [['HQ', 'headquarters'], ['SB', 'sb'], ['Terminal', 'staff']]) {
  test(`${label} icon pack contains all required platform sizes`, async () => {
    for (const [suffix, size] of [
      ['32', '32x32'],
      ['192', '192x192'],
      ['512', '512x512'],
      ['apple-touch-icon', '180x180'],
      ['maskable-512', '512x512'],
    ]) {
      assert.equal(await pngSize(`/icons/${app}-${suffix}.png`), size)
    }
  })

  test(`transparent ${label} master preserves an alpha channel`, async () => {
    const data = await readFile(new URL(`public/assets/${app}-icon.png`, root))
    assert.deepEqual(data.subarray(0, 8), pngSignature)
    assert.equal(data[25], 6, `${label} master must use RGBA`)
  })
}

test('HQ, SB, and store terminal retain distinct artwork at every size', async () => {
  for (const suffix of ['master', '32', '192', '512', 'apple-touch-icon', 'maskable-512']) {
    const hashes = []
    for (const app of ['headquarters', 'sb', 'staff']) {
      const path = suffix === 'master' ? `public/assets/${app}-icon.png` : `public/icons/${app}-${suffix}.png`
      const data = await readFile(new URL(path, root))
      hashes.push(createHash('sha256').update(data).digest('hex'))
    }
    assert.equal(new Set(hashes).size, 3, `${suffix} artwork must remain app-specific`)
  }
})
