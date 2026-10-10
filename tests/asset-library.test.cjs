const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { readImageIndexAssets, verifyImageIndexAssets } = loadTsModule(
  'electron/imageIndexAssetSource.ts',
)
const { AssetMetadataStore } = loadTsModule('electron/assetMetadataStore.ts')
const { AssetCatalogProjection } = loadTsModule('electron/assetCatalogProjection.ts')
const assetGuards = loadTsModule('electron/assetLibraryGuards.ts')
const {
  approximateCentroidCandidates,
  clusterCompressedAssetBuckets,
  estimateAdaptiveClusterCount,
  scoreClusterPurity,
} = loadTsModule('electron/assetClustering.ts')
const { CLUSTER_LABEL_CANDIDATES, rankClusterLabels } = loadTsModule('electron/clusterLabeling.ts')
const { loadClipEmbeddingsForPaths, streamClipEmbeddingsForPaths } = loadTsModule(
  'electron/clipEmbeddingCacheReader.ts',
)
const { EMBEDDING_F16_CACHE_VERSION, float32ToFloat16 } = loadTsModule(
  'electron/embeddingF16Cache.ts',
)
const { getVisionModelCapability } = loadTsModule('electron/modelRegistry.ts')
const { bestSemanticSeed, observeSemanticSeed } = loadTsModule(
  'electron/clusterSemanticRefinement.ts',
)
const {
  buildSemanticPersonClassifier,
  classifySemanticPerson,
  SEMANTIC_PERSON_CLASSES,
  SEMANTIC_PERSON_HUMAN_PROMPTS,
  SEMANTIC_PERSON_NON_HUMAN_PROMPTS,
} = loadTsModule('electron/semanticPersonClassification.ts')
const { undoSuggestionReviewState } = loadTsModule('electron/assetSuggestionReview.ts')
const { assetMetadataDeletionRecordBytes, selectRetainedAssetMetadataDeletions } = loadTsModule(
  'electron/assetMetadataDeletionHistory.ts',
)
const { JsonLinesStore, initVectorDatabase, getEmbeddingStorePath } = loadTsModule(
  'electron/vectorDatabaseService.ts',
)
const { runJsonLinesTransaction, recoverJsonLinesTransaction, jsonLinesTransactionFiles } =
  loadTsModule('electron/jsonLinesTransaction.ts')
const { recoverAssetMetadataTransaction, assetMetadataTransactionFiles } = loadTsModule(
  'electron/assetMetadataTransaction.ts',
)
const {
  assetLibraryRestoreFiles,
  createAssetLibraryBackupIfDue,
  listAssetLibraryBackups,
  recoverAssetLibraryRestore,
  restoreAssetLibraryBackup,
  verifyAssetLibraryBackup,
  verifyAssetLibraryBackupById,
} = loadTsModule('electron/assetLibraryBackup.ts')
const {
  createAssetCategory,
  createAssetTag,
  createAssetLibraryMetadataBackup,
  deleteAssetCategory,
  deleteAssetTag,
  getAssetLibraryStats,
  resolveAssetReferenceEmbeddingBackend,
  initAssetLibraryService,
  listAssetCategories,
  listAssetMetadataDeletions,
  listAssetTags,
  restoreAssetMetadataDeletion,
  restoreAssetLibraryMetadataBackup,
  resolveAssetLibraryAssetPath,
  undoLastAssetMetadataDeletion,
  getAssetLibraryShadowDatabase,
} = loadTsModule('electron/assetLibraryService.ts')
const { streamAssetEmbeddings, loadAssetEmbeddingsForPaths } = loadTsModule(
  'electron/assetLibraryEmbeddingSource.ts',
)
const { scoreReferencePrototypes, pushBoundedScoredCandidate, resolveReferenceThresholds } =
  loadTsModule('electron/assetLibraryScoring.ts')

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'floating-clock-asset-library-'))
  try {
    await run(dir)
  } finally {
    try {
      // Close the SQLite relation database so Windows can remove the temp dir.
      getAssetLibraryShadowDatabase()?.close()
    } catch {
      // best effort cleanup
    }
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('reference embedding backend follows vector settings with a CPU-safe fallback', async () => {
  await withTempDir(async (dir) => {
    assert.equal(resolveAssetReferenceEmbeddingBackend(dir), 'cpu')
    await fs.writeFile(path.join(dir, 'vector-settings.json'), '{"backend":"gpu"}', 'utf8')
    assert.equal(resolveAssetReferenceEmbeddingBackend(dir), 'gpu')
    await fs.writeFile(path.join(dir, 'vector-settings.json'), '{"backend":"invalid"}', 'utf8')
    assert.equal(resolveAssetReferenceEmbeddingBackend(dir), 'cpu')
    await fs.writeFile(path.join(dir, 'vector-settings.json'), '{not-json', 'utf8')
    assert.equal(resolveAssetReferenceEmbeddingBackend(dir), 'cpu')
  })
})

async function writeSegment(filePath, records, deletedIndexes = []) {
  const headerSize = 80
  const footerSize = 16
  const pathBuffers = records.map((record) => Buffer.from(`${record.path}\0`, 'utf8'))
  const offsetsSize = (records.length + 1) * 8
  const pathBytesSize = pathBuffers.reduce((sum, value) => sum + value.length, 0)
  const pathOffsetsOffset = headerSize
  const pathBytesOffset = pathOffsetsOffset + offsetsSize
  const metadataOffset = pathBytesOffset + pathBytesSize
  const diffHashOffset = metadataOffset + records.length * 32
  const dctHashOffset = diffHashOffset + records.length * 8
  const deletedOffset = dctHashOffset + records.length * 8
  const deletedSize = Math.ceil(records.length / 8)
  const footerOffset = deletedOffset + deletedSize
  const fileSize = footerOffset + footerSize
  const output = Buffer.alloc(fileSize)

  output.write('IMS1', 0, 'ascii')
  output.writeUInt32LE(4, 4)
  output.writeBigUInt64LE(BigInt(records.length), 8)
  output.writeBigUInt64LE(BigInt(fileSize), 16)
  output.writeBigUInt64LE(BigInt(headerSize), 24)
  output.writeBigUInt64LE(BigInt(pathOffsetsOffset), 32)
  output.writeBigUInt64LE(BigInt(pathBytesOffset), 40)
  output.writeBigUInt64LE(BigInt(metadataOffset), 48)
  output.writeBigUInt64LE(BigInt(diffHashOffset), 56)
  output.writeBigUInt64LE(BigInt(footerOffset), 64)

  let pathOffset = 0
  records.forEach((record, index) => {
    output.writeBigUInt64LE(BigInt(pathOffset), pathOffsetsOffset + index * 8)
    pathBuffers[index].copy(output, pathBytesOffset + pathOffset)
    pathOffset += pathBuffers[index].length
    const metaOffset = metadataOffset + index * 32
    output.writeInt32LE(record.width || 100, metaOffset)
    output.writeInt32LE(record.height || 80, metaOffset + 4)
    output.writeBigInt64LE(BigInt(record.fileSize || 1000), metaOffset + 8)
    output.writeBigInt64LE(BigInt(record.modifiedTime || 100), metaOffset + 16)
    output.writeBigUInt64LE(BigInt(record.diffHash || index + 1), diffHashOffset + index * 8)
    output.writeBigUInt64LE(BigInt(record.dctHash || index + 11), dctHashOffset + index * 8)
  })
  output.writeBigUInt64LE(BigInt(pathOffset), pathOffsetsOffset + records.length * 8)
  for (const index of deletedIndexes) output[deletedOffset + (index >> 3)] |= 1 << (index & 7)
  output.write('END\0', footerOffset, 'binary')
  output.writeBigUInt64LE(BigInt(records.length), footerOffset + 4)
  output.writeUInt32LE(4, footerOffset + 12)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, output)
}

test('image index asset source keeps newest records and honors deleted records and overlay', async () => {
  await withTempDir(async (dir) => {
    const oldSegment = path.join(dir, 'segments', 'old.idx')
    const newSegment = path.join(dir, 'segments', 'new.idx')
    await writeSegment(oldSegment, [
      { path: 'C:\\images\\a.jpg', modifiedTime: 10, fileSize: 10 },
      { path: 'C:\\images\\b.jpg', modifiedTime: 20, fileSize: 20 },
    ])
    await writeSegment(
      newSegment,
      [
        { path: 'C:\\images\\a.jpg', modifiedTime: 99, fileSize: 99 },
        { path: 'C:\\images\\c.jpg', modifiedTime: 30, fileSize: 30 },
      ],
      [1],
    )
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 2,
        segments: [
          { file: 'segments/new.idx', recordCount: 2 },
          { file: 'segments/old.idx', recordCount: 2 },
        ],
      }),
    )
    await fs.writeFile(
      path.join(dir, 'overlay.json'),
      JSON.stringify({ deleted: ['c:\\images\\b.jpg'], replaced: [] }),
    )

    const result = await readImageIndexAssets(dir)
    assert.equal(result.assets.length, 1)
    assert.equal(result.assets[0].path, 'C:\\images\\a.jpg')
    assert.equal(result.assets[0].modifiedTime, 99)
    assert.equal(result.assets[0].fileSize, 99)
  })
})

test('image index asset source accepts a persisted empty manifest', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ schemaVersion: 2, segments: [] }),
      'utf8',
    )

    const result = await readImageIndexAssets(dir)
    assert.deepEqual(result.assets, [])
    assert.equal(result.sourceManifest, path.join(dir, 'manifest.json'))
  })
})

test('image index asset source rejects oversized and out-of-root segment declarations', async () => {
  await withTempDir(async (dir) => {
    const oversizedPath = path.join(dir, 'oversized.idx')
    const oversized = Buffer.alloc(96)
    oversized.write('IMS1', 0, 'ascii')
    oversized.writeUInt32LE(4, 4)
    oversized.writeBigUInt64LE(1_000_001n, 8)
    oversized.writeBigUInt64LE(96n, 16)
    await fs.writeFile(oversizedPath, oversized)
    await assert.rejects(readImageIndexAssets(oversizedPath), /record count exceeds safety limit/i)

    const indexDir = path.join(dir, 'index')
    const outsideSegment = path.join(dir, 'outside.idx')
    await writeSegment(outsideSegment, [
      { path: 'C:\\images\\outside.jpg', modifiedTime: 1, fileSize: 1 },
    ])
    await fs.mkdir(indexDir, { recursive: true })
    await fs.writeFile(
      path.join(indexDir, 'manifest.json'),
      JSON.stringify({
        segments: [{ file: outsideSegment, recordCount: 1 }],
      }),
    )
    await assert.rejects(readImageIndexAssets(indexDir), /escapes manifest directory/i)
  })
})

