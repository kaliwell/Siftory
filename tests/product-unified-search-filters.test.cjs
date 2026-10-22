const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { loadTsModule } = require('./guard-utils.cjs')
const { normalizeUnifiedSearchQuery } = loadTsModule('electron/unifiedSearchGuards.ts')
const { UnifiedSearchService, classifyUnifiedOrientation, matchesUnifiedSearchFilters } =
  loadTsModule('electron/unifiedSearchService.ts')

const ROOT = path.resolve(__dirname, '..')

function item(name, sourceId, modifiedAt) {
  return {
    fileEntryId: `file-${name}`,
    displayName: name,
    displayPath: `D:\\library\\${name}`,
    sizeBytes: 100,
    modifiedAt,
    source: {
      id: sourceId,
      name: sourceId,
      type: 'local-ntfs',
      availability: 'online',
    },
    indexState: ['discovered:ready'],
  }
}

test('filter guard allowlists arrays, bounds ranges, and removes hostile values', () => {
  const normalized = normalizeUnifiedSearchQuery({
    filters: {
      mediaTypes: ['video', 'video', 'executable'],
      sourceIds: ['source-1', '', 'x'.repeat(200)],
      modifiedAfter: 200,
      modifiedBefore: 100,
      minDurationMs: 9000,
      maxDurationMs: 1000,
      orientations: ['portrait', 'sideways'],
      indexLevels: ['full', 'corrupt'],
    },
  })

  assert.deepEqual(normalized.filters, {
    mediaTypes: ['video'],
    sourceIds: ['source-1', 'x'.repeat(128)],
    modifiedAfter: 100,
    modifiedBefore: 200,
    minDurationMs: 1000,
    maxDurationMs: 9000,
    orientations: ['portrait'],
    indexLevels: ['full'],
  })
})

test('filter predicate handles media, source, date, duration, orientation, and index level', () => {
  const candidate = {
    mediaType: 'video',
    source: { id: 'source-2' },
    modifiedAt: 200,
    durationMs: 120_000,
    width: 1080,
    height: 1920,
    indexState: ['full'],
  }
  assert.equal(classifyUnifiedOrientation(1920, 1080), 'landscape')
  assert.equal(classifyUnifiedOrientation(1000, 980), 'square')
  assert.equal(
    matchesUnifiedSearchFilters(candidate, {
      mediaTypes: ['video'],
      sourceIds: ['source-2'],
      modifiedAfter: 100,
      modifiedBefore: 300,
      minDurationMs: 60_000,
      maxDurationMs: 300_000,
      orientations: ['portrait'],
      indexLevels: ['full'],
    }),
    true,
  )
  assert.equal(matchesUnifiedSearchFilters(candidate, { orientations: ['landscape'] }), false)
  assert.equal(matchesUnifiedSearchFilters(candidate, { maxDurationMs: 60_000 }), false)
})

test('service filters the merged authoritative result before pagination', async () => {
  const items = [
    item('photo.jpg', 'source-1', 100),
    item('portrait.mp4', 'source-2', 200),
    item('song.mp3', 'source-2', 300),
  ]
  const service = new UnifiedSearchService({
    lexicalRecall: () => ({ items, total: items.length }),
    vectorHealth: () => ({ status: 'ready' }),
    semanticRecall: async () => [
      { displayPath: 'D:\\library\\photo.jpg', score: 0.5 },
      {
        displayPath: 'D:\\library\\portrait.mp4',
        score: 0.9,
        durationMs: 120_000,
        width: 1080,
        height: 1920,
      },
    ],
  })

  const response = await service.search({
    query: 'portrait',
    offset: 0,
    limit: 1,
    filters: {
      mediaTypes: ['video'],
      sourceIds: ['source-2'],
      modifiedAfter: 150,
      modifiedBefore: 250,
      minDurationMs: 60_000,
      maxDurationMs: 300_000,
      orientations: ['portrait'],
      indexLevels: ['full'],
    },
  })

  assert.equal(response.total, 1)
  assert.equal(response.items.length, 1)
  assert.equal(response.items[0].displayName, 'portrait.mp4')
  assert.equal(response.items[0].width, 1080)
  assert.equal(response.items[0].durationMs, 120_000)
})

test('simple unified search UI keeps every core filter directly reachable', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'src/components/UnifiedSearchPanel.tsx'), 'utf8')
  for (const id of [
    'unified-search-source-filter',
    'unified-search-media-filter',
    'unified-search-duration-filter',
    'unified-search-orientation-filter',
    'unified-search-index-filter',
  ]) {
    assert.match(ui, new RegExp(`data-testid="${id}"`))
  }
  assert.match(ui, /type="date"/)
  assert.match(ui, /Object\.keys\(filters\)\.length \? \{ filters \} : \{\}/)
  assert.doesNotMatch(ui, /<details[^>]*>(?:(?!<\/details>)[\s\S])*unified-search-filters/)
})
