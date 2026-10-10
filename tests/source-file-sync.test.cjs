const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  completeSourceFileSyncAssetLibraryRecovery,
  executeSourceFileSync,
  getSourceFileSyncAssetLibraryRecovery,
  getSourceFileSyncMutationEpoch,
  getSourceFileSyncProgress,
  prepareSourceFileSyncAssetLibraryRecovery,
  previewSourceFileSync,
  recordSourceFileSyncAssetLibraryRecoveryFailure,
  retrySourceFileSyncAssetLibraryRecovery,
} = loadTsModule('electron/sourceFileSyncService.ts')
const mediaCache = loadTsModule('electron/mediaCacheService.ts')
const videoScan = loadTsModule('electron/videoScanService.ts')

function makeDependencies(records) {
  const calls = {
    deletedImages: [],
    missingVideos: [],
    thumbnails: [],
    assetSync: 0,
  }
  return {
    calls,
    dependencies: {
      listImageRecords: () => records.images,
      listVideoRecords: () => records.videos,
      deleteImageRecords: async (paths) => {
        calls.deletedImages.push(...paths)
        return {
          ok: true,
          removed: paths.length,
          vectorRecordsRemoved: paths.length * 2,
          warnings: [],
        }
      },
      markVideoRecordsMissing: async (videoIds) => {
        calls.missingVideos.push(...videoIds)
        return { removed: videoIds.length }
      },
      purgeImageThumbnails: async (images) => {
        calls.thumbnails.push(...images.map((record) => record.path))
        return { deletedFiles: images.length, freedBytes: images.length * 128, warnings: [] }
      },
      startAssetLibrarySync: () => {
        calls.assetSync += 1
        return { ok: true, taskId: 'asset-sync-1' }
      },
    },
  }
}

