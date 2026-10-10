import fs from 'fs'
import type {
  MediaSearchFrameImageSearchResponse,
  MediaSearchFrameTextSearchResponse,
  MediaSearchVideoFrameRecord,
} from '../shared/ipc-contract'
import { embedImageForMediaSearch } from './frameQueryEmbeddingService'
import { getQueryTextEmbedding } from './semanticSearchService'
import { loadReadyVideoFrameManifest } from './videoFrameService'
import {
  normalizeFrameKey,
  normalizeFrameVector,
  normalizedCosineScore,
  expectedFrameVectorDim,
  type MediaFrameModelName,
} from './mediaSearchVectorMath'
import { pruneTopKCandidates } from './mediaSearchTopK'
import { createMediaSearchScopeMatcher, normalizeMediaSearchScopePaths } from './mediaSearchScope'
import { loadVideoManifest } from './videoScanService'

type ImageEmbeddingProvider = typeof embedImageForMediaSearch
type TextEmbeddingProvider = typeof getQueryTextEmbedding

let imageEmbeddingProvider: ImageEmbeddingProvider = embedImageForMediaSearch
let textEmbeddingProvider: TextEmbeddingProvider = getQueryTextEmbedding

export function setMediaSearchEmbeddingProvidersForTests(providers?: {
  image?: ImageEmbeddingProvider
  text?: TextEmbeddingProvider
}): void {
  imageEmbeddingProvider = providers?.image ?? embedImageForMediaSearch
  textEmbeddingProvider = providers?.text ?? getQueryTextEmbedding
}

export interface MediaSearchProgress {
  phase: 'embedding' | 'indexing' | 'scanning'
  shardIndex: number
  shardTotal: number
  candidatesScanned: number
}

function minimumUsefulScore(kind: 'image' | 'text', _modelName: MediaFrameModelName): number {
  if (kind === 'text') return 0
  return 0
}

function rankAndFilterFrames(
  candidates: MediaSearchVideoFrameRecord[],
  kind: 'image' | 'text',
  modelName: MediaFrameModelName,
  topK: number,
): MediaSearchVideoFrameRecord[] {
  if (candidates.length === 0) return []
  const sorted = [...candidates].sort((a, b) => (b.vectorScore ?? 0) - (a.vectorScore ?? 0))
  const cutoff = minimumUsefulScore(kind, modelName)
  return sorted
    .filter(
      (frame) =>
        (frame.vectorScore ?? 0) >= cutoff &&
        Boolean(frame.imagePath) &&
        fs.existsSync(frame.imagePath as string),
    )
    .slice(0, topK)
}

function getFrameScore(candidate: MediaSearchVideoFrameRecord): number {
  return candidate.vectorScore ?? 0
}

function missingVideoIds(): Set<string> {
  return new Set(
    loadVideoManifest()
      .filter((video) => video.missing)
      .map((video) => video.videoId),
  )
}

