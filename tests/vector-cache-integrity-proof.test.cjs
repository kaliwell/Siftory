// VAL-038: unified integrity proof for persisted F16 vector caches.
// Controlled bitflip fixtures prove that corrupted authoritative, delta and
// derived F16 segments fail closed: readers refuse the handle (with an
// explicit [vector-integrity] signal) and consumers degrade to proven data or
// a rebuild instead of silently serving corrupted vectors.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const migration = loadTsModule('electron/vectorStoreMigrationService.ts')
const store = loadTsModule('electron/authoritativeVectorStore.ts')
const cacheApi = loadTsModule('electron/embeddingF16Cache.ts')
const vectorDb = loadTsModule('electron/vectorDatabaseService.ts')
const increment = loadTsModule('electron/embeddingIncrementLog.ts')
const integrity = loadTsModule('electron/embeddingCacheIntegrity.ts')

const MODEL = 'fixture_dinov2'
const TYPE = 'global'
const DIM = 3

function row(imageId, vector) {
  return `${JSON.stringify({ modelName: MODEL, embeddingType: TYPE, imageId, dim: DIM, vector })}\n`
}

function entry(imageId, vector) {
  return {
    imageId,
    modelName: MODEL,
    modelVersion: '1',
    embeddingType: TYPE,
    dim: DIM,
    vector,
    norm: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function makeRoot(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `floating-clock-vip-${label}-`))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const embeddings = path.join(root, 'vector-db', 'embeddings')
  fs.mkdirSync(embeddings, { recursive: true })
  const source = path.join(embeddings, `${MODEL}__${TYPE}.jsonl`)
  return { root, source }
}

function sourceOptions(root, source) {
  return {
    cacheDir: path.join(root, 'vector-db', 'embedding-cache'),
    modelName: MODEL,
    embeddingType: TYPE,
    dim: DIM,
    sourcePaths: [source],
  }
}

async function waitForMigration() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const progress = migration.getVectorStoreMigrationProgress()
    if (progress.state !== 'running') return progress
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('migration test timed out')
}

async function migrate(root, source) {
  migration.resetVectorStoreMigrationForTests()
  const preview = migration.createVectorStoreMigrationPreview(root, [sourceOptions(root, source)])
  assert.equal(migration.startVectorStoreMigration(root, preview.token).ok, true)
  const completed = await waitForMigration()
  assert.equal(completed.state, 'completed', completed.errors.join('\n'))
  return completed.generation
}

/** Flips one byte on disk and drops the proof memo so the change is re-hashed. */
function flipByte(filePath, offset) {
  const fd = fs.openSync(filePath, 'r+')
  try {
    const byte = Buffer.alloc(1)
    fs.readSync(fd, byte, 0, 1, offset)
    byte[0] ^= 0xff
    fs.writeSync(fd, byte, 0, 1, offset)
  } finally {
    fs.closeSync(fd)
  }
  integrity.resetEmbeddingCacheIntegrityMemoForTests()
}

function captureIntegrityWarnings(t) {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => {
    warnings.push(args.join(' '))
  }
  t.after(() => {
    console.warn = original
  })
  return warnings
}

function derivedFiles(root) {
  const cacheDir = path.join(root, 'vector-db', 'embedding-cache')
  const base = `${MODEL}__${TYPE}`
  return {
    meta: path.join(cacheDir, `${base}.f16.json`),
    vectors: path.join(cacheDir, `${base}.f16`),
    paths: path.join(cacheDir, `${base}.paths.jsonl`),
  }
}

function incrementPaths(root) {
  const storeRoot = path.join(root, 'vector-db', 'vector-store')
  const dir = increment.embeddingIncrementDir(storeRoot, MODEL, TYPE)
  return {
    dir,
    f16: path.join(dir, 'delta.f16'),
    paths: path.join(dir, 'delta.paths.jsonl'),
    commit: path.join(dir, 'delta.json'),
  }
}

test('derived cache bitflip fails closed with a signal and the next ensure rebuilds', async (t) => {
  const warnings = captureIntegrityWarnings(t)
  const { root, source } = makeRoot(t, 'derived')
  fs.writeFileSync(
    source,
    row('C:\\images\\a.jpg', [1, 0, 0]) +
      row('C:\\images\\b.jpg', [0, 1, 0]) +
      row('C:\\images\\c.jpg', [0, 0, 1]),
  )
  const options = sourceOptions(root, source)
  const handle = await cacheApi.ensureEmbeddingF16Cache(options)
  assert.equal(handle.meta.count, 3)
  assert.ok(handle.integrity, 'minted handle carries content proofs')

  flipByte(handle.vectorPath, Math.floor(fs.statSync(handle.vectorPath).size / 2))

  assert.equal(cacheApi.readExistingEmbeddingF16Cache(options), null)
  assert.equal(cacheApi.readFreshEmbeddingF16Cache(options), null)
  assert.ok(
    warnings.some((line) => line.includes('[vector-integrity] derived-read')),
    'corruption raises an explicit signal',
  )

  // Fail-closed does not mean stuck: the derived cache rebuilds from the
  // authoritative JSONL sources and serves correct results again.
  const rebuilt = await cacheApi.ensureEmbeddingF16Cache(options)
  assert.equal(rebuilt.meta.count, 3)
  const results = await cacheApi.searchEmbeddingF16Cache(rebuilt, {
    queryVector: [1, 0, 0],
    topK: 1,
  })
  assert.equal(results.length, 1)
  assert.equal(results[0].path, 'C:\\images\\a.jpg')
  assert.equal(results[0].score, 1)
})

