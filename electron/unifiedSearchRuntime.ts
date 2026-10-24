// ── Unified search runtime wiring (Phase 3, main process) ─
// Process-level scheduler + search service composition. Lexical recall always
// comes from the Discovery Catalog (model-free SQL); the semantic lane is
// gated on the authoritative vector store health probe so a corrupted or
// unbuilt index surfaces as an explicit degraded state. The semantic recall
// provider itself is injected via configureUnifiedSearchDeps (worker-based
// wiring lands with the search UI hookup; until then the lane reports
// 'model-missing' instead of returning misleading empty results).

import fs from 'fs'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import type { UnifiedSchedulerStats } from '../shared/ipc/unified-search'
import type {
  MediaSearchFrameImageSearchResponse,
  MediaSearchFrameTextSearchResponse,
} from '../shared/ipc/media-search'
import { getAssetIdentityService } from './assetIdentityService'
import { getSftpVideoProjectionStore } from './sftpVideoProjection'
import { requireAssetLibraryStores } from './assetLibraryStorageContext'
import { isClipTextModelAvailable, searchSemanticImages } from './semanticSearchService'
import { getSourceCatalogService } from './sourceCatalogService'
import { searchBySubject } from './subjectSearchService'
import {
  searchImagesAsync,
  queryImageSearchData,
  isImageSearchIndexedPath,
} from './imageSearchService'
import { searchLayered } from './rerankService'
import { getEmbeddingCacheDir, getEmbeddingStorePaths } from './vectorDatabaseService'
import { probeUnifiedImageVectorHealth } from './unifiedImageVectorHealth'
import {
  UnifiedRecallError,
  UnifiedSearchService,
  type UnifiedSearchServiceDeps,
} from './unifiedSearchService'
import { recallDuplicateGroupHits } from './unifiedDuplicateRecall'
import { UnifiedTaskScheduler } from './unifiedTaskScheduler'
import { normalizeUnifiedResourceProfile } from './resourceGovernor'
import type { UnifiedResourcePressureSnapshot } from './resourceGovernor'
import { loadResourceGovernorProfile, saveResourceGovernorProfile } from './resourceGovernor'
import { collectRuntimeResourceMetrics } from './runtimeResourcePressure'
import { initUnifiedSearchFeedbackStore } from './unifiedSearchFeedbackStore'
import { searchVideoFramesByImage, searchVideoFramesByText } from './videoFrameSearchService'
import { loadVideoManifest } from './videoScanService'
import { hasTranscriptIndex, searchTranscripts } from './transcriptService'
import { VideoSemanticDatabase, VIDEO_SEMANTIC_DATABASE_FILENAME } from './videoSemanticDatabase'
import { requestRegisteredRuntimeCacheRelease } from './runtimeMemoryCacheRegistry'
import { requestUserModelRuntimeMemoryPressureRelease } from './userModelRuntimeHost'
import { requestVectorAnnMemoryPressureRelease } from './vectorAnnWorkerHost'
import { applyEmbeddingRuntimeResourcePressure } from './embeddingService'

let scheduler: UnifiedTaskScheduler | null = null
let searchDeps: UnifiedSearchServiceDeps | null = null
let searchService: UnifiedSearchService | null = null
let videoSemanticDatabase: VideoSemanticDatabase | null = null
let resourceUserDataPath: string | null = null
let resourcePressureTimer: ReturnType<typeof setInterval> | null = null
let resourceOnBattery = false
let resourcePressureProbeActive = false
let resourcePressureGeneration = 0
let lastUnifiedResourcePressure: UnifiedResourcePressureSnapshot = {}

function mediaRecallFailure(error: string): UnifiedRecallError {
  if (/model|embedding failed|CLIP text embedding/i.test(error)) {
    return new UnifiedRecallError(error, 'model-missing')
  }
  if (/No ready video frame|No .*frame index|Build .*Frames/i.test(error)) {
    return new UnifiedRecallError(error, 'index-stale')
  }
  return new UnifiedRecallError(error, 'task-failed')
}

export function getUnifiedTaskScheduler(): UnifiedTaskScheduler {
  if (!scheduler) scheduler = new UnifiedTaskScheduler()
  return scheduler
}

