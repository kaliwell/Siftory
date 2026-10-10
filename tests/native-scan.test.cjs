const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { Worker } = require('node:worker_threads')
const sharp = require('sharp')

// Windows CRT snapshots the process environment when the addon DLL loads.
process.env.REASONIX_NATIVE_STAGE_METRICS = '1'
const addonPath = path.resolve(
  process.env.REASONIX_NATIVE_ADDON_PATH ||
    path.join(__dirname, '..', 'native', 'build', 'Release', 'fast_scanner.node'),
)
const addon = require(addonPath)
const nativeSource = fs.readFileSync(
  path.join(__dirname, '..', 'native', 'fast_scanner.cc'),
  'utf8',
)

function createPng(filePath) {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  fs.writeFileSync(filePath, png)
}

function upsertTestIndexRecords(filePaths) {
  for (const [index, filePath] of filePaths.entries()) {
    const stat = fs.statSync(filePath)
    const diffHash64 = (index + 1).toString(16).padStart(16, '0')
    const dctHash64 = (index + 257).toString(16).padStart(16, '0')
    const result = addon.upsertIndexRecord(
      filePath,
      index + 1,
      index + 2,
      stat.size,
      Math.trunc(stat.mtimeMs),
      diffHash64,
      dctHash64,
    )
    assert.equal(result.ok, true, JSON.stringify(result))
  }
}

async function createPatternJpeg(filePath, width = 800, height = 600) {
  const pixels = Buffer.allocUnsafe(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      pixels[offset] = (x * 3 + y) % 256
      pixels[offset + 1] = (x + y * 5) % 256
      pixels[offset + 2] = (x * 7 + y * 11) % 256
    }
  }
  await sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 88 })
    .toFile(filePath)
}

