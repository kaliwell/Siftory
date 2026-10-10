const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const cacheApi = loadTsModule('electron/embeddingF16Cache.ts')

function row(imageId, vector, modelName = 'dinov2_vitb14') {
  return JSON.stringify({ modelName, embeddingType: 'global', imageId, dim: vector.length, vector })
}

test('Float16 conversion preserves representative values', () => {
  for (const value of [0, 1, -1, 0.5, -0.125, 0.0001, 10, 65504]) {
    const restored = cacheApi.float16ToFloat32(cacheApi.float32ToFloat16(value))
    assert.ok(Math.abs(restored - value) <= Math.max(0.00001, Math.abs(value) * 0.001))
  }
})

test('cache uses latest path row and rebuilds after source change', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-f16-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'dinov2.jsonl')
  const cacheDir = path.join(root, 'cache')
  fs.writeFileSync(
    source,
    [
      row('C:\\images\\a.jpg', [1, 0, 0]),
      row('C:\\images\\b.jpg', [0, 0, 2]),
      row('C:\\images\\a.jpg', [0, 3, 0]),
      row('C:\\images\\ignored.jpg', [1, 1, 1], 'clip_vit_base_patch32'),
      '{bad-json',
    ].join('\n'),
  )
  const options = {
    cacheDir,
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    dim: 3,
    sourcePaths: [source],
  }
  const first = await cacheApi.ensureEmbeddingF16Cache(options)
  assert.equal(first.meta.count, 2)
  assert.equal(first.meta.sourceRecordCount, 3)
  assert.equal(fs.statSync(first.vectorPath).size, 12)
  assert.equal(fs.readdirSync(cacheDir).filter((name) => name.includes('.tmp')).length, 0)

  const vectors = await cacheApi.readEmbeddingF16VectorsForPaths(first, [
    'c:/images/a.jpg',
    'C:\\images\\b.jpg',
  ])
  assert.deepEqual([...vectors.get('c:\\images\\a.jpg')].map(Math.round), [0, 1, 0])
  assert.deepEqual([...vectors.get('c:\\images\\b.jpg')].map(Math.round), [0, 0, 1])
  const streamed = []
  await cacheApi.streamEmbeddingF16Cache(first, {
    onVector: (filePath, vector, cacheRow) => {
      streamed.push({ filePath, vector: [...vector], cacheRow })
    },
  })
  assert.deepEqual(
    streamed.map((item) => [item.filePath, item.vector.map(Math.round), item.cacheRow]),
    [
      ['C:\\images\\b.jpg', [0, 0, 1], 0],
      ['C:\\images\\a.jpg', [0, 1, 0], 1],
    ],
  )
  assert.equal(
    (await cacheApi.ensureEmbeddingF16Cache(options)).meta.updatedAt,
    first.meta.updatedAt,
  )

  fs.appendFileSync(source, `\n${row('C:\\images\\c.jpg', [1, 1, 0])}\n`)
  const future = new Date(Date.now() + 2000)
  fs.utimesSync(source, future, future)
  const staleButComplete = cacheApi.readExistingEmbeddingF16Cache(options)
  assert.ok(staleButComplete)
  assert.equal(staleButComplete.meta.count, 2)
  assert.equal((await cacheApi.ensureEmbeddingF16Cache(options)).meta.count, 3)
})

test('cancelled build removes temporary files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-f16-cancel-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'dinov2.jsonl')
  const cacheDir = path.join(root, 'cache')
  fs.writeFileSync(source, row('C:\\images\\a.jpg', [1, 0, 0]))
  await assert.rejects(
    cacheApi.ensureEmbeddingF16Cache({
      cacheDir,
      modelName: 'dinov2_vitb14',
      dim: 3,
      sourcePaths: [source],
      isCancelled: () => true,
    }),
    /cancelled/,
  )
  assert.deepEqual(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [], [])
})

test('cache metadata invalidation cancels an older in-flight build epoch', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-f16-epoch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'dinov2.jsonl')
  const cacheDir = path.join(root, 'cache')
  fs.writeFileSync(
    source,
    Array.from({ length: 8_000 }, (_, index) =>
      row(`C:\\images\\epoch-${index}.jpg`, [1, index % 2, 0]),
    ).join('\n'),
  )
  let markBuildStarted
  const buildStarted = new Promise((resolve) => {
    markBuildStarted = resolve
  })
  const options = {
    cacheDir,
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    dim: 3,
    sourcePaths: [source],
  }
  const staleBuild = cacheApi.ensureEmbeddingF16Cache({
    ...options,
    onProgress: (progress) => {
      if (progress.phase === 'building') markBuildStarted()
    },
  })
  const staleBuildResult = staleBuild.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  )
  await buildStarted
  await cacheApi.invalidateEmbeddingF16CacheMetadata(cacheDir, 'dinov2_vitb14', 'global')
  const stale = await staleBuildResult
  assert.equal(stale.ok, false)
  assert.match(String(stale.error), /cancelled/)
  assert.equal(cacheApi.readExistingEmbeddingF16Cache(options), null)
  assert.equal(fs.existsSync(path.join(cacheDir, 'dinov2_vitb14__global.f16.json')), false)

  const rebuilt = await cacheApi.ensureEmbeddingF16Cache(options)
  assert.equal(rebuilt.meta.count, 8_000)
})

