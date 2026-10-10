const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')
const { WindowVisibilityDiagnostics } = loadTsModule('electron/windowVisibilityDiagnostics.ts')

const state = { state: 'visible', generation: 4, reason: 'hotkey', changedAt: 0 }
const snapshotPath = (dir) => path.join(dir, 'diagnostics', 'window-visibility.json')
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siftory-window-diagnostics-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const diagnostics = new WindowVisibilityDiagnostics(dir)
  t.after(() => diagnostics.close())
  return { dir, diagnostics }
}

test('ring capacity and field allowlist bound persistent diagnostics without personal text', async (t) => {
  const { dir, diagnostics } = await fixture(t)
  const secret = 'C:\\Users\\private-person\\secret.mp4 token=private-token'
  diagnostics.record('hotkey-conflicted', state, { hotkey: 'toggle-primary' })
  for (let i = 0; i < 500; i++) {
    diagnostics.record(
      'transition',
      { ...state, reason: secret, state: secret },
      {
        message: secret,
        path: secret,
        hotkey: secret,
        shapeCount: Number.MAX_SAFE_INTEGER,
      },
    )
  }
  diagnostics.record(secret, state, {})
  const snapshot = diagnostics.snapshot()
  assert.equal(snapshot.events.length, 128)
  assert.equal(snapshot.totalEvents, 501)
  assert.equal(snapshot.droppedEvents, 373)
  assert.equal(snapshot.events[0].sequence, 374)
  assert.equal(snapshot.events.at(-1).shapeCount, 64)
  assert.deepEqual(snapshot.hotkeys, [{ id: 'toggle-primary', status: 'conflicted' }])
  snapshot.events[0].code = secret
  assert.equal(diagnostics.snapshot().events[0].code, 'transition')
  await diagnostics.close()
  const payload = await fs.readFile(snapshotPath(dir), 'utf8')
  assert.doesNotMatch(payload, /private-person|private-token|secret\.mp4|message|"path"/)
  assert.ok(Buffer.byteLength(payload) < 32 * 1024)
  assert.deepEqual(await fs.readdir(path.dirname(snapshotPath(dir))), ['window-visibility.json'])
})

test('concurrent flush and shutdown drain the newest complete snapshot', async (t) => {
  const { dir, diagnostics } = await fixture(t)
  diagnostics.record('initialized', state)
  const first = diagnostics.flush()
  diagnostics.record('hotkey-registered', state, { hotkey: 'toggle-primary' })
  await Promise.all([first, diagnostics.flush(), diagnostics.close()])
  const snapshot = JSON.parse(await fs.readFile(snapshotPath(dir), 'utf8'))
  assert.equal(snapshot.totalEvents, 2)
  assert.deepEqual(snapshot.hotkeys, [{ id: 'toggle-primary', status: 'registered' }])
  diagnostics.record('transition', state)
  assert.equal(diagnostics.snapshot().totalEvents, 2)
})

test('an unwritable destination preserves window behavior and recovers on later activity', async (t) => {
  const { dir, diagnostics } = await fixture(t)
  await fs.writeFile(path.join(dir, 'diagnostics'), 'block directory creation')
  diagnostics.record('mouse-failed', state)
  await diagnostics.flush()
  assert.equal(diagnostics.snapshot().writeFailures, 1)
  await fs.unlink(path.join(dir, 'diagnostics'))
  diagnostics.record('mouse-applied', state, { ignoreMouse: true })
  await diagnostics.close()
  const snapshot = JSON.parse(await fs.readFile(snapshotPath(dir), 'utf8'))
  assert.equal(snapshot.writeFailures, 1)
  assert.equal(snapshot.events.at(-1).ignoreMouse, true)
})

test('failed atomic replacement keeps the preceding snapshot intact', async (t) => {
  const { dir, diagnostics } = await fixture(t)
  diagnostics.record('initialized', state)
  await diagnostics.flush()
  await fs.mkdir(`${snapshotPath(dir)}.tmp`)
  diagnostics.record('show-timeout', state)
  await diagnostics.flush()
  assert.equal(JSON.parse(await fs.readFile(snapshotPath(dir), 'utf8')).totalEvents, 1)
  await fs.rmdir(`${snapshotPath(dir)}.tmp`)
  await diagnostics.close()
  assert.equal(JSON.parse(await fs.readFile(snapshotPath(dir), 'utf8')).totalEvents, 2)
})
