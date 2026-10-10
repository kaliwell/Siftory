const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  buildProductHealthReport,
  findUnsafeProductHealthFields,
  redactProductDiagnosticText,
  serializeProductHealthReport,
} = loadTsModule('electron/productHealthReport.ts')
const { ProductHealthService, normalizeProductHealthRepairRequest } = loadTsModule(
  'electron/productHealthService.ts',
)
const { DiscoveryCatalogDatabase } = loadTsModule('electron/discoveryCatalogDatabase.ts')

function catalog(overrides = {}) {
  return {
    ok: true,
    schemaVersion: 1,
    sourceCount: 1,
    fileCount: 10,
    indexStateCount: 20,
    missingFileCount: 0,
    staleIndexCount: 0,
    failedIndexCount: 0,
    orphanFileCount: 0,
    orphanIndexCount: 0,
    missingDiscoveryStateCount: 0,
    invalidIndexStateCount: 0,
    quickCheckOk: true,
    foreignKeyViolationCount: 0,
    ...overrides,
  }
}

function healthyInput(overrides = {}) {
  return {
    generatedAt: 1_700_000_000_000,
    appVersion: '1.0.0',
    platform: 'win32',
    architecture: 'x64',
    sources: [{ availability: 'online' }],
    catalog: catalog(),
    vector: { status: 'ready' },
    models: [{ state: 'downloaded' }, { state: 'verified' }],
    scheduler: {
      failed: 0,
      queued: 0,
      running: 0,
      backgroundPaused: false,
      pressureReasonCount: 0,
    },
    dataProtection: { applied: true },
    storage: { freeBytes: 100 * 1024 ** 3, minimumFreeBytes: 5 * 1024 ** 3 },
    ...overrides,
  }
}