test('derived path index bitflip fails closed', async (t) => {
  const { root, source } = makeRoot(t, 'derived-paths')
  fs.writeFileSync(
    source,
    row('C:\\images\\a.jpg', [1, 0, 0]) + row('C:\\images\\b.jpg', [0, 1, 0]),
  )
  const options = sourceOptions(root, source)
  const handle = await cacheApi.ensureEmbeddingF16Cache(options)
  flipByte(handle.pathIndexPath, 4)
  assert.equal(cacheApi.readExistingEmbeddingF16Cache(options), null)
})

test('derived meta without a committed proof is rejected (safe invalidation)', async (t) => {
  const { root, source } = makeRoot(t, 'derived-legacy')
  fs.writeFileSync(source, row('C:\\images\\a.jpg', [1, 0, 0]))
  const options = sourceOptions(root, source)
  await cacheApi.ensureEmbeddingF16Cache(options)
  const files = derivedFiles(root)
  const meta = JSON.parse(fs.readFileSync(files.meta, 'utf8'))
  delete meta.integrity
  fs.writeFileSync(files.meta, JSON.stringify(meta, null, 2), 'utf8')
  integrity.resetEmbeddingCacheIntegrityMemoForTests()
  assert.equal(cacheApi.readExistingEmbeddingF16Cache(options), null)
})

test('authoritative generation bitflip fails closed with a signal', async (t) => {
  const warnings = captureIntegrityWarnings(t)
  const { root, source } = makeRoot(t, 'authoritative')
  fs.writeFileSync(
    source,
    row('C:\\images\\a.jpg', [1, 0, 0]) + row('C:\\images\\b.jpg', [0, 1, 0]),
  )
  await migrate(root, source)
  const storeRoot = path.join(root, 'vector-db', 'vector-store')
  const manifest = store.readCurrentAuthoritativeManifest(storeRoot)
  const manifestEntry = manifest.entries.find(
    (candidate) => candidate.modelName === MODEL && candidate.embeddingType === TYPE,
  )
  const generationDir = path.join(storeRoot, 'generations', manifest.generation)
  const vectorPath = path.join(generationDir, manifestEntry.vectors.name)
  // Isolate the authoritative reader: without derived files the handle can
  // only come from the (now corrupted) generation.
  const files = derivedFiles(root)
  for (const target of [files.meta, files.vectors, files.paths]) {
    if (fs.existsSync(target)) fs.unlinkSync(target)
  }

  flipByte(vectorPath, 2)

  const options = sourceOptions(root, source)
  assert.equal(cacheApi.readExistingEmbeddingF16Cache(options), null)
  assert.equal(cacheApi.readFreshEmbeddingF16Cache(options), null)
  assert.ok(
    warnings.some((line) => line.includes('[vector-integrity] authoritative-read')),
    'corruption raises an explicit signal',
  )
})

