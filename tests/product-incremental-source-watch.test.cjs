const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { DiscoveryCatalogDatabase } = loadTsModule('electron/discoveryCatalogDatabase.ts')
const { SourceCatalogService } = loadTsModule('electron/sourceCatalogService.ts')

function fixture(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const sourceRoot = path.join(base, 'source')
  fs.mkdirSync(sourceRoot)
  return { base, sourceRoot, databasePath: path.join(base, 'state', 'catalog.sqlite') }
}

function fakeAdapter() {
  return {
    async probe() {
      return {
        availability: 'online',
        scanCapability: 'directory',
        nativeConnected: false,
        detail: 'reachable',
      }
    },
    async *enumerate() {
      yield {
        entries: [],
        progress: { discoveredCount: 0, backend: 'directory' },
        final: true,
      }
    },
  }
}

function addSource(service, root) {
  const result = service.addSource({
    type: 'local-generic',
    displayName: 'Watched source',
    rootLocator: root,
  })
  assert.equal(result.ok, true, result.error)
  return result.source
}

async function waitFor(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('waitFor timed out')
}

test('watcher batches additions, invalidates every derived stage, and tombstones deletions', async () => {
  const { base, sourceRoot, databasePath } = fixture('siftory-product-watch-')
  const watchers = []
  const service = new SourceCatalogService({
    databasePath,
    adapterFactory: fakeAdapter,
    watchDebounceMs: 50,
    watcherFactory(root, onChange, onError) {
      const watcher = {
        root,
        onChange,
        onError,
        closed: false,
        close() {
          this.closed = true
        },
      }
      watchers.push(watcher)
      return watcher
    },
  })
  let database
  try {
    addSource(service, sourceRoot)
    assert.equal(service.listSources()[0].incrementalWatch.state, 'watching')
    const filePath = path.join(sourceRoot, 'nested', 'portrait.mp4')
    fs.mkdirSync(path.dirname(filePath))
    fs.writeFileSync(filePath, 'first')
    watchers.at(-1).onChange('rename', Buffer.from(path.join('nested', 'portrait.mp4')))
    await waitFor(() => service.queryCatalog({}).total === 1)

    const first = service.queryCatalog({}).items[0]
    database = new DiscoveryCatalogDatabase(databasePath)
    for (const stage of [
      'metadata-ready',
      'preview-ready',
      'hash-ready',
      'image-embedding-ready',
    ]) {
      assert.equal(database.setFileEntryIndexState(first.fileEntryId, stage, 'ready', 10), true)
    }

    fs.appendFileSync(filePath, '-changed')
    fs.utimesSync(filePath, new Date(), new Date(Date.now() + 2_000))
    watchers.at(-1).onChange('change', path.join('nested', 'portrait.mp4'))
    await waitFor(() => {
      const current = service.queryCatalog({}).items[0]
      return (
        current?.sizeBytes === 13 &&
        current.indexState.filter((state) => state.endsWith(':stale')).length === 4
      )
    })
    const changed = service.queryCatalog({}).items[0]
    assert.equal(changed.fileEntryId, first.fileEntryId)
    assert.deepEqual(
      new Set(changed.indexState),
      new Set([
        'discovered:ready',
        'metadata-ready:stale',
        'preview-ready:stale',
        'hash-ready:stale',
        'image-embedding-ready:stale',
      ]),
    )

    fs.unlinkSync(filePath)
    watchers.at(-1).onChange('rename', path.join('nested', 'portrait.mp4'))
    await waitFor(() => service.queryCatalog({}).total === 0)
    assert.equal(service.listSources()[0].fileCount, 0)
    assert.equal(service.getFileEntryForAction(first.fileEntryId), null)
    assert.ok(service.listSources()[0].incrementalWatch.lastAppliedAt)
  } finally {
    database?.close()
    service.close()
    assert.equal(
      watchers.every((watcher) => watcher.closed),
      true,
    )
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('offline roots never convert the retained catalog into false deletions and reconnect resumes', async () => {
  const { base, sourceRoot, databasePath } = fixture('siftory-product-watch-offline-')
  const watchers = []
  const service = new SourceCatalogService({
    databasePath,
    adapterFactory: fakeAdapter,
    watchDebounceMs: 50,
    watcherFactory(root, onChange, onError) {
      const watcher = {
        root,
        onChange,
        onError,
        closed: false,
        close() {
          this.closed = true
        },
      }
      watchers.push(watcher)
      return watcher
    },
  })
  try {
    const source = addSource(service, sourceRoot)
    const filePath = path.join(sourceRoot, 'kept.mp4')
    fs.writeFileSync(filePath, 'retained')
    assert.equal((await service.applyIncrementalChanges(source.id, [filePath])).ok, true)
    const retainedId = service.queryCatalog({}).items[0].fileEntryId

    fs.rmSync(sourceRoot, { recursive: true, force: true })
    const offline = await service.applyIncrementalChanges(source.id, [filePath])
    assert.equal(offline.offline, true)
    assert.equal(offline.missing, 0)
    assert.equal(service.queryCatalog({}).total, 1)
    assert.equal(service.queryCatalog({}).items[0].fileEntryId, retainedId)
    assert.equal(service.listSources()[0].availability, 'offline')
    assert.equal(service.listSources()[0].incrementalWatch.state, 'paused-offline')

    fs.mkdirSync(sourceRoot)
    fs.writeFileSync(filePath, 'retained')
    const probe = await service.probeSource(source.id)
    assert.equal(probe.ok, true)
    assert.equal(service.listSources()[0].incrementalWatch.state, 'watching')
    assert.equal((await service.applyIncrementalChanges(source.id, [filePath])).ok, true)
    assert.equal(service.queryCatalog({}).items[0].fileEntryId, retainedId)
    assert.ok(watchers.length >= 2)
  } finally {
    service.close()
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('incremental updates reject paths outside the registered root and expose UI status', async () => {
  const { base, sourceRoot, databasePath } = fixture('siftory-product-watch-boundary-')
  const outside = path.join(base, 'outside.mp4')
  fs.writeFileSync(outside, 'outside')
  const service = new SourceCatalogService({
    databasePath,
    adapterFactory: fakeAdapter,
    watcherFactory() {
      return { close() {} }
    },
  })
  try {
    const source = addSource(service, sourceRoot)
    const result = await service.applyIncrementalChanges(source.id, [outside, '..\\outside.mp4'])
    assert.equal(result.ok, true)
    assert.equal(result.upserted, 0)
    assert.equal(result.ignored, 2)
    assert.equal(service.queryCatalog({}).total, 0)

    const ui = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'components', 'DiscoverySourcesSection.tsx'),
      'utf8',
    )
    assert.match(ui, /data-testid={`source-incremental-watch-\$\{source\.id\}`}/)
    assert.match(ui, /incrementalWatch\.lastAppliedAt/)
    assert.match(ui, /Paused while source is offline/)
  } finally {
    service.close()
    fs.rmSync(base, { recursive: true, force: true })
  }
})
