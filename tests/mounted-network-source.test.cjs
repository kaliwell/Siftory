const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { MountedNetworkSourceAdapter } = loadTsModule('electron/mountedNetworkSourceAdapter.ts')
const { SourceCatalogService } = loadTsModule('electron/sourceCatalogService.ts')
const { SourceAdapterError } = loadTsModule('electron/sourceAdapterErrors.ts')

function dirent(name, type) {
  return {
    name,
    isDirectory: () => type === 'directory',
    isFile: () => type === 'file',
    isSymbolicLink: () => type === 'symlink',
  }
}

function source(rootLocator = path.resolve('mounted-share')) {
  return {
    id: 'src_network',
    type: 'mounted-network',
    displayName: 'NAS',
    rootLocator,
    readOnly: true,
    availability: 'unknown',
    scanCapability: 'directory',
  }
}

async function collect(adapter, requestSource, signal = new AbortController().signal) {
  const batches = []
  for await (const batch of adapter.enumerate({ source: requestSource, signal }))
    batches.push(batch)
  return batches
}

test('mounted-network adapter recursively batches metadata with an independent stat budget', async () => {
  const root = path.resolve('mounted-share')
  let activeStats = 0
  let peakStats = 0
  const adapter = new MountedNetworkSourceAdapter({
    batchSize: 2,
    statConcurrency: 2,
    operationTimeoutMs: 1000,
    io: {
      readdir: async (directory) =>
        directory === root
          ? [dirent('nested', 'directory'), dirent('one.png', 'file'), dirent('skip', 'symlink')]
          : [dirent('two.mp4', 'file'), dirent('three.psd', 'file')],
      stat: async (filePath) => {
        if (filePath === root)
          return { isDirectory: () => true, isFile: () => false, size: 0, mtimeMs: 0 }
        activeStats += 1
        peakStats = Math.max(peakStats, activeStats)
        await new Promise((resolve) => setTimeout(resolve, 5))
        activeStats -= 1
        return { isDirectory: () => false, isFile: () => true, size: 7, mtimeMs: 11 }
      },
    },
  })
  const batches = await collect(adapter, source(root))
  const entries = batches.flatMap((batch) => batch.entries)
  assert.deepEqual(entries.map((entry) => entry.relativePath).sort(), [
    'nested\\three.psd',
    'nested\\two.mp4',
    'one.png',
  ])
  assert.equal(batches.at(-1).final, true)
  assert.equal(batches.at(-1).progress.discoveredCount, 3)
  assert.ok(peakStats <= 2)
})

test('mounted-network timeout reports offline and cancellation remains a non-error terminal batch', async () => {
  const root = path.resolve('mounted-timeout')
  const never = () => new Promise(() => {})
  const timedOut = new MountedNetworkSourceAdapter({
    operationTimeoutMs: 10,
    io: { readdir: never, stat: never },
  })
  await assert.rejects(collect(timedOut, source(root)), (error) => {
    assert.equal(error.code, 'SOURCE_OFFLINE')
    return true
  })

  const controller = new AbortController()
  const cancelled = new MountedNetworkSourceAdapter({
    operationTimeoutMs: 1000,
    io: { readdir: never, stat: never },
  })
  const collecting = collect(cancelled, source(root), controller.signal)
  controller.abort()
  const batches = await collecting
  assert.equal(batches.length, 1)
  assert.equal(batches[0].final, true)
  assert.deepEqual(batches[0].entries, [])
})

test('mounted-network probe distinguishes permission failure from offline failure', async () => {
  const root = path.resolve('mounted-probe')
  const permissionError = Object.assign(new Error('denied'), { code: 'EACCES' })
  const denied = new MountedNetworkSourceAdapter({
    io: { readdir: async () => [], stat: async () => Promise.reject(permissionError) },
  })
  const deniedResult = await denied.probe(source(root))
  assert.equal(deniedResult.availability, 'degraded')
  assert.match(deniedResult.detail, /permission denied/i)

  const offline = new MountedNetworkSourceAdapter({
    io: { readdir: async () => [], stat: async () => Promise.reject(new Error('offline')) },
  })
  assert.equal((await offline.probe(source(root))).availability, 'offline')
})

