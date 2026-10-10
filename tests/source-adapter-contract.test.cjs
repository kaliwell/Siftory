// Phase 1 source adapter contract test against the real native scanner:
// - the LocalNtfsSourceAdapter wraps the current native scan (USN preferred,
//   directory-enumeration fallback) and streams committed batches
// - the discovered result set matches the directory-enumeration baseline
//   (integrity acceptance), whatever backend the native scanner picked
// - fallback backend reports a non-empty degradation reason
// - cancel + rescan through SourceCatalogService stays duplicate-free
//
// Skips cleanly when the native addon is not built or the platform is not
// Windows (the addon only ships win32 binaries in this repo).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const addonPath = path.join(__dirname, '..', 'native', 'build', 'Release', 'fast_scanner.node')
const addonAvailable = process.platform === 'win32' && fs.existsSync(addonPath)

const { LocalNtfsSourceAdapter } = loadTsModule('electron/sourceAdapter.ts')
const { SourceCatalogService } = loadTsModule('electron/sourceCatalogService.ts')

function createPng(filePath) {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, png)
}

// Directory-enumeration baseline over the fixture tree, restricted to the
// file types the native image scanner enumerates.
function baselineImagePaths(root) {
  const results = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(entry.name)) {
        results.push(process.platform === 'win32' ? full.toLowerCase() : full)
      }
    }
  }
  walk(root)
  return results.sort()
}

async function drainEnumeration(adapter, source, signal) {
  const entries = new Map()
  const progressLog = []
  for await (const batch of adapter.enumerate({ source, signal })) {
    for (const entry of batch.entries) {
      const key =
        process.platform === 'win32' ? entry.absolutePath.toLowerCase() : entry.absolutePath
      entries.set(key, entry)
    }
    progressLog.push(batch.progress)
    if (batch.final) break
  }
  return { entries, progressLog }
}

async function waitFor(condition, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = condition()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('waitFor timed out')
}

// These tests never connect the real addon or read the synthetic source root.
function memoryFixture(overrides = {}) {
  const root = path.resolve('synthetic-discovery-fixture')
  const source = {
    id: 'memory-source',
    type: 'local-ntfs',
    displayName: 'Memory fixture',
    rootLocator: root,
    readOnly: true,
    availability: 'unknown',
    scanCapability: 'usn',
  }
  const calls = { starts: 0, stops: 0 }
  const exports = { opened: 0, closed: 0 }
  const cursors = new Map()
  const addon = {
    scanDirectory() {
      calls.starts++
      return { ok: true, generation: 1 }
    },
    getScanProgress: () => ({ generation: 1, state: 'idle', backend: 'enum' }),
    captureRecords: () => ({ ok: true, records: [] }),
    async snapshotScanRecordsAsync(generation) {
      const captured = await addon.captureRecords()
      if (!captured.ok) return captured
      const cursor = `fixture-${++exports.opened}`
      cursors.set(cursor, captured.records)
      return {
        ok: true,
        cursor,
        generation,
        recordCount: captured.recordCount ?? captured.records?.length,
      }
    },
    readScanExportPage(cursor, generation, offset, limit) {
      const all = cursors.get(cursor)
      const records = all.slice(offset, offset + limit)
      return {
        ok: true,
        generation,
        records,
        nextOffset: offset + records.length,
        hasMore: offset + records.length < all.length,
      }
    },
    async closeIndexExport(cursor) {
      exports.closed++
      cursors.delete(cursor)
      return { ok: true }
    },
    snapshotIndexRecords() {
      assert.fail('Production discovery must not capture synchronously')
    },
    queryIndexRecords() {
      assert.fail('Production discovery must not use synchronous query fallback')
    },
    async stopScanGenerationAsync(generation) {
      assert.equal(generation, 1)
      calls.stops++
      return { ok: true }
    },
    ...overrides,
  }
  const controller = new AbortController()
  const adapter = new LocalNtfsSourceAdapter({ addon, pollIntervalMs: 0 })
  const iterator = adapter.enumerate({ source, signal: controller.signal })
  return { root, source, addon, calls, exports, cursors, controller, iterator }
}

