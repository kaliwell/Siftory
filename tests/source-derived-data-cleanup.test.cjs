const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  executeSourceDerivedDataCleanup,
  previewSourceDerivedDataCleanup,
  getSourceDerivedDataCleanupProgress,
} = loadTsModule('electron/sourceDerivedDataCleanupService.ts')
const { resetImageSearchFolderDataEditForTests } = loadTsModule(
  'electron/imageSearchFolderDataService.ts',
)
const { cacheKey } = loadTsModule('electron/thumbnailDiskCache.ts')
const subjectStore = loadTsModule('electron/subjectEmbeddingStore.ts')

// Run the production IPC registration and image-data service without starting
// Electron, model workers, startup recovery, or touching an existing profile.
function sourcePreviewIpcFixture(t, nativeOverrides = {}) {
  const Module = require('node:module')
  const ts = require('typescript')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preview-ipc-'))
  const userData = path.join(root, 'user-data')
  const sourcePath = path.join(root, 'source')
  fs.mkdirSync(userData)
  fs.mkdirSync(sourcePath)
  const original = write(sourcePath, 'original.jpg', Buffer.from('untouched-original'))
  const handlers = new Map()
  const calls = { preview: 0, captures: 0, reads: 0, closes: 0, mutations: 0 }
  let hashDelegate
  const addon = {
    getIndexPathStats: () => ({ ok: true, count: 0, totalBytes: 0 }),
    getIndexMode: () => ({ recordCount: 0 }),
    snapshotIndexRecordsAsync: async () => ({ ok: true, cursor: 'fixture', recordCount: 0 }),
    readIndexExportPage: () => ({ ok: true, records: [], nextOffset: 0, hasMore: false }),
    closeIndexExport: async () => ({ ok: true }),
    deleteIndexPathsPagedAsync: () => {
      calls.mutations += 1
      assert.fail('preview must not mutate Native index')
    },
    ...nativeOverrides,
  }
  for (const [method, counter] of [
    ['snapshotIndexRecordsAsync', 'captures'],
    ['readIndexExportPage', 'reads'],
    ['closeIndexExport', 'closes'],
  ]) {
    const operation = addon[method]
    addon[method] = (...args) => {
      calls[counter] += 1
      return operation(...args)
    }
  }
  const { createImageSearchDataService } = loadTsModule('electron/imageSearchDataService.ts')
  const dataService = createImageSearchDataService({ getNativeAddon: () => addon })
  const cleanup = loadTsModule('electron/sourceDerivedDataCleanupService.ts')
  const sync = loadTsModule('electron/sourceFileSyncService.ts')
  const empty = () => undefined
  const mocks = {
    './ipcAuthorization': { secureIpcMain: { handle: (channel, fn) => handlers.set(channel, fn) } },
    './imageSearchService': {
      ...dataService,
      getImageIndexMode: addon.getIndexMode,
      getImageSearchStatus: () => ({ state: 'idle', indexedCount: 0 }),
      getImageSearchScopeState: () => 'valid',
    },
    './sourceDerivedDataCleanupService': {
      ...cleanup,
      previewSourceDerivedDataCleanup: async (options) => {
        calls.preview += 1
        return cleanup.previewSourceDerivedDataCleanup(options)
      },
    },
    './sourceFileSyncService': {
      ...sync,
      retrySourceFileSyncAssetLibraryRecovery: async () => ({ state: 'none' }),
    },
    './rerankService': { setHashDelegate: (delegate) => (hashDelegate = delegate) },
    './pathGuards': loadTsModule('electron/pathGuards.ts'),
    './mediaCacheService': { getMediaSearchDir: () => path.join(root, 'media') },
    './projectSearchIndexService': { getProjectSearchEntriesInFolder: () => [] },
    './videoScanService': { loadVideoManifest: () => [] },
    './modelService': { initModelService: empty, onModelStatusChanged: empty },
    './vectorDatabaseService': { initVectorDatabase: empty },
    './embeddingService': {
      getEmbeddingProgress: () => ({ state: 'idle' }),
      onEmbeddingProgress: empty,
    },
    './mediaTaskQueue': { getMediaSearchStatus: () => ({ state: 'idle' }) },
  }
  const file = path.resolve(__dirname, '../electron/vectorIpc.ts')
  const mod = new Module(file, module)
  mod.filename = file
  mod.paths = Module._nodeModulePaths(path.dirname(file))
  mod.require = (id) => {
    if (id.startsWith('../shared/')) return loadTsModule(`shared/${id.slice(10)}.ts`)
    if (id.startsWith('./')) {
      return new Proxy(mocks[id] || {}, {
        get(target, name) {
          if (name in target) return target[name]
          if (String(name).startsWith('is')) return () => false
          return () => assert.fail(`Unexpected IPC fixture dependency: ${id}.${String(name)}`)
        },
      })
    }
    if (id === 'electron') return {}
    return require(id)
  }
  mod._compile(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    file,
  )
  const timers = []
  const realSetTimeout = global.setTimeout
  try {
    global.setTimeout = (...args) => {
      const handle = realSetTimeout(...args)
      timers.push(handle)
      return handle
    }
    mod.exports.registerVectorIpc(() => null, userData)
  } finally {
    global.setTimeout = realSetTimeout
    // Startup recovery is outside this fixture's scope.
    for (const timer of timers) clearTimeout(timer)
  }
  t.after(() => {
    assert.equal(fs.readFileSync(original, 'utf8'), 'untouched-original')
    assert.equal(calls.mutations, 0)
    resetImageSearchFolderDataEditForTests()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    calls,
    dataService,
    hashDelegate: () => hashDelegate,
    preview: () => handlers.get('sourceDerivedData:preview')({}, { sourcePath }),
    syncPreview: () => handlers.get('sourceDerivedData:syncPreview')({}, { sourcePath }),
    sourcePath,
  }
}

for (const [name, native, expectedCloseCount] of [
  [
    'capture failure',
    { snapshotIndexRecordsAsync: async () => ({ ok: false, error: 'cursor quota reached' }) },
    0,
  ],
  [
    'capture rejection',
    {
      snapshotIndexRecordsAsync: async () => {
        throw new Error('capture rejected')
      },
    },
    0,
  ],
  [
    'page failure',
    {
      snapshotIndexRecordsAsync: async () => ({ ok: true, cursor: 'fixture', recordCount: 1 }),
      readIndexExportPage: () => ({ ok: false, error: 'snapshot page unreadable' }),
    },
    1,
  ],
  [
    'close rejection',
    {
      closeIndexExport: async () => {
        throw new Error('close rejected')
      },
    },
    1,
  ],
]) {
  test(`source preview IPC rejects ${name} without issuing a cleanup token`, async (t) => {
    const fixture = sourcePreviewIpcFixture(t, native)
    const result = await fixture.preview()
    assert.equal(result.ok, false)
    assert.equal(result.token, undefined)
    assert.match(
      result.error,
      /cursor quota reached|snapshot page unreadable|capture rejected|close rejected/,
    )
    assert.equal(fixture.calls.preview, 0)
    assert.equal(fixture.calls.closes, expectedCloseCount)
  })
}

test('source preview IPC rejects Native stats failure before exporting or issuing a token', async (t) => {
  const fixture = sourcePreviewIpcFixture(t, {
    getIndexPathStats: () => ({ ok: false, error: 'stats index unavailable' }),
  })
  const result = await fixture.preview()
  assert.equal(result.ok, false)
  assert.equal(result.token, undefined)
  assert.match(result.error, /stats index unavailable/)
  assert.equal(fixture.calls.captures, 0)
  assert.equal(fixture.calls.reads, 0)
  assert.equal(fixture.calls.preview, 0)
})

test('source preview IPC returns a structured failure when Native stats throws', async (t) => {
  const fixture = sourcePreviewIpcFixture(t, {
    getIndexPathStats: () => {
      throw new Error('stats read rejected')
    },
  })
  const result = await fixture.preview()
  assert.equal(result.ok, false)
  assert.equal(result.token, undefined)
  assert.match(result.error, /stats read rejected/)
  assert.equal(fixture.calls.captures, 0)
  assert.equal(fixture.calls.preview, 0)
})

test('source preview IPC preserves a successfully exported empty Native index', async (t) => {
  const fixture = sourcePreviewIpcFixture(t)
  const result = await fixture.preview()
  assert.equal(result.ok, true, result.error)
  assert.equal(typeof result.token, 'string')
  assert.equal(result.imageRecords, 0)
  assert.equal(fixture.calls.preview, 1)
  assert.equal(fixture.calls.closes, 1)
})

test('source synchronization IPC propagates export failure even when status count is zero', async (t) => {
  const fixture = sourcePreviewIpcFixture(t, {
    snapshotIndexRecordsAsync: async () => ({ ok: false, error: 'native scope unavailable' }),
  })
  const result = await fixture.syncPreview()
  assert.equal(result.ok, false)
  assert.equal(result.token, undefined)
  assert.match(result.error, /native scope unavailable/)
})

test('source synchronization IPC permits a successfully exported empty Native index', async (t) => {
  const fixture = sourcePreviewIpcFixture(t)
  const result = await fixture.syncPreview()
  assert.equal(result.ok, true, result.error)
  assert.equal(typeof result.token, 'string')
  assert.equal(result.checkedImageRecords, 0)
})

test('registered ANN scope delegate rejects snapshot failure instead of widening to an empty scope', async (t) => {
  const fixture = sourcePreviewIpcFixture(t, {
    snapshotIndexRecordsAsync: async () => ({ ok: false, error: 'native scope unavailable' }),
  })
  const { resolveVectorPathScopeKeys } = loadTsModule('electron/rerankService.ts')
  await assert.rejects(
    fixture.dataService.listImageSearchIndexedPaths(),
    /native scope unavailable/,
  )
  await assert.rejects(
    fixture.dataService.listImageSearchIndexedThumbnailSources(fixture.sourcePath),
    /native scope unavailable/,
  )
  await assert.rejects(
    resolveVectorPathScopeKeys({
      ...fixture.hashDelegate(),
      getIndexedCount: () => 1,
    }),
    /native scope unavailable/,
  )
  assert.equal(fixture.calls.preview, 0)
})

function write(root, relativePath, data) {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, data)
  return target
}

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
}

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function category(preview, id) {
  return preview.categories.find((item) => item.id === id)
}

