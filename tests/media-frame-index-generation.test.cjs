const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const electronModulePath = require.resolve('electron')
require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getAppPath: () => path.resolve(__dirname, '..'),
      getPath: () => os.tmpdir(),
    },
  },
}

const { ensureMediaSearchDirs, setMediaSearchDirForTests } = loadTsModule(
  'electron/mediaCacheService.ts',
)
const {
  appendEmbeddingNoUpsertAsync,
  initVectorDatabase,
  getEmbeddingCacheDir,
  getEmbeddingStorePaths,
} = loadTsModule('electron/vectorDatabaseService.ts')
const {
  buildFrameIndex,
  acquireFrameIndexForSearch,
  ensureFrameIndexFreshAsync,
  findFrameVector,
  getFrameIndexCacheMemoryStats,
  getFrameEmbeddingCacheOptions,
  invalidateFrameIndex,
  isFrameIndexFresh,
  loadFrameIndex,
  requestFrameIndexMemoryPressureRelease,
  setFrameIndexIdleTimeoutForTests,
} = loadTsModule('electron/mediaSearchFrameIndex.ts')
const { collectEmbeddedImageIds, getFrameEmbeddingStats } = loadTsModule(
  'electron/videoFrameService.ts',
)
const { describeEmbeddingVectorSource } = loadTsModule('electron/embeddingF16Cache.ts')
const migration = loadTsModule('electron/vectorStoreMigrationService.ts')
const annHost = loadTsModule('electron/vectorAnnWorkerHost.ts')

test.after(() => annHost.disposeVectorAnnWorker())

const CLIP = 'clip_vit_base_patch32'
const CLIP_DIM = 512
const DINO = 'dinov2_vitb14'
const DINO_DIM = 768

function unitVector(first, second = 0) {
  const vector = Array(CLIP_DIM).fill(0)
  vector[0] = first
  vector[1] = second
  const norm = Math.sqrt(first * first + second * second) || 1
  vector[0] /= norm
  vector[1] /= norm
  return vector
}

function embeddingRow(imageId, vector, modelName = CLIP) {
  return { imageId, modelName, embeddingType: 'global', dim: CLIP_DIM, vector }
}

