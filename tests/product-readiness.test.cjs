const assert = require('node:assert/strict')
const test = require('node:test')

const { loadTsModule } = require('./guard-utils.cjs')
const {
  buildProductReadiness,
  buildProductTaskInventory,
  loadProductReadiness,
  runProductTaskControl,
} = loadTsModule('src/services/productReadiness.ts')

const NOW = 1_700_000_000_000

function source(overrides = {}) {
  return {
    id: 'source-1',
    type: 'local-ntfs',
    displayName: 'Library',
    rootLocator: 'D:\\media',
    readOnly: true,
    availability: 'online',
    scanCapability: 'directory',
    fileCount: 12,
    totalBytes: 1024,
    ...overrides,
  }
}

function model(name, state = 'verified', progress) {
  return { name, state, ...(progress === undefined ? {} : { progress }) }
}

function imageSearch(overrides = {}) {
  return { state: 'idle', indexedCount: 12, pendingCount: 0, ...overrides }
}

function mediaSearch(overrides = {}) {
  return {
    state: 'idle',
    videoCount: 0,
    indexedFrameCount: 0,
    ffmpegConfigured: true,
    ffprobeConfigured: true,
    updatedAt: NOW,
    ...overrides,
  }
}

function videoSemantic(overrides = {}) {
  return {
    runtime: { adapterId: 'qwen3-vl', state: 'ready' },
    indexState: 'ready',
    activeVideos: 0,
    activeSegments: 0,
    profileOverride: 'auto',
    profiles: [],
    jobs: [],
    canBuild: true,
    canStop: false,
    canResume: false,
    updatedAt: NOW,
    ...overrides,
  }
}

function audioSemantic(overrides = {}) {
  return {
    runtime: { adapterId: 'sensevoice', state: 'ready' },
    diarization: { state: 'ready' },
    indexState: 'ready',
    indexedVideos: 0,
    indexedSegments: 0,
    eligibleVideos: 0,
    capabilities: {
      asr: true,
      language: true,
      emotion: true,
      audioEvents: true,
      speakerDiarization: true,
    },
    canBuild: true,
    canStop: false,
    canResume: false,
    modelDownloadRequired: false,
    updatedAt: NOW,
    ...overrides,
  }
}

function readyInput(overrides = {}) {
  return {
    sources: [source()],
    scans: [],
    imageSearch: imageSearch(),
    modelStatuses: {
      dinov2_vitb14: model('dinov2_vitb14'),
      clip_vit_base_patch32: model('clip_vit_base_patch32'),
    },
    mediaSearch: mediaSearch(),
    videoSemantic: videoSemantic(),
    audioSemantic: audioSemantic(),
    ...overrides,
  }
}

test('empty installation reports a single safe first action', () => {
  const snapshot = buildProductReadiness(
    readyInput({
      sources: [],
      imageSearch: imageSearch({ indexedCount: 0 }),
      modelStatuses: {
        dinov2_vitb14: model('dinov2_vitb14', 'not-installed'),
        clip_vit_base_patch32: model('clip_vit_base_patch32', 'not-installed'),
      },
      mediaSearch: mediaSearch({ ffmpegConfigured: false, ffprobeConfigured: false }),
      videoSemantic: videoSemantic({
        runtime: { adapterId: 'none', state: 'not-installed' },
      }),
      audioSemantic: audioSemantic({
        runtime: { adapterId: 'none', state: 'not-installed' },
        modelDownloadRequired: true,
      }),
    }),
  )

  assert.equal(snapshot.state, 'not-started')
  assert.equal(snapshot.searchable, false)
  assert.equal(snapshot.nextAction, 'add-source')
  assert.equal(snapshot.stages.find((stage) => stage.id === 'sources').reason, 'no-source')
})

test('an active discovery scan is preparing and exposes bounded progress', () => {
  const snapshot = buildProductReadiness({
    sources: [source({ fileCount: 0 })],
    scans: [
      {
        sourceId: 'source-1',
        running: true,
        session: {
          id: 'scan-1',
          sourceId: 'source-1',
          state: 'running',
          backend: 'directory',
          startedAt: NOW,
          discoveredCount: 40,
          committedCount: 10,
        },
      },
    ],
  })

  assert.equal(snapshot.state, 'preparing')
  assert.equal(snapshot.stages.find((stage) => stage.id === 'catalog').progress, 25)
  assert.ok(snapshot.progress >= 0 && snapshot.progress <= 100)
})

