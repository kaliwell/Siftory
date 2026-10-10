const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { BoundedAsyncQueue, BoundedLruCache } = loadTsModule('electron/boundedAsyncQueue.ts')
const { ThumbnailCacheWriter } = loadTsModule('electron/thumbnailCacheWriter.ts')
const { runThumbCacheMaintenanceIfDue } = loadTsModule('electron/thumbnailDiskCache.ts')
const { RendererDataUrlLru, setBoundedDataUrlRecord } = loadTsModule(
  'src/utils/rendererDataUrlCache.ts',
)
const { THUMBNAIL_CACHE_VERSION } = loadTsModule('shared/thumbnailPolicy.ts')

test('bounded async queue applies backpressure without a batch completion barrier', async () => {
  const queue = new BoundedAsyncQueue(2)
  assert.equal(await queue.push('first'), true)
  assert.equal(await queue.push('second'), true)
  let thirdPushed = false
  const third = queue.push('third').then((value) => {
    thirdPushed = value
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(thirdPushed, false, 'producer must pause at the in-flight boundary')
  assert.equal(await queue.take(), 'first')
  await third
  assert.equal(thirdPushed, true)
  assert.equal(await queue.take(), 'second')
  assert.equal(await queue.take(), 'third')
  queue.close()
  assert.equal(await queue.take(), undefined)
})

test('bounded LRU enforces entry and byte budgets while preserving recent entries', () => {
  const cache = new BoundedLruCache(2, 10)
  assert.equal(cache.set('first', 'one', 4), true)
  assert.equal(cache.set('second', 'two', 4), true)
  assert.equal(cache.get('first'), 'one')
  assert.equal(cache.set('third', 'three', 4), true)
  assert.equal(cache.get('second'), undefined, 'least recently used entry should be evicted')
  assert.equal(cache.get('first'), 'one')
  assert.equal(cache.get('third'), 'three')

  assert.equal(cache.set('oversized', 'value', 11), false)
  assert.equal(cache.get('oversized'), undefined)
  assert.deepEqual(cache.stats(), {
    entries: 2,
    totalWeight: 8,
    maxEntries: 2,
    maxWeight: 10,
  })
  cache.clear()
  assert.equal(cache.size, 0)
  assert.equal(cache.totalWeight, 0)
})

test('renderer Data URL caches remain byte-bounded across UI churn and repeated searches', () => {
  const cache = new RendererDataUrlLru(3, 700)
  assert.equal(cache.set('first', `data:image/webp;base64,${'a'.repeat(80)}`), true)
  assert.equal(cache.set('second', `data:image/webp;base64,${'b'.repeat(80)}`), true)
  assert.equal(cache.get('first')?.includes('aaaa'), true)
  assert.equal(cache.set('third', `data:image/webp;base64,${'c'.repeat(80)}`), true)
  assert.equal(cache.get('second'), undefined)
  assert.ok(cache.stats().totalWeight <= cache.stats().maxWeight)

  for (let cycle = 0; cycle < 600; cycle += 1) {
    cache.set(`cycle-${cycle}`, `data:image/webp;base64,${'x'.repeat(64)}`)
    cache.clear()
  }
  assert.deepEqual(cache.stats(), {
    entries: 0,
    totalWeight: 0,
    maxEntries: 3,
    maxWeight: 700,
  })

  let previews = {}
  for (let search = 0; search < 100; search += 1) {
    for (let result = 0; result < 50; result += 1) {
      previews = setBoundedDataUrlRecord(
        previews,
        `${search}:${result}`,
        `data:image/jpeg;base64,${'z'.repeat(128)}`,
        20,
        8 * 1024,
      )
    }
    assert.ok(Object.keys(previews).length <= 20)
  }
})

test('renderer source does not create unreleased Object URLs', () => {
  const sourceRoot = path.resolve(__dirname, '..', 'src')
  const sourceFiles = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(entryPath)
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) sourceFiles.push(entryPath)
    }
  }
  visit(sourceRoot)
  const source = sourceFiles.map((filePath) => fs.readFileSync(filePath, 'utf8')).join('\n')
  const created = (source.match(/URL\.createObjectURL\s*\(/g) || []).length
  const revoked = (source.match(/URL\.revokeObjectURL\s*\(/g) || []).length
  assert.equal(created, revoked)
})

test('thumbnail rebuild preserves requested batch and separates GPU/CPU queues', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'electron', 'thumbnailIpc.ts'),
    'utf8',
  )
  assert.match(source, /thumbnailRebuildProgress\.batchSize = batchSize/)
  assert.doesNotMatch(source, /maxSafeBatchSize|effectiveBatchSize/)
  assert.match(source, /new BoundedAsyncQueue<string>/)
  assert.match(source, /new BoundedLruCache<string, string \| null>/)
  assert.match(source, /SHORTCUT_CACHE_MAX_BYTES = 4 \* 1024 \* 1024/)
  assert.match(source, /const cpuWorkers =/)
  assert.match(source, /const gpuWorkers =/)
  assert.match(source, /routeAutoTaskToCpu/)
  assert.match(source, /activeCpuTasks \+ cpuQueue\.size/)
  assert.match(source, /AUTO_THIRD_CPU_LANE_MIN_FREE_BYTES/)
  assert.match(source, /os\.freemem\(\)/)
  assert.match(source, /new ThumbnailCacheWriter/)
  assert.match(source, /await cacheWriter\.closeAndDrain\(\)/)
  assert.match(source, /function clampThumbnailGpuJobs/)
  assert.match(source, /parsed >= 1/)
})