test('healthy report is deterministic, bounded, path-free, and complete', () => {
  const first = buildProductHealthReport(healthyInput())
  const second = buildProductHealthReport(JSON.parse(JSON.stringify(healthyInput())))
  assert.deepEqual(second, first)
  assert.equal(first.schema, 'siftory-product-health/v1')
  assert.equal(first.overall, 'healthy')
  assert.deepEqual(
    first.checks.map((check) => check.id),
    [
      'source-connectivity',
      'catalog-integrity',
      'vector-integrity',
      'model-integrity',
      'task-runtime',
      'data-protection',
      'storage',
    ],
  )
  assert.deepEqual(findUnsafeProductHealthFields(first), [])
  const serialized = serializeProductHealthReport(first)
  assert.doesNotMatch(serialized, /Users|fixture\.mp4|password|sftp:\/\//i)
})

test('health checks expose layered repairs for offline, corrupt, pressured, and low-disk states', () => {
  const report = buildProductHealthReport(
    healthyInput({
      sources: [{ availability: 'offline' }, { availability: 'online' }],
      catalog: catalog({ staleIndexCount: 3, failedIndexCount: 2 }),
      vector: { status: 'vector-corrupt' },
      models: [{ state: 'error' }, { state: 'not-installed' }],
      scheduler: {
        failed: 2,
        queued: 4,
        running: 1,
        backgroundPaused: true,
        pressureReasonCount: 2,
      },
      storage: { freeBytes: 1, minimumFreeBytes: 10 },
    }),
  )
  assert.equal(report.overall, 'error')
  assert.equal(report.checks.find((check) => check.id === 'catalog-integrity').state, 'degraded')
  const actions = report.checks.flatMap((check) => check.actions)
  assert.ok(actions.some((action) => action.id === 'reconnect-sources' && action.tier === 'safe'))
  assert.ok(
    actions.some((action) => action.id === 'open-image-rebuild' && action.tier === 'rebuild'),
  )
  assert.ok(
    actions.some(
      (action) =>
        action.id === 'review-derived-reset' &&
        action.tier === 'destructive' &&
        action.requiresConfirmation,
    ),
  )
  assert.ok(
    actions.some((action) => action.id === 'cancel-background' && action.requiresConfirmation),
  )
})

test('free-form diagnostic redaction removes paths, URIs, identities, addresses, and secrets', () => {
  const raw =
    'C:\\Users\\Alice Smith\\Videos\\private.mp4 /home/alice/private.mov ' +
    '\\\\nas01\\private\\clip.mov sftp://alice:secret@10.0.0.8/private ' +
    'password=hunter2 token:abc123 alice@example.com 192.168.1.20'
  const redacted = redactProductDiagnosticText(raw)
  assert.doesNotMatch(
    redacted,
    /Alice|private\.mp4|private\.mov|hunter2|abc123|example\.com|192\.168/i,
  )
  assert.match(redacted, /\[path\]/)
  assert.equal(redactProductDiagnosticText('sftp://alice:secret@10.0.0.8/private'), '[uri]')
  assert.equal(redactProductDiagnosticText('password=hunter2'), 'password=[redacted]')
  assert.equal(redactProductDiagnosticText('alice@example.com'), '[email]')
  assert.equal(redactProductDiagnosticText('192.168.1.20'), '[ip]')

  const report = buildProductHealthReport(
    healthyInput({ appVersion: 'C:\\Users\\Alice\\secret.exe' }),
  )
  assert.equal(report.app.version, 'unknown')
  report.app.platform = 'C:\\Users\\Alice'
  assert.deepEqual(findUnsafeProductHealthFields(report), ['app.platform'])
  assert.throws(() => serializeProductHealthReport(report), /private fields/)
})

test('catalog consistency probe checks SQLite, foreign keys, and derived index aggregates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-health-catalog-'))
  const database = new DiscoveryCatalogDatabase(path.join(root, 'catalog.sqlite'))
  try {
    database.insertSource(
      {
        id: 'source-1',
        type: 'local-generic',
        displayName: 'Fixture',
        rootLocator: root,
        readOnly: true,
        availability: 'online',
        scanCapability: 'directory',
      },
      1_000,
    )
    database.upsertDiscoveredBatch(
      'source-1',
      null,
      [
        {
          absolutePath: path.join(root, 'fixture.jpg'),
          relativePath: 'fixture.jpg',
          name: 'fixture.jpg',
          extension: 'jpg',
          sizeBytes: 12,
          modifiedAt: 1_000,
        },
      ],
      1_000,
    )
    const item = database.queryCatalog({}).items[0]
    database.setFileEntryIndexState(item.fileEntryId, 'image-embedding-ready', 'stale', 1_001)
    const consistency = database.getConsistencyReport()
    assert.equal(consistency.ok, true)
    assert.equal(consistency.quickCheckOk, true)
    assert.equal(consistency.foreignKeyViolationCount, 0)
    assert.equal(consistency.orphanFileCount, 0)
    assert.equal(consistency.orphanIndexCount, 0)
    assert.equal(consistency.missingDiscoveryStateCount, 0)
    assert.equal(consistency.staleIndexCount, 1)
  } finally {
    database.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('repair service enforces availability and confirmation before routing or mutation', async () => {
  let input = healthyInput({
    sources: [{ availability: 'offline' }],
    vector: { status: 'vector-corrupt' },
    scheduler: {
      failed: 0,
      queued: 2,
      running: 0,
      backgroundPaused: true,
      pressureReasonCount: 1,
    },
    storage: { freeBytes: 1, minimumFreeBytes: 10 },
  })
  let reconnects = 0
  let cancellations = 0
  const service = new ProductHealthService({
    readInput: () => input,
    reconnectSources: () => {
      reconnects += 1
      input = { ...input, sources: [{ availability: 'online' }] }
      return 1
    },
    cancelBackground: () => {
      cancellations += 1
      input = {
        ...input,
        scheduler: { ...input.scheduler, queued: 0, backgroundPaused: false },
      }
      return 2
    },
  })

  assert.deepEqual(normalizeProductHealthRepairRequest({ actionId: 'unknown' }), null)
  assert.equal((await service.runRepair({ actionId: 'unknown' })).errorCode, 'invalid-action')
  const reconnect = await service.runRepair({ actionId: 'reconnect-sources' })
  assert.equal(reconnect.ok, true)
  assert.equal(reconnect.affected, 1)
  assert.equal(reconnects, 1)

  const unconfirmed = await service.runRepair({ actionId: 'cancel-background' })
  assert.equal(unconfirmed.errorCode, 'confirmation-required')
  assert.equal(cancellations, 0)
  const cancelled = await service.runRepair({ actionId: 'cancel-background', confirmed: true })
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.affected, 2)

  assert.equal(
    (await service.runRepair({ actionId: 'review-derived-reset', confirmed: true })).route,
    'settings-data-reset',
  )
  assert.equal(
    (await service.runRepair({ actionId: 'open-model-repair' })).errorCode,
    'action-unavailable',
  )
  assert.equal((await service.runRepair({ actionId: 'recheck' })).ok, true)
})