test('metadata remains searchable while optional semantic capabilities are missing', () => {
  const snapshot = buildProductReadiness(
    readyInput({
      imageSearch: imageSearch({ indexedCount: 0 }),
      modelStatuses: {
        dinov2_vitb14: model('dinov2_vitb14', 'not-installed'),
        clip_vit_base_patch32: model('clip_vit_base_patch32', 'not-installed'),
      },
      videoSemantic: videoSemantic({
        runtime: { adapterId: 'none', state: 'not-installed' },
      }),
      audioSemantic: audioSemantic({
        runtime: { adapterId: 'none', state: 'not-installed' },
        modelDownloadRequired: true,
      }),
    }),
  )

  assert.equal(snapshot.state, 'searchable')
  assert.equal(snapshot.searchable, true)
  assert.equal(snapshot.capabilities.metadata, true)
  assert.equal(snapshot.capabilities.naturalLanguageImage, false)
  assert.equal(snapshot.nextAction, 'prepare-image-search')
})

test('offline sources degrade but do not hide an existing searchable catalog', () => {
  const snapshot = buildProductReadiness(
    readyInput({ sources: [source({ availability: 'offline' })] }),
  )

  assert.equal(snapshot.state, 'degraded')
  assert.equal(snapshot.searchable, true)
  assert.equal(snapshot.nextAction, 'reconnect-source')
  assert.equal(snapshot.stages.find((stage) => stage.id === 'catalog').state, 'ready')
})

test('all prepared capabilities produce a stable ready snapshot', () => {
  const snapshot = buildProductReadiness(readyInput())

  assert.equal(snapshot.state, 'ready')
  assert.equal(snapshot.progress, 100)
  assert.equal(snapshot.nextAction, undefined)
  assert.equal(snapshot.capabilities.metadata, true)
  assert.equal(snapshot.capabilities.imageSimilarity, true)
  assert.equal(snapshot.capabilities.naturalLanguageImage, true)
  assert.deepEqual(
    snapshot.models.map((model) => [model.id, model.management, model.state]),
    [
      ['dinov2_vitb14', 'managed-download', 'verified'],
      ['clip_vit_base_patch32', 'managed-download', 'verified'],
      ['qwen3-vl', 'external-runtime', 'ready'],
      ['sensevoice', 'external-runtime', 'ready'],
    ],
  )
})

test('runtime failures are explicit and keep already indexed content searchable', () => {
  const snapshot = buildProductReadiness(
    readyInput({
      mediaSearch: mediaSearch({ videoCount: 2, indexedFrameCount: 20 }),
      videoSemantic: videoSemantic({
        runtime: { adapterId: 'qwen3-vl', state: 'error', reason: 'child-exited' },
        activeVideos: 1,
        activeSegments: 8,
      }),
    }),
  )

  assert.equal(snapshot.state, 'degraded')
  assert.equal(snapshot.capabilities.videoSemantic, true)
  assert.equal(
    snapshot.stages.find((stage) => stage.id === 'video-semantic').action,
    'retry-video-semantic',
  )
})

test('partial video and dialogue indexes report resume actions without discarding capabilities', () => {
  const snapshot = buildProductReadiness(
    readyInput({
      mediaSearch: mediaSearch({ videoCount: 3, indexedFrameCount: 30 }),
      videoSemantic: videoSemantic({ activeVideos: 1, activeSegments: 4, canResume: true }),
      audioSemantic: audioSemantic({
        indexedVideos: 1,
        indexedSegments: 20,
        eligibleVideos: 3,
        canResume: true,
      }),
    }),
  )

  assert.equal(snapshot.state, 'searchable')
  assert.equal(snapshot.capabilities.videoSemantic, true)
  assert.equal(snapshot.capabilities.dialogue, true)
  assert.equal(
    snapshot.stages.find((stage) => stage.id === 'video-semantic').action,
    'resume-video-semantic',
  )
  assert.equal(
    snapshot.stages.find((stage) => stage.id === 'audio-semantic').action,
    'resume-audio-semantic',
  )
})