function memoryRecord(root, name, modifiedTime = 1) {
  return { path: path.join(root, name), fileSize: 12, modifiedTime, width: 1, height: 1 }
}

for (const [name, overrides, message] of [
  [
    'snapshot refusal',
    { captureRecords: () => ({ ok: false, error: 'snapshot budget exceeded' }) },
    /snapshot budget exceeded/,
  ],
  [
    'scan error',
    { getScanProgress: () => ({ generation: 1, state: 'error', lastError: 'scan crashed' }) },
    /scan crashed/,
  ],
  [
    'export page failure',
    {
      captureRecords: () => ({ ok: true, records: [], recordCount: 1 }),
      readScanExportPage: () => ({ ok: false, error: 'query failed' }),
    },
    /query failed/,
  ],
  ['missing snapshot records', { captureRecords: () => ({ ok: true }) }, /snapshot/i],
  [
    'inconsistent snapshot count',
    { captureRecords: () => ({ ok: true, records: [], recordCount: 3 }) },
    /count/i,
  ],
  [
    'export page without progress',
    {
      captureRecords: () => ({ ok: true, records: [], recordCount: 1 }),
      readScanExportPage: () => ({
        ok: true,
        generation: 1,
        records: [],
        nextOffset: 0,
        hasMore: true,
      }),
    },
    /progress/i,
  ],
  [
    'export page offset mismatch',
    {
      captureRecords: () => ({ ok: true, records: [], recordCount: 1 }),
      readScanExportPage: () => ({
        ok: true,
        generation: 1,
        records: [],
        nextOffset: 4,
        hasMore: false,
      }),
    },
    /bounds/i,
  ],
  [
    'missing export continuation',
    {
      captureRecords: () => ({ ok: true, records: [], recordCount: 1 }),
      readScanExportPage: () => ({ ok: true, generation: 1, records: [], nextOffset: 0 }),
    },
    /page/i,
  ],
  [
    'oversized export page',
    {
      captureRecords: () => ({ ok: true, records: [], recordCount: 1 }),
      readScanExportPage: () => ({
        ok: true,
        generation: 1,
        records: Array(257).fill(null),
        nextOffset: 257,
        hasMore: false,
      }),
    },
    /bounds/i,
  ],
  ['malformed Native record', { captureRecords: () => ({ ok: true, records: [null] }) }, /record/i],
  [
    'unknown scan state',
    { getScanProgress: () => ({ generation: 1, state: 'unexpected' }) },
    /state/i,
  ],
]) {
  test(`local discovery rejects ${name} instead of completing an empty catalog`, async () => {
    const fixture = memoryFixture(overrides)
    const batches = []
    await assert.rejects(async () => {
      for await (const batch of fixture.iterator) batches.push(batch)
    }, message)
    assert.equal(
      batches.some((batch) => batch.final),
      false,
    )
  })
}

test('local discovery stops its scan on read failure and preserves the original error', async () => {
  const fixture = memoryFixture({
    getScanProgress: () => ({ generation: 1, state: 'scanning' }),
    captureRecords: () => ({ ok: false, error: 'read refused' }),
  })
  await assert.rejects(fixture.iterator.next(), /read refused/)
  assert.equal(fixture.calls.stops, 1)
})

test('local discovery reports cleanup failure together with the read error', async () => {
  const fixture = memoryFixture({
    getScanProgress: () => ({ generation: 1, state: 'scanning' }),
    captureRecords: () => ({ ok: false, error: 'read refused' }),
    stopScanGenerationAsync: async () => ({ ok: false, error: 'stop refused' }),
  })
  await assert.rejects(fixture.iterator.next(), (error) => {
    assert.match(error.message, /read refused/)
    assert.match(error.message, /stop refused/)
    return true
  })
})

