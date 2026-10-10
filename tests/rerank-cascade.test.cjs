const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const database = loadTsModule('electron/vectorDatabaseService.ts')
const rerank = loadTsModule('electron/rerankService.ts')
const binaryProtocol = loadTsModule('electron/embeddingChildBinaryProtocol.ts')

test('DINO query search consumes the embedding child binary vector protocol', () => {
  const encoded = binaryProtocol.encodeEmbeddingChildFrame(
    { id: 1, ok: true, vectorEncoding: 'float64le' },
    [3, 4],
  )
  const decoder = new binaryProtocol.EmbeddingChildBinaryFrameDecoder()
  const frame = decoder.push(encoded).frames[0]
  const vector = rerank.decodeDinoQueryVectorFrame(frame, 2)
  assert.ok(Math.abs(vector[0] - 0.6) < 1e-12)
  assert.ok(Math.abs(vector[1] - 0.8) < 1e-12)
  assert.throws(() => rerank.decodeDinoQueryVectorFrame(frame, 3), /metadata is invalid/)
})

test('vector cache preparation has no implicit timeout but honors an explicit deadline', async () => {
  const result = await rerank.waitForVectorSearch(Promise.resolve([{ imageId: 'ready' }]))
  assert.equal(result[0].imageId, 'ready')

  let timedOut = false
  await assert.rejects(
    rerank.waitForVectorSearch(new Promise(() => {}), 5, () => {
      timedOut = true
    }),
    /Vector timeout \(5ms\)/,
  )
  assert.equal(timedOut, true)
})

test('vector search is not filtered out when the hash index is empty', () => {
  const isIndexedPath = () => false
  assert.equal(
    rerank.resolveVectorPathFilter({
      searchByImageAsync: async () => ({ results: [] }),
      hashImageAsync: async () => ({}),
      isIndexedPath,
      getIndexedCount: () => 0,
    }),
    undefined,
  )
  assert.equal(
    rerank.resolveVectorPathFilter({
      searchByImageAsync: async () => ({ results: [] }),
      hashImageAsync: async () => ({}),
      isIndexedPath,
      getIndexedCount: () => 10,
    }),
    isIndexedPath,
  )
})

// VAL-036: a corrupted Native scope fails closed — the vector filter rejects
// every candidate and the ANN scope snapshot is empty — instead of widening
// to the full library like an absent/empty index does.
test('corrupt Native scope fails the vector resolvers closed', async () => {
  const isIndexedPath = () => true
  const delegate = {
    searchByImageAsync: async () => ({ results: [] }),
    hashImageAsync: async () => ({}),
    isIndexedPath,
    getIndexedCount: () => 10,
    listIndexedPaths: () => ['C:\\indexed\\a.jpg'],
    getScopeState: () => 'corrupt',
  }
  const filter = rerank.resolveVectorPathFilter(delegate)
  assert.ok(filter, 'a corrupt scope still resolves a filter')
  assert.equal(filter('C:\\indexed\\a.jpg'), false, 'the fail-closed filter rejects every path')
  assert.deepEqual(await rerank.resolveVectorPathScopeKeys(delegate), [])
})

test('absent and valid-empty Native scopes keep the legacy widening resolvers', () => {
  const isIndexedPath = () => false
  for (const scopeState of ['absent', 'valid-empty']) {
    assert.equal(
      rerank.resolveVectorPathFilter({
        searchByImageAsync: async () => ({ results: [] }),
        hashImageAsync: async () => ({}),
        isIndexedPath,
        getIndexedCount: () => 0,
        getScopeState: () => scopeState,
      }),
      undefined,
      `${scopeState} keeps the legacy unfiltered behavior`,
    )
  }
})

test('precise Top 1000 uses a bounded cached feature pool and returns all requested rows', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'floating-clock-rerank-cascade-'))
  try {
    database.initVectorDatabase(userData)
    const count = 5000
    const colorHist = new Array(26).fill(1 / 26)
    const candidates = Array.from({ length: count }, (_, index) => {
      const imageId = `asset-${String(index).padStart(4, '0')}`
      return {
        imageId,
        result: {
          id: imageId,
          path: imageId,
          score: 1 - index / count,
          distance: index,
        },
      }
    })
    database.colorFeatureStore.replaceAll(
      candidates.map(({ imageId }) => ({
        imageId,
        featureType: 'hsv_hist',
        colorHist,
        dominantColors: [],
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    database.shapeFeatureStore.replaceAll(
      candidates.map(({ imageId }) => ({
        imageId,
        aspectRatio: 1,
        objectAreaRatio: 1,
        edgeDensity: 0.1,
        bboxWidth: 100,
        bboxHeight: 100,
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    await database.flushVectorDatabaseWrites()
    rerank.setHashDelegate({
      searchByImageAsync: async () => ({ results: candidates.map((item) => item.result) }),
      hashImageAsync: async () => ({}),
      isIndexedPath: () => true,
    })

    const response = await rerank.searchLayered({
      imagePath: candidates[0].imageId,
      mode: 'precise',
      hashTopK: 2000,
      rerankTopK: 1000,
    })

    assert.equal(response.mergedCandidateCount, 5000)
    assert.equal(response.featureRerankCandidateCount, 2000)
    assert.equal(response.featurePreparedCount, 0)
    assert.equal(response.featureDeferredCount, 0)
    assert.equal(response.results.length, 1000)
    assert.equal(response.results[0].imageId, candidates[0].imageId)
  } finally {
    await fs.rm(userData, { recursive: true, force: true })
  }
})