test('status loader reads authoritative APIs and keeps failures explicit', async () => {
  const calls = []
  const input = readyInput()
  const api = {
    discoveryCatalog: {
      listSources: async () => {
        calls.push('sources')
        return input.sources
      },
      getScanStatus: async () => {
        calls.push('scans')
        return []
      },
    },
    imageSearch: {
      getStatus: async () => {
        calls.push('image')
        return input.imageSearch
      },
      getThumbnailRebuildProgress: async () => ({
        state: 'idle',
        total: 0,
        completed: 0,
        skipped: 0,
        failed: 0,
      }),
      getDataOverview: async () => {
        calls.push('image-storage')
        return { ok: true, totalBytes: 1024 }
      },
    },
    vector: {
      getModelStatus: async (name) => {
        calls.push(name)
        return input.modelStatuses[name]
      },
      getEmbeddingProgress: async () => ({
        total: 12,
        completed: 12,
        failed: 0,
        skipped: 0,
        running: 0,
        pending: 0,
        state: 'done',
      }),
    },
    mediaSearch: {
      getStatus: async () => input.mediaSearch,
      getTaskProgress: async () => null,
      getCacheStats: async () => {
        calls.push('media-storage')
        return { totalBytes: 2048 }
      },
      getVideoSemanticStatus: async () => input.videoSemantic,
      getAudioSemanticStatus: async () => {
        throw new Error('audio IPC unavailable')
      },
    },
  }

  const snapshot = await loadProductReadiness(api)
  assert.equal(snapshot.state, 'degraded')
  assert.equal(
    snapshot.stages.find((stage) => stage.id === 'audio-semantic').reason,
    'status-unavailable',
  )
  assert.deepEqual(calls.sort(), [
    'clip_vit_base_patch32',
    'dinov2_vitb14',
    'image',
    'scans',
    'sources',
  ])
  assert.deepEqual(snapshot.taskStorage, {})

  const snapshotWithStorage = await loadProductReadiness(api, { includeStorage: true })
  assert.ok(calls.includes('image-storage'))
  assert.ok(calls.includes('media-storage'))
  assert.deepEqual(snapshotWithStorage.taskStorage, {
    imageBytes: 1024,
    mediaBytes: 2048,
    totalBytes: 3072,
  })
})

test('task inventory deterministically projects every persisted work authority', () => {
  const input = readyInput({
    scans: [
      {
        sourceId: 'source-1',
        running: true,
        session: {
          id: 'scan-1',
          sourceId: 'source-1',
          state: 'running',
          backend: 'directory',
          startedAt: NOW,
          discoveredCount: 100,
          committedCount: 40,
        },
      },
    ],
    imageSearch: imageSearch({ state: 'indexing', indexedCount: 60, pendingCount: 40 }),
    thumbnailProgress: {
      state: 'running',
      total: 100,
      completed: 30,
      skipped: 5,
      failed: 2,
      startedAt: NOW,
    },
    embeddingProgress: {
      clip_vit_base_patch32: {
        total: 100,
        completed: 20,
        failed: 1,
        skipped: 0,
        running: 1,
        pending: 78,
        state: 'running',
        itemsPerSecond: 4,
        etaMs: 20_000,
      },
    },
    mediaTaskProgress: {
      taskId: 'frames-1',
      type: 'extract-video-frames',
      state: 'running',
      total: 10,
      completed: 3,
      failed: 0,
      percentage: 30,
      startedAt: NOW,
      updatedAt: NOW + 1,
    },
    videoSemantic: videoSemantic({
      jobs: [
        {
          jobId: 'video-1',
          videoId: 'v1',
          generationId: 'g1',
          profileId: 'general',
          state: 'paused',
          completedSegments: 2,
          failedSegments: 0,
          totalSegments: 8,
          updatedAt: NOW + 2,
        },
      ],
    }),
    audioSemantic: audioSemantic({
      job: {
        jobId: 'audio-1',
        generationId: 'g2',
        state: 'stopped',
        totalVideos: 2,
        completedVideos: 1,
        totalSegments: 10,
        completedSegments: 5,
        failedSegments: 1,
        createdAt: NOW,
        updatedAt: NOW + 3,
      },
    }),
  })

  const first = buildProductTaskInventory(input)
  const restored = buildProductTaskInventory(JSON.parse(JSON.stringify(input)))
  assert.deepEqual(restored, first)
  assert.deepEqual(
    first.map((task) => task.kind),
    [
      'video-index',
      'source-scan',
      'image-embedding',
      'image-index',
      'thumbnail-index',
      'video-semantic',
      'audio-semantic',
    ],
  )
  assert.deepEqual(
    first.slice(0, 3).map((task) => task.state),
    ['running', 'running', 'running'],
  )
  assert.equal(first.find((task) => task.kind === 'image-embedding').etaMs, 20_000)
  assert.equal(first.find((task) => task.kind === 'video-semantic').canResume, true)
})

