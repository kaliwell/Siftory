const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')

const {
  MAX_USER_DATA_ENTRIES,
  compactUserDataSnapshot,
  compareCompactUserDataSnapshots,
  compareUserDataSnapshots,
  snapshotUserDataRoots,
  validateCompactUserDataSnapshot,
  validateUserDataSnapshot,
} = require('../scripts/fixed-hardware-user-data-proof.cjs')

function createFixture(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-user-data-proof-'))
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
  const appRoot = path.join(tempRoot, 'app-data')
  const nested = path.join(appRoot, 'nested')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(appRoot, 'settings.json'), '{"theme":"dark"}\n', 'utf8')
  fs.writeFileSync(path.join(nested, 'index.bin'), Buffer.from([1, 2, 3, 4]))
  return {
    tempRoot,
    appRoot,
    missingRoot: path.join(tempRoot, 'not-created'),
  }
}

test('snapshot is deterministic, sorted, metadata-only, and records missing roots', (t) => {
  const fixture = createFixture(t)
  const first = snapshotUserDataRoots([fixture.missingRoot, fixture.appRoot])
  const second = snapshotUserDataRoots([fixture.appRoot, fixture.missingRoot])

  assert.deepEqual(second, first)
  assert.equal(validateUserDataSnapshot(first), true)
  assert.match(first.identity, /^[a-f0-9]{64}$/)
  assert.equal(first.rootCount, 2)
  assert.equal(first.existingRootCount, 1)
  assert.equal(first.missingRootCount, 1)
  assert.ok(first.entryCount > 0)

  const existing = first.roots.find((root) => root.exists)
  const missing = first.roots.find((root) => !root.exists)
  assert.equal(missing.path, path.resolve(fixture.missingRoot))
  assert.equal(missing.entryCount, 0)
  assert.deepEqual(missing.entries, [])
  assert.equal(existing.entries[0].path, '.')
  assert.equal(existing.entries[0].type, 'directory')
  assert.deepEqual(
    existing.entries.map((entry) => entry.path),
    [...existing.entries.map((entry) => entry.path)].sort(),
  )

  const file = existing.entries.find((entry) => entry.path === 'nested/index.bin')
  assert.equal(file.type, 'file')
  assert.equal(file.size, '4')
  assert.match(file.mtimeNs, /^\d+$/)
  assert.match(file.ctimeNs, /^\d+$/)
  assert.match(file.birthtimeNs, /^\d+$/)
  assert.ok(['ns', 'ms-derived-ns'].includes(file.timestampPrecision))
  assert.equal(Object.hasOwn(file, 'content'), false)
  assert.equal(Object.hasOwn(file, 'sha256'), false)
})

test('exact comparison returns changed/fail only when root metadata differs', (t) => {
  const fixture = createFixture(t)
  const before = snapshotUserDataRoots([fixture.appRoot, fixture.missingRoot])
  const unchanged = snapshotUserDataRoots([fixture.missingRoot, fixture.appRoot])
  assert.deepEqual(compareUserDataSnapshots(before, unchanged), {
    ok: true,
    changed: false,
    fail: false,
    failure: null,
    beforeIdentity: before.identity,
    afterIdentity: unchanged.identity,
    changedRootCount: 0,
    changedRoots: [],
  })

  fs.writeFileSync(path.join(fixture.appRoot, 'new-runtime-write.db'), 'changed', 'utf8')
  fs.mkdirSync(fixture.missingRoot)
  const after = snapshotUserDataRoots([fixture.appRoot, fixture.missingRoot])
  const comparison = compareUserDataSnapshots(before, after)
  assert.equal(comparison.ok, false)
  assert.equal(comparison.changed, true)
  assert.equal(comparison.fail, true)
  assert.equal(comparison.failure.code, 'user-data-changed')
  assert.equal(comparison.changedRootCount, 2)
  assert.notEqual(comparison.beforeIdentity, comparison.afterIdentity)
})

test('comparison rejects forged or malformed snapshot metadata', (t) => {
  const fixture = createFixture(t)
  const snapshot = snapshotUserDataRoots([fixture.appRoot])
  const forged = JSON.parse(JSON.stringify(snapshot))
  forged.roots[0].entries[0].size = '999'

  const comparison = compareUserDataSnapshots(snapshot, forged)
  assert.equal(comparison.ok, false)
  assert.equal(comparison.changed, null)
  assert.equal(comparison.fail, true)
  assert.equal(comparison.failure.code, 'invalid-snapshot')
})

