const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { DatabaseSync } = require('node:sqlite')
const { loadTsModule } = require('./guard-utils.cjs')

const worker = loadTsModule('electron/imageSearchDataCatalogWorker.ts')
const pathUtils = loadTsModule('electron/imageSearchDataPathUtils.ts')
const catalogService = loadTsModule('electron/imageSearchDataCatalogService.ts')

const temporaryRoots = []

function source(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8')
}

function embeddingRow(imageId, modelName) {
  return JSON.stringify({
    imageId,
    modelName,
    modelVersion: 'test',
    embeddingType: 'global',
    dim: 2,
    vector: [1, 0],
    norm: 1,
    createdAt: 1,
    updatedAt: 1,
  })
}

function catalogFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-data-catalog-'))
  temporaryRoots.push(root)
  const generation = 'test-generation'
  const catalogRoot = path.join(root, 'image-search-data-catalog')
  const generationDir = path.join(catalogRoot, 'generations', generation)
  fs.mkdirSync(generationDir, { recursive: true })
  const vectorRoot = path.join(root, 'vector-db', 'embeddings')
  fs.mkdirSync(vectorRoot, { recursive: true })
  const dinoPath = path.join(vectorRoot, 'dinov2_vitb14__global.jsonl')
  const clipPath = path.join(vectorRoot, 'clip_vit_base_patch32__global.jsonl')
  const imageA = 'D:\\dataset\\images\\a.jpg'
  const imageB = 'D:\\dataset\\images\\b.jpg'
  const nativeOnly = 'D:\\dataset\\images\\native-only.jpg'
  const vectorOnly = 'D:\\dataset\\images\\vector-only.jpg'
  fs.writeFileSync(
    dinoPath,
    [
      embeddingRow(imageA, 'dinov2_vitb14'),
      embeddingRow(imageA, 'dinov2_vitb14'),
      embeddingRow(imageB, 'dinov2_vitb14'),
      embeddingRow(vectorOnly, 'dinov2_vitb14'),
      '{malformed',
    ].join('\n') + '\n',
  )
  fs.writeFileSync(
    clipPath,
    [
      embeddingRow(imageA, 'clip_vit_base_patch32'),
      embeddingRow(imageB, 'clip_vit_base_patch32'),
      embeddingRow(vectorOnly, 'clip_vit_base_patch32'),
    ].join('\n') + '\n',
  )
  const vectorSource = (filePath, layer) => {
    const stat = fs.statSync(filePath)
    const physicalKey = path.relative(root, filePath).replace(/\\/g, '/')
    return {
      sourceId: `${layer}-source`,
      filePath,
      physicalKey,
      logicalName: physicalKey,
      layer,
      sizeBytes: stat.size,
      modifiedAt: stat.mtimeMs,
    }
  }
  return {
    root,
    generation,
    catalogRoot,
    generationDir,
    databasePath: path.join(generationDir, 'catalog.sqlite'),
    metadataPath: path.join(generationDir, 'build.json'),
    imageA,
    imageB,
    nativeOnly,
    vectorOnly,
    input: {
      taskId: 'test-task',
      generation,
      databasePath: path.join(generationDir, 'catalog.sqlite'),
      buildMetadataPath: path.join(generationDir, 'build.json'),
      roots: ['D:\\dataset\\images'],
      nativeRecords: [imageA, imageB, nativeOnly].map((filePath) => ({
        path: filePath,
        width: 100,
        height: 100,
        fileSize: 10,
        modifiedTime: 1,
        exists: true,
      })),
      nativeSource: {
        sourceId: 'native-index',
        physicalKey: 'image-search-index',
        logicalName: 'image-search-index',
        sizeBytes: 123,
        modifiedAt: 1,
      },
      vectorSources: [vectorSource(dinoPath, 'dino'), vectorSource(clipPath, 'clip')],
      sourceSnapshot: JSON.stringify({ version: 1, nativeRevision: 'test', vectors: [] }),
    },
  }
}

function refreshedVectorSources(sources) {
  return sources.map((source) => {
    const stat = fs.statSync(source.filePath)
    return { ...source, sizeBytes: stat.size, modifiedAt: stat.mtimeMs }
  })
}

