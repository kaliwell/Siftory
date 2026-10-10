const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { loadTsModule } = require('./guard-utils.cjs')

const cacheApi = loadTsModule('electron/embeddingF16Cache.ts')
const annApi = loadTsModule('electron/vectorAnnIndex.ts')

function option(name, fallback) {
  const prefix = `--${name}=`
  const entry = process.argv.slice(2).find((value) => value.startsWith(prefix))
  return entry ? entry.slice(prefix.length) : fallback
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback
}

function percentile(values, percentileValue) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1)]
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
}

function projectionDimensions(dim, count) {
  const values = Array.from({ length: dim }, (_, index) => index)
  const random = { value: 0x243f6a88 }
  for (let index = values.length - 1; index > 0; index--) {
    random.value = (Math.imul(random.value, 1664525) + 1013904223) >>> 0
    const target = random.value % (index + 1)
    ;[values[index], values[target]] = [values[target], values[index]]
  }
  return Uint16Array.from(values.slice(0, Math.min(dim, count)))
}

function measureProjectedCandidates({
  vectors,
  currentRows,
  queryVector,
  targetRows,
  dimensions,
  dim,
}) {
  const dimensionCounts = [64, 128, 256].filter((count) => count <= dimensions.length)
  const scoresByDimensionCount = new Map(
    dimensionCounts.map((count) => [count, new Float32Array(currentRows.length)]),
  )
  for (let activeIndex = 0; activeIndex < currentRows.length; activeIndex++) {
    const rowOffset = currentRows[activeIndex].row * dim * 2
    let dot = 0
    let nextBoundaryIndex = 0
    for (let projectedIndex = 0; projectedIndex < dimensions.length; projectedIndex++) {
      const dimension = dimensions[projectedIndex]
      dot +=
        queryVector[dimension] *
        cacheApi.float16ToFloat32(vectors.readUInt16LE(rowOffset + dimension * 2))
      if (projectedIndex + 1 === dimensionCounts[nextBoundaryIndex]) {
        scoresByDimensionCount.get(dimensionCounts[nextBoundaryIndex])[activeIndex] = dot
        nextBoundaryIndex += 1
        if (nextBoundaryIndex >= dimensionCounts.length) break
      }
    }
  }

  const firstTarget = targetRows.values().next().value
  const output = {}
  for (const [dimensionCount, scores] of scoresByDimensionCount) {
    for (const ratio of [0.05, 0.1, 0.15, 0.2]) {
      const candidateLimit = Math.max(
        50,
        Math.min(scores.length, Math.floor(scores.length * ratio)),
      )
      const sorted = scores.slice()
      sorted.sort()
      const cutoff = sorted[Math.max(0, sorted.length - candidateLimit)]
      let strictlyGreater = 0
      for (const score of scores) if (score > cutoff) strictlyGreater += 1
      let tiedRemaining = candidateLimit - strictlyGreater
      let targetHits = 0
      let firstHit = false
      for (let activeIndex = 0; activeIndex < scores.length; activeIndex++) {
        const accepted =
          scores[activeIndex] > cutoff || (scores[activeIndex] === cutoff && tiedRemaining-- > 0)
        if (!accepted) continue
        const row = currentRows[activeIndex].row
        if (targetRows.has(row)) targetHits += 1
        if (row === firstTarget) firstHit = true
      }
      output[`projection${dimensionCount}-top${Math.round(ratio * 100)}`] = {
        candidates: candidateLimit,
        candidateRatio: candidateLimit / Math.max(1, currentRows.length),
        targetHits,
        firstHit,
      }
    }
  }
  return output
}

function buildQuantizedProjection(vectors, count, dim, dimensions) {
  const maximums = new Float32Array(dimensions.length)
  for (let row = 0; row < count; row++) {
    const rowOffset = row * dim * 2
    for (let projectedIndex = 0; projectedIndex < dimensions.length; projectedIndex++) {
      const value = Math.abs(
        cacheApi.float16ToFloat32(vectors.readUInt16LE(rowOffset + dimensions[projectedIndex] * 2)),
      )
      if (value > maximums[projectedIndex]) maximums[projectedIndex] = value
    }
  }
  const inverseScales = Float32Array.from(maximums, (maximum) => maximum / 127 || 1)
  const values = new Int8Array(count * dimensions.length)
  for (let row = 0; row < count; row++) {
    const sourceOffset = row * dim * 2
    const targetOffset = row * dimensions.length
    for (let projectedIndex = 0; projectedIndex < dimensions.length; projectedIndex++) {
      const value = cacheApi.float16ToFloat32(
        vectors.readUInt16LE(sourceOffset + dimensions[projectedIndex] * 2),
      )
      values[targetOffset + projectedIndex] = Math.max(
        -127,
        Math.min(127, Math.round(value / inverseScales[projectedIndex])),
      )
    }
  }
  return { values, inverseScales, dimensions }
}

