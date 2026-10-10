// ── Rerank Service ─────────────────────────────────────────
// Layer 3 candidate rescoring pipeline.
// Combines Hash TopK + Vector TopK, then applies colorScore,
// shapeScore (and future localFeatureScore, ocrScore) to
// produce final ranked results with match levels and reasons.

import path from 'path'
import fs from 'fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type {
  LayeredSearchResult,
  LayeredSearchRequest,
  LayeredSearchResponse,
  VectorSearchResult,
  MatchLevel,
  ModelStatus,
  LayeredSearchProgress,
  ColorFeature,
  ShapeFeature,
} from '../shared/vectorTypes'
import type { ImageSearchResult } from '../shared/ipc-contract'
import { getModelStatus } from './modelService'
import { searchVectorIndex } from './vectorIndexService'
import { colorSimilarity, extractColorFeature } from './colorFeatureService'
import { extractShapeFeature, shapeSimilarity } from './shapeFeatureService'
import { getColorFeature } from './vectorDatabaseService'
import { getShapeFeature } from './vectorDatabaseService'
import { resolveProjectSearchInputPath } from './projectSearchIndexService'
import { requireNormalizedEmbeddingVector } from './embeddingVectorValidation'
import type { NativeScopeState } from './semanticSearchScope'
import {
  decodeEmbeddingChildVector,
  EmbeddingChildBinaryFrameDecoder,
  type EmbeddingChildBinaryFrame,
} from './embeddingChildBinaryProtocol'

// ── Types ──────────────────────────────────────────────────

// Delegate types for the existing Hash search
export interface HashSearchDelegate {
  searchByImageAsync: (
    imagePath: string,
    threshold: number,
    topK: number,
    searchMode: string,
  ) => Promise<{
    results: ImageSearchResult[]
    queryHash?: string
    queryDctHash64?: string
    searchMs?: number
    candidateCount?: number
  }>
  hashImageAsync: (imagePath: string) => Promise<{
    diffHash64?: string
    dctHash64?: string
    diffHash256?: string
  }>
  isIndexedPath?: (filePath: string) => boolean
  getIndexedCount?: () => number
  /** One-shot scope snapshot for ANN candidate prefiltering. */
  listIndexedPaths?: () => string[] | Promise<string[]>
  /**
   * Explicit Native scope state (VAL-036). When it reports 'corrupt', the
   * vector resolvers below fail closed instead of widening to the full
   * library. Delegates without it keep the legacy count-only behavior.
   */
  getScopeState?: () => NativeScopeState
}

// ── State ──────────────────────────────────────────────────

let hashDelegate: HashSearchDelegate | null = null
export function setHashDelegate(d: HashSearchDelegate): void {
  hashDelegate = d
}

export function resolveVectorPathFilter(
  delegate: HashSearchDelegate | null,
): ((filePath: string) => boolean) | undefined {
  if (!delegate?.isIndexedPath) return undefined
  // Fail closed: a corrupted scope is not an empty scope (VAL-036).
  if (delegate.getScopeState?.() === 'corrupt') return () => false
  const indexedCount = delegate.getIndexedCount?.()
  return indexedCount === 0 ? undefined : delegate.isIndexedPath
}

/**
 * Scope snapshot for the ANN worker, drawn from the same delegate as
 * resolveVectorPathFilter. Undefined when the index is empty or the delegate
 * has no enumeration capability; ANN then keeps the legacy post-filter behavior.
 * An implemented export that fails rejects this promise, so searchLayered
 * records the failure and retains Hash-only results instead of widening scope.
 * A corrupted scope fails closed with an empty snapshot (VAL-036).
 */