export async function searchVideoFramesByImage(input: {
  imagePath: string
  modelName?: MediaFrameModelName
  backend?: 'cpu' | 'gpu'
  topK?: number
  scanPaths?: string[]
  onProgress?: (progress: MediaSearchProgress) => void
}): Promise<MediaSearchFrameImageSearchResponse> {
  const searchStartedAt = performance.now()
  const modelName = input.modelName ?? 'clip_vit_base_patch32'
  const topK = Math.max(1, Math.min(1000, Math.floor(input.topK ?? 50)))
  const minScore = minimumUsefulScore('image', modelName)

  const manifestStartedAt = performance.now()
  const frames = loadReadyVideoFrameManifest()
  const unavailableVideos = missingVideoIds()
  const scopePaths = normalizeMediaSearchScopePaths(input.scanPaths)
  const isInScope = createMediaSearchScopeMatcher(scopePaths)
  const byImagePath = new Map(
    frames
      .filter(
        (record) =>
          record.imagePath && !unavailableVideos.has(record.videoId) && isInScope(record.videoPath),
      )
      .map((record) => [normalizeFrameKey(record.imagePath as string), record]),
  )
  const manifestMs = performance.now() - manifestStartedAt
  if (byImagePath.size === 0) {
    return {
      ok: false,
      queryImagePath: input.imagePath,
      modelName,
      results: [],
      totalCandidates: 0,
      error:
        scopePaths.length > 0
          ? 'No ready video frame images in the selected scan paths. Build Frames for this scope first.'
          : 'No ready video frame images. Build Frames first.',
    }
  }

  const indexStartedAt = performance.now()
  const { ensureFrameIndexFreshAsync, getFrameIndexVectorCount, scanFrameIndexVectors } =
    await import('./mediaSearchFrameIndex')
  input.onProgress?.({ phase: 'indexing', shardIndex: 0, shardTotal: 1, candidatesScanned: 0 })
  await ensureFrameIndexFreshAsync()

  const indexMs = performance.now() - indexStartedAt
  const frameVectorCount = await getFrameIndexVectorCount(modelName)
  if (frameVectorCount === 0) {
    return {
      ok: false,
      queryImagePath: input.imagePath,
      modelName,
      results: [],
      totalCandidates: 0,
      error: `No ${modelName} frame index. Build ${modelName === 'clip_vit_base_patch32' ? 'CLIP' : 'DINO'} Frames first.`,
    }
  }

  input.onProgress?.({ phase: 'embedding', shardIndex: 0, shardTotal: 1, candidatesScanned: 0 })
  const embeddingStartedAt = performance.now()
  const query = await imageEmbeddingProvider({
    imagePath: input.imagePath,
    modelName,
    backend: input.backend ?? 'gpu',
  })
  if (!query.ok || !query.vector) {
    return {
      ok: false,
      queryImagePath: input.imagePath,
      modelName,
      results: [],
      totalCandidates: 0,
      error: query.error || 'Query image embedding failed',
    }
  }
  const normalizedQuery = normalizeFrameVector(query.vector, expectedFrameVectorDim(modelName))
  if (!normalizedQuery) {
    return {
      ok: false,
      queryImagePath: input.imagePath,
      modelName,
      results: [],
      totalCandidates: 0,
      error: 'Query image embedding is invalid',
    }
  }
  const embeddingMs = performance.now() - embeddingStartedAt
  const candidates: MediaSearchVideoFrameRecord[] = []
  const scoringStartedAt = performance.now()
  let totalCandidates = 0

  input.onProgress?.({
    phase: 'scanning',
    shardIndex: 0,
    shardTotal: 1,
    candidatesScanned: 0,
  })
  const progressEvery = Math.max(200, Math.floor(frameVectorCount / 100))
  await scanFrameIndexVectors(modelName, (imagePath, vector) => {
    if (vector.length !== normalizedQuery.length) return
    const frame = byImagePath.get(normalizeFrameKey(imagePath))
    if (!frame) return
    totalCandidates += 1
    if (totalCandidates % progressEvery === 0) {
      input.onProgress?.({
        phase: 'scanning',
        shardIndex: totalCandidates,
        shardTotal: byImagePath.size,
        candidatesScanned: totalCandidates,
      })
    }
    const vectorScore = normalizedCosineScore(normalizedQuery, vector)
    if (vectorScore < minScore) return
    candidates.push({ ...frame, vectorScore })
    pruneTopKCandidates(candidates, topK, getFrameScore)
  })

  const unavailableAtCommit = missingVideoIds()
  const top = rankAndFilterFrames(candidates, 'image', modelName, topK).filter(
    (record) => !unavailableAtCommit.has(record.videoId),
  )
  const scoringMs = performance.now() - scoringStartedAt
  input.onProgress?.({
    phase: 'scanning',
    shardIndex: byImagePath.size,
    shardTotal: byImagePath.size,
    candidatesScanned: totalCandidates,
  })
  return {
    ok: true,
    queryImagePath: input.imagePath,
    modelName,
    results: top,
    totalCandidates,
    timings: {
      manifestMs,
      indexMs,
      embeddingMs,
      scoringMs,
      totalMs: performance.now() - searchStartedAt,
    },
  }
}

