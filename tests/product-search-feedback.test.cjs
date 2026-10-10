const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const ROOT = path.resolve(__dirname, '..')
const { UnifiedSearchFeedbackStore } = loadTsModule('electron/unifiedSearchFeedbackStore.ts')
const { UnifiedSearchService } = loadTsModule('electron/unifiedSearchService.ts')
const { normalizeUnifiedSearchFeedback } = loadTsModule('electron/unifiedSearchGuards.ts')

function item(name, extra = {}) {
  return {
    fileEntryId: `file-${name}`,
    displayName: name,
    displayPath: `D:\\private-library\\${name}`,
    sizeBytes: 1,
    modifiedAt: 1,
    mediaType: name.endsWith('.mp4') ? 'video' : 'image',
    source: { id: 'source-1', name: 'Library', type: 'local-ntfs', availability: 'online' },
    indexState: ['metadata-only'],
    evidence: [],
    ...extra,
  }
}

async function withStore(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-feedback-'))
  try {
    await run(new UnifiedSearchFeedbackStore(directory), directory)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('feedback guard rejects missing identities and bounds a timestamp action', () => {
  assert.equal(normalizeUnifiedSearchFeedback({ kind: 'relevant', target: {} }), undefined)
  const normalized = normalizeUnifiedSearchFeedback({
    search: { query: 'cat', offset: -10, limit: 90_000 },
    target: { fileEntryId: 'file-cat', timestampMs: 12_345.9, ignored: 'x' },
    kind: 'timestamp-wrong',
  })
  assert.equal(normalized.search.offset, 0)
  assert.equal(normalized.search.limit, 500)
  assert.deepEqual(normalized.target, { fileEntryId: 'file-cat', timestampMs: 12_345 })
})

test('feedback persists locally without query text or absolute paths and can be undone', async () => {
  await withStore(async (store, directory) => {
    const search = { query: 'private red bicycle' }
    const target = item('bicycle.jpg', { assetId: 'asset-1' })
    const saved = await store.submit({
      search,
      target: { fileEntryId: target.fileEntryId, assetId: target.assetId },
      kind: 'relevant',
    })
    assert.equal(saved.ok, true)
    assert.equal(store.rankingFor(search, target).adjustment, 0.2)

    const filePath = path.join(directory, 'search-feedback', 'unified-search.json')
    const persisted = fs.readFileSync(filePath, 'utf8')
    assert.doesNotMatch(persisted, /private red bicycle/i)
    assert.doesNotMatch(persisted, /private-library/i)

    const reloaded = new UnifiedSearchFeedbackStore(directory)
    assert.equal(reloaded.rankingFor(search, target).reason, 'relevant')
    const undone = await reloaded.undo(saved.feedbackId)
    assert.equal(undone.ok, true)
    assert.equal(reloaded.rankingFor(search, target), undefined)
  })
})

test('latest relevance is deterministic and an incorrect hit time yields the next video hit', async () => {
  await withStore(async (store) => {
    const search = { query: 'door opens' }
    const video = item('door.mp4')
    const first = await store.submit({
      search,
      target: { fileEntryId: video.fileEntryId },
      kind: 'irrelevant',
    })
    assert.equal(first.ok, true)
    const second = await store.submit({
      search,
      target: { fileEntryId: video.fileEntryId },
      kind: 'relevant',
    })
    assert.equal(second.ok, true)
    const wrongTime = await store.submit({
      search,
      target: { fileEntryId: video.fileEntryId, videoId: 'video-1', timestampMs: 10_000 },
      kind: 'timestamp-wrong',
    })
    assert.equal(wrongTime.ok, true)

    const service = new UnifiedSearchService({
      lexicalRecall: () => ({ items: [video], total: 1 }),
      vectorHealth: () => ({ status: 'ready' }),
      semanticRecall: async () => [],
      videoRecall: async () => [
        {
          displayPath: video.displayPath,
          score: 0.9,
          videoId: 'video-1',
          videoHit: {
            timestampMs: 10_000,
            score: 0.9,
            kind: 'visual',
            evidenceSources: ['cached-frame'],
          },
        },
        {
          displayPath: video.displayPath,
          score: 0.8,
          videoId: 'video-1',
          videoHit: {
            timestampMs: 20_000,
            score: 0.8,
            kind: 'visual',
            evidenceSources: ['cached-frame'],
          },
        },
      ],
      resolveRankingFeedback: (request, result) => store.rankingFor(request, result),
    })
    const response = await service.search(search)
    assert.equal(response.items[0].videoHitMs, 20_000)
    assert.equal(response.items[0].rankingFeedback.reason, 'relevant-and-timestamp-wrong')
    assert.equal(response.items[0].rankingFeedback.adjustment, 0.12)
  })
})

test('relevant and irrelevant feedback rerank results without changing raw recall scores', async () => {
  await withStore(async (store) => {
    const search = { query: 'cat' }
    const cat = item('cat.jpg')
    const dog = item('dog.jpg')
    await store.submit({
      search,
      target: { fileEntryId: dog.fileEntryId },
      kind: 'relevant',
    })
    await store.submit({
      search,
      target: { fileEntryId: cat.fileEntryId },
      kind: 'irrelevant',
    })
    const service = new UnifiedSearchService({
      lexicalRecall: () => ({ items: [cat, dog], total: 2 }),
      resolveRankingFeedback: (request, result) => store.rankingFor(request, result),
    })
    const response = await service.search(search)
    assert.deepEqual(
      response.items.map((result) => result.displayName),
      ['dog.jpg', 'cat.jpg'],
    )
    assert.equal(response.items[0].score, undefined)
    assert.equal(response.items[0].rankingFeedback.adjustment, 0.2)
  })
})

test('simple result cards expose all feedback actions, local status, undo, and explanation', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'src', 'components', 'UnifiedSearchPanel.tsx'), 'utf8')
  assert.match(ui, /data-testid="unified-search-feedback-relevant"/)
  assert.match(ui, /data-testid="unified-search-feedback-irrelevant"/)
  assert.match(ui, /data-testid="unified-search-feedback-timestamp"/)
  assert.match(ui, /data-testid="unified-search-feedback-undo"/)
  assert.match(ui, /data-testid="unified-search-feedback-explanation"/)
  assert.match(ui, /saveFeedback/)
  assert.match(ui, /undoFeedback/)
})
