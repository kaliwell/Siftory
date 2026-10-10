import fs from 'fs'
import readline from 'readline'
import { parentPort, workerData } from 'worker_threads'
import {
  buildFeedbackSearchCenters,
  buildFeedbackTargetModel,
  scoreAssetFeedbackTarget,
  type AssetFeedbackTargetModel,
} from './assetFeedbackModel'
import type {
  AssetFeedbackSourceSnapshot,
  AssetFeedbackSourceTarget,
} from './assetFeedbackModelService'
import {
  embeddingCachePathKey,
  ensureEmbeddingF16Cache,
  float16ToFloat32,
  readEmbeddingF16VectorsForPaths,
} from './embeddingF16Cache'
import type { PreparedClipEmbeddingCache } from './semanticSearchService'

export interface AssetCategoryFeedbackWorkerProgress {
  stage: 'clip' | 'feedback' | 'dino'
  current: number
  total: number
  percent: number
  message: string
}

export interface AssetFeedbackBuildWorkerInput {
  kind: 'feedback_build'
  source: AssetFeedbackSourceSnapshot
  cache: PreparedClipEmbeddingCache
}

export interface AssetFeedbackBuildWorkerResult {
  dim: number
  sourceSampleCount: number
  embeddedSampleCount: number
  skippedSampleCount: number
  targets: AssetFeedbackTargetModel[]
}

export interface AssetCategorySearchWorkerInput {
  kind: 'category_search'
  cache: PreparedClipEmbeddingCache
  target: AssetFeedbackTargetModel
  eligibleAssets: Array<{ id: number; pathKey: string }>
  clipCandidateK: number
  topK: number
  /** Optional ANN recall rows. Omit to run the complete exact CLIP diagnostic scan. */
  clipAnnCandidates?: Array<{ path: string; row: number }>
  clipCandidateWarning?: string
  dino: {
    cacheDir: string
    modelName: string
    embeddingType: string
    dim: number
    sourcePaths: string[]
  }
}

export interface AssetCategorySearchHit {
  assetId: number
  path: string
  score: number
  positiveScore: number
  negativeScore: number
  clipScore: number
  dinoScore?: number
}

export interface AssetCategorySearchWorkerResult {
  scanned: number
  mode: 'clip' | 'clip_dino'
  clipScanMode: 'ann' | 'exact'
  clipAnnCandidateCount: number
  clipCandidateCount: number
  clipIndexedCount: number
  hits: AssetCategorySearchHit[]
  dinoCandidateCount: number
  dinoPositiveSampleCount: number
  dinoNegativeSampleCount: number
  cacheVectorCount: number
  warning?: string
}

type AssetCategoryFeedbackWorkerInput =
  | AssetFeedbackBuildWorkerInput
  | AssetCategorySearchWorkerInput

interface ClipPathRow {
  row?: unknown
  path?: unknown
}

interface ClipCandidate {
  assetId: number
  key: string
  path: string
  score: number
  row: number
}

interface HeapNode {
  candidate: ClipCandidate
  index: number
}

const CLIP_WEIGHT = 0.25
const DINO_WEIGHT = 0.75
const MIN_DINO_POSITIVE_SAMPLES = 2
const MIN_DINO_CANDIDATE_COVERAGE = 0.6