function nextCatalogInput(fixture, generation, options = {}) {
  const generationDir = path.join(fixture.catalogRoot, 'generations', generation)
  fs.mkdirSync(generationDir, { recursive: true })
  const vectorSources = refreshedVectorSources(fixture.input.vectorSources)
  return {
    ...fixture.input,
    generation,
    taskId: `task-${generation}`,
    databasePath: path.join(generationDir, 'catalog.sqlite'),
    buildMetadataPath: path.join(generationDir, 'build.json'),
    nativeRecords: (options.nativeRecords || fixture.input.nativeRecords).map((record) => ({
      ...record,
    })),
    vectorSources,
    sourceSnapshot: JSON.stringify({
      version: 2,
      nativeRevision: 'test',
      vectors: vectorSources.map((source) => ({
        physicalKey: source.physicalKey,
        layer: source.layer,
        sizeBytes: source.sizeBytes,
        modifiedAt: source.modifiedAt,
      })),
    }),
    ...(options.previousDatabasePath
      ? { previousDatabasePath: options.previousDatabasePath }
      : {}),
  }
}

function comparableSummary(summary) {
  return Object.fromEntries(
    Object.entries(summary).filter(([key]) => key !== 'generation' && key !== 'builtAt'),
  )
}

test.afterEach(() => {
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop(), { recursive: true, force: true })
  }
})

test('catalog worker builds a Native/DINO/CLIP union and exact folder anomaly rollup', async () => {
  const fixture = catalogFixture()
  const stopView = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  const progress = []
  const result = await worker.runImageSearchDataCatalogBuild(fixture.input, stopView, (update) =>
    progress.push(update),
  )

  assert.equal(result.summary.unionPathCount, 4)
  assert.equal(result.summary.nativeUniqueCount, 3)
  assert.equal(result.summary.dinoUniqueCount, 3)
  assert.equal(result.summary.clipUniqueCount, 3)
  assert.equal(result.summary.completeCount, 2)
  assert.equal(result.summary.missingDinoCount, 1)
  assert.equal(result.summary.missingClipCount, 1)
  assert.equal(result.summary.vectorOnlyCount, 1)
  assert.equal(result.summary.duplicateRows, 1)
  assert.equal(result.summary.malformedRows, 1)
  assert.equal(result.summary.folderCount, 1)
  assert.equal(fs.existsSync(fixture.metadataPath), true)
  assert.equal(
    progress.some((item) => item.stage === 'folders'),
    true,
  )

  const database = new DatabaseSync(fixture.databasePath, { readOnly: true })
  try {
    const folder = database.prepare('SELECT * FROM folder_rollups').get()
    assert.equal(folder.display_path, 'D:\\dataset\\images')
    assert.equal(folder.native_count, 3)
    assert.equal(folder.dino_count, 3)
    assert.equal(folder.clip_count, 3)
    assert.equal(folder.missing_dino, 1)
    assert.equal(folder.missing_clip, 1)
    assert.equal(folder.vector_only, 1)
    assert.equal(folder.duplicate_rows, 1)

    const dino = database.prepare("SELECT * FROM source_files WHERE layer = 'dino'").get()
    assert.equal(dino.record_count, 5)
    assert.equal(dino.unique_count, 3)
    assert.equal(dino.malformed_count, 1)
    assert.equal(dino.duplicate_count, 1)
    assert.match(dino.fingerprint, /^[a-f0-9]{64}$/)
  } finally {
    database.close()
  }
})

