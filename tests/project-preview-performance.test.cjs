const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')
const { ProjectPreviewManifestStore, projectSourceId } = loadTsModule(
  'electron/projectPreviewManifest.ts',
)
test('batched manifest checkpoints persist every 32 updates and flush the tail on cancellation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-batch-'))
  try {
    const store = new ProjectPreviewManifestStore(root)
    await Promise.all([store.load(), store.load()])
    store.beginBatch()
    for (let i = 0; i < 35; i++) {
      const sourcePath = path.join(root, `${i}.psd`)
      await store.upsert({
        sourceId: projectSourceId(sourcePath),
        sourcePath,
        sourceExt: 'psd',
        size: 1,
        mtimeMs: 1,
        provider: 'test',
        providerVersion: '1',
        keywords: [],
        status: 'unavailable',
        updatedAt: 1,
      })
      if (i === 30) assert.equal(fs.existsSync(store.manifestPath), false)
      if (i === 31) assert.equal(JSON.parse(fs.readFileSync(store.manifestPath)).entries.length, 32)
    }
    // The indexing finally block calls endBatch even on cancellation/errors.
    await store.endBatch()
    const reopened = new ProjectPreviewManifestStore(root)
    assert.equal((await reopened.list()).length, 35)
    assert.equal(
      fs.readdirSync(store.rootDir).some((x) => x.endsWith('.tmp')),
      false,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a failed manifest write rejects its caller and the next checkpoint can retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-retry-'))
  try {
    const store = new ProjectPreviewManifestStore(root)
    await store.load()
    const original = store.writeAtomic.bind(store)
    store.writeAtomic = async () => {
      throw new Error('simulated write failure')
    }
    const sourcePath = path.join(root, 'a.psd')
    await assert.rejects(
      store.upsert({
        sourceId: projectSourceId(sourcePath),
        sourcePath,
        sourceExt: 'psd',
        size: 1,
        mtimeMs: 1,
        provider: 'test',
        providerVersion: '1',
        keywords: [],
        status: 'unavailable',
        updatedAt: 1,
      }),
      /simulated write failure/,
    )
    store.writeAtomic = original
    await store.flush()
    assert.equal((await new ProjectPreviewManifestStore(root).list()).length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('cancelled project indexing flushes the completed preview and its native hash metadata', async () => {
  const { initProjectSearchIndex, indexProjectPreviews } = loadTsModule(
    'electron/projectSearchIndexService.ts',
  )
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-cancel-'))
  const data = path.join(root, 'data'),
    source = path.join(root, 'source')
  fs.mkdirSync(source)
  for (let i = 0; i < 3; i++)
    fs.writeFileSync(
      path.join(source, `${i}.svg`),
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>',
    )
  let cancelled = false
  try {
    await initProjectSearchIndex(data)
    const result = await indexProjectPreviews(
      [source],
      {
        hashImageAsync: async () => ({
          ok: true,
          width: 64,
          height: 64,
          diffHash64: '1'.repeat(16),
          dctHash64: '2'.repeat(16),
        }),
        upsertIndexRecord: () => {
          cancelled = true
          return { ok: true }
        },
        deleteIndexPath: () => ({ ok: true }),
        removeSourceVectorData: () => {},
      },
      { isCancelled: () => cancelled },
    )
    assert.equal(result.cancelled, true)
    assert.equal(result.indexed, 1)
    const entries = await new ProjectPreviewManifestStore(data).list()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].diffHash64, '1'.repeat(16))
    assert.ok(fs.existsSync(entries[0].previewPath))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('cancelling during hash calculation prevents a late native-index write', async () => {
  const { initProjectSearchIndex, indexProjectPreviews } = loadTsModule(
    'electron/projectSearchIndexService.ts',
  )
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-late-cancel-'))
  const source = path.join(root, 'source')
  fs.mkdirSync(source)
  fs.writeFileSync(
    path.join(source, 'a.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>',
  )
  let cancelled = false,
    writes = 0
  try {
    await initProjectSearchIndex(path.join(root, 'data'))
    const result = await indexProjectPreviews(
      [source],
      {
        hashImageAsync: async () => {
          cancelled = true
          return {
            ok: true,
            width: 64,
            height: 64,
            diffHash64: '1'.repeat(16),
            dctHash64: '2'.repeat(16),
          }
        },
        upsertIndexRecord: () => {
          writes++
          return { ok: true }
        },
        deleteIndexPath: () => ({ ok: true }),
        removeSourceVectorData: () => {},
      },
      { isCancelled: () => cancelled },
    )
    assert.equal(result.cancelled, true)
    assert.equal(writes, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('missing-source cleanup preserves permission failures and removes only confirmed missing files', async () => {
  const { initProjectSearchIndex, indexProjectPreviews } = loadTsModule(
    'electron/projectSearchIndexService.ts',
  )
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-stale-')),
    data = path.join(root, 'data'),
    source = path.join(root, 'source')
  fs.mkdirSync(source)
  const denied = path.join(source, 'denied.psd'),
    missing = path.join(source, 'missing.psd')
  const store = new ProjectPreviewManifestStore(data)
  for (const sourcePath of [denied, missing])
    await store.upsert({
      sourceId: projectSourceId(sourcePath),
      sourcePath,
      sourceExt: 'psd',
      size: 1,
      mtimeMs: 1,
      provider: 'test',
      providerVersion: '1',
      keywords: [],
      status: 'unavailable',
      updatedAt: 1,
    })
  const stat = fs.promises.stat,
    removed = []
  try {
    await initProjectSearchIndex(data)
    fs.promises.stat = async (file, ...args) => {
      if (file === denied) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return stat(file, ...args)
    }
    const result = await indexProjectPreviews([source], {
      hashImageAsync: async () => ({ ok: false }),
      upsertIndexRecord: () => ({ ok: true }),
      deleteIndexPath: () => ({ ok: true }),
      removeSourceVectorData: (file) => removed.push(file),
    })
    assert.equal(result.removed, 1)
    assert.deepEqual(removed, [missing])
    const entries = await new ProjectPreviewManifestStore(data).list()
    assert.deepEqual(
      entries.map((x) => x.sourcePath),
      [denied],
    )
  } finally {
    fs.promises.stat = stat
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('large manifest serialization yields between transfer chunks and writes a complete snapshot', async () => {
  const { runProjectPreviewCompute } = loadTsModule('electron/projectPreviewCompute.ts')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-yield-'))
  let turns = 0,
    running = true
  const heartbeat = () => {
    if (running) {
      turns++
      setImmediate(heartbeat)
    }
  }
  try {
    const entries = Array.from({ length: 10000 }, (_, i) => ({
      sourcePath: `synthetic-${10000 - i}`,
    }))
    const temporaryPath = path.join(root, 'snapshot.tmp')
    setImmediate(heartbeat)
    await runProjectPreviewCompute({ kind: 'manifest', entries, temporaryPath })
    assert.ok(turns >= 10, `expected event loop turns during chunking, got ${turns}`)
    assert.equal(JSON.parse(fs.readFileSync(temporaryPath)).entries.length, 10000)
  } finally {
    running = false
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an unavailable scan root does not purge its cached project records', async () => {
  const { initProjectSearchIndex, indexProjectPreviews } = loadTsModule(
    'electron/projectSearchIndexService.ts',
  )
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-offline-root-')),
    data = path.join(root, 'data'),
    source = path.join(root, 'offline')
  const sourcePath = path.join(source, 'a.psd'),
    store = new ProjectPreviewManifestStore(data)
  await store.upsert({
    sourceId: projectSourceId(sourcePath),
    sourcePath,
    sourceExt: 'psd',
    size: 1,
    mtimeMs: 1,
    provider: 'test',
    providerVersion: '1',
    keywords: [],
    status: 'unavailable',
    updatedAt: 1,
  })
  try {
    await initProjectSearchIndex(data)
    const result = await indexProjectPreviews([source], {
      hashImageAsync: async () => ({ ok: false }),
      upsertIndexRecord: () => ({ ok: true }),
      deleteIndexPath: () => {
        throw Error('must not delete')
      },
      removeSourceVectorData: () => {
        throw Error('must not delete')
      },
    })
    assert.equal(result.removed, 0)
    assert.equal((await new ProjectPreviewManifestStore(data).list()).length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('fast previews are indexed before PDF work and async upserts finish before success is reported', async () => {
  const { initProjectSearchIndex, indexProjectPreviews } = loadTsModule(
    'electron/projectSearchIndexService.ts',
  )
  const { getProjectPreviewService } = loadTsModule('electron/projectPreviewService.ts')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-priority-'))
  const source = path.join(root, 'source'),
    data = path.join(root, 'data')
  fs.mkdirSync(source)
  fs.writeFileSync(
    path.join(source, 'a.pdf'),
    require('./fixtures/project-preview-assets.cjs').makePdf(),
  )
  fs.writeFileSync(
    path.join(source, 'z.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>',
  )
  const events = [],
    requests = []
  try {
    await initProjectSearchIndex(data)
    const service = getProjectPreviewService(data),
      original = service.getOrCreate.bind(service)
    service.getOrCreate = async (file, options) => {
      events.push(path.extname(file))
      requests.push(options)
      return original(file, options)
    }
    let committed = 0
    const result = await indexProjectPreviews([source], {
      hashImageAsync: async () => ({
        ok: true,
        width: 32,
        height: 32,
        diffHash64: '1'.repeat(16),
        dctHash64: '2'.repeat(16),
      }),
      upsertIndexRecord: async () => {
        await new Promise((r) => setTimeout(r, 5))
        committed++
        return { ok: true }
      },
      deleteIndexPath: () => ({ ok: true }),
      removeSourceVectorData: () => {},
    })
    assert.deepEqual(events, ['.svg', '.pdf'])
    assert.equal(result.indexed, 2)
    assert.equal(committed, 2)
    assert.ok(requests.every((request) => request.pdfTimeoutMs === 15000))
    const { prepareProjectSearchInput } = loadTsModule('electron/projectSearchIndexService.ts')
    assert.ok(await prepareProjectSearchInput(path.join(source, 'a.pdf')))
    assert.equal(requests.at(-1).forceRetry, true)
    assert.equal(requests.at(-1).pdfTimeoutMs, 120000)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