test('asset embedding streams keep the latest appended vector for each path', async () => {
  await withTempDir(async (dir) => {
    initVectorDatabase(dir)
    const modelName = 'dinov2_vitb14'
    const expectedDim = getVisionModelCapability(modelName).dim
    const embeddingPath = getEmbeddingStorePath(modelName, 'global')
    const entry = (id, imageId, vector, updatedAt) => ({
      id,
      imageId,
      modelName,
      modelVersion: '1',
      embeddingType: 'global',
      dim: vector.length,
      vector,
      norm: 1,
      createdAt: updatedAt,
      updatedAt,
    })
    const targetPath = 'C:\\素材\\target.png'
    const otherPath = 'D:\\images\\other.png'
    const vector = (...head) => [...head, ...new Array(expectedDim - head.length).fill(0)]
    await fs.mkdir(path.dirname(embeddingPath), { recursive: true })
    await fs.writeFile(
      embeddingPath,
      [
        JSON.stringify(entry(1, targetPath, vector(1, 0), 1)),
        JSON.stringify(entry(2, otherPath, vector(1, 1), 2)),
        '{malformed',
        JSON.stringify(entry(3, targetPath, vector(0, 2), 3)),
      ].join('\r\n') + '\r\n',
      'utf8',
    )

    const streamed = []
    const result = await streamAssetEmbeddings({
      modelName,
      onEntry: (value) => streamed.push(value),
    })
    assert.equal(result.scanned, 2)
    assert.deepEqual(
      streamed.map((value) => value.imageId),
      [targetPath, otherPath],
    )
    assert.deepEqual(Array.from(streamed[0].vector.slice(0, 2)), [0, 1])

    const loaded = await loadAssetEmbeddingsForPaths(modelName, [targetPath])
    assert.deepEqual(Array.from(loaded.get(targetPath.toLowerCase()).slice(0, 2)), [0, 1])
  })
})

test('reference scoring preserves distinct visual modes and keeps deterministic top candidates', () => {
  const score = scoreReferencePrototypes(Float32Array.from([-1, 0]), [
    { assetId: 10, vector: Float32Array.from([1, 0]), weight: 1 },
    { assetId: 20, vector: Float32Array.from([-1, 0]), weight: 1 },
  ])
  assert.ok(score.confidence > 0.999)
  assert.equal(score.evidenceAssetId, 20)

  const heap = []
  for (const candidate of [
    { assetId: 5, confidence: 0.7 },
    { assetId: 3, confidence: 0.9 },
    { assetId: 8, confidence: 0.8 },
    { assetId: 2, confidence: 0.9 },
    { assetId: 1, confidence: 0.4 },
  ]) {
    pushBoundedScoredCandidate(heap, candidate, 3)
  }
  assert.deepEqual(
    heap
      .sort((left, right) => right.confidence - left.confidence || left.assetId - right.assetId)
      .map((candidate) => [candidate.assetId, candidate.confidence]),
    [
      [2, 0.9],
      [3, 0.9],
      [8, 0.8],
    ],
  )
})

test('asset metadata synchronization preserves ids and marks missing assets', async () => {
  await withTempDir(async (dir) => {
    const store = new AssetMetadataStore(dir)
    const first = await store.replaceFromImageIndex(
      [
        { path: 'C:\\images\\a.jpg', width: 100, height: 100, fileSize: 10, modifiedTime: 1 },
        { path: 'C:\\images\\b.jpg', width: 100, height: 100, fileSize: 20, modifiedTime: 1 },
      ],
      'manifest-one',
      () => false,
    )
    assert.equal(first.added, 2)
    const firstA = store.getByPath('c:\\IMAGES\\a.jpg')
    const firstB = store.getByPath('C:\\images\\b.jpg')
    assert.ok(firstA)
    assert.ok(firstB)

    const reloaded = new AssetMetadataStore(dir)
    await reloaded.ensureLoaded()
    assert.equal(reloaded.getByPath('C:\\images\\a.jpg').id, firstA.id)
    const second = await reloaded.replaceFromImageIndex(
      [
        { path: 'C:\\images\\a.jpg', width: 120, height: 100, fileSize: 11, modifiedTime: 2 },
        { path: 'C:\\images\\c.jpg', width: 80, height: 80, fileSize: 30, modifiedTime: 1 },
      ],
      'manifest-two',
      () => false,
    )
    assert.equal(second.added, 1)
    assert.equal(second.updated, 1)
    assert.equal(second.missing, 1)
    assert.equal(reloaded.getByPath('C:\\images\\a.jpg').id, firstA.id)
    assert.equal(reloaded.getByPath('C:\\images\\b.jpg').id, firstB.id)
    assert.equal(reloaded.getByPath('C:\\images\\b.jpg').missing, true)
    assert.equal(reloaded.activeCount(), 2)

    const listed = await reloaded.list(
      { offset: 0, limit: 10, sort: 'name_asc', query: 'images' },
      () => true,
    )
    assert.deepEqual(
      listed.records.map((record) => path.basename(record.path)),
      ['a.jpg', 'c.jpg'],
    )
  })
})

test('cancelled asset synchronization leaves memory and disk on the previous committed snapshot', async () => {
  await withTempDir(async (dir) => {
    const store = new AssetMetadataStore(dir)
    await store.replaceFromImageIndex(
      [{ path: 'C:\\images\\a.jpg', width: 100, height: 100, fileSize: 10, modifiedTime: 1 }],
      'manifest-one',
      () => false,
    )
    const originalId = store.getByPath('C:\\images\\a.jpg').id
    const originalState = { ...store.getState() }
    let cancelChecks = 0

    await assert.rejects(
      store.replaceFromImageIndex(
        [
          {
            path: 'C:\\images\\a.jpg',
            width: 120,
            height: 100,
            fileSize: 99,
            modifiedTime: 2,
          },
          { path: 'C:\\images\\b.jpg', width: 80, height: 80, fileSize: 20, modifiedTime: 1 },
          { path: 'C:\\images\\c.jpg', width: 80, height: 80, fileSize: 30, modifiedTime: 1 },
        ],
        'manifest-cancelled',
        () => {
          cancelChecks += 1
          return cancelChecks >= 2
        },
      ),
      /cancelled/i,
    )

    assert.deepEqual({ ...store.getState() }, originalState)
    assert.equal(store.getByPath('C:\\images\\a.jpg').fileSize, 10)
    assert.equal(store.getByPath('C:\\images\\b.jpg'), undefined)

    const reloaded = new AssetMetadataStore(dir)
    await reloaded.ensureLoaded()
    assert.deepEqual({ ...reloaded.getState() }, originalState)
    assert.equal(reloaded.getByPath('C:\\images\\a.jpg').fileSize, 10)
    assert.equal(reloaded.getByPath('C:\\images\\b.jpg'), undefined)
    const transactionArtifacts = (await fs.readdir(dir)).filter(
      (filename) =>
        filename === assetMetadataTransactionFiles.journal ||
        filename.startsWith(assetMetadataTransactionFiles.stagePrefix),
    )
    assert.deepEqual(transactionArtifacts, [])

    await store.replaceFromImageIndex(
      [
        { path: 'C:\\images\\a.jpg', width: 100, height: 100, fileSize: 10, modifiedTime: 1 },
        { path: 'C:\\images\\b.jpg', width: 80, height: 80, fileSize: 20, modifiedTime: 1 },
      ],
      'manifest-two',
      () => false,
    )
    assert.equal(store.getByPath('C:\\images\\a.jpg').id, originalId)
    assert.equal(store.getByPath('C:\\images\\b.jpg').id, originalId + 1)
  })
})

test('malformed asset rows remain readable but lock all authoritative writes', async () => {
  await withTempDir(async (dir) => {
    const store = new AssetMetadataStore(dir)
    await store.replaceFromImageIndex(
      [{ path: 'C:\\images\\valid.jpg', width: 100, height: 100, fileSize: 10, modifiedTime: 1 }],
      'manifest-one',
      () => false,
    )
    await store.flush()
    const assetsPath = path.join(dir, 'assets.jsonl')
    const original = await fs.readFile(assetsPath, 'utf8')
    await fs.appendFile(assetsPath, `${original.trim()}\n{malformed-json\n`, 'utf8')
    const before = await fs.readFile(assetsPath, 'utf8')

    const damaged = new AssetMetadataStore(dir)
    await damaged.ensureLoaded()
    assert.equal(damaged.activeCount(), 1)
    assert.equal(damaged.getByPath('C:\\images\\valid.jpg').id, 1)
    assert.deepEqual(damaged.getPersistenceStatus(), {
      state: 'read_only',
      corruptRows: 2,
      error: 'assets.jsonl contains 2 malformed row(s)',
    })
    await assert.rejects(damaged.persist(), /malformed row.*writing is disabled/i)
    await assert.rejects(damaged.setArchived([1], true), /malformed row.*writing is disabled/i)
    await assert.rejects(
      damaged.replaceFromImageIndex([], 'replacement', () => false),
      /malformed row.*writing is disabled/i,
    )
    assert.equal(await fs.readFile(assetsPath, 'utf8'), before)
    assert.equal(damaged.getById(1).archived, false)
  })
})

test('invalid state metadata fails closed without replacing the asset snapshot', async () => {
  await withTempDir(async (dir) => {
    const assetsPath = path.join(dir, 'assets.jsonl')
    await fs.writeFile(assetsPath, '{"id":1,"path":"C:\\\\images\\\\valid.jpg"}\n', 'utf8')
    await fs.writeFile(path.join(dir, 'state.json'), '{invalid-state', 'utf8')
    const before = await fs.readFile(assetsPath, 'utf8')
    const store = new AssetMetadataStore(dir)

    await assert.rejects(store.ensureLoaded(), /invalid state\.json/i)
    assert.equal(store.getPersistenceStatus().state, 'unavailable')
    await assert.rejects(store.persist(), /writing is disabled/i)
    assert.equal(await fs.readFile(assetsPath, 'utf8'), before)
  })
})

test('invalid archive metadata fails closed instead of treating removed assets as active', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'assets.jsonl'),
      '{"id":1,"path":"C:\\\\images\\\\valid.jpg"}\n',
      'utf8',
    )
    await fs.writeFile(path.join(dir, 'state.json'), '{"nextId":2}', 'utf8')
    await fs.writeFile(path.join(dir, 'archived-assets.json'), '{invalid-archive', 'utf8')
    const store = new AssetMetadataStore(dir)

    await assert.rejects(store.ensureLoaded(), /invalid archived-assets\.json/i)
    assert.equal(store.getPersistenceStatus().state, 'unavailable')
    await assert.rejects(store.setArchived([1], false), /writing is disabled/i)
  })
})

test('archive persistence failure does not commit memory and locks later writes', async () => {
  await withTempDir(async (dir) => {
    const imagePath = path.join(dir, 'reference.png')
    const libraryPath = path.join(dir, 'library')
    await fs.writeFile(imagePath, Buffer.from('reference-image'))
    const store = new AssetMetadataStore(libraryPath)
    const [asset] = await store.importManualImages([imagePath])
    await fs.mkdir(path.join(libraryPath, 'archived-assets.json'))

    await assert.rejects(store.setArchived([asset.id], true), /archive persistence failed/i)
    assert.equal(store.getById(asset.id).archived, false)
    assert.equal(store.activeCount(), 1)
    assert.equal(store.archivedCount(), 0)
    assert.equal(store.getPersistenceStatus().state, 'unavailable')
    await assert.rejects(store.persist(), /writing is disabled/i)
  })
})

