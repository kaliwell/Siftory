const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const { runDuplicateTask, runLargestTask } = loadTsModule('electron/duplicateFinderWorker.ts')

function runningStopView() {
  return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
}

test('Duplicate Finder worker detects identical files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-duplicates-'))
  try {
    fs.writeFileSync(path.join(root, 'copy-a.bin'), 'identical-content')
    fs.writeFileSync(path.join(root, 'copy-b.bin'), 'identical-content')
    fs.writeFileSync(path.join(root, 'unique.bin'), 'unique-content')

    const result = runDuplicateTask(root, 0, runningStopView(), () => {})
    assert.equal(result.stopped, false)
    assert.equal(result.progress.state, 'done')
    assert.equal(result.groups.length, 1)
    assert.deepEqual(result.groups[0].files.map((file) => file.name).sort(), [
      'copy-a.bin',
      'copy-b.bin',
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Duplicate Finder worker largest-file scan is sorted and bounded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-largest-'))
  try {
    fs.writeFileSync(path.join(root, 'small.bin'), Buffer.alloc(10))
    fs.writeFileSync(path.join(root, 'large.bin'), Buffer.alloc(100))
    fs.writeFileSync(path.join(root, 'medium.bin'), Buffer.alloc(50))

    const result = runLargestTask(root, 2, runningStopView(), () => {})
    assert.equal(result.stopped, false)
    assert.deepEqual(
      result.files.map((file) => file.name),
      ['large.bin', 'medium.bin'],
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Duplicate Finder worker observes an atomic stop request', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-stop-'))
  try {
    fs.writeFileSync(path.join(root, 'file.bin'), Buffer.alloc(1024))
    const stopView = runningStopView()
    Atomics.store(stopView, 0, 1)
    const result = runDuplicateTask(root, 0, stopView, () => {})
    assert.equal(result.stopped, true)
    assert.deepEqual(result.groups, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Duplicate Finder worker does not recurse through junctions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-junction-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-outside-'))
  try {
    fs.writeFileSync(path.join(outside, 'external-a.bin'), 'shared-content')
    fs.writeFileSync(path.join(root, 'local-a.bin'), 'shared-content')
    try {
      fs.symlinkSync(outside, path.join(root, 'junction-link'), 'junction')
    } catch (error) {
      t.skip(`junction creation unavailable: ${error.message}`)
      return
    }

    const result = runDuplicateTask(root, 0, runningStopView(), () => {})
    const scanned = result.groups.flatMap((group) => group.files.map((file) => file.path))
    assert.ok(
      !scanned.some((scannedPath) => scannedPath.includes('external-a.bin')),
      `junction target must not be scanned: ${JSON.stringify(scanned)}`,
    )
    assert.ok(
      !scanned.some((scannedPath) => scannedPath.includes('junction-link')),
      `junction itself must not be followed as a directory: ${JSON.stringify(scanned)}`,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})
