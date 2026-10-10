const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const ROOT = path.resolve(__dirname, '..')
const { UnifiedSearchService } = loadTsModule('electron/unifiedSearchService.ts')
const { unifiedDegradedLabelKey, unifiedEvidenceHitLabelKey, unifiedEvidenceModelLabel } =
  loadTsModule('src/utils/unifiedSearchEvidence.ts')

function catalogItem(name = 'scene.jpg') {
  return {
    fileEntryId: `file-${name}`,
    displayName: name,
    displayPath: `D:\\library\\${name}`,
    sizeBytes: 1024,
    modifiedAt: 1_700_000_000_000,
    source: { id: 'source-1', name: 'Library', type: 'local-ntfs', availability: 'online' },
    indexState: ['discovered:ready'],
  }
}

test('main process projects filename and semantic evidence with bounded model authority', async () => {
  const item = catalogItem()
  const service = new UnifiedSearchService({
    lexicalRecall: () => ({ items: [item], total: 1 }),
    vectorHealth: () => ({ status: 'ready' }),
    semanticRecall: async () => [
      {
        displayPath: item.displayPath,
        score: 1.4,
        evidenceSummary: 'red bicycle beside a wall',
        modelSources: [{ modelId: 'clip_vit_base_patch32' }],
      },
    ],
  })

  const response = await service.search({ query: 'red bicycle' })
  assert.deepEqual(
    response.items[0].evidence.map((entry) => entry.hitType),
    ['filename', 'image-semantic'],
  )
  const semantic = response.items[0].evidence[1]
  assert.equal(semantic.summary, 'red bicycle beside a wall')
  assert.equal(semantic.confidence, 1, 'confidence is clamped before crossing IPC')
  assert.deepEqual(semantic.modelSources, [{ modelId: 'clip_vit_base_patch32' }])
})

test('fused video evidence preserves time range, sources, confidence, and every model', async () => {
  const item = catalogItem('scene.mp4')
  const service = new UnifiedSearchService({
    lexicalRecall: () => ({ items: [item], total: 1 }),
    vectorHealth: () => ({ status: 'ready' }),
    semanticRecall: async () => [],
    videoRecall: async () => [
      {
        displayPath: item.displayPath,
        score: 0.81,
        videoId: 'video-1',
        videoHit: {
          timestampMs: 10_000,
          score: 0.81,
          kind: 'visual',
          frameId: 'frame-10',
          evidenceSources: ['cached-frame'],
          generatedBy: { modelId: 'clip_vit_base_patch32' },
        },
      },
    ],
    subtitleRecall: async () => [
      {
        displayPath: item.displayPath,
        score: 0.9,
        videoId: 'video-1',
        videoHit: {
          timestampMs: 10_500,
          endMs: 12_000,
          score: 0.9,
          kind: 'subtitle',
          text: 'We found the red bicycle.',
          evidenceSources: ['transcript-reference'],
          generatedBy: { modelId: 'sensevoice-small', modelRevision: '2026-08' },
        },
      },
    ],
  })

  const response = await service.search({ query: 'red bicycle' })
  const fused = response.items[0].evidence.find((entry) => entry.hitType === 'mixed')
  assert.ok(fused)
  assert.equal(fused.startMs, 10_000)
  assert.equal(fused.endMs, 12_000)
  assert.equal(fused.confidence, 0.9)
  assert.deepEqual(fused.evidenceSources, ['cached-frame', 'transcript-reference'])
  assert.deepEqual(fused.modelSources, [
    { modelId: 'clip_vit_base_patch32' },
    { modelId: 'sensevoice-small', modelRevision: '2026-08' },
  ])
  assert.match(fused.summary, /red bicycle/)
})

test('renderer formats only the main-process evidence contract', () => {
  const evidence = {
    lane: 'video-semantic',
    hitType: 'video-semantic',
    summary: 'a person enters the room',
    modelSources: [{ modelId: 'qwen3-vl', modelRevision: '2b-q4' }],
  }
  assert.equal(unifiedEvidenceHitLabelKey(evidence), 'Video semantic match')
  assert.equal(unifiedEvidenceModelLabel(evidence), 'qwen3-vl@2b-q4')
  assert.equal(unifiedDegradedLabelKey('source-offline'), 'Source is offline')

  const ui = fs.readFileSync(path.join(ROOT, 'src', 'components', 'UnifiedSearchPanel.tsx'), 'utf8')
  assert.match(ui, /data-testid="unified-search-evidence-card"/)
  assert.match(ui, /evidence\.summary/)
  assert.match(ui, /evidence\.confidence/)
  assert.match(ui, /unifiedEvidenceModelLabel\(evidence\)/)
  assert.match(ui, /unifiedDegradedLabelKey\(item\.degradedReason\)/)
})