test('asset metadata pagination returns deterministic bounded pages for expensive sorts', async () => {
  await withTempDir(async (dir) => {
    const store = new AssetMetadataStore(dir)
    const source = Array.from({ length: 300 }, (_, index) => ({
      path: `C:\\images\\${String(299 - index).padStart(3, '0')}.jpg`,
      width: 100,
      height: 100,
      fileSize: index,
      modifiedTime: index,
    }))
    await store.replaceFromImageIndex(source, 'manifest', () => false)

    const byName = await store.list({ offset: 100, limit: 25, sort: 'name_asc' }, () => true)
    assert.equal(byName.total, 300)
    assert.deepEqual(
      byName.records.map((record) => path.basename(record.path)),
      Array.from({ length: 25 }, (_, index) => `${String(100 + index).padStart(3, '0')}.jpg`),
    )

    const bySize = await store.list({ offset: 10, limit: 5, sort: 'size_desc' }, () => true)
    assert.deepEqual(
      bySize.records.map((record) => record.fileSize),
      [289, 288, 287, 286, 285],
    )
  })
})

test('asset metadata list filters source, kind and modified date range before pagination', async () => {
  await withTempDir(async (dir) => {
    const store = new AssetMetadataStore(dir)
    await store.replaceFromImageIndex(
      [
        { path: 'C:\\images\\old.jpg', width: 1, height: 1, fileSize: 1, modifiedTime: 100 },
        { path: 'C:\\images\\new.jpg', width: 1, height: 1, fileSize: 1, modifiedTime: 300 },
      ],
      'manifest',
      () => false,
    )
    const filtered = await store.list({
      offset: 0,
      limit: 10,
      sort: 'updated_desc',
      source: 'image_search',
      kind: 'image',
      modifiedAfter: 200,
      modifiedBefore: 400,
    })
    assert.equal(filtered.total, 1)
    assert.equal(path.basename(filtered.records[0].path), 'new.jpg')
    assert.equal(
      (
        await store.list({
          offset: 0,
          limit: 10,
          sort: 'updated_desc',
          source: 'manual',
        })
      ).total,
      0,
    )
  })
})

test('asset rating and favorite metadata persist atomically and filter before pagination', async () => {
  await withTempDir(async (dir) => {
    const store = new AssetMetadataStore(dir)
    await store.replaceFromImageIndex(
      [
        { path: 'C:\\images\\one.jpg', width: 1, height: 1, fileSize: 1, modifiedTime: 1 },
        { path: 'C:\\images\\two.jpg', width: 1, height: 1, fileSize: 1, modifiedTime: 2 },
      ],
      'manifest',
      () => false,
    )
    assert.equal(await store.setUserMetadata([2], { rating: 4, favorite: true }), 1)
    const filtered = await store.list({
      offset: 0,
      limit: 10,
      sort: 'updated_desc',
      minRating: 3,
      favoriteOnly: true,
    })
    assert.deepEqual(
      filtered.records.map((record) => record.id),
      [2],
    )
    const reloaded = new AssetMetadataStore(dir)
    await reloaded.ensureLoaded()
    assert.equal(reloaded.getById(2).rating, 4)
    assert.equal(reloaded.getById(2).favorite, true)
    assert.equal(await reloaded.setUserMetadata([2], { rating: 0, favorite: false }), 1)
    assert.equal(reloaded.getById(2).rating, undefined)
    assert.equal(reloaded.getById(2).favorite, undefined)
  })
})

test('SQLite asset catalog preserves active, archived, query, and incremental update semantics', async () => {
  await withTempDir(async (dir) => {
    const projection = new AssetCatalogProjection(path.join(dir, 'asset-catalog.sqlite'))
    const makeRecord = (id, filePath, overrides = {}) => ({
      id,
      path: filePath,
      kind: 'image',
      source: 'image_search',
      width: 100,
      height: 80,
      fileSize: id * 10,
      modifiedTime: id,
      missing: false,
      archived: false,
      createdAt: id,
      updatedAt: id,
      ...overrides,
    })
    const records = new Map([
      [1, makeRecord(1, 'C:\\images\\zeta.jpg')],
      [
        2,
        makeRecord(2, 'D:\\\u7d20\u6750\\alpha.png', {
          source: 'manual',
          kind: 'video_frame',
          modifiedTime: 200,
          rating: 5,
          favorite: true,
        }),
      ],
      [3, makeRecord(3, 'D:\\images\\missing.jpg', { missing: true })],
      [4, makeRecord(4, 'D:\\images\\removed.jpg', { archived: true, archivedAt: 40 })],
    ])
    await projection.replaceAll(records, 'fingerprint-one')
    assert.equal(projection.isFresh('fingerprint-one', 4), true)
    assert.equal(projection.isFresh('stale-fingerprint', 4), false)

    const active = projection.list({ offset: 0, limit: 10, sort: 'name_asc' })
    assert.equal(active.total, 2)
    assert.deepEqual(
      active.records.map((record) => path.basename(record.path)),
      ['alpha.png', 'zeta.jpg'],
    )
    assert.equal(
      projection.list({ offset: 0, limit: 10, sort: 'updated_desc', query: '\u7d20\u6750' }).total,
      1,
    )
    assert.equal(
      projection.list({ offset: 0, limit: 10, sort: 'updated_desc', archivedOnly: true }).total,
      1,
    )
    assert.deepEqual(
      projection
        .list({
          offset: 0,
          limit: 10,
          sort: 'updated_desc',
          source: 'manual',
          kind: 'video_frame',
          modifiedAfter: 150,
          modifiedBefore: 250,
        })
        .records.map((record) => record.id),
      [2],
    )
    assert.equal(
      projection.list({
        offset: 0,
        limit: 10,
        sort: 'updated_desc',
        source: 'image_search',
        modifiedAfter: 150,
      }).total,
      0,
    )
    assert.deepEqual(
      projection
        .list({
          offset: 0,
          limit: 10,
          sort: 'updated_desc',
          minRating: 4,
          favoriteOnly: true,
        })
        .records.map((record) => record.id),
      [2],
    )

    const archived = { ...records.get(1), archived: true, archivedAt: 50, updatedAt: 50 }
    records.set(1, archived)
    assert.equal(projection.updateRecords([archived], 'fingerprint-two', records.size), true)
    assert.equal(projection.isFresh('fingerprint-two', 4), true)
    assert.equal(projection.list({ offset: 0, limit: 10, sort: 'updated_desc' }).total, 1)
    assert.equal(
      projection.list({ offset: 0, limit: 10, sort: 'updated_desc', archivedOnly: true }).total,
      2,
    )
  })
})

test('asset sync verification removes stale paths and uses live file metadata', async () => {
  await withTempDir(async (dir) => {
    const existingPath = path.join(dir, 'existing.png')
    const missingPath = path.join(dir, 'missing.png')
    await fs.writeFile(existingPath, Buffer.from('image-bytes'))
    const result = await verifyImageIndexAssets([
      {
        path: existingPath,
        width: 99_999_999,
        height: -2,
        fileSize: 999_999,
        modifiedTime: 1,
      },
      { path: missingPath, width: 10, height: 10, fileSize: 10, modifiedTime: 1 },
    ])

    assert.equal(result.assets.length, 1)
    assert.equal(result.missing, 1)
    assert.equal(result.assets[0].path, existingPath)
    assert.equal(result.assets[0].fileSize, 11)
    assert.equal(result.assets[0].width, 0)
    assert.equal(result.assets[0].height, 0)
    assert.ok(result.assets[0].modifiedTime > 1)
  })
})

test('manual reference images are imported once and survive image-index synchronization', async () => {
  await withTempDir(async (dir) => {
    const imagePath = path.join(dir, 'reference.png')
    await fs.writeFile(imagePath, Buffer.from('reference-image'))
    const store = new AssetMetadataStore(path.join(dir, 'library'))
    const first = await store.importManualImages([imagePath, imagePath])
    const second = await store.importManualImages([imagePath])

    assert.equal(first.length, 1)
    assert.equal(second.length, 1)
    assert.equal(second[0].id, first[0].id)
    assert.equal(second[0].source, 'manual')
    assert.equal(second[0].missing, false)

    await store.replaceFromImageIndex([], 'empty-manifest', () => false)
    assert.equal(store.getById(first[0].id).missing, false)
    assert.equal(store.activeCount(), 1)
  })
})

test('manual reference verification persists file changes and missing state', async () => {
  await withTempDir(async (dir) => {
    const imagePath = path.join(dir, 'reference.png')
    const libraryPath = path.join(dir, 'library')
    await fs.writeFile(imagePath, Buffer.from('first'))
    const store = new AssetMetadataStore(libraryPath)
    const [asset] = await store.importManualImages([imagePath])

    await fs.writeFile(imagePath, Buffer.from('updated-reference'))
    const future = new Date(Date.now() + 5000)
    await fs.utimes(imagePath, future, future)
    const changed = await store.verifyManualAssets([asset.id])
    assert.equal(changed.checked, 1)
    assert.equal(changed.updated, 1)
    assert.deepEqual(changed.changedAssetIds, [asset.id])
    assert.equal(store.getById(asset.id).fileSize, 17)
    assert.equal(store.getById(asset.id).missing, false)

    await fs.unlink(imagePath)
    const missing = await store.verifyManualAssets([asset.id])
    assert.equal(missing.missing, 1)
    assert.equal(missing.updated, 1)
    assert.equal(store.getById(asset.id).missing, true)

    const reloaded = new AssetMetadataStore(libraryPath)
    await reloaded.ensureLoaded()
    assert.equal(reloaded.getById(asset.id).missing, true)
  })
})

test('asset removal is reversible, persists across restarts, and keeps source files', async () => {
  await withTempDir(async (dir) => {
    const imagePath = path.join(dir, 'keep-original.png')
    const libraryPath = path.join(dir, 'library')
    await fs.writeFile(imagePath, Buffer.from('original-image'))

    const store = new AssetMetadataStore(libraryPath)
    const [asset] = await store.importManualImages([imagePath])
    assert.ok(asset)
    assert.equal(await store.setArchived([asset.id], true), 1)
    assert.equal(store.activeCount(), 0)
    assert.equal(store.archivedCount(), 1)
    assert.equal(
      (await store.list({ offset: 0, limit: 10, sort: 'name_asc' }, () => true)).total,
      0,
    )
    const removed = await store.list(
      { offset: 0, limit: 10, sort: 'name_asc', archivedOnly: true },
      () => true,
    )
    assert.equal(removed.total, 1)
    assert.equal(removed.records[0].id, asset.id)
    assert.equal((await fs.stat(imagePath)).isFile(), true)

    const reloaded = new AssetMetadataStore(libraryPath)
    await reloaded.ensureLoaded()
    assert.equal(reloaded.activeCount(), 0)
    assert.equal(reloaded.archivedCount(), 1)
    assert.equal(reloaded.getById(asset.id).archived, true)

    await reloaded.replaceFromImageIndex([], 'empty-manifest', () => false)
    assert.equal(reloaded.getById(asset.id).archived, true)
    assert.equal(await reloaded.setArchived([asset.id], false), 1)

    const restored = new AssetMetadataStore(libraryPath)
    await restored.ensureLoaded()
    assert.equal(restored.activeCount(), 1)
    assert.equal(restored.archivedCount(), 0)
    assert.equal(restored.getById(asset.id).archived, false)
  })
})