test('later history failure preserves completed video cleanup counters and original files', async (t) => {
  resetImageSearchFolderDataEditForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-derived-partial-result-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const userData = path.join(root, 'user-data')
  const mediaRoot = path.join(root, 'media')
  const sourcePath = path.join(root, 'source')
  const videoPath = write(sourcePath, 'original.mp4', 'original must remain')
  const videoId = 'c'.repeat(40)
  const imagePath = write(mediaRoot, `frames/${videoId}/frame.jpg`, 'derived frame')
  const videoManifest = write(
    mediaRoot,
    'manifests/video_files.jsonl',
    jsonl([{ videoId, path: videoPath }]),
  )
  const frameManifest = write(
    mediaRoot,
    'manifests/video_frames.jsonl',
    jsonl([
      {
        frameId: 'd'.repeat(40),
        videoId,
        videoPath,
        imagePath,
        timestampMs: 1000,
        status: 'done',
      },
    ]),
  )
  const history = write(
    userData,
    'value-automation/vector-rebuild.stderr.log',
    `indexed ${videoPath}\n`,
  )
  const preview = await previewSourceDerivedDataCleanup({
    userDataPath: userData,
    mediaRoot,
    sourcePath,
    nativeStats: { count: 0, totalBytes: 0 },
    thumbnailSources: [],
    historyPolicy: 'remove-source-traces',
  })
  assert.equal(preview.ok, true, preview.error)
  fs.appendFileSync(history, 'concurrent history change\n')
  const historyBefore = fs.readFileSync(history, 'utf8')
  const result = await executeSourceDerivedDataCleanup({
    userDataPath: userData,
    token: preview.token,
  })
  assert.equal(result.ok, false)
  assert.equal(result.partialCommit, true)
  assert.match(result.error, /changed|stale/i)
  assert.equal(result.videoRecordsRemoved, 2)
  assert.equal(
    result.totalRecordsRemoved,
    result.imageRecordsRemoved +
      result.videoRecordsRemoved +
      result.automationHistoryRecordsRemoved,
  )
  assert.ok(result.deletedFiles >= 1)
  assert.ok(result.freedBytes >= Buffer.byteLength('derived frame'))
  assert.equal(result.automationHistoryRecordsRemoved, 0)
  assert.equal(result.originalFilesAffected, 0)
  assert.equal(fs.readFileSync(videoPath, 'utf8'), 'original must remain')
  assert.equal(fs.readFileSync(history, 'utf8'), historyBefore)
  assert.equal(fs.existsSync(imagePath), false)
  assert.deepEqual(readJsonl(videoManifest), [])
  assert.deepEqual(readJsonl(frameManifest), [])
  const progress = getSourceDerivedDataCleanupProgress()
  assert.equal(progress.state, 'error')
  assert.equal(progress.removedRecords, result.totalRecordsRemoved)
  assert.equal(progress.processedBytes, result.freedBytes)
})