test('catalog append-tail generation matches a clean full rebuild and reuses unchanged shards', async () => {
  const fixture = catalogFixture()
  const stopView = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  const initial = await worker.runImageSearchDataCatalogBuild(fixture.input, stopView)
  assert.equal(initial.buildMode, 'full')

  const dinoSource = fixture.input.vectorSources.find((source) => source.layer === 'dino')
  const appendedPath = fixture.nativeOnly
  const deepPath = 'D:\\dataset\\images\\new\\deep\\tail.jpg'
  fs.appendFileSync(
    dinoSource.filePath,
    [
      embeddingRow(appendedPath, 'dinov2_vitb14'),
      embeddingRow(deepPath, 'dinov2_vitb14'),
      embeddingRow(fixture.imageA, 'dinov2_vitb14'),
      '{malformed-tail',
    ].join('\n') + '\n',
  )

  const incrementalInput = nextCatalogInput(fixture, 'incremental-generation', {
    previousDatabasePath: fixture.databasePath,
  })
  const incremental = await worker.runImageSearchDataCatalogBuild(
    incrementalInput,
    stopView,
  )
  assert.equal(incremental.buildMode, 'incremental')
  assert.equal(incremental.reusedSourceCount, 1)
  assert.equal(incremental.fullBytesRead, 0)
  assert.ok(incremental.tailBytesRead > 0)
  assert.ok(incremental.changedPathCount >= 2)

  const fullInput = nextCatalogInput(fixture, 'comparison-full-generation')
  const full = await worker.runImageSearchDataCatalogBuild(fullInput, stopView)
  assert.equal(full.buildMode, 'full')
  assert.deepEqual(comparableSummary(incremental.summary), comparableSummary(full.summary))
  assert.equal(incremental.catalogSha256, full.catalogSha256)
  assert.equal(incremental.summary.malformedRows, 2)
  assert.equal(incremental.summary.duplicateRows, 2)
  assert.equal(incremental.summary.missingDinoCount, 0)

  const incrementalDatabase = new DatabaseSync(incrementalInput.databasePath, {
    readOnly: true,
  })
  const fullDatabase = new DatabaseSync(fullInput.databasePath, { readOnly: true })
  try {
    const incrementalSources = incrementalDatabase
      .prepare(
        `SELECT source_id, fingerprint, record_count, unique_count, malformed_count,
                duplicate_count, namespace_count, single_namespace
           FROM source_files ORDER BY source_order`,
      )
      .all()
    const fullSources = fullDatabase
      .prepare(
        `SELECT source_id, fingerprint, record_count, unique_count, malformed_count,
                duplicate_count, namespace_count, single_namespace
           FROM source_files ORDER BY source_order`,
      )
      .all()
    assert.deepEqual(incrementalSources, fullSources)
    for (const query of [
      `SELECT normalized_path, display_path, native_count, native_bytes, native_exists,
              dino_rows, dino_bytes, clip_rows, clip_bytes, duplicate_rows
         FROM indexed_paths ORDER BY normalized_path`,
      `SELECT folder_key, parent_key, display_path, name, depth, child_count,
              native_count, dino_count, clip_count, native_only, dino_only, clip_only,
              missing_dino, missing_clip, vector_only, duplicate_rows, malformed_rows,
              matched_bytes
         FROM folder_rollups ORDER BY folder_key`,
    ]) {
      assert.deepEqual(
        incrementalDatabase.prepare(query).all(),
        fullDatabase.prepare(query).all(),
      )
    }
    const rootFolder = incrementalDatabase
      .prepare('SELECT child_count FROM folder_rollups WHERE folder_key = ?')
      .get(pathUtils.normalizedImageDataPathKey('D:\\dataset\\images'))
    assert.equal(rootFolder.child_count, 1)
  } finally {
    incrementalDatabase.close()
    fullDatabase.close()
  }
})

