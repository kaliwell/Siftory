const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  JsonLinesStore,
  appendEmbeddingNoUpsertAsync,
  appendGlobalEmbeddingInvalidationTombstonesAsync,
  cropStore,
  colorFeatureStore,
  embeddingStore,
  flushVectorDatabaseWrites,
  getEmbeddingStorePaths,
  getEmbeddingsByModel,
  initVectorDatabase,
  jobStore,
  removeImageDataBatch,
  shapeFeatureStore,
  upsertEmbedding,
} = loadTsModule('electron/vectorDatabaseService.ts')
const cacheApi = loadTsModule('electron/embeddingF16Cache.ts')
const streamApi = loadTsModule('electron/assetEmbeddingStream.ts')

const DINO_MODEL = 'dinov2_vitb14'
const CLIP_MODEL = 'clip_vit_base_patch32'

function embeddingRow(imageId, vector, modelName = DINO_MODEL) {
  return JSON.stringify({ modelName, embeddingType: 'global', imageId, dim: vector.length, vector })
}

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'floating-clock-vector-store-'))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('JsonLinesStore keeps valid rows and reports malformed rows', async () => {
  await withTempDir(async (dir) => {
    const storePath = path.join(dir, 'records.jsonl')
    await fs.writeFile(storePath, '{"id":1,"value":"a"}\nnot-json\n{"id":2,"value":"b"}\n')
    const store = new JsonLinesStore('records.jsonl', () => dir)

    assert.deepEqual(store.getAll(), [
      { id: 1, value: 'a' },
      { id: 2, value: 'b' },
    ])
    assert.equal(store.getPersistenceStatus().corruptedRows, 1)
    assert.equal(store.getPersistenceStatus().readOnly, true)
    assert.throws(() => store.insert({ value: 'blocked' }), /writing is disabled/i)

    const report = await fs.readFile(`${storePath}.corruptions.jsonl`, 'utf8')
    const row = JSON.parse(report.trim())
    assert.equal(row.lineNumber, 2)
    assert.equal(row.raw, 'not-json')
  })
})

test('JsonLinesStore unique index provides stable point lookups across mutations', async () => {
  await withTempDir(async (dir) => {
    let selectorCalls = 0
    const store = new JsonLinesStore('records.jsonl', () => dir, {
      uniqueKey: (record) => {
        selectorCalls += 1
        return record.key
      },
    })
    const first = store.insert({ key: 'a', value: 1 })
    store.insert({ key: 'b', value: 2 })

    assert.equal(store.getByUniqueKey('b').value, 2)
    const callsAfterBuild = selectorCalls
    for (let index = 0; index < 100; index++) {
      assert.equal(store.getByUniqueKey('b').value, 2)
    }
    assert.equal(selectorCalls, callsAfterBuild, 'hot lookups must not rescan every record')

    store.update(first.id, { key: 'renamed', value: 3 })
    assert.equal(store.getByUniqueKey('a'), undefined)
    assert.equal(store.getByUniqueKey('renamed').value, 3)
    store.deleteWhere((record) => record.key === 'b')
    assert.equal(store.getByUniqueKey('b'), undefined)
    await store.flush()
  })
})