test('reimporting an archived reference commits asset and archive metadata together', async () => {
  await withTempDir(async (dir) => {
    const imagePath = path.join(dir, 'reference.png')
    const libraryPath = path.join(dir, 'library')
    await fs.writeFile(imagePath, Buffer.from('reference-image'))
    const store = new AssetMetadataStore(libraryPath)
    const [asset] = await store.importManualImages([imagePath])
    await store.setArchived([asset.id], true)

    const [restored] = await store.importManualImages([imagePath])
    assert.equal(restored.id, asset.id)
    assert.equal(restored.archived, false)
    assert.equal(store.activeCount(), 1)
    assert.equal(store.archivedCount(), 0)

    const reloaded = new AssetMetadataStore(libraryPath)
    await reloaded.ensureLoaded()
    assert.equal(reloaded.getById(asset.id).archived, false)
    assert.equal(reloaded.activeCount(), 1)
    assert.equal(reloaded.archivedCount(), 0)
    const archive = JSON.parse(
      await fs.readFile(path.join(libraryPath, 'archived-assets.json'), 'utf8'),
    )
    assert.deepEqual(archive.entries, [])
    const transactionArtifacts = (await fs.readdir(libraryPath)).filter(
      (filename) =>
        filename === assetMetadataTransactionFiles.journal ||
        filename.startsWith(assetMetadataTransactionFiles.stagePrefix) ||
        filename === 'archived-assets.json.tmp',
    )
    assert.deepEqual(transactionArtifacts, [])
  })
})

