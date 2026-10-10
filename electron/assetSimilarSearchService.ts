import crypto from 'crypto'
import path from 'path'
import type {
  AssetCategoryAssignment,
  AssetLibrarySearchResultQuery,
  AssetLibrarySimilarSearchRequest,
  AssetLibrarySimilarSearchResponse,
  AssetLibraryTaskProgress,
  AssetLibraryTaskResult,
  AssetRecord,
  AssetTagAssignment,
} from '../shared/ipc/asset-library'
import { SessionSearchResultCache } from './assetSearchResultCache'
import {
  embeddingCachePathKey,
  ensureEmbeddingF16Cache,
  readEmbeddingF16VectorsForPaths,
} from './embeddingF16Cache'
import { categoryReviewStates } from './assetCategorySampleSearchService'
import type {
  AssetSimilarSearchScanInput,
  AssetSimilarSearchWorkerProgress,
} from './assetSimilarSearchWorker'
import { runAssetTaskWorker } from './assetTaskWorkerHost'
import type { AssetLibraryRunningTask } from './assetLibraryTaskController'
import { getAssetLibraryBaseDir, requireAssetLibraryStores } from './assetLibraryStorageContext'
import type { ScoredAssetCandidate } from './assetLibraryScoring'
import { getVisionModelCapability } from './modelRegistry'
import { getEmbeddingStorePaths } from './vectorDatabaseService'

const DINO_MODEL = 'dinov2_vitb14'
const DINO_DIM = getVisionModelCapability(DINO_MODEL).dim
const assetSimilarSearchResults = new SessionSearchResultCache<AssetLibrarySimilarSearchResponse>()

export interface AssetSimilarSearchHost {
  startTask(
    type: 'asset_similar_search',
    runner: (task: AssetLibraryRunningTask) => Promise<string>,
  ): AssetLibraryTaskResult
  publishProgress(patch: Partial<AssetLibraryTaskProgress>): void
}

function formalStatus(status: AssetCategoryAssignment['status']): boolean {
  return status === 'confirmed' || status === 'manual_override'
}

function isActiveAsset(asset: AssetRecord | undefined): asset is AssetRecord {
  return !!asset && !asset.missing && !asset.archived
}

export function clearAssetSimilarSearchResults(): void {
  assetSimilarSearchResults.clear()
}