export async function searchVideoFramesByText(input: {
  textQuery: string
  topK?: number
  scanPaths?: string[]
  onProgress?: (progress: MediaSearchProgress) => void
  isCancelled?: () => boolean
}): Promise<MediaSearchFrameTextSearchResponse> {
  const searchStartedAt = performance.now()
  const textQuery = input.textQuery.trim()
  const topK = Math.max(1, Math.min(1000, Math.floor(input.topK ?? 50)))
  const modelName = 'clip_vit_base_patch32' as const
  if (!textQuery) {
    return {
      ok: false,
      query: textQuery,
      modelName,
      results: [],
      totalCandidates: 0,
      error: 'Empty text query',
    }
  }
  if (input.isCancelled?.()) throw new Error('Media search cancelled')

  const manifestStartedAt = performance.now()
  const frames = loadReadyVideoFrameManifest()
  const unavailableVideos = missingVideoIds()
  const scopePaths = normalizeMediaSearchScopePaths(input.scanPaths)
  const isInScope = createMediaSearchScopeMatcher(scopePaths)
  const byImagePath = new Map(
    frames
      .filter(
        (record) =>
          record.imagePath && !unavailableVideos.has(record.videoId) && isInScope(record.videoPath),
      )
      .map((record) => [normalizeFrameKey(record.imagePath as string), record]),
  )
  const manifestMs = performance.now() - manifestStartedAt
  if (byImagePath.size === 0) {
    return {
      ok: false,
      query: textQuery,
      modelName,
      results: [],
      totalCandidates: 0,
      error:
        scopePaths.length > 0
          ? 'No ready video frame images in the selected scan paths. Build Frames for this scope first.'
          : 'No ready video frame images. Build Frames first.',
    }
  }

  const indexStartedAt = performance.now()
  const { ensureFrameIndexFreshAsync, getFrameIndexVectorCount, scanFrameIndexVectors } =
    await import('./mediaSearchFrameIndex')
  input.onProgress?.({ phase: 'indexing', shardIndex: 0, shardTotal: 1, candidatesScanned: 0 })
  await ensureFrameIndexFreshAsync()
  if (input.isCancelled?.()) throw new Error('Media search cancelled')
  const indexMs = performance.now() - indexStartedAt
  const frameVectorCount = await getFrameIndexVectorCount(modelName)
  if (frameVectorCount === 0) {
    return {
      ok: false,
      query: textQuery,
      modelName,
      results: [],
      totalCandidates: 0,
      error: 'No CLIP frame embeddings. Build CLIP Frames first.',
    }
  }

  input.onProgress?.({ phase: 'embedding', shardIndex: 0, shardTotal: 1, candidatesScanned: 0 })
  const embeddingStartedAt = performance.now()
  const queryVector = await textEmbeddingProvider(textQuery)
  if (input.isCancelled?.()) throw new Error('Media search cancelled')
  const normalizedQuery = normalizeFrameVector(queryVector, expectedFrameVectorDim(modelName))
  if (!normalizedQuery) {
    return {
      ok: false,
      query: textQuery,
      modelName,
      results: [],
      totalCandidates: 0,
      error: 'CLIP text embedding is invalid',
    }
  }
  const embeddingMs = performance.now() - embeddingStartedAt

  const candidates: MediaSearchVideoFrameRecord[] = []
  const scoringStartedAt = performance.now()
  let totalCandidates = 0
  const minScore = minimumUsefulScore('text', modelName)
  input.onProgress?.({ phase: 'scanning', shardIndex: 0, shardTotal: 1, candidatesScanned: 0 })
  const progressEvery = Math.max(200, Math.floor(frameVectorCount / 100))
  await scanFrameIndexVectors(
    modelName,
    (imagePath, vector) => {
      if (vector.length !== normalizedQuery.length) return
      const frame = byImagePath.get(normalizeFrameKey(imagePath))
      if (!frame) return
      totalCandidates += 1
      if (totalCandidates % progressEvery === 0) {
        input.onProgress?.({
          phase: 'scanning',
          shardIndex: totalCandidates,
          shardTotal: byImagePath.size,
          candidatesScanned: totalCandidates,
        })
      }
      const vectorScore = normalizedCosineScore(normalizedQuery, vector)
      if (vectorScore < minScore) return
      candidates.push({ ...frame, vectorScore })
      pruneTopKCandidates(candidates, topK, getFrameScore)
    },
    { isCancelled: input.isCancelled },
  )

  const unavailableAtCommit = missingVideoIds()
  const top = rankAndFilterFrames(candidates, 'text', modelName, topK).filter(
    (record) => !unavailableAtCommit.has(record.videoId),
  )
  const scoringMs = performance.now() - scoringStartedAt
  input.onProgress?.({
    phase: 'scanning',
    shardIndex: byImagePath.size,
    shardTotal: byImagePath.size,
    candidatesScanned: totalCandidates,
  })
  return {
    ok: true,
    query: textQuery,
    modelName,
    results: top,
    totalCandidates,
    timings: {
      manifestMs,
      indexMs,
      embeddingMs,
      scoringMs,
      totalMs: performance.now() - searchStartedAt,
    },
  }
}