test('scan and index state are owned by explicit runtime contexts', () => {
  const scanWorkerSource = nativeSource.slice(
    nativeSource.indexOf('static void scan_worker('),
    nativeSource.indexOf('// ===== Hamming ====='),
  )
  const usnScanSource = nativeSource.slice(
    nativeSource.indexOf('static bool try_usn_scan('),
    nativeSource.indexOf('// ===== Scan worker'),
  )
  const usnEnumSource = nativeSource.slice(
    nativeSource.indexOf('static void usn_enum_files('),
    nativeSource.indexOf('// USN incremental read'),
  )
  const searchSource = nativeSource.slice(
    nativeSource.indexOf('static void search_all_gd('),
    nativeSource.indexOf('// ===== N-API wrappers ====='),
  )
  const editSource = nativeSource.slice(
    nativeSource.indexOf('static bool find_effective_record_locked('),
    nativeSource.indexOf('static std::shared_ptr<SegmentView> mmap_segment('),
  )
  const syncPersistenceSource = nativeSource.slice(
    nativeSource.indexOf('static napi_value IsIndexDirty('),
    nativeSource.indexOf('// Async N-API helpers'),
  )
  const asyncLoadSaveSource = nativeSource.slice(
    nativeSource.indexOf('struct LoadManifestAsyncData'),
    nativeSource.indexOf('struct HashImageAsyncData'),
  )
  const asyncCompactSource = nativeSource.slice(
    nativeSource.indexOf('struct CompactAsyncData'),
    nativeSource.indexOf('static napi_value GetCompactStatus('),
  )
  assert.match(nativeSource, /struct ScanRuntime\s*\{/)
  assert.match(nativeSource, /struct ScanMetrics\s*\{/)
  assert.match(nativeSource, /ScanMetrics metrics;/)
  assert.match(nativeSource, /struct IndexRuntime\s*\{/)
  assert.match(
    nativeSource,
    /static std::shared_ptr<IndexRuntime> acquire_shared_index_runtime\(\)/,
  )
  assert.match(nativeSource, /static std::weak_ptr<IndexRuntime> service;/)
  assert.match(nativeSource, /struct IndexWriteLease\s*\{/)
  assert.match(nativeSource, /tryAcquireWriter\(const std::string& operation/)
  assert.match(
    nativeSource,
    /scan_worker\(ScanRuntime& runtime,IndexRuntime& index[\s\S]*?std::shared_ptr<IndexWriteLease> writeLease/,
  )
  assert.match(nativeSource, /struct AddonContext\s*\{/)
  assert.match(nativeSource, /std::shared_ptr<ScanRuntime> scan;/)
  assert.match(nativeSource, /std::shared_ptr<IndexRuntime> index;/)
  assert.match(nativeSource, /class AsyncWorkRegistry\s*\{/)
  assert.match(nativeSource, /std::shared_ptr<AsyncWorkRegistry> asyncWorks;/)
  assert.match(
    nativeSource,
    /napi_add_async_cleanup_hook\(env,cleanup_addon_async_work,context,&context->asyncCleanupHook\)/,
  )
  assert.match(nativeSource, /napi_remove_async_cleanup_hook\(completedHook\)/)
  assert.match(nativeSource, /beginTeardown[\s\S]*?napi_cancel_async_work/)
  assert.equal(nativeSource.match(/create_registered_async_work\(env,d->registry,/g)?.length, 10)
  assert.equal(
    nativeSource.match(/finish_registered_async_work\(env,d->registry,d->work\)/g)?.length,
    9,
  )
  assert.equal(
    nativeSource.match(/std::shared_ptr<AsyncCancellationToken> cancellation=std::make_shared/g)
      ?.length,
    5,
  )
  assert.equal(nativeSource.match(/d->work,d->cancellation\)/g)?.length, 7)
  assert.match(nativeSource, /write_segment_file[\s\S]*?AsyncCancellationToken[\s\S]*?TmpGuard/)
  assert.match(nativeSource, /async_cancellation_checkpoint/)
  assert.match(
    nativeSource,
    /struct StopScanAsyncData\s*\{[\s\S]*?std::shared_ptr<ScanRuntime> runtime;/,
  )
  assert.doesNotMatch(nativeSource, /struct StopScanAsyncData\s*\{[\s\S]*?ScanRuntime\* runtime;/)
  assert.match(nativeSource, /StopScanAsyncExecute[\s\S]*?stop_scan_sync\(\*d->runtime\)/)
  assert.match(nativeSource, /napi_set_instance_data\(env,context,finalize_addon_context/)
  assert.match(nativeSource, /napi_get_instance_data\(env,&data\)/)
  assert.match(nativeSource, /BoundedScanPipeline\(ScanRuntime& runtime/)
  assert.match(nativeSource, /scan_worker\(ScanRuntime& runtime,IndexRuntime& index/)
  assert.match(nativeSource, /try_usn_scan\(IndexRuntime& index/)
  assert.match(usnEnumSource, /std::unordered_map<uint64_t,UsnDirectoryNode> directories/)
  assert.match(usnEnumSource, /directories\[frn\]=UsnDirectoryNode\{pfrn,std::move\(fn\)\}/)
  assert.match(usnEnumSource, /if\(current==rootFrn\)\{withinScope=true;break;\}/)
  assert.match(usnEnumSource, /current=parent->second\.parentFrn/)
  assert.match(usnEnumSource, /should_skip_dir_name\(wide_to_utf8\(parent->second\.name\)\)/)
  assert.match(usnEnumSource, /outFiles\.push_back\(wide_to_utf8\(absolutePath\)\)/)
  assert.match(usnScanSource, /uint64_t rootFrn=usn_get_path_frn\(rootPath\)/)
  assert.match(usnScanSource, /"root-frn-unavailable"/)
  assert.doesNotMatch(usnScanSource, /"scoped-directory"/)
  assert.doesNotMatch(usnScanSource, /usn_read_changes\(index,hVol/)
  assert.match(nativeSource, /lower=="windows"/)
  assert.match(nativeSource, /lower=="program files"/)
  assert.match(nativeSource, /lower=="program files \(x86\)"/)
  assert.match(nativeSource, /lower=="programdata"/)
  assert.doesNotMatch(usnScanSource, /skipDirs/)
  assert.match(usnScanSource, /volume-access-denied/)
  assert.match(usnScanSource, /journal-query-failed/)
  assert.match(nativeSource, /std::ref\(runtime\),std::ref\(index\),p,sm/)
  assert.doesNotMatch(scanWorkerSource, /g_indexRuntime/)
  assert.doesNotMatch(usnScanSource, /g_indexRuntime/)
  assert.match(nativeSource, /search_by_hash\(IndexRuntime& index/)
  assert.match(nativeSource, /find_effective_record_locked\(IndexRuntime& index/)
  assert.match(
    nativeSource,
    /struct SearchByImageAsyncData\s*\{[\s\S]*?std::shared_ptr<IndexRuntime> index;/,
  )
  assert.doesNotMatch(searchSource, /g_indexRuntime/)
  assert.doesNotMatch(editSource, /g_indexRuntime/)
  assert.match(nativeSource, /next_segment_id\(IndexRuntime& index\)/)
  assert.match(nativeSource, /mmap_segment\(IndexRuntime& index/)
  assert.match(nativeSource, /save_global_directory\(IndexRuntime& index/)
  assert.match(nativeSource, /save_overlay\(IndexRuntime& index/)
  assert.doesNotMatch(syncPersistenceSource, /g_indexRuntime/)
  assert.match(
    nativeSource,
    /struct LoadManifestAsyncData\s*\{[\s\S]*?std::shared_ptr<IndexRuntime> index;/,
  )
  assert.match(
    nativeSource,
    /struct SaveManifestAsyncData\s*\{[\s\S]*?std::shared_ptr<IndexRuntime> index;/,
  )
  assert.match(
    nativeSource,
    /struct CompactAsyncData\s*\{[\s\S]*?std::shared_ptr<IndexRuntime> index;/,
  )
  assert.match(nativeSource, /unmap_index_internal\(IndexRuntime& index\)/)
  assert.doesNotMatch(asyncLoadSaveSource, /g_indexRuntime/)
  assert.doesNotMatch(asyncCompactSource, /g_indexRuntime/)
  assert.doesNotMatch(nativeSource, /g_indexRuntime/)
  assert.doesNotMatch(nativeSource, /static ScanRuntime g_scanRuntime/)
  assert.doesNotMatch(nativeSource, /static std::thread g_scanThread/)
  assert.doesNotMatch(nativeSource, /static std::atomic<bool> g_scanStop/)
  assert.doesNotMatch(nativeSource, /static std::mutex g_scanLifecycleMutex/)
  assert.doesNotMatch(nativeSource, /static std::atomic<int64_t> g_skippedCount/)
  assert.doesNotMatch(nativeSource, /static std::atomic<int64_t> g_enumUs/)
  assert.doesNotMatch(nativeSource, /static std::vector<ImageRecord> g_index/)
  assert.doesNotMatch(nativeSource, /static std::vector<UsnVolState> g_usnStates/)
  assert.doesNotMatch(nativeSource, /static std::atomic<int64_t> g_indexedCount/)
})

test('shared index admits only one writer across addon environments', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-writer-admission-'))
  try {
    for (let index = 0; index < 128; index++) createPng(path.join(root, `image-${index}.png`))
    addon.clearIndex()
    assert.equal(addon.scanDirectory(root, 'full').ok, true)
    assert.equal(addon.pauseScan().ok, true)
    await waitForScanState('paused')

    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads')
      const workerAddon = require(workerData.addonPath)
      parentPort.postMessage({ clear: workerAddon.clearIndex(), status: workerAddon.getNativeStatus() })
    `
    const message = await new Promise((resolve, reject) => {
      const worker = new Worker(workerSource, { eval: true, workerData: { addonPath } })
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`writer-admission worker exited with code ${code}`))
      })
    })
    assert.equal(message.clear.ok, false)
    assert.match(message.clear.error, /Index write busy: scan/)
    assert.equal(message.status.indexWriterActive, true)
    assert.equal(message.status.indexWriterOperation, 'scan')
  } finally {
    addon.resumeScan()
    await addon.stopScanAsync()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('stopScanAsync retains its scan runtime while a worker env exits early', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-scan-runtime-owner-'))
  try {
    for (let index = 0; index < 256; index++) createPng(path.join(root, `image-${index}.png`))
    addon.clearIndex()
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads')
      const workerAddon = require(workerData.addonPath)
      const started = workerAddon.scanDirectory(workerData.root, 'full')
      if (!started.ok) throw new Error(started.error || 'worker scan failed to start')
      void workerAddon.stopScanAsync()
      parentPort.postMessage(workerAddon.getNativeStatus())
    `
    const worker = new Worker(workerSource, { eval: true, workerData: { addonPath, root } })
    const status = await new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
    })
    assert.equal(status.scanRuntimeMode, 'env-owned-shared-lifetime')
    assert.equal(status.stopScanAsyncMode, 'shared-runtime-owned')
    assert.equal(status.scanStopInProgress, true)
    assert.equal(status.scanStopWorkCount, 1)
    await worker.terminate()

    const deadline = Date.now() + 5000
    while (addon.getNativeStatus().indexWriterActive && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(addon.getNativeStatus().indexWriterActive, false)
    assert.equal(addon.getNativeStatus().connected, true)
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('async work registry cancels queued worker tasks during env teardown', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-async-registry-'))
  try {
    const imagePath = path.join(root, 'queued.png')
    createPng(imagePath)
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads')
      const workerAddon = require(workerData.addonPath)
      for (let index = 0; index < 64; index++) void workerAddon.hashImageAsync(workerData.imagePath)
      parentPort.postMessage(workerAddon.getNativeStatus())
    `
    const worker = new Worker(workerSource, { eval: true, workerData: { addonPath, imagePath } })
    const status = await new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
    })
    assert.equal(status.asyncWorkMode, 'env-owned-explicit-cancel-teardown-drain')
    assert.equal(status.asyncWorkActiveCount, 64)
    assert.equal(status.asyncWorkClosing, false)
    await worker.terminate()
    assert.equal(addon.getNativeStatus().connected, true)
    assert.equal(addon.getNativeStatus().asyncWorkActiveCount, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('snapshotIndexRecords exports the effective Native view in one pass without source stats', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-index-snapshot-'))
  const kept = path.join(root, 'kept.png')
  const removed = path.join(root, 'removed.png')
  try {
    addon.clearIndex()
    assert.equal(
      addon.upsertIndexRecord(kept, 10, 20, 100, 1, '0123456789abcdef', 'fedcba9876543210').ok,
      true,
    )
    assert.equal(
      addon.upsertIndexRecord(removed, 30, 40, 200, 2, '1111111111111111', '2222222222222222').ok,
      true,
    )
    assert.equal(
      addon.upsertIndexRecord(kept, 50, 60, 300, 3, '3333333333333333', '4444444444444444').ok,
      true,
    )
    assert.equal(addon.deleteIndexPath(removed).ok, true)

    const snapshot = addon.snapshotIndexRecords()
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.recordCount, 1)
    assert.equal(snapshot.records.length, 1)
    assert.equal(snapshot.records[0].path, kept)
    assert.equal(snapshot.records[0].width, 50)
    assert.equal(snapshot.records[0].height, 60)
    assert.equal(snapshot.records[0].fileSize, 300)
    assert.equal(Object.hasOwn(snapshot.records[0], 'exists'), false)
    assert.equal(Object.hasOwn(snapshot.records[0], 'diffHash64'), false)
    assert.equal(Object.hasOwn(snapshot.records[0], 'dctHash64'), false)
    assert.equal(snapshot.scanned >= snapshot.recordCount, true)

    const originalParityFields = process.env.REASONIX_NATIVE_PARITY_FIELDS
    try {
      process.env.REASONIX_NATIVE_PARITY_FIELDS = '1'
      const detailedSnapshot = addon.snapshotIndexRecords()
      assert.equal(detailedSnapshot.records[0].channels, 0)
      assert.equal(detailedSnapshot.records[0].diffHash64, '3333333333333333')
      assert.equal(detailedSnapshot.records[0].dctHash64, '4444444444444444')
    } finally {
      if (originalParityFields === undefined) delete process.env.REASONIX_NATIVE_PARITY_FIELDS
      else process.env.REASONIX_NATIVE_PARITY_FIELDS = originalParityFields
    }

    const interactive = addon.queryIndexRecords('', 0, 200)
    assert.deepEqual(
      snapshot.records.map((record) => record.path),
      interactive.records.map((record) => record.path),
    )
  } finally {
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('deleteIndexPaths removes only exact requested paths from the in-memory index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-delete-paths-memory-'))
  const nested = path.join(root, 'nested')
  fs.mkdirSync(nested)
  const removeFirst = path.join(root, 'target.png')
  const removeSecond = path.join(root, 'target-two.png')
  const keepPrefix = path.join(root, 'target.png.backup')
  const keepNested = path.join(nested, 'target.png')
  const missing = path.join(root, 'not-indexed.png')
  const indexedPaths = [removeFirst, removeSecond, keepPrefix, keepNested]
  for (const filePath of indexedPaths) createPng(filePath)

  try {
    addon.clearIndex()
    assert.equal(typeof addon.deleteIndexPaths, 'function')
    upsertTestIndexRecords(indexedPaths)

    const deleted = addon.deleteIndexPaths([removeFirst, missing, removeSecond, removeFirst])
    assert.equal(deleted.ok, true)
    assert.equal(deleted.removedCount, 2)
    assert.equal(deleted.missingCount, 1, 'duplicate inputs must be counted only once')
    assert.equal(deleted.remainingCount, 2)
    assert.deepEqual(deleted.removedPaths, [removeFirst, removeSecond])
    assert.equal(addon.hasIndexPath(removeFirst), false)
    assert.equal(addon.hasIndexPath(removeSecond), false)
    assert.equal(addon.hasIndexPath(keepPrefix), true, 'a path-prefix neighbor must survive')
    assert.equal(
      addon.hasIndexPath(keepNested),
      true,
      'a same-name path in another folder must survive',
    )

    const snapshot = addon.snapshotIndexRecords()
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.recordCount, 2)
    assert.deepEqual(
      new Set(snapshot.records.map((record) => record.path)),
      new Set([keepPrefix, keepNested]),
    )

    const repeated = addon.deleteIndexPaths([removeFirst, removeSecond])
    assert.equal(repeated.ok, true)
    assert.equal(repeated.removedCount, 0)
    assert.equal(repeated.missingCount, 2)
    assert.equal(repeated.remainingCount, 2)
    assert.deepEqual(repeated.removedPaths, [])
    for (const filePath of indexedPaths) {
      assert.equal(fs.existsSync(filePath), true, 'index deletion must not delete source files')
    }
  } finally {
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('deleteIndexPathsAsync holds the shared writer lease until completion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-delete-paths-lease-'))
  const indexRoot = path.join(root, 'index')
  const removePath = path.join(root, 'remove.png')
  const keepPath = path.join(root, 'keep.png')
  const rejectedUpsert = path.join(root, 'rejected.png')
  for (const filePath of [removePath, keepPath, rejectedUpsert]) createPng(filePath)
  fs.mkdirSync(indexRoot)
  const delayVariable = 'FLOATING_CLOCK_NATIVE_BATCH_DELETE_DELAY_MS_TEST'
  const originalDelay = process.env[delayVariable]
  try {
    addon.clearIndex()
    upsertTestIndexRecords([removePath, keepPath])
    process.env[delayVariable] = '200'
    const pending = addon.deleteIndexPathsAsync([removePath])
    assert.equal(typeof pending?.then, 'function')
    assert.equal(addon.getNativeStatus().indexWriterActive, true)
    assert.equal(addon.getNativeStatus().indexWriterOperation, 'edit-delete-batch-async')

    const upsert = addon.upsertIndexRecord(
      rejectedUpsert,
      1,
      1,
      fs.statSync(rejectedUpsert).size,
      Math.trunc(fs.statSync(rejectedUpsert).mtimeMs),
      '0123456789abcdef',
      'fedcba9876543210',
    )
    assert.equal(upsert.ok, false)
    assert.match(upsert.error, /Index write busy: edit-delete-batch-async/)
    const cleared = addon.clearIndex()
    assert.equal(cleared.ok, false)
    assert.match(cleared.error, /Index write busy: edit-delete-batch-async/)
    const scan = addon.scanDirectory(root, 'full')
    assert.equal(scan.ok, false)
    assert.match(scan.error, /Index write busy: edit-delete-batch-async/)
    const saveAttempt = addon.saveIndexToManifestAsync(indexRoot)
    await assert.rejects(saveAttempt, /Index write busy: edit-delete-batch-async/)

    let timerFired = false
    await new Promise((resolve) =>
      setTimeout(() => {
        timerFired = true
        resolve()
      }, 20),
    )
    assert.equal(timerFired, true, 'the async delete must not occupy the JavaScript thread')
    const deleted = await pending
    assert.equal(deleted.ok, true)
    assert.deepEqual(deleted.removedPaths, [removePath])
    assert.equal(addon.hasIndexPath(removePath), false)
    assert.equal(addon.hasIndexPath(keepPath), true)
    assert.equal(addon.hasIndexPath(rejectedUpsert), false)
    assert.equal(addon.getNativeStatus().indexWriterActive, false)
  } finally {
    if (originalDelay === undefined) delete process.env[delayVariable]
    else process.env[delayVariable] = originalDelay
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('deleteIndexPathsAsync rejects pre-commit faults and invalid batches without modification', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-delete-paths-fault-'))
  const indexRoot = path.join(root, 'index')
  const removePath = path.join(root, 'remove.png')
  const keepPath = path.join(root, 'keep.png')
  for (const filePath of [removePath, keepPath]) createPng(filePath)
  fs.mkdirSync(indexRoot)
  const faultVariable = 'FLOATING_CLOCK_NATIVE_FAIL_BATCH_DELETE_BEFORE_COMMIT_TEST'
  const originalFault = process.env[faultVariable]
  try {
    addon.clearIndex()
    upsertTestIndexRecords([removePath, keepPath])
    assert.equal((await addon.saveIndexToManifestAsync(indexRoot)).ok, true)
    addon.clearIndex()
    assert.equal((await addon.loadManifestAsync(indexRoot)).ok, true)
    assert.equal(addon.isIndexDirty().dirty, false)
    const before = addon.snapshotIndexRecords().records.map((record) => record.path)

    process.env[faultVariable] = '1'
    await assert.rejects(
      addon.deleteIndexPathsAsync([removePath]),
      /Injected batch delete failure before commit/,
    )
    delete process.env[faultVariable]
    assert.equal(addon.isIndexDirty().dirty, false)
    assert.deepEqual(
      addon.snapshotIndexRecords().records.map((record) => record.path),
      before,
    )
    assert.equal(addon.hasIndexPath(removePath), true)
    assert.equal(addon.hasIndexPath(keepPath), true)

    await assert.rejects(addon.deleteIndexPathsAsync([removePath, 42]), /only string paths/)
    await assert.rejects(
      addon.deleteIndexPathsAsync(new Array(1_000_001)),
      /1000000 path safety limit/,
    )
    assert.deepEqual(
      addon.snapshotIndexRecords().records.map((record) => record.path),
      before,
    )
    assert.equal(addon.isIndexDirty().dirty, false)
  } finally {
    if (originalFault === undefined) delete process.env[faultVariable]
    else process.env[faultVariable] = originalFault
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('deleteIndexPathsAsync persists exact mmap deletions across save and reload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-delete-paths-mmap-'))
  const source = path.join(root, 'source')
  const nested = path.join(source, 'nested')
  const indexRoot = path.join(root, 'index')
  fs.mkdirSync(nested, { recursive: true })
  fs.mkdirSync(indexRoot)
  const removeFirst = path.join(source, 'target.png')
  const removeSecond = path.join(source, 'target-two.png')
  const keepPrefix = path.join(source, 'target.png.backup')
  const keepNested = path.join(nested, 'target.png')
  const missing = path.join(source, 'not-indexed.png')
  const indexedPaths = [removeFirst, removeSecond, keepPrefix, keepNested]
  for (const filePath of indexedPaths) createPng(filePath)

  try {
    addon.clearIndex()
    assert.equal(typeof addon.deleteIndexPathsAsync, 'function')
    upsertTestIndexRecords(indexedPaths)
    const initialSave = await addon.saveIndexToManifestAsync(indexRoot)
    assert.equal(initialSave.ok, true)
    assert.equal(initialSave.recordCount, 4)

    addon.clearIndex()
    const initialLoad = await addon.loadManifestAsync(indexRoot)
    assert.equal(initialLoad.ok, true)
    assert.equal(initialLoad.recordCount, 4)
    assert.equal(addon.getIndexMode().mode, 'segment_mmap')

    const deleted = await addon.deleteIndexPathsAsync([
      removeFirst,
      missing,
      removeSecond,
      removeFirst,
    ])
    assert.equal(deleted.ok, true)
    assert.equal(deleted.removedCount, 2)
    assert.equal(deleted.missingCount, 1, 'duplicate inputs must be counted only once')
    assert.equal(deleted.remainingCount, 2)
    assert.deepEqual(deleted.removedPaths, [removeFirst, removeSecond])
    assert.equal(addon.hasIndexPath(removeFirst), false)
    assert.equal(addon.hasIndexPath(removeSecond), false)
    assert.equal(addon.hasIndexPath(keepPrefix), true, 'a path-prefix neighbor must survive')
    assert.equal(
      addon.hasIndexPath(keepNested),
      true,
      'a same-name path in another folder must survive',
    )

    const persisted = await addon.saveIndexToManifestAsync(indexRoot)
    assert.equal(persisted.ok, true)
    assert.equal(persisted.recordCount, 2)

    addon.clearIndex()
    const reloaded = await addon.loadManifestAsync(indexRoot)
    assert.equal(reloaded.ok, true)
    assert.equal(addon.getIndexMode().mode, 'segment_mmap')
    assert.equal(addon.hasIndexPath(removeFirst), false)
    assert.equal(addon.hasIndexPath(removeSecond), false)
    assert.equal(addon.hasIndexPath(keepPrefix), true)
    assert.equal(addon.hasIndexPath(keepNested), true)
    const snapshot = addon.snapshotIndexRecords()
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.recordCount, 2)
    assert.deepEqual(
      new Set(snapshot.records.map((record) => record.path)),
      new Set([keepPrefix, keepNested]),
    )
    for (const filePath of indexedPaths) {
      assert.equal(fs.existsSync(filePath), true, 'index deletion must not delete source files')
    }
  } finally {
    addon.clearIndex()
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // Windows may retain a retired mapping until the addon releases it.
    }
  }
})

test('mixed unsaved overlay and exact deletes use one checked atomic overlay commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-overlay-atomic-'))
  const source = path.join(root, 'source')
  const indexRoot = path.join(root, 'index')
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(indexRoot)
  const removePath = path.join(source, 'remove.png')
  const keepPath = path.join(source, 'keep.png')
  const unsavedPath = path.join(source, 'unsaved.png')
  for (const filePath of [removePath, keepPath, unsavedPath]) createPng(filePath)
  const faultVariable = 'FLOATING_CLOCK_NATIVE_FAIL_OVERLAY_REPLACE_TEST'
  const originalFault = process.env[faultVariable]

  try {
    addon.clearIndex()
    upsertTestIndexRecords([removePath, keepPath])
    assert.equal((await addon.saveIndexToManifestAsync(indexRoot)).ok, true)
    addon.clearIndex()
    assert.equal((await addon.loadManifestAsync(indexRoot)).ok, true)

    upsertTestIndexRecords([unsavedPath])
    const deleted = addon.deleteIndexPaths([removePath])
    assert.equal(deleted.ok, true)
    assert.equal(deleted.removedCount, 1)
    const manifestBeforeFailure = fs.readFileSync(path.join(indexRoot, 'manifest.json'), 'utf8')
    const segmentsBeforeFailure = fs.readdirSync(path.join(indexRoot, 'segments')).sort()

    process.env[faultVariable] = '1'
    await assert.rejects(addon.saveIndexToManifestAsync(indexRoot), /Atomic overlay replace failed/)
    delete process.env[faultVariable]
    assert.equal(addon.isIndexDirty().dirty, true, 'a failed commit must remain retryable')
    assert.equal(
      fs.readFileSync(path.join(indexRoot, 'manifest.json'), 'utf8'),
      manifestBeforeFailure,
      'overlay failure must not publish the new manifest',
    )
    assert.deepEqual(
      fs.readdirSync(path.join(indexRoot, 'segments')).sort(),
      segmentsBeforeFailure,
      'a failed mixed commit must roll back its newly created segment',
    )
    assert.equal(fs.existsSync(path.join(indexRoot, 'overlay.tmp')), false)

    addon.clearIndex()
    assert.equal((await addon.loadManifestAsync(indexRoot)).ok, true)
    assert.equal(addon.hasIndexPath(removePath), true, 'failed deletion must not become durable')
    assert.equal(addon.hasIndexPath(keepPath), true)
    assert.equal(addon.hasIndexPath(unsavedPath), false, 'failed append must not become durable')

    upsertTestIndexRecords([unsavedPath])
    assert.equal(addon.deleteIndexPaths([removePath]).removedCount, 1)
    const saved = await addon.saveIndexToManifestAsync(indexRoot)
    assert.equal(saved.ok, true)
    assert.equal(addon.isIndexDirty().dirty, false)
    const overlay = JSON.parse(fs.readFileSync(path.join(indexRoot, 'overlay.json'), 'utf8'))
    assert.ok(overlay.deleted.includes(path.resolve(removePath).toLowerCase()))

    addon.clearIndex()
    const reloaded = await addon.loadManifestAsync(indexRoot)
    assert.equal(reloaded.ok, true)
    assert.equal(addon.hasIndexPath(removePath), false)
    assert.equal(addon.hasIndexPath(keepPath), true)
    assert.equal(addon.hasIndexPath(unsavedPath), true)
  } finally {
    if (originalFault === undefined) delete process.env[faultVariable]
    else process.env[faultVariable] = originalFault
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('fresh worker accepts schema-v2 empty manifests and rejects malformed manifests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-empty-manifest-'))
  const emptyRoot = path.join(root, 'empty')
  const malformedRoot = path.join(root, 'malformed')
  fs.mkdirSync(emptyRoot)
  fs.mkdirSync(malformedRoot)
  fs.writeFileSync(
    path.join(emptyRoot, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      segments: [],
      overlay: { replacedCount: 0, deletedCount: 0 },
      metadata: { file: 'must-not-be-treated-as-a-segment.idx' },
    }),
  )
  fs.writeFileSync(
    path.join(malformedRoot, 'manifest.json'),
    '{"schemaVersion":2,"segments":[],"overlay":',
  )

  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads')
    const path = require('node:path')
    const workerAddon = require(workerData.addonPath)
    const insert = (name) => workerAddon.upsertIndexRecord(
      path.join(workerData.root, name), 1, 1, 1, 1,
      '0123456789abcdef', 'fedcba9876543210'
    )
    ;(async () => {
      const firstMarker = path.join(workerData.root, 'before-sync.png')
      insert('before-sync.png')
      const sync = workerAddon.loadManifest(workerData.emptyRoot)
      const syncMode = workerAddon.getIndexMode()
      const syncDirty = workerAddon.isIndexDirty()
      const syncMarkerVisible = workerAddon.hasIndexPath(firstMarker)

      const secondMarker = path.join(workerData.root, 'before-async.png')
      insert('before-async.png')
      const asyncResult = await workerAddon.loadManifestAsync(workerData.emptyRoot)
      const asyncMode = workerAddon.getIndexMode()
      const asyncDirty = workerAddon.isIndexDirty()
      const asyncMarkerVisible = workerAddon.hasIndexPath(secondMarker)

      const malformedSync = workerAddon.loadManifest(workerData.malformedRoot)
      let malformedAsyncError = ''
      try { await workerAddon.loadManifestAsync(workerData.malformedRoot) }
      catch (error) { malformedAsyncError = String(error) }
      parentPort.postMessage({
        sync, syncMode, syncDirty, syncMarkerVisible,
        asyncResult, asyncMode, asyncDirty, asyncMarkerVisible,
        malformedSync, malformedAsyncError,
      })
    })().catch((error) => parentPort.postMessage({ fatal: String(error) }))
  `
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: { addonPath, root, emptyRoot, malformedRoot },
  })

  try {
    const message = await new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`empty-manifest worker exited with code ${code}`))
      })
    })
    assert.equal(message.fatal, undefined, JSON.stringify(message))
    for (const result of [message.sync, message.asyncResult]) {
      assert.equal(result.ok, true)
      assert.equal(result.recordCount, 0)
      assert.equal(result.segmentCount, 0)
    }
    for (const mode of [message.syncMode, message.asyncMode]) {
      assert.equal(mode.recordCount, 0)
      assert.equal(mode.segmentCount, 0)
      assert.equal(path.resolve(mode.manifestPath), path.resolve(emptyRoot))
    }
    for (const dirty of [message.syncDirty, message.asyncDirty]) {
      assert.equal(dirty.dirty, false)
      assert.equal(dirty.memoryRecords, 0)
      assert.equal(dirty.overlayRecords, 0)
      assert.equal(dirty.replacedCount, 0)
      assert.equal(dirty.deletedCount, 0)
    }
    assert.equal(message.syncMarkerVisible, false)
    assert.equal(message.asyncMarkerVisible, false)
    assert.equal(message.malformedSync.ok, false)
    assert.match(message.malformedSync.error, /Malformed manifest/i)
    assert.match(message.malformedAsyncError, /Malformed manifest/i)
  } finally {
    await worker.terminate()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('manifest persistence rejects absolute, parent, and reparse-point segment escapes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-manifest-boundary-'))
  const sourcePath = path.join(root, 'source.png')
  const seedIndexRoot = path.join(root, 'seed-index')
  const maliciousRoot = path.join(root, 'malicious-index')
  const saveRoot = path.join(root, 'save-index')
  const outsideSegment = path.join(root, 'outside.idx')
  const outsideOverlay = path.join(root, 'outside-overlay.json')
  const manifestPath = path.join(maliciousRoot, 'manifest.json')

  const assertOutsideUnchanged = (before) => {
    assert.equal(fs.existsSync(outsideSegment), true)
    assert.deepEqual(fs.readFileSync(outsideSegment), before.segment)
    assert.deepEqual(fs.readFileSync(outsideOverlay), before.overlay)
  }
  const writeMaliciousManifest = (segmentFile) => {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        segments: [{ id: 'outside', file: segmentFile, recordCount: 1, version: 4 }],
      }),
    )
  }
  const assertRejectedByEveryManifestReader = async (segmentFile, pattern) => {
    writeMaliciousManifest(segmentFile)
    addon.clearIndex()
    const syncResult = addon.loadManifest(maliciousRoot)
    assert.equal(syncResult.ok, false)
    assert.match(syncResult.error, pattern)
    addon.clearIndex()
    await assert.rejects(addon.loadManifestAsync(maliciousRoot), pattern)
    await assert.rejects(addon.compactManifestAsync(maliciousRoot), pattern)
  }

  try {
    createPng(sourcePath)
    fs.mkdirSync(maliciousRoot, { recursive: true })
    fs.mkdirSync(path.join(maliciousRoot, 'segments'))
    fs.mkdirSync(path.join(maliciousRoot, 'staging'))
    fs.writeFileSync(outsideOverlay, '{"sentinel":"must-not-change"}')

    addon.clearIndex()
    upsertTestIndexRecords([sourcePath])
    assert.equal((await addon.saveIndexToManifestAsync(seedIndexRoot)).ok, true)
    const seedSegmentName = fs.readdirSync(path.join(seedIndexRoot, 'segments'))[0]
    fs.copyFileSync(path.join(seedIndexRoot, 'segments', seedSegmentName), outsideSegment)
    const outsideBefore = {
      segment: fs.readFileSync(outsideSegment),
      overlay: fs.readFileSync(outsideOverlay),
    }

    await assertRejectedByEveryManifestReader(
      outsideSegment,
      /Unsafe manifest segment path: absolute paths are not allowed/,
    )
    assertOutsideUnchanged(outsideBefore)
    await assertRejectedByEveryManifestReader(
      '../outside.idx',
      /Unsafe manifest segment path: empty, dot, and parent components are not allowed/,
    )
    assertOutsideUnchanged(outsideBefore)
    await assertRejectedByEveryManifestReader(
      'segments/../../outside.idx',
      /Unsafe manifest segment path: empty, dot, and parent components are not allowed/,
    )
    assertOutsideUnchanged(outsideBefore)

    addon.clearIndex()
    assert.equal(addon.loadIndexFromSegment(outsideSegment).ok, true)
    const syncSave = addon.saveIndexToManifest(saveRoot)
    assert.equal(syncSave.ok, false)
    assert.match(syncSave.error, /Unsafe loaded segment path|Unsafe manifest segment path/)
    await assert.rejects(
      addon.saveIndexToManifestAsync(saveRoot),
      /Unsafe loaded segment path|Unsafe manifest segment path/,
    )
    assertOutsideUnchanged(outsideBefore)

    const segmentLink = path.join(maliciousRoot, 'segments', 'linked.idx')
    try {
      fs.symlinkSync(outsideSegment, segmentLink, 'file')
      await assertRejectedByEveryManifestReader(
        'segments/linked.idx',
        /Unsafe manifest segment path: Unsafe manifest path: reparse points are not allowed/,
      )
      assertOutsideUnchanged(outsideBefore)
      fs.unlinkSync(segmentLink)

      fs.writeFileSync(
        manifestPath,
        JSON.stringify({ schemaVersion: 2, segments: [{ file: `segments/${seedSegmentName}` }] }),
      )
      fs.copyFileSync(outsideSegment, path.join(maliciousRoot, 'segments', seedSegmentName))
      fs.symlinkSync(outsideOverlay, path.join(maliciousRoot, 'overlay.json'), 'file')
      addon.clearIndex()
      const overlaySync = addon.loadManifest(maliciousRoot)
      assert.equal(overlaySync.ok, false)
      assert.match(
        overlaySync.error,
        /Unsafe overlay\.json: Unsafe manifest path: reparse points are not allowed/,
      )
      await assert.rejects(
        addon.loadManifestAsync(maliciousRoot),
        /Unsafe overlay\.json: Unsafe manifest path: reparse points are not allowed/,
      )
      assertOutsideUnchanged(outsideBefore)
      fs.unlinkSync(path.join(maliciousRoot, 'overlay.json'))
    } catch (error) {
      if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error
      t.diagnostic(`file symlink checks skipped: ${error.code}`)
    }

    const junctionRoot = path.join(root, 'junction-index')
    const outsideDirectory = path.join(root, 'outside-segments')
    fs.mkdirSync(junctionRoot)
    fs.mkdirSync(outsideDirectory)
    fs.copyFileSync(outsideSegment, path.join(outsideDirectory, 'outside.idx'))
    try {
      fs.symlinkSync(outsideDirectory, path.join(junctionRoot, 'segments'), 'junction')
      fs.writeFileSync(
        path.join(junctionRoot, 'manifest.json'),
        JSON.stringify({ schemaVersion: 2, segments: [{ file: 'segments/outside.idx' }] }),
      )
      addon.clearIndex()
      const junctionLoad = addon.loadManifest(junctionRoot)
      assert.equal(junctionLoad.ok, false)
      assert.match(junctionLoad.error, /reparse points are not allowed|Unsafe manifest directory/)
      await assert.rejects(
        addon.loadManifestAsync(junctionRoot),
        /reparse points are not allowed|Unsafe manifest directory/,
      )
      await assert.rejects(
        addon.compactManifestAsync(junctionRoot),
        /reparse points are not allowed|Unsafe manifest directory/,
      )
      const repaired = addon.repairManifestFromSegments(junctionRoot)
      assert.equal(repaired.ok, false)
      assert.match(repaired.error, /Unsafe manifest directory|reparse points are not allowed/)
      assert.deepEqual(
        fs.readFileSync(path.join(outsideDirectory, 'outside.idx')),
        outsideBefore.segment,
      )
    } catch (error) {
      if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error
      t.diagnostic(`junction check skipped: ${error.code}`)
    }
  } finally {
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('running manifest save cooperatively cancels at a safe commit boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-persistence-cancel-'))
  try {
    addon.clearIndex()
    process.env.FLOATING_CLOCK_NATIVE_COOPERATIVE_CANCEL_TEST = '1'
    const inserted = addon.upsertIndexRecord(
      path.join(root, 'cancel-boundary.png'),
      1,
      1,
      1,
      1,
      '0123456789abcdef',
      'fedcba9876543210',
    )
    assert.equal(inserted.ok, true)

    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads')
      const workerAddon = require(workerData.addonPath)
      parentPort.on('message', (command) => {
        if (command === 'cancel') parentPort.postMessage({ phase: 'cancel-requested', result: workerAddon.cancelAsyncWork() })
      })
      let reported = false
      const save = workerAddon.saveIndexToManifestAsync(workerData.root)
      const timer = setInterval(() => {
        const status = workerAddon.getNativeStatus()
        if (status.asyncWorkPreCommitCount > 0) {
          reported = true
          clearInterval(timer)
          parentPort.postMessage({ phase: 'pre-commit', status })
        }
      }, 1)
      void save.then(
        () => { if (!reported) { clearInterval(timer); parentPort.postMessage({ phase: 'completed' }) } },
        (error) => { if (!reported) { clearInterval(timer); parentPort.postMessage({ phase: 'failed', error: String(error) }) } },
      )
    `
    const worker = new Worker(workerSource, { eval: true, workerData: { addonPath, root } })
    const message = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('worker did not reach the persistence pre-commit boundary')),
        10000,
      )
      worker.once('message', (value) => {
        clearTimeout(timeout)
        resolve(value)
      })
      worker.once('error', reject)
    })
    assert.equal(message.phase, 'pre-commit', JSON.stringify(message))
    const status = message.status
    assert.equal(status.asyncWorkCancellationMode, 'explicit-cooperative-persistence-native-queued')
    assert.equal(status.asyncWorkRunningCount, 1)
    assert.equal(status.asyncWorkCancellableCount, 1)
    assert.equal(status.asyncWorkPreCommitCount, 1)
    const cancelled = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('worker did not acknowledge cooperative cancellation')),
        5000,
      )
      worker.once('message', (value) => {
        clearTimeout(timeout)
        resolve(value)
      })
      worker.once('error', reject)
    })
    worker.postMessage('cancel')
    const cancellation = await cancelled
    assert.equal(cancellation.phase, 'cancel-requested')
    assert.equal(cancellation.result.ok, true)
    assert.equal(cancellation.result.cooperativeRequested, 1)
    await worker.terminate()

    const deadline = Date.now() + 5000
    while (addon.getNativeStatus().indexWriterActive && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(addon.getNativeStatus().indexWriterActive, false)
    assert.equal(fs.existsSync(path.join(root, 'manifest.tmp')), false)
    const staging = path.join(root, 'staging')
    if (fs.existsSync(staging)) {
      assert.deepEqual(
        fs.readdirSync(staging).filter((name) => name.endsWith('.tmp')),
        [],
      )
    }

    const manifestPath = path.join(root, 'manifest.json')
    const segmentDir = path.join(root, 'segments')
    const segmentFiles = fs.existsSync(segmentDir)
      ? fs
          .readdirSync(segmentDir)
          .filter((name) => name.endsWith('.idx'))
          .sort()
      : []
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      const referenced = manifest.segments.map((segment) => path.basename(segment.file)).sort()
      assert.deepEqual(
        segmentFiles,
        referenced,
        'a committed manifest must reference every retained segment',
      )
    } else {
      assert.deepEqual(
        segmentFiles,
        [],
        'a cancelled pre-commit save must not leave orphan segments',
      )
    }
  } finally {
    delete process.env.FLOATING_CLOCK_NATIVE_COOPERATIVE_CANCEL_TEST
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

async function waitForScan() {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const progress = addon.getScanProgress()
    if (progress.state !== 'scanning') return progress
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  addon.stopScan()
  throw new Error('scan timed out')
}

async function waitForScanState(expectedState, predicate = () => true) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const progress = addon.getScanProgress()
    if (progress.state === expectedState && predicate(progress)) return progress
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`scan did not reach ${expectedState}: ${JSON.stringify(addon.getScanProgress())}`)
}

test('scan-owned asynchronous snapshot exports old committed metadata while the scan owns its writer', async () => {
  assert.equal(typeof addon.snapshotScanRecordsAsync, 'function')
  assert.equal(typeof addon.readScanExportPage, 'function')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-scan-owned-export-'))
  let cursor
  try {
    addon.clearIndex()
    const oldPath = path.join(root, 'old-index-only.png')
    assert.equal(
      addon.upsertIndexRecord(oldPath, 30, 40, 321, 123, '0123456789abcdef', 'fedcba9876543210').ok,
      true,
    )
    for (let i = 0; i < 128; i++) createPng(path.join(root, `${i}.png`))
    const started = addon.scanDirectory(root, 'full')
    assert.equal(started.ok, true)
    assert.equal(addon.pauseScan().ok, true)
    await waitForScanState('paused')
    await assert.rejects(addon.snapshotIndexRecordsAsync(), /Index write busy/)
    const snapshot = await addon.snapshotScanRecordsAsync(started.generation)
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.generation, started.generation)
    cursor = snapshot.cursor
    const page = addon.readScanExportPage(cursor, started.generation, 0, 256)
    assert.equal(page.ok, true)
    assert.ok(page.records.length <= 256)
    assert.ok(
      page.records.some(
        (record) =>
          record.path === oldPath && record.fileSize === 321 && record.modifiedTime === 123,
      ),
    )
    for (const record of page.records)
      assert.deepEqual(Object.keys(record).sort(), ['fileSize', 'modifiedTime', 'path'])
    assert.equal(addon.readIndexExportPage(cursor, 0, 256).ok, false)
    assert.equal(addon.readScanExportPage(cursor, started.generation + 1, 0, 256).ok, false)
  } finally {
    if (cursor) await addon.closeIndexExport(cursor)
    await addon.stopScanAsync()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('scan-owned final snapshot rejects an intervening completed writer from another environment', async () => {
  assert.equal(typeof addon.snapshotScanRecordsAsync, 'function')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-scan-export-epoch-'))
  try {
    addon.clearIndex()
    createPng(path.join(root, 'a.png'))
    const started = addon.scanDirectory(root, 'full')
    assert.equal(started.ok, true)
    await waitForScanState('idle')
    const first = await addon.snapshotScanRecordsAsync(started.generation)
    assert.equal(first.ok, true)
    await addon.closeIndexExport(first.cursor)
    const second = await addon.snapshotScanRecordsAsync(started.generation)
    assert.equal(second.ok, true)
    await addon.closeIndexExport(second.cursor)
    await new Promise((resolve, reject) => {
      const worker = new Worker(
        `
        const { parentPort, workerData } = require('node:worker_threads')
        const addon = require(workerData.addonPath)
        const result = addon.clearIndex()
        if (!result.ok) throw new Error(result.error)
        parentPort.postMessage('done')
      `,
        { eval: true, workerData: { addonPath } },
      )
      worker.once('error', reject)
      worker.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('worker exit ' + code)),
      )
    })
    assert.equal(addon.getScanProgress().generation, started.generation)
    assert.equal(addon.getNativeStatus().indexWriterActive, false)
    await assert.rejects(
      addon.snapshotScanRecordsAsync(started.generation),
      /changed|stale|writer/i,
    )
  } finally {
    await addon.stopScanAsync()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('scan-owned exports enforce cursor quotas, page limits, kinds and owners', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-scan-export-bounds-'))
  const cursors = []
  try {
    addon.clearIndex()
    for (let i = 0; i < 600; i++)
      assert.equal(
        addon.upsertIndexRecord(
          path.join(root, `${i}.png`),
          1,
          1,
          i,
          1,
          '0000000000000000',
          '0000000000000000',
        ).ok,
        true,
      )
    const { generation } = addon.scanDirectory(root, 'full')
    await waitForScanState('idle')
    for (const owner of [undefined, 0, -1, 0.5, NaN, '1', Number.MAX_SAFE_INTEGER + 1])
      await assert.rejects(addon.snapshotScanRecordsAsync(owner), /generation/)
    const first = await addon.snapshotScanRecordsAsync(generation)
    cursors.push(first.cursor)
    const second = await addon.snapshotScanRecordsAsync(generation)
    cursors.push(second.cursor)
    await assert.rejects(addon.snapshotScanRecordsAsync(generation), /limit 2/)
    let offset = 0
    do {
      const page = addon.readScanExportPage(first.cursor, generation, offset, 1_000_000)
      assert.equal(page.ok, true)
      assert.ok(page.records.length <= 256)
      assert.ok(
        page.records.reduce((sum, item) => sum + Buffer.byteLength(item.path) + 128, 0) <=
          256 * 1024,
      )
      offset = page.nextOffset
      if (!page.hasMore) break
    } while (offset < 600)
    assert.equal(offset, 600)
    await addon.closeIndexExport(cursors.pop())
    const normal = await addon.snapshotIndexRecordsAsync()
    cursors.push(normal.cursor)
    assert.equal(addon.readScanExportPage(normal.cursor, generation, 0, 256).ok, false)
    assert.equal(addon.readIndexExportPage(first.cursor, 0, 256).ok, false)
    assert.equal(addon.readScanExportPage(first.cursor, generation, -1, 256).ok, false)
    assert.equal(addon.readScanExportPage(first.cursor, generation, 601, 256).ok, false)
    const replacement = addon.scanDirectory(root, 'full')
    assert.equal(replacement.ok, true)
    assert.equal(addon.readScanExportPage(first.cursor, generation, 0, 256).ok, false)
    await assert.rejects(addon.snapshotScanRecordsAsync(generation), /replaced/)
  } finally {
    for (const cursor of cursors) await addon.closeIndexExport(cursor)
    await addon.stopScanAsync()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('scan-owned capture keeps writer admission until completion and cancels before publication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-scan-export-cancel-'))
  const variable = 'FLOATING_CLOCK_NATIVE_SCAN_SNAPSHOT_DELAY_MS_TEST'
  const previous = process.env[variable]
  const discardVariable = 'FLOATING_CLOCK_NATIVE_FAIL_SCAN_DISCARD_QUEUE_TEST'
  const previousDiscard = process.env[discardVariable]
  process.env[variable] = '200'
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  const blockUntilPhase = (phase) => {
    const deadline = Date.now() + 5000
    while (addon.getNativeStatus().scanSnapshotTestPhase !== phase && Date.now() < deadline)
      Atomics.wait(sleeper, 0, 0, 5)
    assert.equal(addon.getNativeStatus().scanSnapshotTestPhase, phase)
  }
  try {
    addon.clearIndex()
    for (const late of [false, true, 'queue-failure']) {
      if (late === 'queue-failure') process.env[discardVariable] = '1'
      else delete process.env[discardVariable]
      const { generation } = addon.scanDirectory(root, 'full')
      await waitForScanState('idle')
      const capture = addon.snapshotScanRecordsAsync(generation)
      const rejected = assert.rejects(capture, /cancel/i)
      blockUntilPhase(late ? 3 : 1)
      assert.equal(
        addon.getScanProgress().state,
        'idle',
        'capture extends an already completed scan lease',
      )
      const before = performance.now()
      const busy = addon.clearIndex()
      assert.equal(busy.ok, false)
      assert.match(busy.error, /busy/i)
      assert.ok(
        performance.now() - before < 250,
        'writer fails immediately, without waiting on capture',
      )
      const stopped = addon.stopScanGenerationAsync(generation)
      await rejected
      await stopped
      assert.equal(addon.getNativeStatus().indexWriterActive, false)
      assert.equal(addon.getScanProgress().cancelled, true)
      assert.equal(addon.clearIndex().ok, true)
    }
    // Cancelled cursor slots must be removed, including discard queue failure.
    delete process.env[variable]
    const { generation } = addon.scanDirectory(root, 'full')
    await waitForScanState('idle')
    const a = await addon.snapshotScanRecordsAsync(generation)
    const b = await addon.snapshotScanRecordsAsync(generation)
    await addon.closeIndexExport(a.cursor)
    await addon.closeIndexExport(b.cursor)
  } finally {
    if (previous === undefined) delete process.env[variable]
    else process.env[variable] = previous
    if (previousDiscard === undefined) delete process.env[discardVariable]
    else process.env[discardVariable] = previousDiscard
    await addon.stopScanAsync()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('idle environment stop leaves the active environment thumbnail sidecar running', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-sidecar-owner-'))
  const empty = path.join(root, 'empty'),
    source = path.join(root, 'source'),
    cache = path.join(root, 'cache')
  for (const dir of [empty, source, cache]) fs.mkdirSync(dir, { recursive: true })
  let worker
  try {
    addon.clearIndex()
    const first = addon.scanDirectory(empty, 'full')
    assert.equal(first.ok, true)
    await waitForScanState('idle')
    const jpeg = await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#3874ac' },
    })
      .jpeg()
      .toBuffer()
    for (let i = 0; i < 256; i++) fs.writeFileSync(path.join(source, `${i}.jpg`), jpeg)
    worker = new Worker(
      `
      const {parentPort, workerData} = require('node:worker_threads')
      const addon = require(workerData.addonPath)
      const delay = () => new Promise(r => setTimeout(r, 5))
      ;(async () => {
        addon.configureScanThumbnails(workerData.cache, true, 6)
        const started = addon.scanDirectory(workerData.source, 'full')
        if (!started.ok) throw new Error(started.error)
        addon.pauseScan()
        const deadline = Date.now() + 5000
        while (addon.getScanProgress().thumbnailPhase !== 'scan' && Date.now() < deadline) await delay()
        parentPort.postMessage({kind:'ready', progress:addon.getScanProgress()})
        parentPort.once('message', async () => {
          parentPort.postMessage({kind:'before', progress:addon.getScanProgress()})
          addon.resumeScan()
          while (addon.getScanProgress().state !== 'idle') await delay()
          parentPort.postMessage({kind:'done', progress:addon.getScanProgress()})
        })
      })().catch(e => {throw e})
    `,
      { eval: true, workerData: { addonPath, source, cache } },
    )
    const messages = [],
      waiters = []
    worker.on('message', (message) => {
      if (waiters.length) waiters.shift()(message)
      else messages.push(message)
    })
    let workerError
    worker.on('error', (error) => {
      workerError = error
    })
    const next = async () => {
      const deadline = Date.now() + 10000
      while (!messages.length && !workerError && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 5))
      if (workerError) throw workerError
      assert.ok(messages.length, 'worker response timed out')
      return messages.shift()
    }
    assert.equal((await next()).progress.thumbnailPhase, 'scan')
    await addon.stopScanGenerationAsync(first.generation)
    worker.postMessage('resume')
    assert.equal(
      (await next()).progress.thumbnailPhase,
      'scan',
      'old idle owner cannot cancel another environment sidecar',
    )
    const done = await next()
    assert.equal(done.progress.thumbnailCompleted, 256)
    assert.equal(done.progress.thumbnailCancelled, 0)
    assert.equal(fs.readdirSync(cache).filter((name) => name.endsWith('.jpg')).length, 256)
  } finally {
    if (worker) await worker.terminate()
    await addon.stopScanAsync()
    addon.configureScanThumbnails('', false, 6)
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('scan export cursor tokens cannot alias cursors owned by another environment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-cursor-env-'))
  let cursor, worker
  try {
    addon.clearIndex()
    const first = addon.scanDirectory(root, 'full')
    await waitForScanState('idle')
    cursor = (await addon.snapshotScanRecordsAsync(first.generation)).cursor
    const result = await new Promise((resolve, reject) => {
      worker = new Worker(
        `
        const {parentPort,workerData} = require('node:worker_threads')
        const addon = require(workerData.addonPath)
        ;(async () => {
          const started = addon.scanDirectory(workerData.root, 'full')
          if (!started.ok) throw new Error(started.error)
          while(addon.getScanProgress().state !== 'idle') await new Promise(r=>setTimeout(r,5))
          const snapshot = await addon.snapshotScanRecordsAsync(started.generation)
          const foreign = addon.readScanExportPage(workerData.foreign, started.generation, 0, 256)
          const own = addon.readScanExportPage(snapshot.cursor, started.generation, 0, 256)
          parentPort.postMessage({snapshot,foreign,own})
          parentPort.once('message', async () => {await addon.closeIndexExport(snapshot.cursor)})
        })().catch(e=>{throw e})
      `,
        { eval: true, workerData: { addonPath, root, foreign: cursor } },
      )
      worker.once('message', resolve)
      worker.once('error', reject)
    })
    assert.equal(result.foreign.ok, false)
    assert.equal(result.own.ok, true)
    assert.notEqual(result.snapshot.cursor, cursor)
    assert.equal(
      addon.readScanExportPage(result.snapshot.cursor, first.generation, 0, 256).ok,
      false,
    )
    assert.equal(
      addon.readScanExportPage(cursor, first.generation, 0, 256).ok,
      true,
      'already captured view remains immutable',
    )
    worker.postMessage('close')
  } finally {
    if (worker) await worker.terminate()
    if (cursor) await addon.closeIndexExport(cursor)
    await addon.stopScanAsync()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('scan-owned capture observes byte budgets and bounds long-path pages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-scan-byte-budget-'))
  const longPart = 'x'.repeat(100_000)
  let cursor
  try {
    addon.clearIndex()
    for (let i = 0; i < 3; i++)
      assert.equal(
        addon.upsertIndexRecord(
          path.join(root, `${longPart}${i}.png`),
          1,
          1,
          i,
          1,
          '0000000000000000',
          '0000000000000000',
        ).ok,
        true,
      )
    let started = addon.scanDirectory(root, 'full')
    await waitForScanState('idle')
    cursor = (await addon.snapshotScanRecordsAsync(started.generation)).cursor
    const page = addon.readScanExportPage(cursor, started.generation, 0, 256)
    assert.equal(page.records.length, 2)
    assert.equal(page.hasMore, true)
    assert.ok(
      page.records.reduce((sum, record) => sum + Buffer.byteLength(record.path) + 128, 0) <=
        256 * 1024,
    )
    await addon.closeIndexExport(cursor)
    cursor = undefined
    // Upsert normalizes all prior overlay paths; construct a checked mmap fixture
    // directly so this budget regression tests export rather than quadratic setup.
    const count = 700
    const paths = Array.from({ length: count }, (_, i) =>
      Buffer.from(path.join(root, `${longPart}${i}.png`) + '\0'),
    )
    const offsets = Buffer.alloc((count + 1) * 8)
    let pathBytes = 0
    for (let i = 0; i < count; i++) {
      offsets.writeBigUInt64LE(BigInt(pathBytes), i * 8)
      pathBytes += paths[i].length
    }
    offsets.writeBigUInt64LE(BigInt(pathBytes), count * 8)
    const header = Buffer.alloc(80),
      metadata = Buffer.alloc(count * 32),
      hashes = Buffer.alloc(count * 8),
      footer = Buffer.alloc(16)
    const pathStart = 80 + offsets.length,
      metaStart = pathStart + pathBytes,
      hashStart = metaStart + metadata.length,
      footerStart = hashStart + hashes.length
    header.write('IMS1')
    header.writeUInt32LE(2, 4)
    for (const [offset, value] of [
      [8, count],
      [16, footerStart + 16],
      [24, 80],
      [32, 80],
      [40, pathStart],
      [48, metaStart],
      [56, hashStart],
      [64, footerStart],
    ])
      header.writeBigUInt64LE(BigInt(value), offset)
    footer.write('END')
    footer.writeBigUInt64LE(BigInt(count), 4)
    footer.writeUInt32LE(2, 12)
    const segment = path.join(root, 'fixture.idx')
    fs.writeFileSync(segment, Buffer.concat([header, offsets, ...paths, metadata, hashes, footer]))
    addon.clearIndex()
    assert.equal(addon.loadIndexFromSegment(segment).ok, true)
    started = addon.scanDirectory(root, 'full')
    await waitForScanState('idle')
    await assert.rejects(addon.snapshotScanRecordsAsync(started.generation), /128 MiB/)
    assert.equal(addon.getNativeStatus().indexWriterActive, false)
    addon.clearIndex()
    assert.equal(
      addon.upsertIndexRecord(
        path.join(root, 'x'.repeat(256 * 1024)),
        1,
        1,
        1,
        1,
        '0000000000000000',
        '0000000000000000',
      ).ok,
      true,
    )
    started = addon.scanDirectory(root, 'full')
    await waitForScanState('idle')
    await assert.rejects(addon.snapshotScanRecordsAsync(started.generation), /page byte/)
  } finally {
    if (cursor) await addon.closeIndexExport(cursor)
    await addon.stopScanAsync()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('worker teardown cancels an in-flight scan snapshot and releases its shared lease', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-scan-export-teardown-'))
  const variable = 'FLOATING_CLOCK_NATIVE_SCAN_SNAPSHOT_DELAY_MS_TEST'
  const previous = process.env[variable]
  process.env[variable] = '200'
  let worker
  try {
    addon.clearIndex()
    await new Promise((resolve, reject) => {
      worker = new Worker(
        `
        const {parentPort,workerData} = require('node:worker_threads')
        const addon = require(workerData.addonPath)
        ;(async () => {
          const scan = addon.scanDirectory(workerData.root, 'full')
          while(addon.getScanProgress().state !== 'idle') await new Promise(r=>setTimeout(r,5))
          addon.snapshotScanRecordsAsync(scan.generation).catch(()=>{})
          while(addon.getNativeStatus().scanSnapshotTestPhase !== 1) await new Promise(r=>setTimeout(r,5))
          parentPort.postMessage('capturing')
        })().catch(e=>{throw e})
      `,
        { eval: true, workerData: { addonPath, root } },
      )
      worker.once('message', resolve)
      worker.once('error', reject)
    })
    assert.equal(addon.getNativeStatus().indexWriterActive, true)
    await worker.terminate()
    assert.equal(addon.getNativeStatus().indexWriterActive, false)
    assert.equal(addon.clearIndex().ok, true)
  } finally {
    if (worker) await worker.terminate()
    if (previous === undefined) delete process.env[variable]
    else process.env[variable] = previous
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('generation-bound stop cannot stop a replacement scan and blocks starts while joining', async () => {
  assert.equal(typeof addon.stopScanGenerationAsync, 'function')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-scan-owner-'))
  try {
    for (let index = 0; index < 512; index++) createPng(path.join(root, `${index}.png`))
    const first = addon.scanDirectory(root, 'full')
    assert.equal(first.ok, true)
    assert.ok(Number.isSafeInteger(first.generation) && first.generation > 0)
    await waitForScanState('idle')
    const second = addon.scanDirectory(root, 'full')
    assert.equal(second.ok, true)
    assert.ok(second.generation > first.generation)
    assert.equal(addon.pauseScan().ok, true)
    await waitForScanState('paused')
    assert.equal(addon.getScanProgress().generation, second.generation)
    const stale = await addon.stopScanGenerationAsync(first.generation)
    assert.equal(stale.ok, true)
    assert.equal(stale.matched, false)
    assert.equal(
      addon.getScanProgress().state,
      'paused',
      'old owner must not request stop or resume B',
    )
    assert.equal(addon.getScanProgress().generation, second.generation)
    const stopping = addon.stopScanGenerationAsync(second.generation)
    const refused = addon.scanDirectory(root, 'full')
    assert.equal(refused.ok, false)
    assert.match(refused.error, /stopping/i)
    const stopped = await stopping
    assert.equal(stopped.ok, true)
    assert.equal(stopped.matched, true)
    assert.equal(addon.getScanProgress().state, 'idle')
    const third = addon.scanDirectory(root, 'full')
    assert.equal(third.ok, true)
    assert.ok(third.generation > second.generation)
    assert.equal((await addon.stopScanAsync()).ok, true, 'legacy no-argument API stays compatible')
  } finally {
    await addon.stopScanAsync()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('generation-bound stop rejects missing, fractional, unsafe and nonnumeric owners', async () => {
  assert.equal(typeof addon.stopScanGenerationAsync, 'function')
  const statusBefore = addon.getNativeStatus()
  for (const args of [
    [],
    [undefined],
    [null],
    ['1'],
    [0],
    [-1],
    [0.5],
    [NaN],
    [Infinity],
    [Number.MAX_SAFE_INTEGER + 1],
  ]) {
    await assert.rejects(
      Promise.resolve().then(() => addon.stopScanGenerationAsync(...args)),
      /generation/i,
    )
  }
  const statusAfter = addon.getNativeStatus()
  assert.equal(statusAfter.asyncWorkActiveCount, statusBefore.asyncWorkActiveCount)
})

test('overlapping generation and legacy stops share a join without blocking the event loop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-stop-overlap-'))
  const previousFlag = process.env.FLOATING_CLOCK_NATIVE_SCAN_STOP_JOIN_TEST
  process.env.FLOATING_CLOCK_NATIVE_SCAN_STOP_JOIN_TEST = '1'
  try {
    for (let index = 0; index < 512; index++) createPng(path.join(root, `${index}.png`))
    const started = addon.scanDirectory(root, 'full')
    assert.equal(started.ok, true)
    assert.equal(addon.pauseScan().ok, true)
    let firstDone = false
    const first = addon.stopScanGenerationAsync(started.generation).then((result) => {
      firstDone = true
      return result
    })
    const deadline = Date.now() + 3000
    while (!addon.getNativeStatus().scanStopJoinActive && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    assert.equal(
      addon.getNativeStatus().scanStopJoinActive,
      true,
      'first stop must already be joining',
    )
    const before = performance.now()
    const second = addon.stopScanGenerationAsync(started.generation)
    const third = addon.stopScanAsync()
    assert.ok(
      performance.now() - before < 250,
      'overlapping calls must not wait for the 600ms join fixture',
    )
    assert.equal(addon.getNativeStatus().scanStopWorkCount, 1)
    assert.equal(addon.scanDirectory(root, 'full').ok, false)
    await new Promise(setImmediate)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(firstDone, false, 'heartbeats ran while the first join remained pending')
    const results = await Promise.all([first, second, third])
    assert.equal(
      results.every((result) => result.ok),
      true,
    )
    assert.equal(results[0].matched, true)
    assert.equal(results[1].matched, true)
    assert.equal(addon.getNativeStatus().scanStopJoinActive, false)
    const stopped = addon.getScanProgress()
    assert.equal(stopped.cancelled, true)
    assert.equal(stopped.generation, started.generation)
    assert.equal(stopped.state, 'idle')
  } finally {
    if (previousFlag === undefined) delete process.env.FLOATING_CLOCK_NATIVE_SCAN_STOP_JOIN_TEST
    else process.env.FLOATING_CLOCK_NATIVE_SCAN_STOP_JOIN_TEST = previousFlag
    await addon.stopScanAsync()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('native terminal errors survive later stop and next generation resets the outcome', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-scan-outcome-'))
  const previousFlag = process.env.FLOATING_CLOCK_NATIVE_FAIL_SCAN_START_TEST
  process.env.FLOATING_CLOCK_NATIVE_FAIL_SCAN_START_TEST = '1'
  try {
    createPng(path.join(root, 'one.png'))
    const failed = addon.scanDirectory(root, 'full')
    assert.equal(failed.ok, true)
    await waitForScanState('error')
    await addon.stopScanAsync()
    assert.equal(addon.getScanProgress().state, 'error')
    assert.match(addon.getScanProgress().lastError, /Injected scan failure/)
    delete process.env.FLOATING_CLOCK_NATIVE_FAIL_SCAN_START_TEST
    const next = addon.scanDirectory(root, 'full')
    assert.equal(next.ok, true)
    await waitForScanState('idle')
    assert.equal(addon.getScanProgress().cancelled, false)
    assert.equal(addon.getScanProgress().lastError, undefined)
  } finally {
    if (previousFlag === undefined) delete process.env.FLOATING_CLOCK_NATIVE_FAIL_SCAN_START_TEST
    else process.env.FLOATING_CLOCK_NATIVE_FAIL_SCAN_START_TEST = previousFlag
    await addon.stopScanAsync()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

async function waitForNativeThumbnailRebuild() {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const progress = addon.getNativeThumbnailRebuildProgress()
    if (progress.state === 'done' || progress.state === 'error') return progress
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  addon.stopNativeThumbnailRebuild()
  throw new Error('native thumbnail rebuild timed out')
}

test('scan commit feed emits only committed paths while explicitly enabled', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-scan-commit-feed-'))
  const first = path.join(root, 'first.png')
  const second = path.join(root, 'second.png')
  createPng(first)
  createPng(second)

  try {
    addon.clearIndex()
    assert.equal(typeof addon.configureScanCommitFeed, 'function')
    assert.equal(typeof addon.drainScanCommittedPaths, 'function')
    assert.deepEqual(addon.configureScanCommitFeed(true, 16), {
      ok: true,
      enabled: true,
      maxEntries: 16,
    })
    assert.equal(addon.scanDirectory(root, 'full').ok, true)
    assert.equal((await waitForScan()).state, 'idle')

    const firstChunk = addon.drainScanCommittedPaths(1)
    const secondChunk = addon.drainScanCommittedPaths(256)
    assert.equal(firstChunk.ok, true)
    assert.ok(firstChunk.generation > 0)
    assert.equal(firstChunk.pending, 1)
    assert.equal(secondChunk.generation, firstChunk.generation)
    assert.equal(secondChunk.pending, 0)
    assert.equal(secondChunk.dropped, 0)
    assert.deepEqual(new Set([...firstChunk.paths, ...secondChunk.paths]), new Set([first, second]))

    assert.equal(addon.configureScanCommitFeed(false, 16).enabled, false)
    addon.clearIndex()
    assert.equal(addon.scanDirectory(root, 'full').ok, true)
    assert.equal((await waitForScan()).state, 'idle')
    const disabled = addon.drainScanCommittedPaths(256)
    assert.equal(disabled.enabled, false)
    assert.deepEqual(disabled.paths, [])
    assert.equal(disabled.pending, 0)
  } finally {
    addon.configureScanCommitFeed(false, 16)
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('scans multiple roots including Unicode paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-scan-'))
  const first = path.join(root, 'first')
  const second = path.join(root, '中文目录')
  fs.mkdirSync(first)
  fs.mkdirSync(second)
  createPng(path.join(first, 'one.png'))
  createPng(path.join(second, '图片.png'))

  try {
    addon.clearIndex()
    const started = addon.scanDirectory(`${first}\x1f${second}`, 'full')
    assert.equal(started.ok, true)
    const progress = await waitForScan()
    assert.equal(progress.state, 'idle')
    assert.equal(addon.getIndexStats().indexedCount, 2, JSON.stringify(progress))
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('directory fallback prunes whole-drive system folders and reports an actionable reason', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-whole-drive-policy-'))
  const scanRoot = path.relative(process.cwd(), root)
  const excluded = ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData']
  const visible = path.join(root, 'Pictures')
  fs.mkdirSync(visible)
  createPng(path.join(visible, 'visible.png'))
  for (const directory of excluded) {
    const target = path.join(root, directory)
    fs.mkdirSync(target)
    createPng(path.join(target, 'must-not-index.png'))
  }

  try {
    addon.clearIndex()
    addon.configureScanThumbnails('', false, 6)
    assert.equal(addon.scanDirectory(scanRoot, 'full').ok, true)
    const progress = await waitForScan()
    assert.equal(progress.state, 'idle')
    assert.equal(progress.backend, 'enum')
    assert.equal(progress.fallbackCode, 'not-drive-path')
    assert.equal(progress.fallbackReason, 'not a drive path')
    assert.equal(progress.fallbackAction, 'Directory paths use the safe enumeration backend.')
    assert.equal(progress.usnWin32Error, 0)
    assert.equal(progress.usnRequiresAdmin, false)
    assert.equal(progress.enumSkippedDirCount, excluded.length)
    assert.equal(addon.getIndexStats().indexedCount, 1)
    const records = addon.queryIndexRecords('', 0, 10).records
    assert.deepEqual(
      records.map((record) => record.path),
      [path.join(scanRoot, 'Pictures', 'visible.png')],
    )
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('drive-rooted subdirectory scan stays scoped and returns absolute paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-usn-scope-'))
  const selected = path.join(root, 'selected')
  const sibling = path.join(root, 'sibling')
  const inside = path.join(selected, '图片.png')
  fs.mkdirSync(selected)
  fs.mkdirSync(sibling)
  createPng(inside)
  createPng(path.join(sibling, 'must-not-index.png'))

  try {
    addon.clearIndex()
    addon.configureScanThumbnails('', false, 6)
    assert.equal(addon.scanDirectory(selected, 'full').ok, true)
    const progress = await waitForScan()
    assert.equal(progress.state, 'idle')
    assert.ok(['USN', 'enum'].includes(progress.backend))
    assert.notEqual(progress.fallbackCode, 'scoped-directory')
    assert.equal(addon.getIndexStats().indexedCount, 1, JSON.stringify(progress))
    const records = addon.queryIndexRecords('', 0, 10).records
    assert.deepEqual(
      records.map((record) => record.path),
      [inside],
    )
    assert.equal(path.isAbsolute(records[0].path), true)
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('scan signature prefilter rejects extension spoofing and preserves valid dual hashes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-signature-prefilter-'))
  const validPath = path.join(root, 'valid.png')
  const renamedPath = path.join(root, 'renamed.jpg')
  const spoofedPath = path.join(root, 'spoofed.jpg')
  const pixels = Buffer.alloc(8 * 8)
  for (let index = 0; index < pixels.length; index++) pixels[index] = index % 2 === 0 ? 255 : 0
  await sharp(pixels, { raw: { width: 8, height: 8, channels: 1 } })
    .png()
    .toFile(validPath)
  fs.copyFileSync(validPath, renamedPath)
  fs.writeFileSync(spoofedPath, Buffer.alloc(4 * 1024 * 1024, 0x41))

  try {
    addon.clearIndex()
    addon.configureScanThumbnails('', false, 6)
    const expectedValid = addon.hashImage(validPath)
    const expectedRenamed = addon.hashImage(renamedPath)
    assert.equal(expectedValid.ok, true)
    assert.equal(expectedRenamed.ok, true, 'content signature, not extension, controls admission')
    assert.notEqual(expectedValid.dctHash64, '0000000000000000')

    assert.equal(addon.scanDirectory(root, 'full').ok, true)
    const progress = await waitForScan()
    assert.equal(progress.state, 'idle')
    assert.equal(progress.signatureRejectedCount, 1)
    assert.equal(progress.skippedCount, 1)
    assert.match(progress.lastWarning, /Signature rejected/)

    const search = addon.searchByImage(validPath, 64, 10, 'balanced')
    assert.equal(search.ok, true)
    const byPath = new Map(search.results.map((record) => [record.path, record]))
    assert.equal(byPath.get(validPath).diffHash64, expectedValid.diffHash64)
    assert.equal(byPath.get(validPath).dctHash64, expectedValid.dctHash64)
    assert.equal(byPath.get(renamedPath).diffHash64, expectedRenamed.diffHash64)
    assert.equal(byPath.get(renamedPath).dctHash64, expectedRenamed.dctHash64)

    assert.equal(addon.scanDirectory(root, 'addNew').ok, true)
    const cached = await waitForScan()
    assert.equal(cached.signatureRejectedCount, 0, 'unchanged rejected paths use the failed cache')
    assert.equal(cached.skippedUnchanged, 1)
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('bounds parallel scan workers and stops a paused pipeline asynchronously', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-async-stop-'))
  const source = path.join(root, 'source')
  const restart = path.join(root, 'restart')
  fs.mkdirSync(source)
  fs.mkdirSync(restart)
  for (let i = 0; i < 1024; i += 1) createPng(path.join(source, `${i}.png`))
  createPng(path.join(restart, 'one.png'))

  try {
    assert.equal(typeof addon.stopScanAsync, 'function')
    addon.clearIndex()
    addon.configureScanThumbnails('', false, 6)
    assert.equal(addon.pauseScan().ok, false)
    assert.equal(addon.resumeScan().ok, false)
    assert.equal(addon.scanDirectory(source, 'full').ok, true)
    assert.equal(addon.pauseScan().ok, true)
    const paused = await waitForScanState(
      'paused',
      (progress) => progress.scanActiveWorkers === progress.scanWorkerCount,
    )
    assert.ok(paused.scanWorkerCount >= 2 && paused.scanWorkerCount <= 8)
    assert.equal(paused.scanQueueCapacity, Math.max(64, Math.min(256, paused.scanWorkerCount * 32)))
    assert.equal(paused.scanActiveWorkers, paused.scanWorkerCount)
    assert.equal(paused.scanPeakWorkers, paused.scanWorkerCount)
    assert.equal(paused.scanWorkerPolicy, 'cpu-memory-bounded-v1')
    assert.ok(paused.scanQueuePending >= 0)
    assert.ok(paused.scanQueuePending <= paused.scanQueueCapacity)

    const clearWhileActive = addon.clearIndex()
    assert.equal(clearWhileActive.ok, false)
    assert.match(clearWhileActive.error, /stop the active scan/i)

    const firstStop = addon.stopScanAsync()
    const secondStop = addon.stopScanAsync()
    assert.equal(typeof firstStop?.then, 'function')
    assert.equal(typeof secondStop?.then, 'function')
    const [firstResult, secondResult] = await Promise.all([firstStop, secondStop])
    assert.equal(firstResult.ok, true)
    assert.equal(secondResult.ok, true)
    assert.equal(addon.getScanProgress().state, 'idle')
    assert.equal(addon.isScanPaused().paused, false)
    assert.equal(addon.resumeScan().ok, false)

    assert.equal(addon.scanDirectory(restart, 'full').ok, true)
    const detailed = await waitForScan()
    assert.equal(detailed.state, 'idle')
    assert.equal(detailed.detailedMetricsEnabled, true)
    assert.equal(detailed.queueSubmitCount, 1)
    assert.equal(detailed.readFileCount, 1)
    assert.ok(detailed.readBytes > 0)
    assert.ok(detailed.scanPeakQueuePending >= 1)
    assert.ok(detailed.scanWorkerMaxCompleted >= detailed.scanWorkerMinCompleted)
    assert.ok(detailed.scanWorkerMaxBusyMs >= detailed.scanWorkerMinBusyMs)
    assert.equal(addon.getIndexStats().indexedCount, 1)
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Start Scan reuses JPEG input bytes for a binary thumbnail sidecar', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-native-thumb-'))
  const source = path.join(root, 'source')
  const cache = path.join(root, 'cache')
  fs.mkdirSync(source)
  fs.mkdirSync(cache)
  const imagePath = path.join(source, 'sample.jpg')
  const pixels = Buffer.alloc(120 * 240 * 3)
  for (let y = 0; y < 240; y += 1) {
    for (let x = 0; x < 120; x += 1) {
      const offset = (y * 120 + x) * 3
      pixels[offset] = (x * 2 + y) % 256
      pixels[offset + 1] = (x + y * 3) % 256
      pixels[offset + 2] = (x * 5 + y * 7) % 256
    }
  }
  await sharp(pixels, { raw: { width: 120, height: 240, channels: 3 } })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 90 })
    .toFile(imagePath)

  try {
    addon.clearIndex()
    const configured = addon.configureScanThumbnails(cache, true, 6)
    assert.equal(configured.ok, true)
    assert.equal(configured.enabled, true)
    const expectedHash = addon.hashImage(imagePath)
    assert.equal(expectedHash.ok, true)
    assert.notEqual(expectedHash.dctHash64, '0000000000000000')
    assert.equal(addon.scanDirectory(source, 'full').ok, true)
    const progress = await waitForScan()
    assert.equal(progress.state, 'idle')
    assert.equal(progress.thumbnailQueued, 1)
    assert.equal(progress.thumbnailCompleted, 1)
    assert.equal(progress.thumbnailFailed, 0)
    assert.equal(progress.thumbnailDropped, 0)
    assert.equal(progress.thumbnailInputReused, 1)
    assert.equal(progress.thumbnailInputReusedBytes, fs.statSync(imagePath).size)
    assert.equal(progress.thumbnailInputFallback, 0)
    assert.equal(progress.thumbnailSourceReads, 0)
    assert.equal(progress.thumbnailRetainedInputBytes, 0)
    assert.equal(progress.thumbnailRetainedInputLimitBytes, 128 * 1024 * 1024)

    const stat = fs.statSync(imagePath)
    const cacheKey = crypto
      .createHash('sha256')
      .update(`v6|${imagePath}|${Math.floor(stat.mtimeMs / 1000) * 1000}|256`)
      .digest('hex')
      .slice(0, 24)
    const thumbnailPath = path.join(cache, `${cacheKey}.jpg`)
    assert.equal(fs.existsSync(thumbnailPath), true)
    const bytes = fs.readFileSync(thumbnailPath)
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8])
    assert.deepEqual([...bytes.subarray(bytes.length - 2)], [0xff, 0xd9])
    const thumbnailMetadata = await sharp(thumbnailPath).metadata()
    assert.equal(thumbnailMetadata.width, 240)
    assert.equal(thumbnailMetadata.height, 120)

    const withSidecar = addon
      .searchByImage(imagePath, 64, 10, 'balanced')
      .results.find((record) => record.path === imagePath)
    assert.ok(withSidecar)
    addon.clearIndex()
    addon.configureScanThumbnails(cache, false, 6)
    assert.equal(addon.scanDirectory(source, 'full').ok, true)
    assert.equal((await waitForScan()).state, 'idle')
    const withoutSidecar = addon
      .searchByImage(imagePath, 64, 10, 'balanced')
      .results.find((record) => record.path === imagePath)
    assert.ok(withoutSidecar)
    assert.equal(withSidecar.diffHash64, withoutSidecar.diffHash64)
    assert.equal(withSidecar.dctHash64, withoutSidecar.dctHash64)
  } finally {
    addon.stopScan()
    addon.configureScanThumbnails('', false, 6)
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('adaptive Native thumbnails defer queue pressure and fill every missing JPEG', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-native-thumb-fill-'))
  const source = path.join(root, 'source')
  const cache = path.join(root, 'cache')
  fs.mkdirSync(source)
  fs.mkdirSync(cache)
  const base = path.join(source, 'image-000.jpg')
  await createPatternJpeg(base)
  const imageCount = 64
  for (let index = 1; index < imageCount; index += 1) {
    fs.linkSync(base, path.join(source, `image-${String(index).padStart(3, '0')}.jpg`))
  }

  process.env.REASONIX_NATIVE_THUMB_SCAN_WORKERS = '1'
  process.env.REASONIX_NATIVE_THUMB_FILL_WORKERS = '4'
  process.env.REASONIX_NATIVE_THUMB_QUEUE_CAPACITY = '1'
  try {
    addon.clearIndex()
    addon.configureScanThumbnails(cache, true, 6)
    assert.equal(addon.scanDirectory(source, 'full').ok, true)
    const progress = await waitForScan()
    assert.equal(progress.state, 'idle')
    assert.equal(progress.thumbnailWorkerPolicy, 'index-priority-adaptive-fill-v1')
    assert.equal(progress.thumbnailWorkerOverride, true)
    assert.equal(progress.thumbnailScanWorkerCount, 1)
    assert.equal(progress.thumbnailFillWorkerCount, 4)
    assert.equal(progress.thumbnailQueueCapacity, 1)
    assert.ok(progress.thumbnailDeferred > 0, JSON.stringify(progress))
    assert.equal(progress.thumbnailFillCompleted, progress.thumbnailDeferred)
    assert.equal(progress.thumbnailFillFailed, 0)
    assert.equal(progress.thumbnailDropped, 0)
    assert.equal(progress.thumbnailCancelled, 0)
    assert.equal(progress.thumbnailQueued, imageCount)
    assert.equal(progress.thumbnailCompleted, imageCount)
    assert.equal(progress.thumbnailPending, 0)
    assert.equal(progress.thumbnailDeferredPending, 0)
    assert.equal(progress.thumbnailDeferredPathBytes, 0)
    assert.equal(progress.thumbnailDeferredEntryLimit, 65536)
    assert.equal(progress.thumbnailDeferredPathLimitBytes, 32 * 1024 * 1024)
    assert.equal(progress.thumbnailRetainedInputBytes, 0)
    assert.equal(progress.thumbnailInputReused, imageCount)
    assert.equal(progress.thumbnailSourceReads, 0)
    assert.equal(progress.thumbnailInputFallback, 0)
    assert.equal(progress.thumbnailPhase, 'idle')
    assert.equal(fs.readdirSync(cache).filter((name) => name.endsWith('.jpg')).length, imageCount)
  } finally {
    delete process.env.REASONIX_NATIVE_THUMB_SCAN_WORKERS
    delete process.env.REASONIX_NATIVE_THUMB_FILL_WORKERS
    delete process.env.REASONIX_NATIVE_THUMB_QUEUE_CAPACITY
    addon.stopScan()
    addon.configureScanThumbnails('', false, 6)
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('adaptive Native thumbnail shutdown clears deferred paths and retained JPEG input', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-native-thumb-stop-'))
  const source = path.join(root, 'source')
  const cache = path.join(root, 'cache')
  fs.mkdirSync(source)
  fs.mkdirSync(cache)
  const base = path.join(source, 'image-0000.jpg')
  await createPatternJpeg(base, 1200, 900)
  for (let index = 1; index < 256; index += 1) {
    fs.linkSync(base, path.join(source, `image-${String(index).padStart(4, '0')}.jpg`))
  }

  process.env.REASONIX_NATIVE_THUMB_SCAN_WORKERS = '1'
  process.env.REASONIX_NATIVE_THUMB_FILL_WORKERS = '1'
  process.env.REASONIX_NATIVE_THUMB_QUEUE_CAPACITY = '1'
  try {
    addon.clearIndex()
    addon.configureScanThumbnails(cache, true, 6)
    assert.equal(addon.scanDirectory(source, 'full').ok, true)
    const pressured = await waitForScanState(
      'scanning',
      (progress) => progress.thumbnailDeferred >= 8 && progress.thumbnailPending > 0,
    )
    assert.ok(pressured.thumbnailPending > 0)
    const stopped = await addon.stopScanAsync()
    assert.equal(stopped.ok, true)
    const progress = addon.getScanProgress()
    assert.equal(progress.state, 'idle')
    assert.ok(progress.thumbnailCancelled > 0, JSON.stringify(progress))
    assert.equal(progress.thumbnailPending, 0)
    assert.equal(progress.thumbnailDeferredPending, 0)
    assert.equal(progress.thumbnailDeferredPathBytes, 0)
    assert.equal(progress.thumbnailRetainedInputBytes, 0)
    assert.equal(progress.thumbnailPhase, 'idle')
  } finally {
    delete process.env.REASONIX_NATIVE_THUMB_SCAN_WORKERS
    delete process.env.REASONIX_NATIVE_THUMB_FILL_WORKERS
    delete process.env.REASONIX_NATIVE_THUMB_QUEUE_CAPACITY
    addon.stopScan()
    addon.configureScanThumbnails('', false, 6)
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('native C++ thumbnail rebuild streams JPEG and reports CUDA fallback honestly', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-native-rebuild-'))
  const source = path.join(root, 'source')
  const cache = path.join(root, 'cache')
  fs.mkdirSync(source)
  fs.mkdirSync(cache)
  const imagePath = path.join(source, 'orientation-6.jpg')
  await sharp({
    create: {
      width: 120,
      height: 240,
      channels: 3,
      background: { r: 210, g: 50, b: 30 },
    },
  })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 90 })
    .toFile(imagePath)

  try {
    assert.equal(addon.startNativeThumbnailRebuild(source, cache, 5, 4, false).ok, true)
    const nativeProgress = await waitForNativeThumbnailRebuild()
    assert.equal(nativeProgress.state, 'done', JSON.stringify(nativeProgress))
    assert.equal(nativeProgress.completed, 1)
    assert.equal(nativeProgress.failed, 0)
    assert.equal(nativeProgress.workers, 4)
    assert.equal(nativeProgress.effectiveBackend, 'native-cpp')

    const thumbnails = fs.readdirSync(cache)
    assert.equal(thumbnails.length, 1)
    const metadata = await sharp(path.join(cache, thumbnails[0])).metadata()
    assert.equal(metadata.width, 240)
    assert.equal(metadata.height, 120)

    assert.equal(addon.startNativeThumbnailRebuild(imagePath, cache, 5, 2, true).ok, true)
    const cudaProgress = await waitForNativeThumbnailRebuild()
    assert.equal(cudaProgress.state, 'done', JSON.stringify(cudaProgress))
    assert.equal(cudaProgress.cudaRequested, true)
    assert.equal(typeof cudaProgress.cudaAvailable, 'boolean')
    if (!cudaProgress.cudaAvailable) {
      assert.equal(cudaProgress.effectiveBackend, 'native-cpp')
      assert.match(cudaProgress.cudaError, /CUDA|nvJPEG/)
    }
  } finally {
    addon.stopNativeThumbnailRebuild()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('native thumbnail rebuild excludes its cache subtree and cannot ingest generated JPEGs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-no-thumb-recursion-'))
  const cache = path.join(root, 'thumbcache')
  fs.mkdirSync(cache)
  const sourcePath = path.join(root, 'source.jpg')
  const generatedPath = path.join(cache, 'already-generated.jpg')
  await sharp({
    create: { width: 320, height: 200, channels: 3, background: { r: 40, g: 90, b: 180 } },
  })
    .jpeg()
    .toFile(sourcePath)
  fs.copyFileSync(sourcePath, generatedPath)

  try {
    assert.equal(addon.startNativeThumbnailRebuild(root, cache, 5, 4, false).ok, true)
    const progress = await waitForNativeThumbnailRebuild()
    assert.equal(progress.state, 'done', JSON.stringify(progress))
    assert.equal(progress.total, 1, 'cache JPEG must not become another source')
    assert.equal(progress.completed, 1)
    assert.equal(progress.failed, 0)
    assert.ok(progress.skipped >= 1)
  } finally {
    addon.stopNativeThumbnailRebuild()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('bulk index prefix purge removes generated records without deleting source files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-index-prefix-purge-'))
  const generated = path.join(root, 'generated-thumbnails')
  fs.mkdirSync(generated)
  const keep = path.join(root, 'keep.png')
  const remove = path.join(generated, 'remove.png')
  createPng(keep)
  createPng(remove)

  try {
    addon.clearIndex()
    addon.configureScanThumbnails('', false, 6)
    assert.equal(addon.scanDirectory(root, 'full').ok, true)
    assert.equal((await waitForScan()).state, 'idle')
    assert.equal(addon.hasIndexPath(keep), true)
    assert.equal(addon.hasIndexPath(remove), true)
    const purged = addon.purgeIndexPathPrefix(generated)
    assert.equal(purged.ok, true)
    assert.equal(purged.removedCount, 1)
    assert.equal(addon.hasIndexPath(keep), true)
    assert.equal(addon.hasIndexPath(remove), false)
    assert.equal(fs.existsSync(remove), true, 'index cleanup must not delete cache files')
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('async manifest hydration excludes a generated subtree on the native worker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-load-exclusion-'))
  const source = path.join(root, 'source')
  const generated = path.join(source, 'generated-thumbnails')
  const indexRoot = path.join(root, 'index')
  fs.mkdirSync(generated, { recursive: true })
  fs.mkdirSync(indexRoot)
  const keep = path.join(source, 'keep.png')
  const remove = path.join(generated, 'remove.png')
  createPng(keep)
  createPng(remove)

  try {
    addon.clearIndex()
    addon.configureScanThumbnails('', false, 6)
    assert.equal(addon.scanDirectory(source, 'full').ok, true)
    assert.equal((await waitForScan()).state, 'idle')
    assert.equal((await addon.saveIndexToManifestAsync(indexRoot)).ok, true)

    addon.clearIndex()
    const loaded = await addon.loadManifestAsync(indexRoot, generated)
    assert.equal(loaded.ok, true)
    assert.equal(loaded.recordCount, 2)
    assert.equal(loaded.removedCount, 1)
    assert.equal(addon.hasIndexPath(keep), true)
    assert.equal(addon.hasIndexPath(remove), false)
    assert.equal(fs.existsSync(remove), true, 'worker exclusion must not delete source files')
  } finally {
    addon.stopScan()
    addon.clearIndex()
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // Windows may retain a retired mapping until the addon releases it.
    }
  }
})

test('purged paths stay out of the path index after manifest reload and rescan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-purge-reload-rescan-'))
  const source = path.join(root, 'source')
  const indexRoot = path.join(root, 'index')
  fs.mkdirSync(source)
  fs.mkdirSync(indexRoot)
  const first = path.join(source, 'first.png')
  const second = path.join(source, 'second.png')
  createPng(first)
  createPng(second)

  try {
    addon.clearIndex()
    addon.configureScanThumbnails('', false, 6)
    assert.equal(addon.scanDirectory(source, 'full').ok, true)
    assert.equal((await waitForScan()).state, 'idle')
    assert.equal(addon.hasIndexPath(first), true)
    assert.equal(addon.hasIndexPath(second), true)
    const saved = await addon.saveIndexToManifestAsync(indexRoot)
    assert.equal(saved.ok, true)

    const purged = addon.purgeIndexPathPrefix(source)
    assert.equal(purged.ok, true)
    assert.equal(purged.removedCount, 2)
    assert.equal(addon.hasIndexPath(first), false)
    const savedAfterPurge = await addon.saveIndexToManifestAsync(indexRoot)
    assert.equal(savedAfterPurge.ok, true)

    addon.clearIndex()
    const loaded = await addon.loadManifestAsync(indexRoot)
    assert.equal(loaded.ok, true)

    assert.equal(addon.scanDirectory(source, 'full').ok, true)
    const progress = await waitForScan()
    assert.equal(progress.state, 'idle')
    assert.equal(
      progress.skippedIndexed,
      0,
      'purged paths must not revive in pathIndexMap after manifest reload',
    )
    const records = addon.queryIndexRecords(source, 0, 20)
    assert.equal(records.ok, true)
    assert.equal(records.records.length, 2, 'rescan must re-index the purged source folder')
  } finally {
    addon.stopScan()
    addon.clearIndex()
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // async manifest save retains a retired segment mapping until process exit on Windows
    }
  }
})

test('manifest save after purge and full rescan retains prior segments and resurrected records', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-purge-save-retain-'))
  const keepDir = path.join(root, 'keep')
  const purgedDir = path.join(root, 'purged')
  const indexRoot = path.join(root, 'index')
  fs.mkdirSync(keepDir)
  fs.mkdirSync(purgedDir)
  fs.mkdirSync(indexRoot)
  const keep = path.join(keepDir, 'keep.png')
  const first = path.join(purgedDir, 'first.png')
  const second = path.join(purgedDir, 'second.png')
  createPng(keep)
  createPng(first)
  createPng(second)

  try {
    addon.clearIndex()
    addon.configureScanThumbnails('', false, 6)
    assert.equal(addon.scanDirectory(root, 'full').ok, true)
    assert.equal((await waitForScan()).state, 'idle')
    const saved = await addon.saveIndexToManifestAsync(indexRoot)
    assert.equal(saved.ok, true)

    addon.clearIndex()
    const loaded = await addon.loadManifestAsync(indexRoot)
    assert.equal(loaded.ok, true)
    assert.equal(loaded.recordCount, 3)

    const purged = addon.purgeIndexPathPrefix(purgedDir)
    assert.equal(purged.ok, true)
    assert.equal(purged.removedCount, 2)
    const savedAfterPurge = await addon.saveIndexToManifestAsync(indexRoot)
    assert.equal(savedAfterPurge.ok, true)

    const reloaded = await addon.loadManifestAsync(indexRoot)
    assert.equal(reloaded.ok, true)
    // Grow the purged files so the rescanned copies carry different metadata than the
    // stale copies still physically present in the original segment.
    for (const file of [first, second]) {
      const grown = Buffer.concat([fs.readFileSync(file), Buffer.alloc(64, 7)])
      fs.writeFileSync(file, grown)
    }
    assert.equal(addon.scanDirectory(purgedDir, 'full').ok, true)
    const progress = await waitForScan()
    assert.equal(progress.state, 'idle')
    assert.equal(progress.skippedIndexed, 0, 'purged folder must be rescanned after reload')
    const savedAfterRescan = await addon.saveIndexToManifestAsync(indexRoot)
    assert.equal(savedAfterRescan.ok, true)

    addon.clearIndex()
    const finalLoad = await addon.loadManifestAsync(indexRoot)
    assert.equal(finalLoad.ok, true)
    const keptRecords = addon.queryIndexRecords(keepDir, 0, 20)
    assert.equal(keptRecords.ok, true)
    assert.equal(
      keptRecords.records.length,
      1,
      'save must not drop the pre-existing segment records',
    )
    assert.equal(keptRecords.records[0].path, keep)
    const resurrected = addon.queryIndexRecords(purgedDir, 0, 20)
    assert.equal(resurrected.ok, true)
    assert.equal(
      resurrected.records.length,
      2,
      'rescanned records must stay queryable after save and reload',
    )
    const firstRecord = resurrected.records.find((record) => record.path === first)
    assert.ok(firstRecord, 'query must return the rescanned copy')
    assert.equal(
      firstRecord.fileSize,
      fs.statSync(first).size,
      'query must show the newest copy, not the stale segment copy',
    )
    assert.equal(addon.hasIndexPath(keep), true)
    assert.equal(addon.hasIndexPath(first), true)
    assert.equal(addon.hasIndexPath(second), true)
  } finally {
    addon.stopScan()
    addon.clearIndex()
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // async manifest save retains a retired segment mapping until process exit on Windows
    }
  }
})

test('data editor persists path repair, record update, and index-only delete', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-data-editor-'))
  const source = path.join(root, 'source')
  const indexRoot = path.join(root, 'index')
  fs.mkdirSync(source)
  const original = path.join(source, 'original.png')
  const removedFromIndex = path.join(source, 'keep-source.png')
  const moved = path.join(source, 'moved.png')
  const insertedAfterLoad = path.join(source, 'inserted-after-load.png')
  createPng(original)
  createPng(removedFromIndex)

  try {
    addon.clearIndex()
    assert.equal(addon.scanDirectory(source, 'full').ok, true)
    assert.equal((await waitForScan()).state, 'idle')
    assert.equal(addon.saveIndexToManifest(indexRoot).ok, true)

    fs.renameSync(original, moved)
    const repairedPath = addon.repairIndexPath(original, moved)
    assert.equal(repairedPath.ok, true, JSON.stringify(repairedPath))

    const hash = addon.hashImage(moved)
    const stat = fs.statSync(moved)
    assert.equal(hash.ok, true)
    assert.equal(
      addon.upsertIndexRecord(
        moved,
        hash.width,
        hash.height,
        hash.fileSize,
        stat.mtimeMs,
        hash.diffHash64,
        hash.dctHash64,
      ).ok,
      true,
    )
    assert.equal(addon.deleteIndexPath(removedFromIndex).ok, true)
    assert.equal(fs.existsSync(removedFromIndex), true, 'index delete must not delete source file')
    assert.equal(addon.saveIndexToManifest(indexRoot).ok, true)

    addon.clearIndex()
    assert.equal(addon.loadManifest(indexRoot).ok, true)
    createPng(insertedAfterLoad)
    const insertedHash = addon.hashImage(insertedAfterLoad)
    const insertedStat = fs.statSync(insertedAfterLoad)
    assert.equal(
      addon.upsertIndexRecord(
        insertedAfterLoad,
        insertedHash.width,
        insertedHash.height,
        insertedStat.size,
        insertedStat.mtimeMs,
        insertedHash.diffHash64,
        insertedHash.dctHash64,
      ).ok,
      true,
      'upsert must insert a new path while a segmented manifest is loaded',
    )
    assert.equal(addon.hasIndexPath(insertedAfterLoad), true)
    assert.equal(addon.saveIndexToManifest(indexRoot).ok, true)
    addon.clearIndex()
    assert.equal(addon.loadManifest(indexRoot).ok, true)
    assert.equal(addon.hasIndexPath(original), false)
    assert.equal(addon.hasIndexPath(removedFromIndex), false)
    assert.equal(addon.hasIndexPath(moved), true)
    assert.equal(addon.hasIndexPath(insertedAfterLoad), true)
    const replacementDiffHash = '0123456789abcdef'
    const replacementDctHash = 'fedcba9876543210'
    assert.equal(
      addon.upsertIndexRecord(
        insertedAfterLoad,
        insertedHash.width,
        insertedHash.height,
        insertedStat.size,
        insertedStat.mtimeMs,
        replacementDiffHash,
        replacementDctHash,
      ).ok,
      true,
    )
    assert.equal(addon.saveIndexToManifest(indexRoot).ok, true)
    addon.clearIndex()
    assert.equal(addon.loadManifest(indexRoot).ok, true)
    const replacementMatches = addon.searchByHash(replacementDiffHash, 0, 20, 'recall').results
    assert.equal(
      replacementMatches.some((result) => result.path === insertedAfterLoad),
      true,
      'the newest replacement segment must remain searchable',
    )
    const staleMatches = addon.searchByHash(insertedHash.diffHash64, 0, 20, 'recall').results
    assert.equal(
      staleMatches.some((result) => result.path === insertedAfterLoad),
      false,
      'older copies of a replaced path must stay hidden',
    )
    assert.equal(addon.queryIndexRecords(original, 0, 20).records.length, 0)
    assert.equal(addon.queryIndexRecords(removedFromIndex, 0, 20).records.length, 0)
    const repaired = addon.queryIndexRecords(moved, 0, 20)
    assert.equal(repaired.ok, true)
    assert.equal(repaired.records.length, 1)
    assert.equal(repaired.records[0].path, moved)
    assert.equal(repaired.records[0].exists, true)
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('searchByImageAsync returns hits in segment_mmap mode without an explicit topK', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-async-search-mmap-'))
  const source = path.join(root, 'source')
  const indexRoot = path.join(root, 'index')
  fs.mkdirSync(source)
  fs.mkdirSync(indexRoot)
  const queryPath = path.join(source, 'query.png')
  createPng(queryPath)
  createPng(path.join(source, 'other.png'))

  try {
    addon.clearIndex()
    addon.configureScanThumbnails('', false, 6)
    assert.equal(addon.scanDirectory(source, 'full').ok, true)
    assert.equal((await waitForScan()).state, 'idle')
    const saved = await addon.saveIndexToManifestAsync(indexRoot)
    assert.equal(saved.ok, true)
    addon.clearIndex()
    const loaded = await addon.loadManifestAsync(indexRoot)
    assert.equal(loaded.ok, true)
    assert.equal(addon.getIndexMode().mode, 'segment_mmap')

    // No topK argument: must fall back to the same default as the sync searchByImage
    // instead of searching with topK=0 (which crashed on an empty candidate heap).
    const hit = await addon.searchByImageAsync(queryPath, 5)
    assert.equal(hit.ok, true)
    assert.equal(hit.mode, 'segment_mmap')
    assert.ok(hit.resultCount >= 1, 'indexed query image must produce a hit')
    assert.ok(
      hit.results.some((result) => result.path === queryPath && result.distance === 0),
      'the query image itself must be the distance-0 hit',
    )
  } finally {
    addon.stopScan()
    addon.clearIndex()
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // async manifest save retains a retired segment mapping until process exit on Windows
    }
  }
})

test('addon context initializes and finalizes in a worker env without invalidating the main env', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-addon-context-'))
  try {
    createPng(path.join(root, 'retained.png'))
    addon.clearIndex()
    assert.equal(addon.scanDirectory(root, 'full').ok, true)
    await waitForScan()
    assert.equal(addon.getIndexStats().indexedCount, 1)
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads')
      const workerAddon = require(workerData.addonPath)
      void workerAddon.searchByImageAsync(workerData.imagePath, 30, 20, 'balanced').then((search) => {
        parentPort.postMessage({ status: workerAddon.getNativeStatus(), paused: workerAddon.isScanPaused(), search })
      })
    `
    let message
    await new Promise((resolve, reject) => {
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: { addonPath, imagePath: path.join(root, 'retained.png') },
      })
      worker.once('message', (value) => {
        message = value
      })
      worker.once('error', reject)
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`worker exited with code ${code}`))
        else resolve()
      })
    })
    assert.equal(message.status.addonContextMode, 'env-owned-scan-shared-index-owner')
    assert.equal(message.paused.paused, false)
    assert.equal(message.search.ok, true)
    assert.equal(message.search.resultCount, 1)
    assert.equal(addon.getNativeStatus().connected, true)
    assert.equal(addon.isScanPaused().paused, false)
    assert.equal(
      addon.getIndexStats().indexedCount,
      1,
      'worker finalization must retain the shared main-env index',
    )
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('getIndexPathStats aggregates count and bytes for the whole index and a folder prefix', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-path-stats-'))
  const folderA = path.join(root, 'folder-a')
  const folderB = path.join(root, 'folder-b')
  const indexRoot = path.join(root, 'index')
  fs.mkdirSync(folderA)
  fs.mkdirSync(folderB)
  const a1 = path.join(folderA, 'a1.png')
  const a2 = path.join(folderA, 'a2.png')
  const b1 = path.join(folderB, 'b1.png')
  createPng(a1)
  createPng(a2)
  createPng(b1)
  const sizeOf = (file) => fs.statSync(file).size
  const totalBytes = sizeOf(a1) + sizeOf(a2) + sizeOf(b1)
  const bytesA = sizeOf(a1) + sizeOf(a2)

  try {
    addon.clearIndex()
    addon.configureScanThumbnails('', false, 6)
    assert.equal(addon.scanDirectory(root, 'full').ok, true)
    assert.equal((await waitForScan()).state, 'idle')

    const whole = addon.getIndexPathStats('')
    assert.equal(whole.ok, true)
    assert.equal(whole.count, 3, 'empty prefix must cover the whole index')
    assert.equal(whole.totalBytes, totalBytes)

    const folderStats = addon.getIndexPathStats(folderA)
    assert.equal(folderStats.ok, true)
    assert.equal(folderStats.count, 2)
    assert.equal(folderStats.totalBytes, bytesA)
    const fileStats = addon.getIndexPathStats(b1)
    assert.equal(fileStats.count, 1, 'exact file path prefix must match the record itself')
    const sibling = addon.getIndexPathStats(folderA + '-sibling')
    assert.equal(sibling.count, 0, 'prefix must require a separator boundary')

    // 'C:\' normalizes to the 2-char drive root 'c:', which is too short to be a safe prefix.
    const unsafe = addon.getIndexPathStats('C:\\')
    assert.equal(unsafe.ok, false)
    assert.match(unsafe.error, /Unsafe index prefix/)

    fs.mkdirSync(indexRoot)
    const saved = await addon.saveIndexToManifestAsync(indexRoot)
    assert.equal(saved.ok, true)
    addon.clearIndex()
    const loaded = await addon.loadManifestAsync(indexRoot)
    assert.equal(loaded.ok, true)

    const fromSegments = addon.getIndexPathStats(folderA)
    assert.equal(fromSegments.ok, true)
    assert.equal(fromSegments.count, 2, 'segment-backed records must be counted after reload')
    assert.equal(fromSegments.totalBytes, bytesA)

    assert.equal(addon.deleteIndexPath(a2).ok, true)
    const afterDelete = addon.getIndexPathStats(folderA)
    assert.equal(afterDelete.count, 1, 'deleted records must leave the aggregate')
    assert.equal(afterDelete.totalBytes, bytesA - sizeOf(a2))
    const wholeAfterDelete = addon.getIndexPathStats('')
    assert.equal(wholeAfterDelete.count, 2)
    assert.equal(wholeAfterDelete.totalBytes, totalBytes - sizeOf(a2))
  } finally {
    addon.stopScan()
    addon.clearIndex()
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // async manifest save retains a retired segment mapping until process exit on Windows
    }
  }
})

test('getIndexPathSegmentStats and purgeIndexPathSegment match a directory name at any location', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-segment-stats-'))
  const parentA = path.join(root, 'a-parent')
  const parentB = path.join(root, 'b-parent')
  const dirA = path.join(parentA, 'rwtemp')
  const dirB = path.join(parentB, 'nested', 'rwtemp')
  const sibling = path.join(parentA, 'foobar')
  fs.mkdirSync(dirA, { recursive: true })
  fs.mkdirSync(dirB, { recursive: true })
  fs.mkdirSync(sibling, { recursive: true })
  const a = path.join(dirA, 'a.png')
  const b = path.join(dirB, 'b.png')
  const keepSibling = path.join(sibling, 'keep.png')
  const keepFile = path.join(parentA, 'rwtemp-note.png')
  createPng(a)
  createPng(b)
  createPng(keepSibling)
  createPng(keepFile)
  const sizeOf = (file) => fs.statSync(file).size
  const segmentBytes = sizeOf(a) + sizeOf(b)

  try {
    addon.clearIndex()
    addon.configureScanThumbnails('', false, 6)
    assert.equal(addon.scanDirectory(root, 'full').ok, true)
    assert.equal((await waitForScan()).state, 'idle')

    const stats = addon.getIndexPathSegmentStats('rwtemp')
    assert.equal(stats.ok, true)
    assert.equal(stats.count, 2, 'same-named directories under different parents must aggregate')
    assert.equal(stats.totalBytes, segmentBytes)
    // Case-insensitive and forward-slash tolerant input.
    assert.equal(addon.getIndexPathSegmentStats('RwTemp').count, 2)
    // 'foobar' must not match a 'foo' segment, and a file whose name merely
    // contains the word (rwtemp-note.png) must not match 'rwtemp' as a segment.
    assert.equal(addon.getIndexPathSegmentStats('foo').count, 0)
    assert.equal(addon.getIndexPathSegmentStats('rwtemp-note').count, 0)
    // Whole-index stats are unaffected by segment-name scoping.
    assert.equal(addon.getIndexPathStats('').count, 4)

    for (const bad of ['', 'x', 'two\\level', 'two/level']) {
      const rejected = addon.getIndexPathSegmentStats(bad)
      assert.equal(rejected.ok, false, `name '${bad}' must be rejected`)
      assert.match(rejected.error, /Invalid directory name/)
      assert.equal(addon.purgeIndexPathSegment(bad).ok, false, `purge '${bad}' must be rejected`)
    }

    const purged = addon.purgeIndexPathSegment('rwtemp')
    assert.equal(purged.ok, true)
    assert.equal(purged.removedCount, 2)
    assert.equal(addon.hasIndexPath(a), false)
    assert.equal(addon.hasIndexPath(b), false)
    assert.equal(addon.hasIndexPath(keepSibling), true, 'sibling directory must survive')
    assert.equal(addon.hasIndexPath(keepFile), true, 'file named like the segment must survive')
    assert.equal(fs.existsSync(a), true, 'purge never touches source files')
    const after = addon.getIndexPathSegmentStats('rwtemp')
    assert.equal(after.count, 0)
    assert.equal(after.totalBytes, 0)
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('asynchronous index exports are immutable, bounded, and explicitly released', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-paged-export-'))
  const cursors = new Set()
  try {
    addon.clearIndex()
    for (let i = 0; i < 701; i += 1) {
      assert.equal(
        addon.upsertIndexRecord(path.join(root, `${i}.png`), i, 2, 3, 4, '1', '2').ok,
        true,
      )
    }
    const store = path.join(root, 'index')
    assert.equal(addon.saveIndexToManifest(store).ok, true)
    assert.equal(addon.clearIndex().ok, true)
    assert.equal(addon.loadManifest(store).ok, true)
    assert.equal(addon.deleteIndexPath(path.join(root, '4.png')).ok, true)
    assert.equal(addon.upsertIndexRecord(path.join(root, '2.png'), 999, 2, 3, 4, '1', '2').ok, true)
    const expected = addon.snapshotIndexRecords()
    const pending = addon.snapshotIndexRecordsAsync()
    assert.equal(
      addon.clearIndex().ok,
      false,
      'the background reader holds the shared writer lease',
    )
    const snapshot = await pending
    cursors.add(snapshot.cursor)
    assert.equal(snapshot.recordCount, expected.recordCount)
    assert.equal(snapshot.scanned, expected.scanned)
    assert.equal(addon.clearIndex().ok, true, 'lease is released once the immutable view is ready')
    const empty = await addon.snapshotIndexRecordsAsync()
    cursors.add(empty.cursor)
    assert.equal(empty.recordCount, 0)
    await assert.rejects(addon.snapshotIndexRecordsAsync(), /limit 2/)
    const actual = []
    let offset = 0
    do {
      const page = addon.readIndexExportPage(snapshot.cursor, offset, 1000000)
      assert.equal(page.ok, true)
      assert.ok(page.records.length <= 256)
      assert.equal(page.nextOffset, offset + page.records.length)
      actual.push(...page.records)
      offset = page.nextOffset
      if (!page.hasMore) break
      await new Promise((resolve) => setImmediate(resolve))
    } while (offset < expected.recordCount)
    assert.deepEqual(
      actual,
      expected.records,
      'pages retain the original mmap/overlay view after the live index is cleared',
    )
    for (const bad of [-1, NaN, Infinity, 1.5, 1000001]) {
      assert.equal(addon.readIndexExportPage(snapshot.cursor, bad).ok, false)
    }
    assert.equal(addon.readIndexExportPage(snapshot.cursor, 0, 0).ok, false)
    assert.equal(addon.readIndexExportPage('unknown', 0).ok, false)
    assert.equal((await addon.closeIndexExport(snapshot.cursor)).ok, true)
    cursors.delete(snapshot.cursor)
    assert.equal(addon.readIndexExportPage(snapshot.cursor, 0).ok, false)
    await assert.rejects(addon.closeIndexExport(snapshot.cursor), /closed/)
    const reopened = await addon.snapshotIndexRecordsAsync()
    cursors.add(reopened.cursor)
    assert.equal(reopened.recordCount, 0)
  } finally {
    for (const cursor of cursors) await addon.closeIndexExport(cursor)
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('paged atomic deletion returns exact paths, preserves sources, and releases failed reservations', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-paged-delete-'))
  const inputs = Array.from({ length: 701 }, (_, i) => path.join(root, `${i}.png`))
  let cursor
  const oldFault = process.env.FLOATING_CLOCK_NATIVE_FAIL_BATCH_DELETE_BEFORE_COMMIT_TEST
  try {
    addon.clearIndex()
    for (const filePath of inputs)
      assert.equal(addon.upsertIndexRecord(filePath, 1, 2, 3, 4, '1', '2').ok, true)
    const keep = path.join(root, 'keep.png')
    assert.equal(addon.upsertIndexRecord(keep, 1, 2, 3, 4, '1', '2').ok, true)
    createPng(inputs[0])
    const original = fs.readFileSync(inputs[0])
    process.env.FLOATING_CLOCK_NATIVE_FAIL_BATCH_DELETE_BEFORE_COMMIT_TEST = '1'
    await assert.rejects(addon.deleteIndexPathsPagedAsync(inputs), /before commit/)
    assert.equal(addon.snapshotIndexRecords().recordCount, inputs.length + 1)
    delete process.env.FLOATING_CLOCK_NATIVE_FAIL_BATCH_DELETE_BEFORE_COMMIT_TEST
    const missing = path.join(root, 'missing.png')
    const result = await addon.deleteIndexPathsPagedAsync([...inputs, inputs[0], missing])
    cursor = result.cursor
    assert.equal(result.ok, true)
    assert.equal(result.removedCount, inputs.length)
    assert.equal(result.missingCount, 1)
    assert.equal(result.remainingCount, 1)
    assert.equal(
      Object.hasOwn(result, 'removedPaths'),
      false,
      'completion returns only summary and cursor',
    )
    const paths = []
    let offset = 0
    do {
      const page = addon.readIndexExportPage(cursor, offset)
      assert.equal(page.ok, true)
      assert.ok(page.removedPaths.length <= 256)
      paths.push(...page.removedPaths)
      offset = page.nextOffset
      if (!page.hasMore) break
      await new Promise((resolve) => setImmediate(resolve))
    } while (offset < result.removedCount)
    assert.deepEqual(paths, inputs)
    assert.deepEqual(fs.readFileSync(inputs[0]), original)
    assert.equal(addon.saveIndexToManifest(path.join(root, 'index')).ok, true)
    assert.equal(addon.clearIndex().ok, true)
    assert.equal(addon.loadManifest(path.join(root, 'index')).ok, true)
    assert.equal(addon.snapshotIndexRecords().recordCount, 1)
    await addon.closeIndexExport(cursor)
    cursor = undefined
    const first = await addon.snapshotIndexRecordsAsync()
    const second = await addon.snapshotIndexRecordsAsync()
    await addon.closeIndexExport(first.cursor)
    await addon.closeIndexExport(second.cursor)
  } finally {
    if (oldFault === undefined)
      delete process.env.FLOATING_CLOCK_NATIVE_FAIL_BATCH_DELETE_BEFORE_COMMIT_TEST
    else process.env.FLOATING_CLOCK_NATIVE_FAIL_BATCH_DELETE_BEFORE_COMMIT_TEST = oldFault
    if (cursor) await addon.closeIndexExport(cursor)
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('index export pages bound long path payload bytes as well as record counts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-export-byte-page-'))
  let cursor
  try {
    addon.clearIndex()
    for (let i = 0; i < 300; i += 1) {
      assert.equal(
        addon.upsertIndexRecord(
          path.join(root, `${i}-${'x'.repeat(3000)}.png`),
          1,
          2,
          3,
          4,
          '1',
          '2',
        ).ok,
        true,
      )
    }
    cursor = (await addon.snapshotIndexRecordsAsync()).cursor
    const page = addon.readIndexExportPage(cursor, 0)
    assert.equal(page.ok, true)
    assert.ok(page.records.length < 100)
    assert.ok(
      page.records.reduce((sum, record) => sum + Buffer.byteLength(record.path) + 128, 0) <=
        256 * 1024,
    )
    assert.equal(page.hasMore, true)
  } finally {
    if (cursor) await addon.closeIndexExport(cursor)
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an exhausted export quota rejects paged deletion before any commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-export-quota-'))
  const target = path.join(root, 'retained.png')
  const cursors = []
  try {
    addon.clearIndex()
    createPng(target)
    assert.equal(addon.upsertIndexRecord(target, 1, 2, 3, 4, '1', '2').ok, true)
    cursors.push((await addon.snapshotIndexRecordsAsync()).cursor)
    cursors.push((await addon.snapshotIndexRecordsAsync()).cursor)
    await assert.rejects(addon.deleteIndexPathsPagedAsync([target]), /limit 2/)
    assert.equal(addon.hasIndexPath(target), true)
    assert.equal(fs.existsSync(target), true)
    // Rejected deletion must release its writer lease as well as its allocation.
    assert.equal(addon.upsertIndexRecord(target, 9, 2, 3, 4, '1', '2').ok, true)
  } finally {
    for (const cursor of cursors) await addon.closeIndexExport(cursor)
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('worker teardown releases unconsumed exports without invalidating the main index', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-export-env-'))
  let worker
  try {
    addon.clearIndex()
    const target = path.join(root, 'retained.png')
    assert.equal(addon.upsertIndexRecord(target, 1, 2, 3, 4, '1', '2').ok, true)
    worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads')
      const addon = require(workerData)
      addon.snapshotIndexRecordsAsync().then((snapshot) => {
        parentPort.postMessage(snapshot.recordCount)
        setInterval(() => {}, 1000)
      })
    `,
      { eval: true, workerData: addonPath },
    )
    const count = await new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
    })
    assert.equal(count, 1)
    await worker.terminate()
    worker = undefined
    assert.equal(addon.hasIndexPath(target), true)
    const snapshot = await addon.snapshotIndexRecordsAsync()
    assert.equal(snapshot.recordCount, 1)
    await addon.closeIndexExport(snapshot.cursor)
  } finally {
    if (worker) await worker.terminate()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
