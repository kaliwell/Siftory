const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { createMediaPreparationPipeline } = loadTsModule('electron/mediaPreparationPipeline.ts')

function progress(state, overrides = {}) {
  return {
    total: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    running: 0,
    pending: 0,
    state,
    ...overrides,
  }
}

function videoRecord(filePath) {
  const stat = fs.statSync(filePath)
  return {
    videoId: 'video-a',
    path: filePath,
    name: path.basename(filePath),
    ext: '.mp4',
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    durationMs: 12_000,
    width: 320,
    height: 180,
    metadataStatus: 'done',
    discoveredAt: 1,
    updatedAt: 1,
  }
}

function frameRecord(root, index) {
  const imagePath = path.join(root, `frame-${index}.jpg`)
  fs.writeFileSync(imagePath, `frame-${index}`)
  return {
    frameId: String(index).padStart(40, '0'),
    videoId: 'video-a',
    videoPath: path.join(root, 'source.mp4'),
    timestampMs: index * 1000,
    imagePath,
    width: 256,
    status: 'done',
    createdAt: 1,
    updatedAt: index,
  }
}

test('media preparation overlaps committed frame extraction with embeddings and gates ready on exact coverage', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-pipeline-overlap-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sourcePath = path.join(root, 'source.mp4')
  fs.writeFileSync(sourcePath, 'source')
  const video = videoRecord(sourcePath)
  const frames = [1, 2, 3, 4].map((index) => frameRecord(root, index))
  const coverage = {
    dinov2_vitb14: new Set(),
    clip_vit_base_patch32: new Set(),
  }
  const builds = []
  const appended = []
  const snapshots = []
  let embeddingState = progress('idle')
  let embeddingListener = null
  let extractionDone = false
  let streamReady = false
  const scaledConcurrency = []
  let releaseExtraction
  const extractionGate = new Promise((resolve) => {
    releaseExtraction = resolve
  })
  let submittedStage = ''

  const pipeline = createMediaPreparationPipeline({
    submitTask: async (_scheduler, request) => {
      submittedStage = request.stage
      return request.run()
    },
    buildFrames: async (options) => {
      options.onProgress?.({ completed: 0, total: 4, failed: 0 })
      options.onCheckpoint?.({
        kind: 'checkpoint',
        scopeId: 'a'.repeat(32),
        sequence: 1,
        records: frames.slice(0, 2),
        readyRecords: frames.slice(0, 2),
        completed: 2,
        total: 4,
      })
      options.onProgress?.({ completed: 2, total: 4, failed: 0 })
      await extractionGate
      extractionDone = true
      options.onProgress?.({ completed: 4, total: 4, failed: 0 })
      options.onCheckpoint?.({
        kind: 'final',
        scopeId: 'a'.repeat(32),
        sequence: 2,
        records: frames,
        readyRecords: frames,
        completed: 4,
        total: 4,
      })
      return {
        records: frames,
        total: 4,
        completed: 4,
        failed: 0,
        unavailable: 0,
        preserved: 0,
        sourceChanged: 0,
        invalidatedImagePaths: [],
      }
    },
    getModelStatus: (modelName) => ({ name: modelName, state: 'downloaded' }),
    startEmbedding: async (request) => {
      const imageIds = [...(request.imageIds || [])]
      builds.push({
        modelName: request.modelName,
        imageIds,
        extractionDoneAtStart: extractionDone,
        maxConcurrentEmbeddings: request.maxConcurrentEmbeddings,
      })
      embeddingState = progress('running', { total: imageIds.length, pending: imageIds.length })
      if (request.streamSessionId) {
        streamReady = true
        for (const imageId of imageIds) coverage[request.modelName].add(imageId)
        releaseExtraction()
        return { ok: true }
      }
      setImmediate(() => {
        for (const imageId of imageIds) coverage[request.modelName].add(imageId)
        embeddingState = progress('done', {
          total: imageIds.length,
          completed: imageIds.length,
        })
        embeddingListener?.(embeddingState)
      })
      return { ok: true }
    },
    isStreamingEmbeddingReady: () => streamReady,
    appendStreamingEmbeddingInputs: async (_sessionId, imageIds) => {
      appended.push([...imageIds])
      for (const imageId of imageIds) coverage.dinov2_vitb14.add(imageId)
      return { ok: true }
    },
    closeStreamingEmbedding: () => {
      streamReady = false
      embeddingState = progress('done', {
        total: coverage.dinov2_vitb14.size,
        completed: coverage.dinov2_vitb14.size,
      })
      embeddingListener?.(embeddingState)
      return { ok: true }
    },
    scaleStreamingEmbedding: (_sessionId, maxConcurrency) => {
      scaledConcurrency.push(maxConcurrency)
      return { ok: true }
    },
    getEmbeddingProgress: () => embeddingState,
    onEmbeddingProgress: (listener) => {
      embeddingListener = listener
      return () => {
        if (embeddingListener === listener) embeddingListener = null
      }
    },
    collectEmbeddedIds: async (modelName, requested) =>
      new Set([...requested].filter((imagePath) => coverage[modelName].has(imagePath))),
    buildFrameIndex: async () => {
      assert.equal(coverage.dinov2_vitb14.size, 4)
      assert.equal(coverage.clip_vit_base_patch32.size, 4)
      return { entries: 8, errors: 0 }
    },
    invalidateFrameIndex: () => undefined,
    cancelQueuedEmbedding: () => false,
    stopEmbedding: () => ({ ok: true }),
    removeInvalidatedEmbeddings: async () => undefined,
  })

  const result = await pipeline({
    videos: [video],
    backend: 'cpu',
    maxConcurrentEmbeddings: 2,
    onProgress: (next) => snapshots.push(next),
  })

  assert.equal(submittedStage, 'preview')
  assert.deepEqual(
    builds.map((build) => [build.modelName, build.imageIds.length]),
    [
      ['dinov2_vitb14', 2],
      ['clip_vit_base_patch32', 4],
    ],
  )
  assert.deepEqual(
    appended.map((chunk) => chunk.length),
    [2],
  )
  assert.equal(builds[0].extractionDoneAtStart, false)
  assert.equal(builds[0].maxConcurrentEmbeddings, 1)
  assert.deepEqual(scaledConcurrency, [2])
  assert.equal(result.readyFrames, 4)
  assert.equal(result.frameIndexEntries, 8)
  assert.equal(snapshots.at(-1).phase, 'done')
  assert.equal(snapshots.at(-1).percentage, 100)
  assert.equal(snapshots.at(-1).frameExtractionComplete, true)
  assert.equal(snapshots.at(-1).dinoEmbeddingComplete, true)
  assert.equal(snapshots.at(-1).clipEmbeddingComplete, true)
  assert.equal(snapshots.at(-1).frameIndexComplete, true)
  assert.ok(
    snapshots.slice(0, -1).every((snapshot) => !snapshot.frameIndexComplete),
    'no partial checkpoint may advertise a committed searchable index',
  )
  for (let index = 1; index < snapshots.length; index++) {
    assert.ok(snapshots[index].percentage >= snapshots[index - 1].percentage)
  }
})