test('thumbnail cache writer applies bounded asynchronous write-behind', async () => {
  const writes = []
  let releaseFirst
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve
  })
  const writer = new ThumbnailCacheWriter(1, 1, async (destination, dataUrl) => {
    if (destination === 'first') await firstBlocked
    writes.push([destination, dataUrl])
  })
  assert.equal(await writer.enqueue('first', 'one'), true)
  assert.equal(await writer.enqueue('second', 'two'), true)
  let thirdAccepted = false
  const third = writer.enqueue('third', 'three').then((accepted) => {
    thirdAccepted = accepted
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(thirdAccepted, false)
  releaseFirst()
  await third
  await writer.closeAndDrain()
  assert.deepEqual(writes, [
    ['first', 'one'],
    ['second', 'two'],
    ['third', 'three'],
  ])
  assert.equal(writer.completed, 3)
  assert.equal(writer.failed, 0)
})

test('GPU thumbnails use explicit shader orientation and invalidate legacy cache', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'electron', 'thumbnailGpuService.ts'),
    'utf8',
  )
  assert.match(source, /1\.0-\(a_position\.y\+1\.0\)\*0\.5/)
  assert.match(source, /UNPACK_FLIP_Y_WEBGL, false/)
  assert.match(source, /preserveDrawingBuffer: false/)
  assert.match(source, /resizeWidth: job\.targetWidth/)
  assert.match(source, /gl\.texImage2D\([\s\S]*?1,[\s\S]*?new Uint8Array\(\[0, 0, 0, 0\]\)/)
  assert.match(source, /withSourceBudget/)
  assert.equal(THUMBNAIL_CACHE_VERSION, 6)
})

