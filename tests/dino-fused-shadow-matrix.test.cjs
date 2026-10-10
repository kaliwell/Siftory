const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  evaluateMatrix,
  parseArgs,
  runFormalPreflight,
} = require('../scripts/run-dino-fused-shadow-matrix.cjs')

function report(seed = 'same', ready = 100, publicShape = false) {
  const scan = { count: 1000, sha256: seed }
  const dino = { count: 1000, sha256: seed }
  const clip = { count: 1000, sha256: seed }
  return {
    ok: true,
    ...(publicShape ? { config: { imageCount: 1000 } } : { imageCount: 1000 }),
    phases: { libraryReadyMs: ready },
    scan: publicShape ? { digest: scan } : scan,
    ...(publicShape ? { embeddingDigests: { dino, clip } } : { dino, clip }),
    vectorIndex: publicShape ? { status: { count: 1000 } } : { count: 1000 },
    providerEvidence: {
      dino: { selectedProviders: ['dml'], fallbackDetected: false },
      clip: { selectedProviders: ['dml'], fallbackDetected: false },
    },
    resources: { memory: { childPeakAggregateRssMiBApprox: 1000 } },
    safety: {
      sourceDatasetReadOnly: true,
      sourceUnchanged: true,
      isolatedUserData: true,
      noBenchmarkChildProcessesAtStop: true,
      sourceSnapshot: { count: 1000, sha256: seed },
    },
  }
}

function matrix(publicShape = false) {
  return [1, 2, 3].flatMap((round) => [
    { round, mode: 'baseline', report: report('same', 100, publicShape) },
    { round, mode: 'candidate', report: report('same', 101, publicShape) },
  ])
}

test('DINO fused matrix accepts three exact, bounded, source-safe rounds', () => {
  const gate = evaluateMatrix(matrix())
  assert.equal(gate.passed, true)
  assert.equal(gate.parity.dinoDigest, 'same')
})

test('DINO fused matrix reads the persisted public E2E report shape', () => {
  const gate = evaluateMatrix(matrix(true))
  assert.equal(gate.passed, true)
  assert.deepEqual(gate.parity, {
    scanDigest: 'same',
    dinoDigest: 'same',
    clipDigest: 'same',
  })
  assert.deepEqual(gate.safety, { sourceSafe: true, lifecycleSafe: true })
})

test('DINO fused matrix rejects digest, ready, memory, provider, and safety regressions', () => {
  const entries = matrix()
  entries[1].report.dino.sha256 = 'changed'
  entries[3].report.phases.libraryReadyMs = 200
  entries[3].report.resources.memory.childPeakAggregateRssMiBApprox = 1100
  entries[5].report.providerEvidence.dino.fallbackDetected = true
  entries[5].report.safety.sourceUnchanged = false
  const gate = evaluateMatrix(entries)
  assert.equal(gate.passed, false)
  const failures = gate.failures.join('\n')
  assert.match(failures, /digest changed/)
  assert.match(failures, /Ready P95/)
  assert.match(failures, /RSS peak/)
  assert.match(failures, /fell back/)
  assert.match(failures, /safety/)
})

test('DINO fused matrix confines artifacts and rejects unknown arguments', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-dino-matrix-'))
  context.after(() => fs.rmSync(root, { force: true, recursive: true }))
  const dataset = path.join(root, 'dataset')
  fs.mkdirSync(dataset)
  const outputDir = path.join(root, 'artifacts', 'benchmark', 'runtime-memory', 'candidate')
  const parsed = parseArgs([`--dataset=${dataset}`, `--output-dir=${outputDir}`], root)
  assert.equal(parsed.dataset, dataset)
  assert.equal(parsed.outputDir, outputDir)
  assert.equal(
    parseArgs([`--dataset=${dataset}`, `--output-dir=${outputDir}`, '--formal'], root).formal,
    true,
  )
  assert.throws(
    () => parseArgs([`--dataset=${dataset}`, `--output-dir=${path.join(root, 'outside')}`], root),
    /must stay under/,
  )
  assert.throws(() => parseArgs([`--dataset=${dataset}`, '--unsafe=true'], root), /Unknown/)
})

test('DINO formal preflight binds evaluation to immutable accepted GPU evidence', async () => {
  const snapshot = { kind: 'snapshot' }
  const result = await runFormalPreflight(
    { projectRoot: process.cwd() },
    {
      resolveAcceptedGpuBaseline: () => ({ usedMiB: 1060 }),
      collectRuntimeMemoryPreflight: async () => snapshot,
      evaluateRuntimeMemoryPreflight(value, options) {
        assert.equal(value, snapshot)
        assert.deepEqual(options, { formal: true, gpuBaselineUsedMiB: 1060 })
        return { status: 'passed' }
      },
    },
  )
  assert.equal(result.gpuBaseline.usedMiB, 1060)
  assert.equal(result.evaluation.status, 'passed')
})
