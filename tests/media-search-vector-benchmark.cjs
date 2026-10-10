const { performance } = require('node:perf_hooks')
const { loadTsModule } = require('./guard-utils.cjs')

const { normalizedCosineScore } = loadTsModule('electron/mediaSearchVectorMath.ts')

const dim = 512
const requested = Number.parseInt(process.env.MEDIA_SEARCH_BENCH_VECTORS || '20000', 10)
const count = Math.max(1000, Math.min(200000, Number.isFinite(requested) ? requested : 20000))

function unitVector(seed) {
  const vector = new Float32Array(dim)
  let squaredNorm = 0
  for (let index = 0; index < dim; index++) {
    const value = Math.sin((seed + 1) * (index + 3) * 0.017)
    vector[index] = value
    squaredNorm += value * value
  }
  const inverseNorm = 1 / Math.sqrt(squaredNorm)
  for (let index = 0; index < dim; index++) vector[index] *= inverseNorm
  return vector
}

const query = unitVector(0)
const vectors = Array.from({ length: count }, (_, index) => unitVector(index + 1))
const before = process.memoryUsage()
const startedAt = performance.now()
let checksum = 0
for (const vector of vectors) checksum += normalizedCosineScore(query, vector)
const elapsedMs = performance.now() - startedAt
const after = process.memoryUsage()

console.log(
  JSON.stringify(
    {
      vectors: count,
      dim,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      vectorsPerSecond: Math.round((count / Math.max(1, elapsedMs)) * 1000),
      checksum: Number(checksum.toFixed(6)),
      vectorBytes: count * dim * Float32Array.BYTES_PER_ELEMENT,
      heapDeltaBytes: after.heapUsed - before.heapUsed,
      arrayBufferBytes: after.arrayBuffers,
    },
    null,
    2,
  ),
)