function writeJsonLines(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

function initFixture(root) {
  const mediaDir = path.join(root, 'media-search')
  const userDataDir = path.join(root, 'user-data')
  setMediaSearchDirForTests(mediaDir)
  initVectorDatabase(userDataDir)
  ensureMediaSearchDirs()

  const videoPath = path.join(root, 'fixture.mp4')
  fs.writeFileSync(videoPath, 'video')
  const framesDir = path.join(mediaDir, 'frames', 'video-a')
  fs.mkdirSync(framesDir, { recursive: true })
  const framePaths = ['alpha', 'beta', 'gamma'].map((name) => path.join(framesDir, `${name}.jpg`))
  for (const framePath of framePaths) fs.writeFileSync(framePath, 'jpg')

  writeJsonLines(
    path.join(mediaDir, 'manifests', 'video_frames.jsonl'),
    framePaths.map((imagePath, index) => ({
      frameId: `frame-${index}`,
      videoId: 'video-a',
      videoPath,
      timestampMs: (index + 1) * 1000,
      imagePath,
      status: 'done',
      createdAt: 1,
      updatedAt: 1,
    })),
  )

  // Two frame rows in the model shard, the third only in the legacy store —
  // coverage and index semantics must include legacy rows either way.
  writeJsonLines(path.join(userDataDir, 'vector-db', 'embeddings', `${CLIP}__global.jsonl`), [
    embeddingRow(framePaths[0], unitVector(1, 0)),
    embeddingRow(framePaths[1], unitVector(0.9, 0.2)),
    embeddingRow(path.join(root, 'not-a-frame.jpg'), unitVector(0, 1)),
  ])
  writeJsonLines(path.join(userDataDir, 'vector-db', 'image_embeddings.jsonl'), [
    embeddingRow(framePaths[2], unitVector(0.5, 0.5)),
  ])

  return { mediaDir, userDataDir, framePaths }
}

function readIndexEntries(mediaDir) {
  const filePath = path.join(mediaDir, 'vectors', 'frame_embedding_index.jsonl')
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test('frame index keeps one model, defers pressure release during search, and releases idle cache', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-frame-lifecycle-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { mediaDir, framePaths } = initFixture(root)
  const indexPath = path.join(mediaDir, 'vectors', 'frame_embedding_index.jsonl')
  writeJsonLines(indexPath, [
    { imagePath: framePaths[0], modelName: CLIP, dim: CLIP_DIM, vector: unitVector(1, 0) },
    {
      imagePath: framePaths[0],
      modelName: DINO,
      dim: DINO_DIM,
      vector: [1, ...Array(DINO_DIM - 1).fill(0)],
    },
  ])

  assert.equal(loadFrameIndex(CLIP).size, 1)
  assert.equal(getFrameIndexCacheMemoryStats().models, 1)
  assert.equal(loadFrameIndex(DINO).size, 1)
  assert.deepEqual(
    {
      models: getFrameIndexCacheMemoryStats().models,
      entries: getFrameIndexCacheMemoryStats().entries,
    },
    { models: 1, entries: 1 },
  )

  const lease = await acquireFrameIndexForSearch(CLIP)
  assert.equal(lease.index.size, 1)
  assert.deepEqual(requestFrameIndexMemoryPressureRelease(), {
    status: 'deferred',
    activeSearches: 1,
    releasedModels: 0,
  })
  assert.equal(getFrameIndexCacheMemoryStats().models, 1)
  assert.ok(lease.index.has(framePaths[0]))
  lease.release()
  assert.equal(getFrameIndexCacheMemoryStats().models, 0)

  const restoreIdleTimeout = setFrameIndexIdleTimeoutForTests(20)
  t.after(restoreIdleTimeout)
  loadFrameIndex(DINO)
  assert.equal(getFrameIndexCacheMemoryStats().models, 1)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(getFrameIndexCacheMemoryStats().models, 0)
})

function assertVectorsClose(actual, expected, tolerance = 2e-3) {
  assert.equal(actual.length, expected.length)
  for (let index = 0; index < actual.length; index++) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= tolerance,
      `vector[${index}]: ${actual[index]} vs ${expected[index]}`,
    )
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

async function migrateToGeneration(userDataDir) {
  migration.resetVectorStoreMigrationForTests()
  const options = {
    cacheDir: getEmbeddingCacheDir(),
    modelName: CLIP,
    embeddingType: 'global',
    dim: CLIP_DIM,
    sourcePaths: getEmbeddingStorePaths(CLIP, 'global'),
  }
  const preview = migration.createVectorStoreMigrationPreview(userDataDir, [options])
  assert.equal(preview.models.length, 1)
  assert.equal(migration.startVectorStoreMigration(userDataDir, preview.token).ok, true)
  const completed = await waitForMigration()
  assert.equal(completed.state, 'completed', completed.errors.join('\n'))
  return completed.generation
}

test('frame index and coverage stats read from generation match the JSONL baseline', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-frame-generation-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { mediaDir, userDataDir, framePaths } = initFixture(root)

  // Baseline: no generation, both readers scan the shards directly.
  const baselineBuild = buildFrameIndex()
  assert.equal(baselineBuild.entries, 3)
  assert.equal(baselineBuild.errors, 0)
  const baselineEntries = readIndexEntries(mediaDir)
  const baselineStats = await getFrameEmbeddingStats()
  assert.equal(baselineStats.clipEmbeddedFrames, 3)
  assert.equal(baselineStats.missingClipFrames, 0)

  await migrateToGeneration(userDataDir)

  // Rebuild against the authoritative generation and compare with baseline.
  invalidateFrameIndex()
  const generationBuild = buildFrameIndex()
  assert.equal(generationBuild.entries, 3)
  assert.equal(generationBuild.errors, 0)
  const generationEntries = readIndexEntries(mediaDir)
  assert.deepEqual(
    generationEntries.map((entry) => entry.imagePath).sort(),
    baselineEntries.map((entry) => entry.imagePath).sort(),
  )
  for (const entry of generationEntries) {
    const baseline = baselineEntries.find((candidate) => candidate.imagePath === entry.imagePath)
    assert.ok(baseline)
    assert.equal(entry.modelName, baseline.modelName)
    assertVectorsClose(entry.vector, baseline.vector)
  }

  // Freshness signature now hangs on the generation, not the shard mtimes.
  const meta = JSON.parse(
    fs.readFileSync(path.join(mediaDir, 'vectors', 'frame_embedding_index.meta.json'), 'utf-8'),
  )
  assert.match(meta.sourceSignature, /generation:/)
  assert.equal(isFrameIndexFresh(), true)

  // Coverage stats (including the legacy-only frame) stay on the JSONL caliber.
  const generationStats = await getFrameEmbeddingStats()
  assert.equal(generationStats.clipEmbeddedFrames, baselineStats.clipEmbeddedFrames)
  assert.equal(generationStats.dinoEmbeddedFrames, baselineStats.dinoEmbeddedFrames)
  assert.equal(generationStats.missingClipFrames, baselineStats.missingClipFrames)
  assert.deepEqual(generationStats.coverageByDrive, baselineStats.coverageByDrive)

  // findFrameVector resolves from the generation when the compact index is gone.
  invalidateFrameIndex()
  const fromGeneration = findFrameVector(framePaths[0], CLIP)
  assert.ok(fromGeneration)
  const baselineAlpha = baselineEntries.find((entry) => entry.imagePath === framePaths[0])
  assert.ok(baselineAlpha)
  assertVectorsClose(Array.from(fromGeneration), baselineAlpha.vector)
})

