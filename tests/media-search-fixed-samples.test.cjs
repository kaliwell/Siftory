const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')
const ts = require('typescript')
const vm = require('node:vm')
const { MediaSearchRequestState } = loadTsModule('src/services/mediaSearchRequestState.ts')

function compileSourceCallback(sourceFile, expression, bindings) {
  return vm.runInNewContext(
    ts.transpileModule(`(${expression.getText(sourceFile)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText,
    bindings,
  )
}

function mediaQueryUiFixture() {
  const filename = path.resolve(__dirname, '../src/components/MediaSearchPanel.tsx')
  const source = ts.createSourceFile(
    filename,
    fs.readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const functions = new Map()
  let browseEffect
  let progressCallback
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(source) === 'useCallback'
    ) {
      functions.set(node.name.getText(source), node.initializer.arguments[0])
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'useEffect' &&
      node.arguments[0]?.getText(source).includes("frameDisplayMode !== 'browse'")
    ) {
      browseEffect = node.arguments[0]
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'mediaSearchBridge.onSearchProgress'
    ) {
      progressCallback = node.arguments[0]
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const pending = new Map()
  let listCalls = 0
  const state = { frames: [{ frameId: 'old' }], message: '', progress: null, frameTotal: 1 }
  const bindings = {
    requestState: new MediaSearchRequestState(),
    queryImagePath: '',
    textQuery: 'query',
    searchModel: 'dinov2_vitb14',
    searchBackend: 'cpu',
    searchTopK: 50,
    selectedPaths: ['C:\\selected'],
    frameEmbeddingStats: {},
    sortMode: 'score',
    frameDisplayMode: 'browse',
    viewMode: 'frames',
    status: { state: 'idle' },
    frames: state.frames,
    performance,
    logMediaSearchPerf: () => {},
    t: (text) => text,
    announceFirstSearchCompleted: () => {},
    refreshManagedModels: async () => ({ dinov2_vitb14: {}, clip_vit_base_patch32: {} }),
    isManagedSearchModelReady: () => true,
    setFrameDisplayMode: (mode) => {
      bindings.frameDisplayMode = mode
    },
    setFrames: (frames) => {
      state.frames = frames
      bindings.frames = frames
    },
    setFrameTotal: (count) => {
      state.frameTotal = count
    },
    setViewMode: (mode) => {
      bindings.viewMode = mode
    },
    setMessage: (message) => {
      state.message = message
    },
    setSearchProgress: (value) => {
      state.progress = value
    },
    setStatus: () => {},
    setCacheStats: () => {},
    setVideos: () => {},
    setVideoTotal: () => {},
    setFrameEmbeddingStats: () => {},
    mediaSearchBridge: {
      searchFramesByImage: (request) =>
        new Promise((resolve, reject) =>
          pending.set(request.imagePath, { resolve, reject, request }),
        ),
      getStatus: async () => ({ state: 'idle' }),
      getCacheStats: async () => null,
      listVideos: async () => null,
      getFrameEmbeddingStats: async () => null,
      listFrames: async () => {
        listCalls += 1
        return { frames: [{ frameId: 'library' }], total: 1 }
      },
    },
  }
  for (const name of ['runFrameQuery', 'beginBrowsing', 'refresh', 'searchFramesByImage']) {
    assert.ok(functions.has(name), name)
    bindings[name] = compileSourceCallback(source, functions.get(name), bindings)
  }
  assert.ok(browseEffect)
  assert.ok(progressCallback)
  return {
    bindings,
    pending,
    state,
    listCalls: () => listCalls,
    browse: () => compileSourceCallback(source, browseEffect, bindings)(),
    progress: (value) => compileSourceCallback(source, progressCallback, bindings)(value),
  }
}

const flushMediaCallbacks = () => new Promise((resolve) => setImmediate(resolve))

test('media UI ignores late search responses, stale errors, and old progress generations', async () => {
  const fixture = mediaQueryUiFixture()
  const { bindings, pending, state } = fixture
  const old = bindings.searchFramesByImage('old.png')
  await flushMediaCallbacks()
  const current = bindings.searchFramesByImage('new.png')
  await flushMediaCallbacks()
  assert.equal(bindings.requestState.isCurrent(pending.get('old.png').request.requestId), false)
  assert.equal(bindings.requestState.isCurrent(pending.get('new.png').request.requestId), true)
  fixture.progress({ taskId: pending.get('old.png').request.requestId, percentage: 90 })
  assert.equal(state.progress, null)
  fixture.progress({ taskId: pending.get('new.png').request.requestId, percentage: 20 })
  assert.equal(state.progress.percentage, 20)
  pending.get('new.png').resolve({ ok: true, results: [{ frameId: 'new-result' }] })
  await current
  const currentMessage = state.message
  pending.get('old.png').resolve({ ok: true, results: [{ frameId: 'old-result' }] })
  await old
  assert.equal(state.frames[0].frameId, 'new-result')
  assert.equal(state.message, currentMessage)

  const failing = bindings.searchFramesByImage('failing.png')
  await flushMediaCallbacks()
  const next = bindings.searchFramesByImage('next.png')
  await flushMediaCallbacks()
  state.progress = 'current progress'
  pending.get('failing.png').reject(new Error('stale failure'))
  await failing
  assert.equal(state.message, currentMessage)
  assert.equal(state.progress, 'current progress')
  pending.get('next.png').resolve({ ok: false, results: [], error: 'current failure' })
  await next
  assert.equal(state.message, 'current failure')
  assert.equal(state.progress, null)
})

test('media UI keeps zero search hits empty until the user returns to browsing', async () => {
  const fixture = mediaQueryUiFixture()
  const query = fixture.bindings.searchFramesByImage('empty.png')
  await flushMediaCallbacks()
  fixture.pending.get('empty.png').resolve({ ok: true, results: [] })
  await query
  fixture.browse()
  await flushMediaCallbacks()
  assert.equal(fixture.state.frames.length, 0)
  assert.equal(fixture.state.frameTotal, 0)
  assert.equal(fixture.listCalls(), 0)
  fixture.bindings.beginBrowsing()
  fixture.browse()
  await flushMediaCallbacks()
  assert.equal(fixture.listCalls(), 1)
  assert.equal(fixture.state.frames[0].frameId, 'library')
})

test('a delayed library refresh cannot overwrite a new query or a newer browse revision', async () => {
  const fixture = mediaQueryUiFixture()
  let resolveList
  fixture.bindings.mediaSearchBridge.listFrames = () =>
    new Promise((resolve) => {
      resolveList = resolve
    })
  const refresh = fixture.bindings.refresh()
  const query = fixture.bindings.searchFramesByImage('new.png')
  await flushMediaCallbacks()
  fixture.pending.get('new.png').resolve({ ok: true, results: [{ frameId: 'new-result' }] })
  await query
  resolveList({ frames: [{ frameId: 'old-library' }], total: 1 })
  await refresh
  assert.equal(fixture.state.frames[0].frameId, 'new-result')

  const state = fixture.bindings.requestState
  state.beginBrowse()
  const previous = state.browseRevision()
  state.beginBrowse()
  assert.equal(state.acceptsBrowse(previous), false)
})

test('unmount and explicit browsing invalidate an in-flight media query', async () => {
  for (const cancel of ['dispose', 'beginBrowse']) {
    const fixture = mediaQueryUiFixture()
    const query = fixture.bindings.searchFramesByImage('pending.png')
    await flushMediaCallbacks()
    fixture.bindings.requestState[cancel]()
    fixture.pending.get('pending.png').resolve({ ok: true, results: [{ frameId: 'late' }] })
    await query
    assert.equal(fixture.state.frames[0].frameId, 'old')
    assert.equal(fixture.state.message, '')
    fixture.bindings.requestState.activate()
    assert.equal(
      fixture.bindings.requestState.isCurrent(fixture.pending.get('pending.png').request.requestId),
      false,
    )
  }
})

function multimodalIpcFixture() {
  const filename = path.resolve(__dirname, '../electron/mediaSearchIpc.ts')
  const source = ts.createSourceFile(
    filename,
    fs.readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  let callback
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'secureIpcMain.handle' &&
      node.arguments[0]?.text === 'mediaSearch:searchMultimodal'
    )
      callback = node.arguments[1]
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(callback)
  const scope = path.join(os.tmpdir(), 'selected')
  const insidePath = path.join(scope, 'a.mp4')
  const outsidePath = path.join(os.tmpdir(), 'outside', 'b.mp4')
  const available = new Set(['a', 'b'])
  const text = [
    { videoId: 'b', videoPath: outsidePath, timestampMs: 1000, score: 100, text: 'query' },
    { videoId: 'a', videoPath: insidePath, timestampMs: 1000, score: 1, text: 'query' },
  ]
  let filteredBeforeTopK = false
  const bindings = {
    isSourceFileSyncRunning: () => false,
    SOURCE_FILE_SYNC_BUSY_MESSAGE: 'busy',
    getSourceFileSyncMutationEpoch: () => 0,
    activeMediaSearches: 0,
    tryAcquireVectorSearchReservation: () => () => {},
    safeShellPath: (value) => value,
    normalizeMediaSearchScopePaths: (paths) => paths || [],
    availableMediaVideoIds: () => available,
    isMediaSearchPathInScope: loadTsModule('electron/mediaSearchScope.ts').isMediaSearchPathInScope,
    isMediaSearchQueryImagePath: () => true,
    fs: { existsSync: () => true },
    searchTranscripts: (_query, topK, options) => {
      assert.equal(typeof options.acceptVideo, 'function')
      filteredBeforeTopK =
        !options.acceptVideo('b', outsidePath) && options.acceptVideo('a', insidePath)
      return text.filter((item) => options.acceptVideo(item.videoId, item.videoPath)).slice(0, topK)
    },
    searchVideoFramesByImage: async () => ({ ok: true, results: [] }),
    searchSimilarVideoFrames: async (request) => {
      assert.deepEqual(request.scanPaths, [scope])
      return { ok: true, results: [] }
    },
    fuseMultimodalResults: loadTsModule('electron/transcriptService.ts').fuseMultimodalResults,
  }
  return {
    invoke: compileSourceCallback(source, callback, bindings),
    bindings,
    scope,
    insidePath,
    outsidePath,
    filteredBeforeTopK: () => filteredBeforeTopK,
  }
}

test('multimodal IPC restricts transcript recall before topK and both reference modes preserve scope', async () => {
  const fixture = multimodalIpcFixture()
  for (const reference of [{ imagePath: 'query.png' }, { frameId: 'a'.repeat(40) }]) {
    const result = await fixture.invoke(
      {},
      { ...reference, textQuery: 'query', scanPaths: [fixture.scope], topK: 1 },
    )
    assert.equal(result.ok, true)
    assert.equal(fixture.filteredBeforeTopK(), true)
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].videoPath, fixture.insidePath)
  }
  assert.equal(fixture.bindings.activeMediaSearches, 0)
})

test('multimodal IPC rejects failed visual recall and cannot silently replace it with text-only success', async () => {
  const fixture = multimodalIpcFixture()
  fixture.bindings.searchVideoFramesByImage = async () => ({
    ok: false,
    results: [],
    error: 'binary protocol failed',
  })
  const result = await fixture.invoke(
    {},
    { imagePath: 'query.png', textQuery: 'query', scanPaths: [fixture.scope] },
  )
  assert.equal(result.ok, false)
  assert.equal(result.error, 'binary protocol failed')
  assert.equal(result.results.length, 0)
  assert.equal(fixture.bindings.activeMediaSearches, 0)
})

test('multimodal final scope check rejects unexpected provider paths and unavailable selected roots', async () => {
  const fixture = multimodalIpcFixture()
  fixture.bindings.searchVideoFramesByImage = async () => ({
    ok: true,
    results: [
      {
        frameId: 'outside',
        videoId: 'b',
        videoPath: fixture.outsidePath,
        timestampMs: 0,
        vectorScore: 1,
      },
    ],
  })
  const result = await fixture.invoke(
    {},
    { imagePath: 'query.png', textQuery: 'query', scanPaths: [fixture.scope] },
  )
  assert.equal(result.ok, true)
  assert.ok(result.results.every((item) => item.videoPath === fixture.insidePath))
  fixture.bindings.normalizeMediaSearchScopePaths = () => []
  const missing = await fixture.invoke(
    {},
    { imagePath: 'query.png', textQuery: 'query', scanPaths: [fixture.scope] },
  )
  assert.equal(missing.ok, false)
  assert.match(missing.error, /sources are unavailable/)
})

const { ensureMediaSearchDirs, setMediaSearchDirForTests } = loadTsModule(
  'electron/mediaCacheService.ts',
)
const { initVectorDatabase } = loadTsModule('electron/vectorDatabaseService.ts')
const {
  findReadyVideoFrameById,
  loadAvailableVideoFrameManifest,
  loadReadyVideoFrameManifest,
  loadVideoFrameManifestPreview,
  searchSimilarVideoFrames,
} = loadTsModule('electron/videoFrameService.ts')
const { buildFrameIndex, ensureFrameIndexFreshAsync, loadFrameIndexAsync } = loadTsModule(
  'electron/mediaSearchFrameIndex.ts',
)
const { pruneTopKCandidates } = loadTsModule('electron/mediaSearchTopK.ts')
const { cosineScore, normalizeFrameVector, normalizedCosineScore } = loadTsModule(
  'electron/mediaSearchVectorMath.ts',
)
const {
  searchVideoFramesByImage,
  searchVideoFramesByText,
  setMediaSearchEmbeddingProvidersForTests,
} = loadTsModule('electron/videoFrameSearchService.ts')

function unitVector(first, second = 0) {
  const vector = Array(512).fill(0)
  vector[0] = first
  vector[1] = second
  const norm = Math.sqrt(first * first + second * second) || 1
  vector[0] /= norm
  vector[1] /= norm
  return vector
}

function writeJsonLines(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

function appendJsonLine(filePath, row) {
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`)
}

function assertSearchTimings(result) {
  assert.ok(result.timings)
  for (const key of ['manifestMs', 'indexMs', 'embeddingMs', 'scoringMs', 'totalMs']) {
    assert.equal(typeof result.timings[key], 'number')
    assert.ok(result.timings[key] >= 0)
  }
  assert.ok(result.timings.totalMs >= result.timings.scoringMs)
}

function initFixedMediaSearchFixture(root) {
  const mediaDir = path.join(root, 'media-search')
  const userDataDir = path.join(root, 'user-data')
  setMediaSearchDirForTests(mediaDir)
  initVectorDatabase(userDataDir)
  ensureMediaSearchDirs()
  return { mediaDir, userDataDir }
}

test('media search candidate pruning keeps highest scores with bounded memory', () => {
  const candidates = []
  for (let score = 0; score < 1500; score++) {
    candidates.push({ id: score, score })
    pruneTopKCandidates(candidates, 10, (candidate) => candidate.score)
  }

  assert.ok(candidates.length < 1000)
  candidates.sort((a, b) => b.score - a.score)
  assert.deepEqual(
    candidates.slice(0, 10).map((candidate) => candidate.score),
    [1499, 1498, 1497, 1496, 1495, 1494, 1493, 1492, 1491, 1490],
  )
})

test('normalized frame dot score matches cosine score for fixed vectors', () => {
  const first = Array.from({ length: 512 }, (_, index) => ((index * 17) % 31) - 15)
  const second = Array.from({ length: 512 }, (_, index) => ((index * 11) % 29) - 14)
  const normalizedFirst = normalizeFrameVector(first, 512)
  const normalizedSecond = normalizeFrameVector(second, 512)
  assert.ok(normalizedFirst)
  assert.ok(normalizedSecond)
  assert.ok(
    Math.abs(
      cosineScore(first, second) - normalizedCosineScore(normalizedFirst, normalizedSecond),
    ) < 1e-12,
  )
  assert.equal(normalizeFrameVector(Array(512).fill(0), 512), null)
})

test('media frame vectors reject coercion, non-finite values, wrong dimensions, and zero norms', () => {
  const valid = unitVector(1, 1)
  const invalidCases = [
    null,
    '1,2,3',
    [...valid.slice(0, 511)],
    [...valid, 0],
    Array(512).fill(0),
    Object.assign([...valid], { 2: NaN }),
    Object.assign([...valid], { 2: Infinity }),
    Object.assign([...valid], { 2: -Infinity }),
  ]
  for (const value of invalidCases) assert.equal(normalizeFrameVector(value, 512), null)

  const huge = Array(512).fill(0)
  huge[0] = 1e308
  huge[1] = -1e308
  const tiny = Array(512).fill(0)
  tiny[0] = Number.MIN_VALUE
  tiny[1] = -Number.MIN_VALUE
  for (const value of [huge, tiny, new Float32Array(valid)]) {
    const normalized = normalizeFrameVector(value, 512)
    assert.ok(normalized)
    assert.ok(normalized.every(Number.isFinite))
    assert.ok(Math.abs(Math.hypot(...normalized) - 1) < 1e-12)
  }

  assert.ok(Math.abs(cosineScore(huge, huge) - 1) < 1e-12)
  assert.equal(cosineScore(Object.assign([...valid], { 0: NaN }), valid), -Infinity)
  assert.equal(normalizedCosineScore(Object.assign([...valid], { 0: Infinity }), valid), -Infinity)
})

function writeFrameSearchFixture(root, mediaDir, userDataDir) {
  const scopeA = path.join(root, 'library-a')
  const scopeAPrefixSibling = path.join(root, 'library-a-copy')
  const scopeB = path.join(root, 'library-b')
  const emptyScope = path.join(root, 'empty-library')
  fs.mkdirSync(scopeA, { recursive: true })
  fs.mkdirSync(scopeAPrefixSibling, { recursive: true })
  fs.mkdirSync(scopeB, { recursive: true })
  fs.mkdirSync(emptyScope, { recursive: true })

  const videoA = path.join(scopeA, 'fixture-a.mp4')
  const videoAPrefixSibling = path.join(scopeAPrefixSibling, 'fixture-a-copy.mp4')
  const videoB = path.join(scopeB, 'fixture-b.mp4')
  fs.writeFileSync(videoA, 'video-a')
  fs.writeFileSync(videoAPrefixSibling, 'video-a-copy')
  fs.writeFileSync(videoB, 'video-b')

  const framesDir = path.join(mediaDir, 'frames', 'fixed-search')
  const framePaths = {
    red: path.join(framesDir, 'red.jpg'),
    blue: path.join(framesDir, 'blue.jpg'),
    prefixSibling: path.join(framesDir, 'prefix-sibling.jpg'),
    outside: path.join(framesDir, 'outside.jpg'),
  }
  fs.mkdirSync(framesDir, { recursive: true })
  for (const framePath of Object.values(framePaths)) fs.writeFileSync(framePath, 'jpg')

  writeJsonLines(path.join(mediaDir, 'manifests', 'video_frames.jsonl'), [
    {
      frameId: 'red-frame',
      videoId: 'video-a',
      videoPath: videoA,
      timestampMs: 1000,
      imagePath: framePaths.red,
      status: 'done',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      frameId: 'blue-frame',
      videoId: 'video-a',
      videoPath: videoA,
      timestampMs: 2000,
      imagePath: framePaths.blue,
      status: 'done',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      frameId: 'prefix-sibling-frame',
      videoId: 'video-a-copy',
      videoPath: videoAPrefixSibling,
      timestampMs: 1000,
      imagePath: framePaths.prefixSibling,
      status: 'done',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      frameId: 'outside-frame',
      videoId: 'video-b',
      videoPath: videoB,
      timestampMs: 1000,
      imagePath: framePaths.outside,
      status: 'done',
      createdAt: 1,
      updatedAt: 1,
    },
  ])

  writeJsonLines(
    path.join(userDataDir, 'vector-db', 'embeddings', 'clip_vit_base_patch32__global.jsonl'),
    [
      {
        imageId: framePaths.red,
        modelName: 'clip_vit_base_patch32',
        embeddingType: 'global',
        dim: 512,
        vector: unitVector(1, 0),
      },
      {
        imageId: framePaths.blue,
        modelName: 'clip_vit_base_patch32',
        embeddingType: 'global',
        dim: 512,
        vector: unitVector(0.15, 0.99),
      },
      {
        imageId: framePaths.prefixSibling,
        modelName: 'clip_vit_base_patch32',
        embeddingType: 'global',
        dim: 512,
        vector: unitVector(1, 0),
      },
      {
        imageId: framePaths.outside,
        modelName: 'clip_vit_base_patch32',
        embeddingType: 'global',
        dim: 512,
        vector: unitVector(0.99, 0.05),
      },
    ],
  )

  return { scopeA, scopeB, emptyScope, videoA, framePaths }
}

test('media frame vector search matches fixed sample ranking and topK', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-search-fixed-'))
  const { mediaDir, userDataDir } = initFixedMediaSearchFixture(root)

  const videoPath = path.join(root, 'fixture.mp4')
  fs.writeFileSync(videoPath, 'video')

  const framesDir = path.join(mediaDir, 'frames', 'video-a')
  const framePaths = ['query', 'near', 'middle', 'far'].map((name) =>
    path.join(framesDir, `${name}.jpg`),
  )
  fs.mkdirSync(framesDir, { recursive: true })
  for (const framePath of framePaths) fs.writeFileSync(framePath, 'jpg')

  writeJsonLines(path.join(mediaDir, 'manifests', 'video_frames.jsonl'), [
    {
      frameId: 'query-frame',
      videoId: 'video-a',
      videoPath,
      timestampMs: 1000,
      imagePath: framePaths[0],
      status: 'done',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      frameId: 'near-frame',
      videoId: 'video-a',
      videoPath,
      timestampMs: 2000,
      imagePath: framePaths[1],
      status: 'done',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      frameId: 'middle-frame',
      videoId: 'video-a',
      videoPath,
      timestampMs: 3000,
      imagePath: framePaths[2],
      status: 'done',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      frameId: 'far-frame',
      videoId: 'video-a',
      videoPath,
      timestampMs: 4000,
      imagePath: framePaths[3],
      status: 'done',
      createdAt: 1,
      updatedAt: 1,
    },
  ])

  writeJsonLines(
    path.join(userDataDir, 'vector-db', 'embeddings', 'clip_vit_base_patch32__global.jsonl'),
    [
      {
        imageId: framePaths[0],
        modelName: 'clip_vit_base_patch32',
        embeddingType: 'global',
        dim: 512,
        vector: unitVector(1, 0),
      },
      {
        imageId: framePaths[1],
        modelName: 'clip_vit_base_patch32',
        embeddingType: 'global',
        dim: 512,
        vector: unitVector(0.98, 0.2),
      },
      {
        imageId: framePaths[2],
        modelName: 'clip_vit_base_patch32',
        embeddingType: 'global',
        dim: 512,
        vector: unitVector(0.65, 0.76),
      },
      {
        imageId: framePaths[3],
        modelName: 'clip_vit_base_patch32',
        embeddingType: 'global',
        dim: 512,
        vector: unitVector(-1, 0),
      },
    ],
  )

  const result = await searchSimilarVideoFrames({
    frameId: 'query-frame',
    modelName: 'clip_vit_base_patch32',
    topK: 2,
  })

  assert.equal(result.ok, true)
  assertSearchTimings(result)
  assert.equal(result.totalCandidates, 3)
  assert.deepEqual(
    result.results.map((frame) => frame.frameId),
    ['near-frame', 'middle-frame'],
  )
  assert.ok((result.results[0].vectorScore ?? 0) > (result.results[1].vectorScore ?? 0))
  assert.equal(
    result.results.some((frame) => frame.frameId === 'query-frame'),
    false,
  )

  fs.rmSync(root, { recursive: true, force: true })
})

