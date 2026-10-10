// Phase 3 acceptance tests for the unified search service:
// - metadata results come back even when AI is unavailable (no misleading
//   empty result), with explicit indexState + actionable degraded reasons;
// - vector corruption, missing models and task failures each map to a
//   distinct, actionable lane state (design 9.2);
// - once indexing finishes, the same query merges semantic recall and
//   re-ranks (incremental enhancement);
// - subject/duplicate lanes merge into the same result contract (9.3).
const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')

const { UnifiedSearchService } = loadTsModule('electron/unifiedSearchService.ts')

function lexicalItem(name, directory = 'D:\\library') {
  return {
    fileEntryId: `fe-${name}`,
    displayName: name,
    displayPath: `${directory}\\${name}`,
    sizeBytes: 1000,
    modifiedAt: 1700000000000,
    source: { id: 'src-1', name: 'Library', type: 'local-ntfs', availability: 'online' },
    indexState: ['discovered:ready'],
  }
}

function makeService(overrides = {}) {
  const items = [lexicalItem('cat.jpg'), lexicalItem('dog.jpg'), lexicalItem('bird.jpg')]
  return new UnifiedSearchService({
    lexicalRecall: () => ({ items, total: items.length }),
    ...overrides,
  })
}

test('model missing: metadata results still return, marked metadata-only with actionable hint', async () => {
  const service = makeService()
  const response = await service.search({ query: 'cat' })
  assert.equal(response.items.length, 3, 'lexical results must not be hidden by missing AI')
  for (const item of response.items) {
    assert.equal(item.indexState[0], 'metadata-only')
    assert.equal(item.degradedReason, 'model-missing')
  }
  assert.equal(response.aiEnhancement, 'unavailable')
  assert.equal(response.degradedReason, 'model-missing')
  assert.match(response.actionableHint, /模型/)
  const semantic = response.lanes.find((lane) => lane.lane === 'semantic')
  assert.equal(semantic.status, 'unavailable')
  assert.equal(semantic.degradedReason, 'model-missing')
})

test('vector corrupt: fails closed with vector-corrupt, lexical results unaffected', async () => {
  const service = makeService({
    vectorHealth: () => ({ status: 'vector-corrupt', detail: 'manifest sha mismatch' }),
    semanticRecall: async () => {
      throw new Error('must never be called on a corrupt store')
    },
  })
  const response = await service.search({ query: 'cat' })
  assert.equal(response.items.length, 3)
  assert.equal(response.degradedReason, 'vector-corrupt')
  assert.match(response.actionableHint, /重建向量索引/)
  const semantic = response.lanes.find((lane) => lane.lane === 'semantic')
  assert.equal(semantic.status, 'unavailable')
  assert.equal(semantic.degradedReason, 'vector-corrupt')
  assert.equal(semantic.detail, 'manifest sha mismatch')
})

test('index not built yet: index-stale with enhancement hint, not an empty result', async () => {
  const service = makeService({
    vectorHealth: () => ({ status: 'index-stale', detail: 'No committed vector generation' }),
    semanticRecall: async () => [{ displayPath: 'D:\\library\\cat.jpg', score: 0.9 }],
  })
  const response = await service.search({ query: 'cat' })
  assert.equal(response.items.length, 3)
  assert.equal(response.aiEnhancement, 'unavailable')
  assert.equal(response.degradedReason, 'index-stale')
  assert.match(response.actionableHint, /embedding/)
})

test('recall task failure: lane degraded task-failed, metadata results still returned', async () => {
  const service = makeService({
    vectorHealth: () => ({ status: 'ready' }),
    semanticRecall: async () => {
      throw new Error('worker crashed')
    },
  })
  const response = await service.search({ query: 'cat' })
  assert.equal(response.items.length, 3)
  const semantic = response.lanes.find((lane) => lane.lane === 'semantic')
  assert.equal(semantic.status, 'degraded')
  assert.equal(semantic.degradedReason, 'task-failed')
  assert.equal(semantic.detail, 'worker crashed')
})

test('incremental enhancement: metadata-only first, semantic re-rank after indexing', async () => {
  let health = { status: 'index-stale', detail: 'not built' }
  const service = makeService({
    vectorHealth: () => health,
    semanticRecall: async () => [{ displayPath: 'd:/library/bird.jpg', score: 0.95 }],
  })
  const before = await service.search({ query: 'bird' })
  assert.equal(before.items[0].displayName, 'cat.jpg', 'lexical order before AI is ready')
  assert.equal(before.items[0].indexState[0], 'metadata-only')
  assert.equal(before.aiEnhancement, 'unavailable')
  // Embedding stage completes; the same query is now enhanced.
  health = { status: 'ready' }
  const after = await service.search({ query: 'bird' })
  assert.equal(after.aiEnhancement, 'ready')
  assert.equal(after.items[0].displayName, 'bird.jpg', 'semantic hit re-ranks to the front')
  assert.equal(after.items[0].indexState[0], 'full')
  assert.equal(after.items[0].scoreBreakdown.semantic, 0.95)
  assert.equal(after.items[0].degradedReason, undefined)
})