test('JsonLinesStore recovers its write queue and persists the full snapshot', async () => {
  await withTempDir(async (dir) => {
    const storePath = path.join(dir, 'records.jsonl')
    const store = new JsonLinesStore('records.jsonl', () => dir)
    assert.deepEqual(store.getAll(), [])
    await fs.mkdir(storePath)

    store.insert({ value: 'first' })
    await assert.rejects(store.flush())
    assert.ok(store.getPersistenceStatus().lastWriteError)

    await fs.rm(storePath, { recursive: true, force: true })
    store.insert({ value: 'second' })
    await store.flush()

    const rows = (await fs.readFile(storePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(
      rows.map((row) => row.value),
      ['first', 'second'],
    )
    assert.equal(store.getPersistenceStatus().lastWriteError, undefined)
    assert.equal(store.getPersistenceStatus().pendingWrites, 0)
  })
})

test('JsonLinesStore fails closed when an existing store cannot be read', async () => {
  await withTempDir(async (dir) => {
    const storePath = path.join(dir, 'records.jsonl')
    await fs.mkdir(storePath)
    const store = new JsonLinesStore('records.jsonl', () => dir)

    assert.throws(() => store.getAll(), /is unavailable and cannot be modified/i)
    assert.throws(() => store.insert({ value: 'blocked' }), /is unavailable/i)
    assert.throws(() => store.replaceAll([{ value: 'blocked' }]), /is unavailable/i)
    assert.throws(() => store.clear(), /is unavailable/i)
    assert.equal(store.getPersistenceStatus().readOnly, true)
    assert.match(store.getPersistenceStatus().unavailableError, /Could not read/i)
    assert.equal((await fs.stat(storePath)).isDirectory(), true)
  })
})

test('JsonLinesStore snapshots queued full saves', async () => {
  await withTempDir(async (dir) => {
    const store = new JsonLinesStore('records.jsonl', () => dir)
    const first = store.insert({ value: 'first' })
    store.update(first.id, { value: 'updated' })
    await store.flush()

    const rows = (await fs.readFile(path.join(dir, 'records.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(rows, [{ id: first.id, value: 'updated' }])
  })
})

test('JsonLinesStore replaceAll preserves ids and assigns new ids once', async () => {
  await withTempDir(async (dir) => {
    const store = new JsonLinesStore('records.jsonl', () => dir)
    const rows = store.replaceAll([{ id: 8, value: 'existing' }, { value: 'new' }])
    await store.flush()

    assert.equal(rows[0].id, 8)
    assert.equal(rows[1].id, 9)
    const persisted = (await fs.readFile(path.join(dir, 'records.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(persisted, rows)
  })
})

test('JsonLinesStore flags over-long lines as corruptions on load', async () => {
  await withTempDir(async (dir) => {
    const storePath = path.join(dir, 'records.jsonl')
    const longLine = JSON.stringify({ id: 2, value: 'x'.repeat(4096) })
    await fs.writeFile(storePath, `{"id":1,"value":"a"}\n${longLine}\n`)
    const store = new JsonLinesStore('records.jsonl', () => dir, { maxLineBytes: 1024 })

    assert.deepEqual(store.getAll(), [{ id: 1, value: 'a' }])
    assert.equal(store.getPersistenceStatus().corruptedRows, 1)
    assert.throws(() => store.insert({ value: 'blocked' }), /writing is disabled/i)
  })
})

test('JsonLinesStore fails closed when the file exceeds maxFileBytes', async () => {
  await withTempDir(async (dir) => {
    const storePath = path.join(dir, 'records.jsonl')
    await fs.writeFile(storePath, `{"id":1,"value":"${'x'.repeat(2048)}"}\n`)
    const store = new JsonLinesStore('records.jsonl', () => dir, { maxFileBytes: 1024 })

    assert.throws(() => store.getAll(), /unavailable/i)
    assert.match(store.getPersistenceStatus().unavailableError, /maxFileBytes/)
  })
})

test('JsonLinesStore fails closed when records exceed maxRecords on load', async () => {
  await withTempDir(async (dir) => {
    const storePath = path.join(dir, 'records.jsonl')
    await fs.writeFile(
      storePath,
      '{"id":1,"value":"a"}\n{"id":2,"value":"b"}\n{"id":3,"value":"c"}\n',
    )
    const store = new JsonLinesStore('records.jsonl', () => dir, { maxRecords: 2 })

    assert.throws(() => store.getAll(), /unavailable/i)
    assert.match(store.getPersistenceStatus().unavailableError, /maxRecords/)
  })
})

test('JsonLinesStore validate hook flags bad rows on load and rejects on write', async () => {
  await withTempDir(async (dir) => {
    const storePath = path.join(dir, 'records.jsonl')
    await fs.writeFile(storePath, '{"id":1,"value":"ok"}\n{"id":2}\n')
    const validate = (record) => (typeof record?.value === 'string' ? null : 'value is required')
    const store = new JsonLinesStore('records.jsonl', () => dir, { validate })

    assert.deepEqual(store.getAll(), [{ id: 1, value: 'ok' }])
    assert.equal(store.getPersistenceStatus().corruptedRows, 1)

    const cleanStore = new JsonLinesStore('clean.jsonl', () => dir, { validate })
    assert.throws(() => cleanStore.insert({ note: 'no value' }), /value is required/)
    const good = cleanStore.insert({ value: 'fine' })
    assert.equal(good.id, 1)
  })
})

test('JsonLinesStore rejects writes that exceed capacity limits', async () => {
  await withTempDir(async (dir) => {
    const store = new JsonLinesStore('records.jsonl', () => dir, {
      maxRecords: 2,
      maxLineBytes: 256,
    })
    store.insert({ value: 'a' })
    store.insert({ value: 'b' })
    assert.throws(() => store.insert({ value: 'c' }), /maxRecords/)
    assert.throws(
      () => store.replaceAll([{ value: 'a' }, { value: 'b' }, { value: 'c' }]),
      /maxRecords/,
    )
    assert.throws(() => store.insert({ value: 'x'.repeat(1024) }), /maxLineBytes/)
    assert.equal(store.count(), 2)
  })
})

test('embedding upsert rejects invalid vectors and known-model dimension lies before mutation', async () => {
  await withTempDir(async (dir) => {
    initVectorDatabase(dir)
    const valid = {
      imageId: 'C:\\images\\valid.jpg',
      modelName: 'fixture_model',
      modelVersion: '1',
      embeddingType: 'global',
      dim: 3,
      vector: [1, 0, 0],
      norm: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    upsertEmbedding(valid)
    await flushVectorDatabaseWrites()
    assert.equal(getEmbeddingsByModel('fixture_model', 'global').length, 1)
    for (const vector of [
      [0, 0, 0],
      [1, null, 0],
      [1, 0],
      [1, 0, 0, 0],
    ]) {
      assert.throws(
        () => upsertEmbedding({ ...valid, imageId: `bad-${vector.length}`, vector }),
        /Invalid embedding vector/,
      )
    }
    assert.throws(
      () => upsertEmbedding({ ...valid, modelName: 'clip_vit_base_patch32' }),
      /does not match.*capability/,
    )
    await flushVectorDatabaseWrites()
    assert.equal(getEmbeddingsByModel('fixture_model', 'global').length, 1)
    assert.equal(getEmbeddingsByModel('clip_vit_base_patch32', 'global').length, 0)
  })
})

test('global embedding tombstones append once per shard and invalidate latest F16 rows', async () => {
  await withTempDir(async (dir) => {
    const embeddingsDir = path.join(dir, 'vector-db', 'embeddings')
    const cacheDir = path.join(dir, 'vector-db', 'embedding-cache')
    await fs.mkdir(embeddingsDir, { recursive: true })
    const dinoPath = path.join(embeddingsDir, `${DINO_MODEL}__global.jsonl`)
    const clipPath = path.join(embeddingsDir, `${CLIP_MODEL}__global.jsonl`)
    const first = 'C:\\Images\\delete-first.jpg'
    const second = 'C:\\Images\\delete-second.jpg'
    const keep = 'C:\\Images\\keep.jpg'
    const sourceRows = [
      embeddingRow(first, [1, 0, 0]),
      embeddingRow(second, [0, 1, 0]),
      embeddingRow(keep, [0, 0, 1]),
    ]
    const originalDino = `${sourceRows.join('\n')}\n`
    const originalClip = `${[
      embeddingRow(first, [1, 0, 0], CLIP_MODEL),
      embeddingRow(second, [0, 1, 0], CLIP_MODEL),
      embeddingRow(keep, [0, 0, 1], CLIP_MODEL),
    ].join('\n')}\n`
    await fs.writeFile(dinoPath, originalDino)
    await fs.writeFile(clipPath, originalClip)
    initVectorDatabase(dir)

    const cacheOptions = {
      cacheDir,
      modelName: DINO_MODEL,
      embeddingType: 'global',
      dim: 3,
      sourcePaths: [dinoPath],
      preferAuthoritative: false,
    }
    const initialCache = await cacheApi.ensureEmbeddingF16Cache(cacheOptions)
    assert.equal(initialCache.meta.count, 3)
    const incrementRoot = path.join(dir, 'vector-db', 'vector-store', 'incremental')
    const dinoIncrement = path.join(incrementRoot, `${DINO_MODEL}__global`)
    const clipIncrement = path.join(incrementRoot, `${CLIP_MODEL}__global`)
    const dinoMeta = path.join(cacheDir, `${DINO_MODEL}__global.f16.json`)
    const clipMeta = path.join(cacheDir, `${CLIP_MODEL}__global.f16.json`)
    await fs.mkdir(dinoIncrement, { recursive: true })
    await fs.mkdir(clipIncrement, { recursive: true })
    await fs.writeFile(path.join(dinoIncrement, 'delta.json'), '{}')
    await fs.writeFile(path.join(clipIncrement, 'delta.json'), '{}')
    await fs.writeFile(clipMeta, '{}')

    const originalAppendFile = fs.appendFile
    const appendCalls = []
    fs.appendFile = async (...args) => {
      appendCalls.push({ filePath: String(args[0]), payload: String(args[1]) })
      return originalAppendFile(...args)
    }
    let result
    try {
      result = await appendGlobalEmbeddingInvalidationTombstonesAsync(
        [first, 'c:/images/delete-first.jpg', second, second, ''],
        ['dino', 'clip', 'dino'],
      )
    } finally {
      fs.appendFile = originalAppendFile
    }

    assert.equal(result.requestedPaths, 5)
    assert.equal(result.uniquePaths, 2)
    assert.equal(result.appendedRows, 4)
    assert.equal(result.shards.length, 2)
    assert.deepEqual(
      result.shards.map((shard) => shard.modelName),
      [DINO_MODEL, CLIP_MODEL],
    )
    assert.equal(appendCalls.length, 2, 'this fixture fits in one bounded append per shard')
    assert.equal(
      result.appendedBytes,
      appendCalls.reduce((sum, call) => sum + Buffer.byteLength(call.payload), 0),
    )

    for (const [filePath, original] of [
      [dinoPath, originalDino],
      [clipPath, originalClip],
    ]) {
      const persisted = await fs.readFile(filePath, 'utf8')
      assert.equal(persisted.startsWith(original), true, 'the multi-GB shard must not be rewritten')
      const appended = persisted.slice(original.length).trim().split('\n').map(JSON.parse)
      assert.equal(appended.length, 2)
      assert.deepEqual(
        appended.map((entry) => streamApi.embeddingPathKey(entry.imageId)),
        [streamApi.embeddingPathKey(first), streamApi.embeddingPathKey(second)],
      )
      assert.equal(
        appended.every((entry) => entry.invalid === true),
        true,
      )
      assert.equal(
        appended.every((entry) => !('vector' in entry) && !('dim' in entry)),
        true,
      )
    }
    await assert.rejects(
      fs.stat(path.join(dir, 'vector-db', 'image_embeddings.jsonl')),
      /ENOENT/,
      'global invalidation must not create or rewrite the legacy store',
    )
    await assert.rejects(fs.stat(dinoIncrement), /ENOENT/)
    await assert.rejects(fs.stat(clipIncrement), /ENOENT/)
    await assert.rejects(fs.stat(dinoMeta), /ENOENT/)
    await assert.rejects(fs.stat(clipMeta), /ENOENT/)

    assert.equal(cacheApi.readExistingEmbeddingF16Cache(cacheOptions), null)
    assert.equal(cacheApi.readFreshEmbeddingF16Cache(cacheOptions), null)
    const rebuilt = await cacheApi.ensureEmbeddingF16Cache(cacheOptions)
    assert.equal(rebuilt.meta.count, 1)
    const vectors = await cacheApi.readEmbeddingF16VectorsForPaths(rebuilt, [first, second, keep])
    assert.equal(vectors.has(streamApi.embeddingPathKey(first)), false)
    assert.equal(vectors.has(streamApi.embeddingPathKey(second)), false)
    assert.equal(vectors.has(streamApi.embeddingPathKey(keep)), true)

    const streamedClipPaths = []
    await streamApi.streamAssetEmbeddingsFromPaths({
      modelName: CLIP_MODEL,
      expectedDim: 3,
      sourcePaths: [clipPath],
      onEntry: (entry) => streamedClipPaths.push(entry.imageId),
    })
    assert.deepEqual(streamedClipPaths, [keep])
  })
})

test('global tombstones share the async embedding append chain', async () => {
  await withTempDir(async (dir) => {
    const embeddingsDir = path.join(dir, 'vector-db', 'embeddings')
    await fs.mkdir(embeddingsDir, { recursive: true })
    const dinoPath = path.join(embeddingsDir, `${DINO_MODEL}__global.jsonl`)
    const clipPath = path.join(embeddingsDir, `${CLIP_MODEL}__global.jsonl`)
    const target = 'C:\\Images\\concurrent-delete.jpg'
    const vector = Array(768).fill(0)
    vector[0] = 1
    await fs.writeFile(dinoPath, `${embeddingRow(target, vector)}\n`)
    initVectorDatabase(dir)
    const staleClipIncrement = path.join(
      dir,
      'vector-db',
      'vector-store',
      'incremental',
      `${CLIP_MODEL}__global`,
    )
    const staleClipMeta = path.join(
      dir,
      'vector-db',
      'embedding-cache',
      `${CLIP_MODEL}__global.f16.json`,
    )
    await fs.mkdir(staleClipIncrement, { recursive: true })
    await fs.mkdir(path.dirname(staleClipMeta), { recursive: true })
    await fs.writeFile(path.join(staleClipIncrement, 'delta.json'), '{}')
    await fs.writeFile(staleClipMeta, '{}')

    const originalAppendFile = fs.appendFile
    const appendCalls = []
    let releaseFirstWrite
    const firstWriteBlocked = new Promise((resolve) => {
      releaseFirstWrite = resolve
    })
    let markFirstWriteEntered
    const firstWriteEntered = new Promise((resolve) => {
      markFirstWriteEntered = resolve
    })
    fs.appendFile = async (...args) => {
      appendCalls.push({ filePath: String(args[0]), payload: String(args[1]) })
      if (appendCalls.length === 1) {
        markFirstWriteEntered()
        await firstWriteBlocked
      }
      return originalAppendFile(...args)
    }

    let embeddingAppend
    let tombstoneAppend
    let tombstoneResult
    try {
      embeddingAppend = appendEmbeddingNoUpsertAsync({
        imageId: target,
        modelName: DINO_MODEL,
        modelVersion: 'fixture',
        embeddingType: 'global',
        dim: vector.length,
        vector,
        norm: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      await firstWriteEntered
      tombstoneAppend = appendGlobalEmbeddingInvalidationTombstonesAsync(
        [target, 'c:/images/concurrent-delete.jpg'],
        ['dino', 'clip'],
      )
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(
        appendCalls.length,
        1,
        'the tombstone append must wait behind an accepted embedding append',
      )
      releaseFirstWrite()
      ;[, tombstoneResult] = await Promise.all([embeddingAppend, tombstoneAppend])
    } finally {
      releaseFirstWrite?.()
      await Promise.allSettled([embeddingAppend, tombstoneAppend].filter(Boolean))
      fs.appendFile = originalAppendFile
    }

    assert.equal(tombstoneResult.uniquePaths, 1)
    assert.equal(tombstoneResult.appendedRows, 2)
    assert.equal(appendCalls.length, 3)
    const rows = (await fs.readFile(dinoPath, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(rows.length, 3)
    assert.equal(rows.at(-1).invalid, true)
    assert.equal(rows.at(-1).imageId, target)
    const clipRows = (await fs.readFile(clipPath, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(clipRows.length, 1, 'a missing current shard must be created for the tombstone')
    assert.equal(clipRows[0].invalid, true)
    assert.equal(clipRows[0].imageId, target)
    await assert.rejects(fs.stat(staleClipIncrement), /ENOENT/)
    await assert.rejects(fs.stat(staleClipMeta), /ENOENT/)

    const streamed = []
    const summary = await streamApi.streamAssetEmbeddingsFromPaths({
      modelName: DINO_MODEL,
      expectedDim: vector.length,
      sourcePaths: [dinoPath],
      onEntry: (entry) => streamed.push(entry),
    })
    assert.equal(summary.scanned, 0)
    assert.deepEqual(streamed, [])
  })
})

test('flush waits for an accepted tombstone append instead of only JsonLines stores', async () => {
  await withTempDir(async (dir) => {
    const shard = path.join(dir, 'vector-db', 'embeddings', `${DINO_MODEL}__global.jsonl`)
    await fs.mkdir(path.dirname(shard), { recursive: true })
    await fs.writeFile(shard, '')
    initVectorDatabase(dir)

    const originalAppendFile = fs.appendFile
    let releaseAppend
    let markAppendEntered
    const appendEntered = new Promise((resolve) => {
      markAppendEntered = resolve
    })
    const appendBlocked = new Promise((resolve) => {
      releaseAppend = resolve
    })
    fs.appendFile = async (...args) => {
      markAppendEntered()
      await appendBlocked
      return originalAppendFile(...args)
    }

    let tombstoneWrite
    let flush
    try {
      tombstoneWrite = appendGlobalEmbeddingInvalidationTombstonesAsync(
        ['C:\\Images\\flush-barrier.jpg'],
        ['dino'],
      )
      await appendEntered
      let flushSettled = false
      flush = flushVectorDatabaseWrites().then(() => {
        flushSettled = true
      })
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(flushSettled, false, 'flush must remain behind the blocked append chain')
      releaseAppend()
      await Promise.all([tombstoneWrite, flush])
      assert.equal(flushSettled, true)
    } finally {
      releaseAppend?.()
      await Promise.allSettled([tombstoneWrite, flush].filter(Boolean))
      fs.appendFile = originalAppendFile
    }
  })
})

test('canonical legacy cleanup removes aliases from embeddings, jobs, crops and features', async () => {
  await withTempDir(async (dir) => {
    const vectorDir = path.join(dir, 'vector-db')
    const storedPath = 'C:\\Images\\Legacy-Alias.JPG'
    const requestedPath = 'c:/images/legacy-alias.jpg'
    await fs.mkdir(vectorDir, { recursive: true })
    await Promise.all([
      fs.writeFile(
        path.join(vectorDir, 'image_embeddings.jsonl'),
        `${embeddingRow(storedPath, [1, 0, 0])}\n`,
      ),
      fs.writeFile(
        path.join(vectorDir, 'embedding_jobs.jsonl'),
        `${JSON.stringify({ imageId: 'legacy-job', path: storedPath })}\n`,
      ),
      fs.writeFile(
        path.join(vectorDir, 'object_crops.jsonl'),
        `${JSON.stringify({ imageId: storedPath })}\n`,
      ),
      fs.writeFile(
        path.join(vectorDir, 'image_color_features.jsonl'),
        `${JSON.stringify({ imageId: storedPath })}\n`,
      ),
      fs.writeFile(
        path.join(vectorDir, 'image_shape_features.jsonl'),
        `${JSON.stringify({ imageId: storedPath })}\n`,
      ),
    ])
    initVectorDatabase(dir)

    assert.equal(removeImageDataBatch([requestedPath]), 5)
    await flushVectorDatabaseWrites()
    assert.equal(embeddingStore.getAll().length, 0)
    assert.equal(jobStore.getAll().length, 0)
    assert.equal(cropStore.getAll().length, 0)
    assert.equal(colorFeatureStore.getAll().length, 0)
    assert.equal(shapeFeatureStore.getAll().length, 0)
  })
})

test('a tombstone-only current shard masks an equivalent legacy path', async () => {
  await withTempDir(async (dir) => {
    const vectorDir = path.join(dir, 'vector-db')
    const cacheDir = path.join(vectorDir, 'embedding-cache')
    const storedPath = 'C:\\Images\\Legacy-Only.JPG'
    const requestedPath = 'c:/images/legacy-only.jpg'
    await fs.mkdir(vectorDir, { recursive: true })
    await fs.writeFile(
      path.join(vectorDir, 'image_embeddings.jsonl'),
      `${embeddingRow(storedPath, [1, 0, 0])}\n`,
    )
    initVectorDatabase(dir)

    const invalidated = await appendGlobalEmbeddingInvalidationTombstonesAsync(
      [requestedPath],
      ['dino'],
    )
    assert.equal(invalidated.appendedRows, 1)
    const sourcePaths = getEmbeddingStorePaths(DINO_MODEL, 'global')
    assert.deepEqual(
      sourcePaths.map((sourcePath) => path.basename(sourcePath)),
      ['image_embeddings.jsonl', `${DINO_MODEL}__global.jsonl`],
    )
    const rebuilt = await cacheApi.ensureEmbeddingF16Cache({
      cacheDir,
      modelName: DINO_MODEL,
      embeddingType: 'global',
      dim: 3,
      sourcePaths,
      preferAuthoritative: false,
    })
    assert.ok(rebuilt)
    assert.equal(rebuilt.meta.count, 0)
    assert.deepEqual(cacheApi.readEmbeddingF16CachePaths(rebuilt), [])
  })
})

test('a later bounded append failure reports completed tombstone chunks for idempotent retry', async () => {
  await withTempDir(async (dir) => {
    const shard = path.join(dir, 'vector-db', 'embeddings', `${DINO_MODEL}__global.jsonl`)
    await fs.mkdir(path.dirname(shard), { recursive: true })
    await fs.writeFile(shard, '')
    initVectorDatabase(dir)
    const paths = Array.from(
      { length: 280 },
      (_, index) => `C:\\partial-${index}-${'x'.repeat(31_000)}`,
    )
    const originalAppendFile = fs.appendFile
    let appendCalls = 0
    fs.appendFile = async (...args) => {
      appendCalls += 1
      if (appendCalls === 2) throw new Error('simulated second tombstone chunk failure')
      return originalAppendFile(...args)
    }
    let observedError
    try {
      await appendGlobalEmbeddingInvalidationTombstonesAsync(paths, ['dino'])
    } catch (error) {
      observedError = error
    } finally {
      fs.appendFile = originalAppendFile
    }

    assert.equal(observedError?.name, 'GlobalEmbeddingInvalidationError')
    const persistedLines = (await fs.readFile(shard, 'utf8')).split('\n').filter(Boolean)
    assert.ok(persistedLines.length > 0 && persistedLines.length < paths.length)
    assert.equal(observedError.result.appendedRows, persistedLines.length)
    assert.equal(observedError.result.appendedBytes, (await fs.stat(shard)).size)

    const retried = await appendGlobalEmbeddingInvalidationTombstonesAsync(paths, ['dino'])
    assert.equal(retried.appendedRows, paths.length)
    assert.equal(
      (await fs.readFile(shard, 'utf8')).split('\n').filter(Boolean).length,
      persistedLines.length + paths.length,
    )
  })
})
