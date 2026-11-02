// Paired scalar/lookup measurements on the production paged scoring path.
// Uses only deterministic synthetic vectors and an isolated temporary snapshot.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { loadTsModule } = require('../tests/guard-utils.cjs')
const { float32ToFloat16 } = loadTsModule('electron/embeddingF16Cache.ts')
const { F16SnapshotReader, scoreF16SnapshotCandidates } = loadTsModule(
  'electron/f16SnapshotReader.ts',
)
const { scoreVectorAnnCandidates } = loadTsModule('electron/vectorAnnIndex.ts')

function integerOption(name, fallback, minimum, maximum) {
  const argument = process.argv.slice(2).find((item) => item.startsWith(`--${name}=`))
  if (!argument) return fallback
  const value = Number(argument.slice(name.length + 3))
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`--${name} must be an integer between ${minimum} and ${maximum}`)
  return value
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

function scalarMode(scalar, operation) {
  const previous = process.env.SIFTORY_F16_RERANK_SCALAR
  try {
    if (scalar) process.env.SIFTORY_F16_RERANK_SCALAR = '1'
    else delete process.env.SIFTORY_F16_RERANK_SCALAR
    return operation()
  } finally {
    if (previous === undefined) delete process.env.SIFTORY_F16_RERANK_SCALAR
    else process.env.SIFTORY_F16_RERANK_SCALAR = previous
  }
}

function fixture(rows, dim, samples) {
  const buffer = Buffer.alloc(rows * dim * 2)
  const queries = []
  let seed = 0x51f70
  for (let row = 0; row < rows; row++) {
    const vector = new Float32Array(dim)
    let norm = 0
    for (let coordinate = 0; coordinate < dim; coordinate++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      vector[coordinate] = seed / 0x100000000 - 0.5
      norm += vector[coordinate] ** 2
    }
    norm = Math.sqrt(norm)
    for (let coordinate = 0; coordinate < dim; coordinate++) {
      vector[coordinate] /= norm
      buffer.writeUInt16LE(float32ToFloat16(vector[coordinate]), (row * dim + coordinate) * 2)
    }
    if (row < samples) queries.push(vector)
  }
  return { buffer, queries }
}

function main() {
  const rows = integerOption('rows', 20000, 64, 500000)
  const dim = integerOption('dim', 768, 1, 4096)
  const samples = integerOption('samples', 15, 3, 101)
  if (rows * dim * 2 > 512 * 1024 * 1024) throw new Error('Fixture exceeds the 512 MiB budget')
  const { buffer, queries } = fixture(rows, dim, samples)
  const candidates = Uint32Array.from({ length: Math.ceil(rows / 5) }, (_, index) => index * 5)
  const topK = Math.min(50, candidates.length)
  const parent = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(parent, 'siftory-rerank-benchmark-'))
  const readers = []
  try {
    const vectorPath = path.join(root, 'fixture.f16')
    fs.writeFileSync(vectorPath, buffer)
    const cache = { meta: { dim, count: rows }, vectorPath }
    readers.push(new F16SnapshotReader(cache), new F16SnapshotReader(cache))
    const modes = [
      { name: 'scalar', reader: readers[0], times: [], firstPassMs: 0 },
      { name: 'lookup', reader: readers[1], times: [], firstPassMs: 0 },
    ]
    let sampledPeakRssBytes = process.memoryUsage().rss
    const initialMemory = process.memoryUsage()
    // Alternate the first mode to reduce ordering bias. First reader passes and
    // one further warmup are excluded from steady-state percentiles.
    for (let iteration = -2; iteration < samples; iteration++) {
      const query = queries[Math.max(0, iteration) % queries.length]
      const results = new Map()
      const order = iteration % 2 === 0 ? modes : [...modes].reverse()
      for (const mode of order) {
        const started = performance.now()
        const result = scalarMode(mode.name === 'scalar', () =>
          scoreF16SnapshotCandidates(mode.reader, candidates, query, topK),
        )
        const elapsed = performance.now() - started
        if (iteration === -2) mode.firstPassMs = elapsed
        if (iteration >= 0) mode.times.push(elapsed)
        results.set(mode.name, result)
        sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss)
      }
      assert.deepEqual(results.get('lookup'), results.get('scalar'), 'paged ranking changed')
      const resident = scalarMode(false, () =>
        scoreVectorAnnCandidates(buffer, dim, candidates, query, topK),
      )
      assert.deepEqual(results.get('lookup'), resident, 'paged/resident ranking changed')
    }
    const environment = {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    }
    const results = modes.map((mode) => ({
      name: mode.name,
      firstReaderPassMs: mode.firstPassMs,
      p50Ms: percentile(mode.times, 0.5),
      p95Ms: percentile(mode.times, 0.95),
      samplesMs: mode.times,
      reader: mode.reader.stats(),
    }))
    const report = {
      schemaVersion: 1,
      fixtureVersion: 'seed-51f70-f16-v1',
      implementationSha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.resolve(__dirname, '../electron/f16DotProduct.ts')))
        .update(fs.readFileSync(path.resolve(__dirname, '../electron/f16SnapshotReader.ts')))
        .digest('hex'),
      synthetic: true,
      generatedAt: new Date().toISOString(),
      environment,
      comparabilityKey: crypto
        .createHash('sha256')
        .update(JSON.stringify({ environment, rows, dim, samples }))
        .digest('hex'),
      workload: {
        rows,
        dim,
        samples,
        candidates: candidates.length,
        topK,
        vectorBytes: buffer.length,
      },
      results,
      p50Speedup: results[0].p50Ms / results[1].p50Ms,
      p95Speedup: results[0].p95Ms / results[1].p95Ms,
      decodeTableBytesPerWorker: 256 * 1024,
      memory: { before: initialMemory, after: process.memoryUsage(), sampledPeakRssBytes },
      gate: { passed: true, exactScoresAndRanks: true, residentAndPagedParity: true },
      scope:
        'Production paged CPU reranking only. OS file cache is uncontrolled; first reader pass is not cold disk latency. Excludes model/GPU, ANN recall quality, actual media/NAS and UI. Paired readers and the resident fixture increase benchmark memory; this is not application peak RSS.',
    }
    const output = path.resolve(__dirname, '../artifacts/benchmark/vector-rerank/latest.json')
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    console.log(
      JSON.stringify(
        {
          ok: true,
          output,
          workload: report.workload,
          results,
          p50Speedup: report.p50Speedup,
          p95Speedup: report.p95Speedup,
        },
        null,
        2,
      ),
    )
    return report
  } finally {
    for (const reader of readers) reader.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
module.exports = { main }
