const fs = require('node:fs')
const readline = require('node:readline')
const { performance } = require('node:perf_hooks')

function pathKey(filePath) {
  return String(filePath).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function percentile(values, ratio) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]
}

function summarize(values) {
  return {
    mean: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length > 0 ? Math.max(...values) : null,
    samples: values.length,
  }
}

function pushTopN(heap, item, topN) {
  if (heap.length < topN) {
    heap.push(item)
    let child = heap.length - 1
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2)
      if (heap[parent].score <= heap[child].score) break
      ;[heap[parent], heap[child]] = [heap[child], heap[parent]]
      child = parent
    }
    return
  }
  if (item.score <= heap[0].score) return
  heap[0] = item
  let parent = 0
  for (;;) {
    const left = parent * 2 + 1
    const right = left + 1
    if (left >= heap.length) break
    let smaller = left
    if (right < heap.length && heap[right].score < heap[left].score) smaller = right
    if (heap[parent].score <= heap[smaller].score) break
    ;[heap[parent], heap[smaller]] = [heap[smaller], heap[parent]]
    parent = smaller
  }
}

async function loadPathIndex(store) {
  const startedAt = performance.now()
  const paths = new Array(store.count)
  let jsonParseMs = 0
  let parsed = 0
  let physicalRow = 0
  const lines = readline.createInterface({
    input: fs.createReadStream(store.pathIndexPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of lines) {
    if (!line) continue
    const parseStartedAt = performance.now()
    let item
    try {
      item = JSON.parse(line)
    } catch {
      item = null
    }
    jsonParseMs += performance.now() - parseStartedAt
    const row = Number.isInteger(item?.row) ? item.row : physicalRow
    if (item && row >= 0 && row < paths.length && typeof item.path === 'string') {
      paths[row] = pathKey(item.path)
      parsed += 1
    }
    physicalRow += 1
  }
  const elapsedMs = performance.now() - startedAt
  if (parsed !== store.count) {
    throw new Error(`${store.modelName} path index count mismatch: ${parsed}/${store.count}`)
  }
  return {
    paths,
    timings: {
      pathIndexMs: elapsedMs,
      jsonParseMs,
      pathIoMs: Math.max(0, elapsedMs - jsonParseMs),
    },
  }
}

function decodeFloat16(value) {
  const sign = value & 0x8000 ? -1 : 1
  const exponent = (value >>> 10) & 0x1f
  const mantissa = value & 0x03ff
  if (exponent === 0) return sign * Math.pow(2, -14) * (mantissa / 1024)
  if (exponent === 0x1f) return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY
  return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024)
}

const FLOAT16_LOOKUP = new Float32Array(65_536)
for (let value = 0; value < FLOAT16_LOOKUP.length; value += 1) {
  FLOAT16_LOOKUP[value] = decodeFloat16(value)
}

function readFloat16(buffer, offset) {
  return FLOAT16_LOOKUP[buffer.readUInt16LE(offset)]
}

async function readVectorsForPaths(store, requestedPaths, loadedPaths) {
  const requested = new Set([...requestedPaths].map(pathKey))
  const rows = []
  const pathState = loadedPaths || (await loadPathIndex(store))
  for (let row = 0; row < pathState.paths.length; row += 1) {
    const key = pathState.paths[row]
    if (requested.has(key)) rows.push({ row, key })
  }
  const result = new Map()
  const bytesPerValue = store.dtype === 'f32-le' ? 4 : 2
  const rowBytes = store.dim * bytesPerValue
  const buffer = Buffer.allocUnsafe(rowBytes)
  const handle = await fs.promises.open(store.vectorPath, 'r')
  try {
    for (const item of rows) {
      const read = await handle.read(buffer, 0, rowBytes, item.row * rowBytes)
      if (read.bytesRead !== rowBytes) continue
      const vector = new Float32Array(store.dim)
      for (let column = 0; column < store.dim; column += 1) {
        vector[column] =
          store.dtype === 'f32-le'
            ? buffer.readFloatLE(column * 4)
            : readFloat16(buffer, column * 2)
      }
      result.set(item.key, vector)
    }
  } finally {
    await handle.close()
  }
  return { vectors: result, pathState }
}

async function scanExactStore(store, options) {
  const startedAt = performance.now()
  const pathState = options.pathState || (await loadPathIndex(store))
  const pathTimings = options.pathState
    ? { pathIndexMs: 0, jsonParseMs: 0, pathIoMs: 0 }
    : pathState.timings
  const heap = []
  const poolScores = new Map()
  const bytesPerValue = store.dtype === 'f32-le' ? 4 : 2
  const rowBytes = store.dim * bytesPerValue
  const rowsPerChunk = Math.max(1, Math.floor((4 * 1024 * 1024) / rowBytes))
  const buffer = Buffer.allocUnsafe(rowsPerChunk * rowBytes)
  const handle = await fs.promises.open(store.vectorPath, 'r')
  let vectorIoMs = 0
  let similarityMs = 0
  let rankingMs = 0
  let scanned = 0
  let scored = 0
  const vector = new Float32Array(store.dim)
  try {
    for (let firstRow = 0; firstRow < store.count; firstRow += rowsPerChunk) {
      const rowCount = Math.min(rowsPerChunk, store.count - firstRow)
      const bytes = rowCount * rowBytes
      const ioStartedAt = performance.now()
      const read = await handle.read(buffer, 0, bytes, firstRow * rowBytes)
      vectorIoMs += performance.now() - ioStartedAt
      if (read.bytesRead !== bytes) throw new Error(`${store.modelName} vector read truncated`)
      for (let localRow = 0; localRow < rowCount; localRow += 1) {
        const row = firstRow + localRow
        const key = pathState.paths[row]
        scanned += 1
        if (options.acceptPathKey && !options.acceptPathKey(key)) continue
        const baseOffset = localRow * rowBytes
        const similarityStartedAt = performance.now()
        for (let column = 0; column < store.dim; column += 1) {
          vector[column] =
            store.dtype === 'f32-le'
              ? buffer.readFloatLE(baseOffset + column * 4)
              : readFloat16(buffer, baseOffset + column * 2)
        }
        let maxPositive = -1
        let nearestNegative = -1
        for (const prototype of options.positiveVectors) {
          let dot = 0
          for (let column = 0; column < store.dim; column += 1) {
            dot += vector[column] * prototype[column]
          }
          if (dot > maxPositive) maxPositive = dot
        }
        if (options.poolByPath.has(key)) {
          for (const prototype of options.negativeVectors) {
            let dot = 0
            for (let column = 0; column < store.dim; column += 1) {
              dot += vector[column] * prototype[column]
            }
            if (dot > nearestNegative) nearestNegative = dot
          }
          poolScores.set(key, { positive: maxPositive, negative: nearestNegative })
        }
        similarityMs += performance.now() - similarityStartedAt
        const rankingStartedAt = performance.now()
        pushTopN(heap, { key, score: maxPositive }, options.topN)
        rankingMs += performance.now() - rankingStartedAt
        scored += 1
      }
    }
  } finally {
    await handle.close()
  }
  const totalMs = performance.now() - startedAt
  return {
    poolScores,
    heap,
    scanned,
    scored,
    pathState,
    timings: {
      totalMs,
      ...pathTimings,
      vectorIoMs,
      similarityMs,
      rankingMs,
      unattributedMs: Math.max(
        0,
        totalMs - pathTimings.pathIndexMs - vectorIoMs - similarityMs - rankingMs,
      ),
    },
  }
}

async function benchmarkExactStore(store, options) {
  const runs = Math.max(3, Math.floor(options.runs || 3))
  const cold = []
  let result
  for (let index = 0; index < runs; index += 1) {
    result = await scanExactStore(store, options)
    cold.push(result.timings)
    result.pathState = null
    if (typeof global.gc === 'function') global.gc()
  }
  const pathState = await loadPathIndex(store)
  const warm = []
  for (let index = 0; index < runs; index += 1) {
    result = await scanExactStore(store, { ...options, pathState })
    warm.push(result.timings)
  }
  const summarizePhase = (rows, field) => summarize(rows.map((row) => row[field]))
  return {
    result,
    profile: {
      runs,
      samples: { applicationCold: cold, warmPathIndex: warm },
      applicationCold: {
        totalMs: summarizePhase(cold, 'totalMs'),
        pathIoMs: summarizePhase(cold, 'pathIoMs'),
        jsonParseMs: summarizePhase(cold, 'jsonParseMs'),
        vectorIoMs: summarizePhase(cold, 'vectorIoMs'),
        similarityMs: summarizePhase(cold, 'similarityMs'),
        rankingMs: summarizePhase(cold, 'rankingMs'),
      },
      warmPathIndex: {
        metadataPreparation: pathState.timings,
        totalMs: summarizePhase(warm, 'totalMs'),
        vectorIoMs: summarizePhase(warm, 'vectorIoMs'),
        similarityMs: summarizePhase(warm, 'similarityMs'),
        rankingMs: summarizePhase(warm, 'rankingMs'),
      },
      note: 'applicationCold reopens and reparses metadata each run; operating-system file cache is not flushed. warmPathIndex reuses parsed metadata but reopens and scans the complete vector file.',
    },
  }
}

module.exports = {
  benchmarkExactStore,
  loadPathIndex,
  pathKey,
  readVectorsForPaths,
  scanExactStore,
  summarize,
}
