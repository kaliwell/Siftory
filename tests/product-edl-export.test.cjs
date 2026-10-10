const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const ROOT = path.resolve(__dirname, '..')
const { normalizeUnifiedSearchExportRequest } = loadTsModule('electron/unifiedSearchExport.ts')
const {
  cmxTimecodeFromFrameNumber,
  millisecondsToCmxTimecode,
  serializeUnifiedSearchEdl,
  validateCmx3600Edl,
} = loadTsModule('electron/unifiedSearchEdlExport.ts')

function item(name, mediaType, evidence, extra = {}) {
  return {
    fileEntryId: `file-${name}`,
    videoId: mediaType === 'video' ? `video-${name}` : undefined,
    mediaType,
    displayName: name,
    displayPath: `D:\\library\\${name}`,
    sizeBytes: 100,
    modifiedAt: 1_700_000_000_000,
    source: { id: 'source-1', name: 'Library', type: 'local-ntfs', availability: 'online' },
    indexState: ['full'],
    evidence,
    ...extra,
  }
}

function evidence(startMs, endMs, summary = 'door opens') {
  return {
    lane: 'video-semantic',
    hitType: 'video-semantic',
    summary,
    startMs,
    ...(endMs === undefined ? {} : { endMs }),
    confidence: 0.9,
    evidenceSources: ['ai-visual-semantic'],
    modelSources: [{ modelId: 'qwen3-vl', modelRevision: '2b-q4' }],
  }
}

test('CMX3600 timecodes cover integer, fractional, and drop-frame rates', () => {
  assert.equal(cmxTimecodeFromFrameNumber(25, 25), '00:00:01:00')
  assert.equal(millisecondsToCmxTimecode(1_000, 23.976), '00:00:01:00')
  assert.equal(millisecondsToCmxTimecode(60_000, 29.97), '00:00:59;28')
  assert.equal(millisecondsToCmxTimecode(600_000, 29.97), '00:10:00;00')
  assert.equal(millisecondsToCmxTimecode(600_000, 59.94), '00:10:00;00')
})

test('EDL export emits importable events and explicitly reports clamped and skipped results', () => {
  const request = normalizeUnifiedSearchExportRequest({
    format: 'edl',
    frameRate: 25,
    search: { query: 'door opens' },
    items: [
      item('scene.mp4', 'video', [evidence(8_000, 12_000)], { durationMs: 10_000 }),
      item('poster.jpg', 'image', []),
    ],
  })
  const result = serializeUnifiedSearchEdl(request)
  assert.equal(result.exportedCount, 1)
  assert.equal(result.clampedCount, 1)
  assert.equal(result.skippedCount, 1)
  assert.match(result.content, /^TITLE: SIFTORY SEARCH RESULTS\r?$/m)
  assert.match(result.content, /^FCM: NON-DROP FRAME\r?$/m)
  assert.match(
    result.content,
    /^001\s{2}SFT00001\s+V\s+C\s+00:00:08:00 00:00:10:00 01:00:00:00 01:00:02:00\r?$/m,
  )
  assert.match(result.content, /\* FROM CLIP NAME: scene\.mp4/)
  assert.match(result.content, /\* SOURCE FILE: D:\\library\\scene\.mp4/)
  assert.match(result.content, /\* SIFTORY RANGE CLAMPED TO SOURCE DURATION/)
  const validation = validateCmx3600Edl(result.content)
  assert.deepEqual(validation, { ok: true, eventCount: 1, errors: [] })
})

test('drop-frame EDL uses semicolon timecodes and deduplicates identical ranges', () => {
  const request = normalizeUnifiedSearchExportRequest({
    format: 'edl',
    frameRate: 29.97,
    search: {},
    items: [
      item('drop.mp4', 'video', [
        evidence(60_000, 61_000),
        evidence(60_000, 61_000, 'duplicate evidence'),
      ]),
    ],
  })
  const result = serializeUnifiedSearchEdl(request)
  assert.equal(result.exportedCount, 1)
  assert.match(result.content, /^FCM: DROP FRAME\r?$/m)
  assert.match(result.content, /00:00:59;28/)
  assert.equal(validateCmx3600Edl(result.content).ok, true)
})

test('EDL guard requires an approved explicit frame rate and rejects unusable ranges', () => {
  assert.equal(
    normalizeUnifiedSearchExportRequest({ format: 'edl', items: [item('x.mp4', 'video', [])] }),
    undefined,
  )
  assert.equal(
    normalizeUnifiedSearchExportRequest({
      format: 'edl',
      frameRate: 27,
      items: [item('x.mp4', 'video', [])],
    }),
    undefined,
  )
  const request = normalizeUnifiedSearchExportRequest({
    format: 'edl',
    frameRate: 25,
    search: {},
    items: [item('x.mp4', 'video', [evidence(20_000, 21_000)], { durationMs: 10_000 })],
  })
  assert.throws(() => serializeUnifiedSearchEdl(request), /exportable time range/)
})

test('simple UI exposes frame rate and EDL export through the guarded save route', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'src', 'components', 'UnifiedSearchPanel.tsx'), 'utf8')
  const ipc = fs.readFileSync(path.join(ROOT, 'electron', 'unifiedSearchIpc.ts'), 'utf8')
  assert.match(ui, /data-testid="unified-search-timeline-frame-rate"/)
  assert.match(ui, /data-testid="unified-search-export-edl"/)
  assert.match(ui, /exportSelected\('edl'\)/)
  assert.match(ipc, /serializeUnifiedSearchEdl/)
  assert.match(ipc, /validateCmx3600Edl/)
})