test('pre-cancelled discovery does not acquire or stop a native scan', async () => {
  const fixture = memoryFixture()
  fixture.controller.abort()
  await assert.rejects(fixture.iterator.next(), (error) => error.code === 'SCAN_CANCELLED')
  assert.deepEqual(fixture.calls, { starts: 0, stops: 0 })
})

test('a rejected scan start never stops another owner', async () => {
  const fixture = memoryFixture({ scanDirectory: () => ({ ok: false, error: 'Already scanning' }) })
  await assert.rejects(fixture.iterator.next(), /Already scanning/)
  assert.equal(fixture.calls.stops, 0)
})

test('old Native without conditional-stop support fails before starting a scan', async () => {
  const fixture = memoryFixture({ stopScanGenerationAsync: undefined })
  await assert.rejects(fixture.iterator.next(), (error) => error.code === 'ADAPTER_UNAVAILABLE')
  assert.deepEqual(fixture.calls, { starts: 0, stops: 0 })
})

test('discovery refuses Native without scan-owned asynchronous export before starting', async () => {
  const fixture = memoryFixture({ snapshotScanRecordsAsync: undefined })
  await assert.rejects(fixture.iterator.next(), (error) => error.code === 'ADAPTER_UNAVAILABLE')
  assert.deepEqual(fixture.calls, { starts: 0, stops: 0 })
})

test('abort while awaiting capture requests owned stop immediately and closes any returned cursor', async () => {
  let finishCapture
  const fixture = memoryFixture({
    getScanProgress: () => ({ generation: 1, state: 'scanning' }),
    captureRecords: () =>
      new Promise((resolve) => {
        finishCapture = resolve
      }),
  })
  const result = fixture.iterator.next()
  const rejected = assert.rejects(result, (error) => error.code === 'SCAN_CANCELLED')
  await new Promise(setImmediate)
  fixture.controller.abort()
  await Promise.resolve()
  assert.equal(fixture.calls.stops, 1, 'abort must reach Native while capture is still pending')
  finishCapture({ ok: true, records: [] })
  await rejected
  assert.deepEqual(fixture.exports, { opened: 1, closed: 1 })
  assert.equal(fixture.cursors.size, 0)
})

for (const missing of ['readScanExportPage', 'closeIndexExport']) {
  test(`discovery refuses missing ${missing} before acquiring a scan`, async () => {
    const fixture = memoryFixture({ [missing]: undefined })
    await assert.rejects(fixture.iterator.next(), (error) => error.code === 'ADAPTER_UNAVAILABLE')
    assert.equal(fixture.calls.starts, 0)
  })
}

test('capture and page generation mismatches close their cursor and cannot complete discovery', async () => {
  for (const mismatch of ['capture', 'page']) {
    const fixture = memoryFixture()
    fixture.addon.captureRecords = () => ({
      ok: true,
      records: [memoryRecord(fixture.root, 'a.png')],
    })
    const name = mismatch === 'capture' ? 'snapshotScanRecordsAsync' : 'readScanExportPage'
    const original = fixture.addon[name].bind(fixture.addon)
    fixture.addon[name] =
      mismatch === 'capture'
        ? async (...args) => ({ ...(await original(...args)), generation: 2 })
        : (...args) => ({ ...original(...args), generation: 2 })
    await assert.rejects(fixture.iterator.next(), /generation mismatch/)
    assert.deepEqual(fixture.exports, { opened: 1, closed: 1 })
    assert.equal(fixture.cursors.size, 0)
  }
})

test('asynchronous cursor close is revalidated before final completion', async () => {
  let generation = 1
  const fixture = memoryFixture({ getScanProgress: () => ({ generation, state: 'idle' }) })
  const close = fixture.addon.closeIndexExport
  fixture.addon.closeIndexExport = async (cursor) => {
    await new Promise(setImmediate)
    generation = 2
    return close(cursor)
  }
  await assert.rejects(fixture.iterator.next(), /replaced.*generation/)
  assert.deepEqual(fixture.exports, { opened: 1, closed: 1 })
})

