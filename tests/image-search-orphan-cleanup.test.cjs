const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { previewIndexOrphanCleanup, executeIndexOrphanCleanup } = loadTsModule(
  'electron/imageSearchIndexOrphans.ts',
)

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-orphan-cleanup-'))
  const indexDir = path.join(root, 'image-search-index')
  fs.mkdirSync(path.join(indexDir, 'segments'), { recursive: true })
  fs.mkdirSync(path.join(indexDir, 'staging'), { recursive: true })
  return { root, indexDir }
}

function writeFile(filePath, bytes, mtime) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 1))
  if (mtime) fs.utimesSync(filePath, mtime, mtime)
}

function writeManifest(indexDir, files) {
  fs.writeFileSync(
    path.join(indexDir, 'manifest.json'),
    JSON.stringify({ schemaVersion: 2, segments: files.map((file) => ({ id: file, file })) }),
  )
}

test('preview lists only old unreferenced segment/staging files', async () => {
  const { indexDir } = fixture()
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
  writeFile(path.join(indexDir, 'segments', 'current.idx'), 100)
  writeFile(path.join(indexDir, 'segments', 'orphan.idx'), 50, old)
  writeFile(path.join(indexDir, 'staging', 'recent.tmp'), 30) // inside protection window
  writeFile(path.join(indexDir, 'staging', 'old.tmp'), 20, old)
  writeManifest(indexDir, ['segments/current.idx'])

  const preview = await previewIndexOrphanCleanup(indexDir)
  assert.equal(preview.referencedCount, 1)
  assert.deepEqual(
    preview.orphans.map((orphan) => path.basename(orphan.path)),
    ['orphan.idx', 'old.tmp'],
  )
  assert.equal(preview.totalBytes, 70)
})

test('preview fails closed when the manifest is missing, unreadable or escaping', async () => {
  const { indexDir } = fixture()
  assert.equal(await previewIndexOrphanCleanup(indexDir), null)

  fs.writeFileSync(path.join(indexDir, 'manifest.json'), 'not json {')
  assert.equal(await previewIndexOrphanCleanup(indexDir), null)

  writeManifest(indexDir, ['../escape.idx'])
  assert.equal(await previewIndexOrphanCleanup(indexDir), null)
})

test('execute deletes previewed orphans and writes an audit report', async () => {
  const { root, indexDir } = fixture()
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
  writeFile(path.join(indexDir, 'segments', 'current.idx'), 100)
  writeFile(path.join(indexDir, 'segments', 'orphan.idx'), 50, old)
  writeFile(path.join(indexDir, 'staging', 'old.tmp'), 20, old)
  writeManifest(indexDir, ['segments/current.idx'])

  const preview = await previewIndexOrphanCleanup(indexDir)
  const result = await executeIndexOrphanCleanup(preview)
  assert.equal(result.ok, true, result.errors.join('; '))
  assert.equal(result.deletedFiles, 2)
  assert.equal(result.deletedBytes, 70)
  assert.equal(result.skipped, 0)
  assert.equal(fs.existsSync(path.join(indexDir, 'segments', 'current.idx')), true)
  assert.equal(fs.existsSync(path.join(indexDir, 'segments', 'orphan.idx')), false)
  assert.equal(fs.existsSync(path.join(indexDir, 'staging', 'old.tmp')), false)

  const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf8'))
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.deletedBytes, 70)
  assert.equal(report.targets.length, 2)
  assert.equal(path.dirname(result.reportPath), path.join(root, 'image-search-orphan-reports'))
})

test('execute aborts when the manifest changes after the preview', async () => {
  const { indexDir } = fixture()
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
  writeFile(path.join(indexDir, 'segments', 'orphan.idx'), 50, old)
  writeManifest(indexDir, ['segments/current.idx'])
  const preview = await previewIndexOrphanCleanup(indexDir)

  // A manifest save between preview and execute must abort before any delete.
  writeManifest(indexDir, ['segments/current.idx', 'segments/orphan.idx'])
  const result = await executeIndexOrphanCleanup(preview)
  assert.equal(result.ok, false)
  assert.match(result.error, /manifest changed/)
  assert.equal(result.deletedFiles, 0)
  assert.equal(fs.existsSync(path.join(indexDir, 'segments', 'orphan.idx')), true)
})

test('execute skips targets that changed or became referenced since the preview', async () => {
  const { indexDir } = fixture()
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
  writeFile(path.join(indexDir, 'segments', 'orphan.idx'), 50, old)
  writeFile(path.join(indexDir, 'staging', 'old.tmp'), 20, old)
  writeManifest(indexDir, ['segments/current.idx'])
  const preview = await previewIndexOrphanCleanup(indexDir)

  // Same manifest fingerprint, but one target rewritten recently (now inside
  // the protection window) → re-verification must skip it.
  writeFile(path.join(indexDir, 'staging', 'old.tmp'), 20)
  const result = await executeIndexOrphanCleanup(preview)
  assert.equal(result.ok, true)
  assert.equal(result.deletedFiles, 1)
  assert.equal(result.skipped, 1)
  assert.equal(fs.existsSync(path.join(indexDir, 'staging', 'old.tmp')), true)
  assert.equal(fs.existsSync(path.join(indexDir, 'segments', 'orphan.idx')), false)
})
