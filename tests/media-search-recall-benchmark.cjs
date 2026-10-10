const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { performance } = require('node:perf_hooks')

const root = path.resolve(__dirname, '..')
const mediaDir = path.resolve(
  process.env.MEDIA_SEARCH_DIR ||
    path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'floating-clock-electron',
      'media-search',
    ),
)
const manifestPath = path.join(mediaDir, 'manifests', 'video_frames.jsonl')
const indexPath = path.join(mediaDir, 'vectors', 'frame_embedding_index.jsonl')
const queryLimit = Math.max(
  1,
  Math.min(500, Number.parseInt(process.env.MEDIA_SEARCH_RECALL_QUERIES || '100', 10) || 100),
)
const topKs = [1, 5, 10, 20, 50]
const maxK = Math.max(...topKs)
const models = ['dinov2_vitb14', 'clip_vit_base_patch32']
const expectedDimensions = { dinov2_vitb14: 768, clip_vit_base_patch32: 512 }

function keyOf(filePath) {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

async function eachJsonLine(filePath, callback) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  let malformed = 0
  try {
    for await (const line of lines) {
      if (!line) continue
      try {
        callback(JSON.parse(line))
      } catch {
        malformed += 1
      }
    }
  } finally {
    lines.close()
  }
  return malformed
}

function normalizeVector(input) {
  if (!Array.isArray(input) || input.length === 0) return null
  const vector = new Float32Array(input.length)
  let normSquared = 0
  for (let index = 0; index < input.length; index += 1) {
    const value = Number(input[index])
    if (!Number.isFinite(value)) return null
    vector[index] = value
    normSquared += value * value
  }
  if (!(normSquared > 0)) return null
  const inverseNorm = 1 / Math.sqrt(normSquared)
  for (let index = 0; index < vector.length; index += 1) vector[index] *= inverseNorm
  return vector
}

function dot(left, right) {
  let score = 0
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index]
  return score
}

function heapPush(heap, item) {
  heap.push(item)
  let index = heap.length - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (heap[parent].score <= item.score) break
    heap[index] = heap[parent]
    index = parent
  }
  heap[index] = item
}

function heapReplaceMin(heap, item) {
  heap[0] = item
  let index = 0
  for (;;) {
    const left = index * 2 + 1
    const right = left + 1
    if (left >= heap.length) break
    let smallest = left
    if (right < heap.length && heap[right].score < heap[left].score) smallest = right
    if (heap[smallest].score >= item.score) break
    heap[index] = heap[smallest]
    index = smallest
  }
  heap[index] = item
}

function topCandidates(entries, queryIndex) {
  const query = entries[queryIndex]
  const heap = []
  for (let index = 0; index < entries.length; index += 1) {
    if (index === queryIndex) continue
    const item = { index, score: dot(query.vector, entries[index].vector) }
    if (heap.length < maxK) heapPush(heap, item)
    else if (item.score > heap[0].score) heapReplaceMin(heap, item)
  }
  return heap.sort((a, b) => b.score - a.score)
}

function percentile(values, ratio) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]
}

function selectQueries(entries, byVideo) {
  const selected = []
  const videos = [...byVideo.values()]
    .filter((indices) => indices.length >= 2)
    .sort((a, b) => a[0] - b[0])
  let round = 0
  while (selected.length < queryLimit) {
    let added = false
    for (const indices of videos) {
      if (round >= indices.length || selected.length >= queryLimit) continue
      selected.push(indices[round])
      added = true
    }
    if (!added) break
    round += 1
  }
  return selected
}