test('data protection repair requires confirmation and refreshes the probed state', async () => {
  let input = healthyInput({
    dataProtection: { applied: false, reason: 'failed' },
  })
  const report = buildProductHealthReport(input)
  const check = report.checks.find((candidate) => candidate.id === 'data-protection')
  assert.equal(check.state, 'error')
  assert.deepEqual(
    check.actions.map((action) => action.id),
    ['recheck', 'repair-data-protection'],
  )
  assert.equal(
    check.actions.find((action) => action.id === 'repair-data-protection').requiresConfirmation,
    true,
  )

  let repairs = 0
  const service = new ProductHealthService({
    readInput: () => input,
    repairDataProtection: () => {
      repairs += 1
      input = { ...input, dataProtection: { applied: true } }
    },
  })
  const unconfirmed = await service.runRepair({ actionId: 'repair-data-protection' })
  assert.equal(unconfirmed.errorCode, 'confirmation-required')
  assert.equal(repairs, 0)

  const repaired = await service.runRepair({ actionId: 'repair-data-protection', confirmed: true })
  assert.equal(repaired.ok, true)
  assert.equal(repairs, 1)
  assert.equal(
    repaired.report.checks.find((candidate) => candidate.id === 'data-protection').state,
    'healthy',
  )
})

test('data protection repair stays unavailable when healthy, disabled, or unsupported', async () => {
  for (const [dataProtection, expectedActions] of [
    [{ applied: true }, []],
    [{ applied: false, reason: 'disabled' }, ['recheck']],
    [{ applied: false, reason: 'unsupported' }, ['recheck']],
  ]) {
    const report = buildProductHealthReport(healthyInput({ dataProtection }))
    const check = report.checks.find((candidate) => candidate.id === 'data-protection')
    assert.deepEqual(
      check.actions.map((action) => action.id),
      expectedActions,
    )
    const service = new ProductHealthService({ readInput: () => healthyInput({ dataProtection }) })
    const result = await service.runRepair({
      actionId: 'repair-data-protection',
      confirmed: true,
    })
    assert.equal(result.errorCode, 'action-unavailable')
  }

  let called = 0
  const failing = new ProductHealthService({
    readInput: () => healthyInput({ dataProtection: { applied: false, reason: 'failed' } }),
    repairDataProtection: () => {
      called += 1
      throw new Error('acl write failed')
    },
  })
  const failed = await failing.runRepair({ actionId: 'repair-data-protection', confirmed: true })
  assert.equal(failed.errorCode, 'repair-failed')
  assert.equal(called, 1)
})

test('renderer, preload, and main process expose the health center without raw diagnostic fields', () => {
  const root = path.resolve(__dirname, '..')
  const ui = fs.readFileSync(
    path.join(root, 'src', 'components', 'ProductReadinessCenter.tsx'),
    'utf8',
  )
  const settings = fs.readFileSync(
    path.join(root, 'src', 'components', 'SettingsPanel.tsx'),
    'utf8',
  )
  const ipc = fs.readFileSync(path.join(root, 'electron', 'productHealthIpc.ts'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.ts'), 'utf8')
  assert.match(ui, /data-testid="product-health-center"/)
  assert.match(ui, /Save redacted report/)
  assert.match(ui, /action\.requiresConfirmation/)
  assert.match(settings, /workspace-review-derived-reset/)
  assert.match(ipc, /serializeProductHealthReport/)
  assert.match(ipc, /commitPreparedPath/)
  assert.match(preload, /PRODUCT_HEALTH_IPC\.REPORT_GET/)
  assert.doesNotMatch(ui, /rootLocator|installedPath|lastError/)
})