export async function resolveVectorPathScopeKeys(
  delegate: HashSearchDelegate | null,
): Promise<string[] | undefined> {
  if (!delegate?.isIndexedPath || !delegate.listIndexedPaths) return undefined
  if (delegate.getScopeState?.() === 'corrupt') return []
  const indexedCount = delegate.getIndexedCount?.()
  if (indexedCount === 0) return undefined
  const paths = await delegate.listIndexedPaths()
  return paths.length > 0 ? paths : undefined
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Large embedding stores may need to build their disposable F16/ANN cache on
 * the first query. With no explicit deadline, let that preparation finish so
 * repeated searches do not restart the same work forever.
 */
export async function waitForVectorSearch(
  searchPromise: Promise<VectorSearchResult[]>,
  timeoutMs?: number,
  onTimeout: () => void = () => {},
): Promise<VectorSearchResult[]> {
  const deadlineMs =
    Number.isFinite(timeoutMs) && (timeoutMs as number) > 0
      ? Math.max(1, Math.floor(timeoutMs as number))
      : undefined
  if (deadlineMs === undefined) return searchPromise

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<VectorSearchResult[]>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      onTimeout()
      reject(new Error(`Vector timeout (${deadlineMs}ms)`))
    }, deadlineMs)
  })

  try {
    return await Promise.race([searchPromise, timeoutPromise])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

function applyLayeredMetrics(
  progress: LayeredSearchProgress,
  startedAt: number,
): LayeredSearchProgress {
  const elapsedMs = Math.max(0, Date.now() - startedAt)
  const seconds = elapsedMs / 1000
  const itemsPerSecond = seconds > 0 ? progress.scanned / seconds : 0
  const percent = typeof progress.percent === 'number' ? progress.percent : undefined
  return {
    ...progress,
    startedAt,
    elapsedMs,
    itemsPerSecond: Number.isFinite(itemsPerSecond) ? itemsPerSecond : 0,
    etaMs:
      typeof percent === 'number' && percent > 0 && percent < 100
        ? Math.max(0, Math.round((elapsedMs * (100 - percent)) / percent))
        : progress.phase === 'done'
          ? 0
          : progress.etaMs,
  }
}

// ── Scoring ────────────────────────────────────────────────

function normalizeWeights(
  hasVector: boolean,
  hasHash: boolean,
  hasColor: boolean,
  hasShape: boolean,
): { wVector: number; wHash: number; wColor: number; wShape: number } {
  // Default weights from spec: 0.45 vector, 0.15 hash, 0.20 color, 0.20 shape
  const wVector = hasVector ? 0.45 : 0
  const wHash = hasHash ? 0.15 : 0
  const wColor = hasColor ? 0.2 : 0
  const wShape = hasShape ? 0.2 : 0

  const total = wVector + wHash + wColor + wShape
  if (total === 0) return { wVector: 1, wHash: 0, wColor: 0, wShape: 0 }

  // Normalize to sum to 1.0
  return {
    wVector: wVector / total,
    wHash: wHash / total,
    wColor: wColor / total,
    wShape: wShape / total,
  }
}

function determineMatchLevel(hashScore: number, vectorScore: number): MatchLevel {
  if (hashScore >= 0.95) return 'exact'
  if (hashScore >= 0.85) return 'near_duplicate'
  if (vectorScore >= 0.8 && hashScore >= 0.5) return 'same_product'
  if (vectorScore >= 0.6) return 'similar_product'
  return 'weak'
}

const RERANK_FEATURE_CONCURRENCY = 6
const RERANK_FEATURE_POOL_MULTIPLIER = 2
const RERANK_FEATURE_POOL_MINIMUM = 200
const RERANK_INTERACTIVE_EXTRACTION_LIMIT = 32

async function ensureRerankFeatures(
  imageIds: string[],
  isCancelled: () => boolean,
  onProgress: (completed: number, total: number) => void,
): Promise<{ failures: number; prepared: number; deferred: number; firstError?: string }> {
  const featurePaths = imageIds.map(resolveProjectSearchInputPath)
  const allMissing = [...new Set(featurePaths)].filter(
    (featurePath) => !getColorFeature(featurePath) || !getShapeFeature(featurePath),
  )
  if (allMissing.length === 0) return { failures: 0, prepared: 0, deferred: 0 }
  const missing = allMissing.slice(0, RERANK_INTERACTIVE_EXTRACTION_LIMIT)
  let cursor = 0
  let completed = 0
  let failures = 0
  let firstError: string | undefined
  const workerCount = Math.min(RERANK_FEATURE_CONCURRENCY, missing.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        if (isCancelled()) throw new Error('Layered search cancelled')
        const index = cursor++
        if (index >= missing.length) return
        const featurePath = missing[index]
        try {
          await Promise.all([
            getColorFeature(featurePath)
              ? Promise.resolve()
              : extractColorFeature(featurePath, featurePath),
            getShapeFeature(featurePath)
              ? Promise.resolve()
              : extractShapeFeature(featurePath, featurePath),
          ])
        } catch (error) {
          failures += 1
          if (!firstError) firstError = errorMessage(error)
        } finally {
          completed += 1
          if (completed === 1 || completed % 10 === 0 || completed === missing.length) {
            onProgress(completed, missing.length)
          }
        }
      }
    }),
  )
  return {
    failures,
    prepared: missing.length - failures,
    deferred: allMissing.length - missing.length,
    ...(firstError ? { firstError } : {}),
  }
}