test('delta segment bitflip rejects the composite snapshot and degrades to proven data', async (t) => {
  const warnings = captureIntegrityWarnings(t)
  const { root, source } = makeRoot(t, 'delta')
  fs.writeFileSync(
    source,
    row('C:\\images\\a.jpg', [1, 0, 0]) + row('C:\\images\\b.jpg', [0, 1, 0]),
  )
  await migrate(root, source)
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()
  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\c.jpg', [0, 0, 1]))
  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\d.jpg', [1, 1, 0]))

  const options = sourceOptions(root, source)
  const composite = cacheApi.readFreshEmbeddingF16Cache(options)
  assert.ok(composite?.delta, 'base+delta composite is served before the bitflip')
  assert.equal(composite.meta.count, 4)
  assert.ok(composite.integrity?.deltaVectors, 'composite handle carries delta proofs')

  const files = incrementPaths(root)
  const commit = JSON.parse(fs.readFileSync(files.commit, 'utf8'))
  assert.equal(typeof commit.vectorsSha256, 'string')
  assert.equal(typeof commit.pathsSha256, 'string')
  assert.ok(Number.isSafeInteger(commit.pathsBytes))

  flipByte(files.f16, 0)

  // The committed snapshot is refused with an explicit signal...
  assert.equal(
    increment.readEmbeddingIncrementSnapshot(
      path.join(root, 'vector-db', 'vector-store'),
      MODEL,
      TYPE,
      DIM,
      [source],
    ),
    null,
  )
  assert.ok(
    warnings.some((line) => line.includes('[vector-integrity] delta-read')),
    'corruption raises an explicit signal',
  )
  // ...the fresh composite is gone...
  assert.equal(cacheApi.readFreshEmbeddingF16Cache(options), null)
  // ...and stale-tolerant readers degrade to the proven derived cache: the
  // corrupted delta rows never reach consumers.
  const degraded = cacheApi.readExistingEmbeddingF16Cache(options)
  assert.ok(degraded, 'proven derived cache is still served')
  assert.equal(degraded.delta, undefined)
  assert.equal(degraded.meta.count, 2)

  // The writer fail-safe discards the corrupted increment instead of
  // laundering it into the next commit's proofs.
  const context = increment.prepareEmbeddingIncrement(
    path.join(root, 'vector-db', 'vector-store'),
    MODEL,
    TYPE,
    source,
  )
  assert.equal(context, null)
  assert.equal(fs.existsSync(files.dir), false)
})

test('delta path index bitflip rejects the composite snapshot', async (t) => {
  const { root, source } = makeRoot(t, 'delta-paths')
  fs.writeFileSync(source, row('C:\\images\\a.jpg', [1, 0, 0]))
  await migrate(root, source)
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()
  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\b.jpg', [0, 1, 0]))

  const files = incrementPaths(root)
  flipByte(files.paths, 4)

  assert.equal(
    increment.readEmbeddingIncrementSnapshot(
      path.join(root, 'vector-db', 'vector-store'),
      MODEL,
      TYPE,
      DIM,
      [source],
    ),
    null,
  )
})

test('delta proofs survive non-ASCII paths through writer revalidation', async (t) => {
  const { root, source } = makeRoot(t, 'delta-unicode')
  fs.writeFileSync(source, row('C:\\图片\\甲.jpg', [1, 0, 0]))
  await migrate(root, source)
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()
  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\图片\\乙.jpg', [0, 1, 0]))
  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\图片\\丙.jpg', [0, 0, 1]))

  const files = incrementPaths(root)
  const commit = JSON.parse(fs.readFileSync(files.commit, 'utf8'))
  // Non-ASCII paths make the JSONL byte length diverge from its UTF-16 length;
  // the commit anchors bytes.
  assert.ok(commit.pathsBytes > fs.readFileSync(files.paths, 'utf8').length)

  // Drop the same-process caches: the next prepare revalidates the committed
  // segments from disk and must still accept (and re-prove) them.
  increment.resetEmbeddingIncrementStateForTests()
  const context = increment.prepareEmbeddingIncrement(
    path.join(root, 'vector-db', 'vector-store'),
    MODEL,
    TYPE,
    source,
  )
  assert.ok(context, 'committed increment with non-ASCII paths survives revalidation')
  const snapshot = increment.readEmbeddingIncrementSnapshot(
    path.join(root, 'vector-db', 'vector-store'),
    MODEL,
    TYPE,
    DIM,
    [source],
  )
  assert.ok(snapshot, 'snapshot with non-ASCII delta paths verifies its proof')
  assert.equal(snapshot.commit.deltaCount, 2)
})

test('legacy delta commit without content proofs is safely invalidated', async (t) => {
  const { root, source } = makeRoot(t, 'delta-legacy')
  fs.writeFileSync(source, row('C:\\images\\a.jpg', [1, 0, 0]))
  await migrate(root, source)
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()
  await vectorDb.appendEmbeddingNoUpsertAsync(entry('C:\\images\\b.jpg', [0, 1, 0]))

  // Simulate a pre-VAL-038 (schema v2) commit: no content proof fields.
  const files = incrementPaths(root)
  const commit = JSON.parse(fs.readFileSync(files.commit, 'utf8'))
  delete commit.vectorsSha256
  delete commit.pathsSha256
  delete commit.pathsBytes
  commit.version = 2
  fs.writeFileSync(files.commit, JSON.stringify(commit, null, 2), 'utf8')
  integrity.resetEmbeddingCacheIntegrityMemoForTests()

  assert.equal(
    increment.readEmbeddingIncrementSnapshot(
      path.join(root, 'vector-db', 'vector-store'),
      MODEL,
      TYPE,
      DIM,
      [source],
    ),
    null,
  )
  assert.equal(cacheApi.readFreshEmbeddingF16Cache(sourceOptions(root, source))?.delta, undefined)
})