test('GPU thumbnail renderer uses a sandboxed minimal preload contract', () => {
  const repoRoot = path.resolve(__dirname, '..')
  const service = fs.readFileSync(path.join(repoRoot, 'electron', 'thumbnailGpuService.ts'), 'utf8')
  const preload = fs.readFileSync(path.join(repoRoot, 'electron', 'thumbnailGpuPreload.ts'), 'utf8')
  const viteConfigs = ['vite.config.mjs', 'vite.config.ts'].map((fileName) =>
    fs.readFileSync(path.join(repoRoot, fileName), 'utf8'),
  )

  assert.match(service, /nodeIntegration: false/)
  assert.match(service, /contextIsolation: true/)
  assert.match(service, /sandbox: true/)
  assert.match(service, /partition: GPU_PARTITION/)
  assert.match(service, /setPermissionCheckHandler\(\(\) => false\)/)
  assert.match(service, /setPermissionRequestHandler/)
  assert.match(service, /will-attach-webview/)
  assert.match(service, /event\.sender\.id !== worker\.webContents\.id/)
  assert.match(service, /MAX_GPU_SOURCE_BYTES/)
  assert.match(service, /MAX_GPU_OUTPUT_BYTES/)
  assert.match(service, /GPU_INPUT_MIMES/)
  assert.doesNotMatch(service, /require\(['"]electron['"]\)/)
  assert.match(preload, /contextBridge\.exposeInMainWorld\('thumbnailGpuBridge'/)
  assert.match(preload, /MAX_GPU_SOURCE_BYTES/)
  assert.match(preload, /MAX_GPU_OUTPUT_BYTES/)
  assert.match(preload, /GPU_INPUT_MIMES/)
  assert.match(preload, /GPU_CANCEL_CHANNEL/)
  for (const vite of viteConfigs) {
    assert.match(vite, /entry: 'electron\/thumbnailGpuPreload\.ts'/)
  }
})

test('thumbnail cache v6 reads native binary JPEG and legacy v4 text entries', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'electron', 'thumbnailDiskCache.ts'),
    'utf8',
  )
  assert.match(source, /extension: '\.jpg', mime: 'image\/jpeg'/)
  assert.match(source, /cacheKeyForVersion\(4, filePath, mtimeMs, dimension\)/)
  assert.match(source, /Math\.floor\(Number\(mtimeMs\) \/ 1000\) \* 1000/)
})

test('Start Scan native thumbnail sidecar is adaptive, bounded, and fills deferred work', () => {
  const nativeSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'native', 'thumbnail_sidecar.h'),
    'utf8',
  )
  const serviceSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'electron', 'imageSearchService.ts'),
    'utf8',
  )
  assert.match(nativeSource, /kMinQueueCapacity = 64/)
  assert.match(nativeSource, /kMaxQueueCapacity = 256/)
  assert.match(nativeSource, /kMaxDeferredEntries = 65536/)
  assert.match(nativeSource, /kMaxDeferredPathBytes = 32ULL \* 1024 \* 1024/)
  assert.match(nativeSource, /select_worker_policy/)
  assert.match(nativeSource, /g_deferredJobs/)
  assert.match(nativeSource, /g_fillPhase/)
  assert.match(nativeSource, /g_dropped\.fetch_add\(1\)/)
  assert.match(nativeSource, /encode_one_to_cache/)
  assert.match(nativeSource, /is_excluded_source/)
  assert.match(serviceSource, /configureScanThumbnails/)
  assert.match(serviceSource, /THUMBNAIL_CACHE_VERSION/)
})

test('standalone rebuild exposes native C++ streaming and honest CUDA fallback', () => {
  const repoRoot = path.resolve(__dirname, '..')
  const nativeHeader = fs.readFileSync(
    path.join(repoRoot, 'native', 'thumbnail_rebuilder.h'),
    'utf8',
  )
  const nativeSource = fs.readFileSync(path.join(repoRoot, 'native', 'fast_scanner.cc'), 'utf8')
  const ipcSource = fs.readFileSync(path.join(repoRoot, 'electron', 'thumbnailIpc.ts'), 'utf8')
  const cacheSource = fs.readFileSync(
    path.join(repoRoot, 'electron', 'thumbnailDiskCache.ts'),
    'utf8',
  )
  assert.match(nativeHeader, /IWICBitmapSourceTransform/)
  assert.match(nativeHeader, /kQueueCapacity = 48/)
  assert.match(nativeHeader, /same_or_descendant/)
  assert.match(nativeHeader, /g_excludedCachePath/)
  assert.match(nativeHeader, /CUDA Toolkit nvJPEG runtime is not installed/)
  assert.match(nativeSource, /startNativeThumbnailRebuild/)
  assert.match(ipcSource, /backend === 'native' \|\| backend === 'cuda'/)
  assert.match(ipcSource, /effectiveBackend: native\?\.effectiveBackend \|\| 'native-cpp'/)
  assert.match(ipcSource, /imageSearch:clearThumbnailCache/)
  assert.match(ipcSource, /await fsp\.rename\(cacheDir, retiredDir\)/)
  assert.match(cacheSource, /\.thumbcache-retired-/)
  assert.match(cacheSource, /Retired cache cleanup retry failed/)
})