async function generateQueryVector(
  imagePath: string,
  modelStatus: ModelStatus,
  backend: 'cpu' | 'gpu' = 'cpu',
  isCancelled?: () => boolean,
): Promise<number[]> {
  const modelPath = modelStatus.installedPath || ''
  if (!modelPath || !fs.existsSync(modelPath)) {
    throw new Error('DINOv2 ONNX model file is not installed')
  }
  return runDinoChildOnce(imagePath, modelPath, 768, backend, isCancelled)
}

function getDinoChildPath(): string {
  const candidates = [
    path.join(__dirname, 'dinoEmbeddingChild.js'),
    path.join(process.resourcesPath || '', 'dinoEmbeddingChild.js'),
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* ok */
    }
  }
  return candidates[0]
}

interface DinoQueryPending {
  resolve: (vector: number[]) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  cancelPoll: ReturnType<typeof setInterval>
  dim: number
}

interface DinoQueryWorker {
  child: ChildProcessWithoutNullStreams
  key: string
  ready: boolean
  nextId: number
  stdoutDecoder: EmbeddingChildBinaryFrameDecoder
  stderrBuffer: string
  queuedTasks: string[]
  pending: Map<number, DinoQueryPending>
}

export function decodeDinoQueryVectorFrame(
  frame: EmbeddingChildBinaryFrame,
  expectedDim: number,
): number[] {
  return requireNormalizedEmbeddingVector(
    decodeEmbeddingChildVector(frame, expectedDim),
    expectedDim,
  )
}

let dinoQueryWorker: DinoQueryWorker | null = null

function stopDinoQueryWorker(error: Error): void {
  const worker = dinoQueryWorker
  if (!worker) return
  dinoQueryWorker = null
  for (const pending of worker.pending.values()) {
    clearTimeout(pending.timeout)
    clearInterval(pending.cancelPoll)
    pending.reject(error)
  }
  worker.pending.clear()
  try {
    worker.child.kill()
  } catch {
    /* already stopped */
  }
}

function finishDinoQuery(
  worker: DinoQueryWorker,
  id: number,
  error?: Error,
  vector?: number[],
): void {
  const pending = worker.pending.get(id)
  if (!pending) return
  worker.pending.delete(id)
  clearTimeout(pending.timeout)
  clearInterval(pending.cancelPoll)
  if (error) pending.reject(error)
  else pending.resolve(vector || [])
}