test('catalog keeps mounted-network metadata when a later scan goes offline', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mounted-catalog-'))
  const root = path.resolve('Z:\\offline-share')
  let scan = 0
  const service = new SourceCatalogService({
    databasePath: path.join(temp, 'catalog.sqlite'),
    adapterFactory: () => ({
      probe: async () => ({
        availability: 'online',
        scanCapability: 'directory',
        nativeConnected: false,
      }),
      async *enumerate() {
        scan += 1
        if (scan > 1) throw new SourceAdapterError('SOURCE_OFFLINE', 'NAS disconnected')
        yield {
          entries: [
            {
              absolutePath: path.join(root, 'photo.png'),
              relativePath: 'photo.png',
              name: 'photo.png',
              extension: 'png',
              sizeBytes: 12,
              modifiedAt: 34,
            },
          ],
          progress: { discoveredCount: 1, backend: 'directory' },
          final: true,
        }
      },
    }),
  })
  try {
    const added = service.addSource({
      type: 'mounted-network',
      displayName: 'Offline NAS',
      rootLocator: root,
      readOnly: false,
    })
    assert.equal(added.ok, true, added.error)
    assert.equal(added.source.readOnly, true)
    assert.equal(added.source.scanCapability, 'directory')
    assert.equal(service.startScan(added.source.id).ok, true)
    while (service.getScanStatus(added.source.id)[0].running) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(service.queryCatalog({}).total, 1)

    assert.equal(service.startScan(added.source.id).ok, true)
    while (service.getScanStatus(added.source.id)[0].running) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(service.getScanStatus(added.source.id)[0].session.state, 'error')
    assert.equal(service.listSources()[0].availability, 'offline')
    assert.equal(service.queryCatalog({}).total, 1)
  } finally {
    service.close()
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('an active mounted-network scan does not serialize an independent local source scan', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mounted-isolation-'))
  const localRoot = path.join(temp, 'local')
  const networkRoot = path.resolve('Z:\\slow-share')
  fs.mkdirSync(localRoot)
  const service = new SourceCatalogService({
    databasePath: path.join(temp, 'catalog.sqlite'),
    adapterFactory: (registeredSource) => ({
      probe: async () => ({
        availability: 'online',
        scanCapability: 'directory',
        nativeConnected: false,
      }),
      async *enumerate(request) {
        if (registeredSource.type === 'mounted-network') {
          while (!request.signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 5))
          }
          yield { entries: [], progress: { discoveredCount: 0, backend: 'directory' }, final: true }
          return
        }
        yield {
          entries: [
            {
              absolutePath: path.join(localRoot, 'local.png'),
              relativePath: 'local.png',
              name: 'local.png',
              extension: 'png',
              sizeBytes: 1,
              modifiedAt: 2,
            },
          ],
          progress: { discoveredCount: 1, backend: 'directory' },
          final: true,
        }
      },
    }),
  })
  try {
    const network = service.addSource({
      type: 'mounted-network',
      displayName: 'Slow NAS',
      rootLocator: networkRoot,
    }).source
    const local = service.addSource({
      type: 'local-generic',
      displayName: 'Local',
      rootLocator: localRoot,
    }).source
    assert.equal(service.startScan(network.id).ok, true)
    assert.equal(service.startScan(local.id).ok, true)
    while (service.getScanStatus(local.id)[0].running) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(service.queryCatalog({ sourceId: local.id }).total, 1)
    assert.equal(service.getScanStatus(network.id)[0].running, true)
    assert.equal(service.cancelScan(network.id).ok, true)
    while (service.getScanStatus(network.id)[0].running) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(service.getScanStatus(network.id)[0].session.state, 'cancelled')
  } finally {
    service.close()
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('mounted-network discovery bypasses the local scheduler and is globally serialized', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mounted-budget-'))
  const firstRoot = path.resolve('Z:\\first-share')
  const secondRoot = path.resolve('Z:\\second-share')
  let scheduled = 0
  const service = new SourceCatalogService({
    databasePath: path.join(temp, 'catalog.sqlite'),
    taskScheduler: {
      enqueue() {
        scheduled += 1
        throw new Error('network scan must not use local scheduler')
      },
      cancel: () => false,
    },
    adapterFactory: () => ({
      probe: async () => ({
        availability: 'online',
        scanCapability: 'directory',
        nativeConnected: false,
      }),
      async *enumerate(request) {
        while (!request.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
        yield { entries: [], progress: { discoveredCount: 0, backend: 'directory' }, final: true }
      },
    }),
  })
  try {
    const first = service.addSource({
      type: 'mounted-network',
      displayName: 'First NAS',
      rootLocator: firstRoot,
    }).source
    const second = service.addSource({
      type: 'mounted-network',
      displayName: 'Second NAS',
      rootLocator: secondRoot,
    }).source
    assert.equal(service.startScan(first.id).ok, true)
    const rejected = service.startScan(second.id)
    assert.equal(rejected.ok, false)
    assert.match(rejected.error, /remote source scan/i)
    assert.equal(scheduled, 0)
    service.cancelScan(first.id)
    while (service.getScanStatus(first.id)[0].running) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  } finally {
    service.cancelScan(service.listSources()[0]?.id || '')
    service.close()
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('Sources UI exposes mounted-network registration without enabling remote writes', () => {
  const ui = fs.readFileSync('src/components/DiscoverySourcesSection.tsx', 'utf8')
  const service = fs.readFileSync('electron/sourceCatalogService.ts', 'utf8')
  assert.match(ui, /option value="mounted-network"/)
  assert.match(ui, /type: sourceType/)
  assert.match(service, /readOnly: mountedNetwork \|\| sftp \? true/)
})

test('mounted-network root repair preserves source and file ids after identity sampling', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mounted-repair-'))
  const oldRoot = path.join(temp, 'old-share')
  const newRoot = path.join(temp, 'new-share')
  fs.mkdirSync(oldRoot)
  fs.mkdirSync(newRoot)
  const oldFile = path.join(oldRoot, 'nested', 'photo.png')
  const newFile = path.join(newRoot, 'nested', 'photo.png')
  fs.mkdirSync(path.dirname(oldFile))
  fs.mkdirSync(path.dirname(newFile))
  fs.writeFileSync(oldFile, 'same-file')
  fs.copyFileSync(oldFile, newFile)
  const modifiedAt = 1_700_000_000_000
  fs.utimesSync(oldFile, modifiedAt / 1000, modifiedAt / 1000)
  fs.utimesSync(newFile, modifiedAt / 1000, modifiedAt / 1000)
  const service = new SourceCatalogService({ databasePath: path.join(temp, 'catalog.sqlite') })
  try {
    const added = service.addSource({
      type: 'mounted-network',
      displayName: 'Moved NAS',
      rootLocator: oldRoot,
    })
    assert.equal(added.ok, true, added.error)
    const scan = service.startScan(added.source.id)
    assert.equal(scan.ok, true, scan.error)
    while (service.getScanStatus(added.source.id)[0].running) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const before = service.queryCatalog({ query: 'photo.png' }).items[0]
    const repaired = await service.repairMountedSourceRoot(added.source.id, newRoot)
    assert.equal(repaired.ok, true, repaired.error)
    assert.equal(repaired.source.id, added.source.id)
    assert.equal(repaired.repairedEntries, 1)
    const after = service.queryCatalog({ query: 'photo.png' }).items[0]
    assert.equal(after.fileEntryId, before.fileEntryId)
    assert.equal(after.displayPath, path.resolve(newFile).toLowerCase())
    assert.equal(service.listSources()[0].rootLocator, path.resolve(newRoot))
  } finally {
    service.close()
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('mounted-network root repair rejects a different share before changing catalog paths', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mounted-repair-reject-'))
  const oldRoot = path.join(temp, 'old-share')
  const wrongRoot = path.join(temp, 'wrong-share')
  fs.mkdirSync(oldRoot)
  fs.mkdirSync(wrongRoot)
  fs.writeFileSync(path.join(oldRoot, 'photo.png'), 'original')
  fs.writeFileSync(path.join(wrongRoot, 'photo.png'), 'different-size-and-content')
  const service = new SourceCatalogService({ databasePath: path.join(temp, 'catalog.sqlite') })
  try {
    const added = service.addSource({
      type: 'mounted-network',
      displayName: 'Protected NAS',
      rootLocator: oldRoot,
    })
    service.startScan(added.source.id)
    while (service.getScanStatus(added.source.id)[0].running) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const before = service.queryCatalog({}).items[0]
    const rejected = await service.repairMountedSourceRoot(added.source.id, wrongRoot)
    assert.equal(rejected.ok, false)
    assert.match(rejected.error, /does not match/i)
    assert.equal(service.queryCatalog({}).items[0].displayPath, before.displayPath)
    assert.equal(service.listSources()[0].rootLocator, path.resolve(oldRoot))
  } finally {
    service.close()
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('Sources UI repairs mounted-network roots through folder selection and source id', () => {
  const ui = fs.readFileSync('src/components/DiscoverySourcesSection.tsx', 'utf8')
  assert.match(ui, /source\.canRepairRoot/)
  assert.match(ui, /browseFolder\(\)/)
  assert.match(ui, /repairSourceRoot\(sourceId, newRoot\)/)
})
