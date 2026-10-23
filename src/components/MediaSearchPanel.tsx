import WorkspacePreparationLink from './WorkspacePreparationLink'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  MediaSearchCacheStats,
  MediaSearchFrameEmbeddingStats,
  MediaSearchStatus,
  MediaSearchTaskProgress,
  MediaSearchVideoFrameRecord,
  MediaSearchVideoRecord,
} from '../../shared/ipc-contract'
import type { EmbeddingProgress } from '../../shared/vectorTypes'
import { useLinkedMove } from '../hooks/useLinkedMove'
import { useManagedSearchModels } from '../hooks/useManagedSearchModels'
import { useTranslation } from '../i18n/useTranslation'
import { translateRuntimeError, translateRuntimeFailure } from '../i18n/runtimeError'
import { mediaSearchBridge } from '../services/mediaSearchBridge'
import { MediaSearchRequestState } from '../services/mediaSearchRequestState'
import { announceFirstSearchCompleted } from '../services/firstRunGuide'
import { isManagedSearchModelReady } from '../services/managedSearchModelReadiness'
import {
  ensureSetupModel,
  IDLE_SETUP_WORKFLOW,
  runSetupWorkflow,
  setupDelay,
  type SearchExperienceMode,
  type SetupStepContext,
} from '../services/searchSetupWorkflow'
import { useStore } from '../stores/useStore'
import { DEFAULT_MEDIA_SEARCH_H, DEFAULT_MEDIA_SEARCH_W } from '../types'
import DraggablePanel from './DraggablePanel'
import MediaSearchControls, { type MediaSearchControlSectionId } from './MediaSearchControls'
import MediaSearchPathChips from './MediaSearchPathChips'
import MediaSearchProgressBars from './MediaSearchProgressBars'
import MediaSearchResultsView from './MediaSearchResultsView'
import MediaSearchStatusGrid from './MediaSearchStatusGrid'
import SearchExperienceModeBar from './SearchExperienceModeBar'
import SearchSetupProgress from './SearchSetupProgress'
import VideoSemanticStatusCard from './VideoSemanticStatusCard'
import AudioSemanticStatusCard from './AudioSemanticStatusCard'

const MEDIA_SEARCH_CONTROL_SECTION_IDS: MediaSearchControlSectionId[] = [
  'sources',
  'library',
  'query',
  'maintenance',
]

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const QUERY_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'])

function getFileExtension(filePath: string): string {
  const slashIndex = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  const dotIndex = filePath.lastIndexOf('.')
  if (dotIndex <= slashIndex) return ''
  return filePath.slice(dotIndex).toLowerCase()
}

function getDroppedFilePath(file: File): string {
  const electronFile = file as File & { path?: string }
  return window.electronAPI?.getPathForFile?.(file) || electronFile.path || ''
}

const defaultStatus: MediaSearchStatus = {
  state: 'idle',
  videoCount: 0,
  indexedFrameCount: 0,
  ffmpegConfigured: false,
  ffprobeConfigured: false,
  updatedAt: Date.now(),
  message: 'MediaSearch starting...',
}

function isMediaSearchPerfEnabled(): boolean {
  return import.meta.env.DEV
}

function logMediaSearchPerf(label: string, startedAt?: number) {
  if (!isMediaSearchPerfEnabled()) return
  if (startedAt == null) {
    globalThis.console.info(`[MediaSearchPerf] ${label}`)
    return
  }
  globalThis.console.info(
    `[MediaSearchPerf] ${label} ${Math.round(performance.now() - startedAt)}ms`,
  )
}

function scheduleIdleTask(task: () => void, timeoutMs = 900): () => void {
  const win = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (typeof win.requestIdleCallback === 'function') {
    const id = win.requestIdleCallback(task, { timeout: timeoutMs })
    return () => win.cancelIdleCallback?.(id)
  }
  const timer = window.setTimeout(task, timeoutMs)
  return () => window.clearTimeout(timer)
}