test('stale generation falls back to shard-equivalent rebuild on append', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-frame-drift-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { mediaDir, userDataDir, framePaths } = initFixture(root)

  await migrateToGeneration(userDataDir)
  const first = await ensureFrameIndexFreshAsync()
  assert.equal(first.entries, 3)
  assert.equal(isFrameIndexFresh(), true)

  // Append a new frame embedding without re-migrating: the generation is now
  // stale and the read path must fall back to the shard content.
  const newFramePath = path.join(mediaDir, 'frames', 'video-a', 'delta.jpg')
  fs.writeFileSync(newFramePath, 'jpg')
  fs.appendFileSync(
    path.join(mediaDir, 'manifests', 'video_frames.jsonl'),
    `${JSON.stringify({
      frameId: 'frame-delta',
      videoId: 'video-a',
      videoPath: path.join(root, 'fixture.mp4'),
      timestampMs: 4000,
      imagePath: newFramePath,
      status: 'done',
      createdAt: 2,
      updatedAt: 2,
    })}\n`,
  )
  const shardPath = path.join(userDataDir, 'vector-db', 'embeddings', `${CLIP}__global.jsonl`)
  fs.appendFileSync(shardPath, `${JSON.stringify(embeddingRow(newFramePath, unitVector(0, 1)))}\n`)
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(shardPath, future, future)

  assert.equal(isFrameIndexFresh(), false)
  const rebuilt = await ensureFrameIndexFreshAsync()
  assert.equal(rebuilt.rebuilt, true)
  assert.equal(rebuilt.entries, 4)
  assert.equal(rebuilt.errors, 0)

  const index = loadFrameIndex(CLIP)
  assert.equal(index.size, 4)
  assert.ok(index.has(newFramePath))
  assert.ok(findFrameVector(newFramePath, CLIP))
  for (const framePath of framePaths) assert.ok(index.has(framePath))

  // The stale-generation fallback signature matches the shard stats again.
  const meta = JSON.parse(
    fs.readFileSync(path.join(mediaDir, 'vectors', 'frame_embedding_index.meta.json'), 'utf-8'),
  )
  assert.match(meta.sourceSignature, /jsonl:/)
  assert.equal(isFrameIndexFresh(), true)

  const stats = await getFrameEmbeddingStats()
  assert.equal(stats.clipEmbeddedFrames, 4)
  assert.equal(stats.missingClipFrames, 0)
})

