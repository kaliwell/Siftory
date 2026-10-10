import crypto from 'crypto'
import path from 'path'
import type {
  AssetCategoryAssignment,
  AssetLibraryCategorySampleSearchRequest,
  AssetLibraryCategorySampleSearchResponse,
  AssetLibrarySearchResultQuery,
  AssetLibraryTaskProgress,
  AssetLibraryTaskResult,
  AssetRecord,
  AssetTagAssignment,
} from '../shared/ipc/asset-library'
import {
  getAssetFeedbackModelStatus,
  getAssetFeedbackTargetContext,
  rebuildAssetFeedbackModel,
} from './assetFeedbackModelService'
import { buildFeedbackSearchCenters } from './assetFeedbackModel'
import type {
  AssetCategoryFeedbackWorkerProgress,
  AssetCategorySearchWorkerInput,
  AssetCategorySearchWorkerResult,
} from './assetCategoryFeedbackWorker'
import { type AssetLibraryRunningTask } from './assetLibraryTaskController'
import { getAssetLibraryBaseDir, requireAssetLibraryStores } from './assetLibraryStorageContext'
import { getEmbeddingStorePaths } from './vectorDatabaseService'
import { getVisionModelCapability } from './modelRegistry'
import {
  preparedClipEmbeddingCacheFromHandle,
  prepareClipEmbeddingF16Cache,
} from './semanticSearchService'
import { SessionSearchResultCache } from './assetSearchResultCache'
import { runAssetTaskWorker } from './assetTaskWorkerHost'
import { embeddingCachePathKey } from './embeddingF16Cache'
import { searchVectorAnnBatch } from './vectorAnnWorkerHost'

const DINO_MODEL = 'dinov2_vitb14'
const DINO_DIM = getVisionModelCapability(DINO_MODEL).dim
const NEKO_ANN_TOP_K_CAP = 20_000
const categorySampleSearchResults =
  new SessionSearchResultCache<AssetLibraryCategorySampleSearchResponse>()

export interface AssetCategorySampleSearchHost {
  startTask(
    type: 'category_sample_search',
    runner: (task: AssetLibraryRunningTask) => Promise<string>,
  ): AssetLibraryTaskResult
  publishProgress(patch: Partial<AssetLibraryTaskProgress>): void
}

export interface CategoryFeedbackSearchOptions {
  isCancelled?: () => boolean
  /** Exact mode is retained for diagnostics and ANN parity benchmarks. */
  clipScanMode?: 'ann' | 'exact'
}

function formalStatus(status: AssetCategoryAssignment['status']): boolean {
  return status === 'confirmed' || status === 'manual_override'
}

function isActiveAsset(asset: AssetRecord | undefined): asset is AssetRecord {
  return !!asset && !asset.missing && !asset.archived
}

export function categoryReviewStates(categoryId: number): Map<number, 'positive' | 'negative'> {
  const stores = requireAssetLibraryStores()
  const states = new Map<number, 'positive' | 'negative'>()
  for (const assignment of stores.categoryAssignments.getAll()) {
    if (
      assignment.categoryId === categoryId &&
      formalStatus(assignment.status) &&
      assignment.confirmedByUser
    ) {
      states.set(assignment.assetId, 'positive')
    }
  }
  for (const reference of stores.references.getAll()) {
    if (reference.categoryId === categoryId) states.set(reference.assetId, 'positive')
  }
  for (const suggestion of stores.suggestions.getAll()) {
    if (
      suggestion.categoryId === categoryId &&
      suggestion.status === 'rejected' &&
      !states.has(suggestion.assetId)
    ) {
      states.set(suggestion.assetId, 'negative')
    }
  }
  return states
}

