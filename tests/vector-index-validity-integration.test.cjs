const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { loadTsModule } = require('./guard-utils.cjs')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-index-validity-'))
const userDataPath = path.join(tempRoot, 'user-data')
const originalModuleLoad = Module._load

Module._load = function loadWithElectronMock(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath: () => userDataPath,
      },
    }
  }
  return originalModuleLoad.call(this, request, parent, isMain)
}

const vectorDb = loadTsModule('electron/vectorDatabaseService.ts')
const vectorIndex = loadTsModule('electron/vectorIndexService.ts')
Module._load = originalModuleLoad

vectorDb.initVectorDatabase(userDataPath)

test.after(() => {
  Module._load = originalModuleLoad
  vectorIndex.clearVectorIndex()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function basis(dim, dimension, value = 1) {
  const vector = new Array(dim).fill(0)
  vector[dimension] = value
  return vector
}

function embeddingRow(modelName, imageId, vector, dim = vector.length) {
  return JSON.stringify({
    modelName,
    modelVersion: 'fixture-v1',
    embeddingType: 'global',
    imageId,
    dim,
    vector,
    norm: 1,
    createdAt: 1,
    updatedAt: 1,
  })
}

function writeStores(modelName, legacyRows, shardRows) {
  const dbDir = path.join(userDataPath, 'vector-db')
  const legacyPath = path.join(dbDir, 'image_embeddings.jsonl')
  const shardPath = path.join(dbDir, 'embeddings', `${modelName}__global.jsonl`)
  fs.mkdirSync(path.dirname(shardPath), { recursive: true })
  fs.writeFileSync(legacyPath, `${legacyRows.join('\n')}\n`, 'utf8')
  fs.writeFileSync(shardPath, `${shardRows.join('\n')}\n`, 'utf8')
  return { legacyPath, shardPath }
}

function searchRequest(modelName, queryVector) {
  return {
    queryVector,
    topK: 20,
    modelName,
    embeddingType: 'global',
  }
}

function hostileQueries(dim) {
  const withNull = basis(dim, 0)
  withNull[1] = null
  const withString = basis(dim, 0)
  withString[1] = '1'
  const withNan = basis(dim, 0)
  withNan[1] = Number.NaN
  return [
    null,
    '1,0',
    basis(dim - 1, 0),
    [...basis(dim, 0), 0],
    withNull,
    withString,
    withNan,
    new Array(dim).fill(0),
  ]
}

async function assertStrictQueryBoundary(modelName, dim) {
  for (const query of hostileQueries(dim)) {
    await assert.rejects(
      vectorIndex.searchVectorIndex(searchRequest(modelName, query)),
      /Invalid embedding vector/,
    )
  }

  for (const query of [basis(dim, 0), basis(dim, 0, 1e308), basis(dim, 0, Number.MIN_VALUE)]) {
    const results = await vectorIndex.searchVectorIndex(searchRequest(modelName, query))
    assert.ok(results.length > 0)
    assert.ok(results.every((result) => Number.isFinite(result.vectorScore)))
  }

  for (const topK of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 5001, 1.5]) {
    await assert.rejects(
      vectorIndex.searchVectorIndex({ ...searchRequest(modelName, basis(dim, 0)), topK }),
      /topK must be a safe integer between 1 and 5000/,
    )
  }

  for (const topK of [1, 5000]) {
    const results = await vectorIndex.searchVectorIndex({
      ...searchRequest(modelName, basis(dim, 0)),
      topK,
    })
    assert.ok(results.length > 0)
    assert.ok(results.length <= topK)
  }
}

test('memory index enforces registry dimensions and latest canonical tombstones', async () => {
  vectorIndex.clearVectorIndex()
  const modelName = 'dinov2_vitb14'
  const dim = 768
  writeStores(
    modelName,
    [
      embeddingRow(modelName, 'C:\\Pictures\\legacy-current.JPG', basis(dim, 0)),
      embeddingRow(modelName, 'C:\\Pictures\\canonical.JPG', basis(dim, 1)),
      embeddingRow(modelName, 'C:\\Pictures\\repair.JPG', basis(dim, 2)),
      embeddingRow(modelName, 'C:\\Pictures\\wrong-dim.JPG', [1, 0], 2),
    ],
    [
      embeddingRow(modelName, 'c:/pictures/legacy-current.jpg', new Array(dim).fill(0)),
      embeddingRow(modelName, 'c:/pictures/canonical.jpg', [null, ...new Array(dim - 1).fill(0)]),
      embeddingRow(modelName, 'C:\\Pictures\\same-shard.JPG', basis(dim, 3)),
      embeddingRow(modelName, 'c:/pictures/same-shard.jpg', new Array(dim).fill(0)),
      embeddingRow(modelName, 'c:/pictures/repair.jpg', new Array(dim).fill(0)),
      embeddingRow(modelName, 'C:/PICTURES/REPAIR.JPG', basis(dim, 4)),
      embeddingRow(modelName, 'C:\\Pictures\\live.JPG', basis(dim, 5)),
    ],
  )

  assert.deepEqual(await vectorIndex.buildVectorIndex(modelName), { ok: true })
  assert.deepEqual(vectorIndex.getVectorIndexStatus(), {
    built: true,
    count: 2,
    modelName,
    dim,
  })

  const results = await vectorIndex.searchVectorIndex(searchRequest(modelName, basis(dim, 4)))
  assert.deepEqual(
    new Set(results.map((result) => result.imageId)),
    new Set(['C:/PICTURES/REPAIR.JPG', 'C:\\Pictures\\live.JPG']),
  )
  assert.equal(results[0].imageId, 'C:/PICTURES/REPAIR.JPG')
  await assertStrictQueryBoundary(modelName, dim)
})

test('streaming fallback applies the same latest-row and strict query rules', async () => {
  vectorIndex.clearVectorIndex()
  const modelName = 'clip_vit_base_patch32'
  const dim = 512
  const { legacyPath, shardPath } = writeStores(
    modelName,
    [
      embeddingRow(modelName, 'C:\\Stream\\legacy-current.JPG', basis(dim, 0)),
      embeddingRow(modelName, 'C:\\Stream\\repair.JPG', basis(dim, 1)),
      embeddingRow(modelName, 'C:\\Stream\\wrong-dim.JPG', [1, 0], 2),
    ],
    [
      embeddingRow(modelName, 'c:/stream/legacy-current.jpg', new Array(dim).fill(0)),
      embeddingRow(modelName, 'C:\\Stream\\same-shard.JPG', basis(dim, 2)),
      embeddingRow(modelName, 'c:/stream/same-shard.jpg', new Array(dim).fill(0)),
      embeddingRow(modelName, 'c:/stream/repair.jpg', new Array(dim).fill(0)),
      embeddingRow(modelName, 'C:/STREAM/REPAIR.JPG', basis(dim, 3)),
      embeddingRow(modelName, 'C:\\Stream\\live.JPG', basis(dim, 4)),
    ],
  )

  const sources = new Set([path.resolve(legacyPath), path.resolve(shardPath)])
  const originalStatSync = fs.statSync
  const originalDisableAnn = process.env.FLOATING_CLOCK_DISABLE_VECTOR_ANN
  let rejectedCacheSourceStats = 0
  fs.statSync = function forcedLargeSourceStat(target, ...args) {
    const stat = originalStatSync.call(this, target, ...args)
    if (!sources.has(path.resolve(String(target)))) return stat
    const stack = new Error().stack || ''
    if (stack.includes('sourceFiles')) {
      rejectedCacheSourceStats++
      return new Proxy(stat, {
        get(value, property) {
          if (property === 'isFile') return () => false
          const member = Reflect.get(value, property, value)
          return typeof member === 'function' ? member.bind(value) : member
        },
      })
    }
    return new Proxy(stat, {
      get(value, property) {
        if (property === 'size') return 512 * 1024 * 1024 + 1
        const member = Reflect.get(value, property, value)
        return typeof member === 'function' ? member.bind(value) : member
      },
    })
  }
  process.env.FLOATING_CLOCK_DISABLE_VECTOR_ANN = '1'

  try {
    const built = await vectorIndex.buildVectorIndex(modelName)
    assert.equal(built.ok, true)
    assert.match(built.warning || '', /Streaming vector search is enabled/)
    assert.deepEqual(vectorIndex.getVectorIndexStatus(), {
      built: true,
      count: 2,
      modelName,
      dim,
    })

    const progress = []
    const results = await vectorIndex.searchVectorIndex(
      searchRequest(modelName, basis(dim, 3)),
      (event) => progress.push(event),
    )
    assert.deepEqual(
      new Set(results.map((result) => result.imageId)),
      new Set(['C:/STREAM/REPAIR.JPG', 'C:\\Stream\\live.JPG']),
    )
    assert.equal(results[0].imageId, 'C:/STREAM/REPAIR.JPG')
    assert.ok(progress.some((event) => event.percent === 100))
    assert.ok(
      rejectedCacheSourceStats > 0,
      'the F16 cache must be unavailable to reach JSONL streaming',
    )

    await assertStrictQueryBoundary(modelName, dim)
  } finally {
    fs.statSync = originalStatSync
    if (originalDisableAnn === undefined) delete process.env.FLOATING_CLOCK_DISABLE_VECTOR_ANN
    else process.env.FLOATING_CLOCK_DISABLE_VECTOR_ANN = originalDisableAnn
  }
})