test('failure before mutation reports zero changes and no partial completion', async (t) => {
  resetImageSearchFolderDataEditForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-derived-uncommitted-result-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sourcePath = path.join(root, 'source')
  const videoPath = write(sourcePath, 'original.mp4', 'original must remain')
  const mediaRoot = path.join(root, 'media')
  const manifest = write(
    mediaRoot,
    'manifests/video_files.jsonl',
    jsonl([{ videoId: 'e'.repeat(40), path: videoPath }]),
  )
  const userData = path.join(root, 'user-data')
  fs.mkdirSync(userData)
  const preview = await previewSourceDerivedDataCleanup({
    userDataPath: userData,
    mediaRoot,
    sourcePath,
    nativeStats: { count: 0, totalBytes: 0 },
    thumbnailSources: [],
  })
  assert.equal(preview.ok, true, preview.error)
  fs.appendFileSync(manifest, jsonl([{ videoId: 'f'.repeat(40), path: videoPath }]))
  const before = fs.readFileSync(manifest, 'utf8')
  const result = await executeSourceDerivedDataCleanup({
    userDataPath: userData,
    token: preview.token,
  })
  assert.equal(result.ok, false)
  assert.equal(result.partialCommit, false)
  assert.equal(result.totalRecordsRemoved, 0)
  assert.equal(result.deletedFiles, 0)
  assert.equal(result.freedBytes, 0)
  assert.equal(fs.readFileSync(manifest, 'utf8'), before)
  assert.equal(fs.readFileSync(videoPath, 'utf8'), 'original must remain')
})