test('frame index treats every matching JSONL row as a latest-wins revision and tombstones invalid rows', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-frame-revision-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { mediaDir, userDataDir, framePaths } = initFixture(root)
  const legacyPath = path.join(userDataDir, 'vector-db', 'image_embeddings.jsonl')
  const shardPath = path.join(userDataDir, 'vector-db', 'embeddings', `${CLIP}__global.jsonl`)

  // A same-shard invalid row must remove the prior value rather than retaining it.
  fs.appendFileSync(
    shardPath,
    `${JSON.stringify({ ...embeddingRow(framePaths[0], unitVector(1, 0)), vector: Array(CLIP_DIM).fill(0) })}\n`,
  )
  // A current invalid row also tombstones a valid legacy value; the vector has
  // the right length but intentionally lies about its declared model dimension.
  fs.appendFileSync(
    shardPath,
    `${JSON.stringify({ ...embeddingRow(framePaths[2], unitVector(0.5, 0.5)), dim: 511 })}\n`,
  )
  // A later valid revision repairs an invalid row in the same source.
  fs.appendFileSync(
    shardPath,
    `${JSON.stringify({ ...embeddingRow(framePaths[1], Array(CLIP_DIM).fill(0)) })}\n`,
  )
  fs.appendFileSync(shardPath, `${JSON.stringify(embeddingRow(framePaths[1], unitVector(0, 1)))}\n`)

  const built = buildFrameIndex()
  assert.equal(built.entries, 1)
  assert.ok(built.errors >= 3)
  const entries = readIndexEntries(mediaDir)
  assert.deepEqual(
    entries.map((entry) => entry.imagePath),
    [framePaths[1]],
  )
  assert.equal(entries[0].dim, CLIP_DIM)
  assert.equal(findFrameVector(framePaths[0], CLIP), undefined)
  assert.equal(findFrameVector(framePaths[2], CLIP), undefined)
  assertVectorsClose(Array.from(findFrameVector(framePaths[1], CLIP) || []), unitVector(0, 1))

  // Keep the legacy source explicitly exercised: it must not be reached after
  // the current shard's invalid revision has established a tombstone.
  assert.ok(fs.existsSync(legacyPath))
})

test('frame index readers discard invalid latest index rows instead of reviving earlier entries', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-frame-index-read-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { mediaDir, framePaths } = initFixture(root)
  const indexPath = path.join(mediaDir, 'vectors', 'frame_embedding_index.jsonl')
  fs.mkdirSync(path.dirname(indexPath), { recursive: true })
  writeJsonLines(indexPath, [
    { imagePath: framePaths[0], modelName: CLIP, dim: CLIP_DIM, vector: unitVector(1, 0) },
    // The latest matching canonical key has the right vector length but an
    // invalid declared dimension, so it tombstones the first row.
    { imagePath: framePaths[0], modelName: CLIP, dim: 511, vector: unitVector(1, 0) },
  ])
  assert.equal(loadFrameIndex(CLIP).size, 0)
})

test('v1 frame index metadata forces a v2 rebuild before it can be considered fresh', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-frame-v1-rebuild-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { mediaDir, framePaths } = initFixture(root)
  const vectorsDir = path.join(mediaDir, 'vectors')
  fs.mkdirSync(vectorsDir, { recursive: true })
  // v1 index entries did not declare their vector dimension. Give the v1
  // metadata a plausible signature so only the version gate proves rebuild.
  writeJsonLines(path.join(vectorsDir, 'frame_embedding_index.jsonl'), [
    { imagePath: framePaths[0], modelName: CLIP, vector: unitVector(1, 0) },
  ])
  fs.writeFileSync(
    path.join(vectorsDir, 'frame_embedding_index.meta.json'),
    JSON.stringify({
      version: 1,
      sourceSignature: 'would-have-been-current',
      manifest: { path: 'legacy', signature: 'legacy' },
      stores: [],
      entries: 1,
      errors: 0,
      builtAt: Date.now(),
    }),
  )

  assert.equal(isFrameIndexFresh(), false)
  const rebuilt = await ensureFrameIndexFreshAsync()
  assert.equal(rebuilt.rebuilt, true)
  assert.equal(rebuilt.entries, 3)
  const meta = JSON.parse(
    fs.readFileSync(path.join(vectorsDir, 'frame_embedding_index.meta.json'), 'utf-8'),
  )
  assert.equal(meta.version, 2)
  assert.ok(readIndexEntries(mediaDir).every((entry) => entry.dim === CLIP_DIM))
  assert.equal(isFrameIndexFresh(), true)
})

test('large frame index writes stream incrementally instead of joining all JSON rows', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'mediaSearchFrameIndex.ts'),
    'utf8',
  )
  assert.match(source, /async function writeFrameIndexEntriesAsync/)
  assert.match(source, /await once\(output, 'drain'\)/)
  assert.doesNotMatch(source, /outByKey\.values\(\)\]\.map[\s\S]{0,160}\.join\('\n'\)/)
})

