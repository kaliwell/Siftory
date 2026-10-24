// Phase 1 acceptance tests for the unified Discovery Catalog:
// - path/size/name search works with no AI model involved (lexical SQL only)
// - committed batches are queryable while a scan is still running
// - USN fallback reasons surface on the session and source status
// - cancel / restart / repeated scans never duplicate FileEntry rows
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const { DiscoveryCatalogDatabase, discoveryPathKey } = loadTsModule(
  'electron/discoveryCatalogDatabase.ts',
)
const { SourceCatalogService } = loadTsModule('electron/sourceCatalogService.ts')

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function makeEntry(root, relativePath, sizeBytes, modifiedAt) {
  const absolutePath = path.join(root, relativePath)
  const name = path.basename(relativePath)
  return {
    absolutePath,
    relativePath,
    name,
    extension: path.extname(name).replace(/^\./, '').toLowerCase(),
    sizeBytes,
    modifiedAt,
  }
}

function addTestSource(service, root, displayName = 'Test Source') {
  const result = service.addSource({
    type: 'local-ntfs',
    displayName,
    rootLocator: root,
  })
  assert.equal(result.ok, true, result.error)
  return result.source
}

test('existing indexed files gain durable catalog identities without scanning or admitting arbitrary hits', async () => {
  const root = tempDir('siftory-existing-index-')
  const service = new SourceCatalogService({
    databasePath: path.join(root, 'catalog.sqlite'),
    incrementalWatch: false,
  })
  try {
    const files = ['a.jpg', 'b.jpg', 'not-indexed.jpg'].map((name) => path.join(root, name))
    for (const file of files) fs.writeFileSync(file, 'synthetic fixture')
    const indexed = new Set(files.slice(0, 2))
    await service.projectExistingSearchFiles(files, (file) => indexed.has(file), [
      'unregistered-source',
    ])
    assert.equal(
      service.listSources().length,
      0,
      'a source filter must never create an unrelated source',
    )
    await service.projectExistingSearchFiles([...files, path.join(root, 'missing.jpg')], (file) =>
      indexed.has(file),
    )
    const first = service.findFileEntriesByPaths(files)
    assert.equal(first.length, 2)
    assert.equal(service.listSources().length, 1)
    assert.equal(service.listSources()[0].readOnly, true)
    assert.ok(service.getFileEntryForAction(first[0].fileEntryId))
    await service.projectExistingSearchFiles(files, (file) => indexed.has(file))
    assert.deepEqual(
      service.findFileEntriesByPaths(files).map((item) => item.fileEntryId),
      first.map((item) => item.fileEntryId),
    )
    assert.equal(service.queryCatalog({ query: 'a.jpg' }).items.length, 1)
  } finally {
    service.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

async function waitFor(condition, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = condition()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('waitFor timed out')
}

// Deterministic fake adapter: yields scripted batches with controllable
// pacing so tests can query mid-scan and exercise cancel paths.
function createFakeAdapter(script) {
  return {
    async probe() {
      return {
        availability: 'online',
        scanCapability: 'directory',
        nativeConnected: false,
        detail: 'fake adapter',
      }
    },
    async *enumerate(request) {
      let discovered = 0
      for (let index = 0; index < script.length; index += 1) {
        const step = script[index]
        if (step.waitForAbort) {
          while (!request.signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
        }
        if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs))
        discovered += step.entries.length
        yield {
          entries: step.entries,
          progress: {
            discoveredCount: discovered,
            backend: step.backend || 'directory',
            ...(step.fallbackReason ? { fallbackReason: step.fallbackReason } : {}),
            ...(step.fallbackCode ? { fallbackCode: step.fallbackCode } : {}),
          },
          final: index === script.length - 1 && !step.waitForAbort,
        }
        if (request.signal.aborted) {
          yield {
            entries: [],
            progress: { discoveredCount: discovered, backend: step.backend || 'directory' },
            final: true,
          }
          return
        }
      }
    },
  }
}

test('file entry upsert is idempotent across repeated and duplicate batches', () => {
  const root = tempDir('discovery-db-')
  const database = new DiscoveryCatalogDatabase(path.join(root, 'catalog.sqlite'))
  try {
    const now = 1700000000000
    database.insertSource(
      {
        id: 'src_1',
        type: 'local-ntfs',
        displayName: 'A',
        rootLocator: root,
        readOnly: true,
        availability: 'online',
        scanCapability: 'usn',
      },
      now,
    )
    const entries = [
      makeEntry(root, 'a/one.png', 100, 1000),
      makeEntry(root, 'b/two.jpg', 200, 2000),
    ]
    database.upsertDiscoveredBatch('src_1', 'scan_1', entries, now)
    assert.equal(database.countFileEntries(), 2)
    // Same batch again (duplicate delivery), then a rescan session.
    database.upsertDiscoveredBatch('src_1', 'scan_1', entries, now + 1)
    database.upsertDiscoveredBatch('src_1', 'scan_2', entries, now + 2)
    assert.equal(database.countFileEntries(), 2)
    // Changed size/mtime updates the row in place without duplicating it.
    database.upsertDiscoveredBatch(
      'src_1',
      'scan_3',
      [makeEntry(root, 'a/one.png', 150, 3000)],
      now + 3,
    )
    assert.equal(database.countFileEntries(), 2)
    const response = database.queryCatalog({ query: 'one' })
    assert.equal(response.total, 1)
    assert.equal(response.items[0].sizeBytes, 150)
    assert.equal(response.items[0].modifiedAt, 3000)
    assert.deepEqual(response.items[0].indexState, ['discovered:ready'])
    assert.equal(response.items[0].source.id, 'src_1')
  } finally {
    database.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('lexical path/size/name search needs no AI model', () => {
  const root = tempDir('discovery-db-')
  const database = new DiscoveryCatalogDatabase(path.join(root, 'catalog.sqlite'))
  try {
    database.insertSource(
      {
        id: 'src_1',
        type: 'local-ntfs',
        displayName: 'A',
        rootLocator: root,
        readOnly: true,
        availability: 'online',
        scanCapability: 'directory',
      },
      1700000000000,
    )
    database.upsertDiscoveredBatch(
      'src_1',
      'scan_1',
      [
        makeEntry(root, 'photos/cat.png', 10, 1),
        makeEntry(root, 'docs/dog.png', 20, 2),
        makeEntry(root, 'photos/cats.jpg', 30, 3),
      ],
      1700000000001,
    )
    const byName = database.queryCatalog({ query: 'cat' })
    assert.equal(byName.total, 2)
    const byPath = database.queryCatalog({ query: 'docs' })
    assert.equal(byPath.total, 1)
    assert.equal(byPath.items[0].displayName, 'dog.png')
    const sorted = database.queryCatalog({ sort: 'size_desc' })
    assert.deepEqual(
      sorted.items.map((item) => item.sizeBytes),
      [30, 20, 10],
    )
    const stats = database.getStats()
    assert.equal(stats.fileCount, 3)
    assert.equal(stats.totalBytes, 60)
    const hydrated = database.findFileEntriesByPaths([
      path.join(root, 'photos', 'cat.png').toUpperCase(),
      path.join(root, 'missing.png'),
    ])
    assert.equal(hydrated.length, process.platform === 'win32' ? 1 : 0)
    if (hydrated.length > 0) {
      assert.equal(hydrated[0].displayName, 'cat.png')
      assert.equal(hydrated[0].source.id, 'src_1')
    }
  } finally {
    database.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('source discovery is submitted through the unified scheduler when configured', async () => {
  const root = tempDir('discovery-scheduler-')
  const submitted = []
  const scheduler = {
    enqueue(request) {
      submitted.push(request)
      return { id: 7, promise: Promise.resolve().then(request.run) }
    },
    cancel() {
      return false
    },
  }
  const service = new SourceCatalogService({
    databasePath: path.join(root, 'catalog.sqlite'),
    taskScheduler: scheduler,
    adapterFactory: () => createFakeAdapter([{ entries: [makeEntry(root, 'one.png', 1, 1)] }]),
  })
  try {
    const source = addTestSource(service, root)
    assert.equal(service.startScan(source.id).ok, true)
    await waitFor(() => service.getScanStatus(source.id)[0].running === false)
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0].stage, 'discovery')
    assert.equal(submitted[0].priority, 1)
    assert.deepEqual(submitted[0].paths, [source.rootLocator])
    assert.equal(service.queryCatalog({}).total, 1)
  } finally {
    service.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('committed batches are queryable while the scan is still running', async () => {
  const root = tempDir('discovery-svc-')
  const service = new SourceCatalogService({
    databasePath: path.join(root, 'catalog.sqlite'),
    adapterFactory: () =>
      createFakeAdapter([
        { entries: [makeEntry(root, 'x/first.png', 1, 1)] },
        { entries: [makeEntry(root, 'x/second.png', 2, 2)], delayMs: 400 },
      ]),
  })
  try {
    const source = addTestSource(service, root)
    const started = service.startScan(source.id)
    assert.equal(started.ok, true, started.error)
    // Wait for batch 1 to commit, then query before batch 2 lands.
    await waitFor(() => service.queryCatalog({}).total === 1)
    const midScan = service.queryCatalog({ query: 'first' })
    assert.equal(midScan.total, 1)
    assert.equal(service.getScanStatus(source.id)[0].running, true)
    await waitFor(() => service.getScanStatus(source.id)[0].running === false)
    assert.equal(service.queryCatalog({}).total, 2)
    const session = service.getScanStatus(source.id)[0].session
    assert.equal(session.state, 'completed')
    assert.equal(session.committedCount, 2)
  } finally {
    service.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('USN fallback reason surfaces on session, status and source list', async () => {
  const root = tempDir('discovery-svc-')
  const service = new SourceCatalogService({
    databasePath: path.join(root, 'catalog.sqlite'),
    adapterFactory: () =>
      createFakeAdapter([
        {
          entries: [makeEntry(root, 'y/one.png', 5, 5)],
          backend: 'directory',
          fallbackReason: 'USN journal unavailable (access denied)',
          fallbackCode: 'USN_ACCESS_DENIED',
        },
      ]),
  })
  try {
    const source = addTestSource(service, root)
    assert.equal(service.startScan(source.id).ok, true)
    await waitFor(() => service.getScanStatus(source.id)[0].running === false)
    const session = service.getScanStatus(source.id)[0].session
    assert.equal(session.state, 'completed')
    assert.equal(session.backend, 'directory')
    assert.match(session.fallbackReason, /USN/)
    assert.equal(session.fallbackCode, 'USN_ACCESS_DENIED')
    const listed = service.listSources().find((item) => item.id === source.id)
    assert.equal(listed.scanCapability, 'directory')
    assert.match(listed.lastScanFallbackReason, /USN/)
  } finally {
    service.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('cancel keeps committed batches and rescan never duplicates entries', async () => {
  const root = tempDir('discovery-svc-')
  let scanRun = 0
  const entries = [
    makeEntry(root, 'z/a.png', 1, 1),
    makeEntry(root, 'z/b.png', 2, 2),
    makeEntry(root, 'z/c.png', 3, 3),
  ]
  const service = new SourceCatalogService({
    databasePath: path.join(root, 'catalog.sqlite'),
    adapterFactory: () => {
      scanRun += 1
      // First run: commit batch 1, then block until aborted. Later runs:
      // stream everything to completion.
      if (scanRun === 1) {
        return createFakeAdapter([
          { entries: entries.slice(0, 1) },
          { entries: [], waitForAbort: true },
        ])
      }
      return createFakeAdapter([{ entries }])
    },
  })
  try {
    const source = addTestSource(service, root)
    assert.equal(service.startScan(source.id).ok, true)
    await waitFor(() => service.queryCatalog({}).total === 1)
    assert.equal(service.cancelScan(source.id).ok, true)
    await waitFor(() => service.getScanStatus(source.id)[0].running === false)
    const cancelled = service.getScanStatus(source.id)[0].session
    assert.equal(cancelled.state, 'cancelled')
    assert.equal(service.queryCatalog({}).total, 1, 'committed batch survives cancel')

    // Restart after cancel: all three files discovered, still three rows.
    assert.equal(service.startScan(source.id).ok, true)
    await waitFor(() => service.getScanStatus(source.id)[0].running === false)
    assert.equal(service.getScanStatus(source.id)[0].session.state, 'completed')
    assert.equal(service.queryCatalog({}).total, 3)

    // Repeat scan: identical catalog, stable file entry ids.
    const beforeIds = service.queryCatalog({ limit: 10 }).items.map((item) => item.fileEntryId)
    assert.equal(service.startScan(source.id).ok, true)
    await waitFor(() => service.getScanStatus(source.id)[0].running === false)
    const after = service.queryCatalog({ limit: 10 })
    assert.equal(after.total, 3)
    assert.deepEqual(after.items.map((item) => item.fileEntryId).sort(), beforeIds.sort())
    const keys = service.listSources().find((item) => item.id === source.id)
    assert.equal(keys.fileCount, 3)
    assert.equal(service.getStats().sessionCount, 3)
  } finally {
    service.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('path key normalizes case-insensitively on win32', () => {
  const key = discoveryPathKey(path.join('Some', 'Dir', 'File.PNG'))
  const resolved = path.resolve(path.join('Some', 'Dir', 'File.PNG'))
  assert.equal(key, process.platform === 'win32' ? resolved.toLowerCase() : resolved)
})

test('local source tombstones match exact paths without hiding remote or prefix-sibling entries', () => {
  const root = tempDir('discovery-local-missing-')
  const database = new DiscoveryCatalogDatabase(path.join(root, 'catalog.sqlite'))
  try {
    const localSource = {
      id: 'src_local',
      type: 'local-generic',
      displayName: 'Local',
      rootLocator: root,
      readOnly: true,
      availability: 'online',
      scanCapability: 'directory',
    }
    const remoteSource = {
      id: 'src_remote',
      type: 'sftp',
      displayName: 'Remote',
      rootLocator: 'sftp://test-profile/library',
      readOnly: true,
      availability: 'online',
      scanCapability: 'remote-list',
    }
    database.insertSource(localSource, 1)
    database.insertSource(remoteSource, 1)

    const target = makeEntry(root, 'folder/gone.jpg', 10, 2)
    const prefixSibling = makeEntry(root, 'folder/gone.jpg-copy', 20, 3)
    database.upsertDiscoveredBatch(localSource.id, 'scan_local', [target, prefixSibling], 4)
    // A remote projection with the same path key proves the cross-source helper
    // does not tombstone sources that are not backed by the local filesystem.
    database.upsertDiscoveredBatch(remoteSource.id, 'scan_remote', [target], 4)

    assert.equal(
      database.markLocalFileEntriesMissingByPaths([target.absolutePath, target.absolutePath], 5),
      1,
    )
    assert.equal(database.markLocalFileEntriesMissingByPaths([target.absolutePath], 6), 0)

    const localResults = database.queryCatalog({ sourceId: localSource.id, query: 'gone.jpg' })
    assert.equal(localResults.total, 1)
    assert.deepEqual(
      localResults.items.map((item) => item.displayName),
      ['gone.jpg-copy'],
    )
    const remoteResults = database.queryCatalog({ sourceId: remoteSource.id, query: 'gone.jpg' })
    assert.equal(remoteResults.total, 1)
    assert.equal(remoteResults.items[0].displayName, 'gone.jpg')

    const exactPathResults = database.findFileEntriesByPaths([target.absolutePath])
    assert.deepEqual(
      exactPathResults.map((item) => item.source.id),
      [remoteSource.id],
    )
    assert.equal(database.countFileEntries(), 3, 'tombstones remain recoverable in storage')
    assert.equal(database.getStats().fileCount, 2, 'normal catalog stats exclude the tombstone')
    assert.equal(database.getConsistencyReport().missingFileCount, 1)
  } finally {
    database.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('exact path move re-points catalog projections without creating a row', () => {
  const root = tempDir('discovery-repath-')
  const database = new DiscoveryCatalogDatabase(path.join(root, 'catalog.sqlite'))
  try {
    database.insertSource(
      {
        id: 'src_1',
        type: 'local-ntfs',
        displayName: 'A',
        rootLocator: root,
        readOnly: true,
        availability: 'online',
        scanCapability: 'directory',
      },
      1,
    )
    const oldPath = path.join(root, 'old.jpg')
    const newPath = path.join(root, 'moved', 'new.jpg')
    database.upsertDiscoveredBatch('src_1', 'scan_1', [makeEntry(root, 'old.jpg', 2, 3)], 4)
    assert.equal(database.repathFileEntriesByPath(oldPath, newPath, 5), 1)
    assert.equal(database.countFileEntries(), 1)
    const [item] = database.findFileEntriesByPaths([newPath])
    assert.equal(item.displayName, 'new.jpg')
    assert.equal(item.fileEntryId, database.queryCatalog({}).items[0].fileEntryId)
  } finally {
    database.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('SQL filters apply media, dates and combined sources before candidate truncation', () => {
  const root = tempDir('siftory-sql-filters-')
  const database = new DiscoveryCatalogDatabase(path.join(root, 'catalog.sqlite'))
  try {
    for (const id of ['first', 'second']) {
      database.insertSource(
        {
          id,
          type: 'local-ntfs',
          displayName: id,
          rootLocator: root,
          readOnly: true,
          availability: 'online',
          scanCapability: 'directory',
        },
        1,
      )
    }
    database.upsertDiscoveredBatch(
      'first',
      'scan',
      [
        ...Array.from({ length: 600 }, (_, i) => makeEntry(root, `a-${i}.jpg`, 1, 1)),
        makeEntry(root, 'z-match.mp4', 1, 50),
        makeEntry(root, 'z-old.mp4', 1, 2),
        makeEntry(root, 'raw-image.nef', 1, 50),
      ],
      2,
    )
    database.upsertDiscoveredBatch('second', 'scan', [makeEntry(root, 'z-other.mp4', 1, 50)], 2)
    const result = database.queryCatalog({
      mediaTypes: ['video'],
      sourceIds: ['first'],
      modifiedAfter: 40,
      modifiedBefore: 60,
      limit: 500,
      sort: 'name_asc',
    })
    assert.equal(result.total, 1)
    assert.equal(result.items[0].displayName, 'z-match.mp4')
    assert.equal(database.queryCatalog({ mediaTypes: ['image'], query: 'raw-image' }).total, 1)
    assert.equal(
      database.queryCatalog({
        mediaTypes: ['video'],
        sourceIds: ['first', 'second'],
        modifiedAfter: 40,
      }).total,
      2,
    )
  } finally {
    database.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an asynchronous projection cannot reopen the catalog after shutdown', async () => {
  const root = tempDir('siftory-catalog-shutdown-')
  const databasePath = path.join(root, 'catalog.sqlite')
  const service = new SourceCatalogService({ databasePath, incrementalWatch: false })
  try {
    service.queryCatalog({})
    const file = path.join(root, 'indexed.jpg')
    fs.writeFileSync(file, 'fixture')
    const projection = service.projectExistingSearchFiles([file], () => true)
    service.close()
    const before = fs.readFileSync(databasePath)
    await projection
    assert.deepEqual(service.queryCatalog({}), { items: [], total: 0 })
    assert.deepEqual(service.findFileEntriesByPaths([file]), [])
    assert.deepEqual(fs.readFileSync(databasePath), before)
  } finally {
    service.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