test('source cleanup removes image and video derived data while preserving originals and other sources', async () => {
  resetImageSearchFolderDataEditForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-derived-cleanup-'))
  const userData = path.join(root, 'user-data')
  const mediaRoot = path.join(root, 'media-search')
  const selectedSource = path.join(root, 'source-a')
  const otherSource = path.join(root, 'source-b')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(selectedSource, { recursive: true })
  fs.mkdirSync(otherSource, { recursive: true })

  const selectedImage = write(selectedSource, 'image.jpg', Buffer.from('original-image'))
  const selectedVideo = write(selectedSource, 'video.mp4', Buffer.from('original-video'))
  const otherImage = write(otherSource, 'other.jpg', Buffer.from('other-image'))
  const otherVideo = write(otherSource, 'other.mp4', Buffer.from('other-video'))
  const selectedVideoId = 'a'.repeat(40)
  const otherVideoId = 'b'.repeat(40)
  const selectedFrame = write(
    mediaRoot,
    `frames/${selectedVideoId}/frame-a.jpg`,
    Buffer.from('selected-frame'),
  )
  const otherFrame = write(
    mediaRoot,
    `frames/${otherVideoId}/frame-b.jpg`,
    Buffer.from('other-frame'),
  )
  write(mediaRoot, `thumbnails/${selectedVideoId}/cover.jpg`, Buffer.from('selected-cover'))
  write(mediaRoot, `thumbnails/${otherVideoId}/cover.jpg`, Buffer.from('other-cover'))
  write(
    mediaRoot,
    'manifests/video_files.jsonl',
    jsonl([
      { videoId: selectedVideoId, path: selectedVideo },
      { videoId: otherVideoId, path: otherVideo },
    ]),
  )
  write(
    mediaRoot,
    'manifests/video_frames.jsonl',
    jsonl([
      {
        frameId: '1'.repeat(40),
        videoId: selectedVideoId,
        videoPath: selectedVideo,
        imagePath: selectedFrame,
        timestampMs: 1000,
        status: 'done',
      },
      {
        frameId: '2'.repeat(40),
        videoId: otherVideoId,
        videoPath: otherVideo,
        imagePath: otherFrame,
        timestampMs: 1000,
        status: 'done',
      },
    ]),
  )
  write(
    mediaRoot,
    `transcripts/asr-${selectedVideoId}.json`,
    JSON.stringify({ videoId: selectedVideoId, videoPath: selectedVideo, segments: [] }),
  )
  write(
    mediaRoot,
    `transcripts/asr-${otherVideoId}.json`,
    JSON.stringify({ videoId: otherVideoId, videoPath: otherVideo, segments: [] }),
  )
  const shard = write(
    userData,
    'vector-db/embeddings/clip_vit_base_patch32__global.jsonl',
    jsonl([
      { imageId: selectedImage, modelName: 'clip_vit_base_patch32', vector: [1] },
      { imageId: selectedFrame, modelName: 'clip_vit_base_patch32', vector: [2] },
      { imageId: otherImage, modelName: 'clip_vit_base_patch32', vector: [3] },
      { imageId: otherFrame, modelName: 'clip_vit_base_patch32', vector: [4] },
    ]),
  )
  write(userData, 'vector-db/vector-store/CURRENT', Buffer.from('shared-current'))
  write(
    userData,
    'vector-db/vector-store/generations/old/vectors.f16',
    Buffer.from('stale-selected-vector-copy'),
  )

  const preview = await previewSourceDerivedDataCleanup({
    userDataPath: userData,
    mediaRoot,
    sourcePath: selectedSource,
    nativeStats: { count: 1, totalBytes: fs.statSync(selectedImage).size },
    thumbnailSources: [],
  })
  assert.equal(preview.ok, true)
  assert.ok(preview.token)
  assert.equal(preview.originalFilesAffected, 0)
  assert.ok(preview.imageRecords >= 2)
  assert.ok(preview.videoRecords >= 2)

  const result = await executeSourceDerivedDataCleanup({
    userDataPath: userData,
    token: preview.token,
    hooks: {
      image: {
        deleteNative: async () => ({ ok: true, removedCount: 1 }),
        cleanupAuxiliary: async () => ({ removed: 0 }),
      },
      cleanupLegacyFrameVectors: async () => ({ removed: 0 }),
      cleanupImageArtifacts: async () => ({ deletedFiles: 0, freedBytes: 0 }),
    },
  })

  assert.equal(result.ok, true, result.error)
  assert.equal(result.originalFilesAffected, 0)
  assert.equal(fs.readFileSync(selectedImage, 'utf8'), 'original-image')
  assert.equal(fs.readFileSync(selectedVideo, 'utf8'), 'original-video')
  assert.equal(fs.readFileSync(otherImage, 'utf8'), 'other-image')
  assert.equal(fs.readFileSync(otherVideo, 'utf8'), 'other-video')

  assert.deepEqual(readJsonl(path.join(mediaRoot, 'manifests/video_files.jsonl')), [
    { videoId: otherVideoId, path: otherVideo },
  ])
  assert.equal(readJsonl(path.join(mediaRoot, 'manifests/video_frames.jsonl')).length, 1)
  assert.equal(fs.existsSync(path.join(mediaRoot, 'frames', selectedVideoId)), false)
  assert.equal(fs.existsSync(path.join(mediaRoot, 'thumbnails', selectedVideoId)), false)
  assert.equal(fs.existsSync(path.join(mediaRoot, 'frames', otherVideoId)), true)
  assert.equal(fs.existsSync(path.join(mediaRoot, 'thumbnails', otherVideoId)), true)
  assert.equal(
    fs.existsSync(path.join(mediaRoot, 'transcripts', `asr-${selectedVideoId}.json`)),
    false,
  )
  assert.equal(fs.existsSync(path.join(mediaRoot, 'transcripts', `asr-${otherVideoId}.json`)), true)

  const remainingVectors = readJsonl(shard).map((row) => row.imageId)
  assert.deepEqual(remainingVectors.sort(), [otherFrame, otherImage].sort())
  assert.deepEqual(
    fs.readdirSync(path.dirname(shard)).filter((name) => name.includes('source-cleanup-backup')),
    [],
  )
  assert.deepEqual(
    fs.readdirSync(path.dirname(shard)).filter((name) => name.includes('gc-backup')),
    [],
  )
  assert.equal(fs.existsSync(path.join(userData, 'vector-db', 'vector-store')), false)

  const replay = await executeSourceDerivedDataCleanup({
    userDataPath: userData,
    token: preview.token,
  })
  assert.equal(replay.ok, false)
  assert.match(replay.error, /missing or invalid/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('source cleanup IPC and settings UI expose a token-bound drive or folder flow', () => {
  const source = (relativePath) =>
    fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8')
  const contract = source('shared/ipc/source-derived-data.ts')
  const preload = source('electron/preload.ts')
  const ipc = source('electron/vectorIpc.ts')
  const cleanupService = source('electron/sourceDerivedDataCleanupService.ts')
  const folderEditor = source('electron/imageSearchFolderDataService.ts')
  const ui = source('src/components/SourceDerivedDataCleanup.tsx')
  assert.match(contract, /sourceDerivedData:preview/)
  assert.match(contract, /sourceDerivedData:execute/)
  assert.match(preload, /sourceDerivedData:\s*\{/)
  assert.match(ipc, /SOURCE_DERIVED_DATA_IPC\.PREVIEW/)
  assert.match(ipc, /SOURCE_DERIVED_DATA_IPC\.EXECUTE/)
  assert.match(ui, /mediaSearch\.listDrives\(\)/)
  assert.match(ui, /electronAPI\.browseFolder\(\)/)
  assert.match(ui, /preview\.token/)
  assert.match(ui, /originalFilesAffected: 0/)
  assert.match(cleanupService, /allowFilesystemRoot: true/)
  assert.match(folderEditor, /isFilesystemRootKey\(folderKey\) && !options\.allowFilesystemRoot/)
  assert.match(ipc, /compactAfterDelete: true/)
  assert.match(ipc, /invalidateEmbeddingLogRetentionCaches\(\)/)
  assert.match(cleanupService, /previewThumbnailCacheForFolder/)
  assert.match(contract, /remove-source-traces/)
  assert.match(ui, /removeManagedHistoryTraces/)
})

test('image-only source keeps unrelated shared video caches and reports zero video files', async (t) => {
  resetImageSearchFolderDataEditForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-derived-image-only-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const userData = path.join(root, 'user-data')
  const mediaRoot = path.join(root, 'media-search')
  const source = path.join(root, 'images')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(source, { recursive: true })

  const sharedFiles = [
    write(mediaRoot, 'vectors/frame_embedding_index.jsonl', jsonl([{ imageId: 'unrelated' }])),
    write(mediaRoot, 'vectors/frame_embedding_index.meta.json', '{}'),
    write(mediaRoot, 'stats/frame_embedding_stats.json', '{}'),
    write(mediaRoot, 'audio-semantic/transcript-stats.json', '{}'),
  ]

  const preview = await previewSourceDerivedDataCleanup({
    userDataPath: userData,
    mediaRoot,
    sourcePath: source,
    nativeStats: { count: 0, totalBytes: 0 },
    thumbnailSources: [],
  })
  assert.equal(preview.ok, true, preview.error)
  for (const id of [
    'video-catalog',
    'video-frames-thumbnails',
    'video-model-vectors',
    'video-transcripts-ocr',
    'video-semantics',
    'shared-rebuildable-caches',
  ]) {
    assert.equal(category(preview, id).recordCount, 0, id)
    assert.equal(category(preview, id).fileCount, 0, id)
  }

  const result = await executeSourceDerivedDataCleanup({
    userDataPath: userData,
    token: preview.token,
  })
  assert.equal(result.ok, true, result.error)
  for (const filePath of sharedFiles) assert.equal(fs.existsSync(filePath), true, filePath)
})

test('persisted Native overlay remains an executable maintenance target after logical count reaches zero', async (t) => {
  resetImageSearchFolderDataEditForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-derived-overlay-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const userData = path.join(root, 'user-data')
  const mediaRoot = path.join(root, 'media-search')
  const source = path.join(root, 'source')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(source, { recursive: true })
  const preview = await previewSourceDerivedDataCleanup({
    userDataPath: userData,
    mediaRoot,
    sourcePath: source,
    nativeStats: { count: 0, totalBytes: 0, deletedCount: 5, replacedCount: 2 },
    thumbnailSources: [],
  })
  assert.equal(preview.ok, true, preview.error)
  assert.equal(category(preview, 'image-native-index').recordCount, 0)
  assert.equal(category(preview, 'image-native-index').fileCount, 1)
  assert.match(preview.warnings.join('\n'), /7 persisted overlay entries/)
  let nativeCalls = 0
  const result = await executeSourceDerivedDataCleanup({
    userDataPath: userData,
    token: preview.token,
    hooks: {
      image: {
        deleteNative: async () => {
          nativeCalls += 1
          return { ok: true, removedCount: 0 }
        },
      },
    },
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(nativeCalls, 1)
})

test('image cache invalidation is included in preview and actual released bytes', async (t) => {
  resetImageSearchFolderDataEditForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-derived-image-cache-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const userData = path.join(root, 'user-data')
  const mediaRoot = path.join(root, 'media-search')
  const selectedSource = path.join(root, 'selected')
  const otherSource = path.join(root, 'other')
  const selectedImage = write(selectedSource, 'selected.jpg', 'selected')
  const otherImage = write(otherSource, 'other.jpg', 'other')
  write(
    userData,
    'vector-db/embeddings/clip_vit_base_patch32__global.jsonl',
    jsonl([
      { imageId: selectedImage, modelName: 'clip_vit_base_patch32', vector: [1] },
      { imageId: otherImage, modelName: 'clip_vit_base_patch32', vector: [2] },
    ]),
  )
  const caches = [
    write(userData, 'vector-db/embedding-cache/clip_vit_base_patch32__global.f16.bin', '12345'),
    write(userData, 'vector-db/embedding-cache/clip_vit_base_patch32__global.f16.json', '123'),
    write(userData, 'vector-db/vector_index_manifest.json', '12'),
    write(userData, 'vector-db/clip_embedding_cache.f32', '1234'),
  ]
  const cacheBytes = caches.reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0)

  const preview = await previewSourceDerivedDataCleanup({
    userDataPath: userData,
    mediaRoot,
    sourcePath: selectedSource,
    nativeStats: { count: 0, totalBytes: 0 },
    thumbnailSources: [],
  })
  assert.equal(preview.ok, true, preview.error)
  assert.equal(category(preview, 'shared-rebuildable-caches').fileCount, caches.length)
  assert.equal(category(preview, 'shared-rebuildable-caches').estimatedBytes, cacheBytes)

  const result = await executeSourceDerivedDataCleanup({
    userDataPath: userData,
    token: preview.token,
  })
  assert.equal(result.ok, true, result.error)
  assert.ok(result.deletedFiles >= caches.length)
  assert.ok(result.freedBytes >= cacheBytes)
  for (const filePath of caches) assert.equal(fs.existsSync(filePath), false, filePath)
})

test('source cleanup removes scoped embedding logs and rejection cache entries only', async (t) => {
  resetImageSearchFolderDataEditForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-derived-logs-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const userData = path.join(root, 'user-data')
  const mediaRoot = path.join(root, 'media-search')
  const selectedSource = path.join(root, 'selected')
  const otherSource = path.join(root, 'other')
  fs.mkdirSync(selectedSource, { recursive: true })
  fs.mkdirSync(otherSource, { recursive: true })
  const selectedImage = write(selectedSource, 'bad.jpg', 'selected')
  const otherImage = write(otherSource, 'bad.jpg', 'other')
  const failures = write(
    userData,
    'vector-db/embedding_failures.jsonl',
    jsonl([
      { time: new Date().toISOString(), imageId: selectedImage, modelName: 'clip', error: 'bad' },
      { time: new Date().toISOString(), imageId: otherImage, modelName: 'clip', error: 'bad' },
    ]),
  )
  const diagnostics = write(
    userData,
    'vector-db/embedding_diagnostics.jsonl',
    jsonl([
      { time: new Date().toISOString(), imageId: selectedImage, stage: 'decode' },
      { time: new Date().toISOString(), imageId: otherImage, stage: 'decode' },
    ]),
  )
  const diagnosticBackup = write(
    userData,
    'vector-db/embedding_diagnostics.jsonl.1.bak',
    jsonl([
      { time: new Date().toISOString(), imageId: selectedImage, stage: 'decode' },
      { time: new Date().toISOString(), imageId: otherImage, stage: 'decode' },
    ]),
  )
  const rejectionCache = write(
    userData,
    'vector-db/embedding-input-rejections.json',
    JSON.stringify({
      version: 1,
      entries: {
        [selectedImage.toLowerCase()]: { size: 8, mtimeMs: 1, updatedAt: 1 },
        [otherImage.toLowerCase()]: { size: 5, mtimeMs: 1, updatedAt: 1 },
      },
    }),
  )

  const preview = await previewSourceDerivedDataCleanup({
    userDataPath: userData,
    mediaRoot,
    sourcePath: selectedSource,
    nativeStats: { count: 0, totalBytes: 0 },
    thumbnailSources: [],
  })
  assert.equal(preview.ok, true, preview.error)
  assert.equal(category(preview, 'image-diagnostics').recordCount, 4)
  assert.equal(category(preview, 'image-diagnostics').fileCount, 4)
  assert.equal(preview.imageRecords, 4)
  assert.equal(preview.videoRecords, 0)
  assert.equal(preview.totalRecords, 4)

  const result = await executeSourceDerivedDataCleanup({
    userDataPath: userData,
    token: preview.token,
  })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(
    readJsonl(failures).map((row) => row.imageId),
    [otherImage],
  )
  assert.deepEqual(
    readJsonl(diagnostics).map((row) => row.imageId),
    [otherImage],
  )
  assert.deepEqual(
    readJsonl(diagnosticBackup).map((row) => row.imageId),
    [otherImage],
  )
  const remainingRejections = JSON.parse(fs.readFileSync(rejectionCache, 'utf8')).entries
  assert.deepEqual(Object.keys(remainingRejections), [otherImage.toLowerCase()])
  assert.ok(result.imageRecordsRemoved >= 4)
})

test('source cleanup discovers orphan thumbnails that are absent from the Native snapshot', async (t) => {
  resetImageSearchFolderDataEditForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-derived-thumbnails-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const userData = path.join(root, 'user-data')
  const mediaRoot = path.join(root, 'media-search')
  const selectedSource = path.join(root, 'selected')
  const otherSource = path.join(root, 'other')
  const selectedImage = write(selectedSource, 'not-indexed.jpg', 'selected')
  const otherImage = write(otherSource, 'other.jpg', 'other')
  const selectedStat = fs.statSync(selectedImage)
  const otherStat = fs.statSync(otherImage)
  const selectedThumbnail = write(
    userData,
    `thumbcache/${cacheKey(selectedImage, selectedStat.mtimeMs, 64)}.jpg`,
    'selected-thumbnail',
  )
  const otherThumbnail = write(
    userData,
    `thumbcache/${cacheKey(otherImage, otherStat.mtimeMs, 64)}.jpg`,
    'other-thumbnail',
  )

  const preview = await previewSourceDerivedDataCleanup({
    userDataPath: userData,
    mediaRoot,
    sourcePath: selectedSource,
    nativeStats: { count: 0, totalBytes: 0 },
    thumbnailSources: [],
  })
  assert.equal(preview.ok, true, preview.error)
  assert.equal(category(preview, 'image-thumbnails-previews').fileCount, 1)
  assert.equal(category(preview, 'image-thumbnails-previews').estimatedBytes, 18)

  const result = await executeSourceDerivedDataCleanup({
    userDataPath: userData,
    token: preview.token,
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(fs.existsSync(selectedThumbnail), false)
  assert.equal(fs.existsSync(otherThumbnail), true)
  assert.equal(result.deletedFiles, 1)
})

test('source cleanup atomically removes crop, face, osnet and negative subject vectors and invalidates memory', async (t) => {
  resetImageSearchFolderDataEditForTests()
  subjectStore.resetSubjectEmbeddingStoreForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-derived-subject-vectors-'))
  t.after(() => {
    subjectStore.resetSubjectEmbeddingStoreForTests()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const userData = path.join(root, 'user-data')
  const mediaRoot = path.join(root, 'media-search')
  const selectedSource = path.join(root, 'selected')
  const otherSource = path.join(root, 'other')
  const selectedImage = write(selectedSource, 'selected.jpg', 'selected')
  const otherImage = write(otherSource, 'other.jpg', 'other')
  const selectedKeys = [
    subjectStore.subjectEmbeddingKey('crop:subject', selectedImage, 1),
    subjectStore.subjectEmbeddingKey('face:model-a', selectedImage, 2),
    subjectStore.subjectEmbeddingKey('osnet:model-b', selectedImage, 3),
    subjectStore.subjectEmbeddingKey('face:model-a', selectedImage, 4),
  ]
  const otherKey = subjectStore.subjectEmbeddingKey('crop:subject', otherImage, 1)
  const subjectFile = write(
    userData,
    'subject-embeddings/embeddings.jsonl',
    jsonl([
      { key: selectedKeys[0], vector: [0.1, 0.2], createdAt: 1 },
      { key: selectedKeys[1], vector: [0.3, 0.4], createdAt: 2 },
      { key: selectedKeys[2], vector: [0.5, 0.6], createdAt: 3 },
      { key: selectedKeys[3], vector: [], createdAt: 4 },
      { key: otherKey, vector: [0.7, 0.8], createdAt: 5 },
    ]),
  )

  subjectStore.putSubjectEmbedding(selectedKeys[0], [0.1, 0.2])
  subjectStore.putSubjectEmbedding(otherKey, [0.7, 0.8])
  assert.deepEqual(subjectStore.getSubjectEmbedding(selectedKeys[0]), [0.1, 0.2])

  const preview = await previewSourceDerivedDataCleanup({
    userDataPath: userData,
    mediaRoot,
    sourcePath: selectedSource,
    nativeStats: { count: 0, totalBytes: 0 },
    thumbnailSources: [],
  })
  assert.equal(preview.ok, true, preview.error)
  assert.equal(category(preview, 'image-subject-vectors').recordCount, 4)
  assert.equal(category(preview, 'image-subject-vectors').fileCount, 1)

  const result = await executeSourceDerivedDataCleanup({
    userDataPath: userData,
    token: preview.token,
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.imageRecordsRemoved, 4)
  assert.deepEqual(
    readJsonl(subjectFile).map((row) => row.key),
    [otherKey],
  )
  assert.equal(subjectStore.getSubjectEmbedding(selectedKeys[0]), null)
  assert.deepEqual(subjectStore.getSubjectEmbedding(otherKey), [0.7, 0.8])
  assert.deepEqual(
    fs.readdirSync(path.dirname(subjectFile)).filter((name) => name.includes('source-cleanup')),
    [],
  )
})

test('managed automation traces are preserved by default and explicitly removed only from the whitelist', async (t) => {
  resetImageSearchFolderDataEditForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-derived-managed-history-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const userData = path.join(root, 'user-data')
  const mediaRoot = path.join(root, 'media-search')
  const selectedSource = path.join(root, 'selected')
  const otherSource = path.join(root, 'other')
  fs.mkdirSync(selectedSource, { recursive: true })
  fs.mkdirSync(otherSource, { recursive: true })
  const stateFile = write(
    userData,
    'value-automation/vector-rebuild-state.json',
    `${JSON.stringify(
      {
        schemaVersion: 1,
        scanPaths: [selectedSource, otherSource],
        phase: 'completed',
      },
      null,
      2,
    )}\n`,
  )
  const temporaryState = write(
    userData,
    'value-automation/vector-rebuild-state.json.123.tmp',
    `${JSON.stringify({ currentPath: path.join(selectedSource, 'image.jpg') }, null, 2)}\n`,
  )
  const managedLog = write(
    userData,
    'value-automation/vector-rebuild.stderr.log',
    `indexed ${path.join(selectedSource, 'a.jpg')}\nindexed ${path.join(otherSource, 'b.jpg')}\n`,
  )
  const ordinaryLog = write(
    userData,
    'value-automation/application-debug.log',
    `ordinary ${path.join(selectedSource, 'must-remain.jpg')}\n`,
  )
  const preservedBodies = new Map(
    [stateFile, temporaryState, managedLog, ordinaryLog].map((filePath) => [
      filePath,
      fs.readFileSync(filePath, 'utf8'),
    ]),
  )

  const preservePreview = await previewSourceDerivedDataCleanup({
    userDataPath: userData,
    mediaRoot,
    sourcePath: selectedSource,
    nativeStats: { count: 0, totalBytes: 0 },
    thumbnailSources: [],
  })
  assert.equal(preservePreview.ok, true, preservePreview.error)
  assert.equal(preservePreview.historyPolicy, 'preserve-audit')
  assert.equal(preservePreview.preservedAuditTraceRecords, 3)
  assert.equal(preservePreview.preservedAuditTraceFiles, 3)
  assert.equal(category(preservePreview, 'managed-automation-history').recordCount, 0)
  const preserveResult = await executeSourceDerivedDataCleanup({
    userDataPath: userData,
    token: preservePreview.token,
  })
  assert.equal(preserveResult.ok, true, preserveResult.error)
  assert.equal(preserveResult.automationHistoryRecordsRemoved, 0)
  for (const [filePath, body] of preservedBodies) {
    assert.equal(fs.readFileSync(filePath, 'utf8'), body, filePath)
  }

  const removePreview = await previewSourceDerivedDataCleanup({
    userDataPath: userData,
    mediaRoot,
    sourcePath: selectedSource,
    nativeStats: { count: 0, totalBytes: 0 },
    thumbnailSources: [],
    historyPolicy: 'remove-source-traces',
  })
  assert.equal(removePreview.ok, true, removePreview.error)
  assert.equal(category(removePreview, 'managed-automation-history').recordCount, 3)
  assert.equal(category(removePreview, 'managed-automation-history').fileCount, 3)
  const removeResult = await executeSourceDerivedDataCleanup({
    userDataPath: userData,
    token: removePreview.token,
  })
  assert.equal(removeResult.ok, true, removeResult.error)
  assert.equal(removeResult.automationHistoryRecordsRemoved, 3)
  const redactedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(redactedState.scanPaths.includes(selectedSource), false)
  assert.equal(redactedState.scanPaths.includes(otherSource), true)
  const redactedTemporaryState = JSON.parse(fs.readFileSync(temporaryState, 'utf8'))
  assert.equal(redactedTemporaryState.currentPath, '[source path removed]')
  assert.equal(
    fs.readFileSync(managedLog, 'utf8').toLowerCase().includes(selectedSource.toLowerCase()),
    false,
  )
  assert.equal(
    fs.readFileSync(managedLog, 'utf8').toLowerCase().includes(otherSource.toLowerCase()),
    true,
  )
  assert.equal(fs.readFileSync(ordinaryLog, 'utf8'), preservedBodies.get(ordinaryLog))
  assert.deepEqual(
    fs
      .readdirSync(path.join(userData, 'value-automation'))
      .filter((name) => name.includes('source-cleanup')),
    [],
  )
})