test('catalog append-tail invalidates safely for replacement, namespace changes, and removals', async () => {
  const fixture = catalogFixture()
  const stopView = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  await worker.runImageSearchDataCatalogBuild(fixture.input, stopView)
  const dinoSource = fixture.input.vectorSources.find((source) => source.layer === 'dino')

  fs.appendFileSync(dinoSource.filePath, `${embeddingRow(fixture.imageA, 'dinov2_other')}\n`)
  const namespaceInput = nextCatalogInput(fixture, 'namespace-fallback', {
    previousDatabasePath: fixture.databasePath,
  })
  const namespaceResult = await worker.runImageSearchDataCatalogBuild(
    namespaceInput,
    stopView,
  )
  assert.equal(namespaceResult.buildMode, 'full')

  fs.writeFileSync(dinoSource.filePath, `${embeddingRow(fixture.imageB, 'dinov2_vitb14')}\n`)
  const replacementInput = nextCatalogInput(fixture, 'replacement-fallback', {
    previousDatabasePath: namespaceInput.databasePath,
  })
  const replacementResult = await worker.runImageSearchDataCatalogBuild(
    replacementInput,
    stopView,
  )
  assert.equal(replacementResult.buildMode, 'full')

  const removalInput = nextCatalogInput(fixture, 'native-removal-fallback', {
    previousDatabasePath: replacementInput.databasePath,
    nativeRecords: fixture.input.nativeRecords.slice(0, -1),
  })
  const removalResult = await worker.runImageSearchDataCatalogBuild(removalInput, stopView)
  assert.equal(removalResult.buildMode, 'full')
  assert.equal(removalResult.summary.nativeUniqueCount, 2)
})

test('catalog incrementally applies Native-only additions without reading vector shards', async () => {
  const fixture = catalogFixture()
  const stopView = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  await worker.runImageSearchDataCatalogBuild(fixture.input, stopView)
  const added = {
    path: 'D:\\dataset\\images\\native-new\\added.jpg',
    width: 100,
    height: 100,
    fileSize: 42,
    modifiedTime: 2,
    exists: true,
  }
  const nativeRecords = [...fixture.input.nativeRecords, added]
  const incrementalInput = nextCatalogInput(fixture, 'native-addition', {
    previousDatabasePath: fixture.databasePath,
    nativeRecords,
  })
  const incremental = await worker.runImageSearchDataCatalogBuild(
    incrementalInput,
    stopView,
  )
  const fullInput = nextCatalogInput(fixture, 'native-addition-full', { nativeRecords })
  const full = await worker.runImageSearchDataCatalogBuild(fullInput, stopView)
  assert.equal(incremental.buildMode, 'incremental')
  assert.equal(incremental.fullBytesRead, 0)
  assert.equal(incremental.tailBytesRead, 0)
  assert.equal(incremental.changedPathCount, 1)
  assert.deepEqual(comparableSummary(incremental.summary), comparableSummary(full.summary))
  assert.equal(incremental.catalogSha256, full.catalogSha256)
})

test('catalog duplicate detection keeps model/type namespaces distinct', async () => {
  const fixture = catalogFixture()
  const dinoSource = fixture.input.vectorSources.find((source) => source.layer === 'dino')
  const sharedPath = 'D:\\dataset\\images\\multi-model.jpg'
  fs.writeFileSync(
    dinoSource.filePath,
    [
      embeddingRow(sharedPath, 'dinov2_model_a'),
      embeddingRow(sharedPath, 'dinov2_model_b'),
      embeddingRow(sharedPath, 'dinov2_model_a'),
    ].join('\n') + '\n',
  )
  const stat = fs.statSync(dinoSource.filePath)
  dinoSource.sizeBytes = stat.size
  dinoSource.modifiedAt = stat.mtimeMs

  const stopView = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  await worker.runImageSearchDataCatalogBuild(fixture.input, stopView)
  const database = new DatabaseSync(fixture.databasePath, { readOnly: true })
  try {
    const dino = database.prepare("SELECT * FROM source_files WHERE layer = 'dino'").get()
    assert.equal(dino.record_count, 3)
    assert.equal(dino.unique_count, 1)
    assert.equal(dino.duplicate_count, 1)
  } finally {
    database.close()
  }
})