test('reference image activates subject and duplicate lanes while text semantic is not applicable', async () => {
  const service = makeService({
    subjectRecall: async () => [{ displayPath: 'D:\\library\\dog.jpg', score: 0.7 }],
    duplicateRecall: async () => [{ displayPath: 'D:\\library\\bird.jpg', score: 1 }],
  })
  const response = await service.search({ referenceImagePath: 'D:\\query.jpg' })
  const dog = response.items.find((item) => item.displayName === 'dog.jpg')
  assert.equal(dog.indexState[0], 'full')
  assert.equal(dog.scoreBreakdown.subject, 0.7)
  assert.equal(response.items[0].displayName, 'bird.jpg')
  assert.equal(response.items[0].scoreBreakdown.duplicate, 1)
  assert.equal(response.aiEnhancement, 'ready')
  assert.equal(response.lanes.find((lane) => lane.lane === 'semantic').status, 'not-applicable')
})

test('expired mask capability degrades the subject lane without falling back to a box search', async () => {
  let subjectCalls = 0
  const service = makeService({
    subjectRecall: async (_request, context) => {
      subjectCalls += 1
      if (context?.subjectMaskError) throw new Error(context.subjectMaskError)
      return [{ displayPath: 'D:\\library\\dog.jpg', score: 0.7 }]
    },
    duplicateRecall: async () => [],
  })
  const response = await service.search(
    {
      referenceImagePath: 'D:\\query.jpg',
      subject: { x: 1, y: 2, w: 30, h: 40, confidence: 1, label: 'sam' },
      segmentationSessionId: '12345678-1234-1234-1234-123456789abc',
    },
    { subjectMaskError: 'The segmentation expired' },
  )
  assert.equal(subjectCalls, 1)
  const subjectLane = response.lanes.find((lane) => lane.lane === 'subject')
  assert.equal(subjectLane.status, 'degraded')
  assert.match(subjectLane.detail, /segmentation expired/)
  assert.equal(
    response.items.find((item) => item.displayName === 'dog.jpg').scoreBreakdown,
    undefined,
  )
})

test('text-only request does not misreport image-only lanes as missing models', async () => {
  const service = makeService({
    vectorHealth: () => ({ status: 'ready' }),
    semanticRecall: async () => [],
  })
  const response = await service.search({ query: 'dog' })
  assert.equal(response.lanes.find((lane) => lane.lane === 'subject').status, 'not-applicable')
  assert.equal(response.lanes.find((lane) => lane.lane === 'duplicate').status, 'not-applicable')
  assert.equal(response.degradedReason, undefined)
})

test('semantic-only hits extend the result set only after catalog hydration', async () => {
  const service = makeService({
    vectorHealth: () => ({ status: 'ready' }),
    semanticRecall: async () => [{ displayPath: 'D:\\other\\unknown.png', score: 0.5 }],
    hydrateRecallItems: (paths) =>
      paths.includes('D:\\other\\unknown.png') ? [lexicalItem('unknown.png', 'D:\\other')] : [],
  })
  const response = await service.search({ query: 'cat' })
  assert.equal(response.items.length, 4)
  const extra = response.items.find((item) => item.displayPath === 'D:\\other\\unknown.png')
  assert.equal(extra.scoreBreakdown.semantic, 0.5)
  assert.equal(extra.indexState[0], 'full')
  assert.notEqual(extra.fileEntryId, '')
  assert.equal(extra.source.id, 'src-1')
})

test('derived recall aliases preserve authoritative remote identity without duplicates', async () => {
  const remote = {
    ...lexicalItem('movie.mp4'),
    fileEntryId: 'remote-video-1',
    displayPath: 'sftp://nas/media/movie.mp4',
    source: { id: 'sftp-1', name: 'NAS', type: 'sftp', availability: 'online' },
  }
  const service = new UnifiedSearchService({
    lexicalRecall: () => ({ items: [remote], total: 1 }),
    vectorHealth: () => ({ status: 'ready' }),
    semanticRecall: async () => [
      { displayPath: 'C:\\cache\\movie.mp4', score: 0.88, videoId: 'video-1' },
    ],
    hydrateRecallItems: () => [{ ...remote, recallPath: 'C:\\cache\\movie.mp4' }],
  })
  const response = await service.search({ query: 'movie' })
  assert.equal(response.items.length, 1)
  assert.equal(response.items[0].displayPath, remote.displayPath)
  assert.equal(response.items[0].fileEntryId, remote.fileEntryId)
  assert.equal(response.items[0].videoId, 'video-1')
  assert.equal(response.items[0].scoreBreakdown.semantic, 0.88)
})

