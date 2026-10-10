const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { loadTsModule } = require('./guard-utils.cjs')
const { buildSourceHealthItems } = loadTsModule('src/services/sourceHealth.ts')

const ROOT = path.resolve(__dirname, '..')

function source(overrides = {}) {
  return {
    id: 'source-1',
    type: 'local-ntfs',
    displayName: 'Library',
    rootLocator: 'D:\\media',
    readOnly: true,
    availability: 'online',
    scanCapability: 'usn',
    fileCount: 42,
    totalBytes: 4096,
    lastAttemptAt: 200,
    lastSuccessfulScanAt: 100,
    ...overrides,
  }
}

test('source health preserves last success and exposes a non-mutating probe action', () => {
  const [item] = buildSourceHealthItems([source()], {})

  assert.equal(item.availability, 'online')
  assert.equal(item.lastSuccessfulScanAt, 100)
  assert.equal(item.primaryAction, 'probe')
  assert.equal(item.canRepairRoot, false)
})

test('offline mounted source keeps catalog counts and exposes reconnect plus root repair', () => {
  const mounted = source({
    id: 'nas-1',
    type: 'mounted-network',
    availability: 'offline',
    scanCapability: 'directory',
  })
  const [item] = buildSourceHealthItems([mounted], {
    'nas-1': {
      sourceId: 'nas-1',
      running: false,
      session: {
        id: 'scan-1',
        sourceId: 'nas-1',
        state: 'error',
        backend: 'directory',
        startedAt: 200,
        finishedAt: 201,
        discoveredCount: 0,
        committedCount: 0,
        error: 'share unavailable',
      },
    },
  })

  assert.equal(item.availability, 'offline')
  assert.equal(item.fileCount, 42)
  assert.equal(item.totalBytes, 4096)
  assert.equal(item.primaryAction, 'reconnect')
  assert.equal(item.canRepairRoot, true)
  assert.equal(item.detail, 'share unavailable')
})

test('latest probe result overrides stale availability without changing source identity', () => {
  const [item] = buildSourceHealthItems(
    [source({ id: 'sftp-1', type: 'sftp', availability: 'unknown' })],
    {},
    {
      'sftp-1': {
        ok: true,
        availability: 'degraded',
        scanCapability: 'remote-list',
        nativeConnected: false,
        detail: 'credentials required',
      },
    },
  )

  assert.equal(item.id, 'sftp-1')
  assert.equal(item.availability, 'degraded')
  assert.equal(item.primaryAction, 'reconnect')
  assert.equal(item.canRepairRoot, false)
  assert.equal(item.detail, 'credentials required')
})

test('source health UI binds probe, reconnect, timestamps, and guarded root repair', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'src/components/DiscoverySourcesSection.tsx'), 'utf8')

  assert.match(ui, /data-testid="source-health-center"/)
  assert.match(ui, /discoveryCatalog\.probeSource\(sourceId\)/)
  assert.match(ui, /source\.primaryAction === 'reconnect'/)
  assert.match(ui, /formatTimestamp\(source\.lastSuccessfulScanAt\)/)
  assert.match(ui, /source\.canRepairRoot/)
  assert.match(ui, /repairSourceRoot\(sourceId, newRoot\)/)
})