test('catalog worker bounds and skips an oversized malformed JSONL line', async () => {
  const fixture = catalogFixture()
  const dinoSource = fixture.input.vectorSources.find((source) => source.layer === 'dino')
  const handle = fs.openSync(dinoSource.filePath, 'w')
  try {
    fs.writeSync(handle, `${embeddingRow(fixture.imageA, 'dinov2_vitb14')}\n`)
    fs.writeSync(handle, Buffer.alloc(8 * 1024 * 1024 + 1, 0x78))
    fs.writeSync(handle, '\n')
    fs.writeSync(handle, `${embeddingRow(fixture.imageB, 'dinov2_vitb14')}\n`)
  } finally {
    fs.closeSync(handle)
  }
  const stat = fs.statSync(dinoSource.filePath)
  dinoSource.sizeBytes = stat.size
  dinoSource.modifiedAt = stat.mtimeMs

  const stopView = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  await worker.runImageSearchDataCatalogBuild(fixture.input, stopView)
  const database = new DatabaseSync(fixture.databasePath, { readOnly: true })
  try {
    const dino = database.prepare("SELECT * FROM source_files WHERE layer = 'dino'").get()
    assert.equal(dino.record_count, 3)
    assert.equal(dino.unique_count, 2)
    assert.equal(dino.malformed_count, 1)
  } finally {
    database.close()
  }
})

test('catalog worker observes cancellation before committing a usable catalog', async () => {
  const fixture = catalogFixture()
  const stopView = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  Atomics.store(stopView, 0, 1)
  await assert.rejects(
    worker.runImageSearchDataCatalogBuild(fixture.input, stopView),
    /catalog build cancelled/i,
  )
  assert.equal(fs.existsSync(path.join(fixture.catalogRoot, 'CURRENT')), false)
})

test('catalog incremental cancellation never falls through to a full build', async () => {
  const fixture = catalogFixture()
  const initialStopView = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  )
  await worker.runImageSearchDataCatalogBuild(fixture.input, initialStopView)
  const input = nextCatalogInput(fixture, 'cancelled-incremental', {
    previousDatabasePath: fixture.databasePath,
  })
  const stopView = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  Atomics.store(stopView, 0, 1)
  const stages = []
  await assert.rejects(
    worker.runImageSearchDataCatalogBuild(input, stopView, (progress) =>
      stages.push(progress.stage),
    ),
    /catalog build cancelled/i,
  )
  assert.equal(stages.includes('dino'), false)
  assert.equal(fs.existsSync(input.buildMetadataPath), false)
})

test('catalog service pages and filters folder coverage from the committed snapshot only', async () => {
  const fixture = catalogFixture()
  const stopView = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  await worker.runImageSearchDataCatalogBuild(fixture.input, stopView)
  fs.writeFileSync(
    path.join(fixture.catalogRoot, 'CURRENT'),
    JSON.stringify({ version: 1, generation: fixture.generation, switchedAt: Date.now() }),
  )

  const roots = catalogService.listImageSearchDataFolders(fixture.root, { limit: 1 })
  assert.equal(roots.ok, true)
  assert.equal(roots.total, 1)
  assert.equal(roots.records[0].folder, 'D:\\dataset\\images')
  assert.equal(roots.records[0].missingDino, 1)

  const anomalies = catalogService.listImageSearchDataFolders(fixture.root, {
    query: 'DATASET\\IMAGES',
    onlyAnomalies: true,
    limit: 100,
  })
  assert.equal(anomalies.ok, true)
  assert.equal(anomalies.total, 1)
  assert.equal(anomalies.records[0].vectorOnly, 1)

  const children = catalogService.listImageSearchDataFolders(fixture.root, {
    parent: 'D:\\dataset\\images',
  })
  assert.equal(children.ok, true)
  assert.equal(children.total, 0)

  const bounded = catalogService.listImageSearchDataFolders(fixture.root, {
    offset: Number.POSITIVE_INFINITY,
    limit: Number.POSITIVE_INFINITY,
  })
  assert.equal(bounded.ok, true)
  assert.equal(bounded.offset, 0)
  assert.equal(bounded.records.length, 1)
})

test('catalog retention keeps current and previous generations without touching unknown folders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-data-catalog-retention-'))
  temporaryRoots.push(root)
  const generations = path.join(root, 'generations')
  const current = '20260803123456123-aaaaaaaa'
  const previous = '20260803120000123-bbbbbbbb'
  const old = '20260802120000123-cccccccc'
  const unknown = 'manual-backup'
  for (const name of [current, previous, old, unknown]) {
    fs.mkdirSync(path.join(generations, name), { recursive: true })
    fs.writeFileSync(path.join(generations, name, 'catalog.sqlite'), name)
  }

  await catalogService.pruneCatalogGenerations(generations, new Set([current, previous]))

  assert.equal(fs.existsSync(path.join(generations, current)), true)
  assert.equal(fs.existsSync(path.join(generations, previous)), true)
  assert.equal(fs.existsSync(path.join(generations, old)), false)
  assert.equal(fs.existsSync(path.join(generations, unknown)), true)
})