test('semantic hits absent from the catalog are never exposed as placeholder records', async () => {
  const service = makeService({
    vectorHealth: () => ({ status: 'ready' }),
    semanticRecall: async () => [{ displayPath: 'D:\\other\\orphan.png', score: 0.5 }],
    hydrateRecallItems: () => [],
  })
  const response = await service.search({ query: 'cat' })
  assert.equal(response.items.length, 3)
  assert.equal(
    response.items.some((item) => item.displayPath.includes('orphan.png')),
    false,
  )
})

test('successful semantic recall with zero hits is ready, and merged results obey pagination', async () => {
  const zeroHit = makeService({
    vectorHealth: () => ({ status: 'ready' }),
    semanticRecall: async () => [],
  })
  assert.equal((await zeroHit.search({ query: 'none' })).aiEnhancement, 'ready')

  const paged = makeService({
    vectorHealth: () => ({ status: 'ready' }),
    semanticRecall: async () => [{ displayPath: 'D:\\library\\bird.jpg', score: 0.9 }],
  })
  const response = await paged.search({ query: 'bird', offset: 1, limit: 1 })
  assert.equal(response.items.length, 1)
  assert.equal(response.items[0].displayName, 'cat.jpg')
  assert.equal(response.total, 3)
})

test('lexical lane failure surfaces task-failed instead of a silent empty page', async () => {
  const service = new UnifiedSearchService({
    lexicalRecall: () => {
      throw new Error('catalog database locked')
    },
  })
  const response = await service.search({ query: 'cat' })
  const lexical = response.lanes.find((lane) => lane.lane === 'lexical')
  assert.equal(lexical.status, 'degraded')
  assert.equal(lexical.degradedReason, 'task-failed')
  assert.equal(lexical.detail, 'catalog database locked')
  assert.equal(response.degradedReason, 'task-failed')
})

test('visual, semantic, OCR, ASR and audio-event hits fuse by time with full provenance', async () => {
  const video = lexicalItem('scene.mp4')
  const service = new UnifiedSearchService({
    lexicalRecall: () => ({ items: [video], total: 1 }),
    videoRecall: async () => [
      {
        displayPath: video.displayPath,
        score: 0.91,
        videoId: 'video-1',
        durationMs: 120000,
        videoHit: {
          timestampMs: 42000,
          score: 0.91,
          kind: 'visual',
          evidenceSources: ['cached-frame'],
          frameId: 'frame-42',
        },
      },
      {
        displayPath: video.displayPath,
        score: 0.82,
        videoId: 'video-1',
        durationMs: 120000,
        videoHit: {
          timestampMs: 12000,
          score: 0.82,
          kind: 'visual',
          evidenceSources: ['cached-frame'],
          frameId: 'frame-12',
        },
      },
    ],
    videoSemanticRecall: async () => [
      {
        displayPath: video.displayPath,
        score: 0.8,
        videoId: 'video-1',
        durationMs: 120000,
        videoHit: {
          timestampMs: 41000,
          endMs: 44000,
          score: 0.8,
          kind: 'semantic',
          evidenceSources: ['ai-visual-semantic', 'ocr'],
          text: 'visual semantic evidence',
          generatedBy: { modelId: 'qwen3-vl', modelRevision: 'qwen-revision' },
        },
      },
    ],
    subtitleRecall: async () => [
      {
        displayPath: video.displayPath,
        score: 0.74,
        videoId: 'video-1',
        durationMs: 120000,
        videoHit: {
          timestampMs: 40500,
          score: 0.74,
          kind: 'subtitle',
          evidenceSources: ['transcript-reference', 'audio-event'],
          text: 'the searched phrase',
          endMs: 43000,
          generatedBy: { modelId: 'sensevoice', modelRevision: 'sense-revision' },
        },
      },
    ],
  })
  const response = await service.search({ query: 'searched phrase' })
  assert.equal(response.items.length, 1)
  const result = response.items[0]
  assert.equal(result.fileEntryId, video.fileEntryId)
  assert.equal(result.displayPath, video.displayPath)
  assert.equal(result.mediaType, 'video')
  assert.equal(result.videoId, 'video-1')
  assert.equal(result.durationMs, 120000)
  assert.equal(result.videoHitMs, 40500)
  assert.deepEqual(
    result.videoHits.map((hit) => [hit.kind, hit.timestampMs]),
    [
      ['fused', 40500],
      ['visual', 12000],
    ],
  )
  assert.deepEqual(result.videoHits[0].evidenceSources, [
    'cached-frame',
    'ai-visual-semantic',
    'ocr',
    'transcript-reference',
    'audio-event',
  ])
  assert.deepEqual(result.videoHits[0].generatedByAll, [
    { modelId: 'sensevoice', modelRevision: 'sense-revision' },
    { modelId: 'qwen3-vl', modelRevision: 'qwen-revision' },
  ])
  assert.equal(result.scoreBreakdown['video-frame'], 0.91)
  assert.equal(result.scoreBreakdown['video-semantic'], 0.8)
  assert.equal(result.scoreBreakdown.subtitle, 0.74)
  assert.ok(Math.abs(result.score - 2.45) < 1e-12)
})