test('similar frame candidates apply the requested video scope before topK', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-similar-scoped-'))
  try {
    const { mediaDir, userDataDir } = initFixedMediaSearchFixture(root)
    const { scopeA } = writeFrameSearchFixture(root, mediaDir, userDataDir)
    const scoped = await searchSimilarVideoFrames({
      frameId: 'red-frame',
      modelName: 'clip_vit_base_patch32',
      topK: 1,
      scanPaths: [scopeA],
    })
    assert.equal(scoped.ok, true, scoped.error)
    assert.equal(scoped.totalCandidates, 1)
    assert.equal(scoped.results[0].frameId, 'blue-frame')
  } finally {
    assert.equal(path.dirname(root), os.tmpdir())
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('frame find, preview, list, and similarity search hide frames whose parent video is missing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-search-missing-parent-'))
  try {
    const { mediaDir, userDataDir } = initFixedMediaSearchFixture(root)
    const availableVideoPath = path.join(root, 'available.mp4')
    const missingVideoPath = path.join(root, 'missing.mp4')
    fs.writeFileSync(availableVideoPath, 'available-video')
    // Keep the file present: visibility must follow the authoritative manifest
    // tombstone, not an incidental fs.existsSync failure.
    fs.writeFileSync(missingVideoPath, 'still-present-but-tombstoned')
    writeJsonLines(path.join(mediaDir, 'manifests', 'video_files.jsonl'), [
      {
        videoId: 'video-available',
        path: availableVideoPath,
        name: path.basename(availableVideoPath),
        ext: '.mp4',
        sizeBytes: 15,
        mtimeMs: 1,
        discoveredAt: 1,
        updatedAt: 1,
      },
      {
        videoId: 'video-missing',
        path: missingVideoPath,
        name: path.basename(missingVideoPath),
        ext: '.mp4',
        sizeBytes: 29,
        mtimeMs: 1,
        discoveredAt: 1,
        updatedAt: 2,
        missing: true,
      },
    ])

    const frameIds = {
      availableQuery: 'a'.repeat(40),
      availableCandidate: 'b'.repeat(40),
      missingCandidate: 'c'.repeat(40),
      missingQuery: 'd'.repeat(40),
    }
    const framePaths = Object.fromEntries(
      Object.entries(frameIds).map(([key, frameId]) => [
        key,
        path.join(mediaDir, 'frames', key, `${frameId}.jpg`),
      ]),
    )
    for (const framePath of Object.values(framePaths)) {
      fs.mkdirSync(path.dirname(framePath), { recursive: true })
      fs.writeFileSync(framePath, 'derived-frame')
    }
    const frameRecords = [
      {
        frameId: frameIds.availableQuery,
        videoId: 'video-available',
        videoPath: availableVideoPath,
        timestampMs: 1000,
        imagePath: framePaths.availableQuery,
      },
      {
        frameId: frameIds.availableCandidate,
        videoId: 'video-available',
        videoPath: availableVideoPath,
        timestampMs: 2000,
        imagePath: framePaths.availableCandidate,
      },
      {
        frameId: frameIds.missingCandidate,
        videoId: 'video-missing',
        videoPath: missingVideoPath,
        timestampMs: 1000,
        imagePath: framePaths.missingCandidate,
      },
      {
        frameId: frameIds.missingQuery,
        videoId: 'video-missing',
        videoPath: missingVideoPath,
        timestampMs: 2000,
        imagePath: framePaths.missingQuery,
      },
    ].map((record) => ({ ...record, status: 'done', createdAt: 1, updatedAt: 1 }))
    writeJsonLines(path.join(mediaDir, 'manifests', 'video_frames.jsonl'), frameRecords)

    writeJsonLines(
      path.join(userDataDir, 'vector-db', 'embeddings', 'clip_vit_base_patch32__global.jsonl'),
      [
        [framePaths.availableQuery, unitVector(1, 0)],
        [framePaths.availableCandidate, unitVector(0.8, 0.6)],
        // This missing-parent candidate would otherwise outrank the available one.
        [framePaths.missingCandidate, unitVector(1, 0)],
        [framePaths.missingQuery, unitVector(0, 1)],
      ].map(([imageId, vector]) => ({
        imageId,
        modelName: 'clip_vit_base_patch32',
        embeddingType: 'global',
        dim: 512,
        vector,
      })),
    )

    assert.equal(findReadyVideoFrameById(frameIds.availableCandidate)?.videoId, 'video-available')
    assert.equal(findReadyVideoFrameById(frameIds.missingCandidate), null)

    const preview = loadVideoFrameManifestPreview(20)
    assert.equal(preview.total, 2)
    assert.deepEqual(
      preview.frames.map((frame) => frame.videoId),
      ['video-available', 'video-available'],
    )
    assert.deepEqual(
      loadAvailableVideoFrameManifest().map((frame) => frame.frameId),
      [frameIds.availableQuery, frameIds.availableCandidate],
    )
    assert.deepEqual(
      loadReadyVideoFrameManifest().map((frame) => frame.frameId),
      [frameIds.availableQuery, frameIds.availableCandidate],
    )

    const result = await searchSimilarVideoFrames({
      frameId: frameIds.availableQuery,
      modelName: 'clip_vit_base_patch32',
      topK: 10,
    })
    assert.equal(result.ok, true)
    assert.equal(result.totalCandidates, 1)
    assert.deepEqual(
      result.results.map((frame) => frame.frameId),
      [frameIds.availableCandidate],
    )

    const missingQuery = await searchSimilarVideoFrames({
      frameId: frameIds.missingQuery,
      modelName: 'clip_vit_base_patch32',
      topK: 10,
    })
    assert.equal(missingQuery.ok, false)
    assert.equal(missingQuery.totalCandidates, 0)
    assert.deepEqual(missingQuery.results, [])
    assert.equal(fs.existsSync(framePaths.missingCandidate), true, 'derived cache is retained')
    assert.equal(fs.existsSync(missingVideoPath), true, 'source media is never touched')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('media frame index coalesces concurrent asynchronous loads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-search-index-async-'))
  try {
    const { mediaDir, userDataDir } = initFixedMediaSearchFixture(root)
    writeFrameSearchFixture(root, mediaDir, userDataDir)
    const built = buildFrameIndex()
    assert.equal(built.entries, 4)

    const [first, second] = await Promise.all([
      loadFrameIndexAsync('clip_vit_base_patch32'),
      loadFrameIndexAsync('clip_vit_base_patch32'),
    ])
    assert.equal(first, second)
    assert.equal(first.size, 4)
    assert.ok([...first.values()].every((vector) => vector instanceof Float32Array))
    assert.ok([...first.values()].every((vector) => vector.byteLength === 512 * 4))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('media frame index coalesces concurrent asynchronous rebuilds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-search-index-rebuild-'))
  try {
    const { mediaDir, userDataDir } = initFixedMediaSearchFixture(root)
    writeFrameSearchFixture(root, mediaDir, userDataDir)

    const [first, second] = await Promise.all([
      ensureFrameIndexFreshAsync(),
      ensureFrameIndexFreshAsync(),
    ])
    assert.equal(first.rebuilt, true)
    assert.equal(second.rebuilt, true)
    assert.equal(first.entries, 4)
    assert.equal(second.entries, 4)
    assert.equal(first.errors, 0)
    assert.equal(second.errors, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('media frame text search uses fixed embedding ranking and scanPaths scope', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-search-text-fixed-'))
  try {
    const { mediaDir, userDataDir } = initFixedMediaSearchFixture(root)
    const { scopeA, emptyScope } = writeFrameSearchFixture(root, mediaDir, userDataDir)
    setMediaSearchEmbeddingProvidersForTests({
      text: async () => unitVector(1, 0),
    })

    const result = await searchVideoFramesByText({
      textQuery: 'red frame',
      topK: 5,
      scanPaths: [scopeA],
    })

    assert.equal(result.ok, true)
    assertSearchTimings(result)
    assert.equal(result.totalCandidates, 2)
    assert.deepEqual(
      result.results.map((frame) => frame.frameId),
      ['red-frame', 'blue-frame'],
    )
    assert.equal(
      result.results.some((frame) => frame.frameId === 'outside-frame'),
      false,
    )
    assert.equal(
      result.results.some((frame) => frame.frameId === 'prefix-sibling-frame'),
      false,
    )
    assert.ok((result.results[0].vectorScore ?? 0) > (result.results[1].vectorScore ?? 0))

    const emptyResult = await searchVideoFramesByText({
      textQuery: 'red frame',
      scanPaths: [emptyScope],
    })
    assert.equal(emptyResult.ok, false)
    assert.match(emptyResult.error || '', /selected scan paths/i)
  } finally {
    setMediaSearchEmbeddingProvidersForTests()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('media frame image search uses fixed query embedding and scanPaths scope', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-search-image-fixed-'))
  try {
    const { mediaDir, userDataDir } = initFixedMediaSearchFixture(root)
    const { scopeA, scopeB, framePaths } = writeFrameSearchFixture(root, mediaDir, userDataDir)
    const queryImagePath = path.join(root, 'query.jpg')
    fs.writeFileSync(queryImagePath, 'query')
    setMediaSearchEmbeddingProvidersForTests({
      image: async (input) => {
        assert.equal(input.imagePath, queryImagePath)
        return { ok: true, vector: unitVector(0, 1), dim: 512 }
      },
    })

    const scopedResult = await searchVideoFramesByImage({
      imagePath: queryImagePath,
      modelName: 'clip_vit_base_patch32',
      topK: 1,
      scanPaths: [scopeA],
    })

    assert.equal(scopedResult.ok, true)
    assertSearchTimings(scopedResult)
    assert.equal(scopedResult.totalCandidates, 2)
    assert.deepEqual(
      scopedResult.results.map((frame) => frame.frameId),
      ['blue-frame'],
    )

    fs.unlinkSync(framePaths.blue)
    const afterExternalDelete = await searchVideoFramesByImage({
      imagePath: queryImagePath,
      modelName: 'clip_vit_base_patch32',
      topK: 1,
      scanPaths: [scopeA],
    })
    assert.equal(afterExternalDelete.ok, true)
    assert.deepEqual(
      afterExternalDelete.results.map((frame) => frame.frameId),
      ['red-frame'],
    )

    const otherScopeResult = await searchVideoFramesByImage({
      imagePath: queryImagePath,
      modelName: 'clip_vit_base_patch32',
      topK: 5,
      scanPaths: [scopeB],
    })
    assert.equal(otherScopeResult.ok, true)
    assert.equal(otherScopeResult.totalCandidates, 1)
    assert.deepEqual(
      otherScopeResult.results.map((frame) => frame.imagePath),
      [framePaths.outside],
    )
  } finally {
    setMediaSearchEmbeddingProvidersForTests()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('direct frame image and text searches exclude videos marked missing while retaining caches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-search-missing-video-'))
  try {
    const { mediaDir, userDataDir } = initFixedMediaSearchFixture(root)
    const { scopeA, scopeB, videoA, framePaths } = writeFrameSearchFixture(
      root,
      mediaDir,
      userDataDir,
    )
    writeJsonLines(path.join(mediaDir, 'manifests', 'video_files.jsonl'), [
      {
        videoId: 'video-a',
        path: videoA,
        name: path.basename(videoA),
        ext: '.mp4',
        sizeBytes: 7,
        mtimeMs: 1,
        discoveredAt: 1,
        updatedAt: 2,
        missing: true,
      },
    ])
    const queryImagePath = path.join(root, 'query.jpg')
    fs.writeFileSync(queryImagePath, 'query')
    setMediaSearchEmbeddingProvidersForTests({
      image: async () => ({ ok: true, vector: unitVector(1, 0), dim: 512 }),
      text: async () => unitVector(1, 0),
    })

    const image = await searchVideoFramesByImage({
      imagePath: queryImagePath,
      scanPaths: [scopeA],
    })
    const text = await searchVideoFramesByText({ textQuery: 'cached frame', scanPaths: [scopeA] })
    assert.equal(image.ok, false)
    assert.equal(text.ok, false)
    assert.match(image.error || '', /No ready video frame images/)
    assert.match(text.error || '', /No ready video frame images/)

    const otherScope = await searchVideoFramesByText({
      textQuery: 'cached frame',
      scanPaths: [scopeB],
    })
    assert.equal(otherScope.ok, true)
    assert.deepEqual(
      otherScope.results.map((frame) => frame.videoId),
      ['video-b'],
    )
    assert.equal(fs.existsSync(framePaths.red), true)
    assert.equal(
      fs.existsSync(
        path.join(userDataDir, 'vector-db', 'embeddings', 'clip_vit_base_patch32__global.jsonl'),
      ),
      true,
    )
  } finally {
    setMediaSearchEmbeddingProvidersForTests()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('media frame searches reject provider vectors whose length disagrees with the model registry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-search-query-dim-'))
  try {
    const { mediaDir, userDataDir } = initFixedMediaSearchFixture(root)
    const { scopeA } = writeFrameSearchFixture(root, mediaDir, userDataDir)
    const queryImagePath = path.join(root, 'query.jpg')
    fs.writeFileSync(queryImagePath, 'query')
    setMediaSearchEmbeddingProvidersForTests({
      image: async () => ({ ok: true, vector: Array(511).fill(1), dim: 511 }),
      text: async () => Array(513).fill(1),
    })

    const image = await searchVideoFramesByImage({ imagePath: queryImagePath, scanPaths: [scopeA] })
    assert.equal(image.ok, false)
    assert.match(image.error || '', /embedding is invalid/i)

    const text = await searchVideoFramesByText({ textQuery: 'wrong length', scanPaths: [scopeA] })
    assert.equal(text.ok, false)
    assert.match(text.error || '', /embedding is invalid/i)
  } finally {
    setMediaSearchEmbeddingProvidersForTests()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('media frame search rebuilds stale frame index after manifest and embedding changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-search-rebuild-fixed-'))
  try {
    const { mediaDir, userDataDir } = initFixedMediaSearchFixture(root)
    const { scopeA, videoA } = writeFrameSearchFixture(root, mediaDir, userDataDir)
    setMediaSearchEmbeddingProvidersForTests({
      text: async () => unitVector(0, 1),
    })

    const first = await searchVideoFramesByText({
      textQuery: 'blue frame',
      topK: 1,
      scanPaths: [scopeA],
    })
    assert.equal(first.ok, true)
    assertSearchTimings(first)
    assert.deepEqual(
      first.results.map((frame) => frame.frameId),
      ['blue-frame'],
    )
    const metaPath = path.join(mediaDir, 'vectors', 'frame_embedding_index.meta.json')
    assert.equal(fs.existsSync(metaPath), true)
    const firstMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    assert.equal(firstMeta.version, 2)
    assert.equal(firstMeta.entries, 4)
    assert.equal(typeof firstMeta.sourceSignature, 'string')

    const newFramePath = path.join(mediaDir, 'frames', 'fixed-search', 'new-blue.jpg')
    fs.writeFileSync(newFramePath, 'jpg')
    const manifestPath = path.join(mediaDir, 'manifests', 'video_frames.jsonl')
    const shardPath = path.join(
      userDataDir,
      'vector-db',
      'embeddings',
      'clip_vit_base_patch32__global.jsonl',
    )
    appendJsonLine(manifestPath, {
      frameId: 'new-blue-frame',
      videoId: 'video-a',
      videoPath: videoA,
      timestampMs: 3000,
      imagePath: newFramePath,
      status: 'done',
      createdAt: 2,
      updatedAt: 2,
    })
    appendJsonLine(shardPath, {
      imageId: newFramePath,
      modelName: 'clip_vit_base_patch32',
      embeddingType: 'global',
      dim: 512,
      vector: unitVector(0, 1),
    })
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(manifestPath, future, future)
    fs.utimesSync(shardPath, future, future)

    const rebuilt = await searchVideoFramesByText({
      textQuery: 'blue frame',
      topK: 2,
      scanPaths: [scopeA],
    })
    assert.equal(rebuilt.ok, true)
    assert.equal(rebuilt.totalCandidates, 3)
    assert.deepEqual(
      rebuilt.results.map((frame) => frame.frameId),
      ['new-blue-frame', 'blue-frame'],
    )
    const rebuiltMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    assert.equal(rebuiltMeta.version, 2)
    assert.equal(rebuiltMeta.entries, 5)
    assert.notEqual(rebuiltMeta.sourceSignature, firstMeta.sourceSignature)
  } finally {
    setMediaSearchEmbeddingProvidersForTests()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