test('cursor cleanup failure keeps the original page failure and prevents successful completion', async () => {
  const fixture = memoryFixture({
    captureRecords: () => ({ ok: true, records: [], recordCount: 1 }),
    readScanExportPage: () => ({ ok: false, error: 'page failed' }),
    closeIndexExport: async () => {
      throw new Error('close failed')
    },
  })
  await assert.rejects(fixture.iterator.next(), (error) => {
    assert.equal(error.code, 'SCAN_FAILED')
    assert.match(error.message, /page failed/)
    assert.match(error.message, /close failed/)
    return true
  })
  assert.equal(fixture.calls.stops, 1)
})

test('consumer return, throw and abort release every open native cursor', async () => {
  for (const exit of ['return', 'throw', 'abort']) {
    const fixture = memoryFixture({ getScanProgress: () => ({ generation: 1, state: 'scanning' }) })
    fixture.addon.captureRecords = () => ({
      ok: true,
      records: Array.from({ length: 600 }, (_, i) => memoryRecord(fixture.root, `${i}.png`)),
    })
    assert.equal((await fixture.iterator.next()).value.entries.length, 256)
    assert.deepEqual(fixture.exports, { opened: 1, closed: 0 })
    if (exit === 'return') await fixture.iterator.return()
    else if (exit === 'throw')
      await assert.rejects(
        fixture.iterator.throw(new Error('consumer failure')),
        /consumer failure/,
      )
    else {
      fixture.controller.abort()
      await assert.rejects(fixture.iterator.next(), (error) => error.code === 'SCAN_CANCELLED')
    }
    assert.deepEqual(fixture.exports, { opened: 1, closed: 1 })
    assert.equal(fixture.cursors.size, 0)
    assert.equal(fixture.calls.stops, 1)
  }
})

test('replacement generation interrupts delivery and old cleanup does not stop the replacement', async () => {
  let generation = 1
  let replacementStopped = false
  const fixture = memoryFixture({ getScanProgress: () => ({ state: 'scanning', generation }) })
  fixture.addon.captureRecords = () => ({
    ok: true,
    records: Array.from({ length: 600 }, (_, i) => memoryRecord(fixture.root, `${i}.png`)),
  })
  fixture.addon.stopScanGenerationAsync = async (owner) => {
    if (owner === generation) replacementStopped = true
    return { ok: true, matched: owner === generation }
  }
  assert.equal((await fixture.iterator.next()).value.entries.length, 256)
  generation = 2
  await assert.rejects(fixture.iterator.next(), /replaced.*generation/i)
  assert.equal(replacementStopped, false)
})

test('consumer return uses original generation even before observing replacement progress', async () => {
  let generation = 1
  const stopped = []
  const fixture = memoryFixture({ getScanProgress: () => ({ state: 'scanning', generation }) })
  fixture.addon.captureRecords = () => ({
    ok: true,
    records: [memoryRecord(fixture.root, 'a.png')],
  })
  fixture.addon.stopScanGenerationAsync = async (owner) => {
    stopped.push(owner)
    return { ok: true, matched: owner === generation }
  }
  await fixture.iterator.next()
  generation = 2
  await fixture.iterator.return()
  assert.deepEqual(stopped, [1])
})

test('local discovery stops and awaits cleanup when a consumer returns early', async () => {
  let releaseStop
  const fixture = memoryFixture({ getScanProgress: () => ({ generation: 1, state: 'scanning' }) })
  fixture.addon.captureRecords = () => ({
    ok: true,
    records: [memoryRecord(fixture.root, 'a.png')],
  })
  fixture.addon.stopScanGenerationAsync = () =>
    new Promise((resolve) => {
      fixture.calls.stops++
      releaseStop = resolve
    })
  assert.equal((await fixture.iterator.next()).value.final, false)
  let returned = false
  const pending = fixture.iterator.return().then(() => {
    returned = true
  })
  await new Promise(setImmediate)
  assert.equal(fixture.calls.stops, 1)
  assert.equal(returned, false)
  releaseStop({ ok: true })
  await pending
})

