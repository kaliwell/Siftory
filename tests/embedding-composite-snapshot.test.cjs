const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const migration = loadTsModule('electron/vectorStoreMigrationService.ts')
const cacheApi = loadTsModule('electron/embeddingF16Cache.ts')
const vectorDb = loadTsModule('electron/vectorDatabaseService.ts')
const increment = loadTsModule('electron/embeddingIncrementLog.ts')
const recall = loadTsModule('electron/vectorGenerationRecall.ts')
const clipReader = loadTsModule('electron/clipEmbeddingCacheReader.ts')

const MODEL = 'fixture_dinov2'
const TYPE = 'global'
const DIM = 3
const CLIP_MODEL = 'clip_vit_base_patch32'
const CLIP_DIM = 512

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `floating-clock-ecs-${label}-`))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const embeddings = path.join(root, 'vector-db', 'embeddings')
  fs.mkdirSync(embeddings, { recursive: true })
  const source = path.join(embeddings, `${MODEL}__${TYPE}.jsonl`)
  return { root, source }
}

function cacheOptions(root, source) {
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
  const preview = migration.createVectorStoreMigrationPreview(root, [cacheOptions(root, source)])
  assert.equal(migration.startVectorStoreMigration(root, preview.token).ok, true)
  const completed = await waitForMigration()
  assert.equal(completed.state, 'completed', completed.errors.join('\n'))
  return completed.generation
}

function incrementDir(root) {
  return increment.embeddingIncrementDir(path.join(root, 'vector-db', 'vector-store'), MODEL, TYPE)
}

async function appendRows(root, source, rows) {
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()
  for (const [imageId, vector] of rows) {
    await vectorDb.appendEmbeddingNoUpsertAsync(entry(imageId, vector))
  }
}

async function readAll(handle) {
  const rows = []
  await cacheApi.streamEmbeddingF16Cache(handle, {
    onVector: (filePath, vector, rowIndex) =>
      rows.push({ path: filePath, vector: Array.from(vector), row: rowIndex }),
  })
  return rows
}

test('composite snapshot reads align with a full JSONL rebuild after appends', async (t) => {
  const { root, source } = makeRoot(t, 'align')
  fs.writeFileSync(
    source,
    row('C:\\images\\a.jpg', [1, 0, 0]) + row('C:\\images\\b.jpg', [0, 2, 0]),
  )
  const generation = await migrate(root, source)
  await appendRows(root, source, [
    ['C:\\images\\c.jpg', [0, 0, 3]],
    ['C:\\images\\d.jpg', [1, 1, 0]],
    ['C:\\images\\e.jpg', [4, 0, 0]],
  ])

  // Freshness read returns the composite handle instead of null: the derived
  // cache is not rebuilt after appends.
  const handle = cacheApi.readFreshEmbeddingF16Cache(cacheOptions(root, source))
  assert.ok(handle, 'composite snapshot must be fresh after appends')
  assert.equal(handle.meta.generation, generation)
  assert.equal(handle.meta.count, 5)
  assert.equal(handle.meta.sourceRecordCount, 5)
  assert.ok(handle.delta)
  assert.equal(handle.delta.baseCount, 2)

  // ensureEmbeddingF16Cache serves the same composite handle without a build.
  const ensured = await cacheApi.ensureEmbeddingF16Cache(cacheOptions(root, source))
  assert.ok(ensured?.delta, 'ensure must not fall back to a rebuild')

  // Fingerprint stays generation-kind with count+δ, never falls back to jsonl:.
  const description = cacheApi.describeEmbeddingVectorSource(cacheOptions(root, source))
  assert.equal(description.kind, 'generation')
  assert.equal(description.fingerprint, `generation:${generation}:5:5`)
  assert.equal(cacheApi.embeddingVectorSourceStabilityKey(description), `generation:${generation}`)

  // Row content matches a full rebuild of the final JSONL, within F16 tolerance.
  const referenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ecs-ref-'))
  t.after(() => fs.rmSync(referenceRoot, { recursive: true, force: true }))
  const rebuilt = await cacheApi.ensureEmbeddingF16Cache({
    cacheDir: path.join(referenceRoot, 'cache'),
    modelName: MODEL,
    embeddingType: TYPE,
    dim: DIM,
    sourcePaths: [source],
    preferAuthoritative: false,
  })
  const compositeRows = await readAll(handle)
  const rebuiltRows = await readAll(rebuilt)
  assert.equal(compositeRows.length, rebuiltRows.length)
  for (let index = 0; index < compositeRows.length; index++) {
    assert.equal(compositeRows[index].path, rebuiltRows[index].path)
    assert.equal(compositeRows[index].row, rebuiltRows[index].row)
    for (let component = 0; component < DIM; component++) {
      assert.ok(
        Math.abs(compositeRows[index].vector[component] - rebuiltRows[index].vector[component]) <=
          2e-3,
        `row ${index} component ${component} exceeds the F16 tolerance`,
      )
    }
  }

  // Point lookups resolve rows from both the base and the delta segment.
  const lookup = cacheApi.readEmbeddingF16VectorsForPathsSync(handle, [
    'C:\\images\\a.jpg',
    'C:\\images\\e.jpg',
  ])
  assert.equal(lookup.size, 2)
})