test('GPU path reserves bytes before reading and reuses one source buffer', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'electron', 'thumbnailIpc.ts'),
    'utf8',
  )
  assert.match(source, /gpuPool\.withSourceBudget\(fileBytes/)
  assert.match(source, /const sourceBytes = await fsp\.readFile\(filePath\)/)
  assert.match(source, /sharp\(sourceBytes,/)
  assert.match(source, /gpuPool\.renderReserved\(/)
})

test('cache eviction bounds filesystem stat concurrency', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'electron', 'thumbnailDiskCache.ts'),
    'utf8',
  )
  assert.match(source, /const statConcurrency = 16/)
  assert.match(source, /offset \+= statConcurrency/)
  assert.doesNotMatch(source, /Promise\.all\(\s*files\.map/)
})

test('startup defers and rate-limits thumbnail cache maintenance', () => {
  const repoRoot = path.resolve(__dirname, '..')
  const cacheSource = fs.readFileSync(
    path.join(repoRoot, 'electron', 'thumbnailDiskCache.ts'),
    'utf8',
  )
  const mainSource = fs.readFileSync(path.join(repoRoot, 'electron', 'main.ts'), 'utf8')
  assert.match(cacheSource, /THUMB_CACHE_STARTUP_MAINTENANCE_DELAY_MS = 120_000/)
  assert.match(cacheSource, /THUMB_CACHE_MAINTENANCE_INTERVAL_MS = 24 \* 60 \* 60 \* 1000/)
  assert.match(cacheSource, /runThumbCacheMaintenanceIfDue/)
  assert.match(cacheSource, /controller\.abort\(\)/)
  assert.match(mainSource, /scheduleThumbCacheMaintenance\(app\.getPath\('userData'\)\)/)
  assert.doesNotMatch(mainSource, /evictThumbCache\(app\.getPath\('userData'\)\)/)
})

test('thumbnail cache maintenance persists its interval and honors cancellation', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-thumb-maintenance-'))
  try {
    const cacheDir = path.join(userDataPath, 'thumbcache')
    fs.mkdirSync(cacheDir)
    fs.writeFileSync(path.join(cacheDir, 'entry.jpg'), Buffer.from([1, 2, 3]))

    assert.equal(
      await runThumbCacheMaintenanceIfDue(userDataPath, {
        minIntervalMs: 1_000,
        now: () => 10_000,
      }),
      true,
    )
    assert.equal(
      await runThumbCacheMaintenanceIfDue(userDataPath, {
        minIntervalMs: 1_000,
        now: () => 10_999,
      }),
      false,
    )
    assert.equal(
      await runThumbCacheMaintenanceIfDue(userDataPath, {
        minIntervalMs: 1_000,
        now: () => 11_000,
      }),
      true,
    )

    const controller = new AbortController()
    controller.abort()
    assert.equal(
      await runThumbCacheMaintenanceIfDue(
        userDataPath,
        { minIntervalMs: 0, now: () => 12_000 },
        controller.signal,
      ),
      false,
    )
  } finally {
    fs.rmSync(userDataPath, { recursive: true, force: true })
  }
})