test('local discovery cancels between delivered batches without reporting completion', async () => {
  const fixture = memoryFixture({ getScanProgress: () => ({ generation: 1, state: 'scanning' }) })
  fixture.addon.captureRecords = () => ({
    ok: true,
    records: Array.from({ length: 600 }, (_, i) => memoryRecord(fixture.root, `${i}.png`)),
  })
  const first = await fixture.iterator.next()
  assert.equal(first.value.entries.length, 256)
  assert.equal(first.value.final, false)
  fixture.controller.abort()
  await assert.rejects(fixture.iterator.next(), (error) => error.code === 'SCAN_CANCELLED')
  assert.equal(fixture.calls.stops, 1)
})

test('consumer failure also releases its generation-bound scan owner', async () => {
  const fixture = memoryFixture({
    getScanProgress: () => ({ generation: 1, state: 'scanning' }),
  })
  fixture.addon.stopScanGenerationAsync = async (generation) => {
    assert.equal(generation, 1)
    fixture.calls.stops++
    return { ok: true }
  }
  fixture.addon.captureRecords = () => ({
    ok: true,
    records: [memoryRecord(fixture.root, 'a.png')],
  })
  await fixture.iterator.next()
  await assert.rejects(fixture.iterator.throw(new Error('consumer failed')), /consumer failed/)
  assert.equal(fixture.calls.stops, 1)
})

test('cleanup promise rejection is visible on consumer return', async () => {
  const fixture = memoryFixture({
    getScanProgress: () => ({ generation: 1, state: 'scanning' }),
    stopScanGenerationAsync: async () => {
      throw new Error('async stop failed')
    },
  })
  fixture.addon.captureRecords = () => ({
    ok: true,
    records: [memoryRecord(fixture.root, 'a.png')],
  })
  await fixture.iterator.next()
  await assert.rejects(fixture.iterator.return(), /async stop failed/)
})

test('pages containing only excluded roots remain cancellable', async () => {
  const fixture = memoryFixture({ getScanProgress: () => ({ generation: 1, state: 'scanning' }) })
  fixture.addon.captureRecords = () => ({
    ok: true,
    records: Array.from({ length: 2048 }, (_, i) =>
      memoryRecord(path.dirname(fixture.root), `outside-${i}.png`),
    ),
  })
  setImmediate(() => fixture.controller.abort())
  await assert.rejects(fixture.iterator.next(), (error) => error.code === 'SCAN_CANCELLED')
  assert.equal(fixture.calls.stops, 1)
})

test('local discovery delivers bounded batches and lets the event loop run between them', async () => {
  const fixture = memoryFixture()
  fixture.addon.captureRecords = () => ({
    ok: true,
    records: Array.from({ length: 600 }, (_, i) => memoryRecord(fixture.root, `${i}.png`)),
  })
  const first = await fixture.iterator.next()
  assert.equal(first.value.entries.length, 256)
  assert.equal(first.value.final, false)
  let eventLoopRan = false
  setImmediate(() => {
    eventLoopRan = true
  })
  const second = await fixture.iterator.next()
  assert.equal(eventLoopRan, true)
  assert.equal(second.value.entries.length, 256)
  const rest = []
  for await (const batch of fixture.iterator) rest.push(batch)
  assert.equal(rest.flatMap((batch) => batch.entries).length, 88)
  assert.equal(rest.at(-1).final, true)
  assert.equal(rest.at(-1).progress.discoveredCount, 600)
  assert.equal(fixture.calls.stops, 0)
})

test('transient stopping is not a terminal state until an uncancelled idle outcome', async () => {
  let polls = 0
  const fixture = memoryFixture({
    getScanProgress: () => ({
      generation: 1,
      state: ++polls === 1 ? 'stopping' : 'idle',
      backend: 'enum',
    }),
  })
  fixture.addon.captureRecords = () => ({
    ok: true,
    records: [memoryRecord(fixture.root, 'a.png')],
  })
  const batches = []
  for await (const batch of fixture.iterator) batches.push(batch)
  assert.equal(batches[0].final, false)
  assert.equal(batches.at(-1).final, true)
  assert.ok(polls >= 2)
})

