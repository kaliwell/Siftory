import path from 'path'
import { app } from 'electron'
import type { AssetFeedbackTargetModel } from './assetFeedbackModel'
import { scoreAssetFeedbackTarget } from './assetFeedbackModel'
import {
  embeddingCachePathKey,
  ensureEmbeddingF16Cache,
  readEmbeddingF16VectorsForPaths,
  type EmbeddingF16CacheProgress,
} from './embeddingF16Cache'
import { getVisionModelCapability } from './modelRegistry'
import { getEmbeddingStorePaths } from './vectorDatabaseService'

const DINO_MODEL = 'dinov2_vitb14'
const DINO_DIM = getVisionModelCapability(DINO_MODEL).dim
const CLIP_WEIGHT = 0.25
const DINO_WEIGHT = 0.75
const MIN_DINO_POSITIVE_SAMPLES = 2
const MIN_DINO_CANDIDATE_COVERAGE = 0.6

export interface DinoCategoryCandidate {
  path: string
  score: number
  positiveScore: number
  negativeScore: number
}

export interface DinoCategoryRerankedCandidate extends DinoCategoryCandidate {
  clipScore: number
  dinoScore?: number
}

export interface DinoCategoryRerankResult {
  mode: 'clip' | 'clip_dino'
  hits: DinoCategoryRerankedCandidate[]
  dinoCandidateCount: number
  dinoPositiveSampleCount: number
  dinoNegativeSampleCount: number
  cacheVectorCount: number
  warning?: string
}

export interface DinoCategoryRerankOptions {
  topK: number
  isCancelled?: () => boolean
  onProgress?: (progress: EmbeddingF16CacheProgress) => void
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

function clipFallback(
  candidates: DinoCategoryCandidate[],
  topK: number,
  warning?: string,
  cacheVectorCount = 0,
): DinoCategoryRerankResult {
  return {
    mode: 'clip',
    hits: candidates.slice(0, topK).map((candidate) => ({
      ...candidate,
      clipScore: candidate.score,
    })),
    dinoCandidateCount: 0,
    dinoPositiveSampleCount: 0,
    dinoNegativeSampleCount: 0,
    cacheVectorCount,
    ...(warning ? { warning } : {}),
  }
}

export async function rerankCategoryCandidatesWithDino(
  candidates: DinoCategoryCandidate[],
  target: AssetFeedbackTargetModel,
  options: DinoCategoryRerankOptions,
): Promise<DinoCategoryRerankResult> {
  const topK = Math.max(1, Math.floor(options.topK))
  if (candidates.length === 0) return clipFallback(candidates, topK)
  const sourcePaths = getEmbeddingStorePaths(DINO_MODEL, 'global')
  if (sourcePaths.length === 0) {
    return clipFallback(candidates, topK, 'No DINO embeddings found; CLIP ranking used.')
  }

  try {
    const cache = await ensureEmbeddingF16Cache({
      cacheDir: path.join(app.getPath('userData'), 'vector-db', 'embedding-cache'),
      modelName: DINO_MODEL,
      embeddingType: 'global',
      dim: DINO_DIM,
      sourcePaths,
      isCancelled: options.isCancelled,
      onProgress: options.onProgress,
    })
    if (!cache || cache.meta.count <= 0) {
      return clipFallback(candidates, topK, 'DINO cache is empty; CLIP ranking used.')
    }

    const requestedPaths = new Set<string>()
    for (const candidate of candidates) requestedPaths.add(candidate.path)
    for (const prototype of target.positivePrototypes) requestedPaths.add(prototype.path)
    for (const prototype of target.negativePrototypes) requestedPaths.add(prototype.path)
    const vectors = await readEmbeddingF16VectorsForPaths(cache, requestedPaths, {
      isCancelled: options.isCancelled,
      onProgress: options.onProgress,
    })
    const dinoTarget = buildDinoTarget(target, vectors)
    if (dinoTarget.positivePrototypes.length < MIN_DINO_POSITIVE_SAMPLES) {
      return clipFallback(
        candidates,
        topK,
        `Only ${dinoTarget.positivePrototypes.length} reviewed positive samples have DINO vectors; CLIP ranking used.`,
        cache.meta.count,
      )
    }

    const candidateVectorCount = candidates.reduce(
      (count, candidate) => count + (vectors.has(embeddingCachePathKey(candidate.path)) ? 1 : 0),
      0,
    )
    const coverage = candidateVectorCount / Math.max(1, candidates.length)
    if (coverage < MIN_DINO_CANDIDATE_COVERAGE) {
      return clipFallback(
        candidates,
        topK,
        `DINO candidate coverage is only ${Math.round(coverage * 100)}%; CLIP ranking used.`,
        cache.meta.count,
      )
    }

    const hits: DinoCategoryRerankedCandidate[] = []
    for (let index = 0; index < candidates.length; index++) {
      if (options.isCancelled?.()) throw new Error('Category sample search cancelled')
      const candidate = candidates[index]
      const vector = vectors.get(embeddingCachePathKey(candidate.path))
      if (!vector) {
        hits.push({
          ...candidate,
          score: candidate.score * CLIP_WEIGHT,
          positiveScore: 0,
          negativeScore: 0,
          clipScore: candidate.score,
        })
        continue
      }
      const dino = scoreAssetFeedbackTarget(vector, dinoTarget)
      hits.push({
        path: candidate.path,
        score: candidate.score * CLIP_WEIGHT + dino.score * DINO_WEIGHT,
        positiveScore: dino.positiveScore,
        negativeScore: dino.negativeScore,
        clipScore: candidate.score,
        dinoScore: dino.score,
      })
      if (index % 32 === 0 || index + 1 === candidates.length) {
        options.onProgress?.({
          phase: 'loading',
          current: index + 1,
          total: candidates.length,
          percent: Math.round(((index + 1) / candidates.length) * 100),
          message: `DINO subject rerank: ${(index + 1).toLocaleString()}/${candidates.length.toLocaleString()} candidates`,
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    hits.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    return {
      mode: 'clip_dino',
      hits: hits.slice(0, topK),
      dinoCandidateCount: candidateVectorCount,
      dinoPositiveSampleCount: dinoTarget.positivePrototypes.length,
      dinoNegativeSampleCount: dinoTarget.negativePrototypes.length,
      cacheVectorCount: cache.meta.count,
    }
  } catch (error) {
    if (options.isCancelled?.()) throw error
    const message = error instanceof Error ? error.message : String(error)
    return clipFallback(candidates, topK, `DINO rerank unavailable: ${message}`)
  }
}