function evaluateModel(modelName, entries) {
  const byVideo = new Map()
  for (let index = 0; index < entries.length; index += 1) {
    const videoId = entries[index].videoId
    const indices = byVideo.get(videoId) || []
    indices.push(index)
    byVideo.set(videoId, indices)
  }
  for (const indices of byVideo.values()) {
    indices.sort((a, b) => entries[a].timestampMs - entries[b].timestampMs)
  }

  const adjacentByIndex = new Map()
  for (const indices of byVideo.values()) {
    for (let position = 0; position < indices.length; position += 1) {
      const adjacent = new Set()
      if (position > 0) adjacent.add(indices[position - 1])
      if (position + 1 < indices.length) adjacent.add(indices[position + 1])
      adjacentByIndex.set(indices[position], adjacent)
    }
  }

  const queries = selectQueries(entries, byVideo)
  const sameHits = Object.fromEntries(topKs.map((k) => [k, 0]))
  const adjacentHits = Object.fromEntries(topKs.map((k) => [k, 0]))
  const durations = []
  let reciprocalRankSame = 0
  let reciprocalRankAdjacent = 0

  for (const queryIndex of queries) {
    const startedAt = performance.now()
    const top = topCandidates(entries, queryIndex)
    durations.push(performance.now() - startedAt)
    const query = entries[queryIndex]
    const adjacent = adjacentByIndex.get(queryIndex) || new Set()
    const sameRank = top.findIndex(
      (candidate) => entries[candidate.index].videoId === query.videoId,
    )
    const adjacentRank = top.findIndex((candidate) => adjacent.has(candidate.index))
    if (sameRank >= 0) reciprocalRankSame += 1 / (sameRank + 1)
    if (adjacentRank >= 0) reciprocalRankAdjacent += 1 / (adjacentRank + 1)
    for (const k of topKs) {
      const subset = top.slice(0, k)
      if (subset.some((candidate) => entries[candidate.index].videoId === query.videoId)) {
        sameHits[k] += 1
      }
      if (subset.some((candidate) => adjacent.has(candidate.index))) adjacentHits[k] += 1
    }
  }

  const denominator = Math.max(1, queries.length)
  return {
    modelName,
    indexedFrames: entries.length,
    indexedVideos: byVideo.size,
    eligibleVideos: [...byVideo.values()].filter((indices) => indices.length >= 2).length,
    queries: queries.length,
    recallSameVideo: Object.fromEntries(topKs.map((k) => [`@${k}`, sameHits[k] / denominator])),
    recallAdjacent: Object.fromEntries(topKs.map((k) => [`@${k}`, adjacentHits[k] / denominator])),
    mrrSameVideo: reciprocalRankSame / denominator,
    mrrAdjacent: reciprocalRankAdjacent / denominator,
    queryMs: {
      mean: durations.reduce((sum, value) => sum + value, 0) / denominator,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: Math.max(0, ...durations),
    },
  }
}

async function main() {
  if (!fs.existsSync(manifestPath)) throw new Error(`Frame manifest not found: ${manifestPath}`)
  if (!fs.existsSync(indexPath)) throw new Error(`Frame index not found: ${indexPath}`)
  const startedAt = performance.now()
  const manifest = new Map()
  const manifestMalformed = await eachJsonLine(manifestPath, (row) => {
    if (
      row?.status !== 'done' ||
      typeof row.imagePath !== 'string' ||
      typeof row.videoId !== 'string'
    )
      return
    manifest.set(keyOf(row.imagePath), {
      frameId: typeof row.frameId === 'string' ? row.frameId : row.imagePath,
      imagePath: row.imagePath,
      videoId: row.videoId,
      videoPath: typeof row.videoPath === 'string' ? row.videoPath : '',
      timestampMs: Number.isFinite(row.timestampMs) ? row.timestampMs : 0,
    })
  })
  const manifestLoadMs = performance.now() - startedAt

  const entriesByModel = new Map(models.map((model) => [model, []]))
  let dimensionErrors = 0
  const indexStartedAt = performance.now()
  const indexMalformed = await eachJsonLine(indexPath, (row) => {
    const target = entriesByModel.get(row?.modelName)
    if (!target || typeof row.imagePath !== 'string') return
    const metadata = manifest.get(keyOf(row.imagePath))
    if (!metadata) return
    const vector = normalizeVector(row.vector)
    if (!vector || vector.length !== expectedDimensions[row.modelName]) {
      dimensionErrors += 1
      return
    }
    target.push({ ...metadata, vector })
  })
  const indexLoadMs = performance.now() - indexStartedAt
  const results = []
  for (const model of models) {
    const entries = entriesByModel.get(model)
    if (entries.length > 1) results.push(evaluateModel(model, entries))
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mediaDir,
    groundTruth: {
      sameVideo: 'Any other indexed frame from the query video.',
      adjacent: 'Previous or next indexed frame by timestamp in the query video.',
    },
    queryLimit,
    topKs,
    manifestRecords: manifest.size,
    malformed: { manifest: manifestMalformed, index: indexMalformed, vectors: dimensionErrors },
    loadMs: { manifest: manifestLoadMs, index: indexLoadMs },
    models: results,
    totalMs: performance.now() - startedAt,
  }
  const artifactDir = path.join(root, 'artifacts', 'media-search-recall')
  await fsp.mkdir(artifactDir, { recursive: true })
  await fsp.writeFile(
    path.join(artifactDir, 'latest.json'),
    JSON.stringify(report, null, 2),
    'utf8',
  )
  console.log(JSON.stringify(report, null, 2))
  if (results.length === 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