test('an external stop in the same generation cannot turn partial discovery into completion', async () => {
  let stopped = false
  const fixture = memoryFixture({
    getScanProgress: () => ({
      generation: 1,
      state: stopped ? 'idle' : 'scanning',
      cancelled: stopped,
    }),
  })
  fixture.addon.captureRecords = () => ({
    ok: true,
    records: [memoryRecord(fixture.root, 'a.png')],
  })
  assert.equal((await fixture.iterator.next()).value.final, false)
  stopped = true
  await assert.rejects(fixture.iterator.next(), (error) => error.code === 'SCAN_CANCELLED')
  assert.equal(fixture.calls.stops, 1)
})

test('export failure after a page preserves partial delivery but never completes', async () => {
  const fixture = memoryFixture({
    captureRecords: () => ({ ok: true, records: [], recordCount: 2 }),
    getScanProgress: () => ({ generation: 1, state: 'scanning' }),
  })
  fixture.addon.readScanExportPage = (_cursor, generation, offset) =>
    offset === 0
      ? {
          ok: true,
          generation,
          records: [memoryRecord(fixture.root, 'a.png')],
          nextOffset: 1,
          hasMore: true,
        }
      : { ok: false, error: 'second page failed' }
  const first = await fixture.iterator.next()
  assert.equal(first.value.entries.length, 1)
  assert.equal(first.value.final, false)
  await assert.rejects(fixture.iterator.next(), /second page failed/)
  assert.equal(fixture.calls.stops, 1)
})

test('local discovery filters other roots and re-delivers only changed size/mtime', async () => {
  let polls = 0
  const fixture = memoryFixture({
    getScanProgress: () => ({ generation: 1, state: ++polls < 3 ? 'scanning' : 'idle' }),
  })
  fixture.addon.captureRecords = () => ({
    ok: true,
    records: [
      memoryRecord(fixture.root, 'a.png', polls < 3 ? 1 : 2),
      memoryRecord(fixture.root, 'a.png', polls < 3 ? 1 : 2),
      memoryRecord(path.dirname(fixture.root), 'outside.png'),
      memoryRecord(fixture.root, '..valid.png'),
    ],
  })
  const batches = []
  for await (const batch of fixture.iterator) batches.push(batch)
  assert.deepEqual(
    batches.flatMap((batch) => batch.entries).map((entry) => [entry.name, entry.modifiedAt]),
    [
      ['a.png', 1],
      ['..valid.png', 1],
      ['a.png', 2],
    ],
  )
  assert.equal(batches.at(-1).progress.discoveredCount, 2)
})

