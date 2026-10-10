const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const sharp = require('sharp')
const { loadTsModule } = require('./guard-utils.cjs')

test('real Native D3/D4 scan queues and holds the local lane through finalization', async (t) => {
  try {
    require('../native/build/Release/fast_scanner.node')
  } catch {
    t.skip('native addon not built')
    return
  }
  const service = loadTsModule('electron/imageSearchService.ts')
  const { queueImageSearchScan } = loadTsModule('electron/imageSearchTaskScheduling.ts')
  const { UnifiedTaskScheduler } = loadTsModule('electron/unifiedTaskScheduler.ts')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-staged-scan-'))
  const userData = path.join(root, 'user-data')
  const library = path.join(root, 'library')
  let releaseBlocker
  try {
    fs.mkdirSync(library, { recursive: true })
    await sharp({
      create: { width: 48, height: 32, channels: 3, background: { r: 40, g: 90, b: 160 } },
    })
      .png()
      .toFile(path.join(library, 'sample.png'))
    service.initImageSearchService(() => {}, userData)
    assert.equal(service.getImageSearchStatus().nativeConnected, true)
    const scheduler = new UnifiedTaskScheduler({ localConcurrency: 1, gpuConcurrency: 1 })
    const blocker = scheduler.enqueue({
      stage: 'metadata',
      run: () =>
        new Promise((resolve) => {
          releaseBlocker = resolve
        }),
    })
    const queued = queueImageSearchScan({ paths: [library], buildThumbnails: true }, scheduler)
    assert.equal(queued.state, 'queued')
    assert.equal(scheduler.stats().lanes.local.queued, 1)
    releaseBlocker()
    await blocker.promise

    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const state = service.getImageSearchStatus().state
      const stats = scheduler.stats().lanes.local
      if (state === 'error') assert.fail(service.getImageSearchStatus().lastError)
      if (state === 'idle' && stats.running === 0 && stats.queued === 0) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(service.getImageSearchStatus().state, 'idle')
    assert.equal(service.getImageSearchStatus().indexedCount, 1)
    assert.equal(fs.existsSync(path.join(userData, 'image-search-index', 'manifest.json')), true)
    assert.equal(scheduler.stats().lanes.local.running, 0)
    assert.equal(scheduler.stats().lanes.local.completed, 2)
  } finally {
    if (releaseBlocker) releaseBlocker()
    await service.stopImageSearchScan().catch(() => undefined)
    // Native keeps the freshly mmap-loaded segment open until process exit on
    // Windows. Only remove inputs that are not held by that read-only mapping;
    // the OS temp root is reclaimed after this isolated test process exits.
    fs.rmSync(library, { recursive: true, force: true, maxRetries: 3 })
  }
})
