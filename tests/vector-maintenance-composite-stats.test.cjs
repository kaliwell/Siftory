const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const migration = loadTsModule('electron/vectorStoreMigrationService.ts')
const vectorDb = loadTsModule('electron/vectorDatabaseService.ts')
const increment = loadTsModule('electron/embeddingIncrementLog.ts')
const maintenance = loadTsModule('electron/vectorMaintenanceService.ts')

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `floating-clock-vmcs-${label}-`))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const embeddings = path.join(root, 'vector-db', 'embeddings')
  fs.mkdirSync(embeddings, { recursive: true })
  const source = path.join(embeddings, `${MODEL}__${TYPE}.jsonl`)
  return { root, source }
}

function storeRoot(root) {
  return path.join(root, 'vector-db', 'vector-store')
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

async function appendRows(root, rows) {
  vectorDb.initVectorDatabase(root)
  increment.resetEmbeddingIncrementStateForTests()
  for (const [imageId, vector] of rows) {
    await vectorDb.appendEmbeddingNoUpsertAsync(entry(imageId, vector))
  }
}

function compositeStats(root, source) {
  return maintenance.readCompositeEmbeddingShardStats({
    storeRoot: storeRoot(root),
    modelName: MODEL,
    embeddingType: TYPE,
    sourcePaths: [source],
  })
}

/** Pre-D3 baseline: line count + distinct imageId from the JSONL shard. */
function jsonlScanBaseline(source) {
  const unique = new Set()
  let records = 0
  for (const line of fs.readFileSync(source, 'utf8').split('\n')) {
    if (!line) continue
    records++
    unique.add(JSON.parse(line).imageId)
  }
  return { records, unique: unique.size }
}

test('composite stats match the JSONL line-scan baseline after appends', async (t) => {
  const { root, source } = makeRoot(t, 'align')
  fs.writeFileSync(
    source,
    row('C:\\images\\a.jpg', [1, 0, 0]) +
      row('C:\\images\\b.jpg', [0, 2, 0]) +
      row('C:\\images\\c.jpg', [0, 0, 3]) +
      row('C:\\images\\d.jpg', [1, 1, 0]),
  )
  await migrate(root, source)
  // One duplicate imageId (re-embedded) plus one brand-new row.
  await appendRows(root, [
    ['C:\\images\\b.jpg', [0, 5, 0]],
    ['C:\\images\\e.jpg', [4, 0, 0]],
  ])

  const stats = await compositeStats(root, source)
  assert.ok(stats, 'composite snapshot must serve the diagnostic stats')
  // Records follow the composite caliber sourceRecordCount + δ: the shard
  // holds 6 lines (4 migrated + 2 appended), the duplicate included.
  assert.equal(stats.records, 6)
  assert.equal(stats.unique, 5, 'the duplicate imageId collapses across base + delta')
  assert.deepEqual(
    stats,
    jsonlScanBaseline(source),
    'composite caliber must match the JSONL baseline',
  )

  // An uncommitted tail (crash between the delta segment write and the
  // delta.json commit) must not be counted.
  const dir = increment.embeddingIncrementDir(storeRoot(root), MODEL, TYPE)
  fs.appendFileSync(path.join(dir, 'delta.paths.jsonl'), '{"row":6,"path":"C:\\\\images\\\\ghost')
  assert.deepEqual(await compositeStats(root, source), stats)
})

test('a discarded increment degrades the stats to the base generation only', async (t) => {
  const { root, source } = makeRoot(t, 'base-only')
  fs.writeFileSync(
    source,
    row('C:\\images\\a.jpg', [1, 0, 0]) + row('C:\\images\\b.jpg', [0, 1, 0]),
  )
  await migrate(root, source)
  await appendRows(root, [['C:\\images\\c.jpg', [0, 0, 1]]])

  fs.rmSync(increment.embeddingIncrementDir(storeRoot(root), MODEL, TYPE), {
    recursive: true,
    force: true,
  })
  const stats = await compositeStats(root, source)
  assert.deepEqual(stats, { records: 2, unique: 2 })
})

test('missing generation returns null so the caller falls back to the JSONL scan', async (t) => {
  const { root, source } = makeRoot(t, 'fallback')
  fs.writeFileSync(source, row('C:\\images\\a.jpg', [1, 0, 0]))
  assert.equal(await compositeStats(root, source), null)
  assert.deepEqual(jsonlScanBaseline(source), { records: 1, unique: 1 })
})

test('maintenance shard stats are available without building unrelated storage inventory', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-vmcs-targeted-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const embeddings = path.join(root, 'vector-db', 'embeddings')
  fs.mkdirSync(embeddings, { recursive: true })
  const source = path.join(embeddings, 'dinov2_vitb14__global.jsonl')
  const vector = [1, ...Array(767).fill(0)]
  fs.writeFileSync(
    source,
    `${JSON.stringify({
      modelName: 'dinov2_vitb14',
      embeddingType: TYPE,
      imageId: 'C:\\images\\dino.jpg',
      dim: 768,
      vector,
    })}\n`,
  )
  migration.resetVectorStoreMigrationForTests()
  const preview = migration.createVectorStoreMigrationPreview(root, [
    {
      cacheDir: path.join(root, 'vector-db', 'embedding-cache'),
      modelName: 'dinov2_vitb14',
      embeddingType: TYPE,
      dim: 768,
      sourcePaths: [source],
    },
  ])
  assert.equal(migration.startVectorStoreMigration(root, preview.token).ok, true)
  const completed = await waitForMigration()
  assert.equal(completed.state, 'completed', completed.errors.join('\n'))

  const stats = await maintenance.getVectorMaintenanceShardStats(path.join(root, 'vector-db'))

  assert.deepEqual(stats, {
    dinoEmbeddingRecords: 1,
    dinoUniqueImages: 1,
    clipEmbeddingRecords: 0,
    clipUniqueImages: 0,
  })
})