test('asset shell path resolution accepts only authoritative non-missing asset ids', async () => {
  await withTempDir(async (dir) => {
    const assetDir = path.join(dir, 'asset-library')
    const archivedPath = path.join(dir, 'archived.png')
    const missingPath = path.join(dir, 'missing.png')
    await fs.mkdir(assetDir, { recursive: true })
    const records = [
      {
        id: 1,
        path: archivedPath,
        kind: 'image',
        source: 'manual',
        width: 1,
        height: 1,
        fileSize: 1,
        modifiedTime: 1,
        missing: false,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 2,
        path: missingPath,
        kind: 'image',
        source: 'manual',
        width: 1,
        height: 1,
        fileSize: 1,
        modifiedTime: 1,
        missing: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    await fs.writeFile(
      path.join(assetDir, 'assets.jsonl'),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    )
    await fs.writeFile(path.join(assetDir, 'state.json'), '{"nextId":3}')
    await fs.writeFile(
      path.join(assetDir, 'archived-assets.json'),
      JSON.stringify({ version: 1, entries: [{ path: archivedPath, archivedAt: 2 }] }),
    )
    initAssetLibraryService(dir)

    assert.equal(await resolveAssetLibraryAssetPath(1), archivedPath)
    await assert.rejects(resolveAssetLibraryAssetPath(2), /marked missing/i)
    await assert.rejects(resolveAssetLibraryAssetPath(999), /asset not found/i)
    assert.throws(() => assetGuards.positiveId(archivedPath, 'asset id'), /invalid asset id/i)
  })
})

test('metadata deletion retention prioritizes pending records and enforces byte limits', () => {
  const records = [
    { id: 1, deletedAt: 10, payload: 'old-pending' },
    { id: 2, deletedAt: 20, payload: 'new-pending' },
    { id: 3, deletedAt: 30, restoredAt: 31, payload: 'old-restored' },
    { id: 4, deletedAt: 40, restoredAt: 41, payload: 'new-restored' },
  ]
  assert.deepEqual(
    selectRetainedAssetMetadataDeletions(records, {
      maxRecords: 3,
      maxBytes: 1024 * 1024,
    }).map((item) => item.id),
    [1, 2, 4],
  )
  assert.deepEqual(
    selectRetainedAssetMetadataDeletions(records, { maxRecords: 50, maxBytes: 1 }).map(
      (item) => item.id,
    ),
    [2],
  )
  assert.ok(assetMetadataDeletionRecordBytes(records[0]) > records[0].payload.length)
})

test('metadata deletion history lists and restores a selected category or tag', async () => {
  await withTempDir(async (dir) => {
    initAssetLibraryService(dir)
    const category = await createAssetCategory({ name: 'Recover category' })
    const tag = await createAssetTag({ name: 'Recover tag' })
    assert.equal((await deleteAssetCategory(category.id)).ok, true)
    assert.equal((await deleteAssetTag(tag.id)).ok, true)

    const pending = listAssetMetadataDeletions({ status: 'pending', limit: 10 })
    assert.equal(pending.total, 2)
    assert.ok(pending.totalBytes > 0)
    const categoryDeletion = pending.items.find((item) => item.kind === 'category')
    assert.ok(categoryDeletion)
    assert.equal(categoryDeletion.name, 'Recover category')
    assert.equal(categoryDeletion.relationCount, 0)

    assert.equal((await restoreAssetMetadataDeletion(categoryDeletion.id)).ok, true)
    assert.equal(
      listAssetCategories().some((item) => item.name === 'Recover category'),
      true,
    )
    assert.equal(
      listAssetTags().some((item) => item.name === 'Recover tag'),
      false,
    )
    const restored = listAssetMetadataDeletions({ status: 'restored', limit: 10 })
    assert.equal(restored.total, 1)
    assert.equal(restored.items[0].id, categoryDeletion.id)

    assert.equal((await undoLastAssetMetadataDeletion()).ok, true)
    assert.equal(
      listAssetTags().some((item) => item.name === 'Recover tag'),
      true,
    )
  })
})

test('deleting metadata prunes the oldest recovery record at the retention limit', async () => {
  await withTempDir(async (dir) => {
    const assetDir = path.join(dir, 'asset-library')
    await fs.mkdir(assetDir, { recursive: true })
    const oldRecords = Array.from({ length: 50 }, (_, index) => ({
      id: index + 1,
      kind: 'tag',
      name: `Old tag ${index + 1}`,
      tag: {
        id: index + 1,
        name: `Old tag ${index + 1}`,
        color: '#ffffff',
        createdAt: index + 1,
        updatedAt: index + 1,
      },
      categoryAssignments: [],
      tagAssignments: [],
      references: [],
      suggestions: [],
      deletedAt: index + 1,
    }))
    await fs.writeFile(
      path.join(assetDir, 'metadata_deletion_trash.jsonl'),
      `${oldRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
    )
    initAssetLibraryService(dir)
    const newest = await createAssetTag({ name: 'Newest tag' })
    assert.equal((await deleteAssetTag(newest.id)).ok, true)

    const history = listAssetMetadataDeletions({ status: 'all', limit: 50 })
    assert.equal(history.total, 50)
    assert.equal(history.items[0].name, 'Newest tag')
    assert.equal(
      history.items.some((item) => item.id === 1),
      false,
    )
    assert.equal(history.maxRecords, 50)
    assert.equal(history.maxBytes, 32 * 1024 * 1024)
  })
})

test('asset library IPC guards clamp pages and reject invalid identifiers', () => {
  assert.deepEqual(assetGuards.normalizeAssetListRequest({ offset: -10, limit: 5000 }), {
    offset: 0,
    limit: 200,
  })
  assert.deepEqual(assetGuards.positiveIds([1, 1, 2, -1, '3']), [1, 2])
  assert.deepEqual(assetGuards.normalizeAssetListRequest({ archivedOnly: true }), {
    archivedOnly: true,
  })
  assert.deepEqual(
    assetGuards.normalizeMetadataDeletionListRequest({
      offset: -2,
      limit: 500,
      status: 'restored',
    }),
    { offset: 0, limit: 50, status: 'restored' },
  )
  assert.throws(() => assetGuards.positiveId(0), /Invalid id/)
  assert.equal(assetGuards.normalizeCategoryInput({ name: ' Products ' }).name, 'Products')
  assert.equal(
    assetGuards.normalizeCategoryInput({ name: 'Strict', referenceThreshold: 3 })
      .referenceThreshold,
    1,
  )
  assert.equal(
    assetGuards.normalizeCategoryInput({ name: 'Loose', referenceThreshold: 0.2 })
      .referenceThreshold,
    0.5,
  )
  assert.deepEqual(
    assetGuards.normalizeCategorySampleSearchRequest({
      categoryId: 7,
      topK: 50_000,
      includeReviewed: true,
    }),
    { categoryId: 7, topK: 500, includeReviewed: true },
  )
  assert.deepEqual(assetGuards.normalizeCategorySampleSearchRequest({ categoryId: 7, topK: 1 }), {
    categoryId: 7,
    topK: 10,
  })
  assert.throws(
    () => assetGuards.normalizeCategorySampleSearchRequest({ categoryId: 0 }),
    /Invalid category id/,
  )
  assert.deepEqual(
    assetGuards.normalizeSimilarSearchRequest({
      assetId: 19,
      categoryId: 7,
      topK: 50_000,
      includeReviewed: true,
    }),
    { assetId: 19, categoryId: 7, topK: 500, includeReviewed: true },
  )
  assert.throws(() => assetGuards.normalizeSimilarSearchRequest({ assetId: 0 }), /Invalid asset id/)
  assert.deepEqual(
    assetGuards.normalizeSearchResultQuery({
      taskId: ' task-7 ',
      resultId: ' result-9 ',
      categoryId: 7,
    }),
    { taskId: 'task-7', resultId: 'result-9', categoryId: 7 },
  )
  assert.deepEqual(assetGuards.normalizeSearchResultQuery(7, true), { categoryId: 7 })
  assert.throws(
    () => assetGuards.normalizeSearchResultQuery({ categoryId: 0 }),
    /Invalid category id/,
  )
})

test('reference thresholds prefer explicit requests and preserve per-category defaults', () => {
  assert.deepEqual(resolveReferenceThresholds(), { suggested: 0.82, lowConfidence: 0.7 })
  assert.deepEqual(resolveReferenceThresholds(0.91), { suggested: 0.91, lowConfidence: 0.7 })
  assert.deepEqual(resolveReferenceThresholds(0.91, 0.76, 0.65), {
    suggested: 0.76,
    lowConfidence: 0.65,
  })
  assert.deepEqual(resolveReferenceThresholds(0.6), { suggested: 0.6, lowConfidence: 0.6 })
})

test('JSONL transactions commit every store and roll back failed actions', async () => {
  await withTempDir(async (dir) => {
    const getBaseDir = () => dir
    const left = new JsonLinesStore('left.jsonl', getBaseDir)
    const right = new JsonLinesStore('right.jsonl', getBaseDir)
    const leftRecord = left.insert({ value: 'old-left' })
    const rightRecord = right.insert({ value: 'old-right' })
    await Promise.all([left.flush(), right.flush()])

    await runJsonLinesTransaction(dir, [left, right], () => {
      left.update(leftRecord.id, { value: 'new-left' })
      right.update(rightRecord.id, { value: 'new-right' })
    })
    assert.equal(left.getById(leftRecord.id).value, 'new-left')
    assert.equal(right.getById(rightRecord.id).value, 'new-right')

    await assert.rejects(
      runJsonLinesTransaction(dir, [left, right], () => {
        left.update(leftRecord.id, { value: 'invalid-left' })
        right.update(rightRecord.id, { value: 'invalid-right' })
        throw new Error('abort transaction')
      }),
      /abort transaction/,
    )
    assert.equal(left.getById(leftRecord.id).value, 'new-left')
    assert.equal(right.getById(rightRecord.id).value, 'new-right')

    const reloadedLeft = new JsonLinesStore('left.jsonl', getBaseDir)
    const reloadedRight = new JsonLinesStore('right.jsonl', getBaseDir)
    assert.equal(reloadedLeft.getById(leftRecord.id).value, 'new-left')
    assert.equal(reloadedRight.getById(rightRecord.id).value, 'new-right')
  })
})

test('JSONL transaction recovery completes a partially replaced multi-store commit', async () => {
  await withTempDir(async (dir) => {
    const stageLeft = `${jsonLinesTransactionFiles.stagePrefix}recovery-0`
    const stageRight = `${jsonLinesTransactionFiles.stagePrefix}recovery-1`
    await fs.writeFile(path.join(dir, 'left.jsonl'), '{"id":1,"value":"old-left"}\n')
    await fs.writeFile(path.join(dir, 'right.jsonl'), '{"id":1,"value":"old-right"}\n')
    await fs.writeFile(path.join(dir, stageLeft), '{"id":1,"value":"new-left"}\n')
    await fs.writeFile(path.join(dir, stageRight), '{"id":1,"value":"new-right"}\n')
    await fs.writeFile(
      path.join(dir, jsonLinesTransactionFiles.journal),
      JSON.stringify({
        version: 1,
        id: 'recovery',
        entries: [
          { target: 'left.jsonl', staged: stageLeft },
          { target: 'right.jsonl', staged: stageRight },
        ],
      }),
    )

    await fs.rename(path.join(dir, stageLeft), path.join(dir, 'left.jsonl'))
    assert.equal(recoverJsonLinesTransaction(dir), true)
    assert.match(await fs.readFile(path.join(dir, 'left.jsonl'), 'utf8'), /new-left/)
    assert.match(await fs.readFile(path.join(dir, 'right.jsonl'), 'utf8'), /new-right/)
    await assert.rejects(fs.stat(path.join(dir, jsonLinesTransactionFiles.journal)), {
      code: 'ENOENT',
    })
  })
})

test('asset metadata transaction recovery completes a partially replaced snapshot pair', async () => {
  await withTempDir(async (dir) => {
    const assetsStage = `${assetMetadataTransactionFiles.stagePrefix}recovery-assets`
    const stateStage = `${assetMetadataTransactionFiles.stagePrefix}recovery-state`
    const oldAssets = '{"id":1,"path":"old.jpg"}\n'
    const newAssets = '{"id":2,"path":"new.jpg"}\n'
    const oldState = '{"nextId":2}'
    const newState = '{"nextId":3,"sourceManifest":"new"}'
    const fingerprint = (contents) => ({
      bytes: Buffer.byteLength(contents),
      sha256: crypto.createHash('sha256').update(contents).digest('hex'),
    })
    await fs.writeFile(path.join(dir, 'assets.jsonl'), oldAssets)
    await fs.writeFile(path.join(dir, 'state.json'), oldState)
    await fs.writeFile(path.join(dir, assetsStage), newAssets)
    await fs.writeFile(path.join(dir, stateStage), newState)
    await fs.writeFile(
      path.join(dir, assetMetadataTransactionFiles.journal),
      JSON.stringify({
        version: 1,
        id: 'recovery-1234',
        entries: [
          { target: 'assets.jsonl', staged: assetsStage, ...fingerprint(newAssets) },
          { target: 'state.json', staged: stateStage, ...fingerprint(newState) },
        ],
      }),
    )

    await fs.rename(path.join(dir, assetsStage), path.join(dir, 'assets.jsonl'))
    assert.equal(recoverAssetMetadataTransaction(dir), true)
    assert.equal(await fs.readFile(path.join(dir, 'assets.jsonl'), 'utf8'), newAssets)
    assert.equal(await fs.readFile(path.join(dir, 'state.json'), 'utf8'), newState)
    await assert.rejects(fs.stat(path.join(dir, assetMetadataTransactionFiles.journal)), {
      code: 'ENOENT',
    })
  })
})

test('asset metadata transaction recovery completes a partially replaced archive snapshot', async () => {
  await withTempDir(async (dir) => {
    const assetsStage = `${assetMetadataTransactionFiles.stagePrefix}archive-recovery-assets`
    const stateStage = `${assetMetadataTransactionFiles.stagePrefix}archive-recovery-state`
    const archiveStage = `${assetMetadataTransactionFiles.stagePrefix}archive-recovery-overlay`
    const newAssets = '{"id":2,"path":"new.jpg"}\n'
    const newState = '{"nextId":3,"sourceManifest":"new"}'
    const newArchive = '{"version":1,"entries":[]}'
    const fingerprint = (contents) => ({
      bytes: Buffer.byteLength(contents),
      sha256: crypto.createHash('sha256').update(contents).digest('hex'),
    })
    await fs.writeFile(path.join(dir, 'assets.jsonl'), '{"id":1,"path":"old.jpg"}\n')
    await fs.writeFile(path.join(dir, 'state.json'), '{"nextId":2}')
    await fs.writeFile(
      path.join(dir, 'archived-assets.json'),
      '{"version":1,"entries":[{"path":"old.jpg","archivedAt":1}]}',
    )
    await fs.writeFile(path.join(dir, assetsStage), newAssets)
    await fs.writeFile(path.join(dir, stateStage), newState)
    await fs.writeFile(path.join(dir, archiveStage), newArchive)
    await fs.writeFile(
      path.join(dir, assetMetadataTransactionFiles.journal),
      JSON.stringify({
        version: 1,
        id: 'archive-recovery-1234',
        entries: [
          { target: 'assets.jsonl', staged: assetsStage, ...fingerprint(newAssets) },
          { target: 'state.json', staged: stateStage, ...fingerprint(newState) },
          {
            target: 'archived-assets.json',
            staged: archiveStage,
            ...fingerprint(newArchive),
          },
        ],
      }),
    )

    await fs.rename(path.join(dir, assetsStage), path.join(dir, 'assets.jsonl'))
    await fs.rename(path.join(dir, archiveStage), path.join(dir, 'archived-assets.json'))
    assert.equal(recoverAssetMetadataTransaction(dir), true)
    assert.equal(await fs.readFile(path.join(dir, 'assets.jsonl'), 'utf8'), newAssets)
    assert.equal(await fs.readFile(path.join(dir, 'state.json'), 'utf8'), newState)
    assert.equal(await fs.readFile(path.join(dir, 'archived-assets.json'), 'utf8'), newArchive)
    await assert.rejects(fs.stat(path.join(dir, assetMetadataTransactionFiles.journal)), {
      code: 'ENOENT',
    })
  })
})

test('asset metadata transaction recovery rejects tampered stages without replacing targets', async () => {
  await withTempDir(async (dir) => {
    const assetsStage = `${assetMetadataTransactionFiles.stagePrefix}tampered-assets`
    const stateStage = `${assetMetadataTransactionFiles.stagePrefix}tampered-state`
    const oldAssets = '{"id":1,"path":"old.jpg"}\n'
    const expectedAssets = '{"id":2,"path":"expected.jpg"}\n'
    const tamperedAssets = '{"id":3,"path":"tampered.jpg"}\n'
    const oldState = '{"nextId":2}'
    const newState = '{"nextId":3}'
    const fingerprint = (contents) => ({
      bytes: Buffer.byteLength(contents),
      sha256: crypto.createHash('sha256').update(contents).digest('hex'),
    })
    await fs.writeFile(path.join(dir, 'assets.jsonl'), oldAssets)
    await fs.writeFile(path.join(dir, 'state.json'), oldState)
    await fs.writeFile(path.join(dir, assetsStage), tamperedAssets)
    await fs.writeFile(path.join(dir, stateStage), newState)
    await fs.writeFile(
      path.join(dir, assetMetadataTransactionFiles.journal),
      JSON.stringify({
        version: 1,
        id: 'tampered-1234',
        entries: [
          { target: 'assets.jsonl', staged: assetsStage, ...fingerprint(expectedAssets) },
          { target: 'state.json', staged: stateStage, ...fingerprint(newState) },
        ],
      }),
    )

    assert.throws(() => recoverAssetMetadataTransaction(dir), /integrity verification/i)
    assert.equal(await fs.readFile(path.join(dir, 'assets.jsonl'), 'utf8'), oldAssets)
    assert.equal(await fs.readFile(path.join(dir, 'state.json'), 'utf8'), oldState)
    assert.equal(
      (await fs.stat(path.join(dir, assetMetadataTransactionFiles.journal))).isFile(),
      true,
    )
  })
})

test('asset metadata transaction recovery rejects a tampered archive stage before replacement', async () => {
  await withTempDir(async (dir) => {
    const assetsStage = `${assetMetadataTransactionFiles.stagePrefix}archive-tamper-assets`
    const stateStage = `${assetMetadataTransactionFiles.stagePrefix}archive-tamper-state`
    const archiveStage = `${assetMetadataTransactionFiles.stagePrefix}archive-tamper-overlay`
    const oldAssets = '{"id":1,"path":"old.jpg"}\n'
    const oldState = '{"nextId":2}'
    const oldArchive = '{"version":1,"entries":[]}'
    const newAssets = '{"id":2,"path":"new.jpg"}\n'
    const newState = '{"nextId":3}'
    const expectedArchive = '{"version":1,"entries":[{"path":"old.jpg","archivedAt":1}]}'
    const fingerprint = (contents) => ({
      bytes: Buffer.byteLength(contents),
      sha256: crypto.createHash('sha256').update(contents).digest('hex'),
    })
    await fs.writeFile(path.join(dir, 'assets.jsonl'), oldAssets)
    await fs.writeFile(path.join(dir, 'state.json'), oldState)
    await fs.writeFile(path.join(dir, 'archived-assets.json'), oldArchive)
    await fs.writeFile(path.join(dir, assetsStage), newAssets)
    await fs.writeFile(path.join(dir, stateStage), newState)
    await fs.writeFile(path.join(dir, archiveStage), '{"tampered":true}')
    await fs.writeFile(
      path.join(dir, assetMetadataTransactionFiles.journal),
      JSON.stringify({
        version: 1,
        id: 'archive-tamper-1234',
        entries: [
          { target: 'assets.jsonl', staged: assetsStage, ...fingerprint(newAssets) },
          { target: 'state.json', staged: stateStage, ...fingerprint(newState) },
          {
            target: 'archived-assets.json',
            staged: archiveStage,
            ...fingerprint(expectedArchive),
          },
        ],
      }),
    )

    assert.throws(() => recoverAssetMetadataTransaction(dir), /integrity verification/i)
    assert.equal(await fs.readFile(path.join(dir, 'assets.jsonl'), 'utf8'), oldAssets)
    assert.equal(await fs.readFile(path.join(dir, 'state.json'), 'utf8'), oldState)
    assert.equal(await fs.readFile(path.join(dir, 'archived-assets.json'), 'utf8'), oldArchive)
  })
})

test('asset metadata transaction recovery rejects targets outside the data directory', async () => {
  await withTempDir(async (dir) => {
    const assetsStage = `${assetMetadataTransactionFiles.stagePrefix}escape-assets`
    const stateStage = `${assetMetadataTransactionFiles.stagePrefix}escape-state`
    const contents = '{}'
    const fingerprint = {
      bytes: Buffer.byteLength(contents),
      sha256: crypto.createHash('sha256').update(contents).digest('hex'),
    }
    await fs.writeFile(path.join(dir, assetsStage), contents)
    await fs.writeFile(path.join(dir, stateStage), contents)
    await fs.writeFile(
      path.join(dir, assetMetadataTransactionFiles.journal),
      JSON.stringify({
        version: 1,
        id: 'escape-1234',
        entries: [
          { target: '..\\outside.jsonl', staged: assetsStage, ...fingerprint },
          { target: 'state.json', staged: stateStage, ...fingerprint },
        ],
      }),
    )

    assert.throws(() => recoverAssetMetadataTransaction(dir), /filename|target/i)
    await assert.rejects(fs.stat(path.resolve(dir, '..', 'outside.jsonl')), { code: 'ENOENT' })
  })
})

test('JSONL transaction recovery rejects paths outside its data directory', async () => {
  await withTempDir(async (dir) => {
    const staged = `${jsonLinesTransactionFiles.stagePrefix}escape-0`
    await fs.writeFile(path.join(dir, staged), '{"id":1}\n')
    await fs.writeFile(
      path.join(dir, jsonLinesTransactionFiles.journal),
      JSON.stringify({
        version: 1,
        id: 'escape',
        entries: [{ target: '..\\outside.jsonl', staged }],
      }),
    )
    assert.throws(() => recoverJsonLinesTransaction(dir), /Invalid JSONL transaction filename/)
    await assert.rejects(fs.stat(path.resolve(dir, '..', 'outside.jsonl')), { code: 'ENOENT' })
  })
})

test('JSONL transaction locks stores when preflight recovery fails', async () => {
  await withTempDir(async (dir) => {
    const store = new JsonLinesStore('records.jsonl', () => dir)
    const record = store.insert({ value: 'existing' })
    await store.flush()
    await fs.writeFile(
      path.join(dir, jsonLinesTransactionFiles.journal),
      JSON.stringify({ version: 99, entries: [] }),
    )

    await assert.rejects(
      runJsonLinesTransaction(dir, [store], () => store.update(record.id, { value: 'new' })),
      /cannot start because recovery failed/i,
    )
    assert.equal(store.getById(record.id).value, 'existing')
    assert.throws(() => store.update(record.id, { value: 'blocked' }), /restart is required/i)
  })
})

test('asset library initialization fails closed when a pending journal is invalid', async () => {
  await withTempDir(async (dir) => {
    const assetDir = path.join(dir, 'asset-library')
    await fs.mkdir(assetDir, { recursive: true })
    await fs.writeFile(
      path.join(assetDir, jsonLinesTransactionFiles.journal),
      JSON.stringify({ version: 99, entries: [] }),
    )

    initAssetLibraryService(dir)
    await assert.rejects(
      getAssetLibraryStats(),
      /pending metadata transaction could not be recovered/i,
    )
  })
})

test('asset library initialization fails closed when asset metadata recovery is invalid', async () => {
  await withTempDir(async (dir) => {
    const assetDir = path.join(dir, 'asset-library')
    await fs.mkdir(assetDir, { recursive: true })
    await fs.writeFile(
      path.join(assetDir, assetMetadataTransactionFiles.journal),
      JSON.stringify({ version: 99, entries: [] }),
    )

    initAssetLibraryService(dir)
    await assert.rejects(
      getAssetLibraryStats(),
      /pending asset metadata transaction could not be recovered/i,
    )
  })
})

test('asset library stats expose unavailable primary metadata without trusting partial counts', async () => {
  await withTempDir(async (dir) => {
    const assetDir = path.join(dir, 'asset-library')
    await fs.mkdir(assetDir, { recursive: true })
    await fs.writeFile(path.join(assetDir, 'state.json'), '{invalid-state', 'utf8')

    initAssetLibraryService(dir)
    const stats = await getAssetLibraryStats()
    assert.equal(stats.storageState, 'unavailable')
    assert.equal(stats.storageCorruptRows, 0)
    assert.match(stats.storageError, /invalid state\.json/i)
    assert.equal(stats.totalAssets, 0)
    assert.equal(stats.classifiedAssets, 0)
    assert.equal(stats.unclassifiedAssets, 0)
  })
})

test('JSONL transaction recovery verifies v2 staged content before replacing targets', async () => {
  await withTempDir(async (dir) => {
    const staged = `${jsonLinesTransactionFiles.stagePrefix}integrity-0`
    const targetPath = path.join(dir, 'records.jsonl')
    const stagedPath = path.join(dir, staged)
    await fs.writeFile(targetPath, '{"id":1,"value":"old"}\n')
    await fs.writeFile(stagedPath, '{"id":1,"value":"tampered"}\n')
    await fs.writeFile(
      path.join(dir, jsonLinesTransactionFiles.journal),
      JSON.stringify({
        version: 2,
        id: 'integrity',
        entries: [
          {
            target: 'records.jsonl',
            staged,
            bytes: 4,
            sha256: crypto.createHash('sha256').update('safe').digest('hex'),
          },
        ],
      }),
    )

    assert.throws(() => recoverJsonLinesTransaction(dir), /integrity verification/i)
    assert.match(await fs.readFile(targetPath, 'utf8'), /"old"/)
    assert.equal((await fs.stat(path.join(dir, jsonLinesTransactionFiles.journal))).isFile(), true)
  })
})

test('JSONL transaction recovery failure rolls memory back and locks affected stores', async () => {
  await withTempDir(async (dir) => {
    const getBaseDir = () => dir
    const leftPath = path.join(dir, 'left.jsonl')
    const rightPath = path.join(dir, 'right.jsonl')
    const left = new JsonLinesStore('left.jsonl', getBaseDir)
    const right = new JsonLinesStore('right.jsonl', getBaseDir)
    const leftRecord = left.insert({ value: 'old-left' })
    const rightRecord = right.insert({ value: 'old-right' })
    await Promise.all([left.flush(), right.flush()])

    await assert.rejects(
      runJsonLinesTransaction(dir, [left, right], async () => {
        left.update(leftRecord.id, { value: 'new-left' })
        right.update(rightRecord.id, { value: 'new-right' })
        await fs.rm(rightPath)
        await fs.mkdir(rightPath)
      }),
      /asset data is locked/i,
    )

    assert.equal(left.getById(leftRecord.id).value, 'old-left')
    assert.equal(right.getById(rightRecord.id).value, 'old-right')
    assert.throws(() => left.update(leftRecord.id, { value: 'blocked' }), /restart is required/i)
    assert.equal((await fs.stat(path.join(dir, jsonLinesTransactionFiles.journal))).isFile(), true)
    assert.match(await fs.readFile(leftPath, 'utf8'), /new-left/)
  })
})

test('asset library backups are verified, rate limited, and retained', async () => {
  await withTempDir(async (dir) => {
    const assetDir = path.join(dir, 'asset-library')
    await fs.mkdir(path.join(assetDir, 'search-feedback'), { recursive: true })
    await fs.writeFile(path.join(assetDir, 'assets.jsonl'), '{"id":1,"path":"a.jpg"}\n')
    await fs.writeFile(path.join(assetDir, 'categories.jsonl'), '{"id":1,"name":"A"}\n')
    await fs.writeFile(path.join(assetDir, 'asset-catalog.sqlite'), 'derived')
    await fs.writeFile(path.join(assetDir, 'search-feedback', 'state.json'), '{"revision":1}')

    const first = await createAssetLibraryBackupIfDue(assetDir, {
      now: 1_000,
      minimumIntervalMs: 0,
      maxBackups: 2,
    })
    assert.equal(first.created, true)
    assert.equal((await verifyAssetLibraryBackup(first.backupPath)).ok, true)
    await assert.rejects(fs.stat(path.join(first.backupPath, 'asset-catalog.sqlite')), {
      code: 'ENOENT',
    })

    const skipped = await createAssetLibraryBackupIfDue(assetDir, {
      now: 1_500,
      minimumIntervalMs: 1_000,
      maxBackups: 2,
    })
    assert.equal(skipped.skippedReason, 'not-due')

    const second = await createAssetLibraryBackupIfDue(assetDir, {
      now: 2_000,
      minimumIntervalMs: 0,
      maxBackups: 2,
    })
    const third = await createAssetLibraryBackupIfDue(assetDir, {
      now: 3_000,
      minimumIntervalMs: 0,
      maxBackups: 2,
    })
    assert.equal(second.created, true)
    assert.equal(third.created, true)
    const backups = (await fs.readdir(path.join(dir, 'asset-library-backups'))).filter((name) =>
      name.startsWith('backup-'),
    )
    assert.equal(backups.length, 2)

    await fs.writeFile(path.join(third.backupPath, 'assets.jsonl'), 'tampered')
    const verification = await verifyAssetLibraryBackup(third.backupPath)
    assert.equal(verification.ok, false)
    assert.match(verification.error, /failed verification/i)
  })
})

test('asset library backups expose safe ids and restore an exact metadata snapshot', async () => {
  await withTempDir(async (dir) => {
    const assetDir = path.join(dir, 'asset-library')
    await fs.mkdir(path.join(assetDir, 'search-feedback'), { recursive: true })
    await fs.writeFile(
      path.join(assetDir, 'assets.jsonl'),
      '{"id":1,"path":"a.jpg","note":"before"}\n',
    )
    await fs.writeFile(path.join(assetDir, 'state.json'), '{"nextId":2}')
    await fs.writeFile(path.join(assetDir, 'search-feedback', 'state.json'), '{"revision":1}')

    const created = await createAssetLibraryBackupIfDue(assetDir, {
      now: 4_000,
      minimumIntervalMs: 0,
      reason: 'manual',
    })
    assert.equal(created.created, true)
    const summaries = await listAssetLibraryBackups(assetDir)
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0].id, path.basename(created.backupPath))
    assert.equal(summaries[0].reason, 'manual')
    assert.equal((await verifyAssetLibraryBackupById(assetDir, summaries[0].id)).ok, true)
    await assert.rejects(
      verifyAssetLibraryBackupById(assetDir, '..\\escape'),
      /Invalid.*backup id/i,
    )

    await fs.writeFile(
      path.join(assetDir, 'assets.jsonl'),
      '{"id":2,"path":"b.jpg","note":"after"}\n',
    )
    await fs.writeFile(path.join(assetDir, 'reference_embeddings.jsonl'), '{"id":1,"stale":true}\n')
    await fs.writeFile(path.join(assetDir, 'search-feedback', 'extra.json'), '{"stale":true}')
    await fs.writeFile(path.join(assetDir, 'asset-catalog.sqlite'), 'derived')

    const restored = await restoreAssetLibraryBackup(assetDir, summaries[0].id)
    assert.equal(restored.restoredFiles, 3)
    assert.match(await fs.readFile(path.join(assetDir, 'assets.jsonl'), 'utf8'), /before/)
    assert.equal(
      await fs.readFile(path.join(assetDir, 'search-feedback', 'state.json'), 'utf8'),
      '{"revision":1}',
    )
    await assert.rejects(fs.stat(path.join(assetDir, 'reference_embeddings.jsonl')), {
      code: 'ENOENT',
    })
    await assert.rejects(fs.stat(path.join(assetDir, 'search-feedback', 'extra.json')), {
      code: 'ENOENT',
    })
    await assert.rejects(fs.stat(path.join(assetDir, 'asset-catalog.sqlite')), { code: 'ENOENT' })
    await assert.rejects(fs.stat(path.join(assetDir, assetLibraryRestoreFiles.journal)), {
      code: 'ENOENT',
    })
  })
})

test('asset library restore recovery finishes an interrupted verified replacement', async () => {
  await withTempDir(async (dir) => {
    const assetDir = path.join(dir, 'asset-library')
    await fs.mkdir(assetDir, { recursive: true })
    const contents = '{"id":1,"path":"recovered.jpg"}\n'
    const restoreId = crypto.randomBytes(16).toString('hex')
    const staged = `${assetLibraryRestoreFiles.stagePrefix}${restoreId}-0`
    await fs.writeFile(path.join(assetDir, 'assets.jsonl'), '{"id":1,"path":"old.jpg"}\n')
    await fs.writeFile(path.join(assetDir, staged), contents)
    await fs.writeFile(
      path.join(assetDir, assetLibraryRestoreFiles.journal),
      JSON.stringify({
        version: 1,
        id: restoreId,
        backupId: 'backup-recovery-test',
        createdAt: Date.now(),
        entries: [
          {
            operation: 'replace',
            target: 'assets.jsonl',
            staged,
            bytes: Buffer.byteLength(contents),
            sha256: crypto.createHash('sha256').update(contents).digest('hex'),
          },
        ],
      }),
    )

    assert.equal(recoverAssetLibraryRestore(assetDir), true)
    assert.equal(await fs.readFile(path.join(assetDir, 'assets.jsonl'), 'utf8'), contents)
    await assert.rejects(fs.stat(path.join(assetDir, assetLibraryRestoreFiles.journal)), {
      code: 'ENOENT',
    })
  })
})

test('asset library restore recovery rejects tampered stages without replacing targets', async () => {
  await withTempDir(async (dir) => {
    const assetDir = path.join(dir, 'asset-library')
    await fs.mkdir(assetDir, { recursive: true })
    const restoreId = crypto.randomBytes(16).toString('hex')
    const staged = `${assetLibraryRestoreFiles.stagePrefix}${restoreId}-0`
    const target = path.join(assetDir, 'assets.jsonl')
    await fs.writeFile(target, '{"id":1,"path":"safe.jpg"}\n')
    await fs.writeFile(path.join(assetDir, staged), 'tampered')
    await fs.writeFile(
      path.join(assetDir, assetLibraryRestoreFiles.journal),
      JSON.stringify({
        version: 1,
        id: restoreId,
        backupId: 'backup-recovery-test',
        createdAt: Date.now(),
        entries: [
          {
            operation: 'replace',
            target: 'assets.jsonl',
            staged,
            bytes: 4,
            sha256: crypto.createHash('sha256').update('safe').digest('hex'),
          },
        ],
      }),
    )

    assert.throws(() => recoverAssetLibraryRestore(assetDir), /failed verification/i)
    assert.match(await fs.readFile(target, 'utf8'), /safe/)
    assert.equal(
      (await fs.stat(path.join(assetDir, assetLibraryRestoreFiles.journal))).isFile(),
      true,
    )
  })
})

test('asset library initialization fails closed when a restore journal escapes its data root', async () => {
  await withTempDir(async (dir) => {
    const assetDir = path.join(dir, 'asset-library')
    await fs.mkdir(assetDir, { recursive: true })
    const restoreId = crypto.randomBytes(16).toString('hex')
    await fs.writeFile(
      path.join(assetDir, assetLibraryRestoreFiles.journal),
      JSON.stringify({
        version: 1,
        id: restoreId,
        backupId: 'backup-invalid-test',
        createdAt: Date.now(),
        entries: [{ operation: 'delete', target: '..\\outside.jsonl' }],
      }),
    )

    initAssetLibraryService(dir)
    await assert.rejects(getAssetLibraryStats(), /pending backup restore could not be recovered/i)
    await assert.rejects(fs.stat(path.join(dir, 'outside.jsonl')), { code: 'ENOENT' })
  })
})

test('service restore creates a protective backup and reloads restored stores', async () => {
  await withTempDir(async (dir) => {
    const assetDir = path.join(dir, 'asset-library')
    await fs.mkdir(assetDir, { recursive: true })
    await fs.writeFile(
      path.join(assetDir, 'assets.jsonl'),
      `${JSON.stringify({
        id: 1,
        path: path.join(dir, 'a.jpg'),
        kind: 'image',
        source: 'manual',
        width: 1,
        height: 1,
        fileSize: 1,
        modifiedTime: 1,
        missing: false,
        createdAt: 1,
        updatedAt: 1,
      })}\n`,
    )
    await fs.writeFile(path.join(assetDir, 'state.json'), '{"nextId":2}')
    await fs.writeFile(path.join(assetDir, 'categories.jsonl'), '{"id":1,"name":"baseline"}\n')

    initAssetLibraryService(dir)
    await getAssetLibraryStats()
    const backup = await createAssetLibraryMetadataBackup()
    assert.equal(backup.ok, true)
    await createAssetCategory({ name: 'later' })
    assert.equal(
      listAssetCategories().some((category) => category.name === 'later'),
      true,
    )

    const restored = await restoreAssetLibraryMetadataBackup(backup.backup.id)
    assert.equal(restored.ok, true)
    assert.match(restored.protectiveBackupId, /^backup-/)
    assert.deepEqual(
      listAssetCategories().map((category) => category.name),
      ['baseline'],
    )
    const backups = await listAssetLibraryBackups(assetDir)
    assert.equal(
      backups.some((item) => item.reason === 'pre_restore'),
      true,
    )
  })
})

test('undo accept removes only AI-generated relations and restores the suggestion', () => {
  const now = 500
  const suggestion = (overrides) => ({
    id: 1,
    assetId: 10,
    categoryId: 3,
    confidence: 0.9,
    source: 'reference_image',
    status: 'confirmed',
    evidenceAssetIds: [],
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  })
  const assignment = (overrides) => ({
    id: 1,
    assetId: 10,
    categoryId: 3,
    confidence: 0.9,
    source: 'reference_image',
    status: 'confirmed',
    confirmedByUser: true,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  })
  const result = undoSuggestionReviewState(
    [1, 2],
    [
      suggestion({}),
      suggestion({
        id: 2,
        assetId: 20,
        categoryId: undefined,
        tagId: 7,
        source: 'text_label',
      }),
    ],
    [
      assignment({}),
      assignment({ id: 2, source: 'manual', status: 'manual_override' }),
      assignment({ id: 3, suggestionId: 99 }),
    ],
    [
      {
        id: 1,
        assetId: 20,
        tagId: 7,
        confidence: 0.8,
        source: 'text_label',
        status: 'confirmed',
        confirmedByUser: true,
        createdAt: 100,
        updatedAt: 100,
      },
    ],
    now,
  )

  assert.equal(result.found, 2)
  assert.deepEqual(
    result.suggestions.map((item) => [item.status, item.updatedAt]),
    [
      ['suggested', now],
      ['suggested', now],
    ],
  )
  assert.equal(result.categoryAssignments.length, 2)
  assert.deepEqual(
    result.categoryAssignments.map((item) => [item.id, item.source, item.suggestionId]),
    [
      [2, 'manual', undefined],
      [3, 'reference_image', 99],
    ],
  )
  assert.equal(result.tagAssignments.length, 0)
})

test('compressed clustering keeps distinct groups and leaves low-similarity outliers ungrouped', async () => {
  const bucket = (assetIds, values) => ({
    count: assetIds.length,
    assetIds,
    sum: Float64Array.from(values, (value) => value * assetIds.length),
  })
  const progress = []
  const result = await clusterCompressedAssetBuckets(
    [
      bucket([1, 2], [1, 0]),
      bucket([3], [0.99, 0.1]),
      bucket([4, 5], [-1, 0]),
      bucket([6], [-0.99, -0.1]),
      bucket([7], [0, 1]),
    ],
    {
      maxClusters: 2,
      minSimilarity: 0.8,
      iterations: 3,
      onProgress: (value) => progress.push(value),
    },
  )

  assert.equal(result.clusters.length, 2)
  assert.equal(result.unclusteredAssets, 1)
  assert.deepEqual(
    result.clusters
      .map((cluster) => cluster.members.map((member) => member.assetId).sort((a, b) => a - b))
      .sort((left, right) => left[0] - right[0]),
    [
      [1, 2, 3],
      [4, 5, 6],
    ],
  )
  assert.ok(result.clusters.every((cluster) => cluster.avgSimilarity > 0.99))
  assert.equal(progress.at(-1), 1)
})

test('exact cluster purity rejects a visually different member after coarse routing', () => {
  const centroid = Float32Array.from([1, 0, 0])
  const matching = scoreClusterPurity(Float32Array.from([0.98, 0.1, 0]), centroid, 0.72)
  const mixed = scoreClusterPurity(Float32Array.from([0.2, 0.98, 0]), centroid, 0.72)

  assert.equal(matching.accepted, true)
  assert.ok(matching.similarity > 0.99)
  assert.equal(mixed.accepted, false)
  assert.ok(mixed.similarity < 0.25)
})

test('adaptive clustering requests more groups for a diverse library than a concentrated one', () => {
  const diverse = Array.from({ length: 128 }, () => ({ count: 100 }))
  const concentrated = [{ count: 12_000 }, ...Array.from({ length: 127 }, () => ({ count: 6 }))]
  const diverseCount = estimateAdaptiveClusterCount(diverse, {
    minClusterSize: 5,
    maxClusters: 256,
  })
  const concentratedCount = estimateAdaptiveClusterCount(concentrated, {
    minClusterSize: 5,
    maxClusters: 256,
  })

  assert.ok(diverseCount > concentratedCount)
  assert.ok(diverseCount <= 128)
  assert.ok(concentratedCount >= 2)
})

test('multi-center routing keeps alternate visual centers for exact purity scoring', () => {
  const candidates = approximateCentroidCandidates(
    Float64Array.from([0.1, 0.95, 0, 0]),
    [
      Float32Array.from([1, 0, 0, 0]),
      Float32Array.from([0, 1, 0, 0]),
      Float32Array.from([-1, 0, 0, 0]),
    ],
    2,
    4,
  )

  assert.equal(candidates[0], 1)
  assert.ok(candidates.includes(0))
})

test('cluster labels retain one semantic label from each label dimension', () => {
  const textVectors = new Map(
    CLUSTER_LABEL_CANDIDATES.map((candidate) => [candidate.prompt, Float32Array.from([-1, 0])]),
  )
  for (const label of ['photo', 'cat', 'indoor', 'colorful']) {
    const candidate = CLUSTER_LABEL_CANDIDATES.find((item) => item.label === label)
    textVectors.set(candidate.prompt, Float32Array.from([1, 0]))
  }
  const labels = rankClusterLabels([Float32Array.from([1, 0])], textVectors, 4)

  assert.deepEqual(labels, ['photo', 'cat', 'indoor', 'colorful'])
})

test('cluster labels expose detailed real-person photography concepts', () => {
  const textVectors = new Map(
    CLUSTER_LABEL_CANDIDATES.map((candidate) => [candidate.prompt, Float32Array.from([-1, 0])]),
  )
  const expected = ['portrait photo', 'fashion model', 'photo studio', 'beauty portrait', 'cosplay']
  for (const label of expected) {
    const candidate = CLUSTER_LABEL_CANDIDATES.find((item) => item.label === label)
    assert.ok(candidate, `missing label candidate: ${label}`)
    textVectors.set(candidate.prompt, Float32Array.from([1, 0]))
  }
  const woman = CLUSTER_LABEL_CANDIDATES.find((item) => item.label === 'woman')
  textVectors.set(woman.prompt, Float32Array.from([1, 0]))

  const labels = rankClusterLabels([Float32Array.from([1, 0])], textVectors, 6)
  assert.deepEqual(labels, ['fashion model', 'portrait photo', 'woman', ...expected.slice(2)])
})

test('cluster labels suppress human photography genres without human evidence', () => {
  const textVectors = new Map(
    CLUSTER_LABEL_CANDIDATES.map((candidate) => [candidate.prompt, Float32Array.from([-1, 0])]),
  )
  const icon = CLUSTER_LABEL_CANDIDATES.find((item) => item.label === 'icon')
  const wedding = CLUSTER_LABEL_CANDIDATES.find((item) => item.label === 'wedding portrait')
  const commercial = CLUSTER_LABEL_CANDIDATES.find((item) => item.label === 'commercial model')
  textVectors.set(icon.prompt, Float32Array.from([1, 0]))
  textVectors.set(wedding.prompt, Float32Array.from([0.99, 0.1]))
  textVectors.set(commercial.prompt, Float32Array.from([0.99, -0.1]))

  const labels = rankClusterLabels([Float32Array.from([1, 0])], textVectors, 6)
  assert.deepEqual(labels, ['icon'])
})

test('per-image semantic classifier creates a real model match from positive human evidence', () => {
  const embeddings = new Map()
  for (const prompt of SEMANTIC_PERSON_HUMAN_PROMPTS) embeddings.set(prompt, [1, 0, 0])
  for (const prompt of SEMANTIC_PERSON_NON_HUMAN_PROMPTS) embeddings.set(prompt, [0, 1, 0])
  for (const definition of SEMANTIC_PERSON_CLASSES) {
    for (const prompt of definition.prompts) embeddings.set(prompt, [-1, 0, 0])
  }
  const model = SEMANTIC_PERSON_CLASSES.find((definition) => definition.key === 'model_portraits')
  for (const prompt of model.prompts) embeddings.set(prompt, [1, 0, 0])

  const match = classifySemanticPerson(
    Float32Array.from([1, 0, 0]),
    buildSemanticPersonClassifier(embeddings),
  )
  assert.equal(match?.key, 'model_portraits')
  assert.equal(match?.label, 'Real model photos')
  assert.ok(match.margin > 0.9)
})

test('per-image semantic classifier rejects icons before subtype classification', () => {
  const embeddings = new Map()
  for (const prompt of SEMANTIC_PERSON_HUMAN_PROMPTS) embeddings.set(prompt, [1, 0, 0])
  for (const prompt of SEMANTIC_PERSON_NON_HUMAN_PROMPTS) embeddings.set(prompt, [0, 1, 0])
  for (const definition of SEMANTIC_PERSON_CLASSES) {
    for (const prompt of definition.prompts) embeddings.set(prompt, [1, 0, 0])
  }

  const match = classifySemanticPerson(
    Float32Array.from([0, 1, 0]),
    buildSemanticPersonClassifier(embeddings),
  )
  assert.equal(match, null)
})

test('CLIP cache reader maps requested paths to random-access vector rows', async () => {
  await withTempDir(async (dir) => {
    const cacheDir = path.join(dir, 'embedding-cache')
    await fs.mkdir(cacheDir, { recursive: true })
    const base = 'clip_vit_base_patch32__global'
    const vectors = [1, 2, 3, 4, 5, 6]
    const encoded = Buffer.allocUnsafe(vectors.length * 2)
    vectors.forEach((value, index) => encoded.writeUInt16LE(float32ToFloat16(value), index * 2))
    const pathsContent = `${JSON.stringify({ row: 0, path: 'C:\\one.png' })}\n${JSON.stringify({ row: 1, path: 'D:\\two.png' })}\n`
    await fs.writeFile(path.join(cacheDir, `${base}.paths.jsonl`), pathsContent)
    await fs.writeFile(path.join(cacheDir, `${base}.f16`), encoded)
    // Version-3 derived metas carry the committed content proof (VAL-038).
    const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
    await fs.writeFile(
      path.join(cacheDir, `${base}.f16.json`),
      JSON.stringify({
        version: EMBEDDING_F16_CACHE_VERSION,
        dim: 3,
        count: 2,
        integrity: {
          vectorsSha256: sha256(encoded),
          pathsSha256: sha256(Buffer.from(pathsContent, 'utf8')),
        },
      }),
    )

    const loaded = await loadClipEmbeddingsForPaths(dir, ['D:\\two.png'])
    const vector = loaded.get(path.resolve('D:\\two.png').toLowerCase())
    assert.ok(vector, 'expected vector for D:\\two.png')
    assert.equal(vector.length, 3)
    const expectedVector = [4, 5, 6].map((value) => value / Math.sqrt(77))
    for (const [index, expected] of expectedVector.entries()) {
      assert.ok(
        Math.abs(vector[index] - expected) < 1e-3,
        `element ${index}: expected ~${expected}, got ${vector[index]}`,
      )
    }
  })
})

test('CLIP cache streaming only emits requested asset vectors', async () => {
  await withTempDir(async (dir) => {
    const cacheDir = path.join(dir, 'embedding-cache')
    await fs.mkdir(cacheDir, { recursive: true })
    const base = 'clip_vit_base_patch32__global'
    const vectors = [1, 2, 3, 4, 5, 6]
    const encoded = Buffer.allocUnsafe(vectors.length * 2)
    vectors.forEach((value, index) => encoded.writeUInt16LE(float32ToFloat16(value), index * 2))
    const pathsContent = `${JSON.stringify({ row: 0, path: 'C:\\one.png' })}\n${JSON.stringify({ row: 1, path: 'D:\\two.png' })}\n`
    await fs.writeFile(path.join(cacheDir, `${base}.paths.jsonl`), pathsContent)
    await fs.writeFile(path.join(cacheDir, `${base}.f16`), encoded)
    // Version-3 derived metas carry the committed content proof (VAL-038).
    const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
    await fs.writeFile(
      path.join(cacheDir, `${base}.f16.json`),
      JSON.stringify({
        version: EMBEDDING_F16_CACHE_VERSION,
        dim: 3,
        count: 2,
        integrity: {
          vectorsSha256: sha256(encoded),
          pathsSha256: sha256(Buffer.from(pathsContent, 'utf8')),
        },
      }),
    )

    const emitted = []
    const found = await streamClipEmbeddingsForPaths(dir, new Map([['D:\\two.png', 42]]), {
      onVector: (assetId, vector) => emitted.push([assetId, Array.from(vector)]),
    })
    assert.equal(found, 1)
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0][0], 42)
    const expectedVector = [4, 5, 6].map((value) => value / Math.sqrt(77))
    for (const [index, expected] of expectedVector.entries()) {
      assert.ok(
        Math.abs(emitted[0][1][index] - expected) < 1e-3,
        `element ${index}: expected ~${expected}, got ${emitted[0][1][index]}`,
      )
    }
  })
})

test('semantic refinement creates distinct CLIP centers and respects the split cap', () => {
  const seeds = []
  observeSemanticSeed(seeds, Float32Array.from([1, 0]), 0.86, 2)
  observeSemanticSeed(seeds, Float32Array.from([0.99, 0.1]), 0.86, 2)
  assert.equal(seeds.length, 1)

  observeSemanticSeed(seeds, Float32Array.from([-1, 0]), 0.86, 2)
  observeSemanticSeed(seeds, Float32Array.from([0, -1]), 0.86, 2)
  assert.equal(seeds.length, 2)
  assert.equal(bestSemanticSeed(Float32Array.from([-0.9, 0.1]), seeds).index, 1)
})

test('cluster request guard keeps bounded unique scopes and adaptive mode', () => {
  const request = assetGuards.normalizeClusterRequest({
    autoClusters: true,
    scopePaths: ['C:\\Pictures', 'C:\\Pictures', 'D:\\Assets'],
    semanticRefine: true,
    semanticSimilarity: 0.86,
    semanticMaxSplits: 4,
  })

  assert.equal(request.autoClusters, true)
  assert.deepEqual(request.scopePaths, ['C:\\Pictures', 'D:\\Assets'])
  assert.equal(request.semanticRefine, true)
  assert.equal(request.semanticSimilarity, 0.86)
  assert.equal(request.semanticMaxSplits, 4)
})

test('category cluster request guard bounds search controls and de-duplicates scopes', () => {
  const request = assetGuards.normalizeCategoryClusterRequest({
    categoryId: 7,
    topK: 999999,
    minScore: -3,
    includeReviewed: true,
    scopePaths: ['C:\\Pictures', 'C:\\Pictures', 'D:\\Assets'],
  })

  assert.equal(request.categoryId, 7)
  assert.equal(request.topK, 5000)
  assert.equal(request.minScore, 0)
  assert.equal(request.includeReviewed, true)
  assert.deepEqual(request.scopePaths, ['C:\\Pictures', 'D:\\Assets'])
  assert.throws(
    () => assetGuards.normalizeCategoryClusterRequest({ categoryId: 0 }),
    /Invalid category id/,
  )
})
