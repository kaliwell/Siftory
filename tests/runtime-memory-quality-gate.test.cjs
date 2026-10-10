const assert = require('node:assert/strict')
const test = require('node:test')
const { evaluateQualityRounds } = require('../scripts/run-runtime-memory-quality-gate.cjs')

function model(modelName, fingerprint = 'stable') {
  return {
    modelName,
    gatePassed: true,
    snapshotFingerprint: fingerprint,
    sourceFingerprint: fingerprint,
    generationLoadMode: 'f16-stream',
    generationCount: 100,
    sourceRecordCount: 101,
    sourceEffectiveCount: 100,
    alignedCount: 100,
    recallAtKMean: 0.99,
    rankEquivalentRecallAtKMean: 1,
    selfWithinTop1ToleranceRate: 1,
    scoreErrorP99: 0.001,
    elapsedMs: 20,
    sourceMatrixBytes: 4096,
    generationEncodedBytes: 2048,
    generationDecodedWindowBytes: 1024,
  }
}

function round() {
  return {
    reports: [model('clip_vit_base_patch32'), model('dinov2_vitb14')],
    memory: {
      peakPrivateBytes: 512 * 1024 * 1024,
      peakWorkingSetBytes: 400 * 1024 * 1024,
      minimumFreePhysicalMemoryBytes: 4 * 1024 * 1024 * 1024,
    },
  }
}

test('quality aggregate requires three stable bounded rounds and unchanged sources', () => {
  const snapshot = { source: { bytes: 10, mtimeMs: 20, sampledSha256: 'abc' } }
  const result = evaluateQualityRounds([round(), round(), round()], snapshot, snapshot)
  assert.equal(result.passed, true)
  assert.equal(result.sourceFilesUnchanged, true)
  assert.equal(result.models.dinov2_vitb14.rounds, 3)
})

test('quality aggregate fails missing rounds, identity drift, unbounded loads, and source changes', () => {
  const first = round()
  const second = round()
  second.reports[0].snapshotFingerprint = 'changed'
  second.reports[1].generationLoadMode = 'memory'
  second.memory.peakPrivateBytes = 3 * 1024 * 1024 * 1024
  const result = evaluateQualityRounds(
    [first, second],
    { source: { bytes: 10 } },
    { source: { bytes: 11 } },
  )
  assert.equal(result.passed, false)
  assert.match(result.failures.join('\n'), /fewer than three/)
  assert.match(result.failures.join('\n'), /snapshotFingerprint changed/)
  assert.match(result.failures.join('\n'), /bounded F16 streaming/)
  assert.match(result.failures.join('\n'), /2 GiB process-tree private-memory/)
  assert.match(result.failures.join('\n'), /source file changed/)
})