function pathKey(filePath: string): string {
  return filePath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function stopped(stopView: Int32Array): boolean {
  return Atomics.load(stopView, 0) === 1
}

function checkStopped(stopView: Int32Array): void {
  if (stopped(stopView)) throw new Error('Asset library task cancelled')
}

function worse(left: HeapNode, right: HeapNode): boolean {
  if (left.candidate.score !== right.candidate.score) {
    return left.candidate.score < right.candidate.score
  }
  return left.candidate.key.localeCompare(right.candidate.key) > 0
}

class BoundedClipCandidateHeap {
  private readonly heap: HeapNode[] = []
  private readonly byKey = new Map<string, HeapNode>()

  constructor(private readonly limit: number) {}

  offer(candidate: ClipCandidate): void {
    const existing = this.byKey.get(candidate.key)
    if (existing) {
      if (candidate.score <= existing.candidate.score) return
      existing.candidate = candidate
      this.bubbleDown(existing.index)
      return
    }
    if (this.heap.length < this.limit) {
      const node = { candidate, index: this.heap.length }
      this.heap.push(node)
      this.byKey.set(candidate.key, node)
      this.bubbleUp(node.index)
      return
    }
    const worst = this.heap[0]
    if (
      !worst ||
      candidate.score < worst.candidate.score ||
      (candidate.score === worst.candidate.score &&
        candidate.key.localeCompare(worst.candidate.key) >= 0)
    ) {
      return
    }
    const node = { candidate, index: 0 }
    this.byKey.delete(worst.candidate.key)
    this.heap[0] = node
    this.byKey.set(candidate.key, node)
    this.bubbleDown(0)
  }

  values(): ClipCandidate[] {
    return this.heap.map((node) => node.candidate)
  }

  private bubbleUp(startIndex: number): void {
    let index = startIndex
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (!worse(this.heap[index], this.heap[parent])) break
      this.swap(index, parent)
      index = parent
    }
  }

  private bubbleDown(startIndex: number): void {
    let index = startIndex
    let moved = true
    while (moved) {
      moved = false
      const left = index * 2 + 1
      const right = left + 1
      let worst = index
      if (left < this.heap.length && worse(this.heap[left], this.heap[worst])) worst = left
      if (right < this.heap.length && worse(this.heap[right], this.heap[worst])) worst = right
      if (worst !== index) {
        this.swap(index, worst)
        index = worst
        moved = true
      }
    }
  }

  private swap(left: number, right: number): void {
    const leftNode = this.heap[left]
    const rightNode = this.heap[right]
    this.heap[left] = rightNode
    this.heap[right] = leftNode
    rightNode.index = left
    leftNode.index = right
  }
}