const MediaSearchPanelInner: React.FC = () => {
  const workspaceView = useStore((s) => s.mediaSearchUiPreferences.workspaceView)
  const sourcesOnly = workspaceView !== 'search'
  const { t } = useTranslation()
  const mediaSearchPos = useStore((s) => s.mediaSearchPos)
  const setMediaSearchPos = useStore((s) => s.setMediaSearchPos)
  const mediaSearchSize = useStore((s) => s.mediaSearchSize)
  const setMediaSearchSize = useStore((s) => s.setMediaSearchSize)
  const linkedMove = useStore((s) => s.linkedMove)
  const locked = useStore((s) => s.lockedPanels['mediaSearch'] ?? false)
  const visibilityLocked = useStore((s) => s.lockedVisibility['mediaSearch'] ?? false)
  const togglePanelLocked = useStore((s) => s.togglePanelLocked)
  const toggleVisibilityLock = useStore((s) => s.toggleVisibilityLock)
  const handleMove = useLinkedMove('mediaSearch', mediaSearchPos, setMediaSearchPos, linkedMove)
  const experienceMode = useStore((s) => s.mediaSearchUiPreferences.experienceMode)
  const setMediaSearchUiPreferences = useStore((s) => s.setMediaSearchUiPreferences)
  const {
    checking: managedModelsChecking,
    checkError: managedModelsCheckError,
    isModelReady: isManagedModelReady,
    refresh: refreshManagedModels,
  } = useManagedSearchModels()

  const [status, setStatus] = useState<MediaSearchStatus>(defaultStatus)
  const [cacheStats, setCacheStats] = useState<MediaSearchCacheStats | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [manualPath, setManualPath] = useState('')
  const [showDrivePicker, setShowDrivePicker] = useState(false)
  const [availableDrives, setAvailableDrives] = useState<string[]>([])
  const [videos, setVideos] = useState<MediaSearchVideoRecord[]>([])
  const [videoTotal, setVideoTotal] = useState(0)
  const [frames, setFrames] = useState<MediaSearchVideoFrameRecord[]>([])
  const [frameTotal, setFrameTotal] = useState(0)
  const [frameDisplayMode, setFrameDisplayMode] = useState<'browse' | 'query'>('browse')
  const [requestState] = useState(() => new MediaSearchRequestState())
  const [frameEmbeddingStats, setFrameEmbeddingStats] =
    useState<MediaSearchFrameEmbeddingStats | null>(null)
  const [viewMode, setViewMode] = useState<'videos' | 'frames'>('videos')
  const [queryImagePath, setQueryImagePath] = useState('')
  const [progress, setProgress] = useState<MediaSearchTaskProgress | null>(null)
  const [searchProgress, setSearchProgress] = useState<MediaSearchTaskProgress | null>(null)
  const [embeddingProgress, setEmbeddingProgress] = useState<EmbeddingProgress>({
    total: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    running: 0,
    pending: 0,
    state: 'idle',
  })
  const [message, setMessage] = useState('')
  const [searchTopK, setSearchTopK] = useState(50)
  const [searchModel, setSearchModel] = useState<'dinov2_vitb14' | 'clip_vit_base_patch32'>(
    'dinov2_vitb14',
  )
  const [searchBackend, setSearchBackend] = useState<'cpu' | 'gpu'>('gpu')
  const [textQuery, setTextQuery] = useState('')
  const [multimodalEnabled, setMultimodalEnabled] = useState(false)
  const [sortMode, setSortMode] = useState<'score' | 'time'>('score')
  const [dragOverQueryImage, setDragOverQueryImage] = useState(false)
  const [expandedControlSections, setExpandedControlSections] = useState<
    Record<MediaSearchControlSectionId, boolean>
  >({
    sources: true,
    library: true,
    query: true,
    maintenance: false,
  })
  const toggleControlSection = useCallback((id: MediaSearchControlSectionId) => {
    if (id === 'query') return
    setExpandedControlSections((sections) => ({ ...sections, [id]: !sections[id] }))
  }, [])
  const setAllControlSectionsExpanded = useCallback((expanded: boolean) => {
    setExpandedControlSections(
      Object.fromEntries(
        MEDIA_SEARCH_CONTROL_SECTION_IDS.map((id) => [id, id === 'query' ? true : expanded]),
      ) as Record<MediaSearchControlSectionId, boolean>,
    )
  }, [])
  const [setupWorkflow, setSetupWorkflow] = useState(IDLE_SETUP_WORKFLOW)
  const setupAbortRef = useRef<AbortController | null>(null)
  const startupStatsPending = false
  const setupRunning = setupWorkflow.state === 'running'

  useEffect(() => {
    requestState.activate()
    return () => requestState.dispose()
  }, [requestState])

  const beginBrowsing = useCallback(() => {
    requestState.beginBrowse()
    setFrameDisplayMode('browse')
    setSearchProgress(null)
  }, [requestState])

  const runFrameQuery = useCallback(
    async (query: (requestId: string) => Promise<void>) => {
      const requestId = requestState.beginQuery()
      setFrameDisplayMode('query')
      setSearchProgress(null)
      try {
        await query(requestId)
      } catch (error) {
        if (requestState.isCurrent(requestId)) {
          setMessage(error instanceof Error ? error.message : String(error))
        }
      } finally {
        if (requestState.finishQuery(requestId)) setSearchProgress(null)
      }
    },
    [requestState],
  )

  const refresh = useCallback(
    async (
      options: {
        includeLists?: boolean
        includeVideoList?: boolean
        includeFrameList?: boolean
        includeEmbeddingStats?: boolean
        includeCacheStats?: boolean
        includeImages?: boolean
        includeStatusCounts?: boolean
        videoLimit?: number
        frameLimit?: number
      } = {},
    ) => {
      const startedAt = performance.now()
      const browseRevision = requestState.browseRevision()
      logMediaSearchPerf('refresh:start')
      const includeLists = options.includeLists ?? true
      const includeVideoList = includeLists && (options.includeVideoList ?? true)
      const includeFrameList = includeLists && (options.includeFrameList ?? true)
      const includeEmbeddingStats = options.includeEmbeddingStats ?? true
      const includeCacheStats = options.includeCacheStats ?? false
      const includeImages = options.includeImages ?? false
      const includeStatusCounts = options.includeStatusCounts ?? true
      const videoLimit = options.videoLimit ?? 200
      const frameLimit = options.frameLimit ?? 500
      const timed = async <T,>(label: string, task: Promise<T>): Promise<T> => {
        const taskStartedAt = performance.now()
        try {
          return await task
        } finally {
          logMediaSearchPerf(label, taskStartedAt)
        }
      }
      const [nextStatus, nextStats, videoList, frameList, embeddingStats] = await Promise.all([
        timed('ipc:getStatus', mediaSearchBridge.getStatus({ includeCounts: includeStatusCounts })),
        includeCacheStats
          ? timed('ipc:getCacheStats', mediaSearchBridge.getCacheStats())
          : Promise.resolve(null),
        includeVideoList
          ? timed('ipc:listVideos', mediaSearchBridge.listVideos(videoLimit, includeImages))
          : Promise.resolve(null),
        includeFrameList
          ? timed('ipc:listFrames', mediaSearchBridge.listFrames(frameLimit, includeImages))
          : Promise.resolve(null),
        includeEmbeddingStats
          ? timed('ipc:getFrameEmbeddingStats', mediaSearchBridge.getFrameEmbeddingStats())
          : Promise.resolve(null),
      ])
      if (!nextStatus && !nextStats) {
        setMessage(
          t('MediaSearch IPC unavailable. Restart npm run dev so preload/main process reloads.'),
        )
      }
      if (nextStatus) {
        setStatus((prev) =>
          includeStatusCounts
            ? nextStatus
            : {
                ...nextStatus,
                videoCount: prev.videoCount,
                indexedFrameCount: prev.indexedFrameCount,
              },
        )
      }
      if (nextStats) setCacheStats(nextStats)
      if (videoList) {
        setVideos(videoList.videos)
        setVideoTotal(videoList.total)
      }
      if (frameList && requestState.acceptsBrowse(browseRevision)) {
        setFrames(frameList.frames)
        setFrameTotal(frameList.total)
      }
      if (embeddingStats) setFrameEmbeddingStats(embeddingStats)
      logMediaSearchPerf('refresh:done', startedAt)
    },
    [requestState, t],
  )

  useEffect(() => {
    const initialRefreshTimer = window.setTimeout(() => {
      void refresh({
        includeLists: false,
        includeVideoList: false,
        includeFrameList: false,
        includeEmbeddingStats: false,
        includeCacheStats: false,
        includeImages: false,
        includeStatusCounts: false,
      })
    }, 500)
    const unsubs = [
      mediaSearchBridge.onTaskProgress((next) => {
        setProgress(next)
        if (next.state === 'running') setSearchProgress(null)
        setStatus((prev) => ({
          ...prev,
          state: next.state,
          activeTaskId: next.taskId,
          activeTaskType: next.type,
          message: next.message,
          lastError: next.error,
          updatedAt: next.updatedAt,
        }))
        if (next.state === 'done' || next.state === 'error' || next.state === 'stopped') {
          void refresh()
        }
      }),
      mediaSearchBridge.onSearchProgress((next) => {
        if (requestState.isCurrent(next.taskId)) setSearchProgress(next)
      }),
    ]
    return () => {
      window.clearTimeout(initialRefreshTimer)
      unsubs.forEach((u) => u?.())
    }
  }, [refresh, requestState])

  useEffect(() => {
    const api = window.electronAPI?.vector
    if (!api?.getEmbeddingProgress || !api?.onEmbeddingProgress) return
    const cancelInitialProgressLoad = scheduleIdleTask(() => {
      void api.getEmbeddingProgress().then((next) => {
        if (next) setEmbeddingProgress(next)
      })
    })
    const unsub = api.onEmbeddingProgress((next) => {
      setEmbeddingProgress(next)
    })
    return () => {
      cancelInitialProgressLoad()
      unsub?.()
    }
  }, [])

  useEffect(() => {
    if (
      searchModel === 'clip_vit_base_patch32' &&
      (frameEmbeddingStats?.clipEmbeddedFrames ?? 0) === 0 &&
      (frameEmbeddingStats?.dinoEmbeddedFrames ?? 0) > 0
    ) {
      setSearchModel('dinov2_vitb14')
      setMessage(t('CLIP frame embeddings are empty; switched image search to DINO.'))
    }
  }, [frameEmbeddingStats, searchModel, t])

  useEffect(() => {
    if (
      frameDisplayMode !== 'browse' ||
      viewMode !== 'frames' ||
      frames.length > 0 ||
      status.state === 'running'
    )
      return
    void refresh({
      includeLists: true,
      includeVideoList: false,
      includeFrameList: true,
      includeEmbeddingStats: false,
      includeCacheStats: false,
      includeImages: false,
    })
  }, [frameDisplayMode, frames.length, refresh, status.state, viewMode])

  const appendSelectedPaths = useCallback((paths: string[]) => {
    setSelectedPaths((prev) => {
      const next: string[] = []
      const seen = new Set<string>()
      for (const value of [...prev, ...paths]) {
        const trimmed = value.trim()
        if (!trimmed) continue
        const key = trimmed.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        next.push(trimmed)
        if (next.length >= 64) break
      }
      return next
    })
  }, [])

  const choosePaths = useCallback(
    async (mode: 'single-video' | 'videos' | 'folders') => {
      const selection = await mediaSearchBridge.selectVideoPaths(mode)
      if (!selection) return
      appendSelectedPaths(selection.paths)
      setMessage(
        selection.paths.length > 0
          ? t('Added {count} path(s)', { count: selection.paths.length })
          : '',
      )
    },
    [appendSelectedPaths, t],
  )

  const toggleDrivePicker = useCallback(async () => {
    if (showDrivePicker) {
      setShowDrivePicker(false)
      return
    }
    setAvailableDrives(await mediaSearchBridge.listDrives())
    setShowDrivePicker(true)
  }, [showDrivePicker])

  const addDrivePath = useCallback(
    (drive: string) => {
      setShowDrivePicker(false)
      appendSelectedPaths([drive])
      setMessage(t('Added {path}', { path: drive }))
    },
    [appendSelectedPaths, t],
  )

  const addManualPath = useCallback(async () => {
    const trimmed = manualPath.trim()
    if (!trimmed) return
    const normalized = /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed
    const result = await mediaSearchBridge.validatePath(normalized)
    if (!result.ok || !result.path) {
      setMessage(result.error || t('Path does not exist or is not a video folder/file.'))
      return
    }
    appendSelectedPaths([result.path])
    setManualPath('')
    setMessage(t('Added {path}', { path: result.path }))
  }, [appendSelectedPaths, manualPath, t])

  const removeSelectedPath = useCallback((target: string) => {
    setSelectedPaths((prev) => prev.filter((item) => item !== target))
  }, [])

  const chooseFfmpegDir = useCallback(async () => {
    const result = await mediaSearchBridge.selectFfmpegDirectory()
    if (!result) return
    setMessage(
      result.ok
        ? t('FFmpeg configured: {directory}', { directory: result.ffmpegDir || '' })
        : result.error || t('FFmpeg directory rejected'),
    )
    await refresh()
  }, [refresh, t])

  const openFfmpegToolsDir = useCallback(async () => {
    const result = await mediaSearchBridge.openFfmpegToolsDirectory()
    setMessage(
      result.ok
        ? t('Tools dir: {directory}', { directory: result.toolsDir || '' })
        : result.error || t('Open tools directory failed'),
    )
  }, [t])

  const clearFfmpegDir = useCallback(async () => {
    const result = await mediaSearchBridge.clearFfmpegDirectory()
    setMessage(result.ok ? t('FFmpeg configuration cleared.') : result.error || t('Clear failed'))
    await refresh()
  }, [refresh, t])

  const clearCache = useCallback(async () => {
    beginBrowsing()
    const result = await mediaSearchBridge.clearCache()
    if (result.ok) {
      setVideos([])
      setVideoTotal(0)
      setFrames([])
      setFrameTotal(0)
      setFrameEmbeddingStats(null)
      setCacheStats(result.stats ?? null)
    }
    setMessage(
      result.ok
        ? t('Temporary media cache cleared, freed {bytes}.', {
            bytes: formatBytes(result.freedBytes),
          })
        : result.error || t('Clear cache failed'),
    )
    await refresh()
  }, [beginBrowsing, refresh, t])

  const clearVideoData = useCallback(async () => {
    beginBrowsing()
    const result = await mediaSearchBridge.clearData()
    if (result.ok) {
      setVideos([])
      setVideoTotal(0)
      setFrames([])
      setFrameTotal(0)
      setFrameEmbeddingStats(null)
      setCacheStats(result.stats ?? null)
      setSearchProgress(null)
    }
    setMessage(
      result.ok
        ? t('Video data cleared, freed {bytes}, removed {count} frame embeddings.', {
            bytes: formatBytes(result.freedBytes),
            count: result.removedEmbeddings ?? 0,
          })
        : result.error || t('Clear video data failed'),
    )
    await refresh()
  }, [beginBrowsing, refresh, t])

  const loadFullData = useCallback(() => {
    beginBrowsing()
    void refresh({
      includeLists: true,
      includeVideoList: true,
      includeFrameList: viewMode === 'frames',
      includeEmbeddingStats: true,
      includeCacheStats: true,
      includeImages: false,
      videoLimit: 200,
      frameLimit: 500,
    })
  }, [beginBrowsing, refresh, viewMode])

  const startScan = useCallback(async () => {
    if (selectedPaths.length === 0) {
      setMessage(t('Select video files or folders first.'))
      return
    }
    setSearchProgress(null)
    const result = await mediaSearchBridge.startScan({ paths: selectedPaths, mode: 'metadata' })
    setMessage(
      result.ok
        ? result.warning
          ? t('Warning: {warning}', { warning: result.warning })
          : t('Task started: {taskId}', { taskId: result.taskId || '-' })
        : result.error || t('Start failed'),
    )
    await refresh({ includeLists: false, includeEmbeddingStats: false })
  }, [refresh, selectedPaths, t])

  const buildFrames = useCallback(async () => {
    if (selectedPaths.length === 0) {
      setMessage(t('Select video files or folders first.'))
      return
    }
    setSearchProgress(null)
    const result = await mediaSearchBridge.buildFrames({ paths: selectedPaths })
    setMessage(
      result.ok
        ? t('Frame task started: {taskId}', { taskId: result.taskId || '-' })
        : result.error || t('Start failed'),
    )
    await refresh({ includeLists: false, includeEmbeddingStats: false })
  }, [refresh, selectedPaths, t])

  const buildFrameEmbeddings = useCallback(
    async (modelName: 'dinov2_vitb14' | 'clip_vit_base_patch32') => {
      const latestModels = await refreshManagedModels()
      if (!isManagedSearchModelReady(latestModels?.[modelName])) {
        setMessage(t('The selected model is not ready.'))
        return
      }
      setSearchProgress(null)
      const result = await mediaSearchBridge.buildFrameEmbeddings({
        modelName,
        backend: 'gpu',
        maxConcurrentEmbeddings: modelName === 'clip_vit_base_patch32' ? 8 : 1,
        scanPaths: selectedPaths,
      })
      setMessage(
        result.ok
          ? t('{model} frame embedding started.', {
              model: modelName === 'clip_vit_base_patch32' ? 'CLIP' : 'DINO',
            })
          : translateRuntimeFailure(result, t),
      )
      await refresh({ includeLists: false, includeEmbeddingStats: false })
    },
    [refresh, refreshManagedModels, selectedPaths, t],
  )

  const searchSimilarFrame = useCallback(
    async (frame: MediaSearchVideoFrameRecord) => {
      return runFrameQuery(async (requestId) => {
        const effectiveModel =
          searchModel === 'clip_vit_base_patch32' &&
          (frameEmbeddingStats?.clipEmbeddedFrames ?? 0) === 0 &&
          (frameEmbeddingStats?.dinoEmbeddedFrames ?? 0) > 0
            ? 'dinov2_vitb14'
            : searchModel
        const result = await mediaSearchBridge.searchSimilarFrame({
          requestId,
          frameId: frame.frameId,
          modelName: effectiveModel,
          topK: searchTopK,
        })
        if (!requestState.isCurrent(requestId)) return
        if (result.ok) {
          announceFirstSearchCompleted('video')
          setFrames(result.results)
          setFrameTotal(result.results.length)
          setViewMode('frames')
        }
        setMessage(
          result.ok
            ? t('Similar frames: {results}/{total} by {model} ({milliseconds}ms).', {
                results: result.results.length,
                total: result.totalCandidates,
                model: result.modelName ?? '-',
                milliseconds: Math.round(result.timings?.totalMs ?? 0),
              })
            : result.error || t('Similar frame search failed'),
        )
      })
    },
    [requestState, runFrameQuery, frameEmbeddingStats, searchModel, searchTopK, t],
  )

  const searchFramesByImage = useCallback(
    async (imagePath?: string) => {
      return runFrameQuery(async (requestId) => {
        const effectivePath = imagePath || queryImagePath
        if (!effectivePath) {
          setMessage(t('Select a query image first.'))
          return
        }
        setSearchProgress(null)
        const effectiveModel =
          searchModel === 'clip_vit_base_patch32' &&
          (frameEmbeddingStats?.clipEmbeddedFrames ?? 0) === 0 &&
          (frameEmbeddingStats?.dinoEmbeddedFrames ?? 0) > 0
            ? 'dinov2_vitb14'
            : searchModel
        const latestModels = await refreshManagedModels()
        if (!requestState.isCurrent(requestId)) return
        if (!isManagedSearchModelReady(latestModels?.[effectiveModel])) {
          setMessage(t('The selected model is not ready.'))
          return
        }
        const result = await mediaSearchBridge.searchFramesByImage({
          requestId,
          imagePath: effectivePath,
          modelName: effectiveModel,
          backend: searchBackend,
          topK: searchTopK,
          scanPaths: selectedPaths,
        })
        if (!requestState.isCurrent(requestId)) return
        setSearchProgress(null)
        if (result.ok) {
          announceFirstSearchCompleted('video')
          setFrames(result.results)
          setFrameTotal(result.results.length)
          setViewMode('frames')
        }
        setMessage(
          result.ok
            ? t('Image -> frame results: {results}/{total} by {model} ({milliseconds}ms).', {
                results: result.results.length,
                total: result.totalCandidates,
                model: result.modelName ?? '-',
                milliseconds: Math.round(result.timings?.totalMs ?? 0),
              })
            : result.error || t('Image frame search failed'),
        )
      })
    },
    [
      requestState,
      runFrameQuery,
      frameEmbeddingStats,
      queryImagePath,
      refreshManagedModels,
      searchModel,
      searchBackend,
      searchTopK,
      selectedPaths,
      t,
    ],
  )

  const searchFramesByText = useCallback(async () => {
    return runFrameQuery(async (requestId) => {
      const query = textQuery.trim()
      if (!query) {
        setMessage(t('Enter text or select a query image first.'))
        return
      }
      const latestModels = await refreshManagedModels()
      if (!requestState.isCurrent(requestId)) return
      if (!isManagedSearchModelReady(latestModels?.clip_vit_base_patch32)) {
        setMessage(t('The selected model is not ready.'))
        return
      }
      setSearchProgress(null)
      const result = await mediaSearchBridge.searchFramesByText({
        requestId,
        textQuery: query,
        topK: searchTopK,
        scanPaths: selectedPaths,
      })
      if (!requestState.isCurrent(requestId)) return
      setSearchProgress(null)
      if (result.ok) {
        announceFirstSearchCompleted('video')
        const sorted =
          sortMode === 'time'
            ? [...result.results].sort((a, b) => a.timestampMs - b.timestampMs)
            : result.results
        setFrames(sorted)
        setFrameTotal(result.results.length)
        setViewMode('frames')
      }
      setMessage(
        result.ok
          ? t('Text -> frame results: {results}/{total} by {model} ({milliseconds}ms).', {
              results: result.results.length,
              total: result.totalCandidates,
              model: result.modelName ?? '-',
              milliseconds: Math.round(result.timings?.totalMs ?? 0),
            })
          : result.error || t('Text frame search failed'),
      )
    })
  }, [
    requestState,
    runFrameQuery,
    refreshManagedModels,
    searchTopK,
    selectedPaths,
    sortMode,
    t,
    textQuery,
  ])

  const searchMultimodal = useCallback(
    async (imagePath?: string) => {
      return runFrameQuery(async (requestId) => {
        const effectivePath = imagePath || queryImagePath
        if (!effectivePath || !textQuery) {
          setMessage(t('Select a query image and enter text.'))
          return
        }
        setSearchProgress(null)
        const effectiveModel =
          searchModel === 'clip_vit_base_patch32' &&
          (frameEmbeddingStats?.clipEmbeddedFrames ?? 0) === 0 &&
          (frameEmbeddingStats?.dinoEmbeddedFrames ?? 0) > 0
            ? 'dinov2_vitb14'
            : searchModel
        const latestModels = await refreshManagedModels()
        if (!requestState.isCurrent(requestId)) return
        if (
          !isManagedSearchModelReady(latestModels?.[effectiveModel]) ||
          !isManagedSearchModelReady(latestModels?.clip_vit_base_patch32)
        ) {
          setMessage(t('The selected model is not ready.'))
          return
        }
        const result = await mediaSearchBridge.searchMultimodal({
          imagePath: effectivePath,
          textQuery,
          modelName: effectiveModel,
          backend: searchBackend,
          topK: searchTopK,
          visualWeight: 0.55,
          scanPaths: selectedPaths,
        })
        if (!requestState.isCurrent(requestId)) return
        setSearchProgress(null)
        if (result.ok) {
          announceFirstSearchCompleted('video')
          const sorted =
            sortMode === 'time'
              ? [...result.results].sort((a, b) => a.timestampMs - b.timestampMs)
              : result.results
          setFrames(sorted)
          setFrameTotal(result.results.length)
          setViewMode('frames')
        }
        setMessage(
          result.ok
            ? t('Multimodal: {results}/{total} by {model}.', {
                results: result.results.length,
                total: result.totalCandidates,
                model: effectiveModel,
              })
            : result.error || t('Multimodal search failed'),
        )
      })
    },
    [
      requestState,
      runFrameQuery,
      frameEmbeddingStats,
      queryImagePath,
      refreshManagedModels,
      textQuery,
      searchModel,
      searchBackend,
      searchTopK,
      selectedPaths,
      sortMode,
      t,
    ],
  )

  const chooseQueryImage = useCallback(async () => {
    const selection = await mediaSearchBridge.selectQueryImage()
    if (!selection?.path) return
    setQueryImagePath(selection.path)
    setMessage(t('Query image selected: {path}', { path: selection.path }))
    if (experienceMode === 'advanced' && multimodalEnabled && textQuery.trim()) {
      await searchMultimodal(selection.path)
    } else {
      await searchFramesByImage(selection.path)
    }
  }, [experienceMode, multimodalEnabled, searchFramesByImage, searchMultimodal, t, textQuery])

  const pasteClipboardImage = useCallback(async () => {
    const result = await mediaSearchBridge.pasteClipboardImage()
    if (!result.ok || !result.path) {
      setMessage(result.error || t('Clipboard has no image'))
      return
    }
    setQueryImagePath(result.path)
    setMessage(t('Clipboard image selected: {path}', { path: result.path }))
    if (experienceMode === 'advanced' && multimodalEnabled && textQuery.trim()) {
      await searchMultimodal(result.path)
    } else {
      await searchFramesByImage(result.path)
    }
  }, [experienceMode, multimodalEnabled, searchFramesByImage, searchMultimodal, t, textQuery])

  const handleQueryImageDrop = useCallback(
    async (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault()
      event.stopPropagation()
      setDragOverQueryImage(false)
      if (status.state === 'running') {
        setMessage(t('Task is running. Stop or wait before changing the query image.'))
        return
      }
      const file = Array.from(event.dataTransfer.files).find((item) => {
        const filePath = getDroppedFilePath(item)
        return filePath && QUERY_IMAGE_EXTENSIONS.has(getFileExtension(filePath))
      })
      if (!file) {
        setMessage(t('Drop a local image file: jpg, jpeg, png, webp, bmp, or gif.'))
        return
      }
      const filePath = getDroppedFilePath(file)
      setQueryImagePath(filePath)
      setMessage(t('Dropped query image: {path}', { path: filePath }))
      if (experienceMode === 'advanced' && multimodalEnabled && textQuery.trim()) {
        await searchMultimodal(filePath)
      } else {
        await searchFramesByImage(filePath)
      }
    },
    [
      experienceMode,
      multimodalEnabled,
      searchFramesByImage,
      searchMultimodal,
      status.state,
      t,
      textQuery,
    ],
  )

  const refreshQuerySearch = useCallback(async () => {
    if (experienceMode === 'advanced' && multimodalEnabled && textQuery.trim()) {
      if (!queryImagePath) {
        setMessage(t('Select a query image first for multimodal search.'))
        return
      }
      await searchMultimodal(queryImagePath)
      return
    }
    if (!queryImagePath && textQuery.trim()) {
      await searchFramesByText()
      return
    }
    if (!queryImagePath) {
      setMessage(t('Select a query image or enter text first.'))
      return
    }
    await searchFramesByImage(queryImagePath)
  }, [
    experienceMode,
    multimodalEnabled,
    queryImagePath,
    searchFramesByImage,
    searchFramesByText,
    searchMultimodal,
    t,
    textQuery,
  ])

  const runPrimarySearch = useCallback(() => {
    if (experienceMode === 'advanced' && multimodalEnabled) {
      void searchMultimodal()
      return
    }
    if (queryImagePath) {
      void searchFramesByImage()
      return
    }
    void searchFramesByText()
  }, [
    experienceMode,
    multimodalEnabled,
    queryImagePath,
    searchFramesByImage,
    searchFramesByText,
    searchMultimodal,
  ])

  const changeSortMode = useCallback((mode: 'score' | 'time') => {
    setSortMode(mode)
    setFrames((prev) =>
      mode === 'time'
        ? [...prev].sort((a, b) => a.timestampMs - b.timestampMs)
        : [...prev].sort((a, b) => (b.vectorScore ?? 0) - (a.vectorScore ?? 0)),
    )
  }, [])

  const extractSubs = useCallback(
    async (videoId: string) => {
      const result = await mediaSearchBridge.extractSubtitles(videoId)
      setMessage(
        result.ok
          ? t('Subtitles extracted: {count} segments{language}.', {
              count: result.segmentCount ?? 0,
              language: result.language ? ` (${result.language})` : '',
            })
          : result.error || t('Subtitle extraction failed'),
      )
      await refresh()
    },
    [refresh, t],
  )

  const stopTask = useCallback(async () => {
    const result = await mediaSearchBridge.stopTask(progress?.taskId || status.activeTaskId)
    setMessage(result.ok ? t('Task stopped.') : result.error || t('Stop failed'))
    await refresh()
  }, [progress?.taskId, refresh, status.activeTaskId, t])

  const waitForMediaTask = useCallback(
    async (
      taskId: string,
      context: SetupStepContext,
      completeWhen?: (progress: MediaSearchTaskProgress) => boolean,
    ) => {
      let missingPolls = 0
      for (;;) {
        const next = await mediaSearchBridge.getTaskProgress(taskId)
        if (!next) {
          missingPolls++
          if (missingPolls >= 20) throw new Error('Media task status was lost')
          await setupDelay(250, context.signal)
          continue
        }
        missingPolls = 0
        setProgress(next)
        setStatus((previous) => ({
          ...previous,
          state: next.state,
          activeTaskId: next.taskId,
          activeTaskType: next.type,
          message: next.message,
          lastError: next.error,
          updatedAt: next.updatedAt,
        }))
        context.report(next.percentage, next.message || next.currentPath || 'Processing...')
        if (completeWhen?.(next) || (!completeWhen && next.state === 'done')) return
        if (next.state === 'done') {
          throw new Error('Media task completed without reaching the required preparation stage')
        }
        if (next.state === 'error') {
          throw new Error(next.error || next.message || 'Media task failed')
        }
        if (next.state === 'stopped') throw new DOMException('Setup cancelled', 'AbortError')
        await setupDelay(500, context.signal)
      }
    },
    [],
  )

  const runSimpleSetup = useCallback(async () => {
    if (setupAbortRef.current || selectedPaths.length === 0) return
    if (status.state === 'running') {
      setMessage(t('Wait for the current Media Search task to finish.'))
      return
    }
    const vectorApi = window.electronAPI?.vector
    if (!vectorApi) {
      setMessage(t('Vector API is unavailable.'))
      return
    }
    const latestStatus = await mediaSearchBridge.getStatus({ includeCounts: false })
    if (!latestStatus?.ffmpegConfigured || !latestStatus.ffprobeConfigured) {
      setMessage(t('FFmpeg is not ready. Switch to Advanced and configure FFmpeg Dir.'))
      return
    }

    const paths = [...selectedPaths]
    const capability = await vectorApi.getComputeBackendCapability()
    const backendLabel =
      capability.recommendedBackend === 'gpu'
        ? `GPU · ${capability.deviceName || 'hardware acceleration'}`
        : 'CPU · no usable GPU detected'
    const controller = new AbortController()
    setupAbortRef.current = controller
    let preparationTaskId = ''
    const final = await runSetupWorkflow(
      [
        {
          id: 'scan-videos',
          label: `Scan videos (${backendLabel})`,
          run: async (context) => {
            const started = await mediaSearchBridge.startScan({ paths, mode: 'metadata' })
            if (!started.ok || !started.taskId) {
              throw new Error(started.error || 'Video scan failed to start')
            }
            await waitForMediaTask(started.taskId, context)
          },
        },
        {
          id: 'dino-model',
          label: 'Prepare DINO model',
          run: async (context) => {
            const started = await mediaSearchBridge.prepareLibrary({
              paths,
              backend: capability.recommendedBackend,
              maxConcurrentEmbeddings: 2,
            })
            if (!started.ok || !started.taskId) {
              throw new Error(started.error || 'Media library preparation failed to start')
            }
            preparationTaskId = started.taskId
            await ensureSetupModel(vectorApi, 'dinov2_vitb14', context)
          },
        },
        {
          id: 'clip-model',
          label: 'Prepare CLIP model',
          run: (context) => ensureSetupModel(vectorApi, 'clip_vit_base_patch32', context),
        },
        {
          id: 'build-frames',
          label: 'Extract video frames',
          run: async (context) => {
            if (!preparationTaskId) throw new Error('Media library preparation was not started')
            await waitForMediaTask(
              preparationTaskId,
              context,
              (next) => next.frameExtractionComplete === true,
            )
          },
        },
        {
          id: 'dino-frames',
          label: 'Build DINO frame embeddings',
          run: async (context) => {
            if (!preparationTaskId) throw new Error('Media library preparation was not started')
            await waitForMediaTask(
              preparationTaskId,
              context,
              (next) => next.dinoEmbeddingComplete === true,
            )
          },
        },
        {
          id: 'clip-frames',
          label: 'Build CLIP frame embeddings',
          run: async (context) => {
            if (!preparationTaskId) throw new Error('Media library preparation was not started')
            await waitForMediaTask(preparationTaskId, context)
          },
        },
      ],
      { signal: controller.signal, onChange: setSetupWorkflow },
    )
    setupAbortRef.current = null
    if (final.state !== 'done' && preparationTaskId) {
      await mediaSearchBridge.stopTask(preparationTaskId)
    }
    setMessage(
      final.state === 'done'
        ? t('Media library ready.')
        : final.runtimeError
          ? translateRuntimeError(final.runtimeError, t)
          : final.error || final.message || '',
    )
    await refresh({
      includeLists: true,
      includeVideoList: true,
      includeFrameList: true,
      includeEmbeddingStats: true,
      includeCacheStats: true,
      includeImages: false,
      videoLimit: 200,
      frameLimit: 500,
    })
  }, [refresh, selectedPaths, status.state, t, waitForMediaTask])

  const cancelSimpleSetup = useCallback(async () => {
    setupAbortRef.current?.abort()
    const vectorApi = window.electronAPI?.vector
    await Promise.allSettled([
      mediaSearchBridge.stopTask(),
      vectorApi?.stopEmbeddingBuild() ?? Promise.resolve({ ok: true }),
      vectorApi?.cancelDownload() ?? Promise.resolve({ ok: true }),
    ])
  }, [])

  useEffect(
    () => () => {
      setupAbortRef.current?.abort()
    },
    [],
  )

  const changeExperienceMode = useCallback(
    (mode: SearchExperienceMode) => setMediaSearchUiPreferences({ experienceMode: mode }),
    [setMediaSearchUiPreferences],
  )

  const frameReadyCount = useMemo(
    () => frames.filter((frame) => frame.status === 'done').length,
    [frames],
  )
  const coverageLabel = useMemo(() => {
    const rows = frameEmbeddingStats?.coverageByDrive ?? []
    if (rows.length === 0) return ''
    return rows
      .map(
        (row) =>
          `${row.drive}: V${row.videos} F${row.readyFrames} D${row.dinoEmbeddedFrames} C${row.clipEmbeddedFrames}`,
      )
      .join(' | ')
  }, [frameEmbeddingStats])
  const selectedModelEmbeddedFrames =
    searchModel === 'clip_vit_base_patch32'
      ? (frameEmbeddingStats?.clipEmbeddedFrames ?? 0)
      : (frameEmbeddingStats?.dinoEmbeddedFrames ?? 0)
  const embeddingStatsKnown = frameEmbeddingStats !== null
  const dinoModelReady =
    !managedModelsChecking && !managedModelsCheckError && isManagedModelReady('dinov2_vitb14')
  const clipModelReady =
    !managedModelsChecking &&
    !managedModelsCheckError &&
    isManagedModelReady('clip_vit_base_patch32')
  const imageQueryModelReady =
    searchModel === 'clip_vit_base_patch32' &&
    (frameEmbeddingStats?.clipEmbeddedFrames ?? 0) === 0 &&
    (frameEmbeddingStats?.dinoEmbeddedFrames ?? 0) > 0
      ? dinoModelReady
      : searchModel === 'clip_vit_base_patch32'
        ? clipModelReady
        : dinoModelReady
  const queryModelReady = queryImagePath
    ? imageQueryModelReady && (!multimodalEnabled || clipModelReady)
    : clipModelReady
  const canSearchFrames =
    queryModelReady &&
    (queryImagePath
      ? !embeddingStatsKnown || selectedModelEmbeddedFrames > 0
      : textQuery.trim().length > 0 &&
        (!embeddingStatsKnown || (frameEmbeddingStats?.clipEmbeddedFrames ?? 0) > 0))

  const sourceControlStatus = (
    <MediaSearchPathChips
      disabled={status.state === 'running'}
      paths={selectedPaths}
      onRemovePath={removeSelectedPath}
    />
  )

  const libraryControlStatus = (
    <>
      {experienceMode === 'simple' && (
        <SearchSetupProgress workflow={setupWorkflow} embeddingProgress={embeddingProgress} />
      )}

      {experienceMode === 'advanced' ? (
        <MediaSearchStatusGrid
          cacheStats={cacheStats}
          frameEmbeddingStats={frameEmbeddingStats}
          frameReadyCount={frameReadyCount}
          frameTotal={frameTotal}
          framesListed={frames.length}
          progress={progress}
          queryImagePath={queryImagePath}
          status={status}
          videoTotal={videoTotal}
          videosListed={videos.length}
        />
      ) : (
        <div className="media-search-compact-status">
          <span>
            {t('Videos')} {status.videoCount.toLocaleString()}
          </span>
          <span>
            {t('Frames')} {status.indexedFrameCount.toLocaleString()}
          </span>
          <span>DINO {(frameEmbeddingStats?.dinoEmbeddedFrames ?? 0).toLocaleString()}</span>
          <span>CLIP {(frameEmbeddingStats?.clipEmbeddedFrames ?? 0).toLocaleString()}</span>
        </div>
      )}

      <MediaSearchProgressBars
        embeddingProgress={embeddingProgress}
        progress={progress}
        searchProgress={searchProgress}
        statusState={status.state}
      />
    </>
  )

  const maintenanceControlStatus = (
    <>
      <VideoSemanticStatusCard videos={videos} compact={experienceMode === 'simple'} />
      <AudioSemanticStatusCard compact={experienceMode === 'simple'} videos={videos} />

      <div className="media-search-runtime-message">
        {message ||
          (!status.ffmpegConfigured || !status.ffprobeConfigured
            ? t(
                'ffmpeg.exe / ffprobe.exe not found. Place them in tools/ffmpeg/bin/ or use FFmpeg Dir to select a directory, or add to PATH.',
              )
            : status.message || t('Ready.'))}
      </div>
      {experienceMode === 'advanced' && startupStatsPending && !coverageLabel && (
        <div style={{ opacity: 0.55 }}>{t('Coverage: loading after startup...')}</div>
      )}
      {experienceMode === 'advanced' && coverageLabel && (
        <div
          title={t('Per drive: Videos / ready Frames / DINO embeddings / CLIP embeddings')}
          className="media-search-coverage"
        >
          {t('Coverage')}: {coverageLabel}
        </div>
      )}
    </>
  )

  return (
    <DraggablePanel
      panelId="mediaSearch"
      title="Media Search"
      displayTitle={t(sourcesOnly ? 'Sources' : 'Search')}
      pageDescription={t(
        sourcesOnly
          ? 'Prepare video libraries for frame and semantic search.'
          : 'Search video frames by image or description.',
      )}
      x={mediaSearchPos.x}
      y={mediaSearchPos.y}
      defaultX={160}
      defaultY={140}
      w={mediaSearchSize.w}
      h={mediaSearchSize.h}
      defaultW={DEFAULT_MEDIA_SEARCH_W}
      defaultH={DEFAULT_MEDIA_SEARCH_H}
      onMove={handleMove}
      onResize={(w, h) => setMediaSearchSize(w, h)}
      locked={locked}
      onToggleLock={() => togglePanelLocked('mediaSearch')}
      visibilityLocked={visibilityLocked}
      onToggleVisibilityLock={() => toggleVisibilityLock('mediaSearch')}
    >
      <div
        className="split-tool-shell media-search-shell"
        data-sources-only={sourcesOnly}
        onDragOver={(event) => {
          if (sourcesOnly) return
          event.preventDefault()
          event.dataTransfer.dropEffect = status.state === 'running' ? 'none' : 'copy'
          setDragOverQueryImage(true)
        }}
        onDragLeave={() => setDragOverQueryImage(false)}
        onDrop={(event) => {
          if (!sourcesOnly) void handleQueryImageDrop(event)
        }}
        style={{ fontSize: 11 }}
      >
        <div className="split-tool-workspace media-search-workspace">
          <aside className="split-tool-control-pane media-search-control-pane">
            <MediaSearchControls
              workspaceView={sourcesOnly ? 'sources' : 'search'}
              expandedSections={expandedControlSections}
              experienceMode={experienceMode}
              workflowRunning={setupRunning}
              availableDrives={availableDrives}
              canSearchFrames={canSearchFrames}
              clipModelReady={clipModelReady}
              dinoModelReady={dinoModelReady}
              dragOverQueryImage={dragOverQueryImage}
              manualPath={manualPath}
              multimodalEnabled={experienceMode === 'advanced' && multimodalEnabled}
              queryImagePath={queryImagePath}
              searchBackend={searchBackend}
              searchModel={searchModel}
              searchTopK={searchTopK}
              selectedPathCount={selectedPaths.length}
              showDrivePicker={showDrivePicker}
              sortMode={sortMode}
              status={status}
              textQuery={textQuery}
              viewMode={viewMode}
              modeControl={
                <SearchExperienceModeBar
                  mode={experienceMode}
                  workflow={setupWorkflow}
                  onModeChange={changeExperienceMode}
                />
              }
              sourceStatus={sourceControlStatus}
              libraryStatus={libraryControlStatus}
              maintenanceStatus={maintenanceControlStatus}
              onAddDrivePath={addDrivePath}
              onAddManualPath={() => void addManualPath()}
              onBuildFrameEmbeddings={(modelName) => void buildFrameEmbeddings(modelName)}
              onBuildFrames={buildFrames}
              onChooseFfmpegDir={chooseFfmpegDir}
              onChooseSingleVideo={() => void choosePaths('single-video')}
              onChooseVideoFiles={() => void choosePaths('videos')}
              onChooseFolders={() => void choosePaths('folders')}
              onChooseQueryImage={chooseQueryImage}
              onClearCache={clearCache}
              onClearFfmpegDir={clearFfmpegDir}
              onClearQueryImage={() => {
                beginBrowsing()
                setQueryImagePath('')
                setFrames([])
                setFrameTotal(0)
                setMessage('')
              }}
              onClearSelectedPaths={() => setSelectedPaths([])}
              onClearVideoData={() => void clearVideoData()}
              onLoadData={loadFullData}
              onOpenFfmpegToolsDir={openFfmpegToolsDir}
              onPasteClipboardImage={() => void pasteClipboardImage()}
              onQueryImageDrop={(event) => {
                void handleQueryImageDrop(event)
              }}
              onRefreshQuerySearch={() => void refreshQuerySearch()}
              onRunPrimarySearch={runPrimarySearch}
              onSearchBackendChange={setSearchBackend}
              onSearchModelChange={setSearchModel}
              onSearchTopKChange={setSearchTopK}
              onSetDragOverQueryImage={setDragOverQueryImage}
              onSetManualPath={setManualPath}
              onSetMultimodalEnabled={setMultimodalEnabled}
              onSetTextQuery={setTextQuery}
              onSetViewMode={(mode) => {
                beginBrowsing()
                setViewMode(mode)
              }}
              onSortModeChange={changeSortMode}
              onStartScan={startScan}
              onStopTask={stopTask}
              onPrepareLibrary={() => void runSimpleSetup()}
              onCancelSetup={() => void cancelSimpleSetup()}
              onToggleDrivePicker={() => void toggleDrivePicker()}
              onToggleSection={toggleControlSection}
              onSetAllSectionsExpanded={setAllControlSectionsExpanded}
            />
            {!sourcesOnly && <WorkspacePreparationLink kind="video" ready={canSearchFrames} />}
          </aside>

          {!sourcesOnly && (
            <main className="split-tool-results-pane media-search-results-pane">
              <MediaSearchResultsView
                searchReady={canSearchFrames}
                frames={frames}
                onExtractSubtitles={(videoId) => void extractSubs(videoId)}
                onOpenMedia={(videoId, timestampMs) =>
                  void mediaSearchBridge.openMediaAtTime({ videoId, timestampMs })
                }
                onRevealPath={(input) => void mediaSearchBridge.revealInExplorer(input)}
                onSearchSimilarFrame={(frame) => void searchSimilarFrame(frame)}
                selectedPaths={selectedPaths}
                videos={videos}
                viewMode={viewMode}
              />
            </main>
          )}
        </div>
      </div>
    </DraggablePanel>
  )
}

const MediaSearchPanel: React.FC = () => {
  return <MediaSearchPanelInner />
}

export default MediaSearchPanel
