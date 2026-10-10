const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const migration = loadTsModule('electron/vectorStoreMigrationService.ts')
const store = loadTsModule('electron/authoritativeVectorStore.ts')
const cacheApi = loadTsModule('electron/embeddingF16Cache.ts')
const cleanupApi = loadTsModule('electron/storageCleanupService.ts')
const prewarmApi = loadTsModule('electron/annPrewarmService.ts')
const restorePrewarmPolicy = prewarmApi.configureAnnPrewarmRuntimePolicy({
  preferredModelName: 'dinov2_vitb14',
  canStart: () => false,
})
test.after(restorePrewarmPolicy)

function row(imageId, vector, modelName = 'dinov2_vitb14') {
  return JSON.stringify({ modelName, embeddingType: 'global', imageId, dim: vector.length, vector })
}

async function waitForMigration() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const progress = migration.getVectorStoreMigrationProgress()
    if (progress.state !== 'running') return progress
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('migration test timed out')
}

function sourceOptions(root, source, overrides = {}) {
  return {
    cacheDir: path.join(root, 'vector-db', 'embedding-cache'),
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    dim: 3,
    sourcePaths: [source],
    ...overrides,
  }
}

test('migration streams F16 generation, records offsets and switches CURRENT', async (t) => {
  migration.resetVectorStoreMigrationForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-vector-store-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const embeddings = path.join(root, 'vector-db', 'embeddings')
  fs.mkdirSync(embeddings, { recursive: true })
  const source = path.join(embeddings, 'dinov2_vitb14__global.jsonl')
  const paddedFirstRow = JSON.stringify({
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    imageId: 'C:\\images\\a.jpg',
    dim: 3,
    vector: [1, 0, 0],
    padding: 'x'.repeat(128 * 1024),
  })
  fs.writeFileSync(
    source,
    [paddedFirstRow, row('C:\\images\\b.jpg', [0, 2, 0]), row('C:\\images\\a.jpg', [0, 0, 3])].join(
      '\n',
    ),
  )

  const options = sourceOptions(root, source)
  const preview = migration.createVectorStoreMigrationPreview(root, [options])
  assert.equal(preview.models.length, 1)
  assert.equal(preview.models[0].alreadyCurrent, false)
  assert.equal(migration.startVectorStoreMigration(root, preview.token).ok, true)
  const completed = await waitForMigration()
  assert.equal(completed.state, 'completed', completed.errors.join('\n'))
  assert.ok(completed.generation)

  const storeRoot = path.join(root, 'vector-db', 'vector-store')
  const manifest = store.readCurrentAuthoritativeManifest(storeRoot, true)
  assert.equal(manifest.generation, completed.generation)
  assert.equal(manifest.entries[0].dtype, 'f16-le')
  assert.equal(manifest.entries[0].count, 2)
  assert.equal(manifest.entries[0].imports[0].path, source)
  assert.match(manifest.entries[0].imports[0].tailSha256, /^[a-f0-9]{64}$/)
  assert.equal(manifest.entries[0].imports[0].chunkIntegrity.version, 1)
  assert.equal(manifest.entries[0].imports[0].chunkIntegrity.chunks.length, 4)
  const handle = store.openAuthoritativeVectorStore(storeRoot, 'dinov2_vitb14', 'global', 3, true)
  assert.ok(handle)
  const metadataRows = fs
    .readFileSync(handle.pathIndexPath, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
  assert.deepEqual(
    metadataRows.map(({ row, offset }) => [row, offset]),
    [
      [0, 0],
      [1, 6],
    ],
  )

  const imported = manifest.entries[0].imports[0]
  const originalSource = fs.readFileSync(source)
  const generationDir = path.dirname(handle.vectorPath)
  const manifestPath = path.join(generationDir, 'manifest.json')
  const currentPath = path.join(storeRoot, 'CURRENT')
  const rewriteCurrentManifest = (nextManifest) => {
    fs.writeFileSync(manifestPath, JSON.stringify(nextManifest, null, 2))
    const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'))
    current.manifestSha256 = store.sha256FileSync(manifestPath)
    fs.writeFileSync(currentPath, JSON.stringify(current, null, 2))
  }
  fs.utimesSync(source, imported.mtimeMs / 1000, imported.mtimeMs / 1000)
  imported.mtimeMs = fs.statSync(source).mtimeMs
  rewriteCurrentManifest(manifest)

  const changedSource = Buffer.from(originalSource)
  changedSource[changedSource.length - 1] ^= 1
  fs.writeFileSync(source, changedSource)
  fs.utimesSync(source, imported.mtimeMs / 1000, imported.mtimeMs / 1000)
  assert.equal(fs.statSync(source).size, imported.size)
  assert.equal(fs.statSync(source).mtimeMs, imported.mtimeMs)
  assert.equal(
    store.openAuthoritativeVectorStore(storeRoot, 'dinov2_vitb14', 'global', 3, false, [source]),
    null,
    'same-size same-mtime tail rewrites must invalidate the generation',
  )
  fs.writeFileSync(source, originalSource)
  fs.utimesSync(source, imported.mtimeMs / 1000, imported.mtimeMs / 1000)
  assert.ok(
    store.openAuthoritativeVectorStore(storeRoot, 'dinov2_vitb14', 'global', 3, false, [source]),
  )

  const headChangedSource = Buffer.from(originalSource)
  const paddingOffset = headChangedSource.indexOf(Buffer.from('xxxx'))
  assert.ok(paddingOffset >= 0 && paddingOffset < 64 * 1024)
  headChangedSource[paddingOffset] = 'y'.charCodeAt(0)
  fs.writeFileSync(source, headChangedSource)
  fs.utimesSync(source, imported.mtimeMs / 1000, imported.mtimeMs / 1000)
  assert.equal(fs.statSync(source).size, imported.size)
  assert.equal(
    store.sha256FileTailSync(source, imported.size),
    imported.tailSha256,
    'the legacy 64 KiB tail anchor cannot see an early same-size rewrite',
  )
  assert.equal(
    store.openAuthoritativeVectorStore(storeRoot, 'dinov2_vitb14', 'global', 3, false, [source]),
    null,
    'chunk integrity must reject an early same-size same-mtime rewrite',
  )
  fs.writeFileSync(source, originalSource)
  fs.utimesSync(source, imported.mtimeMs / 1000, imported.mtimeMs / 1000)

  const legacyManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  delete legacyManifest.entries[0].imports[0].tailSha256
  delete legacyManifest.entries[0].imports[0].chunkIntegrity
  rewriteCurrentManifest(legacyManifest)
  assert.ok(
    store.openAuthoritativeVectorStore(storeRoot, 'dinov2_vitb14', 'global', 3, false, [source]),
    'legacy manifests without tailSha256 must remain readable',
  )

  fs.appendFileSync(source, `\n${row('C:\\images\\c.jpg', [1, 1, 0])}`)
  const future = new Date(Date.now() + 2000)
  fs.utimesSync(source, future, future)
  const refreshed = await cacheApi.ensureEmbeddingF16Cache(options)
  assert.equal(refreshed.meta.generation, undefined)
  assert.equal(refreshed.meta.count, 3)

  fs.unlinkSync(source)
  const resolved = await cacheApi.ensureEmbeddingF16Cache(options)
  assert.equal(resolved.meta.generation, completed.generation)
  assert.equal(resolved.vectorPath, handle.vectorPath)
})

test('failed migration preserves CURRENT and old generations become cleanup candidates', async (t) => {
  migration.resetVectorStoreMigrationForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-vector-switch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const embeddings = path.join(root, 'vector-db', 'embeddings')
  fs.mkdirSync(embeddings, { recursive: true })
  const source = path.join(embeddings, 'dinov2_vitb14__global.jsonl')
  fs.writeFileSync(source, row('C:\\images\\first.jpg', [1, 0, 0]))
  const options = sourceOptions(root, source)

  let preview = migration.createVectorStoreMigrationPreview(root, [options])
  migration.startVectorStoreMigration(root, preview.token)
  const first = await waitForMigration()
  assert.equal(first.state, 'completed')
  const currentPath = path.join(root, 'vector-db', 'vector-store', 'CURRENT')
  const firstCurrent = fs.readFileSync(currentPath, 'utf8')

  fs.appendFileSync(source, `\n${row('C:\\images\\second.jpg', [0, 1, 0])}`)
  const future = new Date(Date.now() + 2000)
  fs.utimesSync(source, future, future)
  preview = migration.createVectorStoreMigrationPreview(root, [
    sourceOptions(root, source, { isCancelled: () => true }),
  ])
  migration.startVectorStoreMigration(root, preview.token)
  const cancelled = await waitForMigration()
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(fs.readFileSync(currentPath, 'utf8'), firstCurrent)

  preview = migration.createVectorStoreMigrationPreview(root, [options])
  migration.startVectorStoreMigration(root, preview.token)
  const second = await waitForMigration()
  assert.equal(second.state, 'completed', second.errors.join('\n'))
  assert.notEqual(fs.readFileSync(currentPath, 'utf8'), firstCurrent)
  const cleanup = await cleanupApi.previewStorageCleanup(root)
  assert.ok(cleanup.items.some((item) => item.id === 'vector-store-old-generations'))
  assert.ok(cleanup.items.some((item) => item.id === 'vector-caches'))
})

test('reader rejects truncated generation without touching CURRENT', async (t) => {
  migration.resetVectorStoreMigrationForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-vector-corrupt-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source.jsonl')
  fs.writeFileSync(source, row('C:\\images\\a.jpg', [1, 0, 0]))
  const preview = migration.createVectorStoreMigrationPreview(root, [sourceOptions(root, source)])
  migration.startVectorStoreMigration(root, preview.token)
  const completed = await waitForMigration()
  assert.equal(completed.state, 'completed')
  const storeRoot = path.join(root, 'vector-db', 'vector-store')
  const handle = store.openAuthoritativeVectorStore(storeRoot, 'dinov2_vitb14', 'global', 3)
  fs.truncateSync(handle.vectorPath, 2)
  assert.equal(store.openAuthoritativeVectorStore(storeRoot, 'dinov2_vitb14', 'global', 3), null)
  assert.ok(fs.existsSync(path.join(storeRoot, 'CURRENT')))
})

test('legacy authoritative schema cannot expose zero or non-finite F16 rows', async (t) => {
  migration.resetVectorStoreMigrationForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-vector-v1-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source.jsonl')
  fs.writeFileSync(
    source,
    [row('C:\\images\\zero.jpg', [1, 0, 0]), row('C:\\images\\nan.jpg', [0, 1, 0])].join('\n'),
  )
  const preview = migration.createVectorStoreMigrationPreview(root, [sourceOptions(root, source)])
  migration.startVectorStoreMigration(root, preview.token)
  const completed = await waitForMigration()
  assert.equal(completed.state, 'completed')

  const storeRoot = path.join(root, 'vector-db', 'vector-store')
  const handle = store.openAuthoritativeVectorStore(storeRoot, 'dinov2_vitb14', 'global', 3)
  const encoded = fs.readFileSync(handle.vectorPath)
  encoded.fill(0, 0, 6)
  encoded.writeUInt16LE(0x7e00, 6)
  fs.writeFileSync(handle.vectorPath, encoded)

  const generationDir = path.dirname(handle.vectorPath)
  const manifestPath = path.join(generationDir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.version = 1
  manifest.entries[0].vectors.sha256 = store.sha256FileSync(handle.vectorPath)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  const currentPath = path.join(storeRoot, 'CURRENT')
  const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'))
  current.version = 1
  current.manifestSha256 = store.sha256FileSync(manifestPath)
  fs.writeFileSync(currentPath, JSON.stringify(current))

  assert.equal(store.readCurrentAuthoritativeManifest(storeRoot, true), null)
  assert.equal(store.openAuthoritativeVectorStore(storeRoot, 'dinov2_vitb14', 'global', 3), null)
})
