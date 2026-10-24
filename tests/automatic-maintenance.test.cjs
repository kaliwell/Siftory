const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')
const {
  AutomaticMaintenanceService,
  AUTOMATIC_MISSING_GRACE_MS: DAY,
  normalizeAutomaticMaintenanceConfig,
} = loadTsModule('electron/automaticMaintenanceService.ts')
const { expireAutomaticMaintenanceBackups } = loadTsModule(
  'electron/automaticMaintenanceBackups.ts',
)

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-auto-maintenance-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let now = Date.now(),
    idle = true,
    busy = null,
    leases = 0
  const scope = path.join(dir, 'materials')
  const missing = new Set([path.join(scope, 'missing.jpg')])
  let eligible = [],
    applies = 0,
    gcStarts = 0
  const gc = {
    token: 'gc',
    activeAssetCount: 100,
    shards: [{ sourceBytes: 1024 ** 3, activeRecords: 80 }],
    reclaimableBytes: 0,
  }
  const deps = {
    now: () => now,
    isIdle: () => idle,
    busyReason: () => busy,
    acquire: () => {
      leases++
      return () => {
        leases--
      }
    },
    flush: async () => undefined,
    preview: async (_scope, accept) => {
      eligible = [...missing].filter(accept)
      return {
        ok: true,
        token: 'sync',
        checkedImageRecords: 5000,
        checkedVideoRecords: 0,
        missingImageRecords: eligible.length,
        missingVideoRecords: 0,
        pendingMissingRecords: missing.size - eligible.length,
        originalFilesAffected: 0,
        warnings: [],
      }
    },
    apply: async () => {
      applies++
      for (const file of eligible) missing.delete(file)
      return {
        ok: true,
        imageRecordsRemoved: eligible.length,
        videoRecordsMarkedMissing: 0,
        originalFilesAffected: 0,
        freedBytes: 0,
      }
    },
    gcPreview: async () => gc,
    gcStart: () => {
      gcStarts++
      return { ok: true }
    },
    gcProgress: () => ({ state: 'completed', pendingReleaseBytes: 123, errors: [] }),
    gcCancel: () => undefined,
    expireBackups: async () => 0,
  }
  return {
    dir,
    scope,
    missing,
    gc,
    deps,
    create: () => new AutomaticMaintenanceService(dir, deps),
    advance: (value) => {
      now += value
    },
    setIdle: (value) => {
      idle = value
    },
    setBusy: (value) => {
      busy = value
    },
    calls: () => ({ applies, gcStarts, leases }),
  }
}

test('automatic maintenance is opt-in and validates source scopes', async (t) => {
  const f = fixture(t),
    service = f.create()
  assert.equal((await service.run(true)).phase, 'disabled')
  assert.deepEqual(f.calls(), { applies: 0, gcStarts: 0, leases: 0 })
  for (const value of [
    { enabled: 'true', scopes: [] },
    { enabled: true, scopes: [] },
    { enabled: true, scopes: ['relative'] },
  ])
    assert.throws(() => normalizeAutomaticMaintenanceConfig(value))
})

test('a missing file must survive a 24-hour observation period across restart', async (t) => {
  const f = fixture(t),
    first = f.create()
  first.configure({ enabled: true, scopes: [f.scope] })
  const observed = await first.run(true)
  assert.equal(observed.pendingMissing, 1)
  assert.equal(f.calls().applies, 0)
  f.advance(DAY + 1)
  const restarted = f.create()
  const updated = await restarted.run(true)
  assert.equal(updated.removedImages, 1)
  assert.equal(f.calls().applies, 1)
  assert.equal(f.calls().leases, 0)
})

test('restored and later deleted files start a fresh observation period', async (t) => {
  const f = fixture(t),
    service = f.create()
  service.configure({ enabled: true, scopes: [f.scope] })
  await service.run(true)
  f.missing.clear()
  f.advance(DAY + 1)
  await service.run(true)
  f.missing.add(path.join(f.scope, 'missing.jpg'))
  await service.run(true)
  assert.equal(f.calls().applies, 0)
  assert.equal(service.getStatus().pendingMissing, 1)
})

test('background runs respect idle time, daily cadence and existing work', async (t) => {
  const f = fixture(t),
    service = f.create()
  service.configure({ enabled: true, scopes: [f.scope] })
  f.setIdle(false)
  f.advance(DAY)
  await service.run()
  assert.equal(f.calls().leases, 0)
  assert.equal(service.getStatus().pendingMissing, 0)
  f.setIdle(true)
  f.setBusy('Search running')
  await service.run()
  assert.equal(service.getStatus().message, 'Search running')
  f.setBusy(null)
  await service.run()
  assert.equal(service.getStatus().pendingMissing, 1)
  f.advance(1000)
  await service.run()
  assert.equal(f.calls().applies, 0)
})

