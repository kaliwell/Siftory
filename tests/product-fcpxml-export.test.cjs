const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const ROOT = path.resolve(__dirname, '..')
const { normalizeUnifiedSearchExportRequest } = loadTsModule('electron/unifiedSearchExport.ts')
const { fcpxmlFrameDuration, fcpxmlTimeFromFrames, serializeUnifiedSearchFcpxml, validateFcpxml } =
  loadTsModule('electron/unifiedSearchFcpxmlExport.ts')

function item(name, mediaType, evidence, extra = {}) {
  return {
    fileEntryId: `file-${name}`,
    videoId: mediaType === 'video' ? `video-${name}` : undefined,
    mediaType,
    displayName: name,
    displayPath: `D:\\素材库\\${name}`,
    sizeBytes: 100,
    modifiedAt: 1_700_000_000_000,
    source: { id: 'source-1', name: '素材库', type: 'local-ntfs', availability: 'online' },
    indexState: ['full'],
    width: 1080,
    height: 1920,
    evidence,
    ...extra,
  }
}

function evidence(startMs, endMs, summary = 'door & person <enter>') {
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

test('FCPXML timing uses exact rational frame durations for every accepted fractional rate', () => {
  assert.deepEqual(fcpxmlFrameDuration(23.976), { numerator: 1001, denominator: 24000 })
  assert.deepEqual(fcpxmlFrameDuration(29.97), { numerator: 1001, denominator: 30000 })
  assert.deepEqual(fcpxmlFrameDuration(59.94), { numerator: 1001, denominator: 60000 })
  assert.deepEqual(fcpxmlFrameDuration(25), { numerator: 1, denominator: 25 })
  assert.equal(fcpxmlTimeFromFrames(24, 23.976), '1001/1000s')
  assert.equal(fcpxmlTimeFromFrames(25, 25), '1s')
  assert.equal(fcpxmlTimeFromFrames(0, 25), '0s')
})

test('FCPXML preserves local media URIs, source ranges, portrait format, and escaped evidence', () => {
  const request = normalizeUnifiedSearchExportRequest({
    format: 'fcpxml',
    frameRate: 25,
    search: { query: 'person & "door" <open>' },
    items: [
      item('scene & "one".mp4', 'video', [evidence(12_000, 15_000)], {
        durationMs: 60_000,
      }),
    ],
  })
  const result = serializeUnifiedSearchFcpxml(request)
  assert.equal(result.exportedCount, 1)
  assert.equal(result.skippedCount, 0)
  assert.equal(result.clampedCount, 0)
  assert.match(result.content, /<fcpxml version="1\.11">/)
  assert.match(result.content, /frameDuration="1\/25s" width="1080" height="1920"/)
  assert.match(
    result.content,
    /src="file:\/\/\/D:\/%E7%B4%A0%E6%9D%90%E5%BA%93\/scene%20&amp;%20%22one%22\.mp4"/,
  )
  assert.match(result.content, /start="12s" duration="3s"/)
  assert.match(result.content, /person &amp; &quot;door&quot; &lt;open&gt;/)
  assert.match(result.content, /door &amp; person &lt;enter&gt;/)
  assert.deepEqual(validateFcpxml(result.content), {
    ok: true,
    clipCount: 1,
    markerCount: 1,
    errors: [],
  })
})

test('FCPXML clamps source ranges, skips non-video results, and deduplicates equal ranges', () => {
  const request = normalizeUnifiedSearchExportRequest({
    format: 'fcpxml',
    frameRate: 29.97,
    search: {},
    items: [
      item('clip.mp4', 'video', [evidence(8_000, 12_000), evidence(8_000, 12_000, 'duplicate')], {
        durationMs: 10_000,
      }),
      item('poster.jpg', 'image', []),
    ],
  })
  const result = serializeUnifiedSearchFcpxml(request)
  assert.equal(result.exportedCount, 1)
  assert.equal(result.skippedCount, 1)
  assert.equal(result.clampedCount, 1)
  assert.match(result.content, /tcFormat="DF"/)
  assert.match(result.content, /range clamped to source duration/)
  assert.equal(validateFcpxml(result.content).ok, true)
})

test('FCPXML guard requires a supported frame rate and exportable local timed video', () => {
  assert.equal(
    normalizeUnifiedSearchExportRequest({
      format: 'fcpxml',
      items: [item('x.mp4', 'video', [evidence(0, 1_000)])],
    }),
    undefined,
  )
  assert.equal(
    normalizeUnifiedSearchExportRequest({
      format: 'fcpxml',
      frameRate: 27,
      items: [item('x.mp4', 'video', [evidence(0, 1_000)])],
    }),
    undefined,
  )
  const request = normalizeUnifiedSearchExportRequest({
    format: 'fcpxml',
    frameRate: 25,
    search: {},
    items: [
      item('remote.mp4', 'video', [evidence(0, 1_000)], {
        displayPath: 'sftp://example.invalid/private/remote.mp4',
      }),
    ],
  })
  assert.throws(() => serializeUnifiedSearchFcpxml(request), /local video results/)
})

test('FCPXML import smoke rejects broken references and UI uses the guarded save route', () => {
  const request = normalizeUnifiedSearchExportRequest({
    format: 'fcpxml',
    frameRate: 25,
    search: {},
    items: [item('clip.mp4', 'video', [evidence(0, 1_000)], { durationMs: 5_000 })],
  })
  const valid = serializeUnifiedSearchFcpxml(request).content
  assert.equal(validateFcpxml(valid.replace('ref="r2"', 'ref="missing"')).ok, false)
  assert.equal(validateFcpxml(valid.replace('Siftory evidence', 'Siftory & evidence')).ok, false)

  const ui = fs.readFileSync(path.join(ROOT, 'src', 'components', 'UnifiedSearchPanel.tsx'), 'utf8')
  const ipc = fs.readFileSync(path.join(ROOT, 'electron', 'unifiedSearchIpc.ts'), 'utf8')
  assert.match(ui, /data-testid="unified-search-export-fcpxml"/)
  assert.match(ui, /exportSelected\('fcpxml'\)/)
  assert.match(ipc, /serializeUnifiedSearchFcpxml/)
  assert.match(ipc, /validateFcpxml/)
  assert.match(ipc, /Final Cut Pro XML/)
})
