const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { UnifiedSearchService } = loadTsModule('electron/unifiedSearchService.ts')

function videoItem() {
  return {
    fileEntryId: 'fe-scene',
    displayName: 'scene.mp4',
    displayPath: 'D:\\library\\scene.mp4',
    sizeBytes: 1000,
    modifiedAt: 1700000000000,
    source: { id: 'src-1', name: 'Library', type: 'local-ntfs', availability: 'online' },
    indexState: ['discovered:ready'],
  }
}

function service(overrides = {}) {
  const item = videoItem()
  return new UnifiedSearchService({
    lexicalRecall: () => ({ items: [item], total: 1 }),
    vectorHealth: () => ({ status: 'ready' }),
    semanticRecall: async () => [],
    ...overrides,
  })
}

test('video semantic lane aggregates timestamps without inflating the per-video lane score', async () => {
  const item = videoItem()
  const search = service({
    videoSemanticHealth: () => ({ status: 'ready' }),
    videoSemanticRecall: async () => [
      {
        displayPath: item.displayPath,
        score: 0.92,
        videoId: 'video-1',
        durationMs: 120_000,
        videoHit: {
          timestampMs: 42_000,
          endMs: 52_000,
          score: 0.92,
          kind: 'semantic',
          evidenceSources: ['ai-visual-semantic', 'ocr'],
          text: 'A person opens a red door.',
          generatedBy: { modelId: 'qwen3-vl-2b-instruct', modelRevision: 'revision-1' },
        },
      },
      {
        displayPath: item.displayPath,
        score: 0.75,
        videoId: 'video-1',
        durationMs: 120_000,
        videoHit: {
          timestampMs: 12_000,
          endMs: 20_000,
          score: 0.75,
          kind: 'semantic',
          evidenceSources: ['ai-visual-semantic'],
          text: 'The same room before the door opens.',
          generatedBy: { modelId: 'qwen3-vl-2b-instruct', modelRevision: 'revision-1' },
        },
      },
    ],
  })
  const response = await search.search({ query: 'opens red door' })
  const result = response.items[0]
  assert.equal(response.lanes.find((lane) => lane.lane === 'video-semantic').status, 'ok')
  assert.equal(result.videoId, 'video-1')
  assert.equal(result.videoHitMs, 42_000)
  assert.deepEqual(
    result.videoHits.map((hit) => [hit.kind, hit.timestampMs, hit.endMs]),
    [
      ['semantic', 42_000, 52_000],
      ['semantic', 12_000, 20_000],
    ],
  )
  assert.equal(result.scoreBreakdown['video-semantic'], 0.92)
  assert.equal(result.score, 0.92)
  assert.deepEqual(result.videoHits[0].evidenceSources, ['ai-visual-semantic', 'ocr'])
  assert.equal(result.videoHits[0].generatedBy.modelId, 'qwen3-vl-2b-instruct')
})

test('stale video semantic index degrades explicitly while preserving lexical results', async () => {
  const search = service({
    videoSemanticHealth: () => ({
      status: 'index-stale',
      detail: 'No active deep generation',
      actionableHint: 'Build deep video semantics',
    }),
    videoSemanticRecall: async () => {
      throw new Error('must not query a stale index')
    },
  })
  const response = await search.search({ query: 'door' })
  const lane = response.lanes.find((entry) => entry.lane === 'video-semantic')
  assert.equal(response.items.length, 1)
  assert.equal(lane.status, 'unavailable')
  assert.equal(lane.degradedReason, 'index-stale')
  assert.equal(lane.detail, 'No active deep generation')
  assert.equal(lane.actionableHint, 'Build deep video semantics')
  assert.equal(response.items[0].degradedReason, 'index-stale')
})

test('video semantic model and task failures retain distinct degradation reasons', async () => {
  const missing = await service({
    videoSemanticHealth: () => ({ status: 'model-missing' }),
    videoSemanticRecall: async () => [],
  }).search({ query: 'door' })
  const missingLane = missing.lanes.find((entry) => entry.lane === 'video-semantic')
  assert.equal(missingLane.status, 'unavailable')
  assert.equal(missingLane.degradedReason, 'model-missing')

  const failed = await service({
    videoSemanticHealth: () => ({ status: 'ready' }),
    videoSemanticRecall: async () => {
      throw new Error('deep index database locked')
    },
  }).search({ query: 'door' })
  const failedLane = failed.lanes.find((entry) => entry.lane === 'video-semantic')
  assert.equal(failedLane.status, 'degraded')
  assert.equal(failedLane.degradedReason, 'task-failed')
  assert.equal(failedLane.detail, 'deep index database locked')
})

test('video semantic lane is not applicable when no text query is supplied', async () => {
  const response = await service({
    videoSemanticHealth: () => ({ status: 'ready' }),
    videoSemanticRecall: async () => [],
  }).search({ referenceImagePath: 'D:\\query.jpg' })
  const lane = response.lanes.find((entry) => entry.lane === 'video-semantic')
  assert.equal(lane.status, 'not-applicable')
  assert.equal(lane.detail, 'Text query not supplied')
})