async function sampleUnifiedResourcePressure(
  userDataPath: string,
  generation = resourcePressureGeneration,
): Promise<void> {
  if (resourcePressureProbeActive) return
  resourcePressureProbeActive = true
  let freeDiskBytes: number | undefined
  try {
    const stats = fs.statfsSync(userDataPath)
    freeDiskBytes = Math.max(0, stats.bavail * stats.bsize)
  } catch {
    freeDiskBytes = undefined
  }
  const processors = Math.max(1, os.cpus().length)
  const fallbackCpuLoadPercent = Math.max(0, Math.min(100, (os.loadavg()[0] / processors) * 100))
  let appMetrics: Electron.ProcessMetric[] = []
  try {
    appMetrics = app.getAppMetrics()
  } catch {
    // Electron may be shutting down; the main-process RSS remains a safe fallback.
  }
  try {
    const metrics = await collectRuntimeResourceMetrics(appMetrics)
    if (generation !== resourcePressureGeneration || !resourceUserDataPath) return
    const gpu = metrics.gpu
    lastUnifiedResourcePressure = {
      cpuLoadPercent:
        metrics.electron.processCount > 0 ? metrics.electron.cpuPercent : fallbackCpuLoadPercent,
      processWorkingSetBytes: process.memoryUsage().rss,
      processTreeWorkingSetBytes: metrics.processTree?.workingSetBytes,
      processTreePrivateBytes: metrics.processTree?.privateBytes,
      electronWorkingSetBytes: metrics.electron.workingSetBytes,
      electronPrivateBytes: metrics.electron.privateBytes,
      freeSystemMemoryBytes: os.freemem(),
      totalSystemMemoryBytes: os.totalmem(),
      freeVideoMemoryBytes: gpu ? Math.max(0, gpu.totalBytes - gpu.usedBytes) : undefined,
      usedVideoMemoryBytes: gpu?.usedBytes,
      totalVideoMemoryBytes: gpu?.totalBytes,
      freeDiskBytes,
      onBattery: resourceOnBattery,
    }
    const resourceStats = getUnifiedTaskScheduler().updateResourcePressure(
      lastUnifiedResourcePressure,
      {
        hysteresis: true,
        enterSamples: 2,
        exitSamples: 3,
      },
    )
    applyEmbeddingRuntimeResourcePressure(
      lastUnifiedResourcePressure,
      resourceStats.resource.pressureReasons,
    )
    if (resourceStats.resource.pressureReasons.includes('memory')) {
      requestVectorAnnMemoryPressureRelease()
      requestRegisteredRuntimeCacheRelease('media-frame-index')
      requestUserModelRuntimeMemoryPressureRelease()
    }
  } finally {
    resourcePressureProbeActive = false
  }
}

function startUnifiedResourcePressureMonitor(userDataPath: string): void {
  if (resourcePressureTimer) clearInterval(resourcePressureTimer)
  resourcePressureGeneration += 1
  const generation = resourcePressureGeneration
  void sampleUnifiedResourcePressure(userDataPath, generation)
  resourcePressureTimer = setInterval(
    () => void sampleUnifiedResourcePressure(userDataPath, generation),
    5_000,
  )
  resourcePressureTimer.unref?.()
}

export function getUnifiedResourcePressureSnapshot(): UnifiedResourcePressureSnapshot {
  return { ...lastUnifiedResourcePressure }
}