test('quick store inventory keeps exact totals with a bounded largest-file sample', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-data-inventory-'))
  temporaryRoots.push(root)
  const thumbnails = path.join(root, 'thumbcache')
  fs.mkdirSync(thumbnails, { recursive: true })
  let expectedBytes = 0
  for (let index = 1; index <= 150; index++) {
    fs.writeFileSync(path.join(thumbnails, `thumb-${index}.jpg`), Buffer.alloc(index))
    expectedBytes += index
  }

  catalogService.resetImageSearchDataCatalogForTests()
  const overview = await catalogService.getImageSearchDataOverview(root)
  assert.equal(overview.ok, true)
  const store = overview.stores.find((item) => item.id === 'thumbnail-cache')
  assert.ok(store)
  assert.equal(store.fileCount, 150)
  assert.equal(store.totalBytes, expectedBytes)
  assert.equal(store.filesTruncated, true)
  assert.equal(store.files.length, 100)
  assert.equal(store.files[0].sizeBytes, 150)
  assert.equal(store.files.at(-1).sizeBytes, 51)
})

test('catalog path utilities decode only the requested JSON string and preserve folder boundaries', () => {
  const line = embeddingRow('D:\\dataset\\images\\quote-"-图片.jpg', 'dinov2_vitb14')
  assert.equal(
    pathUtils.extractJsonStringField(line, 'imageId'),
    'D:\\dataset\\images\\quote-"-图片.jpg',
  )
  assert.equal(
    pathUtils.isImageDataPathWithin('D:\\dataset\\images\\a.jpg', 'D:\\dataset\\images'),
    true,
  )
  assert.equal(
    pathUtils.isImageDataPathWithin('D:\\dataset\\images-old\\a.jpg', 'D:\\dataset\\images'),
    false,
  )
  const buffered = Buffer.from(
    '{"noise":"\\"imageId\\":\\"wrong\\"","imageId":"D:\\\\dataset\\\\images\\\\鍥剧墖.jpg","vector":[1,2,3]}',
  )
  assert.equal(
    pathUtils.extractJsonStringFieldBuffer(buffered, 'imageId'),
    'D:\\dataset\\images\\鍥剧墖.jpg',
  )
})