test('offline sources and unusually large deletion batches never execute synchronization', async (t) => {
  const f = fixture(t),
    service = f.create()
  service.configure({ enabled: true, scopes: [f.scope] })
  const original = f.deps.preview
  f.deps.preview = async () => ({ ok: false, error: 'Source offline' })
  assert.equal((await service.run(true)).phase, 'error')
  assert.equal(f.calls().applies, 0)
  f.deps.preview = original
  for (let i = 0; i < 1201; i++) f.missing.add(path.join(f.scope, `missing-${i}.jpg`))
  await service.run(true)
  f.advance(DAY + 1)
  const result = await service.run(true)
  assert.equal(f.calls().applies, 0)
  assert.match(result.message, /manually/)
})

test('GC only starts above both reclaim thresholds and with positive active coverage', async (t) => {
  const f = fixture(t),
    service = f.create()
  f.missing.clear()
  service.configure({ enabled: true, scopes: [f.scope] })
  f.gc.reclaimableBytes = 63 * 1024 ** 2
  await service.run(true)
  assert.equal(f.calls().gcStarts, 0)
  f.gc.reclaimableBytes = 150 * 1024 ** 2
  const result = await service.run(true)
  assert.equal(f.calls().gcStarts, 1)
  assert.equal(result.pendingReleaseBytes, 123)
  f.gc.activeAssetCount = 0
  await service.run(true)
  assert.equal(f.calls().gcStarts, 1)
})

test('disable during analysis prevents mutation and releases the maintenance lock', async (t) => {
  const f = fixture(t),
    service = f.create()
  service.configure({ enabled: true, scopes: [f.scope] })
  f.deps.preview = async () => {
    service.configure({ enabled: false, scopes: [f.scope] })
    return {
      ok: true,
      token: 'sync',
      missingImageRecords: 1,
      missingVideoRecords: 0,
      checkedImageRecords: 1,
      checkedVideoRecords: 0,
    }
  }
  assert.equal((await service.run(true)).phase, 'disabled')
  assert.equal(f.calls().applies, 0)
  assert.equal(f.calls().leases, 0)
})

test('corrupt persisted state does not silently enable automatic deletion', (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.dir, 'automatic-index-maintenance.json'), '{bad')
  const service = f.create()
  assert.equal(service.getStatus().config.enabled, false)
  assert.match(service.getStatus().message, /verified/)
})

test('shutdown waits for an already-started synchronization transaction before releasing ownership', async (t) => {
  const f = fixture(t),
    service = f.create()
  service.configure({ enabled: true, scopes: [f.scope] })
  await service.run(true)
  f.advance(DAY + 1)
  let finish
  f.deps.apply = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const task = service.run(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(typeof finish, 'function')
  let stopped = false
  const stopping = service.stop().then(() => {
    stopped = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stopped, false)
  assert.equal(f.calls().leases, 1)
  finish({
    ok: true,
    imageRecordsRemoved: 1,
    videoRecordsMarkedMissing: 0,
    originalFilesAffected: 0,
    freedBytes: 0,
  })
  await task
  await stopping
  assert.equal(stopped, true)
  assert.equal(f.calls().leases, 0)
})

test('shutdown cancels an active background GC and drains it before releasing ownership', async (t) => {
  const f = fixture(t),
    service = f.create()
  f.missing.clear()
  service.configure({ enabled: true, scopes: [f.scope] })
  f.gc.reclaimableBytes = 150 * 1024 ** 2
  let state = 'running',
    cancels = 0
  f.deps.gcProgress = () => ({ state, pendingReleaseBytes: 0, errors: [] })
  f.deps.gcCancel = () => {
    cancels++
    state = 'cancelled'
  }
  const task = service.run(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.calls().gcStarts, 1)
  await service.stop()
  await task
  assert.ok(cancels > 0)
  assert.equal(f.calls().leases, 0)
})

test('expired backup cleanup refuses active shards, mismatched metadata, invalid dates and young recovery files', async (t) => {
  const f = fixture(t),
    directory = path.join(f.dir, 'vector-db', 'embeddings')
  fs.mkdirSync(directory, { recursive: true })
  const now = Date.now(),
    old = now - 9 * DAY
  const active = path.join(directory, 'model__global.jsonl')
  fs.writeFileSync(active, 'active vector data')
  const make = (stamp, fields = {}) => {
    const backup = `model__global.jsonl.gc-backup-${stamp}`
    const metadata = path.join(directory, backup + '.json')
    fs.writeFileSync(path.join(directory, backup), 'recovery data')
    fs.writeFileSync(
      metadata,
      JSON.stringify({
        version: 1,
        source: 'model__global.jsonl',
        backup,
        createdAt: new Date(stamp).toISOString(),
        expiresAt: new Date(stamp + 7 * DAY).toISOString(),
        ...fields,
      }),
    )
    fs.utimesSync(metadata, new Date(stamp), new Date(stamp))
    return path.join(directory, backup)
  }
  const expired = make(old)
  const forged = make(old + 1, { backup: 'model__global.jsonl' })
  const invalid = make(old + 2, { expiresAt: 'invalid' })
  const young = make(now - DAY)
  assert.ok((await expireAutomaticMaintenanceBackups(f.dir, () => false, now)) > 0)
  assert.equal(fs.existsSync(expired), false)
  for (const file of [active, forged, invalid, young]) assert.equal(fs.existsSync(file), true)
})