test('source sync previews exact missing records and rechecks before applying', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-file-sync-'))
  try {
    const source = path.join(root, 'source')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(source, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    const existingImage = path.join(source, 'existing.jpg')
    const recoveredImage = path.join(source, 'recovered.jpg')
    const missingImage = path.join(source, 'missing.jpg')
    const missingVideo = path.join(source, 'missing.mp4')
    fs.writeFileSync(existingImage, 'image')

    const fixture = makeDependencies({
      images: [
        { path: existingImage, fileSize: 5, modifiedTime: 1 },
        { path: recoveredImage, fileSize: 10, modifiedTime: 2 },
        { path: missingImage, fileSize: 20, modifiedTime: 3 },
        { path: path.join(outside, 'not-in-scope.jpg'), fileSize: 30, modifiedTime: 4 },
      ],
      videos: [
        { videoId: 'missing-video', path: missingVideo, sizeBytes: 40 },
        { videoId: 'old-tombstone', path: path.join(source, 'old.mp4'), missing: true },
      ],
    })

    const preview = await previewSourceFileSync({
      sourcePath: source,
      dependencies: fixture.dependencies,
    })
    assert.equal(preview.ok, true)
    assert.equal(preview.checkedImageRecords, 3)
    assert.equal(preview.checkedVideoRecords, 1)
    assert.equal(preview.missingImageRecords, 2)
    assert.equal(preview.missingVideoRecords, 1)
    assert.equal(preview.staleIndexedSourceBytes, 70)
    assert.equal(preview.originalFilesAffected, 0)

    fs.writeFileSync(recoveredImage, 'restored-before-confirmation')
    const mutationEpochBefore = getSourceFileSyncMutationEpoch()
    const firstExecution = executeSourceFileSync({
      token: preview.token,
      dependencies: fixture.dependencies,
    })
    const duplicateExecution = executeSourceFileSync({
      token: preview.token,
      dependencies: fixture.dependencies,
    })
    assert.equal(duplicateExecution, firstExecution)
    const [result, duplicateResult] = await Promise.all([firstExecution, duplicateExecution])
    assert.deepEqual(duplicateResult, result)
    assert.equal(result.ok, true)
    assert.equal(result.imageRecordsRemoved, 1)
    assert.equal(result.imageVectorRecordsRemoved, 2)
    assert.equal(result.videoRecordsMarkedMissing, 1)
    assert.equal(result.recoveredBeforeApply, 1)
    assert.equal(result.thumbnailFilesRemoved, 1)
    assert.equal(result.assetLibrarySyncStarted, true)
    assert.equal(result.assetLibraryTaskId, 'asset-sync-1')
    assert.equal(result.originalFilesAffected, 0)
    assert.deepEqual(fixture.calls.deletedImages, [missingImage])
    assert.deepEqual(fixture.calls.missingVideos, ['missing-video'])
    assert.deepEqual(fixture.calls.thumbnails, [missingImage])
    assert.equal(fixture.calls.assetSync, 1)
    assert.equal(getSourceFileSyncProgress().state, 'completed')
    assert.equal(getSourceFileSyncMutationEpoch(), mutationEpochBefore + 1)

    const replay = await executeSourceFileSync({
      token: preview.token,
      dependencies: fixture.dependencies,
    })
    assert.deepEqual(replay, result)
    assert.deepEqual(fixture.calls.deletedImages, [missingImage])
    assert.deepEqual(fixture.calls.missingVideos, ['missing-video'])
    assert.equal(fixture.calls.assetSync, 1)
    assert.equal(getSourceFileSyncMutationEpoch(), mutationEpochBefore + 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('source sync blocks an offline root without changing any records', async () => {
  const fixture = makeDependencies({
    images: [{ path: 'Z:\\offline\\image.jpg' }],
    videos: [{ videoId: 'offline', path: 'Z:\\offline\\video.mp4' }],
  })
  const preview = await previewSourceFileSync({
    sourcePath: path.join(os.tmpdir(), `missing-source-${process.pid}-${Date.now()}`),
    dependencies: fixture.dependencies,
  })
  assert.equal(preview.ok, false)
  assert.match(preview.error, /offline|no longer exists/)
  assert.deepEqual(fixture.calls.deletedImages, [])
  assert.deepEqual(fixture.calls.missingVideos, [])
})

test('source sync fails closed when the source disappears during the confirmation recheck', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-file-sync-offline-race-'))
  const source = path.join(root, 'source')
  const offline = path.join(root, 'source-offline')
  const restoredImage = path.join(source, 'restored.jpg')
  fs.mkdirSync(source)
  const fixture = makeDependencies({
    images: [{ path: restoredImage, fileSize: 10, modifiedTime: 1 }],
    videos: [],
  })
  const preview = await previewSourceFileSync({
    sourcePath: source,
    dependencies: fixture.dependencies,
  })
  assert.equal(preview.ok, true)
  assert.equal(preview.missingImageRecords, 1)
  fs.writeFileSync(restoredImage, 'restored-original')

  const originalRealpath = fs.promises.realpath.bind(fs.promises)
  let executeRealpathCalls = 0
  fs.promises.realpath = async (value) => {
    const resolved = await originalRealpath(value)
    executeRealpathCalls += 1
    if (executeRealpathCalls === 1) fs.renameSync(source, offline)
    return resolved
  }
  try {
    const result = await executeSourceFileSync({
      token: preview.token,
      dependencies: fixture.dependencies,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /offline|no longer exists|identity changed/i)
    assert.deepEqual(fixture.calls.deletedImages, [])
    assert.equal(fs.readFileSync(path.join(offline, 'restored.jpg'), 'utf8'), 'restored-original')
  } finally {
    fs.promises.realpath = originalRealpath
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('source sync reports a partial Native commit and completes asset-library compensation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-file-sync-partial-'))
  try {
    const missingImage = path.join(root, 'missing.jpg')
    let assetStarts = 0
    let assetWaits = 0
    let recoveryPrepared = 0
    let recoveryCompleted = 0
    const fixture = makeDependencies({
      images: [{ path: missingImage, fileSize: 10, modifiedTime: 1 }],
      videos: [],
    })
    fixture.dependencies.deleteImageRecords = async () => ({
      ok: false,
      removed: 1,
      vectorRecordsRemoved: 2,
      warnings: ['Native index commit completed'],
      error: 'post-persist vector invalidation failed',
    })
    fixture.dependencies.startAssetLibrarySync = () => {
      assetStarts += 1
      return { ok: true, taskId: 'asset-compensation-1' }
    }
    fixture.dependencies.waitForAssetLibrarySync = async (taskId) => {
      assetWaits += 1
      assert.equal(taskId, 'asset-compensation-1')
      return { ok: true }
    }
    fixture.dependencies.prepareAssetLibraryRecovery = async () => {
      recoveryPrepared += 1
    }
    fixture.dependencies.completeAssetLibraryRecovery = async () => {
      recoveryCompleted += 1
    }

    const preview = await previewSourceFileSync({
      sourcePath: root,
      dependencies: fixture.dependencies,
    })
    const result = await executeSourceFileSync({
      token: preview.token,
      dependencies: fixture.dependencies,
    })
    assert.equal(result.ok, false)
    assert.equal(result.partialCommit, true)
    assert.equal(result.imageRecordsRemoved, 1)
    assert.equal(result.imageVectorRecordsRemoved, 2)
    assert.equal(result.assetLibrarySyncStarted, true)
    assert.equal(result.assetLibrarySyncCompleted, true)
    assert.equal(result.assetLibraryTaskId, 'asset-compensation-1')
    assert.equal(assetStarts, 1)
    assert.equal(assetWaits, 1)
    assert.equal(recoveryPrepared, 1)
    assert.equal(recoveryCompleted, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('source sync reports catalog projection counts as a partial commit when Native deletion fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-file-sync-catalog-partial-'))
  try {
    const missingImage = path.join(root, 'missing.jpg')
    const missingVideo = path.join(root, 'missing.mp4')
    const events = []
    const fixture = makeDependencies({
      images: [{ path: missingImage, fileSize: 10, modifiedTime: 1 }],
      videos: [{ videoId: 'missing-video', path: missingVideo, sizeBytes: 20 }],
    })
    fixture.dependencies.markCatalogRecordsMissing = async (paths) => {
      events.push({ operation: 'catalog', paths: [...paths] })
      return { removed: paths.length }
    }
    fixture.dependencies.deleteImageRecords = async (paths) => {
      events.push({ operation: 'native', paths: [...paths] })
      return {
        ok: false,
        removed: 0,
        vectorRecordsRemoved: 0,
        warnings: [],
        error: 'Native index unavailable',
      }
    }

    const preview = await previewSourceFileSync({
      sourcePath: root,
      dependencies: fixture.dependencies,
    })
    const result = await executeSourceFileSync({
      token: preview.token,
      dependencies: fixture.dependencies,
    })

    assert.equal(result.ok, false)
    assert.equal(result.partialCommit, true)
    assert.equal(result.catalogRecordsMarkedMissing, 2)
    assert.equal(result.imageRecordsRemoved, 0)
    assert.equal(result.videoRecordsMarkedMissing, 0)
    assert.match(result.error, /Native index unavailable/)
    assert.deepEqual(events, [
      { operation: 'catalog', paths: [missingImage, missingVideo] },
      { operation: 'native', paths: [missingImage] },
    ])
    assert.equal(fixture.calls.assetSync, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('source sync reports a partial commit when Asset Library reconciliation fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-file-sync-asset-failure-'))
  try {
    const fixture = makeDependencies({
      images: [{ path: path.join(root, 'missing.jpg') }],
      videos: [],
    })
    fixture.dependencies.waitForAssetLibrarySync = async () => ({
      ok: false,
      error: 'asset database unavailable',
    })
    const recoveryFailures = []
    fixture.dependencies.prepareAssetLibraryRecovery = async () => undefined
    fixture.dependencies.recordAssetLibraryRecoveryFailure = async (error) => {
      recoveryFailures.push(error)
    }
    const preview = await previewSourceFileSync({
      sourcePath: root,
      dependencies: fixture.dependencies,
    })
    const result = await executeSourceFileSync({
      token: preview.token,
      dependencies: fixture.dependencies,
    })
    assert.equal(result.ok, false)
    assert.equal(result.partialCommit, true)
    assert.equal(result.imageRecordsRemoved, 1)
    assert.equal(result.assetLibrarySyncStarted, true)
    assert.equal(result.assetLibrarySyncCompleted, false)
    assert.match(result.error, /Asset Library reconciliation did not complete/)
    assert.match(result.warnings.join('\n'), /asset database unavailable/)
    assert.equal(recoveryFailures.length, 1)
    assert.match(recoveryFailures[0], /asset database unavailable/)
    assert.equal(getSourceFileSyncProgress().state, 'error')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Asset Library compensation marker survives restart, validates checksum, and clears on success', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-file-sync-asset-recovery-'))
  try {
    const sourcePath = path.join(root, 'source')
    fs.mkdirSync(sourcePath)
    const prepared = await prepareSourceFileSyncAssetLibraryRecovery(root, sourcePath)
    assert.equal(prepared.sourcePath, path.resolve(sourcePath))
    assert.equal(prepared.attempts, 0)

    const afterRestart = await getSourceFileSyncAssetLibraryRecovery(root)
    assert.deepEqual(afterRestart, prepared)
    const failed = await recordSourceFileSyncAssetLibraryRecoveryFailure(
      root,
      'asset fixture unavailable',
    )
    assert.equal(failed.attempts, 1)
    assert.equal(failed.lastError, 'asset fixture unavailable')

    assert.equal(await completeSourceFileSyncAssetLibraryRecovery(root), true)
    assert.equal(await getSourceFileSyncAssetLibraryRecovery(root), null)
    assert.equal(await completeSourceFileSyncAssetLibraryRecovery(root), false)

    await prepareSourceFileSyncAssetLibraryRecovery(root, sourcePath)
    const marker = path.join(root, 'asset-library', 'source-file-sync-recovery.json')
    const tampered = JSON.parse(fs.readFileSync(marker, 'utf8'))
    tampered.attempts += 1
    fs.writeFileSync(marker, JSON.stringify(tampered), 'utf8')
    await assert.rejects(getSourceFileSyncAssetLibraryRecovery(root), /checksum mismatch/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Asset Library startup recovery defers while busy and clears only after terminal success', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-file-sync-asset-retry-'))
  try {
    const sourcePath = path.join(root, 'source')
    fs.mkdirSync(sourcePath)
    await prepareSourceFileSyncAssetLibraryRecovery(root, sourcePath)

    let starts = 0
    let releases = 0
    const deferred = await retrySourceFileSyncAssetLibraryRecovery({
      userDataPath: root,
      getBusyReason: () => 'search is running',
      acquireMaintenance: () => {
        throw new Error('maintenance must not be acquired while busy')
      },
      startAssetLibrarySync: () => {
        starts += 1
        return { ok: true, taskId: 'unexpected' }
      },
      waitForAssetLibrarySync: async () => ({ ok: true }),
    })
    assert.deepEqual(deferred, { state: 'deferred', reason: 'search is running' })
    assert.equal(starts, 0)
    assert.equal((await getSourceFileSyncAssetLibraryRecovery(root)).attempts, 0)

    const completed = await retrySourceFileSyncAssetLibraryRecovery({
      userDataPath: root,
      getBusyReason: () => null,
      acquireMaintenance: () => () => {
        releases += 1
      },
      startAssetLibrarySync: () => {
        starts += 1
        return { ok: true, taskId: 'asset-recovery-1' }
      },
      waitForAssetLibrarySync: async (taskId) => {
        assert.equal(taskId, 'asset-recovery-1')
        return { ok: true }
      },
    })
    assert.deepEqual(completed, { state: 'completed' })
    assert.equal(starts, 1)
    assert.equal(releases, 1)
    assert.equal(await getSourceFileSyncAssetLibraryRecovery(root), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Asset Library startup recovery retains a failed marker and releases maintenance', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-file-sync-asset-retry-fail-'))
  try {
    const sourcePath = path.join(root, 'source')
    fs.mkdirSync(sourcePath)
    await prepareSourceFileSyncAssetLibraryRecovery(root, sourcePath)
    let releases = 0
    const failed = await retrySourceFileSyncAssetLibraryRecovery({
      userDataPath: root,
      getBusyReason: () => null,
      acquireMaintenance: () => () => {
        releases += 1
      },
      startAssetLibrarySync: () => ({ ok: true, taskId: 'asset-recovery-fail' }),
      waitForAssetLibrarySync: async () => ({ ok: false, error: 'database is locked' }),
    })
    assert.deepEqual(failed, { state: 'failed', reason: 'database is locked' })
    const marker = await getSourceFileSyncAssetLibraryRecovery(root)
    assert.equal(marker.attempts, 1)
    assert.equal(marker.lastError, 'database is locked')
    assert.equal(releases, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('source sync maintenance barrier failure is a zero-write outcome and does not advance epoch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-file-sync-barrier-'))
  try {
    const fixture = makeDependencies({
      images: [{ path: path.join(root, 'missing.jpg') }],
      videos: [],
    })
    fixture.dependencies.beginMaintenance = async () => {
      throw new Error('maintenance barrier unavailable')
    }
    const preview = await previewSourceFileSync({
      sourcePath: root,
      dependencies: fixture.dependencies,
    })
    const before = getSourceFileSyncMutationEpoch()
    const result = await executeSourceFileSync({
      token: preview.token,
      dependencies: fixture.dependencies,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /maintenance barrier unavailable/)
    assert.equal(getSourceFileSyncMutationEpoch(), before)
    assert.deepEqual(fixture.calls.deletedImages, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('source sync revalidates the root after an asynchronous maintenance barrier', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-file-sync-barrier-offline-'))
  const source = path.join(root, 'source')
  const offline = path.join(root, 'source-offline')
  fs.mkdirSync(source)
  const fixture = makeDependencies({
    images: [{ path: path.join(source, 'missing.jpg') }],
    videos: [],
  })
  try {
    const preview = await previewSourceFileSync({
      sourcePath: source,
      dependencies: fixture.dependencies,
    })
    const before = getSourceFileSyncMutationEpoch()
    fixture.dependencies.beginMaintenance = async () => {
      await Promise.resolve()
      fs.renameSync(source, offline)
    }
    const result = await executeSourceFileSync({
      token: preview.token,
      dependencies: fixture.dependencies,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /offline|no longer exists|identity changed/i)
    assert.equal(getSourceFileSyncMutationEpoch(), before)
    assert.deepEqual(fixture.calls.deletedImages, [])
    assert.deepEqual(fixture.calls.missingVideos, [])
    assert.equal(fixture.calls.assetSync, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('source sync revalidates the root after staging the durable mutation intent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-file-sync-intent-offline-'))
  const source = path.join(root, 'source')
  const offline = path.join(root, 'source-offline')
  fs.mkdirSync(source)
  const fixture = makeDependencies({
    images: [{ path: path.join(source, 'missing.jpg') }],
    videos: [],
  })
  try {
    const preview = await previewSourceFileSync({
      sourcePath: source,
      dependencies: fixture.dependencies,
    })
    const before = getSourceFileSyncMutationEpoch()
    fixture.dependencies.prepareMutation = async () => {
      await Promise.resolve()
      fs.renameSync(source, offline)
    }
    const result = await executeSourceFileSync({
      token: preview.token,
      dependencies: fixture.dependencies,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /offline|no longer exists|identity changed/i)
    assert.equal(getSourceFileSyncMutationEpoch(), before)
    assert.deepEqual(fixture.calls.deletedImages, [])
    assert.deepEqual(fixture.calls.missingVideos, [])
    assert.equal(fixture.calls.assetSync, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('source sync probe timeout preserves the record as inaccessible', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-file-sync-timeout-'))
  const stalledPath = path.join(root, 'stalled.jpg')
  const fixture = makeDependencies({ images: [{ path: stalledPath }], videos: [] })
  fixture.dependencies.probeTimeoutMs = 10
  const originalLstat = fs.promises.lstat.bind(fs.promises)
  fs.promises.lstat = (value) =>
    path.resolve(String(value)) === path.resolve(stalledPath)
      ? new Promise(() => {})
      : originalLstat(value)
  try {
    const preview = await previewSourceFileSync({
      sourcePath: root,
      dependencies: fixture.dependencies,
    })
    assert.equal(preview.ok, true)
    assert.equal(preview.missingImageRecords, 0)
    assert.equal(preview.inaccessibleRecords, 1)
  } finally {
    fs.promises.lstat = originalLstat
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('source sync retains only the newest large preview plan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-file-sync-plan-bound-'))
  try {
    const fixture = makeDependencies({
      images: [{ path: path.join(root, 'missing.jpg') }],
      videos: [],
    })
    const first = await previewSourceFileSync({
      sourcePath: root,
      dependencies: fixture.dependencies,
    })
    const second = await previewSourceFileSync({
      sourcePath: root,
      dependencies: fixture.dependencies,
    })
    const stale = await executeSourceFileSync({
      token: first.token,
      dependencies: fixture.dependencies,
    })
    assert.equal(stale.ok, false)
    assert.match(stale.error, /missing or expired/)
    const current = await executeSourceFileSync({
      token: second.token,
      dependencies: fixture.dependencies,
    })
    assert.equal(current.ok, true)
    assert.equal(current.imageRecordsRemoved, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('source sync UI and IPC keep repeated confirmation inside the idempotent path', () => {
  const ui = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'SourceDerivedDataCleanup.tsx'),
    'utf8',
  )
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'vectorIpc.ts'), 'utf8')
  const imageSearchIpc = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'imageSearchIpc.ts'),
    'utf8',
  )
  const imageSearch = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'imageSearchDataService.ts'),
    'utf8',
  )
  const frameSearch = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'videoFrameSearchService.ts'),
    'utf8',
  )
  const unifiedRuntime = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'unifiedSearchRuntime.ts'),
    'utf8',
  )
  const translations = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'core.ts'), 'utf8')
  assert.match(ui, /actionInFlightRef\.current/)
  assert.match(ui, /syncResult !== null/)
  assert.match(ui, /getTaskProgress\(taskId\)/)
  assert.match(ui, /onTaskProgress\(handleProgress\)/)
  assert.match(ui, /progress\.taskId !== taskId/)
  assert.match(ui, /progress\.state === 'done'/)
  assert.match(ui, /progress\.state === 'error'/)
  assert.match(ui, /progress\.state === 'stopped'/)
  assert.match(ui, /ASSET_LIBRARY_TASK_TIMEOUT_MS/)
  assert.match(ui, /assetTaskWaitAbortRef\.current\?\.abort\(\)/)
  assert.match(ui, /sourceSyncResult\s*\? \{ \.\.\.sourceSyncResult, ok: false, error: message \}/)
  assert.match(ipc, /ignoreSourceFileSync: true/)
  assert.match(imageSearch, /prepareSourceVectorInvalidationIntent/)
  assert.match(imageSearch, /reconcileSourceVectorInvalidationOutbox/)
  assert.match(imageSearch, /appendGlobalEmbeddingInvalidationTombstonesAsync/)
  assert.match(imageSearch, /source-vector invalidation remains queued/i)
  assert.match(ipc, /sourceVectorIntentPrepared: true/)
  assert.match(ipc, /vectorMaintenanceLease: sourceFileSyncMaintenanceLease \|\| undefined/)
  assert.match(ipc, /sourceFileSyncMaintenanceLease = releaseMaintenance/)
  assert.match(ipc, /prepareSourceFileSyncAssetLibraryRecovery\(userDataPath, sourcePath\)/)
  assert.match(ipc, /completeSourceFileSyncAssetLibraryRecovery\(userDataPath\)/)
  assert.match(ipc, /recordSourceFileSyncAssetLibraryRecoveryFailure\(userDataPath, error\)/)
  assert.match(ipc, /retrySourceFileSyncAssetLibraryRecovery/)
  assert.match(ipc, /ASSET_LIBRARY_RECOVERY_RETRY_DELAYS_MS/)
  assert.match(imageSearchIpc, /reconcileBeforeImageIndexSwitch/)
  assert.match(imageSearchIpc, /resolveImageSearchIndexIdentity\(rootDir\)/)
  assert.match(imageSearchIpc, /captureAndReconcileLoadedManifest/)
  assert.match(imageSearchIpc, /const repaired = repairManifest\(rootDir\)/)
  assert.match(imageSearchIpc, /const loaded = loadManifest\(rootDir\)/)
  assert.match(frameSearch, /!unavailableVideos\.has\(record\.videoId\)/)
  assert.ok(
    (unifiedRuntime.match(/if \(video\?\.missing\) return \[\]/g) || []).length >= 2,
    'unified visual and subtitle recall must reject missing videos',
  )
  assert.match(unifiedRuntime, /if \(!video \|\| video\.missing\) return \[\]/)
  assert.match(translations, /Source synchronization preview is missing or expired/)
})

test('video scan implementation fails closed before missing-record reconciliation', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'videoScanService.ts'),
    'utf8',
  )
  assert.match(source, /Video source is offline or unavailable/)
  assert.match(source, /enumerationFailed === 0/)
  assert.match(source, /if \(scanCompletedSafely\)/)
})

test('video reconciliation commits missing state only after a complete online scan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-source-sync-'))
  try {
    const mediaRoot = path.join(root, 'media')
    const source = path.join(root, 'source')
    const deletedVideo = path.join(source, 'deleted.mp4')
    fs.mkdirSync(path.join(mediaRoot, 'manifests'), { recursive: true })
    fs.mkdirSync(source, { recursive: true })
    mediaCache.setMediaSearchDirForTests(mediaRoot)
    fs.writeFileSync(
      path.join(mediaRoot, 'manifests', 'video_files.jsonl'),
      `${JSON.stringify({
        videoId: 'a'.repeat(40),
        path: deletedVideo,
        name: 'deleted.mp4',
        ext: '.mp4',
        sizeBytes: 100,
        mtimeMs: 1,
        discoveredAt: 1,
        updatedAt: 1,
        metadataStatus: 'done',
      })}\n`,
    )
    videoScan.invalidateVideoManifestCache()

    await videoScan.scanVideoFiles({ paths: [source], isCancelled: () => true })
    assert.equal(videoScan.loadVideoManifest()[0].missing, undefined)

    await videoScan.scanVideoFiles({ paths: [source] })
    assert.equal(videoScan.loadVideoManifest()[0].missing, true)

    const offline = path.join(root, 'offline')
    await assert.rejects(videoScan.scanVideoFiles({ paths: [offline] }), /offline or unavailable/)
  } finally {
    mediaCache.setMediaSearchDirForTests('')
    videoScan.invalidateVideoManifestCache()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