test('task controls call the owning authoritative API', async () => {
  const calls = []
  const ok = async (...args) => {
    calls.push(args)
    return { ok: true }
  }
  const api = {
    discoveryCatalog: {
      cancelScan: (...args) => ok('cancel-source', ...args),
      startScan: (...args) => ok('retry-source', ...args),
    },
    imageSearch: {
      pauseScan: (...args) => ok('pause-image', ...args),
      resumeScan: (...args) => ok('resume-image', ...args),
      stopScan: (...args) => ok('stop-image', ...args),
      stopThumbnailRebuild: (...args) => ok('stop-thumbnails', ...args),
    },
    vector: {
      pauseEmbeddingBuild: (...args) => ok('pause-embedding', ...args),
      resumeEmbeddingBuild: (...args) => ok('resume-embedding', ...args),
      stopEmbeddingBuild: (...args) => ok('stop-embedding', ...args),
      startEmbeddingBuild: (...args) => ok('retry-embedding', ...args),
    },
    mediaSearch: {
      stopTask: (...args) => ok('stop-video-index', ...args),
      stopVideoSemanticJob: (...args) => ok('stop-video-semantic', ...args),
      resumeVideoSemanticJob: (...args) => ok('resume-video-semantic', ...args),
      stopAudioSemanticBuild: (...args) => ok('stop-audio-semantic', ...args),
      resumeAudioSemanticBuild: (...args) => ok('resume-audio-semantic', ...args),
    },
  }
  const task = (kind, authorityId = `${kind}-1`) => ({ kind, authorityId })

  await runProductTaskControl(api, task('source-scan', 'source-1'), 'stop')
  await runProductTaskControl(api, task('image-index'), 'pause')
  await runProductTaskControl(api, task('image-index'), 'resume')
  await runProductTaskControl(api, task('thumbnail-index'), 'stop')
  await runProductTaskControl(api, task('image-embedding', 'clip_vit_base_patch32'), 'retry')
  await runProductTaskControl(api, task('video-index', 'frames-1'), 'stop')
  await runProductTaskControl(api, task('video-semantic', 'video-job-1'), 'resume')
  await runProductTaskControl(api, task('audio-semantic', 'audio-job-1'), 'stop')

  assert.deepEqual(calls, [
    ['cancel-source', 'source-1'],
    ['pause-image'],
    ['resume-image'],
    ['stop-thumbnails'],
    [
      'retry-embedding',
      {
        modelName: 'clip_vit_base_patch32',
        embeddingType: 'global',
        backend: 'auto',
      },
    ],
    ['stop-video-index', 'frames-1'],
    ['resume-video-semantic', 'video-job-1'],
    ['stop-audio-semantic', 'audio-job-1'],
  ])
})

test('task retries route to setup when a safe direct restart needs user input', async () => {
  const api = {}
  assert.deepEqual(await runProductTaskControl(api, { kind: 'image-index' }, 'retry'), {
    ok: true,
    route: 'retry-image-index',
  })
  assert.deepEqual(await runProductTaskControl(api, { kind: 'thumbnail-index' }, 'retry'), {
    ok: true,
    route: 'prepare-image-search',
  })
  assert.deepEqual(await runProductTaskControl(api, { kind: 'video-index' }, 'retry'), {
    ok: true,
    route: 'build-video-frames',
  })
})