export function startAssetSimilarSearchTask(
  request: AssetLibrarySimilarSearchRequest,
  host: AssetSimilarSearchHost,
): AssetLibraryTaskResult {
  const stores = requireAssetLibraryStores()
  const category = request.categoryId ? stores.categories.getById(request.categoryId) : undefined
  if (request.categoryId && !category) return { ok: false, error: 'Category not found' }
  return host.startTask('asset_similar_search', async (task) => {
    const startedAt = Date.now()
    const topK = Math.max(10, Math.min(500, Math.floor(request.topK || 100)))
    const includeReviewed = request.includeReviewed === true
    await stores.assets.ensureLoaded()
    const queryAsset = stores.assets.getById(request.assetId)
    if (!isActiveAsset(queryAsset)) throw new Error('Query asset is not available')

    const sourcePaths = getEmbeddingStorePaths(DINO_MODEL, 'global')
    if (sourcePaths.length === 0) throw new Error('No DINO embeddings found. Build DINO first.')
    const cacheDir = path.join(
      path.dirname(getAssetLibraryBaseDir()),
      'vector-db',
      'embedding-cache',
    )
    const cache = await ensureEmbeddingF16Cache({
      cacheDir,
      modelName: DINO_MODEL,
      embeddingType: 'global',
      dim: DINO_DIM,
      sourcePaths,
      isCancelled: () => task.cancelled,
      onProgress: (progress) => {
        host.publishProgress({
          current: progress.current,
          total: progress.total,
          percent: Math.round(progress.percent * 0.2),
          message: progress.message,
        })
      },
    })
    if (!cache || cache.meta.count <= 0) throw new Error('DINO Float16 cache is empty')

    const queryVectors = await readEmbeddingF16VectorsForPaths(cache, [queryAsset.path], {
      isCancelled: () => task.cancelled,
      onProgress: (progress) => {
        host.publishProgress({
          current: progress.current,
          total: progress.total,
          percent: 20 + Math.round(progress.percent * 0.1),
          message: `Locating query image: ${progress.message}`,
        })
      },
    })
    const queryVector = queryVectors.get(embeddingCachePathKey(queryAsset.path))
    if (!queryVector) throw new Error('The selected asset has no DINO embedding')
    if (task.cancelled) throw new Error('Similar asset search cancelled')

    const reviewStates = category ? categoryReviewStates(category.id) : new Map()
    const workerInput: AssetSimilarSearchScanInput = {
      cacheDir,
      modelName: DINO_MODEL,
      embeddingType: 'global',
      dim: DINO_DIM,
      sourcePaths,
      queryVector: Array.from(queryVector),
      topK,
      excludeAssetId: queryAsset.id,
      assets: stores.assets.activePathIndexEntries(),
      reviewedAssetIds: !includeReviewed && category ? [...reviewStates.keys()] : [],
    }
    const scan = await runAssetTaskWorker<
      AssetSimilarSearchWorkerProgress,
      { scanned: number; candidates: ScoredAssetCandidate[] }
    >({
      workerFile: 'assetSimilarSearchWorker.js',
      input: workerInput,
      onProgress: (progress) => {
        host.publishProgress({
          current: progress.current,
          total: progress.total,
          percent:
            progress.phase === 'cache'
              ? 30 + Math.round(progress.percent * 0.05)
              : 35 + Math.round(progress.percent * 0.6),
          message:
            progress.phase === 'scan'
              ? `Finding images similar to ${path.basename(queryAsset.path)}: ${progress.current.toLocaleString()}/${progress.total.toLocaleString()}`
              : progress.message,
        })
      },
    })
    if (task.cancelled) throw new Error('Similar asset search cancelled')
    const candidates = scan.candidates

    candidates.sort(
      (left, right) => right.confidence - left.confidence || left.assetId - right.assetId,
    )
    const resultIds = new Set(candidates.map((candidate) => candidate.assetId))
    const categoriesByAsset = new Map<number, AssetCategoryAssignment[]>()
    const tagsByAsset = new Map<number, AssetTagAssignment[]>()
    for (const assignment of stores.categoryAssignments.getAll()) {
      if (!resultIds.has(assignment.assetId) || !formalStatus(assignment.status)) continue
      const list = categoriesByAsset.get(assignment.assetId) || []
      list.push(assignment)
      categoriesByAsset.set(assignment.assetId, list)
    }
    for (const assignment of stores.tagAssignments.getAll()) {
      if (!resultIds.has(assignment.assetId) || !formalStatus(assignment.status)) continue
      const list = tagsByAsset.get(assignment.assetId) || []
      list.push(assignment)
      tagsByAsset.set(assignment.assetId, list)
    }
    const hits = candidates.flatMap((candidate) => {
      const asset = stores.assets.getById(candidate.assetId)
      if (!isActiveAsset(asset)) return []
      return [
        {
          item: {
            asset,
            categories: categoriesByAsset.get(asset.id) || [],
            tags: tagsByAsset.get(asset.id) || [],
          },
          score: candidate.confidence,
          positiveScore: candidate.confidence,
          negativeScore: 0,
          dinoScore: candidate.confidence,
          reviewState: reviewStates.get(asset.id) || ('unreviewed' as const),
        },
      ]
    })

    assetSimilarSearchResults.put({
      taskId: task.id,
      resultId: `similar-${crypto.randomUUID()}`,
      queryAssetId: queryAsset.id,
      queryPath: queryAsset.path,
      ...(category ? { categoryId: category.id, categoryName: category.name } : {}),
      topK,
      includeReviewed,
      scanned: scan.scanned,
      returned: hits.length,
      searchMs: Date.now() - startedAt,
      generatedAt: Date.now(),
      hits,
    })
    host.publishProgress({
      current: 100,
      total: 100,
      percent: 100,
      message: `Found ${hits.length.toLocaleString()} images similar to ${path.basename(queryAsset.path)}.`,
    })
    return `Similar asset search complete: ${hits.length.toLocaleString()} results from ${scan.scanned.toLocaleString()} DINO vectors.`
  })
}

export function getAssetSimilarSearchResult(
  query: AssetLibrarySearchResultQuery = {},
): AssetLibrarySimilarSearchResponse | null {
  return assetSimilarSearchResults.get(query)
}
