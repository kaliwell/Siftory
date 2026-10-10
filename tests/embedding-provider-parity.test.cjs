const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const {
  compareEmbeddingSnapshots,
  normalizeSnapshot,
} = require('../scripts/verify-embedding-provider-parity.cjs')

function snapshot(provider, samples) {
  return {
    schemaVersion: 1,
    model: 'dinov2_vitb14',
    provider,
    dimension: samples[0].vector.length,
    samples,
  }
}

const REFERENCE = snapshot('directml', [
  { id: 'east', vector: [1, 0, 0] },
  { id: 'north', vector: [0, 1, 0] },
  { id: 'up', vector: [0, 0, 1] },
  { id: 'diagonal', vector: [Math.SQRT1_2, Math.SQRT1_2, 0] },
])

test('embedding provider parity accepts deterministic near-identical CUDA output', () => {
  const candidate = snapshot(
    'cuda',
    REFERENCE.samples.map(({ id, vector }) => ({ id, vector: [...vector] })),
  )
  const result = compareEmbeddingSnapshots(REFERENCE, candidate, { topK: 2 })
  assert.equal(result.ok, true, result.failures.join('\n'))
  assert.equal(result.metrics.minimumCosine, 1)
  assert.equal(result.metrics.meanTopKOverlap, 1)
})

test('embedding provider parity rejects vector drift even when dimensions match', () => {
  const candidate = snapshot('cuda', [
    { id: 'east', vector: [0, 1, 0] },
    ...REFERENCE.samples.slice(1),
  ])
  const result = compareEmbeddingSnapshots(REFERENCE, candidate, { topK: 2 })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => failure.includes('minimum cosine')))
})

test('embedding provider parity validates ids, dimensions, finite values, and normalization', () => {
  assert.throws(
    () => normalizeSnapshot(snapshot('cuda', [{ id: 'bad', vector: [1, Number.NaN] }]), 'x'),
    /at least two samples|non-finite/,
  )
  const candidate = snapshot('cuda', [
    { id: 'east', vector: [2, 0, 0] },
    ...REFERENCE.samples.slice(1),
  ])
  const result = compareEmbeddingSnapshots(REFERENCE, candidate, { topK: 2 })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => failure.includes('unit-norm error')))
})

test('embedding provider parity CLI emits JSON and a failing exit code on gate failure', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-provider-parity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const referencePath = path.join(directory, 'reference.json')
  const candidatePath = path.join(directory, 'candidate.json')
  fs.writeFileSync(referencePath, JSON.stringify(REFERENCE))
  fs.writeFileSync(
    candidatePath,
    JSON.stringify(snapshot('cuda', REFERENCE.samples.map(({ id }) => ({ id, vector: [1, 1, 1] })))),
  )
  const result = spawnSync(
    process.execPath,
    [
      path.resolve(__dirname, '..', 'scripts', 'verify-embedding-provider-parity.cjs'),
      '--reference',
      referencePath,
      '--candidate',
      candidatePath,
      '--top-k',
      '2',
    ],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, false)
  assert.equal(report.candidateProvider, 'cuda')
})
