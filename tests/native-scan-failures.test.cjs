const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const addon = require(
  process.env.REASONIX_NATIVE_ADDON_PATH || path.resolve('native/build/Release/fast_scanner.node'),
)

async function waitScan() {
  const deadline = Date.now() + 20000
  while (addon.getScanProgress().state === 'scanning') {
    if (Date.now() > deadline) throw Error('scan did not finish')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
test('native failure details expose bounded pages, exact categories, and reset per scan', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-failure-pages-'))
  t.after(async () => {
    await addon.stopScanAsync()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const bad = path.join(root, 'bad')
  const empty = path.join(root, 'empty')
  fs.mkdirSync(bad)
  fs.mkdirSync(empty)
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(bad, `broken-${i}.png`), 'not an image')
  assert.equal(addon.scanDirectory(path.relative(process.cwd(), bad), 'full').ok, true)
  await waitScan()
  const first = addon.getScanFailures(0, 1)
  assert.equal(first.total, 3)
  assert.equal(first.retained, 3)
  assert.equal(first.omitted, 0)
  assert.equal(first.entries.length, 1)
  assert.match(first.entries[0].source, /broken-[0-2]\.png$/)
  assert.ok(first.entries[0].code.length > 0)
  const rest = addon.getScanFailures(first.cursor, 128)
  assert.equal(rest.entries.length, 2)
  assert.equal(
    Object.values(first.counts).reduce((a, b) => a + b, 0),
    3,
  )
  assert.equal(addon.scanDirectory(path.relative(process.cwd(), empty), 'full').ok, true)
  await waitScan()
  const next = addon.getScanFailures(0, 128)
  assert.ok(next.generation > first.generation)
  assert.equal(next.total, 0)
  assert.deepEqual(next.entries, [])
})
