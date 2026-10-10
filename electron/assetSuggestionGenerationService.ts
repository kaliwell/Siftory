import path from 'path'
import type {
  AssetCategoryReference,
  AssetClassificationSuggestion,
  AssetLibraryReferenceSuggestionRequest,
  AssetLibraryTagSuggestionRequest,
  AssetLibraryTaskProgress,
  AssetLibraryTaskResult,
  AssetRecord,
} from '../shared/ipc/asset-library'
import { loadAssetEmbeddingsForPaths } from './assetLibraryEmbeddingSource'
import {
  getAssetLibraryBaseDir,
  requireAssetLibraryStores,
  sqliteWriteDb,
  withShadowRead,
  withSqliteWrite,
  type ReferenceEmbeddingCacheRecord,
} from './assetLibraryStorageContext'
import {
  DEFAULT_REFERENCE_THRESHOLD,
  resolveReferenceThresholds,
  type AssetReferencePrototype,
  type ScoredAssetCandidate,
} from './assetLibraryScoring'
import type {
  AssetSuggestionScanInput,
  AssetSuggestionScanWorkerProgress,
} from './assetSuggestionScanWorker'
import { runAssetTaskWorker } from './assetTaskWorkerHost'
import type { AssetLibraryRunningTask } from './assetLibraryTaskController'
import { taskPercent } from './assetLibraryTaskController'
import { embedImageForMediaSearch } from './frameQueryEmbeddingService'
import { resolveAssetReferenceEmbeddingBackend } from './assetLibraryStorageConfig'
import { getQueryTextEmbedding } from './semanticSearchService'
import { getEmbeddingStorePaths } from './vectorDatabaseService'
import { getVisionModelCapability } from './modelRegistry'
import { requireNormalizedEmbeddingVectorFloat32 } from './embeddingVectorValidation'

const DINO_MODEL = 'dinov2_vitb14'
const CLIP_MODEL = 'clip_vit_base_patch32'
const DINO_DIM = getVisionModelCapability(DINO_MODEL).dim
const CLIP_DIM = getVisionModelCapability(CLIP_MODEL).dim

export interface AssetSuggestionGenerationHost {
  startTask(
    type: 'reference_suggestions' | 'tag_suggestions',
    runner: (task: AssetLibraryRunningTask) => Promise<string>,
  ): AssetLibraryTaskResult
  publishProgress(patch: Partial<AssetLibraryTaskProgress>): void
  markFeedbackDirty(reason: string): Promise<void>
}

function isActiveAsset(asset: AssetRecord | undefined): asset is AssetRecord {
  return !!asset && !asset.missing && !asset.archived
}

function normalizeRawVector(values: unknown, expectedDim: number): Float32Array {
  return requireNormalizedEmbeddingVectorFloat32(values, expectedDim)
}

