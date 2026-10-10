const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')

const { normalizeUnifiedSearchQuery } = loadTsModule('electron/unifiedSearchGuards.ts')

test('unified search guard normalizes a reference path and bounds request fields', () => {
  const normalized = normalizeUnifiedSearchQuery({
    query: 'q'.repeat(600),
    referenceImagePath: '  C:/library/query.jpg  ',
    sourceId: 's'.repeat(200),
    offset: -5,
    limit: 10000,
    subject: { x: 1, y: 2, w: 30, h: 40, confidence: 0.9, label: 'x'.repeat(80) },
    segmentationSessionId: '12345678-1234-1234-1234-123456789abc',
  })
  assert.equal(normalized.query.length, 500)
  assert.equal(normalized.referenceImagePath, 'C:\\library\\query.jpg')
  assert.equal(normalized.sourceId.length, 128)
  assert.equal(normalized.offset, 0)
  assert.equal(normalized.limit, 500)
  assert.deepEqual(normalized.subject, {
    x: 1,
    y: 2,
    w: 30,
    h: 40,
    confidence: 0.9,
    label: 'x'.repeat(50),
  })
  assert.equal(normalized.segmentationSessionId, '12345678-1234-1234-1234-123456789abc')
})

test('unified search guard drops hostile paths and invalid subject regions', () => {
  const invalidPath = normalizeUnifiedSearchQuery({
    referenceImagePath: 'C:\\library\0query.jpg',
    subject: { x: 0, y: 0, w: 20, h: 20, confidence: 1, label: 'person' },
  })
  assert.equal(invalidPath.referenceImagePath, undefined)
  assert.equal(invalidPath.subject, undefined)

  const invalidSubject = normalizeUnifiedSearchQuery({
    referenceImagePath: 'C:\\library\\query.jpg',
    subject: { x: -1, y: 0, w: 3, h: Number.NaN },
  })
  assert.equal(invalidSubject.referenceImagePath, 'C:\\library\\query.jpg')
  assert.equal(invalidSubject.subject, undefined)
})

test('Sources UI forwards an explicitly selected subject to unified search', () => {
  const source = require('node:fs').readFileSync(
    'src/components/DiscoverySourcesSection.tsx',
    'utf8',
  )
  assert.match(source, /<SubjectPickerModal/)
  assert.match(source, /enableSegmentation=\{false\}/)
  assert.match(source, /referenceImagePath && subject \? \{ subject \} : \{\}/)
  assert.match(source, /setSubject\(selectedSubject\)/)
})

test('unified page forwards only the opaque mask session capability', () => {
  const source = require('node:fs').readFileSync('src/components/UnifiedSearchPanel.tsx', 'utf8')
  const ipc = require('node:fs').readFileSync('electron/unifiedSearchIpc.ts', 'utf8')
  assert.match(source, /<SubjectPickerModal/)
  assert.match(source, /segmentationSessionId/)
  assert.match(ipc, /subjectMaskSessions\.resolve\(event\.sender\.id/)
  assert.doesNotMatch(source, /maskedCropPath|contextCropPath|maskPng:/)
})