function measureQuantizedProjection({ index, currentRows, queryVector, targetRows }) {
  const dimensionCounts = [64, 128].filter((count) => count <= index.dimensions.length)
  const scoresByDimensionCount = new Map(
    dimensionCounts.map((count) => [count, new Float32Array(currentRows.length)]),
  )
  const queryWeights = Float32Array.from(
    index.dimensions,
    (dimension, projectedIndex) => queryVector[dimension] * index.inverseScales[projectedIndex],
  )
  for (let activeIndex = 0; activeIndex < currentRows.length; activeIndex++) {
    const sourceOffset = currentRows[activeIndex].row * index.dimensions.length
    let dot = 0
    let nextBoundaryIndex = 0
    for (let projectedIndex = 0; projectedIndex < index.dimensions.length; projectedIndex++) {
      dot += queryWeights[projectedIndex] * index.values[sourceOffset + projectedIndex]
      if (projectedIndex + 1 === dimensionCounts[nextBoundaryIndex]) {
        scoresByDimensionCount.get(dimensionCounts[nextBoundaryIndex])[activeIndex] = dot
        nextBoundaryIndex += 1
        if (nextBoundaryIndex >= dimensionCounts.length) break
      }
    }
  }

  const firstTarget = targetRows.values().next().value
  const output = {}
  for (const [dimensionCount, scores] of scoresByDimensionCount) {
    for (const ratio of [0.05, 0.1, 0.15, 0.2]) {
      const candidateLimit = Math.max(
        50,
        Math.min(scores.length, Math.floor(scores.length * ratio)),
      )
      const sorted = scores.slice()
      sorted.sort()
      const cutoff = sorted[Math.max(0, sorted.length - candidateLimit)]
      let strictlyGreater = 0
      for (const score of scores) if (score > cutoff) strictlyGreater += 1
      let tiedRemaining = candidateLimit - strictlyGreater
      let targetHits = 0
      let firstHit = false
      for (let activeIndex = 0; activeIndex < scores.length; activeIndex++) {
        const accepted =
          scores[activeIndex] > cutoff || (scores[activeIndex] === cutoff && tiedRemaining-- > 0)
        if (!accepted) continue
        const row = currentRows[activeIndex].row
        if (targetRows.has(row)) targetHits += 1
        if (row === firstTarget) firstHit = true
      }
      output[`q8projection${dimensionCount}-top${Math.round(ratio * 100)}`] = {
        candidates: candidateLimit,
        candidateRatio: candidateLimit / Math.max(1, currentRows.length),
        targetHits,
        firstHit,
      }
    }
  }
  return output
}

function popcount32(value) {
  value -= (value >>> 1) & 0x55555555
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333)
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

function bandValue(low, high, bandBits, band) {
  const shift = band * bandBits
  if (shift < 32) {
    if (shift + bandBits <= 32) return (low >>> shift) & ((1 << bandBits) - 1)
    const lowBits = 32 - shift
    const highBits = bandBits - lowBits
    return ((low >>> shift) | ((high & ((1 << highBits) - 1)) << lowBits)) & ((1 << bandBits) - 1)
  }
  return (high >>> (shift - 32)) & ((1 << bandBits) - 1)
}

