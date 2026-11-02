const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')
const { readBenchmarkSnapshot } = require('../scripts/vector-benchmark-snapshot.cjs')
const migration = loadTsModule('electron/vectorStoreMigrationService.ts')
const cacheApi = loadTsModule('electron/embeddingF16Cache.ts')
const vectorDb = loadTsModule('electron/vectorDatabaseService.ts')
const increment = loadTsModule('electron/embeddingIncrementLog.ts')

test('real-layout discovery includes committed increments and latest path revisions', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-benchmark-snapshot-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const modelName = 'dinov2_vitb14'
  const dim = 768
  const source = path.join(root, 'vector-db', 'embeddings', `${modelName}__global.jsonl`)
  fs.mkdirSync(path.dirname(source), { recursive: true })
  const row = (imageId, coordinate) => {
    const vector = Array(dim).fill(0)
    vector[coordinate] = 1
    return {
      imageId,
      modelName,
      modelVersion: '1',
      embeddingType: 'global',
      dim,
      vector,
      norm: 1,
      createdAt: 1,
      updatedAt: 1,
    }
  }
  fs.writeFileSync(
    source,
    [row('C:/synthetic/a.jpg', 0), row('C:/synthetic/b.jpg', 1)].map(JSON.stringify).join('\n') +
      '\n',
  )
  const options = {
    cacheDir: path.join(root, 'vector-db', 'embedding-cache'),
    modelName,
    embeddingType: 'global',
    dim,
    sourcePaths: [source],
  }
  migration.resetVectorStoreMigrationForTests()
  const preview = migration.createVectorStoreMigrationPreview(root, [options])
  assert.equal(migration.startVectorStoreMigration(root, preview.token).ok, true)
  for (
    let attempt = 0;
    attempt < 200 && migration.getVectorStoreMigrationProgress().state === 'running';
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(migration.getVectorStoreMigrationProgress().state, 'completed')
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()
  for (const entry of [
    row('C:/synthetic/c.jpg', 2),
    row('C:/synthetic/a.jpg', 3),
    row('C:/synthetic/d.jpg', 4),
  ])
    await vectorDb.appendEmbeddingNoUpsertAsync(entry)

  const stale = cacheApi.readExistingEmbeddingF16Cache({ ...options, sourcePaths: [] })
  assert.equal(stale.meta.count, 2, 'empty source lists reproduce the previous benchmark omission')
  const before = fs.readFileSync(source)
  const snapshot = readBenchmarkSnapshot(root)
  assert.equal(snapshot.meta.count, 5)
  assert.equal(snapshot.delta.baseCount, 2)
  const rows = cacheApi.readEmbeddingF16CacheLatestPathRowsSync(snapshot)
  assert.equal(rows.length, 4)
  assert.equal(rows.find((row) => row.path === 'C:/synthetic/a.jpg').row, 3)
  assert.deepEqual(fs.readFileSync(source), before)

  // A committed generation remains useful after import JSONL removal. This
  // must still select its valid increment rather than silently selecting base.
  fs.renameSync(source, `${source}.retained`)
  assert.equal(readBenchmarkSnapshot(root).meta.count, 5)
  assert.ok(readBenchmarkSnapshot(root).delta)
  const descriptor = fs.openSync(snapshot.delta.vectorPath, 'r+')
  try {
    fs.writeSync(descriptor, Buffer.from([0xff, 0xff]), 0, 2, 0)
  } finally {
    fs.closeSync(descriptor)
  }
  assert.throws(() => readBenchmarkSnapshot(root), /increment could not be verified/)
})

test('missing snapshots do not create files and unknown models fail closed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-benchmark-missing-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.equal(readBenchmarkSnapshot(root), null)
  assert.equal(readBenchmarkSnapshot(root, 'clip_vit_base_patch32'), null)
  assert.throws(() => readBenchmarkSnapshot(root, '../escape'), /Unsupported/)
  assert.deepEqual(fs.readdirSync(root), [])
})

test('complete derived CLIP snapshots are measured without changing their bytes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-benchmark-clip-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const modelName = 'clip_vit_base_patch32'
  const source = path.join(root, 'vector-db', 'embeddings', `${modelName}__global.jsonl`)
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(
    source,
    JSON.stringify({
      modelName,
      embeddingType: 'global',
      imageId: 'C:/synthetic/a.jpg',
      dim: 512,
      vector: [1, ...Array(511).fill(0)],
    }) + '\n',
  )
  const cache = await cacheApi.ensureEmbeddingF16Cache({
    cacheDir: path.join(root, 'vector-db', 'embedding-cache'),
    modelName,
    embeddingType: 'global',
    dim: 512,
    sourcePaths: [source],
    preferAuthoritative: false,
  })
  const before = fs.readFileSync(cache.vectorPath)
  const actual = readBenchmarkSnapshot(root, modelName)
  assert.equal(actual.meta.count, 1)
  assert.equal(actual.meta.dim, 512)
  assert.deepEqual(fs.readFileSync(cache.vectorPath), before)
})