test('multiple frame hits keep the strongest lane score instead of inflating ranking', async () => {
  const video = lexicalItem('scene.mp4')
  const service = new UnifiedSearchService({
    lexicalRecall: () => ({ items: [video], total: 1 }),
    videoRecall: async () =>
      Array.from({ length: 12 }, (_, index) => ({
        displayPath: video.displayPath,
        score: 0.9 - index / 100,
        videoId: 'video-1',
        videoHit: {
          timestampMs: index * 1000,
          score: 0.9 - index / 100,
          kind: 'visual',
          evidenceSources: ['cached-frame'],
          frameId: `frame-${index}`,
        },
      })),
  })
  const result = (await service.search({ referenceImagePath: 'D:\\query.jpg' })).items[0]
  assert.equal(result.score, 0.9)
  assert.equal(result.scoreBreakdown['video-frame'], 0.9)
  assert.equal(result.videoHits.length, 8)
  assert.equal(result.videoHitMs, 0)
})

test('bounded raw candidates preserve a low-score transcript long enough to fuse before display cap', async () => {
  const video = lexicalItem('conversation.mp4')
  const service = new UnifiedSearchService({
    lexicalRecall: () => ({ items: [video], total: 1 }),
    videoRecall: async () =>
      Array.from({ length: 12 }, (_, index) => ({
        displayPath: video.displayPath,
        score: 0.9 - index / 100,
        videoId: 'video-1',
        videoHit: {
          timestampMs: index * 10_000,
          score: 0.9 - index / 100,
          kind: 'visual',
          evidenceSources: ['cached-frame'],
          frameId: `frame-${index}`,
        },
      })),
    subtitleRecall: async () => [
      {
        displayPath: video.displayPath,
        score: 0.05,
        videoId: 'video-1',
        videoHit: {
          timestampMs: 110_500,
          endMs: 111_500,
          score: 0.05,
          kind: 'subtitle',
          evidenceSources: ['transcript-reference'],
          text: 'low-score ASR evidence',
        },
      },
    ],
  })
  const result = (await service.search({ query: 'conversation' })).items[0]
  assert.equal(result.videoHits.length, 8)
  assert.equal(result.videoHits[0].kind, 'fused')
  assert.deepEqual(result.videoHits[0].evidenceSources, ['cached-frame', 'transcript-reference'])
  assert.equal(result.videoHitMs, 110_000)
  assert.equal(result.scoreBreakdown['video-frame'], 0.9)
  assert.equal(result.scoreBreakdown.subtitle, 0.05)
})

test('SFTP video metadata explains that the remote original is required for deep recall', async () => {
  const remoteVideo = {
    ...lexicalItem('remote.mp4'),
    displayPath: 'sftp://source/video/remote.mp4',
    source: { id: 'sftp-1', name: 'NAS', type: 'sftp', availability: 'online' },
  }
  const service = new UnifiedSearchService({
    lexicalRecall: () => ({ items: [remoteVideo], total: 1 }),
    videoRecall: async () => [],
    subtitleRecall: async () => [],
  })
  const result = (await service.search({ query: 'remote' })).items[0]
  assert.equal(result.mediaType, 'video')
  assert.equal(result.indexState[0], 'metadata-only')
  assert.equal(result.degradedReason, 'remote-content-required')
})

test('offline SFTP video prioritizes source connectivity over content retrieval guidance', async () => {
  const remoteVideo = {
    ...lexicalItem('offline.mp4'),
    displayPath: 'sftp://source/video/offline.mp4',
    source: { id: 'sftp-1', name: 'NAS', type: 'sftp', availability: 'offline' },
  }
  const service = new UnifiedSearchService({
    lexicalRecall: () => ({ items: [remoteVideo], total: 1 }),
    videoRecall: async () => [],
    subtitleRecall: async () => [],
  })
  assert.equal(
    (await service.search({ query: 'offline' })).items[0].degradedReason,
    'source-offline',
  )
})