function ensureDinoQueryWorker(modelPath: string, backend: 'cpu' | 'gpu'): DinoQueryWorker {
  const key = `${backend}:${modelPath}`
  if (dinoQueryWorker?.key === key && !dinoQueryWorker.child.killed) return dinoQueryWorker
  if (dinoQueryWorker) stopDinoQueryWorker(new Error('DINO query backend changed'))

  const nodePath = [
    process.env.NODE_PATH,
    path.join(process.resourcesPath || '', 'app.asar', 'node_modules'),
    path.join(process.resourcesPath || '', 'app', 'node_modules'),
    path.join(__dirname, '..', 'node_modules'),
  ]
    .filter(Boolean)
    .join(path.delimiter)
  const child = spawn(process.execPath, [getDinoChildPath()], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: nodePath },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const worker: DinoQueryWorker = {
    child,
    key,
    ready: false,
    nextId: 1,
    stdoutDecoder: new EmbeddingChildBinaryFrameDecoder(),
    stderrBuffer: '',
    queuedTasks: [],
    pending: new Map(),
  }
  dinoQueryWorker = worker
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: Buffer) => {
    const decoded = worker.stdoutDecoder.push(chunk)
    if (decoded.overflow) {
      if (dinoQueryWorker === worker) {
        stopDinoQueryWorker(new Error('DINO query child emitted an invalid binary frame'))
      }
      return
    }
    for (const frame of decoded.frames) {
      const message = frame.header
      if (message.type === 'ready') {
        worker.ready = true
        for (const task of worker.queuedTasks) child.stdin.write(task)
        worker.queuedTasks = []
      } else if (Number.isInteger(message.id)) {
        const id = message.id as number
        const pending = worker.pending.get(id)
        if (!pending) continue
        if (message.ok !== true) {
          finishDinoQuery(
            worker,
            id,
            new Error(
              typeof message.error === 'string'
                ? message.error
                : 'DINO query child returned an error',
            ),
          )
          continue
        }
        try {
          finishDinoQuery(worker, id, undefined, decodeDinoQueryVectorFrame(frame, pending.dim))
        } catch (error) {
          finishDinoQuery(
            worker,
            id,
            new Error(`DINO query child returned an invalid vector: ${errorMessage(error)}`),
          )
        }
      }
    }
  })
  child.stderr.on('data', (chunk: string) => {
    worker.stderrBuffer = `${worker.stderrBuffer}${chunk}`.slice(-2000)
  })
  child.stdin.on('error', (error) => {
    if (dinoQueryWorker === worker) stopDinoQueryWorker(error)
  })
  child.on('error', (error) => {
    if (dinoQueryWorker === worker) stopDinoQueryWorker(error)
  })
  child.on('exit', (code, signal) => {
    if (dinoQueryWorker !== worker) return
    stopDinoQueryWorker(
      new Error(
        `DINO query child exited: code=${code ?? 'null'} signal=${signal ?? 'null'} ${worker.stderrBuffer.trim()}`,
      ),
    )
  })
  return worker
}

function runDinoChildOnce(
  imagePath: string,
  modelPath: string,
  dim: number,
  backend: 'cpu' | 'gpu',
  isCancelled?: () => boolean,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const worker = ensureDinoQueryWorker(modelPath, backend)
    const id = worker.nextId++
    const timeout = setTimeout(() => {
      finishDinoQuery(worker, id, new Error('DINO query child timeout'))
      if (dinoQueryWorker === worker) stopDinoQueryWorker(new Error('DINO query child timeout'))
    }, 30000)
    const cancelPoll = setInterval(() => {
      if (!isCancelled?.()) return
      finishDinoQuery(worker, id, new Error('DINO query cancelled'))
      if (dinoQueryWorker === worker) stopDinoQueryWorker(new Error('DINO query cancelled'))
    }, 50)
    cancelPoll.unref()
    worker.pending.set(id, { resolve, reject, timeout, cancelPoll, dim })
    const task = `${JSON.stringify({
      id,
      imageId: imagePath,
      imagePath,
      modelPath,
      dim,
      backend,
      batchSize: 1,
    })}\n`
    if (worker.ready) worker.child.stdin.write(task)
    else worker.queuedTasks.push(task)
  })
}

// ── Main search ────────────────────────────────────────────

type LayeredProgressCallback = (progress: LayeredSearchProgress) => void
let layeredSearchSequence = 0

/**
 * Cancel the in-flight layered search (and any Subject search riding on it):
 * bumping the sequence makes the current search's isCancelled() true without
 * starting a new one. The next searchLayered call is unaffected.
 */
export function stopLayeredSearch(): void {
  layeredSearchSequence += 1
}

function makeProgressEmitter(
  req: LayeredSearchRequest,
  cb?: LayeredProgressCallback,
  startedAt = Date.now(),
): (patch: Omit<LayeredSearchProgress, 'requestId' | 'mode'>) => void {
  return (patch) => {
    cb?.(
      applyLayeredMetrics(
        {
          requestId: req.requestId,
          mode: req.mode,
          ...patch,
        },
        startedAt,
      ),
    )
  }
}