const CONFIGURATIONS = [
  { name: 'legacy-band12-r4', accept: (stats) => stats.minBand12 <= 4 },
  { name: 'band12-r3', accept: (stats) => stats.minBand12 <= 3 },
  { name: 'band12-r2', accept: (stats) => stats.minBand12 <= 2 },
  { name: 'band6-exact-any', accept: (stats) => stats.exactBand6 >= 1 },
  { name: 'band6-exact-two', accept: (stats) => stats.exactBand6 >= 2 },
  ...[14, 16, 18, 20, 22, 24].map((threshold) => ({
    name: `hamming48-${threshold}`,
    accept: (stats) => stats.hamming48 <= threshold,
  })),
  {
    name: 'hamming48-18-or-band6',
    accept: (stats) => stats.hamming48 <= 18 || stats.exactBand6 >= 1,
  },
  ...[2, 3, 4].flatMap((tables) =>
    [12, 13, 14].map((threshold) => ({
      name: `tables${tables}-hamming48-${threshold}`,
      requiredTables: tables,
      accept: (stats) => Math.min(...stats.hammingByTable.slice(0, tables)) <= threshold,
    })),
  ),
]

function rowVector(descriptor, row, dim) {
  const bytes = Buffer.allocUnsafe(dim * 2)
  const read = fs.readSync(descriptor, bytes, 0, bytes.length, row * bytes.length)
  if (read !== bytes.length) throw new Error(`Vector row ${row} is truncated`)
  const vector = new Float32Array(dim)
  let normSquared = 0
  for (let index = 0; index < dim; index++) {
    const value = cacheApi.float16ToFloat32(bytes.readUInt16LE(index * 2))
    vector[index] = value
    normSquared += value * value
  }
  const norm = Math.sqrt(normSquared)
  if (!(norm > 0)) throw new Error(`Vector row ${row} has zero norm`)
  for (let index = 0; index < dim; index++) vector[index] /= norm
  return vector
}

function meanVector(vectors, count, dim) {
  const sums = new Float64Array(dim)
  for (let row = 0; row < count; row++) {
    const offset = row * dim * 2
    for (let dimension = 0; dimension < dim; dimension++) {
      sums[dimension] += cacheApi.float16ToFloat32(vectors.readUInt16LE(offset + dimension * 2))
    }
    if (row > 0 && row % 100000 === 0) {
      console.error(`[ann-profile] center: ${row}/${count}`)
    }
  }
  return Float32Array.from(sums, (value) => value / Math.max(1, count))
}

function signatureStats(signatureTables, row, queryTables) {
  const signatures = signatureTables[0]
  const query = queryTables[0]
  const offset = row * annApi.VECTOR_ANN_SIGNATURE_BYTES
  const low = signatures.readUInt32LE(offset)
  const high = signatures.readUInt16LE(offset + 4)
  let minBand12 = 12
  for (let band = 0; band < 4; band++) {
    const distance = popcount32(
      bandValue(low, high, 12, band) ^ bandValue(query.low, query.high, 12, band),
    )
    if (distance < minBand12) minBand12 = distance
  }
  let exactBand6 = 0
  for (let band = 0; band < 8; band++) {
    if (bandValue(low, high, 6, band) === bandValue(query.low, query.high, 6, band)) {
      exactBand6 += 1
    }
  }
  return {
    hamming48: popcount32((low ^ query.low) >>> 0) + popcount32((high ^ query.high) & 0xffff),
    minBand12,
    exactBand6,
    hammingByTable: signatureTables.map((table, tableIndex) => {
      const tableLow = table.readUInt32LE(offset)
      const tableHigh = table.readUInt16LE(offset + 4)
      const tableQuery = queryTables[tableIndex]
      return (
        popcount32((tableLow ^ tableQuery.low) >>> 0) +
        popcount32((tableHigh ^ tableQuery.high) & 0xffff)
      )
    }),
  }
}