test('media preparation invalidates stale frame embeddings when a source revision changes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-pipeline-source-change-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sourcePath = path.join(root, 'source.mp4')
  fs.writeFileSync(sourcePath, 'source')
  const video = videoRecord(sourcePath)
  const frame = frameRecord(root, 1)
  const removed = []
  let invalidated = 0

  const pipeline = createMediaPreparationPipeline({
    submitTask: async (_scheduler, request) => request.run(),
    buildFrames: async (options) => {
      options.onCheckpoint?.({
        kind: 'checkpoint',
        scopeId: 'b'.repeat(32),
        sequence: 1,
        records: [frame],
        readyRecords: [frame],
        completed: 1,
        total: 1,
      })
      return {
        records: [{ ...frame, status: 'error' }],
        total: 1,
        completed: 0,
        failed: 1,
        unavailable: 0,
        preserved: 0,
        sourceChanged: 1,
        invalidatedImagePaths: [frame.imagePath],
      }
    },
    getModelStatus: (modelName) => ({ name: modelName, state: 'not-installed' }),
    removeInvalidatedEmbeddings: async (imagePaths) => removed.push(...imagePaths),
    invalidateFrameIndex: () => {
      invalidated++
    },
    cancelQueuedEmbedding: () => false,
    stopEmbedding: () => ({ ok: true }),
  })

  await assert.rejects(
    pipeline({
      videos: [video],
      backend: 'cpu',
      maxConcurrentEmbeddings: 1,
      modelWaitTimeoutMs: 5_000,
    }),
    /source video\(s\) changed.*rescan required/,
  )
  assert.deepEqual(removed, [frame.imagePath])
  assert.equal(invalidated, 1)
})