test('composite readers expose only the latest revision of duplicate paths', async (t) => {
  const { root, source } = makeRoot(t, 'latest')
  fs.writeFileSync(
    source,
    row('C:\\images\\a.jpg', [1, 0, 0]) + row('C:\\images\\b.jpg', [0, 1, 0]),
  )
  await migrate(root, source)
  await appendRows(root, source, [
    ['C:\\IMAGES\\A.jpg', [0, 0, 1]],
    ['C:\\images\\c.jpg', [1, 1, 0]],
    ['C:/images/a.jpg', [0, -1, 0]],
  ])

  const handle = cacheApi.readFreshEmbeddingF16Cache(cacheOptions(root, source))
  assert.ok(handle?.delta)
  assert.equal(handle.meta.count, 5, 'physical base+delta rows remain addressable')

  const currentRows = cacheApi.readEmbeddingF16CacheLatestPathRowsSync(handle)
  assert.deepEqual(
    currentRows.map((item) => item.path),
    ['C:\\images\\b.jpg', 'C:\\images\\c.jpg', 'C:/images/a.jpg'],
  )
  assert.deepEqual(
    cacheApi.readEmbeddingF16CachePaths(handle),
    currentRows.map((item) => item.path),
  )

  const streamed = await readAll(handle)
  assert.deepEqual(
    streamed.map((item) => item.path),
    currentRows.map((item) => item.path),
  )
  assert.equal(streamed.filter((item) => /[\\/]a\.jpg$/i.test(item.path)).length, 1)

  const syncLookup = cacheApi.readEmbeddingF16VectorsForPathsSync(handle, ['c:\\images\\a.jpg'])
  const asyncLookup = await cacheApi.readEmbeddingF16VectorsForPaths(handle, ['C:/IMAGES/A.jpg'])
  for (const lookup of [syncLookup, asyncLookup]) {
    const vector = lookup.get(cacheApi.embeddingCachePathKey('C:\\images\\a.jpg'))
    assert.ok(vector)
    assert.ok(Math.abs(vector[0]) <= 2e-3)
    assert.ok(Math.abs(vector[1] + 1) <= 2e-3)
    assert.ok(Math.abs(vector[2]) <= 2e-3)
  }

  const search = await cacheApi.searchEmbeddingF16Cache(handle, {
    queryVector: new Float32Array([1, 0, 0]),
    topK: 10,
  })
  assert.equal(search.length, 3)
  assert.equal(search.filter((item) => /[\\/]a\.jpg$/i.test(item.path)).length, 1)
  assert.ok(Math.abs(search.find((item) => /[\\/]a\.jpg$/i.test(item.path)).score - 0.5) <= 2e-3)

  const referenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ecs-latest-ref-'))
  t.after(() => fs.rmSync(referenceRoot, { recursive: true, force: true }))
  const rebuilt = await cacheApi.ensureEmbeddingF16Cache({
    cacheDir: path.join(referenceRoot, 'cache'),
    modelName: MODEL,
    embeddingType: TYPE,
    dim: DIM,
    sourcePaths: [source],
    preferAuthoritative: false,
  })
  assert.deepEqual(
    (await readAll(handle)).map((item) => item.path),
    (await readAll(rebuilt)).map((item) => item.path),
  )
})