async function main() {
  const userData = option(
    'user-data',
    path.join(process.env.APPDATA || '', 'floating-clock-electron'),
  )
  const cacheDir = path.join(userData, 'vector-db', 'embedding-cache')
  const base = option('base', 'dinov2_vitb14__global')
  const metaPath = path.join(cacheDir, `${base}.f16.json`)
  const vectorPath = path.join(cacheDir, `${base}.f16`)
  const pathIndexPath = path.join(cacheDir, `${base}.paths.jsonl`)
  const signaturePath = path.join(cacheDir, `${base}.ann-simhash-v1.bin`)
  const sampleCount = boundedInteger(option('samples', '12'), 12, 2, 50)
  const tableCount = boundedInteger(option('tables', '1'), 1, 1, 4)
  const centered = option('centered', '0') === '1'
  const projected = option('projected', '0') === '1'
  const quantized = option('quantized', '0') === '1'
  for (const filePath of [metaPath, vectorPath, pathIndexPath, signaturePath]) {
    if (!fs.existsSync(filePath))
      throw new Error(`Missing ANN profile input: ${path.basename(filePath)}`)
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  const cache = { meta, vectorPath, pathIndexPath }
  const signatures = fs.readFileSync(signaturePath)
  if (signatures.length !== meta.count * annApi.VECTOR_ANN_SIGNATURE_BYTES) {
    throw new Error('ANN signature count does not match the F16 snapshot')
  }
  const signatureTables = []
  const signatureBuildStartedAt = performance.now()
  let center
  let plans
  if (tableCount > 1 || centered) {
    let vectors = fs.readFileSync(vectorPath)
    if (centered) center = meanVector(vectors, meta.count, meta.dim)
    plans = Array.from({ length: tableCount }, (_, tableIndex) =>
      annApi.createVectorAnnProjectionPlan(meta.dim, tableIndex, center),
    )
    const firstTable = centered ? 0 : 1
    if (!centered) signatureTables.push(signatures)
    for (let tableIndex = firstTable; tableIndex < tableCount; tableIndex++) {
      const table = Buffer.allocUnsafe(meta.count * annApi.VECTOR_ANN_SIGNATURE_BYTES)
      const tablePlan = plans[tableIndex]
      for (let row = 0; row < meta.count; row++) {
        annApi.writeVectorAnnSignature(
          table,
          row,
          annApi.vectorAnnSignatureFromF16(vectors, row, tablePlan),
        )
        if (row > 0 && row % 100000 === 0) {
          console.error(`[ann-profile] table ${tableIndex + 1}/${tableCount}: ${row}/${meta.count}`)
        }
      }
      signatureTables.push(table)
    }
  } else {
    signatureTables.push(signatures)
    plans = [annApi.createVectorAnnProjectionPlan(meta.dim)]
  }
  const signatureBuildMs = performance.now() - signatureBuildStartedAt
  const configurations = CONFIGURATIONS.filter(
    (configuration) => (configuration.requiredTables || 1) <= tableCount,
  )
  const currentRows = cacheApi.readEmbeddingF16CacheLatestPathRowsSync(cache)
  let projectedVectors = projected || quantized ? fs.readFileSync(vectorPath) : null
  const projectedDimensions =
    projected || quantized ? projectionDimensions(meta.dim, projected ? 256 : 128) : null
  const quantizedBuildStartedAt = performance.now()
  const quantizedIndex =
    quantized && projectedVectors && projectedDimensions
      ? buildQuantizedProjection(
          projectedVectors,
          meta.count,
          meta.dim,
          projectedDimensions.subarray(0, Math.min(128, projectedDimensions.length)),
        )
      : null
  const quantizedBuildMs = performance.now() - quantizedBuildStartedAt
  if (!projected) projectedVectors = null
  const projectedConfigurationNames = projected
    ? [64, 128, 256]
        .filter((count) => count <= meta.dim)
        .flatMap((count) => [5, 10, 15, 20].map((ratio) => `projection${count}-top${ratio}`))
    : []
  const quantizedConfigurationNames = quantized
    ? [64, 128]
        .filter((count) => count <= meta.dim)
        .flatMap((count) => [5, 10, 15, 20].map((ratio) => `q8projection${count}-top${ratio}`))
    : []
  const configurationNames = [
    ...configurations.map((configuration) => configuration.name),
    ...projectedConfigurationNames,
    ...quantizedConfigurationNames,
  ]
  const rowByPath = new Map(
    currentRows.map((item) => [cacheApi.embeddingCachePathKey(item.path), item.row]),
  )
  const samples = []
  const seenRows = new Set()
  for (let index = 0; index < sampleCount; index++) {
    const position = Math.min(
      currentRows.length - 1,
      Math.floor(((index + 0.5) * currentRows.length) / sampleCount),
    )
    const item = currentRows[position]
    if (item && !seenRows.has(item.row)) {
      seenRows.add(item.row)
      samples.push(item)
    }
  }
  const descriptor = fs.openSync(vectorPath, 'r')
  const measurements = []
  try {
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
      const sample = samples[sampleIndex]
      const queryVector = rowVector(descriptor, sample.row, meta.dim)
      const querySignatures = plans.map((plan) =>
        annApi.vectorAnnSignatureFromFloat32(queryVector, plan),
      )
      const exactStartedAt = performance.now()
      const exact = await cacheApi.searchEmbeddingF16Cache(cache, {
        queryVector,
        topK: 50,
      })
      const exactMs = performance.now() - exactStartedAt
      const targetRows = new Set(
        exact.flatMap((item) => {
          const row = rowByPath.get(cacheApi.embeddingCachePathKey(item.path))
          return row === undefined ? [] : [row]
        }),
      )
      const byConfig = Object.fromEntries(
        configurations.map((configuration) => [
          configuration.name,
          { candidates: 0, targetHits: 0, firstHit: false },
        ]),
      )
      const candidateStartedAt = performance.now()
      for (const item of currentRows) {
        const stats = signatureStats(signatureTables, item.row, querySignatures)
        const isTarget = targetRows.has(item.row)
        for (const configuration of configurations) {
          if (!configuration.accept(stats)) continue
          const result = byConfig[configuration.name]
          result.candidates += 1
          if (isTarget) result.targetHits += 1
          if (item.row === targetRows.values().next().value) result.firstHit = true
        }
      }
      if (projectedVectors && projectedDimensions) {
        const projectedResults = measureProjectedCandidates({
          vectors: projectedVectors,
          currentRows,
          queryVector,
          targetRows,
          dimensions: projectedDimensions,
          dim: meta.dim,
        })
        for (const [name, result] of Object.entries(projectedResults)) {
          byConfig[name] = result
        }
      }
      if (quantizedIndex) {
        const quantizedResults = measureQuantizedProjection({
          index: quantizedIndex,
          currentRows,
          queryVector,
          targetRows,
        })
        for (const [name, result] of Object.entries(quantizedResults)) {
          byConfig[name] = result
        }
      }
      const candidateScanMs = performance.now() - candidateStartedAt
      measurements.push({
        sampleId: crypto
          .createHash('sha256')
          .update(cacheApi.embeddingCachePathKey(sample.path))
          .digest('hex')
          .slice(0, 16),
        exactMs: Number(exactMs.toFixed(2)),
        candidateScanMs: Number(candidateScanMs.toFixed(2)),
        exactCount: exact.length,
        configurations: Object.fromEntries(
          configurationNames.map((configurationName) => {
            const result = byConfig[configurationName]
            return [
              configurationName,
              {
                candidates: result.candidates,
                candidateRatio: result.candidates / Math.max(1, currentRows.length),
                recall50: result.targetHits / Math.max(1, targetRows.size),
                firstHit: result.firstHit,
              },
            ]
          }),
        ),
      })
      console.error(
        `[ann-profile] ${sampleIndex + 1}/${samples.length}: exact=${exactMs.toFixed(0)}ms candidates=${candidateScanMs.toFixed(0)}ms`,
      )
    }
  } finally {
    fs.closeSync(descriptor)
  }

  const summary = Object.fromEntries(
    configurationNames.map((configurationName) => {
      const values = measurements.map((item) => item.configurations[configurationName])
      return [
        configurationName,
        {
          averageCandidateRatio: average(values.map((item) => item.candidateRatio)),
          p95CandidateRatio: percentile(
            values.map((item) => item.candidateRatio),
            95,
          ),
          averageRecall50: average(values.map((item) => item.recall50)),
          minimumRecall50: Math.min(...values.map((item) => item.recall50)),
          firstHitRate: average(values.map((item) => (item.firstHit ? 1 : 0))),
        },
      ]
    }),
  )
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    snapshot: {
      modelName: meta.modelName,
      dim: meta.dim,
      physicalCount: meta.count,
      activeCount: currentRows.length,
      samples: measurements.length,
      projectionTables: tableCount,
      centered,
      projected,
      quantized,
    },
    timing: {
      exactP50Ms: percentile(
        measurements.map((item) => item.exactMs),
        50,
      ),
      exactP95Ms: percentile(
        measurements.map((item) => item.exactMs),
        95,
      ),
      candidateScanP50Ms: percentile(
        measurements.map((item) => item.candidateScanMs),
        50,
      ),
      candidateScanP95Ms: percentile(
        measurements.map((item) => item.candidateScanMs),
        95,
      ),
      additionalSignatureBuildMs: Number(signatureBuildMs.toFixed(2)),
      quantizedProjectionBuildMs: Number(quantizedBuildMs.toFixed(2)),
    },
    summary,
    measurements,
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