test('Float16 search returns deterministic top-K results and supports cancellation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-f16-search-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'dinov2.jsonl')
  const cacheDir = path.join(root, 'cache')
  fs.writeFileSync(
    source,
    [
      row('C:\\images\\same.jpg', [1, 0, 0]),
      row('C:\\images\\near.jpg', [0.8, 0.2, 0]),
      row('C:\\images\\orthogonal.jpg', [0, 1, 0]),
      row('C:\\images\\opposite.jpg', [-1, 0, 0]),
    ].join('\n'),
  )
  const cache = await cacheApi.ensureEmbeddingF16Cache({
    cacheDir,
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    dim: 3,
    sourcePaths: [source],
  })

  const first = await cacheApi.searchEmbeddingF16Cache(cache, {
    queryVector: [1, 0, 0],
    topK: 2,
  })
  const second = await cacheApi.searchEmbeddingF16Cache(cache, {
    queryVector: [1, 0, 0],
    topK: 2,
  })
  assert.deepEqual(
    first.map((item) => item.path),
    ['C:\\images\\same.jpg', 'C:\\images\\near.jpg'],
  )
  assert.deepEqual(second, first)
  assert.ok(first[0].score > first[1].score)

  let checks = 0
  await assert.rejects(
    cacheApi.searchEmbeddingF16Cache(cache, {
      queryVector: [1, 0, 0],
      topK: 2,
      isCancelled: () => ++checks > 1,
    }),
    /cancelled/,
  )

  for (const invalidQuery of [
    [1, 0],
    [1, 0, 0, 0],
    [0, 0, 0],
    [1, Number.NaN, 0],
    [1, null, 0],
    [1, Number.POSITIVE_INFINITY, 0],
  ]) {
    await assert.rejects(
      cacheApi.searchEmbeddingF16Cache(cache, { queryVector: invalidQuery, topK: 2 }),
      /Invalid embedding vector/,
    )
  }
})

test('latest invalid rows tombstone older vectors across casing, slashes, and source shards', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-f16-tombstone-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const legacy = path.join(root, 'legacy.jsonl')
  const current = path.join(root, 'current.jsonl')
  const cacheDir = path.join(root, 'cache')
  fs.writeFileSync(
    legacy,
    [row('C:\\Images\\A.jpg', [1, 0, 0]), row('C:\\Images\\B.jpg', [0, 1, 0])].join('\n'),
  )
  fs.writeFileSync(
    current,
    [
      JSON.stringify({
        modelName: 'dinov2_vitb14',
        embeddingType: 'global',
        imageId: 'c:/images/a.jpg',
        dim: 999,
        vector: [1, 0, 0],
      }),
      JSON.stringify({
        modelName: 'dinov2_vitb14',
        embeddingType: 'global',
        imageId: 'C:\\Images\\bad-null.jpg',
        dim: 3,
        vector: [1, null, 0],
      }),
    ].join('\n'),
  )
  const options = {
    cacheDir,
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    dim: 3,
    sourcePaths: [legacy, current],
    preferAuthoritative: false,
  }
  const tombstoned = await cacheApi.ensureEmbeddingF16Cache(options)
  assert.equal(tombstoned.meta.count, 1)
  assert.equal(
    (await cacheApi.readEmbeddingF16VectorsForPaths(tombstoned, ['C:\\images\\a.jpg'])).size,
    0,
  )

  fs.appendFileSync(current, `\n${row('c:/IMAGES/a.jpg', [0, 0, 2])}`)
  const future = new Date(Date.now() + 2000)
  fs.utimesSync(current, future, future)
  const repaired = await cacheApi.ensureEmbeddingF16Cache(options)
  assert.equal(repaired.meta.count, 2)
  assert.deepEqual(
    [...(await cacheApi.readEmbeddingF16VectorsForPaths(repaired, ['C:\\images\\a.jpg'])).keys()],
    ['c:\\images\\a.jpg'],
  )
})

test('derived cache schema v1 is rejected after strict vector validation semantics changed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-f16-version-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source.jsonl')
  const cacheDir = path.join(root, 'cache')
  fs.writeFileSync(source, row('C:\\images\\a.jpg', [1, 0, 0]))
  const options = {
    cacheDir,
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    dim: 3,
    sourcePaths: [source],
    preferAuthoritative: false,
  }
  await cacheApi.ensureEmbeddingF16Cache(options)
  const metaPath = path.join(cacheDir, 'dinov2_vitb14__global.f16.json')
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  meta.version = 1
  fs.writeFileSync(metaPath, JSON.stringify(meta))
  assert.equal(cacheApi.readExistingEmbeddingF16Cache(options), null)
})
