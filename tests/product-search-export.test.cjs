const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const ROOT = path.resolve(__dirname, '..')
const {
  normalizeUnifiedSearchExportPath,
  normalizeUnifiedSearchExportRequest,
  projectUnifiedSearchExportDocument,
  serializeUnifiedSearchExport,
} = loadTsModule('electron/unifiedSearchExport.ts')

function rawRequest(format = 'json') {
  return {
    format,
    search: {
      query: '=red, bicycle',
      referenceImagePath: 'D:\\private\\reference.jpg',
      filters: { mediaTypes: ['video'], sourceIds: ['source-1'] },
    },
    items: [
      {
        fileEntryId: 'file-1',
        assetId: 'asset-1',
        videoId: 'video-1',
        mediaType: 'video',
        displayName: '=scene, "one".mp4',
        displayPath: 'D:\\library\\scene, "one".mp4',
        sizeBytes: 1234,
        modifiedAt: 1_700_000_000_000,
        durationMs: 60_000,
        width: 1080,
        height: 1920,
        source: {
          id: 'source-1',
          name: 'Local library',
          type: 'local-ntfs',
          availability: 'online',
        },
        indexState: ['full', 'video-semantic:ready'],
        degradedReason: 'index-stale',
        score: 0.91,
        scoreBreakdown: { secretLane: 99 },
        rankingFeedback: { adjustment: 0.2, reason: 'relevant' },
        evidence: [
          {
            lane: 'subtitle',
            hitType: 'dialogue',
            summary: '+Open the door, please.',
            confidence: 0.88,
            startMs: 12_000,
            endMs: 15_000,
            evidenceSources: ['transcript-reference'],
            modelSources: [{ modelId: 'sensevoice', modelRevision: 'r1' }],
          },
        ],
        hostile: 'must not export',
      },
    ],
  }
}

test('export guard reprojects selected results to a controlled field set', () => {
  const normalized = normalizeUnifiedSearchExportRequest(rawRequest())
  assert.equal(normalized.items.length, 1)
  assert.equal(normalized.items[0].displayName, '=scene, "one".mp4')
  assert.equal(normalized.items[0].hostile, undefined)
  assert.equal(normalized.items[0].scoreBreakdown, undefined)
  assert.equal(normalized.items[0].rankingFeedback, undefined)
  assert.equal(normalizeUnifiedSearchExportRequest({ format: 'xml', items: [] }), undefined)
  assert.equal(normalizeUnifiedSearchExportRequest({ format: 'json', items: [] }), undefined)
})

test('JSON export contains identity, query, hit range, and evidence without reference path leakage', () => {
  const request = normalizeUnifiedSearchExportRequest(rawRequest('json'))
  const document = projectUnifiedSearchExportDocument(request, 1_700_000_000_000)
  assert.equal(document.schema, 'siftory-unified-search-export/v1')
  assert.equal(document.query.text, '=red, bicycle')
  assert.equal(document.query.referenceImageUsed, true)
  assert.equal(document.resultCount, 1)
  assert.equal(document.results[0].fileEntryId, 'file-1')
  assert.equal(document.results[0].evidence[0].startMs, 12_000)
  assert.equal(document.results[0].evidence[0].endMs, 15_000)
  assert.deepEqual(document.results[0].evidence[0].models, ['sensevoice@r1'])
  const serialized = serializeUnifiedSearchExport(request, 1_700_000_000_000)
  assert.doesNotMatch(serialized, /private\\reference/i)
  assert.doesNotMatch(serialized, /secretLane|must not export/)
})

test('CSV export is quoted, Excel-injection safe, UTF-8 BOM encoded, and evidence-complete', () => {
  const request = normalizeUnifiedSearchExportRequest(rawRequest('csv'))
  const csv = serializeUnifiedSearchExport(request, 1_700_000_000_000)
  assert.equal(csv.charCodeAt(0), 0xfeff)
  assert.match(csv, /"'=red, bicycle"/)
  assert.match(csv, /"'=scene, ""one""\.mp4"/)
  assert.match(csv, /"'\+Open the door, please\."/)
  assert.match(csv, /"12000","15000"/)
  assert.match(csv, /"transcript-reference"/)
  assert.match(csv, /"sensevoice@r1"/)
  assert.ok(csv.endsWith('\r\n'))
})

test('export paths must be absolute and receive the selected controlled extension', () => {
  assert.equal(normalizeUnifiedSearchExportPath('relative\\results', 'json'), undefined)
  assert.equal(
    normalizeUnifiedSearchExportPath('D:\\exports\\results', 'csv'),
    'D:\\exports\\results.csv',
  )
  assert.equal(
    normalizeUnifiedSearchExportPath('D:\\exports\\results.JSON', 'json'),
    'D:\\exports\\results.JSON',
  )
})

test('simple search UI exports only selected results through the guarded main-process dialog', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'src', 'components', 'UnifiedSearchPanel.tsx'), 'utf8')
  const ipc = fs.readFileSync(path.join(ROOT, 'electron', 'unifiedSearchIpc.ts'), 'utf8')
  assert.match(ui, /data-testid="unified-search-export-json"/)
  assert.match(ui, /data-testid="unified-search-export-csv"/)
  assert.match(ui, /selectedIds\.has\(item\.fileEntryId\)/)
  assert.match(ui, /unifiedSearch\.exportResults/)
  assert.match(ipc, /dialog\.showSaveDialog/)
  assert.match(ipc, /normalizeUnifiedSearchExportPath/)
  assert.doesNotMatch(ui, /writeFile|showSaveDialog/)
})