function assetPathKey(filePath: string): string {
  return filePath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

async function loadReferenceEmbeddingVectors(
  references: AssetCategoryReference[],
  task: { id: string; cancelled: boolean },
  host: AssetSuggestionGenerationHost,
): Promise<{ vectorsByPath: Map<string, Float32Array>; errors: string[] }> {
  const stores = requireAssetLibraryStores()
  const assets = [...new Set(references.map((reference) => reference.assetId))]
    .map((assetId) => stores.assets.getById(assetId))
    .filter(isActiveAsset)
  const vectorsByPath = await loadAssetEmbeddingsForPaths(
    DINO_MODEL,
    assets.map((asset) => asset.path),
    () => task.cancelled,
  )
  const cacheRecords = stores.referenceEmbeddings.getAll()
  const errors: string[] = []
  let cacheChanged = false
  const missingAssets = assets.filter((asset) => !vectorsByPath.has(assetPathKey(asset.path)))
  const embeddingBackend = resolveAssetReferenceEmbeddingBackend(
    path.dirname(getAssetLibraryBaseDir()),
  )

  for (let index = 0; index < missingAssets.length; index++) {
    if (task.cancelled) throw new Error('Asset library task cancelled')
    const asset = missingAssets[index]
    host.publishProgress({
      current: index,
      total: missingAssets.length,
      percent: taskPercent(index, Math.max(1, missingAssets.length)) * 0.1,
      message: `Embedding local reference ${index + 1}/${missingAssets.length}...`,
    })
    const cached = cacheRecords.find(
      (record) =>
        record.assetId === asset.id &&
        record.modelName === DINO_MODEL &&
        record.modifiedTime === asset.modifiedTime,
    )
    if (cached) {
      try {
        vectorsByPath.set(assetPathKey(asset.path), normalizeRawVector(cached.vector, DINO_DIM))
        continue
      } catch {
        // A corrupt persisted cache record is a miss. Re-embed and replace it.
      }
    }

    const embedded = await embedImageForMediaSearch({
      imagePath: asset.path,
      modelName: DINO_MODEL,
      backend: embeddingBackend,
      timeoutMs: 180_000,
    })
    if (!embedded.ok) {
      errors.push(`${path.basename(asset.path)}: ${embedded.error || 'embedding failed'}`)
      continue
    }
    let normalized: Float32Array
    try {
      normalized = normalizeRawVector(embedded.vector, DINO_DIM)
    } catch (error) {
      errors.push(
        `${path.basename(asset.path)}: ${error instanceof Error ? error.message : 'invalid embedding'}`,
      )
      continue
    }
    vectorsByPath.set(assetPathKey(asset.path), normalized)
    const existingIndex = cacheRecords.findIndex(
      (record) => record.assetId === asset.id && record.modelName === DINO_MODEL,
    )
    const nextRecord: ReferenceEmbeddingCacheRecord = {
      ...(existingIndex >= 0 && cacheRecords[existingIndex].id
        ? { id: cacheRecords[existingIndex].id }
        : {}),
      assetId: asset.id,
      modelName: DINO_MODEL,
      modifiedTime: asset.modifiedTime,
      vector: Array.from(normalized),
      updatedAt: Date.now(),
    }
    if (existingIndex >= 0) cacheRecords[existingIndex] = nextRecord
    else cacheRecords.push(nextRecord)
    cacheChanged = true
  }

  if (cacheChanged) {
    stores.referenceEmbeddings.replaceAll(cacheRecords)
    await stores.referenceEmbeddings.flush()
  }
  return { vectorsByPath, errors }
}

function replaceGeneratedSuggestions(
  source: AssetClassificationSuggestion['source'],
  targetIds: Set<number>,
  generated: Array<Omit<AssetClassificationSuggestion, 'id'> & { id?: number }>,
  target: 'category' | 'tag',
): void {
  const stores = requireAssetLibraryStores()
  if (sqliteWriteDb()) {
    const inserted = withSqliteWrite((db) => {
      db.deleteGeneratedSuggestions(source, target, [...targetIds])
      const records = generated.map((item) => ({ ...item, id: db.allocateId('suggestions') }))
      db.insertDomainRecords('suggestions', records)
      return records
    })
    const retained = stores.suggestions.getAll().filter((item) => {
      if (item.source !== source) return true
      const targetId = target === 'category' ? item.categoryId : item.tagId
      if (!targetId || !targetIds.has(targetId)) return true
      return item.status !== 'suggested' && item.status !== 'low_confidence'
    })
    stores.suggestions.replaceAll([...retained, ...inserted])
    return
  }
  const retained = stores.suggestions.getAll().filter((item) => {
    if (item.source !== source) return true
    const targetId = target === 'category' ? item.categoryId : item.tagId
    if (!targetId || !targetIds.has(targetId)) return true
    return item.status !== 'suggested' && item.status !== 'low_confidence'
  })
  stores.suggestions.replaceAll([...retained, ...generated])
}

export function buildReferenceSuggestionTask(
  request: AssetLibraryReferenceSuggestionRequest = {},
  host: AssetSuggestionGenerationHost,
): AssetLibraryTaskResult {
  return host.startTask('reference_suggestions', async (task) => {
    const stores = requireAssetLibraryStores()
    await stores.assets.ensureLoaded()
    const maxPerCategory = Math.max(1, Math.min(5000, request.maxPerCategory ?? 500))
    const references = stores.references
      .getAll()
      .filter((item) => request.categoryId === undefined || item.categoryId === request.categoryId)
    if (references.length === 0) throw new Error('Add reference images to a category first')

    host.publishProgress({ message: 'Validating local reference images...' })
    const verifiedReferences = await stores.assets.verifyManualAssets(
      references.map((reference) => reference.assetId),
      () => task.cancelled,
    )
    if (verifiedReferences.changedAssetIds.length > 0) {
      const changedIds = new Set(verifiedReferences.changedAssetIds)
      stores.referenceEmbeddings.deleteWhere((record) => changedIds.has(record.assetId))
      await stores.referenceEmbeddings.flush()
      await host.markFeedbackDirty('Local reference image metadata changed')
    }

    host.publishProgress({ message: 'Loading DINO reference embeddings...' })
    const { vectorsByPath, errors: referenceErrors } = await loadReferenceEmbeddingVectors(
      references,
      task,
      host,
    )
    const referencesByCategory = new Map<number, AssetCategoryReference[]>()
    for (const reference of references) {
      const list = referencesByCategory.get(reference.categoryId) || []
      list.push(reference)
      referencesByCategory.set(reference.categoryId, list)
    }
    const prototypesByCategory = new Map<number, AssetReferencePrototype[]>()
    for (const [categoryId, categoryReferences] of referencesByCategory) {
      const prototypes = categoryReferences
        .map((reference) => {
          const asset = stores.assets.getById(reference.assetId)
          const vector = asset ? vectorsByPath.get(assetPathKey(asset.path)) : undefined
          return vector ? { assetId: reference.assetId, vector, weight: reference.weight } : null
        })
        .filter((value): value is AssetReferencePrototype => !!value)
      if (prototypes.length > 0) prototypesByCategory.set(categoryId, prototypes)
    }
    if (prototypesByCategory.size === 0) {
      throw new Error(
        referenceErrors[0] || 'No DINO embeddings were found for the reference images',
      )
    }
    const categoryThresholds = new Map(
      [...prototypesByCategory.keys()].map((categoryId) => {
        const category = stores.categories.getById(categoryId)
        return [
          categoryId,
          resolveReferenceThresholds(
            category?.referenceThreshold ?? DEFAULT_REFERENCE_THRESHOLD,
            request.threshold,
            request.lowConfidenceThreshold,
          ),
        ] as const
      }),
    )

    const suggestionPairs = withShadowRead(
      (db) => ({
        assigned: db.categoryAssignmentPairRows().map((row) => `${row.assetId}:${row.categoryId}`),
        reviewed: db
          .reviewedSuggestionPairRows('reference_image', 'category')
          .map((row) => `${row.assetId}:${row.targetId ?? undefined}`),
      }),
      () => ({
        assigned: stores.categoryAssignments
          .getAll()
          .map((assignment) => `${assignment.assetId}:${assignment.categoryId}`),
        reviewed: stores.suggestions
          .getAll()
          .filter(
            (item) =>
              item.source === 'reference_image' &&
              !['suggested', 'low_confidence'].includes(item.status),
          )
          .map((item) => `${item.assetId}:${item.categoryId}`),
      }),
    )
    const assignedPairs = new Set(suggestionPairs.assigned)
    const reviewedPairs = new Set(suggestionPairs.reviewed)
    const referencePairs = new Set(
      references.map((reference) => `${reference.assetId}:${reference.categoryId}`),
    )
    const scan = await runAssetTaskWorker<
      AssetSuggestionScanWorkerProgress,
      {
        scanned: number
        results: Array<{ targetId: number; candidates: ScoredAssetCandidate[] }>
      }
    >({
      workerFile: 'assetSuggestionScanWorker.js',
      input: {
        mode: 'reference',
        modelName: DINO_MODEL,
        dim: DINO_DIM,
        sourcePaths: getEmbeddingStorePaths(DINO_MODEL, 'global'),
        targets: [...prototypesByCategory.entries()].map(([categoryId, prototypes]) => ({
          targetId: categoryId,
          minConfidence: categoryThresholds.get(categoryId)!.lowConfidence,
          prototypes: prototypes.map((prototype) => ({
            assetId: prototype.assetId,
            vector: Array.from(prototype.vector),
            weight: prototype.weight,
          })),
        })),
        maxPerTarget: maxPerCategory,
        assets: stores.assets.activePathIndexEntries(),
        excludedPairs: [...assignedPairs, ...reviewedPairs, ...referencePairs],
      } satisfies AssetSuggestionScanInput,
      onProgress: (progress) => {
        host.publishProgress({
          current: progress.processedBytes,
          total: progress.totalBytes,
          percent: taskPercent(progress.processedBytes, progress.totalBytes),
          message: `Classifying ${progress.scanned.toLocaleString()} DINO vectors...`,
        })
      },
    })
    if (task.cancelled) throw new Error('Asset library task cancelled')
    const candidatesByCategory = new Map<number, ScoredAssetCandidate[]>()
    for (const categoryId of prototypesByCategory.keys()) candidatesByCategory.set(categoryId, [])
    for (const targetResult of scan.results) {
      candidatesByCategory.set(targetResult.targetId, targetResult.candidates)
    }

    const now = Date.now()
    const generated: Array<Omit<AssetClassificationSuggestion, 'id'> & { id?: number }> = []
    for (const [categoryId, candidates] of candidatesByCategory) {
      const evidenceAssetIds = (referencesByCategory.get(categoryId) || []).map(
        (item) => item.assetId,
      )
      for (const candidate of candidates.sort((a, b) => b.confidence - a.confidence)) {
        generated.push({
          assetId: candidate.assetId,
          categoryId,
          confidence: candidate.confidence,
          source: 'reference_image',
          status:
            candidate.confidence >= categoryThresholds.get(categoryId)!.suggested
              ? 'suggested'
              : 'low_confidence',
          evidenceAssetIds: candidate.evidenceAssetIds || evidenceAssetIds,
          createdAt: now,
          updatedAt: now,
        })
      }
    }
    replaceGeneratedSuggestions(
      'reference_image',
      new Set(prototypesByCategory.keys()),
      generated,
      'category',
    )
    await stores.suggestions.flush()
    return `Generated ${generated.length.toLocaleString()} reference-image suggestions.`
  })
}

export function buildTagSuggestionTask(
  request: AssetLibraryTagSuggestionRequest = {},
  host: AssetSuggestionGenerationHost,
): AssetLibraryTaskResult {
  return host.startTask('tag_suggestions', async (task) => {
    const stores = requireAssetLibraryStores()
    await stores.assets.ensureLoaded()
    const threshold = Math.max(0, Math.min(1, request.threshold ?? 0.7))
    const lowThreshold = Math.max(0, Math.min(threshold, request.lowConfidenceThreshold ?? 0.6))
    const maxPerTag = Math.max(1, Math.min(5000, request.maxPerTag ?? 500))
    const requestedIds = request.tagIds ? new Set(request.tagIds) : null
    const tags = stores.tags.getAll().filter((tag) => !requestedIds || requestedIds.has(tag.id))
    if (tags.length === 0) throw new Error('Create at least one tag first')

    const vectorsByTag = new Map<number, Float32Array>()
    for (let index = 0; index < tags.length; index++) {
      if (task.cancelled) throw new Error('Asset library task cancelled')
      host.publishProgress({
        current: index,
        total: tags.length,
        percent: Math.round((index / tags.length) * 10),
        message: `Encoding tag: ${tags[index].name}`,
      })
      const values = await getQueryTextEmbedding(tags[index].name)
      vectorsByTag.set(tags[index].id, normalizeRawVector(values, CLIP_DIM))
    }
    const suggestionPairs = withShadowRead(
      (db) => ({
        assigned: db.tagAssignmentPairRows().map((row) => `${row.assetId}:${row.tagId}`),
        reviewed: db
          .reviewedSuggestionPairRows('text_label', 'tag')
          .map((row) => `${row.assetId}:${row.targetId ?? undefined}`),
      }),
      () => ({
        assigned: stores.tagAssignments
          .getAll()
          .map((assignment) => `${assignment.assetId}:${assignment.tagId}`),
        reviewed: stores.suggestions
          .getAll()
          .filter(
            (item) =>
              item.source === 'text_label' &&
              !['suggested', 'low_confidence'].includes(item.status),
          )
          .map((item) => `${item.assetId}:${item.tagId}`),
      }),
    )
    const scan = await runAssetTaskWorker<
      AssetSuggestionScanWorkerProgress,
      {
        scanned: number
        results: Array<{ targetId: number; candidates: ScoredAssetCandidate[] }>
      }
    >({
      workerFile: 'assetSuggestionScanWorker.js',
      input: {
        mode: 'text_label',
        modelName: CLIP_MODEL,
        dim: CLIP_DIM,
        sourcePaths: getEmbeddingStorePaths(CLIP_MODEL, 'global'),
        targets: [...vectorsByTag.entries()].map(([tagId, tagVector]) => ({
          targetId: tagId,
          minConfidence: lowThreshold,
          prototypes: [{ assetId: 0, vector: Array.from(tagVector), weight: 1 }],
        })),
        maxPerTarget: maxPerTag,
        assets: stores.assets.activePathIndexEntries(),
        excludedPairs: [...suggestionPairs.assigned, ...suggestionPairs.reviewed],
      } satisfies AssetSuggestionScanInput,
      onProgress: (progress) => {
        host.publishProgress({
          current: progress.processedBytes,
          total: progress.totalBytes,
          percent: 10 + Math.round(taskPercent(progress.processedBytes, progress.totalBytes) * 0.9),
          message: `Matching ${progress.scanned.toLocaleString()} CLIP vectors...`,
        })
      },
    })
    if (task.cancelled) throw new Error('Asset library task cancelled')
    const candidatesByTag = new Map<number, ScoredAssetCandidate[]>()
    for (const tag of tags) candidatesByTag.set(tag.id, [])
    for (const targetResult of scan.results) {
      candidatesByTag.set(targetResult.targetId, targetResult.candidates)
    }
    const now = Date.now()
    const generated: Array<Omit<AssetClassificationSuggestion, 'id'> & { id?: number }> = []
    for (const [tagId, candidates] of candidatesByTag) {
      for (const candidate of candidates.sort((a, b) => b.confidence - a.confidence)) {
        generated.push({
          assetId: candidate.assetId,
          tagId,
          confidence: candidate.confidence,
          source: 'text_label',
          status: candidate.confidence >= threshold ? 'suggested' : 'low_confidence',
          evidenceAssetIds: [],
          createdAt: now,
          updatedAt: now,
        })
      }
    }
    replaceGeneratedSuggestions('text_label', new Set(vectorsByTag.keys()), generated, 'tag')
    await stores.suggestions.flush()
    return `Generated ${generated.length.toLocaleString()} text-tag suggestions.`
  })
}