export function setUnifiedResourceProfile(raw: unknown): {
  ok: boolean
  stats?: UnifiedSchedulerStats
  error?: string
} {
  const profile = normalizeUnifiedResourceProfile(raw)
  if (!profile || !resourceUserDataPath) return { ok: false, error: 'Invalid resource profile' }
  try {
    saveResourceGovernorProfile(resourceUserDataPath, profile)
    return { ok: true, stats: getUnifiedTaskScheduler().setResourceProfile(profile) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function setUnifiedResourcePowerState(onBattery: boolean): void {
  resourceOnBattery = onBattery
  if (resourceUserDataPath) void sampleUnifiedResourcePressure(resourceUserDataPath)
}

export function shutdownUnifiedResourceGovernor(): void {
  if (resourcePressureTimer) clearInterval(resourcePressureTimer)
  resourcePressureGeneration += 1
  resourcePressureTimer = null
  resourceUserDataPath = null
  lastUnifiedResourcePressure = {}
}

export function configureUnifiedSearchDeps(deps: UnifiedSearchServiceDeps): void {
  searchDeps = deps
  searchService = null
}

export function getUnifiedSearchService(): UnifiedSearchService | null {
  if (!searchDeps) return null
  if (!searchService) searchService = new UnifiedSearchService(searchDeps)
  return searchService
}

/** Default composition used by main.ts after the catalog service exists. */
export function initUnifiedSearchRuntime(userDataPath: string): void {
  const taskScheduler = getUnifiedTaskScheduler()
  resourceUserDataPath = userDataPath
  taskScheduler.setResourceProfile(loadResourceGovernorProfile(userDataPath))
  startUnifiedResourcePressureMonitor(userDataPath)
  const feedbackStore = initUnifiedSearchFeedbackStore(userDataPath)
  videoSemanticDatabase?.close()
  videoSemanticDatabase = new VideoSemanticDatabase(
    path.join(userDataPath, 'media-search', VIDEO_SEMANTIC_DATABASE_FILENAME),
  )
  const deepVideoDatabase = videoSemanticDatabase
  let videoMetadataCachedAt = 0
  let videoMetadataByPath = new Map<
    string,
    { width?: number; height?: number; durationMs?: number }
  >()
  const resolveMediaMetadata = (displayPath: string) => {
    try {
      const asset = requireAssetLibraryStores().assets.getByPath(displayPath)
      if (asset && asset.width > 0 && asset.height > 0) {
        return { width: asset.width, height: asset.height }
      }
    } catch {
      // Asset library is optional during early startup; video metadata remains available below.
    }
    const now = Date.now()
    if (now - videoMetadataCachedAt > 2_000) {
      videoMetadataByPath = new Map(
        loadVideoManifest().map((video) => [
          video.path.replace(/\//g, '\\').toLowerCase(),
          {
            ...(video.width ? { width: video.width } : {}),
            ...(video.height ? { height: video.height } : {}),
            ...(video.durationMs !== undefined ? { durationMs: video.durationMs } : {}),
          },
        ]),
      )
      videoMetadataCachedAt = now
    }
    return videoMetadataByPath.get(displayPath.replace(/\//g, '\\').toLowerCase())
  }
  configureUnifiedSearchDeps({
    imageFingerprintRecall: async (request) => {
      if (!request.referenceImagePath || request.subject) return []
      const topK = Math.min(500, Math.max((request.offset ?? 0) + (request.limit ?? 100), 100))
      const task = taskScheduler.enqueue({
        stage: 'metadata',
        priority: 0,
        label: 'unified image fingerprint query',
        run: () =>
          searchImagesAsync({
            imagePath: request.referenceImagePath,
            // Native expects a 64-bit Hamming distance, not a similarity ratio.
            threshold: Math.floor(64 * (1 - 0.85)),
            topK,
            searchMode: 'balanced',
          }),
      })
      const response = await task.promise
      return response.results.map((result) => ({
        displayPath: result.path,
        score: result.score,
        width: result.width,
        height: result.height,
        evidenceSummary: 'Image fingerprint match',
      }))
    },
    lexicalRecall: async (request) => {
      const service = getSourceCatalogService()
      if (!service) return { items: [], total: 0 }
      if (request.referenceImagePath && !request.query?.trim()) return { items: [], total: 0 }
      const filteredSourceId =
        request.sourceId ??
        (request.filters?.sourceIds?.length === 1 ? request.filters.sourceIds[0] : undefined)
      const catalogQuery = {
        ...(request.query !== undefined ? { query: request.query } : {}),
        ...(filteredSourceId ? { sourceId: filteredSourceId } : {}),
        ...(request.filters?.sourceIds?.length ? { sourceIds: request.filters.sourceIds } : {}),
        ...(request.filters?.mediaTypes?.length ? { mediaTypes: request.filters.mediaTypes } : {}),
        ...(request.filters?.modifiedAfter !== undefined
          ? { modifiedAfter: request.filters.modifiedAfter }
          : {}),
        ...(request.filters?.modifiedBefore !== undefined
          ? { modifiedBefore: request.filters.modifiedBefore }
          : {}),
        offset: request.offset ?? 0,
        limit: request.limit ?? 100,
      }
      let result = service.queryCatalog(catalogQuery)
      let nativeOffset = 0
      const deadline = Date.now() + 3000
      let candidateTruncated = false
      do {
        const existing = queryImageSearchData(request.query?.trim() ?? '', nativeOffset, 500)
        if (!existing.ok) break
        const records = existing.records ?? []
        await service.projectExistingSearchFiles(
          records.map((record) => record.path),
          isImageSearchIndexedPath,
          [...(request.sourceId ? [request.sourceId] : []), ...(request.filters?.sourceIds ?? [])],
        )
        nativeOffset += records.length
        result = service.queryCatalog(catalogQuery)
        if (!existing.hasMore || !records.length) break
        if (
          result.items.length >= catalogQuery.limit ||
          nativeOffset >= 25000 ||
          Date.now() >= deadline
        ) {
          candidateTruncated = true
          break
        }
        await new Promise<void>((resolve) => setImmediate(resolve))
      } while (nativeOffset < 25000)
      return { ...result, candidateTruncated }
    },
    vectorHealth: () =>
      probeUnifiedImageVectorHealth(
        getEmbeddingCacheDir(),
        getEmbeddingStorePaths('clip_vit_base_patch32', 'global'),
      ),
    semanticRecall: async (request) => {
      const text = request.query?.trim() ?? ''
      if (!text) return []
      if (!isClipTextModelAvailable())
        throw new UnifiedRecallError('CLIP text model is not installed', 'model-missing')
      const task = taskScheduler.enqueue({
        stage: 'embedding',
        priority: 0,
        label: `unified semantic query: ${text.slice(0, 80)}`,
        run: () =>
          searchSemanticImages({
            text,
            topK: Math.min(500, Math.max((request.offset ?? 0) + (request.limit ?? 100), 100)),
            requestId: `unified-${Date.now().toString(36)}`,
          }),
      })
      const response = await task.promise
      if (response.degraded && response.results.length === 0)
        throw mediaRecallFailure(response.degradationReasons.join('; '))
      return response.results.map((result) => ({
        displayPath: result.path,
        score: result.finalScore,
        evidenceSummary: result.reasons.join(' · '),
        modelSources: [{ modelId: 'clip_vit_base_patch32' }],
      }))
    },
    subjectRecall: async (request, context) => {
      if (!request.referenceImagePath) return []
      if (context?.subjectMaskError) {
        throw new UnifiedRecallError(
          context.subjectMaskError,
          'task-failed',
          '重新选择主体并生成精细蒙版',
        )
      }
      const topK = Math.min(500, Math.max((request.offset ?? 0) + (request.limit ?? 100), 100))
      const task = taskScheduler.enqueue({
        stage: 'embedding',
        priority: 0,
        label: `unified subject query: ${path.basename(request.referenceImagePath).slice(0, 80)}`,
        run: async () => {
          if (!request.subject) {
            const response = await searchLayered({
              imagePath: request.referenceImagePath!,
              mode: 'standard',
              vectorTopK: topK,
              rerankTopK: topK,
            })
            if (response.degraded && response.results.length === 0)
              throw mediaRecallFailure(response.degradationReasons.join('; '))
            return {
              ok: true,
              error: undefined,
              results: response.results.map((result) => ({
                imagePath: result.path,
                score: result.finalScore,
                modelName: '',
              })),
            }
          }
          return searchBySubject(
            request.referenceImagePath!,
            topK,
            request.subject,
            undefined,
            context?.subjectMaskSession,
          )
        },
      })
      const response = await task.promise
      if (!response.ok) {
        if (/^(No results|No subjects detected)/i.test(response.error ?? '')) return []
        throw new Error(response.error || 'Subject recall failed')
      }
      return response.results.map((result) => ({
        displayPath: result.imagePath,
        score: result.score,
        evidenceSummary: request.subject?.label || path.basename(request.referenceImagePath!),
        ...(result.modelName ? { modelSources: [{ modelId: result.modelName }] } : {}),
      }))
    },
    duplicateRecall: async (request) => {
      if (!request.referenceImagePath) return []
      const task = taskScheduler.enqueue({
        stage: 'metadata',
        priority: 0,
        label: `unified duplicate query: ${path.basename(request.referenceImagePath).slice(0, 80)}`,
        run: async () => {
          const stores = requireAssetLibraryStores()
          await stores.assets.ensureLoaded()
          const reference = stores.assets.getByPath(request.referenceImagePath!)
          if (!reference || reference.missing || reference.archived) return []
          return recallDuplicateGroupHits({
            referenceAssetId: reference.id,
            groups: stores.clusters.getAll(),
            members: stores.clusterMembers.getAll(),
            getAssetById: (assetId) => stores.assets.getById(assetId),
          })
        },
      })
      return task.promise
    },
    videoRecall: async (request) => {
      const topK = Math.min(500, Math.max((request.offset ?? 0) + (request.limit ?? 100) * 4, 100))
      const label = request.referenceImagePath
        ? path.basename(request.referenceImagePath)
        : (request.query?.trim() ?? '')
      const task = taskScheduler.enqueue<
        MediaSearchFrameImageSearchResponse | MediaSearchFrameTextSearchResponse
      >({
        stage: 'embedding',
        priority: 0,
        label: `unified video query: ${label.slice(0, 80)}`,
        run: async () => {
          if (request.referenceImagePath) {
            return searchVideoFramesByImage({
              imagePath: request.referenceImagePath,
              modelName: 'clip_vit_base_patch32',
              topK,
            })
          }
          return searchVideoFramesByText({ textQuery: request.query?.trim() ?? '', topK })
        },
      })
      const response = await task.promise
      if (!response.ok) throw mediaRecallFailure(response.error || 'Video frame recall failed')
      const videos = new Map(loadVideoManifest().map((video) => [video.videoId, video]))
      return response.results.flatMap((frame) => {
        const video = videos.get(frame.videoId)
        if (video?.missing) return []
        return [
          {
            displayPath: video?.path ?? frame.videoPath,
            score: frame.vectorScore ?? 0,
            videoId: frame.videoId,
            ...(video?.durationMs !== undefined ? { durationMs: video.durationMs } : {}),
            ...(video?.width !== undefined ? { width: video.width } : {}),
            ...(video?.height !== undefined ? { height: video.height } : {}),
            videoHit: {
              timestampMs: frame.timestampMs,
              score: frame.vectorScore ?? 0,
              kind: 'visual' as const,
              evidenceSources: ['cached-frame' as const],
              frameId: frame.frameId,
              generatedBy: {
                modelId: response.modelName ?? 'clip_vit_base_patch32',
              },
            },
          },
        ]
      })
    },
    subtitleRecall: async (request) => {
      const text = request.query?.trim() ?? ''
      if (!text) return []
      if (!hasTranscriptIndex()) {
        throw new UnifiedRecallError(
          'No indexed video subtitles. Extract subtitles first.',
          'index-stale',
        )
      }
      const topK = Math.min(500, Math.max((request.offset ?? 0) + (request.limit ?? 100) * 4, 100))
      const task = taskScheduler.enqueue({
        stage: 'metadata',
        priority: 0,
        label: `unified subtitle query: ${text.slice(0, 80)}`,
        run: () => searchTranscripts(text, topK),
      })
      const response = await task.promise
      const videos = new Map(loadVideoManifest().map((video) => [video.videoId, video]))
      return response.flatMap((hit) => {
        const video = videos.get(hit.videoId)
        if (video?.missing) return []
        return [
          {
            displayPath: video?.path ?? hit.videoPath,
            score: hit.score,
            videoId: hit.videoId,
            ...(video?.durationMs !== undefined ? { durationMs: video.durationMs } : {}),
            ...(video?.width !== undefined ? { width: video.width } : {}),
            ...(video?.height !== undefined ? { height: video.height } : {}),
            videoHit: {
              timestampMs: hit.timestampMs,
              score: hit.score,
              kind: 'subtitle' as const,
              evidenceSources: [
                hit.source === 'sensevoice-asr'
                  ? ('transcript-reference' as const)
                  : ('embedded-subtitle' as const),
                ...(hit.audioEvents?.length ? (['audio-event' as const] as const) : []),
              ],
              text: hit.text,
              endMs: hit.matchEndMs,
              ...(hit.modelId && hit.modelRevision
                ? {
                    generatedBy: {
                      modelId: hit.modelId,
                      modelRevision: hit.modelRevision,
                    },
                  }
                : {}),
            },
          },
        ]
      })
    },
    videoSemanticHealth: () => {
      const stats = deepVideoDatabase.stats()
      return stats.activeVideos > 0
        ? { status: 'ready' as const }
        : {
            status: 'index-stale' as const,
            detail: 'No active deep video semantic generation',
            actionableHint: '先为所选视频运行“深度视频语义”建库任务',
          }
    },
    videoSemanticRecall: async (request) => {
      const text = request.query?.trim() ?? ''
      if (!text) return []
      const topK = Math.min(500, Math.max((request.offset ?? 0) + (request.limit ?? 100) * 4, 100))
      const task = taskScheduler.enqueue({
        stage: 'metadata',
        priority: 0,
        label: `unified video semantic query: ${text.slice(0, 80)}`,
        run: () => deepVideoDatabase.search(text, topK),
      })
      const hits = await task.promise
      const videos = new Map(loadVideoManifest().map((video) => [video.videoId, video]))
      const strongest = Math.max(0, ...hits.map((hit) => hit.score))
      return hits.flatMap((hit) => {
        const video = videos.get(hit.segment.videoId)
        if (!video || video.missing) return []
        const score = strongest > 0 ? hit.score / strongest : 0.5
        return [
          {
            displayPath: video.path,
            score,
            videoId: hit.segment.videoId,
            ...(video.durationMs !== undefined ? { durationMs: video.durationMs } : {}),
            ...(video.width !== undefined ? { width: video.width } : {}),
            ...(video.height !== undefined ? { height: video.height } : {}),
            videoHit: {
              timestampMs: hit.segment.startMs,
              endMs: hit.segment.endMs,
              score,
              kind: 'semantic' as const,
              evidenceSources:
                hit.matchedFields.length > 0
                  ? hit.matchedFields.map((field) => {
                      if (field === 'visual-text') return 'ocr' as const
                      if (field === 'transcript-reference') return 'transcript-reference' as const
                      if (field === 'audio-event') return 'audio-event' as const
                      return 'ai-visual-semantic' as const
                    })
                  : ['ai-visual-semantic' as const],
              text: hit.segment.summary,
              generatedBy: {
                modelId: hit.segment.modelId,
                modelRevision: hit.segment.modelRevision,
              },
            },
          },
        ]
      })
    },
    hydrateRecallItems: async (displayPaths, request) => {
      const service = getSourceCatalogService()
      if (!service) return []
      const knownVideos = new Set(
        loadVideoManifest()
          .filter((video) => !video.missing && video.sourceType !== 'sftp')
          .map((video) => path.resolve(video.path)),
      )
      const remoteRows = getSftpVideoProjectionStore()?.hydrate(displayPaths, service) ?? []
      const remotePaths = new Set(
        remoteRows.map((row) => path.resolve(row.recallPath ?? row.displayPath).toLowerCase()),
      )
      await service.projectExistingSearchFiles(
        displayPaths.filter((file) => !remotePaths.has(path.resolve(file).toLowerCase())),
        (file) => isImageSearchIndexedPath(file) || knownVideos.has(path.resolve(file)),
        [...(request.sourceId ? [request.sourceId] : []), ...(request.filters?.sourceIds ?? [])],
      )
      const rows = [...service.findFileEntriesByPaths(displayPaths), ...remoteRows]
      const sourceIds = new Set([
        ...(request.sourceId ? [request.sourceId] : []),
        ...(request.filters?.sourceIds ?? []),
      ])
      return sourceIds.size ? rows.filter((row) => sourceIds.has(row.source.id)) : rows
    },
    resolveMediaMetadata,
    resolveRankingFeedback: (request, item) => feedbackStore.rankingFor(request, item),
    resolveAssetId: async (displayPath, item) => {
      if (item.source.type === 'sftp') return undefined
      return (await getAssetIdentityService()?.resolveForPath(displayPath))?.assetId
    },
  })
}

/** Test hook: drop singletons so suites start from a clean scheduler. */
export function resetUnifiedSearchRuntimeForTests(): void {
  shutdownUnifiedResourceGovernor()
  videoSemanticDatabase?.close()
  videoSemanticDatabase = null
  scheduler = null
  searchDeps = null
  searchService = null
}