test('data overview IPC, preload, bridge, UI, and worker packaging contracts stay connected', () => {
  const channels = source('shared/ipc/image-search.ts')
  for (const channel of [
    'imageSearch:getDataOverview',
    'imageSearch:startDataCatalogBuild',
    'imageSearch:getDataCatalogProgress',
    'imageSearch:cancelDataCatalogBuild',
    'imageSearch:listDataFolders',
    'imageSearch:openDataStoreLocation',
  ]) {
    assert.ok(channels.includes(`'${channel}'`), `missing channel ${channel}`)
  }

  const ipc = source('electron/imageSearchIpc.ts')
  const preload = source('electron/preload.ts')
  for (const channel of [
    'getDataOverview',
    'startDataCatalogBuild',
    'getDataCatalogProgress',
    'cancelDataCatalogBuild',
    'listDataFolders',
    'openDataStoreLocation',
  ]) {
    assert.ok(ipc.includes(`imageSearch:${channel}`), `IPC handler missing ${channel}`)
    assert.ok(preload.includes(`imageSearch:${channel}`), `preload missing ${channel}`)
  }
  assert.match(ipc, /resolveImageSearchDataStoreLocation/)
  assert.match(ipc, /typeof rawId === 'string' \? rawId\.slice\(0, 64\)/)

  const bridge = source('src/services/imageSearchBridge.ts')
  assert.match(bridge, /async getDataOverview\(\)/)
  assert.match(bridge, /async listDataFolders\(/)
  assert.match(bridge, /async openDataStoreLocation\(storeId: string\)/)

  const manager = source('src/components/ImageSearchDataManager.tsx')
  const overview = source('src/components/ImageSearchDataOverview.tsx')
  assert.match(manager, /<ImageSearchDataOverview/)
  assert.match(overview, /data-testid="image-search-data-overview"/)
  assert.match(overview, /t\('Major Data Stores'\)/)
  assert.match(overview, /t\('Folder Coverage'\)/)
  assert.match(overview, /onManageFolder\(folder\.folder\)/)
  assert.match(overview, /data-testid="image-search-data-health-breakdown"/)
  assert.match(overview, /overview\.completeCount/)
  assert.match(overview, /overview\.malformedRows/)

  const vite = source('vite.config.mjs')
  const pkg = source('package.json')
  assert.match(vite, /entry: 'electron\/imageSearchDataCatalogWorker\.ts'/)
  assert.match(pkg, /dist-electron\/imageSearchDataCatalogWorker\.js/)
})

test('catalog build uses the linear Native snapshot instead of quadratic page export', () => {
  const nativeSource = source('native/fast_scanner.cc')
  assert.match(nativeSource, /static napi_value SnapshotIndexRecords/)
  assert.match(nativeSource, /xfn\("snapshotIndexRecords",SnapshotIndexRecords\)/)

  const service = source('electron/imageSearchDataCatalogService.ts')
  const start = service.indexOf('async function collectNativeRecords')
  const end = service.indexOf('\nfunction dataCatalogWorkerPath', start)
  const body = service.slice(start, end)
  assert.match(body, /await snapshotImageSearchData\(\(\) => cancelRequested\)/)
  assert.doesNotMatch(body, /queryImageSearchData|NATIVE_PAGE_SIZE|while \(true\)/)
  assert.match(service, /fs\.promises\.statfs\(path\.resolve\(userDataPath\)\)/)
  assert.match(service, /async function pruneCatalogGenerations/)
  assert.match(service, /files\.length = STORE_FILE_LIMIT/)
  assert.match(service, /fileCount\+\+/)
  assert.match(service, /trustedRoot = await fs\.promises\.realpath/)
  assert.match(service, /Math\.min\(2_147_483_647, Math\.floor\(rawOffset\)\)/)

  const worker = source('electron/imageSearchDataCatalogWorker.ts')
  const rollup = source('electron/imageSearchDataCatalogRollup.ts')
  assert.match(worker, /buildImageSearchFolderRollups\(/)
  assert.match(rollup, /for \(const value of rows\.iterate\(\)\)/)
  assert.match(worker, /extractJsonStringFieldBuffer\(lineBuffer, 'imageId'\)/)
  assert.match(worker, /MAX_CATALOG_LINE_BYTES = 8 \* 1024 \* 1024/)
  assert.match(worker, /discardingOversizedLine/)
  assert.doesNotMatch(worker, /const line = lineBuffer\.toString\('utf8'\)/)
  assert.match(worker, /seenRevisionPaths\.clear\(\)/)
  assert.doesNotMatch(worker, /const revisionKey = `\$\{layer\}/)

  const folderEditor = source('electron/imageSearchFolderDataService.ts')
  assert.match(folderEditor, /crypto\.randomBytes\(12\)/)
  assert.doesNotMatch(folderEditor, /Math\.random\(/)
  assert.match(folderEditor, /Vector cache directory is linked outside/)
})

test('Data Overview user-facing strings have Chinese translations', () => {
  const i18n = source('src/i18n/core.ts')
  for (const key of [
    'Image Search Data Overview',
    'Major Data Stores',
    'Folder Coverage',
    'Analyze All Data',
    'Refresh All Data',
    'Only anomalies',
    'Missing DINO',
    'Missing CLIP',
    'Vector-only',
    'Manage Indexes',
    'Complete Paths',
    'Malformed Rows',
  ]) {
    assert.ok(i18n.includes(`'${key}':`), `missing zh-CN translation for ${key}`)
  }
})