export async function runCategoryFeedbackSearchWorker(
  input: Omit<
    AssetCategorySearchWorkerInput,
    'kind' | 'cache' | 'dino' | 'clipAnnCandidates' | 'clipCandidateWarning'
  >,
  progress: (progress: AssetCategoryFeedbackWorkerProgress) => void,
  options: CategoryFeedbackSearchOptions = {},
): Promise<AssetCategorySearchWorkerResult> {
  const cache = await prepareClipEmbeddingF16Cache((cacheProgress) =>
    progress({ stage: 'clip', ...cacheProgress }),
  )
  if (options.isCancelled?.()) throw new Error('Category sample search cancelled')
  let clipAnnCandidates: Array<{ path: string; row: number }> | undefined
  let clipCandidateWarning: string | undefined
  const exactDiagnostic =
    options.clipScanMode === 'exact' || process.env.FLOATING_CLOCK_NEKO_EXACT_SCAN === '1'
  if (!exactDiagnostic) {
    try {
      const centers = buildFeedbackSearchCenters(input.target, 4)
      if (centers.length === 0)
        throw new Error('The selected category has no usable CLIP prototypes')
      const acceptPathKeys = input.eligibleAssets.map((asset) => asset.pathKey)
      const recalled = new Map<string, { path: string; row: number }>()
      const ann = await searchVectorAnnBatch(
        cache,
        centers,
        Math.min(NEKO_ANN_TOP_K_CAP, input.clipCandidateK),
        {
          isCancelled: options.isCancelled,
          acceptPathKeys,
          candidateRatio: 0.1,
          onProgress: (annProgress) =>
            progress({
              stage: 'clip',
              current: annProgress.current,
              total: annProgress.total,
              percent: annProgress.percent,
              message: `Preparing CLIP ANN: ${annProgress.percent}%`,
            }),
        },
      )
      if (!ann.queryResults || ann.queryResults.length !== centers.length) {
        throw new Error('CLIP ANN batch result count mismatch')
      }
      for (const queryResult of ann.queryResults) {
        for (const candidate of queryResult.results) {
          recalled.set(embeddingCachePathKey(candidate.path), {
            path: candidate.path,
            row: candidate.row,
          })
        }
      }
      progress({
        stage: 'clip',
        current: centers.length,
        total: centers.length,
        percent: 100,
        message: `CLIP ANN recalled ${recalled.size.toLocaleString()} unique rows from ${centers.length} centers...`,
      })
      if (recalled.size > 0 || input.eligibleAssets.length === 0) {
        clipAnnCandidates = [...recalled.values()].sort(
          (left, right) => left.row - right.row || left.path.localeCompare(right.path),
        )
      } else {
        clipCandidateWarning = 'CLIP ANN returned no eligible candidates; exact scan used.'
      }
    } catch (error) {
      if (options.isCancelled?.()) throw error
      clipCandidateWarning = `CLIP ANN unavailable; exact scan used: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const userDataPath = path.dirname(getAssetLibraryBaseDir())
  return runAssetTaskWorker<AssetCategoryFeedbackWorkerProgress, AssetCategorySearchWorkerResult>({
    workerFile: 'assetCategoryFeedbackWorker.js',
    input: {
      kind: 'category_search',
      cache: preparedClipEmbeddingCacheFromHandle(cache),
      ...input,
      ...(clipAnnCandidates !== undefined ? { clipAnnCandidates } : {}),
      ...(clipCandidateWarning ? { clipCandidateWarning } : {}),
      dino: {
        cacheDir: path.join(userDataPath, 'vector-db', 'embedding-cache'),
        modelName: DINO_MODEL,
        embeddingType: 'global',
        dim: DINO_DIM,
        sourcePaths: getEmbeddingStorePaths(DINO_MODEL, 'global'),
      },
    } satisfies AssetCategorySearchWorkerInput,
    onProgress: progress,
  })
}

export function clearCategorySampleSearchResults(): void {
  categorySampleSearchResults.clear()
}

export function startCategorySampleSearchTask(
  request: AssetLibraryCategorySampleSearchRequest,
  host: AssetCategorySampleSearchHost,
): AssetLibraryTaskResult {
  const category = requireAssetLibraryStores().categories.getById(request.categoryId)
  if (!category) return { ok: false, error: 'Category not found' }
  return host.startTask('category_sample_search', async (task) => {
    const stores = requireAssetLibraryStores()
    const startedAt = Date.now()
    const topK = Math.max(10, Math.min(500, Math.floor(request.topK || 100)))
    const includeReviewed = request.includeReviewed === true
    await stores.assets.ensureLoaded()

    const feedbackStatus = await getAssetFeedbackModelStatus()
    if (
      feedbackStatus.state !== 'ready' ||
      feedbackStatus.builtRevision !== feedbackStatus.revision
    ) {
      host.publishProgress({
        current: 0,
        total: 100,
        percent: 0,
        message: `Updating reviewed samples for ${category.name}...`,
      })
      await rebuildAssetFeedbackModel({
        isCancelled: () => task.cancelled,
        onProgress: (progress) => {
          const percent = Math.round(progress.percent * 0.25)
          host.publishProgress({
            current: percent,
            total: 100,
            percent,
            message: progress.message,
          })
        },
      })
    }
    if (task.cancelled) throw new Error('Category sample search cancelled')

    const feedback = await getAssetFeedbackTargetContext('category', category.id)
    const target = feedback.targets[0]?.target
    if (!target) {
      throw new Error(
        'This category has no accepted assets with CLIP embeddings. Accept or classify samples first.',
      )
    }

    const reviewStates = categoryReviewStates(category.id)
    const clipCandidateK = Math.min(5000, Math.max(1000, topK * 10))
    const result = await runCategoryFeedbackSearchWorker(
      {
        target,
        eligibleAssets: stores.assets
          .activePathIndexEntries()
          .filter((asset) => includeReviewed || !reviewStates.has(asset.id))
          .map(({ id, pathKey }) => ({ id, pathKey })),
        clipCandidateK,
        topK,
      },
      (progress) => {
        const percent = Math.round(
          progress.stage === 'dino' ? 70 + progress.percent * 0.27 : 25 + progress.percent * 0.45,
        )
        host.publishProgress({
          current: percent,
          total: 100,
          percent,
          message: progress.message,
        })
      },
      { isCancelled: () => task.cancelled },
    )
    if (task.cancelled) throw new Error('Category sample search cancelled')

    const assetsById = new Map<number, AssetRecord>()
    const scoredById = new Map<
      number,
      { score: number; positiveScore: number; negativeScore: number }
    >()
    for (const hit of result.hits) {
      const asset = stores.assets.getById(hit.assetId)
      if (!isActiveAsset(asset)) continue
      const previous = scoredById.get(asset.id)
      if (previous && previous.score >= hit.score) continue
      assetsById.set(asset.id, asset)
      scoredById.set(asset.id, hit)
    }

    const resultIds = new Set(assetsById.keys())
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

    const hits = [...assetsById.values()]
      .map((asset) => {
        const score = scoredById.get(asset.id)!
        return {
          item: {
            asset,
            categories: categoriesByAsset.get(asset.id) || [],
            tags: tagsByAsset.get(asset.id) || [],
          },
          ...score,
          reviewState: reviewStates.get(asset.id) || ('unreviewed' as const),
        }
      })
      .sort((left, right) => right.score - left.score || left.item.asset.id - right.item.asset.id)
      .slice(0, topK)

    categorySampleSearchResults.put({
      taskId: task.id,
      resultId: `sample-${crypto.randomUUID()}`,
      categoryId: category.id,
      categoryName: category.name,
      topK,
      includeReviewed,
      scanned: result.scanned,
      returned: hits.length,
      positiveSampleCount: target.positiveSampleCount,
      negativeSampleCount: target.negativeSampleCount,
      feedbackRevision: feedback.builtRevision,
      feedbackStale: feedback.stale,
      searchMode: result.mode,
      clipScanMode: result.clipScanMode,
      clipAnnCandidateCount: result.clipAnnCandidateCount,
      clipCandidateCount: result.clipCandidateCount,
      clipIndexedCount: result.clipIndexedCount,
      dinoCandidateCount: result.dinoCandidateCount,
      dinoPositiveSampleCount: result.dinoPositiveSampleCount,
      dinoNegativeSampleCount: result.dinoNegativeSampleCount,
      dinoCacheVectorCount: result.cacheVectorCount,
      ...(result.warning ? { searchWarning: result.warning } : {}),
      searchMs: Date.now() - startedAt,
      generatedAt: Date.now(),
      hits,
    })
    host.publishProgress({
      current: 100,
      total: 100,
      percent: 100,
      message: `Found ${hits.length.toLocaleString()} matches for ${category.name}.`,
    })
    return `Category sample search complete: ${hits.length.toLocaleString()} results from ${result.scanned.toLocaleString()} CLIP vectors (${result.mode === 'clip_dino' ? 'CLIP + DINO' : 'CLIP fallback'}).`
  })
}

export function getCategorySampleSearchResult(
  query: AssetLibrarySearchResultQuery = {},
): AssetLibraryCategorySampleSearchResponse | null {
  const result = categorySampleSearchResults.get(query)
  return !result || (query.categoryId !== undefined && result.categoryId !== query.categoryId)
    ? null
    : result
}