test('snapshot refuses symlinks or junctions without following them', (t) => {
  const fixture = createFixture(t)
  const outside = path.join(fixture.tempRoot, 'outside')
  const linked = path.join(fixture.appRoot, 'linked-outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'must-not-be-read.txt'), 'outside', 'utf8')
  try {
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`Symlink/junction creation is unavailable: ${error.message}`)
    return
  }

  assert.throws(
    () => snapshotUserDataRoots([fixture.appRoot]),
    (error) => error?.code === 'reparse-point',
  )
})

test('one hard aggregate entry limit applies across every explicit root', (t) => {
  const fixture = createFixture(t)
  const secondRoot = path.join(fixture.tempRoot, 'second-app-data')
  fs.mkdirSync(secondRoot)
  fs.writeFileSync(path.join(secondRoot, 'state.json'), '{}', 'utf8')

  assert.throws(
    () => snapshotUserDataRoots([fixture.appRoot, secondRoot], { maxEntries: 3 }),
    (error) => error?.code === 'entry-limit',
  )
  assert.throws(
    () => snapshotUserDataRoots([fixture.appRoot], { maxEntries: MAX_USER_DATA_ENTRIES + 1 }),
    (error) => error?.code === 'invalid-entry-limit',
  )
})

test('large directory streaming preserves order and fails at the exact aggregate boundary', (t) => {
  const fixture = createFixture(t)
  const largeRoot = path.join(fixture.tempRoot, 'large-app-data')
  fs.mkdirSync(largeRoot)
  const fileCount = 512
  for (let index = fileCount - 1; index >= 0; index -= 1) {
    fs.writeFileSync(path.join(largeRoot, `entry-${String(index).padStart(4, '0')}.json`), '{}')
  }

  const originalReaddirSync = fs.readdirSync
  let snapshot
  try {
    fs.readdirSync = () => {
      throw new Error('snapshot traversal must use opendirSync')
    }
    snapshot = snapshotUserDataRoots([largeRoot], { maxEntries: fileCount + 1 })
  } finally {
    fs.readdirSync = originalReaddirSync
  }

  assert.equal(snapshot.entryCount, fileCount + 1)
  assert.equal(validateUserDataSnapshot(snapshot), true)
  assert.deepEqual(
    snapshot.roots[0].entries.map((entry) => entry.path),
    [...snapshot.roots[0].entries.map((entry) => entry.path)].sort(),
  )
  assert.deepEqual(snapshotUserDataRoots([largeRoot], { maxEntries: fileCount + 1 }), snapshot)
  assert.throws(
    () => snapshotUserDataRoots([largeRoot], { maxEntries: fileCount }),
    (error) => error?.code === 'entry-limit',
  )
})

test('isolated worker returns only a bounded compact digest proof', (t) => {
  const fixture = createFixture(t)
  const worker = path.join(__dirname, '..', 'scripts', 'fixed-hardware-user-data-proof-worker.cjs')
  const result = spawnSync(
    process.execPath,
    [worker, JSON.stringify([fixture.appRoot, fixture.missingRoot])],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024 },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.ok(Buffer.byteLength(result.stdout) < 8 * 1024)
  const compact = JSON.parse(result.stdout)
  assert.equal(validateCompactUserDataSnapshot(compact), true)
  assert.equal(compact.entryCount > 0, true)
  assert.equal(
    compact.roots.some((root) => Object.hasOwn(root, 'entries')),
    false,
  )
  assert.deepEqual(
    compact,
    compactUserDataSnapshot(snapshotUserDataRoots([fixture.appRoot, fixture.missingRoot])),
  )
  assert.equal(compareCompactUserDataSnapshots(compact, compact).ok, true)

  const forged = structuredClone(compact)
  forged.roots[0].entryCount += 1
  const rejected = compareCompactUserDataSnapshots(compact, forged)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.fail, true)
  assert.equal(rejected.failure.code, 'invalid-compact-snapshot')
})