test('asset CLIP cache reader resolves committed delta additions and updates', async (t) => {
  const { root, source } = makeRoot(t, 'clip-reader')
  const oneHot = (dimension) =>
    Array.from({ length: CLIP_DIM }, (_, index) => (index === dimension ? 1 : 0))
  const clipRow = (imageId, vector) =>
    `${JSON.stringify({ modelName: CLIP_MODEL, embeddingType: TYPE, imageId, dim: CLIP_DIM, vector })}\n`
  fs.writeFileSync(
    source,
    clipRow('C:\\images\\a.jpg', oneHot(0)) + clipRow('C:\\images\\b.jpg', oneHot(1)),
  )
  const options = {
    cacheDir: path.join(root, 'vector-db', 'embedding-cache'),
    modelName: CLIP_MODEL,
    embeddingType: TYPE,
    dim: CLIP_DIM,
    sourcePaths: [source],
  }
  migration.resetVectorStoreMigrationForTests()
  const preview = migration.createVectorStoreMigrationPreview(root, [options])
  assert.equal(migration.startVectorStoreMigration(root, preview.token).ok, true)
  assert.equal((await waitForMigration()).state, 'completed')

  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()
  const appendClip = (imageId, vector) =>
    vectorDb.appendEmbeddingNoUpsertAsync({
      imageId,
      modelName: CLIP_MODEL,
      modelVersion: '1',
      embeddingType: TYPE,
      dim: CLIP_DIM,
      vector,
      norm: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  await appendClip('c:/IMAGES/a.jpg', oneHot(2))
  await appendClip('C:\\images\\c.jpg', oneHot(3))

  const vectors = await clipReader.loadClipEmbeddingsForPaths(path.join(root, 'vector-db'), [
    'C:\\images\\a.jpg',
    'C:\\images\\c.jpg',
  ])
  assert.equal(vectors.size, 2)
  const updated = vectors.get(path.resolve('C:\\images\\a.jpg').toLowerCase())
  const added = vectors.get(path.resolve('C:\\images\\c.jpg').toLowerCase())
  assert.ok(updated)
  assert.ok(added)
  assert.ok(Math.abs(updated[2] - 1) <= 2e-3)
  assert.ok(Math.abs(updated[0]) <= 2e-3)
  assert.ok(Math.abs(added[3] - 1) <= 2e-3)

  const clipShard = path.join(root, 'vector-db', 'embeddings', `${CLIP_MODEL}__${TYPE}.jsonl`)
  const currentOptions = { ...options, sourcePaths: [source, clipShard] }
  const composite = cacheApi.readExistingEmbeddingF16Cache(currentOptions)
  assert.ok(composite?.delta, 'the fixture must expose a real committed D3 composite')
  const clipIncrement = increment.embeddingIncrementDir(
    path.join(root, 'vector-db', 'vector-store'),
    CLIP_MODEL,
    TYPE,
  )
  assert.equal(fs.existsSync(path.join(clipIncrement, 'delta.json')), true)

  const invalidated = await vectorDb.appendGlobalEmbeddingInvalidationTombstonesAsync(
    ['C:\\images\\a.jpg'],
    ['clip'],
  )
  assert.equal(invalidated.appendedRows, 1)
  assert.equal(fs.existsSync(clipIncrement), false)
  assert.equal(cacheApi.readExistingEmbeddingF16Cache(currentOptions), null)
  assert.equal(cacheApi.readFreshEmbeddingF16Cache(currentOptions), null)

  const rebuilt = await cacheApi.ensureEmbeddingF16Cache(currentOptions)
  const rebuiltPaths = cacheApi.readEmbeddingF16CachePaths(rebuilt)
  assert.equal(
    rebuiltPaths.some((imagePath) => /[\\/]a\.jpg$/i.test(imagePath)),
    false,
  )
  assert.equal(
    rebuiltPaths.some((imagePath) => /[\\/]b\.jpg$/i.test(imagePath)),
    true,
  )
  assert.equal(
    rebuiltPaths.some((imagePath) => /[\\/]c\.jpg$/i.test(imagePath)),
    true,
  )
})

test('uncommitted delta tail is invisible to the composite read view', async (t) => {
  const { root, source } = makeRoot(t, 'tail')
  fs.writeFileSync(source, row('C:\\images\\a.jpg', [1, 0, 0]))
  await migrate(root, source)
  await appendRows(root, source, [['C:\\images\\b.jpg', [0, 1, 0]]])

  // Crash between the delta segment writes and the delta.json commit.
  const dir = incrementDir(root)
  fs.appendFileSync(path.join(dir, 'delta.f16'), Buffer.from([1, 2, 3, 4, 5]))
  fs.appendFileSync(path.join(dir, 'delta.paths.jsonl'), '{"row":2,"path":"C:\\\\images\\\\ghost')

  const handle = cacheApi.readFreshEmbeddingF16Cache(cacheOptions(root, source))
  assert.ok(handle)
  assert.equal(handle.meta.count, 2, 'only committed delta rows are visible')
  const rows = await readAll(handle)
  assert.deepEqual(
    rows.map((item) => item.path),
    ['C:\\images\\a.jpg', 'C:\\images\\b.jpg'],
  )
})

test('JSONL ahead of the committed increment is incomplete for freshness reads', async (t) => {
  const { root, source } = makeRoot(t, 'ahead')
  fs.writeFileSync(source, row('C:\\images\\a.jpg', [1, 0, 0]))
  await migrate(root, source)
  await appendRows(root, source, [['C:\\images\\b.jpg', [0, 1, 0]]])

  // Crash window: the JSONL row landed but the delta commit did not.
  fs.appendFileSync(source, row('C:\\images\\x.jpg', [9, 9, 9]))

  assert.equal(
    cacheApi.readFreshEmbeddingF16Cache(cacheOptions(root, source)),
    null,
    'freshness reads must fall back to rebuild while the JSONL leads the delta',
  )
  const existing = cacheApi.readExistingEmbeddingF16Cache(cacheOptions(root, source))
  assert.ok(existing?.delta, 'stale-tolerant reads still see the committed composite snapshot')
  assert.equal(existing.meta.count, 2)
  const description = cacheApi.describeEmbeddingVectorSource(cacheOptions(root, source))
  assert.equal(description.kind, 'jsonl', 'fingerprint falls back to the JSONL caliber')
})

test('migration switch removes the stale increment directory', async (t) => {
  const { root, source } = makeRoot(t, 'switch')
  fs.writeFileSync(source, row('C:\\images\\a.jpg', [1, 0, 0]))
  await migrate(root, source)
  await appendRows(root, source, [['C:\\images\\b.jpg', [0, 1, 0]]])
  assert.ok(fs.existsSync(path.join(incrementDir(root), 'delta.json')))

  const nextGeneration = await migrate(root, source)
  assert.equal(
    fs.existsSync(incrementDir(root)),
    false,
    'the executor removes the increment directory anchored on the old generation',
  )

  const handle = cacheApi.readFreshEmbeddingF16Cache(cacheOptions(root, source))
  assert.ok(handle)
  assert.equal(handle.meta.generation, nextGeneration)
  assert.equal(handle.meta.count, 2, 'the new generation folded the appended rows in')
  assert.equal(handle.delta, undefined)
  const description = cacheApi.describeEmbeddingVectorSource(cacheOptions(root, source))
  assert.equal(description.fingerprint, `generation:${nextGeneration}:2:2`)
})

test('migration reuses committed delta rows and scans only the JSONL lead', async (t) => {
  const { root, source } = makeRoot(t, 'migration-delta')
  fs.writeFileSync(
    source,
    row('C:\\images\\a.jpg', [1, 0, 0]) + row('C:\\images\\b.jpg', [0, 2, 0]),
  )
  await migrate(root, source)
  await appendRows(root, source, [
    ['C:\\images\\a.jpg', [9, 0, 0]],
    ['C:\\images\\c.jpg', [0, 0, 3]],
    ['C:\\images\\a.jpg', [5, 5, 0]],
  ])
  const deltaCommit = JSON.parse(
    fs.readFileSync(path.join(incrementDir(root), 'delta.json'), 'utf8'),
  )
  fs.appendFileSync(
    source,
    row('C:\\images\\d.jpg', [1, 1, 1]) + row('C:\\images\\c.jpg', [0, 4, 0]),
  )

  const sourceReadStarts = []
  const originalCreateReadStream = fs.createReadStream
  fs.createReadStream = function trackedCreateReadStream(filePath, options) {
    if (path.resolve(String(filePath)) === path.resolve(source)) {
      sourceReadStarts.push(options?.start ?? 0)
    }
    return originalCreateReadStream.call(this, filePath, options)
  }
  try {
    await migrate(root, source)
  } finally {
    fs.createReadStream = originalCreateReadStream
  }
  assert.deepEqual(
    sourceReadStarts,
    [deltaCommit.sources[0].size],
    'the committed JSONL prefix must not be parsed again',
  )

  const cacheDir = path.join(root, 'vector-db', 'embedding-cache')
  const extendedVectors = fs.readFileSync(path.join(cacheDir, `${MODEL}__${TYPE}.f16`))
  const extendedPaths = fs.readFileSync(
    path.join(cacheDir, `${MODEL}__${TYPE}.paths.jsonl`),
    'utf8',
  )
  const referenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ecs-migrate-ref-'))
  t.after(() => fs.rmSync(referenceRoot, { recursive: true, force: true }))
  const rebuilt = await cacheApi.ensureEmbeddingF16Cache({
    cacheDir: path.join(referenceRoot, 'cache'),
    modelName: MODEL,
    embeddingType: TYPE,
    dim: DIM,
    sourcePaths: [source],
    preferAuthoritative: false,
  })
  assert.deepEqual(extendedVectors, fs.readFileSync(rebuilt.vectorPath))
  assert.equal(extendedPaths, fs.readFileSync(rebuilt.pathIndexPath, 'utf8'))
  assert.deepEqual(
    extendedPaths
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).path),
    ['C:\\images\\b.jpg', 'C:\\images\\a.jpg', 'C:\\images\\d.jpg', 'C:\\images\\c.jpg'],
  )
})