async function scanClipPathRows(
  cache: PreparedClipEmbeddingCache,
  stopView: Int32Array,
  onRow: (filePath: string, row: number) => void,
  onProgress: (current: number) => void,
): Promise<number> {
  const segments = cache.delta
    ? [
        { pathListPath: cache.pathListPath, firstRow: 0, rowLimit: cache.delta.baseCount },
        {
          pathListPath: cache.delta.pathListPath,
          firstRow: cache.delta.baseCount,
          rowLimit: cache.count,
        },
      ]
    : [{ pathListPath: cache.pathListPath, firstRow: 0, rowLimit: cache.count }]
  const latest = new Map<string, { path: string; row: number }>()
  let scanned = 0
  for (const segment of segments) {
    const lines = readline.createInterface({
      input: fs.createReadStream(segment.pathListPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    let segmentRow = segment.firstRow
    try {
      for await (const line of lines) {
        checkStopped(stopView)
        try {
          const parsed = JSON.parse(line) as ClipPathRow
          const row = Number.isInteger(parsed.row) ? (parsed.row as number) : segmentRow
          if (
            typeof parsed.path === 'string' &&
            row >= segment.firstRow &&
            row < segment.rowLimit
          ) {
            const key = pathKey(parsed.path)
            latest.delete(key)
            latest.set(key, { path: parsed.path, row })
          }
        } catch {
          /* Ignore malformed derived cache rows. */
        }
        segmentRow += 1
        scanned += 1
        if (scanned % 4096 === 0 || scanned === cache.count) {
          onProgress(scanned)
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }
    } finally {
      lines.close()
    }
  }
  for (const item of [...latest.values()].sort((left, right) => left.row - right.row)) {
    checkStopped(stopView)
    onRow(item.path, item.row)
  }
  return latest.size
}

function clipCacheRowBytes(cache: PreparedClipEmbeddingCache): number {
  return cache.dtype === 'f16-le' ? cache.dim * 2 : cache.dim * Float32Array.BYTES_PER_ELEMENT
}

interface ClipVectorReader {
  readRow: (row: number, buffer: Buffer) => number
  close: () => void
}

function openClipVectorReader(cache: PreparedClipEmbeddingCache): ClipVectorReader {
  const rowBytes = clipCacheRowBytes(cache)
  const baseFd = fs.openSync(cache.vectorPath, 'r')
  let deltaFd: number | null = null
  try {
    deltaFd = cache.delta ? fs.openSync(cache.delta.vectorPath, 'r') : null
  } catch (error) {
    fs.closeSync(baseFd)
    throw error
  }
  return {
    readRow(row, buffer) {
      if (deltaFd !== null && cache.delta && row >= cache.delta.baseCount) {
        return fs.readSync(deltaFd, buffer, 0, rowBytes, (row - cache.delta.baseCount) * rowBytes)
      }
      return fs.readSync(baseFd, buffer, 0, rowBytes, row * rowBytes)
    },
    close() {
      fs.closeSync(baseFd)
      if (deltaFd !== null) fs.closeSync(deltaFd)
    },
  }
}

function readNormalizedClipVector(
  reader: ClipVectorReader,
  cache: PreparedClipEmbeddingCache,
  row: number,
  buffer: Buffer,
): Float32Array | null {
  const rowBytes = clipCacheRowBytes(cache)
  if (reader.readRow(row, buffer) !== rowBytes) return null
  const vector = new Float32Array(cache.dim)
  let normSquared = 0
  if (cache.dtype === 'f16-le') {
    for (let index = 0; index < cache.dim; index++) {
      const value = float16ToFloat32(buffer.readUInt16LE(index * 2))
      vector[index] = value
      normSquared += value * value
    }
  } else {
    const source = new Float32Array(buffer.buffer, buffer.byteOffset, cache.dim)
    for (let index = 0; index < cache.dim; index++) {
      const value = source[index]
      vector[index] = value
      normSquared += value * value
    }
  }
  const norm = Math.sqrt(normSquared)
  if (!(norm > 0)) return null
  for (let index = 0; index < cache.dim; index++) vector[index] /= norm
  return vector
}

function offerClipCandidate(
  candidates: BoundedClipCandidateHeap,
  eligibleByPath: ReadonlyMap<string, number>,
  centers: readonly Float32Array[],
  reader: ClipVectorReader,
  cache: PreparedClipEmbeddingCache,
  buffer: Buffer,
  filePath: string,
  row: number,
): boolean {
  if (!Number.isSafeInteger(row) || row < 0 || row >= cache.count) {
    throw new Error('CLIP candidate row is outside the immutable snapshot')
  }
  const key = pathKey(filePath)
  const assetId = eligibleByPath.get(key)
  if (assetId === undefined) return false
  const vector = readNormalizedClipVector(reader, cache, row, buffer)
  if (!vector) return false
  let bestCosine = -1
  for (const center of centers) {
    let dot = 0
    for (let index = 0; index < cache.dim; index++) dot += center[index] * vector[index]
    bestCosine = Math.max(bestCosine, dot)
  }
  candidates.offer({
    assetId,
    key,
    path: filePath,
    score: Math.max(0, Math.min(1, (bestCosine + 1) / 2)),
    row,
  })
  return true
}

function requestedFeedbackPaths(source: AssetFeedbackSourceSnapshot): Set<string> {
  const result = new Set<string>()
  for (const target of source.targets) {
    for (const sample of target.positiveSamples) result.add(pathKey(sample.path))
    for (const sample of target.negativeSamples) result.add(pathKey(sample.path))
  }
  return result
}

function feedbackTargetFromVectors(
  target: AssetFeedbackSourceTarget,
  vectors: ReadonlyMap<string, Float32Array>,
): AssetFeedbackTargetModel | null {
  return buildFeedbackTargetModel({
    ...target,
    positiveVectors: target.positiveSamples.flatMap((sample) => {
      const vector = vectors.get(pathKey(sample.path))
      return vector ? [{ ...sample, vector }] : []
    }),
    negativeVectors: target.negativeSamples.flatMap((sample) => {
      const vector = vectors.get(pathKey(sample.path))
      return vector ? [{ ...sample, vector }] : []
    }),
  })
}

export async function runAssetFeedbackBuild(
  input: AssetFeedbackBuildWorkerInput,
  stopView: Int32Array,
  onProgress: (progress: AssetCategoryFeedbackWorkerProgress) => void,
): Promise<{ stopped: boolean; result?: AssetFeedbackBuildWorkerResult }> {
  const requested = requestedFeedbackPaths(input.source)
  const rows = new Map<string, number>()
  try {
    await scanClipPathRows(
      input.cache,
      stopView,
      (filePath, row) => {
        const key = pathKey(filePath)
        if (requested.has(key)) rows.set(key, row)
      },
      (current) =>
        onProgress({
          stage: 'clip',
          current,
          total: input.cache.count,
          percent: Math.round((current / Math.max(1, input.cache.count)) * 70),
          message: `Reading CLIP embedding cache: ${current.toLocaleString()}/${input.cache.count.toLocaleString()}`,
        }),
    )
    checkStopped(stopView)
    const vectors = new Map<string, Float32Array>()
    const rowBytes = clipCacheRowBytes(input.cache)
    const buffer = Buffer.allocUnsafe(rowBytes)
    const reader = openClipVectorReader(input.cache)
    try {
      let loaded = 0
      for (const [key, row] of rows) {
        checkStopped(stopView)
        const vector = readNormalizedClipVector(reader, input.cache, row, buffer)
        if (vector) vectors.set(key, vector)
        loaded += 1
        if (loaded % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      }
    } finally {
      reader.close()
    }

    const targets: AssetFeedbackTargetModel[] = []
    for (let index = 0; index < input.source.targets.length; index++) {
      checkStopped(stopView)
      const built = feedbackTargetFromVectors(input.source.targets[index], vectors)
      if (built) targets.push(built)
      const current = index + 1
      onProgress({
        stage: 'feedback',
        current,
        total: input.source.targets.length,
        percent: 70 + Math.round((current / Math.max(1, input.source.targets.length)) * 30),
        message: `Building feedback prototypes: ${current}/${input.source.targets.length}`,
      })
      if (index % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    return {
      stopped: false,
      result: {
        dim: input.cache.dim,
        sourceSampleCount: requested.size,
        embeddedSampleCount: vectors.size,
        skippedSampleCount: Math.max(0, requested.size - vectors.size),
        targets,
      },
    }
  } catch (error) {
    if (stopped(stopView)) return { stopped: true }
    throw error
  }
}

function clipFallback(
  candidates: AssetCategorySearchHit[],
  topK: number,
  warning?: string,
  cacheVectorCount = 0,
): Omit<
  AssetCategorySearchWorkerResult,
  'scanned' | 'clipScanMode' | 'clipAnnCandidateCount' | 'clipCandidateCount' | 'clipIndexedCount'
> {
  return {
    mode: 'clip',
    hits: candidates.slice(0, topK),
    dinoCandidateCount: 0,
    dinoPositiveSampleCount: 0,
    dinoNegativeSampleCount: 0,
    cacheVectorCount,
    ...(warning ? { warning } : {}),
  }
}

function buildDinoTarget(
  target: AssetFeedbackTargetModel,
  vectors: ReadonlyMap<string, Float32Array>,
): AssetFeedbackTargetModel {
  const positivePrototypes = target.positivePrototypes.flatMap((prototype) => {
    const vector = vectors.get(embeddingCachePathKey(prototype.path))
    return vector ? [{ path: prototype.path, vector }] : []
  })
  const negativePrototypes = target.negativePrototypes.flatMap((prototype) => {
    const vector = vectors.get(embeddingCachePathKey(prototype.path))
    return vector ? [{ path: prototype.path, vector }] : []
  })
  return {
    ...target,
    positiveSampleCount: positivePrototypes.length,
    negativeSampleCount: negativePrototypes.length,
    positivePrototypes,
    negativePrototypes,
  }
}

async function rerankWithDino(
  input: AssetCategorySearchWorkerInput,
  candidates: AssetCategorySearchHit[],
  stopView: Int32Array,
  onProgress: (progress: AssetCategoryFeedbackWorkerProgress) => void,
): Promise<
  Omit<
    AssetCategorySearchWorkerResult,
    'scanned' | 'clipScanMode' | 'clipAnnCandidateCount' | 'clipCandidateCount' | 'clipIndexedCount'
  >
> {
  if (candidates.length === 0) return clipFallback(candidates, input.topK)
  if (input.dino.sourcePaths.length === 0) {
    return clipFallback(candidates, input.topK, 'No DINO embeddings found; CLIP ranking used.')
  }
  try {
    const cache = await ensureEmbeddingF16Cache({
      ...input.dino,
      isCancelled: () => stopped(stopView),
      onProgress: (progress) => onProgress({ stage: 'dino', ...progress }),
    })
    checkStopped(stopView)
    if (!cache || cache.meta.count <= 0) {
      return clipFallback(candidates, input.topK, 'DINO cache is empty; CLIP ranking used.')
    }
    const requestedPaths = new Set<string>()
    for (const candidate of candidates) requestedPaths.add(candidate.path)
    for (const prototype of input.target.positivePrototypes) requestedPaths.add(prototype.path)
    for (const prototype of input.target.negativePrototypes) requestedPaths.add(prototype.path)
    const vectors = await readEmbeddingF16VectorsForPaths(cache, requestedPaths, {
      isCancelled: () => stopped(stopView),
      onProgress: (progress) => onProgress({ stage: 'dino', ...progress }),
    })
    checkStopped(stopView)
    const dinoTarget = buildDinoTarget(input.target, vectors)
    if (dinoTarget.positivePrototypes.length < MIN_DINO_POSITIVE_SAMPLES) {
      return clipFallback(
        candidates,
        input.topK,
        `Only ${dinoTarget.positivePrototypes.length} reviewed positive samples have DINO vectors; CLIP ranking used.`,
        cache.meta.count,
      )
    }
    const candidateVectorCount = candidates.reduce(
      (count, candidate) => count + (vectors.has(embeddingCachePathKey(candidate.path)) ? 1 : 0),
      0,
    )
    if (candidateVectorCount / Math.max(1, candidates.length) < MIN_DINO_CANDIDATE_COVERAGE) {
      return clipFallback(
        candidates,
        input.topK,
        `DINO candidate coverage is only ${Math.round((candidateVectorCount / Math.max(1, candidates.length)) * 100)}%; CLIP ranking used.`,
        cache.meta.count,
      )
    }
    const hits: AssetCategorySearchHit[] = []
    for (let index = 0; index < candidates.length; index++) {
      checkStopped(stopView)
      const candidate = candidates[index]
      const vector = vectors.get(embeddingCachePathKey(candidate.path))
      if (!vector) {
        hits.push({
          ...candidate,
          score: candidate.score * CLIP_WEIGHT,
          positiveScore: 0,
          negativeScore: 0,
        })
      } else {
        const dino = scoreAssetFeedbackTarget(vector, dinoTarget)
        hits.push({
          ...candidate,
          score: candidate.score * CLIP_WEIGHT + dino.score * DINO_WEIGHT,
          positiveScore: dino.positiveScore,
          negativeScore: dino.negativeScore,
          dinoScore: dino.score,
        })
      }
      if (index % 32 === 0 || index + 1 === candidates.length) {
        const current = index + 1
        onProgress({
          stage: 'dino',
          current,
          total: candidates.length,
          percent: Math.round((current / candidates.length) * 100),
          message: `DINO subject rerank: ${current.toLocaleString()}/${candidates.length.toLocaleString()} candidates`,
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    hits.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    return {
      mode: 'clip_dino',
      hits: hits.slice(0, input.topK),
      dinoCandidateCount: candidateVectorCount,
      dinoPositiveSampleCount: dinoTarget.positivePrototypes.length,
      dinoNegativeSampleCount: dinoTarget.negativePrototypes.length,
      cacheVectorCount: cache.meta.count,
    }
  } catch (error) {
    if (stopped(stopView)) throw error
    const message = error instanceof Error ? error.message : String(error)
    return clipFallback(candidates, input.topK, `DINO rerank unavailable: ${message}`)
  }
}

export async function runAssetCategorySearch(
  input: AssetCategorySearchWorkerInput,
  stopView: Int32Array,
  onProgress: (progress: AssetCategoryFeedbackWorkerProgress) => void,
): Promise<{ stopped: boolean; result?: AssetCategorySearchWorkerResult }> {
  try {
    const centers = buildFeedbackSearchCenters(input.target, 4)
    if (centers.length === 0) throw new Error('The selected category has no usable CLIP prototypes')
    const eligibleByPath = new Map(input.eligibleAssets.map((asset) => [asset.pathKey, asset.id]))
    const candidates = new BoundedClipCandidateHeap(input.clipCandidateK)
    const rowBytes = clipCacheRowBytes(input.cache)
    const buffer = Buffer.allocUnsafe(rowBytes)
    const reader = openClipVectorReader(input.cache)
    let scanned = 0
    try {
      if (input.clipAnnCandidates !== undefined) {
        const ordered = [...input.clipAnnCandidates].sort(
          (left, right) => left.row - right.row || left.path.localeCompare(right.path),
        )
        for (let index = 0; index < ordered.length; index++) {
          checkStopped(stopView)
          const candidate = ordered[index]
          scanned += 1
          offerClipCandidate(
            candidates,
            eligibleByPath,
            centers,
            reader,
            input.cache,
            buffer,
            candidate.path,
            candidate.row,
          )
          if ((index & 255) === 0 || index + 1 === ordered.length) {
            const current = index + 1
            onProgress({
              stage: 'clip',
              current,
              total: ordered.length,
              percent: Math.round((current / Math.max(1, ordered.length)) * 100),
              message: `CLIP ANN exact rerank: ${current.toLocaleString()}/${ordered.length.toLocaleString()} recalled rows...`,
            })
            await new Promise<void>((resolve) => setImmediate(resolve))
          }
        }
      } else {
        await scanClipPathRows(
          input.cache,
          stopView,
          (filePath, row) => {
            scanned += 1
            offerClipCandidate(
              candidates,
              eligibleByPath,
              centers,
              reader,
              input.cache,
              buffer,
              filePath,
              row,
            )
          },
          (current) =>
            onProgress({
              stage: 'clip',
              current,
              total: input.cache.count,
              percent: Math.min(99, Math.round((current / Math.max(1, input.cache.count)) * 100)),
              message: `Searching ${current.toLocaleString()}/${input.cache.count.toLocaleString()} CLIP vectors...`,
            }),
        )
      }
      checkStopped(stopView)
      const reranked: AssetCategorySearchHit[] = []
      const candidateValues = candidates.values()
      for (let index = 0; index < candidateValues.length; index++) {
        checkStopped(stopView)
        const candidate = candidateValues[index]
        const vector = readNormalizedClipVector(reader, input.cache, candidate.row, buffer)
        if (!vector) continue
        const score = scoreAssetFeedbackTarget(vector, input.target)
        reranked.push({
          assetId: candidate.assetId,
          path: candidate.path,
          ...score,
          clipScore: score.score,
        })
        if (index % 16 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      }
      reranked.sort(
        (left, right) => right.score - left.score || left.path.localeCompare(right.path),
      )
      const dinoResult = await rerankWithDino(
        input,
        reranked.slice(0, input.clipCandidateK),
        stopView,
        onProgress,
      )
      const warning = [input.clipCandidateWarning, dinoResult.warning]
        .filter((value): value is string => !!value)
        .join(' ')
      return {
        stopped: false,
        result: {
          scanned,
          ...dinoResult,
          clipScanMode: input.clipAnnCandidates !== undefined ? 'ann' : 'exact',
          clipAnnCandidateCount: input.clipAnnCandidates?.length || 0,
          clipCandidateCount: candidateValues.length,
          clipIndexedCount: input.cache.count,
          ...(warning ? { warning } : {}),
        },
      }
    } finally {
      reader.close()
    }
  } catch (error) {
    if (stopped(stopView)) return { stopped: true }
    throw error
  }
}

interface WorkerInput {
  input: AssetCategoryFeedbackWorkerInput
  stopBuffer: SharedArrayBuffer
}

if (parentPort && workerData) {
  const port = parentPort
  const { input, stopBuffer } = workerData as WorkerInput
  const stopView = new Int32Array(stopBuffer)
  const onProgress = (progress: AssetCategoryFeedbackWorkerProgress) =>
    port.postMessage({ type: 'progress', progress })
  const run =
    input.kind === 'feedback_build'
      ? runAssetFeedbackBuild(input, stopView, onProgress)
      : runAssetCategorySearch(input, stopView, onProgress)
  run
    .then((outcome) => {
      port.postMessage(
        outcome.stopped ? { type: 'stopped' } : { type: 'result', result: outcome.result },
      )
    })
    .catch((error: unknown) => {
      port.postMessage({ type: 'error', error: String(error) })
    })
}