test('catalog keeps committed rows and successful-scan timestamp when a rescan fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-failed-catalog-'))
  const fixture = memoryFixture()
  let clock = 100
  const service = new SourceCatalogService({
    databasePath: path.join(root, 'catalog.sqlite'),
    now: () => ++clock,
    adapterFactory: () => new LocalNtfsSourceAdapter({ addon: fixture.addon, pollIntervalMs: 0 }),
  })
  try {
    const added = service.addSource({
      type: 'local-ntfs',
      displayName: 'Fixture',
      rootLocator: root,
    })
    assert.equal(added.ok, true)
    const id = added.source.id
    fixture.addon.captureRecords = () => ({
      ok: true,
      records: [memoryRecord(root, 'a.png')],
    })
    service.startScan(id)
    await waitFor(() => !service.getScanStatus(id)[0].running)
    const before = service.listSources().find((source) => source.id === id)
    assert.equal(before.lastScanState, 'completed')
    assert.equal(service.queryCatalog({}).total, 1)
    let reads = 0
    fixture.addon.getScanProgress = () => ({ generation: 1, state: 'scanning', backend: 'enum' })
    fixture.addon.captureRecords = () =>
      ++reads === 1
        ? { ok: true, records: [memoryRecord(root, 'b.png')] }
        : { ok: false, error: 'injected export refusal' }
    service.startScan(id)
    await waitFor(() => !service.getScanStatus(id)[0].running)
    const after = service.listSources().find((source) => source.id === id)
    assert.equal(after.lastScanState, 'error')
    assert.equal(after.availability, 'degraded')
    assert.equal(after.lastSuccessfulScanAt, before.lastSuccessfulScanAt)
    assert.equal(service.queryCatalog({}).total, 2)
    assert.equal(fixture.calls.stops, 1)
    assert.match(service.getScanStatus(id)[0].session.error, /injected export refusal/)
  } finally {
    service.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test(
  'local NTFS adapter discovers exactly the directory-enumeration baseline',
  { skip: !addonAvailable, timeout: 60000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-contract-'))
    try {
      for (let index = 0; index < 12; index += 1) {
        createPng(path.join(root, `sub${index % 3}`, `img_${String(index).padStart(3, '0')}.png`))
      }
      fs.writeFileSync(path.join(root, 'notes.txt'), 'not an image')
      const addon = require(addonPath)
      const adapter = new LocalNtfsSourceAdapter({ addon, pollIntervalMs: 50 })
      const source = {
        id: 'src_contract',
        type: 'local-ntfs',
        displayName: 'Contract',
        rootLocator: root,
        readOnly: true,
        availability: 'unknown',
        scanCapability: 'usn',
      }
      const controller = new AbortController()
      const { entries, progressLog } = await drainEnumeration(adapter, source, controller.signal)
      const discovered = [...entries.keys()].sort()
      assert.deepEqual(discovered, baselineImagePaths(root))
      const finalProgress = progressLog[progressLog.length - 1]
      assert.ok(['usn', 'directory'].includes(finalProgress.backend))
      if (finalProgress.backend === 'directory') {
        assert.ok(
          finalProgress.fallbackReason || finalProgress.fallbackCode,
          'directory fallback must surface a degradation reason',
        )
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'service + native adapter: cancel, restart and rescan stay duplicate-free',
  { skip: !addonAvailable, timeout: 60000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-service-'))
    try {
      for (let index = 0; index < 8; index += 1) {
        createPng(path.join(root, `pic_${index}.png`))
      }
      const addon = require(addonPath)
      const service = new SourceCatalogService({
        databasePath: path.join(root, 'catalog.sqlite'),
        adapterFactory: () => new LocalNtfsSourceAdapter({ addon, pollIntervalMs: 50 }),
      })
      try {
        const added = service.addSource({
          type: 'local-ntfs',
          displayName: 'Native',
          rootLocator: root,
        })
        assert.equal(added.ok, true, added.error)
        const sourceId = added.source.id

        // First scan to completion.
        assert.equal(service.startScan(sourceId).ok, true)
        await waitFor(() => service.getScanStatus(sourceId)[0].running === false)
        const baselineTotal = service.queryCatalog({}).total
        assert.equal(baselineTotal, 8)

        // Cancel a scan immediately (may finish before the abort lands —
        // either way the invariant below must hold).
        assert.equal(service.startScan(sourceId).ok, true)
        service.cancelScan(sourceId)
        await waitFor(() => service.getScanStatus(sourceId)[0].running === false)
        assert.ok(
          ['cancelled', 'completed'].includes(service.getScanStatus(sourceId)[0].session.state),
        )
        assert.equal(service.queryCatalog({}).total, baselineTotal)

        // Rescan after cancel/restart: no duplicate FileEntry rows and
        // stable identities.
        const idsBefore = service
          .queryCatalog({ limit: 50 })
          .items.map((item) => item.fileEntryId)
          .sort()
        assert.equal(service.startScan(sourceId).ok, true)
        await waitFor(() => service.getScanStatus(sourceId)[0].running === false)
        assert.equal(service.queryCatalog({}).total, baselineTotal)
        assert.deepEqual(
          service
            .queryCatalog({ limit: 50 })
            .items.map((item) => item.fileEntryId)
            .sort(),
          idsBefore,
        )
      } finally {
        service.close()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)