test('recall gate accepts the composite snapshot and fails without it', async (t) => {
  const { root, source } = makeRoot(t, 'recall')
  const vectors = []
  for (let index = 0; index < 40; index++) {
    vectors.push([
      `C:\\images\\img-${index}.jpg`,
      [index + 1, ((index * 7) % 13) + 1, ((index * 3) % 5) + 1],
    ])
  }
  fs.writeFileSync(
    source,
    vectors
      .slice(0, 30)
      .map(([id, v]) => row(id, v))
      .join(''),
  )
  await migrate(root, source)
  await appendRows(root, source, vectors.slice(30))

  const handle = cacheApi.readFreshEmbeddingF16Cache(cacheOptions(root, source))
  assert.ok(handle?.delta)
  const report = await recall.evaluateGenerationRecall(source, handle, {
    queryCount: 20,
    topK: 5,
  })
  assert.equal(report.generationCount, 40)
  assert.equal(report.alignedCount, 40)
  assert.equal(report.gatePassed, true, report.gateFailures.join('; '))

  // Without the increment the generation alone is stale: the gate's handle
  // read fails closed, exactly the pre-D3 behavior.
  fs.rmSync(incrementDir(root), { recursive: true, force: true })
  assert.equal(cacheApi.readFreshEmbeddingF16Cache(cacheOptions(root, source)), null)
})