export async function searchLayered(
  req: LayeredSearchRequest,
  onProgress?: LayeredProgressCallback,
): Promise<LayeredSearchResponse> {
  const searchSequence = ++layeredSearchSequence
  let timedOut = false
  const isCancelled = () => timedOut || searchSequence !== layeredSearchSequence
  const t0 = Date.now()
  const emitProgress = makeProgressEmitter(req, onProgress, t0)
  emitProgress({ phase: 'preparing', scanned: 0, percent: 0, message: 'Preparing image search...' })
  const modelStatus = getModelStatus('dinov2_vitb14')
  const degradationReasons: string[] = []
  let hashResults: ImageSearchResult[] = []
  let vectorResults: VectorSearchResult[] = []
  let queryHash: string | undefined
  let queryDctHash64: string | undefined
  let hashMs = 0
  let vectorMs = 0

  // ── Stage 1: Hash Retrieval (always available) ───────────
  if (hashDelegate) {
    const tHash = Date.now()
    try {
      emitProgress({ phase: 'hash', scanned: 0, percent: 10, message: 'Hash search...' })
      const hashResp = await hashDelegate.searchByImageAsync(
        req.imagePath,
        req.hashThreshold ?? 14,
        req.hashTopK ?? 100,
        'balanced',
      )
      hashResults = hashResp.results
      queryHash = hashResp.queryHash
      queryDctHash64 = hashResp.queryDctHash64
      hashMs = Date.now() - tHash
      emitProgress({
        phase: 'hash',
        scanned: hashResults.length,
        percent: req.mode === 'fast' ? 85 : 25,
        message: `Hash candidates: ${hashResults.length.toLocaleString()}`,
      })
    } catch (err: unknown) {
      degradationReasons.push(`Hash search failed: ${errorMessage(err)}`)
    }
  } else {
    degradationReasons.push('Hash delegate not configured')
  }

  // ── Stage 2: Vector Retrieval ────────────────────────────
  if (hashDelegate?.getScopeState?.() === 'corrupt') {
    degradationReasons.push(
      'Native image index is corrupted; vector candidates were not widened beyond the verified scope.',
    )
  }
  if (req.mode === 'standard' || req.mode === 'precise') {
    if (modelStatus.state === 'downloaded' || modelStatus.state === 'loaded') {
      const tVec = Date.now()
      try {
        emitProgress({
          phase: 'vector_embedding',
          scanned: 0,
          percent: 30,
          message: 'Embedding query image...',
        })
        const queryVector = await generateQueryVector(
          req.imagePath,
          modelStatus,
          req.backend || 'cpu',
          isCancelled,
        )
        emitProgress({
          phase: 'vector_search',
          scanned: 0,
          percent: 40,
          message: 'Vector search...',
        })

        const vectorPathFilter = resolveVectorPathFilter(hashDelegate)
        const vectorPathScopeKeys = await resolveVectorPathScopeKeys(hashDelegate)
        const vectorPromise = searchVectorIndex(
          {
            queryVector,
            topK: req.vectorTopK ?? 200,
            modelName: 'dinov2_vitb14',
            embeddingType: 'global',
            isCancelled,
            acceptPath: vectorPathFilter,
            acceptPathKeys: vectorPathScopeKeys,
          },
          (progress) => {
            const inner = Math.max(0, Math.min(100, progress.percent ?? 0))
            emitProgress({
              phase: 'vector_search',
              scanned: progress.scanned,
              total: progress.totalBytes,
              percent: 40 + Math.round(inner * 0.35),
              message: `Vector search: ${inner}%`,
            })
          },
        )
        vectorResults = await waitForVectorSearch(vectorPromise, req.timeoutMs, () => {
          timedOut = true
        })
        vectorMs = Date.now() - tVec
        emitProgress({
          phase: 'vector_search',
          scanned: vectorResults.length,
          percent: 76,
          message: `Vector candidates: ${vectorResults.length.toLocaleString()}`,
        })
      } catch (err: unknown) {
        const msg = errorMessage(err)
        if (msg.includes('timeout')) {
          degradationReasons.push(`${msg}. Falling back to Hash-only.`)
        } else {
          degradationReasons.push(`Vector search failed: ${msg}`)
        }
      }
    } else {
      degradationReasons.push(
        `Model not ready (${modelStatus.state}). Degrading to Hash-only search.`,
      )
    }
  }

  // ── Stage 3: Merge candidates ────────────────────────────
  const candidateMap = new Map<
    string,
    {
      hashScore: number
      vectorScore: number
      diffDistance?: number
      dctDistance?: number
      sources: ('hash' | 'vector')[]
      width?: number
      height?: number
      fileSize?: number
      modifiedTime?: number
      path?: string
    }
  >()
  emitProgress({ phase: 'merge', scanned: 0, percent: 80, message: 'Merging candidates...' })

  for (const r of hashResults) {
    const id = r.path || r.id
    candidateMap.set(id, {
      hashScore: r.score,
      vectorScore: 0,
      diffDistance: r.distance,
      dctDistance: undefined,
      sources: ['hash'],
      width: r.width,
      height: r.height,
      fileSize: r.fileSize,
      modifiedTime: r.modifiedTime,
      path: r.path,
    })
  }

  for (const r of vectorResults) {
    const id = r.path || r.imageId
    const existing = candidateMap.get(id)
    if (existing) {
      existing.vectorScore = r.vectorScore
      existing.sources.push('vector')
      if (r.path) existing.path = r.path
    } else {
      candidateMap.set(id, {
        hashScore: 0,
        vectorScore: r.vectorScore,
        sources: ['vector'],
        path: r.path || r.imageId,
      })
    }
  }

  const mergedCandidateCount = candidateMap.size

  // ── Cross-layer overlay filter ──────────────────────────
  // Remove candidates whose files no longer exist on disk.
  // This syncs the vector layer with hash-layer tombstones.
  let overlayFiltered = 0
  for (const [imageId] of candidateMap) {
    // Only validate if imageId looks like a real path (not an opaque hash digest)
    if (
      !imageId ||
      imageId.includes('..') ||
      imageId.startsWith('/') ||
      /^[A-Za-z]:[\\/]/.test(imageId)
    ) {
      try {
        if (!fs.existsSync(imageId)) {
          candidateMap.delete(imageId)
          overlayFiltered++
        }
      } catch {
        candidateMap.delete(imageId)
        overlayFiltered++
      }
    }
  }
  if (overlayFiltered > 0) {
    degradationReasons.push(
      `Filtered ${overlayFiltered.toLocaleString()} missing vector/hash candidate(s).`,
    )
  }

  // ── Stage 4: Rerank ──────────────────────────────────────
  const rerankTopK = req.rerankTopK ?? 50
  const scored: LayeredSearchResult[] = []
  const rerankTotal = Math.max(1, candidateMap.size)
  let rerankScanned = 0
  let featureCandidateIds = new Set<string>()
  let queryColorFeature: ColorFeature | undefined
  let queryShapeFeature: ShapeFeature | undefined
  let featurePreparedCount = 0
  let featureDeferredCount = 0
  let featureMs = 0

  if (req.mode === 'precise') {
    const featureStartedAt = Date.now()
    const featurePoolSize = Math.min(
      candidateMap.size,
      Math.max(RERANK_FEATURE_POOL_MINIMUM, rerankTopK * RERANK_FEATURE_POOL_MULTIPLIER),
    )
    const baseRanked = [...candidateMap.entries()]
      .map(([imageId, candidate]) => {
        const weights = normalizeWeights(
          candidate.vectorScore > 0,
          candidate.hashScore > 0,
          false,
          false,
        )
        return {
          imageId,
          score: weights.wVector * candidate.vectorScore + weights.wHash * candidate.hashScore,
        }
      })
      .sort((left, right) => right.score - left.score || left.imageId.localeCompare(right.imageId))
      .slice(0, featurePoolSize)
    featureCandidateIds = new Set(baseRanked.map((item) => item.imageId))
    const featureResult = await ensureRerankFeatures(
      [req.imagePath, ...featureCandidateIds],
      isCancelled,
      (completed, total) => {
        emitProgress({
          phase: 'rerank',
          scanned: completed,
          total,
          percent: 85 + Math.round((completed / Math.max(1, total)) * 10),
          message: `Preparing rerank features: ${completed.toLocaleString()} / ${total.toLocaleString()}`,
        })
      },
    )
    featurePreparedCount = featureResult.prepared
    featureDeferredCount = featureResult.deferred
    featureMs = Date.now() - featureStartedAt
    if (featureResult.failures > 0) {
      degradationReasons.push(
        `Feature extraction failed for ${featureResult.failures.toLocaleString()} candidate(s): ${
          featureResult.firstError || 'unknown error'
        }`,
      )
    }
    queryColorFeature = getColorFeature(req.imagePath)
    queryShapeFeature = getShapeFeature(req.imagePath)
  }

  for (const [imageId, candidate] of candidateMap) {
    if (isCancelled()) throw new Error('Layered search cancelled')
    rerankScanned++
    if (rerankScanned === 1 || rerankScanned % 20 === 0 || rerankScanned === rerankTotal) {
      emitProgress({
        phase: 'rerank',
        scanned: rerankScanned,
        total: rerankTotal,
        percent: 95 + Math.round((rerankScanned / rerankTotal) * 3),
        message: `Reranking: ${rerankScanned.toLocaleString()} / ${rerankTotal.toLocaleString()}`,
      })
    }
    let colorScore = 0
    let shapeScore = 0
    const reasons: string[] = []

    if (req.mode === 'precise' && featureCandidateIds.has(imageId)) {
      const featurePath = resolveProjectSearchInputPath(imageId)
      const candidateColorFeature = getColorFeature(featurePath)
      const candidateShapeFeature = getShapeFeature(featurePath)
      if (queryColorFeature && candidateColorFeature) {
        colorScore = colorSimilarity(queryColorFeature.colorHist, candidateColorFeature.colorHist)
      }
      if (queryShapeFeature && candidateShapeFeature) {
        shapeScore = shapeSimilarity(queryShapeFeature, candidateShapeFeature)
      }
    }

    // Build reasons
    if (candidate.hashScore >= 0.85) reasons.push('Hash 高度相似')
    if (candidate.vectorScore >= 0.8) reasons.push('DINOv2 视觉向量高度相似')
    if (colorScore >= 0.7) reasons.push('主体颜色接近')
    if (shapeScore >= 0.7) reasons.push('主体比例接近')
    if (candidate.dctDistance !== undefined && candidate.dctDistance <= 5)
      reasons.push('DCT 精排一致')

    if (degradationReasons.length > 0 && reasons.length === 0) {
      reasons.push('模型未安装，仅使用 Hash 搜索')
    }

    // Compute final score
    const hasVector = candidate.vectorScore > 0
    const hasHash = candidate.hashScore > 0
    const hasColor = colorScore > 0
    const hasShape = shapeScore > 0
    const w = normalizeWeights(hasVector, hasHash, hasColor, hasShape)

    const finalScore =
      w.wVector * candidate.vectorScore +
      w.wHash * candidate.hashScore +
      w.wColor * colorScore +
      w.wShape * shapeScore

    const matchLevel = determineMatchLevel(candidate.hashScore, candidate.vectorScore)

    scored.push({
      imageId,
      path: candidate.path || imageId,
      finalScore: Math.round(finalScore * 1000) / 1000,
      hashScore: Math.round(candidate.hashScore * 1000) / 1000,
      vectorScore: Math.round(candidate.vectorScore * 1000) / 1000,
      colorScore: Math.round(colorScore * 1000) / 1000,
      shapeScore: Math.round(shapeScore * 1000) / 1000,
      localFeatureScore: 0,
      ocrScore: 0,
      diffDistance: candidate.diffDistance,
      dctDistance: candidate.dctDistance,
      matchLevel,
      reasons,
      indexSources: candidate.sources,
      width: candidate.width,
      height: candidate.height,
      fileSize: candidate.fileSize,
      modifiedTime: candidate.modifiedTime,
    })
  }

  // Sort by finalScore descending
  scored.sort((a, b) => b.finalScore - a.finalScore)

  // Take top K
  const topResults = scored.slice(0, rerankTopK)
  emitProgress({
    phase: 'done',
    scanned: topResults.length,
    total: rerankTopK,
    percent: 100,
    message: 'Image search complete',
  })

  const totalMs = Date.now() - t0

  return {
    results: topResults,
    mode: req.mode,
    degraded: degradationReasons.length > 0,
    degradationReasons,
    queryHash,
    queryDctHash64,
    hashCandidateCount: hashResults.length,
    vectorCandidateCount: vectorResults.length,
    mergedCandidateCount,
    rerankedCount: topResults.length,
    featureRerankCandidateCount: featureCandidateIds.size,
    featurePreparedCount,
    featureDeferredCount,
    totalMs,
    hashMs,
    vectorMs,
    rerankMs: totalMs - hashMs - vectorMs,
    featureMs,
    modelStatus,
    searchMode: req.mode,
  }
}