test('JSONL coverage fallback applies canonical latest-wins validation and tombstones', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-frame-coverage-latest-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { userDataDir, framePaths } = initFixture(root)
  const legacyPath = path.join(userDataDir, 'vector-db', 'image_embeddings.jsonl')
  const shardPath = path.join(userDataDir, 'vector-db', 'embeddings', `${CLIP}__global.jsonl`)
  const slashAndCaseVariant = framePaths[0].replace(/\\/g, '/').toUpperCase()

  writeJsonLines(legacyPath, [
    embeddingRow(slashAndCaseVariant, unitVector(1, 0)),
    embeddingRow(framePaths[2], unitVector(0, 1)),
  ])
  writeJsonLines(shardPath, [
    // Current invalid revision tombstones legacy alpha despite slash/case changes.
    { ...embeddingRow(framePaths[0], Array(CLIP_DIM).fill(0)) },
    // Same-shard invalid revision tombstones a prior current beta row.
    embeddingRow(framePaths[1], unitVector(1, 0)),
    { ...embeddingRow(framePaths[1], Array(CLIP_DIM).fill(0)) },
    // A wrong declared dim tombstones legacy gamma, then a later valid row repairs it.
    { ...embeddingRow(framePaths[2], unitVector(1, 0)), dim: CLIP_DIM - 1 },
    embeddingRow(framePaths[2].replace(/\\/g, '/'), unitVector(0, 1)),
  ])

  const embedded = await collectEmbeddedImageIds(CLIP, new Set(framePaths), { useCache: false })
  assert.deepEqual([...embedded], [framePaths[2]])
})

test('frame index and coverage signatures include composite delta state and invalid latest rows', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-frame-composite-freshness-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { userDataDir, framePaths } = initFixture(root)
  const shardPath = path.join(userDataDir, 'vector-db', 'embeddings', `${CLIP}__global.jsonl`)

  await migrateToGeneration(userDataDir)
  const first = await ensureFrameIndexFreshAsync()
  assert.equal(first.entries, 3)
  assert.equal(isFrameIndexFresh(), true)
  assert.equal((await getFrameEmbeddingStats()).clipEmbeddedFrames, 3)
  const before = describeEmbeddingVectorSource(getFrameEmbeddingCacheOptions(CLIP))
  assert.match(before.fingerprint, /^generation:/)

  // The append commits a composite delta. It repairs the existing path and
  // must change a same-generation source fingerprint instead of retaining the
  // old compact index / persisted coverage signature.
  await appendEmbeddingNoUpsertAsync({
    imageId: framePaths[0],
    modelName: CLIP,
    embeddingType: 'global',
    dim: CLIP_DIM,
    vector: unitVector(0, 1),
  })
  const afterDelta = describeEmbeddingVectorSource(getFrameEmbeddingCacheOptions(CLIP))
  assert.match(afterDelta.fingerprint, /^generation:/)
  assert.notEqual(afterDelta.fingerprint, before.fingerprint)
  assert.equal(isFrameIndexFresh(), false)
  assert.equal((await getFrameEmbeddingStats()).clipEmbeddedFrames, 3)
  const rebuiltAfterDelta = await ensureFrameIndexFreshAsync()
  assert.equal(rebuiltAfterDelta.entries, 3)
  assert.equal(isFrameIndexFresh(), true)
  assertVectorsClose(Array.from(findFrameVector(framePaths[0], CLIP) || []), unitVector(0, 1))

  // An uncommitted invalid append makes the composite incomplete. The index
  // and stats must fall back to latest JSONL state, delete alpha, and never
  // serve its older valid row.
  fs.appendFileSync(
    shardPath,
    `${JSON.stringify({ ...embeddingRow(framePaths[0], Array(CLIP_DIM).fill(0)) })}\n`,
  )
  assert.equal(isFrameIndexFresh(), false)
  assert.equal((await getFrameEmbeddingStats()).clipEmbeddedFrames, 2)
  assert.equal(findFrameVector(framePaths[0], CLIP), undefined)

  // A later valid row repairs the tombstone and becomes the only answer.
  fs.appendFileSync(
    shardPath,
    `${JSON.stringify(embeddingRow(framePaths[0].replace(/\\/g, '/'), unitVector(-1, 0)))}\n`,
  )
  assert.equal((await getFrameEmbeddingStats()).clipEmbeddedFrames, 3)
  assertVectorsClose(Array.from(findFrameVector(framePaths[0], CLIP) || []), unitVector(-1, 0))
  const repaired = await ensureFrameIndexFreshAsync()
  assert.equal(repaired.entries, 3)
  assert.equal(isFrameIndexFresh(), true)
  assertVectorsClose(Array.from(findFrameVector(framePaths[0], CLIP) || []), unitVector(-1, 0))
})
