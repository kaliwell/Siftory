import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useStore } from '../stores/useStore'
import DraggablePanel from './DraggablePanel'
import VectorMaintenanceBar from './VectorMaintenanceBar'
import EmbeddingBuildControls from './EmbeddingBuildControls'
import ImageSearchStatusBar from './ImageSearchStatusBar'
import SearchProgressBar from './SearchProgressBar'
import ImageSearchResultGrid, {
  type ImageSearchDisplayResult,
  type ImageSearchMetrics,
} from './ImageSearchResultGrid'
import ImageSearchIndexFooter from './ImageSearchIndexFooter'
import RecentManifestBar from './RecentManifestBar'
import ImageSearchControls from './ImageSearchControls'
import { sortImageSearchResults, type ImageSearchSortMode } from './imageSearchSort'
import ImageSearchDataManager from './ImageSearchDataManager'
import SearchExperienceModeBar from './SearchExperienceModeBar'
import DiscoverySourcesSection from './DiscoverySourcesSection'
import SearchSetupProgress from './SearchSetupProgress'
import {
  ConfirmWholeDriveBanner,
  ImageSearchToastBanner,
  type ImageSearchToastState,
} from './ImageSearchBanners'
import ImageHashSmokeTest from './ImageHashSmokeTest'
import CollapsibleSearchSection, { SearchControlSectionsToolbar } from './CollapsibleSearchSection'
import { DEFAULT_IMAGESEARCH_W, DEFAULT_IMAGESEARCH_H } from '../types'
import { useLinkedMove } from '../hooks/useLinkedMove'
import { useManagedSearchModels } from '../hooks/useManagedSearchModels'
import { imageSearchBridge } from '../services/imageSearchBridge'
import { announceFirstSearchCompleted } from '../services/firstRunGuide'
import { subjectSearchBridge } from '../services/subjectSearchBridge'
import SubjectPickerModal, { type SubjectPickerData } from './SubjectPickerModal'
import { useTranslation } from '../i18n/useTranslation'
import type { SubjectBBox } from '../../shared/ipc-contract'
import {
  IDLE_SETUP_WORKFLOW,
  setupSnapshotFromImagePreparationProgress,
  startDeferredSimpleThumbnails,
  type SearchExperienceMode,
} from '../services/searchSetupWorkflow'
import { isManagedSearchModelReady } from '../services/managedSearchModelReadiness'
import type {
  ImageSearchPreparationProgress,
  ImageSearchStatus,
  ImageSearchResult,
  ImageHashResult,
} from '../../shared/ipc-contract'
import type {
  EmbeddingProgress,
  LayeredSearchResult,
  LayeredSearchProgress,
  SemanticSearchProgress,
  SearchMode,
} from '../../shared/vectorTypes'

type ImageSearchControlSectionId = 'sources' | 'library' | 'query' | 'maintenance'

const IMAGE_SEARCH_CONTROL_SECTION_IDS: ImageSearchControlSectionId[] = [
  'sources',
  'library',
  'query',
  'maintenance',
]

function normalizeImageSearchRoot(value?: string): string {
  if (!value) return ''
  const normalized = value.replace(/\//g, '\\').replace(/[\\]+$/, '')
  return navigator.userAgent.includes('Windows') ? normalized.toLowerCase() : normalized
}

const ImageSearchPanel: React.FC = () => {
  const { t } = useTranslation()
  const imageSearchPos = useStore((s) => s.imageSearchPos)
  const setImageSearchPos = useStore((s) => s.setImageSearchPos)
  const imageSearchSize = useStore((s) => s.imageSearchSize)
  const setImageSearchSize = useStore((s) => s.setImageSearchSize)
  const linkedMove = useStore((s) => s.linkedMove)
  const locked = useStore((s) => s.lockedPanels['imageSearch'] ?? false)
  const visibilityLocked = useStore((s) => s.lockedVisibility['imageSearch'] ?? false)
  const togglePanelLocked = useStore((s) => s.togglePanelLocked)
  const toggleVisibilityLock = useStore((s) => s.toggleVisibilityLock)
  const handleMove = useLinkedMove('imageSearch', imageSearchPos, setImageSearchPos, linkedMove)
  const gpuJobs = useStore((s) => s.imageSearchUiPreferences.embeddingGpuJobs)
  const batchSize = useStore((s) => s.imageSearchUiPreferences.embeddingBatchSize)
  const buildScanThumbnails = useStore((s) => s.imageSearchUiPreferences.buildScanThumbnails)
  const experienceMode = useStore((s) => s.imageSearchUiPreferences.experienceMode)
  const setImageSearchUiPreferences = useStore((s) => s.setImageSearchUiPreferences)
  const setGpuJobs = useCallback(
    (value: number) => setImageSearchUiPreferences({ embeddingGpuJobs: value }),
    [setImageSearchUiPreferences],
  )
  const setBatchSize = useCallback(
    (value: number) => setImageSearchUiPreferences({ embeddingBatchSize: value }),
    [setImageSearchUiPreferences],
  )
  const setBuildScanThumbnails = useCallback(
    (enabled: boolean) => setImageSearchUiPreferences({ buildScanThumbnails: enabled }),
    [setImageSearchUiPreferences],
  )
  const setExperienceMode = useCallback(
    (mode: SearchExperienceMode) => setImageSearchUiPreferences({ experienceMode: mode }),
    [setImageSearchUiPreferences],
  )
  const {
    statuses: managedModelStatuses,
    checking: managedModelsChecking,
    checkError: managedModelsCheckError,
    isModelReady: isManagedModelReady,
    refresh: refreshManagedModels,
  } = useManagedSearchModels()
  const dinoModelStatus = managedModelStatuses.dinov2_vitb14
  const clipModelStatus = managedModelStatuses.clip_vit_base_patch32

  const [status, setStatus] = useState<ImageSearchStatus>({
    state: 'idle',
    indexedCount: 0,
    pendingCount: 0,
    message: 'Ready',
  })
  const [initialStatusLoaded, setInitialStatusLoaded] = useState(false)
  const [manualPath, setManualPath] = useState('')
  const [showDrivePicker, setShowDrivePicker] = useState(false)
  const [availableDrives, setAvailableDrives] = useState<string[]>([])
  const [confirmWholeDrive, setConfirmWholeDrive] = useState<string[] | null>(null) // paths triggering confirmation
  const [searchQuery, setSearchQuery] = useState('')
  const [semanticQuery, setSemanticQuery] = useState('')
  const [results, setResults] = useState<ImageSearchResult[]>([])
  const [subjectSearching, setSubjectSearching] = useState(false)
  const [searching, setSearching] = useState(false)
  const [testImagePath, setTestImagePath] = useState<string | null>(null)
  const [hashResult, setHashResult] = useState<ImageHashResult | null>(null)
  const [hashing, setHashing] = useState(false)
  const [queryHash, setQueryHash] = useState<string | null>(null)
  const [searchMetrics, setSearchMetrics] = useState<ImageSearchMetrics | null>(null)

  // Search params
  const [threshold, setThreshold] = useState(0.85)
  const [topK, setTopK] = useState(50)
  const [sortBy, setSortBy] = useState<ImageSearchSortMode>('score')
  const [searchMode, setSearchMode] = useState<SearchMode>('fast')
  const [lastQueryKind, setLastQueryKind] = useState<'image' | 'semantic' | null>(null)
  const [scanMode, setScanMode] = useState<'addNew' | 'update' | 'updateAll'>('addNew')
  const [expandedControlSections, setExpandedControlSections] = useState<
    Record<ImageSearchControlSectionId, boolean>
  >({
    sources: true,
    library: true,
    query: true,
    maintenance: false,
  })
  const toggleControlSection = useCallback((id: ImageSearchControlSectionId) => {
    if (id === 'query') return
    setExpandedControlSections((sections) => ({ ...sections, [id]: !sections[id] }))
  }, [])
  const setAllControlSectionsExpanded = useCallback((expanded: boolean) => {
    setExpandedControlSections(
      Object.fromEntries(
        IMAGE_SEARCH_CONTROL_SECTION_IDS.map((id) => [id, id === 'query' ? true : expanded]),
      ) as Record<ImageSearchControlSectionId, boolean>,
    )
  }, [])
  useEffect(() => {
    const expandSources = () => {
      setExpandedControlSections((sections) => ({ ...sections, sources: true }))
    }
    window.addEventListener('workspace-sources-focus', expandSources)
    return () => window.removeEventListener('workspace-sources-focus', expandSources)
  }, [])
  const [setupWorkflow, setSetupWorkflow] = useState(IDLE_SETUP_WORKFLOW)
  const setupTaskIdRef = useRef<string | null>(null)
  const handledPreparationTaskRef = useRef<string | null>(null)
  const setupPathsRef = useRef<string[]>([])
  const simpleSetupStartRef = useRef<(() => void) | null>(null)
  const wholeDriveActionRef = useRef<'scan' | 'simple'>('scan')
  const [toast, setToast] = useState<ImageSearchToastState | null>(null)
  const toastTimerRef = useRef(0)
  const [dragOver, setDragOver] = useState(false)

  // Vector / Rerank state
  const [embeddingProgress, setEmbeddingProgress] = useState<EmbeddingProgress>({
    total: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    running: 0,
    pending: 0,
    state: 'idle',
  })
  const [vectorIndexStatus, setVectorIndexStatus] = useState<{
    built: boolean
    count: number
    modelName?: string
    dim?: number
    error?: string
  }>({
    built: false,
    count: 0,
  })
  const buildDisabled = ['queued', 'running', 'paused', 'stopping'].includes(
    embeddingProgress.state,
  )
  const [layeredResults, setLayeredResults] = useState<LayeredSearchResult[]>([])
  const [showExtendedScores, setShowExtendedScores] = useState(false)
  const [semanticProgress, setSemanticProgress] = useState<SemanticSearchProgress | null>(null)
  const [layeredProgress, setLayeredProgress] = useState<LayeredSearchProgress | null>(null)
  const semanticRequestIdRef = useRef<string | null>(null)
  const layeredRequestIdRef = useRef<string | null>(null)

  const manifestPath = useStore((s) => s.manifestPath)
  const recentManifests = useStore((s) => s.recentManifests)
  const setManifestPath = useStore((s) => s.setManifestPath)
  const addRecentManifest = useStore((s) => s.addRecentManifest)
  const scanPaths = useStore((s) => s.imageSearchScanPaths)
  const addScanPaths = useStore((s) => s.addImageSearchScanPaths)
  const removeScanPath = useStore((s) => s.removeImageSearchScanPath)
  const clearScanPaths = useStore((s) => s.clearImageSearchScanPaths)

  const showToast = useCallback((msg: string, type: 'ok' | 'err' = 'ok') => {
    window.clearTimeout(toastTimerRef.current)
    setToast({ msg, type })
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = 0
      setToast(null)
    }, 3000)
  }, [])

  useEffect(
    () => () => {
      window.clearTimeout(toastTimerRef.current)
    },
    [],
  )

  // Convert UI threshold (0.5-1.0) to maximum hamming distance.
  const hammingThreshold = Math.floor(64 * (1 - threshold))

  const isScanning =
    status.state === 'queued' || status.state === 'scanning' || status.state === 'indexing'
  const setupRunning = setupWorkflow.state === 'running'

  // Fetch status on mount.
  const fetchStatus = useCallback(async () => {
    try {
      const s = await imageSearchBridge.getStatus()
      if (s) setStatus(s)
    } finally {
      setInitialStatusLoaded(true)
    }
  }, [])

  useEffect(() => {
    fetchStatus()
    // Load vector build and index status.
    ;(async () => {
      try {
        const api = window.electronAPI?.vector
        if (api?.getEmbeddingProgress) {
          const ep = await api.getEmbeddingProgress()
          if (ep) setEmbeddingProgress(ep)
        }
        if (api?.getVectorIndexStatus) {
          let indexStatus = await api.getVectorIndexStatus()
          if (!indexStatus.built && api.buildVectorIndex) {
            const adopted = await api.buildVectorIndex('dinov2_vitb14')
            if (adopted.ok) indexStatus = await api.getVectorIndexStatus()
          }
          setVectorIndexStatus(indexStatus)
        }
      } catch {
        /* ignore */
      }
    })()
  }, [fetchStatus])

  useEffect(() => {
    return window.electronAPI.fileDrag.onError((message) => showToast(t(message), 'err'))
  }, [showToast, t])

  // Scan completion toast.
  const prevScanning = useRef(false)
  useEffect(() => {
    const wasScanning = prevScanning.current
    prevScanning.current = isScanning
    if (wasScanning && !isScanning && status.state === 'idle') {
      const parts: string[] = []
      if (status.newCount != null && status.newCount > 0) parts.push(`${status.newCount} new`)
      if (status.updatedCount != null && status.updatedCount > 0)
        parts.push(`${status.updatedCount} updated`)
      if (status.skippedCount != null && status.skippedCount > 0)
        parts.push(`${status.skippedCount} unreadable`)
      if (status.durationMs != null) parts.push(`${(status.durationMs / 1000).toFixed(1)}s`)
      const msg = parts.length > 0 ? `Scan done: ${parts.join(', ')}` : 'Scan complete'
      showToast(msg, status.lastError ? 'err' : 'ok')
    }
  }, [
    isScanning,
    status.state,
    status.newCount,
    status.skippedIndexed,
    status.skippedUnchanged,
    status.updatedCount,
    status.skippedCount,
    status.warningCount,
    status.durationMs,
    status.lastError,
    showToast,
  ])

  // Auto-load manifest when manifestPath changes (e.g. Store restore after restart)
  const lastLoadedManifest = useRef('')
  const [autoloadState, setAutoloadState] = useState<'idle' | 'loading' | 'ok' | 'err'>('idle')
  useEffect(() => {
    if (!initialStatusLoaded || !manifestPath || manifestPath === lastLoadedManifest.current) return
    // Path correction: if manifestPath points to a file, correct to parent directory
    let rootDir = manifestPath
    const lower = rootDir.toLowerCase()
    if (
      lower.endsWith('.idx') ||
      lower.endsWith('manifest.json') ||
      lower.endsWith('manifest.tmp')
    ) {
      const idx = Math.max(rootDir.lastIndexOf('\\'), rootDir.lastIndexOf('/'))
      if (idx > 0) {
        rootDir = rootDir.slice(0, idx)
        setManifestPath(rootDir)
      }
    }
    // The main process owns loading the default index. Its status event also persists
    // that path in the renderer store; treating the event as a new user-selected path
    // used to load the same multi-gigabyte manifest for a second time during startup.
    if (
      status.segmentPath &&
      normalizeImageSearchRoot(status.segmentPath) === normalizeImageSearchRoot(rootDir) &&
      status.autoloadSource !== 'none'
    ) {
      lastLoadedManifest.current = rootDir
      setAutoloadState('ok')
      return
    }
    lastLoadedManifest.current = rootDir
    setAutoloadState('loading')
    imageSearchBridge
      .loadManifest(rootDir)
      .then((r) => {
        if (r?.ok) {
          setAutoloadState('ok')
          showToast(
            t('Loaded {records} records, {segments} segment(s)', {
              records: r.recordCount ?? 0,
              segments: r.segmentCount ?? 1,
            }),
          )
          fetchStatus()
        } else {
          setAutoloadState('err')
          showToast(
            t('Autoload failed: {error}', {
              error: r?.error || t('manifest may be empty'),
            }),
            'err',
          )
        }
      })
      .catch(() => {
        setAutoloadState('err')
        showToast(t('Autoload failed'), 'err')
      })
  }, [
    manifestPath,
    initialStatusLoaded,
    status.segmentPath,
    status.autoloadSource,
    fetchStatus,
    setManifestPath,
    showToast,
    t,
  ])

  // Listen for status changes.
  useEffect(() => {
    const unsub = imageSearchBridge.onStatusChanged((s) => {
      setStatus(s)
      // Sync autosave path to Store
      if (s.segmentPath && s.segmentPath !== manifestPath) {
        setManifestPath(s.segmentPath)
        addRecentManifest(s.segmentPath)
      }
    })
    return () => {
      unsub?.()
    }
  }, [manifestPath, setManifestPath, addRecentManifest])

  useEffect(() => {
    const focusPreparation = () => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-onboarding-action="image-prepare-library"]',
      )
      button?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      button?.focus()
    }
    window.addEventListener('workspace-prepare-library-focus', focusPreparation)
    return () => window.removeEventListener('workspace-prepare-library-focus', focusPreparation)
  }, [])

  // Listen for embedding build progress.
  useEffect(() => {
    const api = window.electronAPI?.vector
    if (!api?.onEmbeddingProgress) return
    const unsub = api.onEmbeddingProgress((progress: EmbeddingProgress) => {
      setEmbeddingProgress(progress)
    })
    return () => {
      unsub?.()
    }
  }, [])

  // Load available drives.
  useEffect(() => {
    imageSearchBridge.listDrives().then((drives) => setAvailableDrives(drives))
  }, [])

  useEffect(() => {
    const api = window.electronAPI?.vector
    if (!api?.onSemanticSearchProgress) return
    const unsub = api.onSemanticSearchProgress((progress: SemanticSearchProgress) => {
      if (progress.requestId && progress.requestId !== semanticRequestIdRef.current) return
      setSemanticProgress(progress)
    })
    return () => {
      unsub?.()
    }
  }, [])

  useEffect(() => {
    const api = window.electronAPI?.vector
    if (!api?.onLayeredSearchProgress) return
    const unsub = api.onLayeredSearchProgress((progress: LayeredSearchProgress) => {
      if (progress.requestId && progress.requestId !== layeredRequestIdRef.current) return
      setLayeredProgress(progress)
    })
    return () => {
      unsub?.()
    }
  }, [])

  // Check if any path is a whole drive root.
  const isWholeDrive = (p: string) => /^[A-Za-z]:\\?$/.test(p)

  const handleStartScan = useCallback(async () => {
    if (scanPaths.length === 0) {
      showToast(t('Add at least one scan path first'), 'err')
      return
    }
    // Check for whole-drive paths and require confirmation.
    const wholeDrives = scanPaths.filter((p) => isWholeDrive(p))
    if (wholeDrives.length > 0 && !confirmWholeDrive) {
      wholeDriveActionRef.current = 'scan'
      setConfirmWholeDrive(wholeDrives)
      return
    }
    setConfirmWholeDrive(null)
    const s = await imageSearchBridge.startScan({
      paths: scanPaths,
      mode: 'balanced',
      scanMode,
      buildThumbnails: buildScanThumbnails,
    })
    if (s) setStatus(s)
  }, [scanPaths, scanMode, buildScanThumbnails, confirmWholeDrive, showToast, t])

  const handleStartScanConfirmed = useCallback(async () => {
    setConfirmWholeDrive(null)
    if (wholeDriveActionRef.current === 'simple') {
      simpleSetupStartRef.current?.()
      return
    }
    const s = await imageSearchBridge.startScan({
      paths: scanPaths,
      mode: 'balanced',
      scanMode,
      buildThumbnails: buildScanThumbnails,
    })
    if (s) setStatus(s)
  }, [scanPaths, scanMode, buildScanThumbnails])

  const handleStopScan = useCallback(async () => {
    const s = await imageSearchBridge.stopScan()
    if (s) setStatus(s)
  }, [])

  const handleClearIndex = useCallback(async () => {
    if (isScanning) await imageSearchBridge.stopScan()
    await imageSearchBridge.clearIndex()
    setResults([])
    setQueryHash(null)
    fetchStatus()
  }, [isScanning, fetchStatus])

  const handleReloadIndex = useCallback(async () => {
    if (!manifestPath) {
      showToast(t('No manifest loaded'), 'err')
      return
    }
    const r = await imageSearchBridge.loadManifest(manifestPath)
    if (r?.ok) {
      const n = r.recordCount || 0
      showToast(
        t('Reloaded {records} records, {segments} segment(s)', {
          records: n,
          segments: r.segmentCount ?? 1,
        }),
      )
    } else {
      showToast(t('Reload failed: {error}', { error: r?.error || '' }), 'err')
    }
    fetchStatus()
  }, [fetchStatus, manifestPath, showToast, t])

  const handleLoadRecentManifest = useCallback(
    async (p: string) => {
      const r = await imageSearchBridge.loadManifest(p)
      if (r?.ok) {
        setManifestPath(p)
        addRecentManifest(p)
        showToast(
          t('Loaded {records} records, {segments} segment(s)', {
            records: r.recordCount ?? 0,
            segments: r.segmentCount ?? 1,
          }),
        )
        fetchStatus()
      } else {
        showToast(t('Load failed: {error}', { error: r?.error || '' }), 'err')
      }
    },
    [addRecentManifest, fetchStatus, setManifestPath, showToast, t],
  )

  const handleOpenIndexDir = useCallback(() => {
    const p = manifestPath || status.segmentPath
    if (p) {
      imageSearchBridge.openFolder(p)
    } else {
      showToast(t('No index path available'), 'err')
    }
  }, [manifestPath, showToast, status.segmentPath, t])

  const runImageQuery = useCallback(
    async (imagePath: string) => {
      const effectiveSearchMode = experienceMode === 'simple' ? 'standard' : searchMode
      setTestImagePath(imagePath)
      setLastQueryKind('image')
      setSearching(true)
      setSearchQuery('')
      setResults([])
      setLayeredResults([])
      setSemanticProgress(null)
      const requestId = `image-${Date.now()}-${Math.random().toString(36).slice(2)}`
      layeredRequestIdRef.current = requestId
      setLayeredProgress({
        requestId,
        mode: effectiveSearchMode,
        phase: 'preparing',
        scanned: 0,
        percent: 0,
        message: 'Preparing image search...',
      })
      try {
        if (effectiveSearchMode === 'fast') {
          // Fast mode: existing Hash-only search
          setLayeredProgress({
            requestId,
            mode: 'fast',
            phase: 'hash',
            scanned: 0,
            percent: 20,
            message: 'Hash search...',
          })
          const res = await imageSearchBridge.search({
            imagePath,
            threshold: hammingThreshold,
            topK,
            searchMode: 'fast',
          })
          if (res && layeredRequestIdRef.current === requestId) {
            announceFirstSearchCompleted('image')
            setLayeredProgress({
              requestId,
              mode: 'fast',
              phase: 'done',
              scanned: res.results?.length ?? 0,
              total: topK,
              percent: 100,
              message: 'Image search complete',
            })
            setResults(res.results)
            setStatus(res.status)
            setQueryHash(res.queryHash ?? null)
            setSearchMetrics(
              res.scannedCount != null
                ? {
                    scanned: res.scannedCount,
                    candidates: res.candidateCount,
                    returned: res.results?.length ?? 0,
                    ms: res.searchMs,
                    mode: res.mode,
                    indexType: res.indexType,
                    bucketSize: res.bucketSize,
                    fallbackUsed: res.fallbackUsed,
                    searchMode: res.searchMode,
                  }
                : null,
            )
          }
        } else {
          // Standard / Precise mode: layered search via vector API
          const electronAPI = window.electronAPI
          if (!electronAPI?.vector?.searchLayered) {
            showToast(t('Vector API not available'), 'err')
            setSearching(false)
            return
          }
          const res = await electronAPI.vector.searchLayered({
            imagePath,
            mode: effectiveSearchMode,
            requestId,
            hashThreshold: hammingThreshold,
            hashTopK: Math.max(100, topK * 2),
            vectorTopK: Math.max(200, topK * 3),
            rerankTopK: topK,
          })
          // A user-stopped search resolves as a degraded "cancelled" response:
          // keep the previous results and stay quiet instead of erroring.
          const cancelled =
            !!res?.degraded && res.degradationReasons.some((r) => /cancelled/i.test(r))
          if (res && layeredRequestIdRef.current === requestId && !cancelled) {
            announceFirstSearchCompleted('image')
            setLayeredResults(res.results)
            setQueryHash(res.queryHash ?? null)
            setSearchMetrics({
              scanned: res.hashCandidateCount,
              candidates: res.mergedCandidateCount,
              returned: res.results?.length ?? 0,
              ms: res.totalMs,
              mode: res.mode,
              indexType: 'hash+vector',
              searchMode: res.searchMode,
            })
            // Show degradation notice
            if (res.degraded && res.degradationReasons.length > 0) {
              showToast(t('Degraded: {reason}', { reason: res.degradationReasons[0] }), 'err')
            }
          }
        }
      } finally {
        if (layeredRequestIdRef.current === requestId) {
          layeredRequestIdRef.current = null
          setSearching(false)
        }
      }
    },
    [experienceMode, hammingThreshold, topK, searchMode, showToast, t],
  )

  const handleQueryImage = useCallback(async () => {
    const selectedPath = await imageSearchBridge.selectImage()
    if (selectedPath) await runImageQuery(selectedPath)
  }, [runImageQuery])

  const handlePasteClipboardImage = useCallback(async () => {
    if (searching) return
    const result = await imageSearchBridge.pasteClipboardImage()
    if (!result.ok || !result.path) {
      showToast(result.error || t('Clipboard has no image'), 'err')
      return
    }
    await runImageQuery(result.path)
  }, [runImageQuery, searching, showToast, t])

  const handleClearQueryImage = useCallback(() => {
    setTestImagePath(null)
    setHashResult(null)
    setQueryHash(null)
    setResults([])
    setLayeredResults([])
    setSearchMetrics(null)
    setLayeredProgress(null)
    setLastQueryKind((kind) => (kind === 'image' ? null : kind))
  }, [])

  const handleSemanticSearch = useCallback(async () => {
    const text = semanticQuery.trim()
    if (!text) {
      showToast(t('Enter semantic text first'), 'err')
      return
    }
    const api = window.electronAPI?.vector
    if (!api?.searchSemantic) {
      showToast(t('Semantic search API not available'), 'err')
      return
    }
    const latestModels = await refreshManagedModels()
    if (!isManagedSearchModelReady(latestModels?.clip_vit_base_patch32)) {
      showToast(t('The selected model is not ready.'), 'err')
      return
    }
    setSearching(true)
    setLastQueryKind('semantic')
    setResults([])
    setLayeredResults([])
    setQueryHash(null)
    setLayeredProgress(null)
    const requestId = `semantic-${Date.now()}-${Math.random().toString(36).slice(2)}`
    semanticRequestIdRef.current = requestId
    setSemanticProgress({
      requestId,
      phase: 'preparing',
      scanned: 0,
      percent: 0,
      message: 'Preparing semantic search...',
    })
    try {
      const res = await api.searchSemantic({ text, topK, requestId })
      if (res) {
        announceFirstSearchCompleted('image')
        setLayeredResults(res.results || [])
        setSearchMetrics({
          scanned: res.totalCandidates,
          candidates: res.matchedCandidates ?? res.results?.length ?? 0,
          returned: res.returnedCount ?? res.results?.length ?? 0,
          fallbackCount: res.fallbackCount ?? 0,
          ms: res.totalMs,
          mode: 'semantic',
          indexType: res.feedbackApplied
            ? `CLIP+feedback r${res.feedbackBuiltRevision ?? 0}${res.feedbackStale ? ' (stale)' : ''}`
            : 'CLIP',
          searchMode: 'semantic',
        })
        if (res.degraded && res.degradationReasons?.[0]) {
          showToast(res.degradationReasons[0], 'err')
        }
      }
    } finally {
      setSemanticProgress((prev) =>
        prev?.requestId === requestId
          ? { ...prev, phase: 'done', percent: 100, message: 'Semantic search complete' }
          : prev,
      )
      semanticRequestIdRef.current = null
      setSearching(false)
    }
  }, [refreshManagedModels, semanticQuery, showToast, t, topK])

  const handleRefreshSearch = useCallback(async () => {
    if (searching) return
    if (lastQueryKind === 'semantic' && semanticQuery.trim()) {
      await handleSemanticSearch()
      return
    }
    if (lastQueryKind === 'image' && testImagePath) {
      await runImageQuery(testImagePath)
      return
    }
    if (semanticQuery.trim()) {
      await handleSemanticSearch()
      return
    }
    showToast(t('No query to refresh'), 'err')
  }, [
    handleSemanticSearch,
    lastQueryKind,
    runImageQuery,
    searching,
    semanticQuery,
    showToast,
    t,
    testImagePath,
  ])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'v') return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable || searching) {
        return
      }
      event.preventDefault()
      void handlePasteClipboardImage()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handlePasteClipboardImage, searching])

  const handleSelectPaths = useCallback(async () => {
    const paths = await imageSearchBridge.selectPaths()
    if (paths?.length) addScanPaths(paths)
  }, [addScanPaths])

  const handleToggleDrivePicker = useCallback(async () => {
    if (showDrivePicker) {
      setShowDrivePicker(false)
      return
    }
    const drives = await imageSearchBridge.listDrives()
    setAvailableDrives(drives || [])
    setShowDrivePicker(true)
  }, [showDrivePicker])

  const handleAddDrive = useCallback(
    async (drive: string) => {
      setShowDrivePicker(false)
      addScanPaths([drive])
    },
    [addScanPaths],
  )

  const handleManualAdd = useCallback(async () => {
    const trimmed = manualPath.trim()
    if (!trimmed) return
    // Normalize drive roots like "C:" to "C:\".
    let normalized = trimmed
    if (/^[A-Za-z]:$/.test(normalized)) normalized = normalized + '\\'
    const result = await imageSearchBridge.validatePath(normalized)
    if (result?.ok) {
      addScanPaths([normalized])
      setManualPath('')
    } else {
      showToast(t('Path does not exist or is invalid'), 'err')
    }
  }, [manualPath, addScanPaths, showToast, t])

  const handleManualKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleManualAdd()
    },
    [handleManualAdd],
  )

  const handleRemovePath = useCallback(
    (p: string) => {
      removeScanPath(p)
    },
    [removeScanPath],
  )

  const handleClearPaths = useCallback(() => {
    clearScanPaths()
  }, [clearScanPaths])

  const handleSelectTestImage = useCallback(async () => {
    const p = await imageSearchBridge.selectImage()
    if (p) {
      setTestImagePath(p)
      setHashing(true)
      setHashResult(null)
      const r = await imageSearchBridge.hashImage(p)
      setHashResult(r)
      setHashing(false)
    }
  }, [])

  // Result actions.
  const handleOpenFile = useCallback(async (path: string) => {
    await imageSearchBridge.openFile(path)
  }, [])

  const handleOpenFolder = useCallback(async (path: string) => {
    await imageSearchBridge.openFolder(path)
  }, [])

  // doQuery removed

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files?.[0]
      const fp = file ? window.electronAPI.getPathForFile(file) : ''
      if (!fp) {
        showToast(t('Unable to read the dropped file path'), 'err')
        return
      }
      const ext = fp.split('.').pop()?.toLowerCase()
      if (!ext || !['jpg', 'jpeg', 'png', 'bmp', 'webp', 'gif'].includes(ext)) {
        showToast(t('Unsupported file type: .{extension}', { extension: ext || '?' }), 'err')
        return
      }
      await runImageQuery(fp)
    },
    [runImageQuery, showToast, t],
  )

  const handleCopyPath = useCallback(async (path: string) => {
    try {
      await window.electronAPI.copyToClipboard(path)
    } catch {
      /* ok */
    }
  }, [])

  const handleSearchSimilar = useCallback(
    async (path: string) => {
      if (searching) return
      await runImageQuery(path)
    },
    [runImageQuery, searching],
  )

  const [subjectPicker, setSubjectPicker] = useState<SubjectPickerData | null>(null)

  const runSubjectSearch = useCallback(
    async (path: string, subject?: SubjectBBox, segmentationSessionId?: string) => {
      if (subjectSearching || searching) return
      setSubjectSearching(true)
      setSearching(true)
      setLastQueryKind('image')
      setTestImagePath(path)
      try {
        const resp = await subjectSearchBridge.search(path, topK, subject, segmentationSessionId)
        if (resp.ok && resp.results.length > 0) {
          const mapped: ImageSearchResult[] = resp.results.map((r) => ({
            id: r.imageId,
            path: r.imagePath,
            score: r.score,
          }))
          setResults(mapped)
          setLayeredResults([])
          setSearchQuery('')
          showToast(
            t('Subject: {subject} · {count} results', {
              subject:
                resp.subjectLabel === 'manual'
                  ? t('Box select')
                  : resp.subjectLabel || t('unknown'),
              count: resp.results.length,
            }),
            'ok',
          )
        } else {
          // Stopped by the user via the Stop button: keep previous results.
          if (!/cancelled/i.test(resp.error || '')) {
            setResults([])
            setLayeredResults([])
            showToast(resp.error || t('No similar subjects found'), 'err')
          }
        }
      } catch (err) {
        setResults([])
        setLayeredResults([])
        showToast(err instanceof Error ? err.message : t('Subject search failed'), 'err')
      } finally {
        setSubjectSearching(false)
        setSearching(false)
      }
    },
    [subjectSearching, searching, showToast, t, topK],
  )

  // Stop the in-flight layered search (image or subject). The main process
  // bumps the search sequence; the running pipeline cancels at its next
  // checkpoint and resolves as a graceful "cancelled" response.
  const handleStopSearch = useCallback(() => {
    void window.electronAPI?.vector?.stopLayeredSearch?.().catch(() => {})
  }, [])

  // Detect first, then always open the picker: boxes to click, SAM
  // click-to-segment anywhere else, and Auto for the old direct path.
  const handleSubjectSearch = useCallback(
    async (path: string) => {
      if (subjectSearching || searching) return
      try {
        const det = await subjectSearchBridge.detect(path)
        if (!det.ok) {
          showToast(det.error || t('No subjects detected'), 'err')
          return
        }
        setSubjectPicker({
          imagePath: path,
          width: det.width,
          height: det.height,
          subjects: det.subjects,
        })
      } catch (err) {
        showToast(err instanceof Error ? err.message : t('Subject detection failed'), 'err')
      }
    },
    [subjectSearching, searching, showToast, t],
  )

  const handlePreparationProgress = useCallback(
    (progress: ImageSearchPreparationProgress) => {
      setSetupWorkflow(setupSnapshotFromImagePreparationProgress(progress))
      if (progress.state === 'running') {
        if (progress.taskId && progress.taskId !== setupTaskIdRef.current) {
          setupTaskIdRef.current = progress.taskId
          handledPreparationTaskRef.current = null
          if (setupPathsRef.current.length === 0) setupPathsRef.current = [...scanPaths]
        }
        return
      }

      const taskId = progress.taskId
      if (
        !taskId ||
        taskId !== setupTaskIdRef.current ||
        handledPreparationTaskRef.current === taskId
      ) {
        return
      }
      handledPreparationTaskRef.current = taskId
      setupTaskIdRef.current = null
      const preparedPaths = [...setupPathsRef.current]
      setupPathsRef.current = []
      void (async () => {
        if (progress.state === 'done') {
          const thumbnails = await startDeferredSimpleThumbnails(
            imageSearchBridge,
            preparedPaths,
            buildScanThumbnails,
            gpuJobs,
            batchSize,
          )
          if (thumbnails.error) {
            console.error('[ImageSearch] Background thumbnails:', thumbnails.error)
          }
        }
        await fetchStatus()
        showToast(
          progress.state === 'done'
            ? t('Image library ready')
            : progress.error || progress.message || t('Setup stopped'),
          progress.state === 'done' ? 'ok' : 'err',
        )
      })()
    },
    [batchSize, buildScanThumbnails, fetchStatus, gpuJobs, scanPaths, showToast, t],
  )

  useEffect(() => {
    const unsubscribe = imageSearchBridge.onPreparationProgress(handlePreparationProgress)
    let disposed = false
    void imageSearchBridge.getPreparationProgress().then((progress) => {
      if (disposed) return
      setSetupWorkflow(setupSnapshotFromImagePreparationProgress(progress))
      if (progress.state !== 'running' || !progress.taskId) return
      const discovered = setupTaskIdRef.current !== progress.taskId
      setupTaskIdRef.current = progress.taskId
      handledPreparationTaskRef.current = null
      if (discovered || setupPathsRef.current.length === 0) setupPathsRef.current = [...scanPaths]
    })
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [handlePreparationProgress, scanPaths])

  const runSimpleSetupNow = useCallback(async () => {
    if (setupTaskIdRef.current || scanPaths.length === 0) return
    if (isScanning || buildDisabled) {
      showToast(t('Wait for the current scan or embedding task to finish'), 'err')
      return
    }

    const paths = [...scanPaths]
    const started = await imageSearchBridge.prepareLibrary({
      paths,
      backend: 'auto',
      maxConcurrentEmbeddings: gpuJobs,
      batchSize,
      buildThumbnails: false,
    })
    if (!started.ok || !started.taskId) {
      showToast(started.error || t('Image scan failed to start'), 'err')
      return
    }
    if (handledPreparationTaskRef.current === started.taskId) return
    setupTaskIdRef.current = started.taskId
    handledPreparationTaskRef.current = null
    setupPathsRef.current = paths
    const progress = await imageSearchBridge.getPreparationProgress()
    if (progress.taskId === started.taskId) handlePreparationProgress(progress)
  }, [
    batchSize,
    buildDisabled,
    gpuJobs,
    handlePreparationProgress,
    isScanning,
    scanPaths,
    showToast,
    t,
  ])

  useEffect(() => {
    simpleSetupStartRef.current = () => void runSimpleSetupNow()
    return () => {
      simpleSetupStartRef.current = null
    }
  }, [runSimpleSetupNow])

  const handlePrepareLibrary = useCallback(() => {
    if (scanPaths.length === 0) {
      showToast(t('Add at least one scan path first'), 'err')
      return
    }
    const wholeDrives = scanPaths.filter((path) => isWholeDrive(path))
    if (wholeDrives.length > 0) {
      wholeDriveActionRef.current = 'simple'
      setConfirmWholeDrive(wholeDrives)
      return
    }
    void runSimpleSetupNow()
  }, [runSimpleSetupNow, scanPaths, showToast, t])

  const handleCancelSetup = useCallback(async () => {
    const taskId = setupTaskIdRef.current
    if (!taskId) return
    const stopped = await imageSearchBridge.stopPreparation(taskId)
    if (!stopped.ok) showToast(stopped.error || t('Setup stopped'), 'err')
  }, [showToast, t])

  const handleExperienceModeChange = useCallback(
    (mode: SearchExperienceMode) => setExperienceMode(mode),
    [setExperienceMode],
  )

  // Sorted results.
  const sortedResults = useMemo<ImageSearchDisplayResult[]>(() => {
    const displayResults: ImageSearchDisplayResult[] =
      layeredResults.length > 0
        ? layeredResults.map((lr) => ({
            id: lr.imageId,
            path: lr.path,
            score: lr.finalScore,
            distance: lr.diffDistance,
            width: lr.width,
            height: lr.height,
            fileSize: lr.fileSize,
            modifiedTime: lr.modifiedTime,
            dragToken: lr.dragToken,
            sourceKind: lr.sourceKind,
            sourceExt: lr.sourceExt,
            projectDisplayType: lr.projectDisplayType,
            keywords: lr.keywords,
            previewProvider: lr.previewProvider,
            _layered: lr as LayeredSearchResult,
          }))
        : ([...results] as ImageSearchDisplayResult[])
    return sortImageSearchResults(displayResults, sortBy)
  }, [results, layeredResults, sortBy])

  return (
    <DraggablePanel
      panelId="imageSearch"
      title="Image Search"
      displayTitle={t('Search')}
      x={imageSearchPos.x}
      y={imageSearchPos.y}
      defaultX={319}
      defaultY={42}
      w={imageSearchSize.w}
      h={imageSearchSize.h}
      defaultW={DEFAULT_IMAGESEARCH_W}
      defaultH={DEFAULT_IMAGESEARCH_H}
      onMove={handleMove}
      onResize={(w, h) => setImageSearchSize(w, h)}
      locked={locked}
      onToggleLock={() => togglePanelLocked('imageSearch')}
      visibilityLocked={visibilityLocked}
      onToggleVisibilityLock={() => toggleVisibilityLock('imageSearch')}
    >
      <div
        className="image-search-shell"
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          overflow: 'hidden',
          fontSize: 12,
        }}
      >
        <div className={`image-search-workspace is-${experienceMode}`}>
          <aside
            className="image-search-control-pane"
            aria-label={t('Search controls')}
            onDragOver={(event) => {
              event.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            <ImageSearchToastBanner toast={toast} />

            <ConfirmWholeDriveBanner
              paths={confirmWholeDrive}
              onConfirm={handleStartScanConfirmed}
              onCancel={() => setConfirmWholeDrive(null)}
            />

            <SearchControlSectionsToolbar
              panelId="image-search"
              leadingControl={
                <SearchExperienceModeBar
                  mode={experienceMode}
                  workflow={setupWorkflow}
                  onModeChange={handleExperienceModeChange}
                />
              }
              onExpandAll={() => setAllControlSectionsExpanded(true)}
              onCollapseAll={() => setAllControlSectionsExpanded(false)}
            />

            <CollapsibleSearchSection
              id="image-search-sources-section"
              step="01"
              title={t('Data sources and collections')}
              description={t(
                'Register storage locations, organize collections, and check connectivity.',
              )}
              expanded={expandedControlSections.sources}
              onToggle={() => toggleControlSection('sources')}
              tone="sources"
              testId="image-search-sources-section"
            >
              <DiscoverySourcesSection />
            </CollapsibleSearchSection>

            <ImageSearchControls
              experienceMode={experienceMode}
              workflowRunning={setupRunning}
              isScanning={isScanning}
              searching={searching}
              scanPaths={scanPaths}
              manualPath={manualPath}
              setManualPath={setManualPath}
              scanMode={scanMode}
              setScanMode={setScanMode}
              buildScanThumbnails={buildScanThumbnails}
              setBuildScanThumbnails={setBuildScanThumbnails}
              showDrivePicker={showDrivePicker}
              availableDrives={availableDrives}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              semanticQuery={semanticQuery}
              setSemanticQuery={setSemanticQuery}
              testImagePath={testImagePath}
              dragOver={dragOver}
              threshold={threshold}
              setThreshold={setThreshold}
              topK={topK}
              setTopK={setTopK}
              sortBy={sortBy}
              setSortBy={setSortBy}
              searchMode={searchMode}
              setSearchMode={setSearchMode}
              semanticModelReady={
                !managedModelsChecking &&
                !managedModelsCheckError &&
                isManagedModelReady('clip_vit_base_patch32')
              }
              showExtendedScores={showExtendedScores}
              setShowExtendedScores={setShowExtendedScores}
              onStartScan={handleStartScan}
              onStopScan={handleStopScan}
              onPrepareLibrary={handlePrepareLibrary}
              onCancelSetup={() => void handleCancelSetup()}
              onSelectPaths={handleSelectPaths}
              onToggleDrivePicker={handleToggleDrivePicker}
              onAddDrive={handleAddDrive}
              onManualKeyDown={handleManualKeyDown}
              onManualAdd={handleManualAdd}
              onClearPaths={handleClearPaths}
              onRemovePath={handleRemovePath}
              onQueryImage={handleQueryImage}
              onPasteClipboardImage={handlePasteClipboardImage}
              onRefreshSearch={handleRefreshSearch}
              onClearQueryImage={handleClearQueryImage}
              onSemanticSearch={handleSemanticSearch}
              libraryExpanded={expandedControlSections.library}
              onToggleLibrary={() => toggleControlSection('library')}
            />

            <CollapsibleSearchSection
              id="image-search-maintenance-section"
              step="04"
              title={t('Index and maintenance')}
              description={t('Review index health, storage, rebuild tools, and diagnostics.')}
              expanded={expandedControlSections.maintenance}
              onToggle={() => toggleControlSection('maintenance')}
              tone="maintenance"
              testId="image-search-maintenance-section"
              summary={t(status.state)}
            >
              <ImageSearchDataManager
                scanPaths={scanPaths}
                disabled={isScanning || setupRunning}
                onChanged={() => {
                  setResults([])
                  setLayeredResults([])
                  void fetchStatus()
                }}
                showToast={showToast}
              />

              {experienceMode === 'simple' && (
                <SearchSetupProgress
                  workflow={setupWorkflow}
                  embeddingProgress={embeddingProgress}
                />
              )}

              {experienceMode === 'advanced' && (
                <>
                  <EmbeddingBuildControls
                    searchMode={searchMode}
                    scanPaths={scanPaths}
                    dinoModelStatus={dinoModelStatus}
                    clipModelStatus={clipModelStatus}
                    embeddingProgress={embeddingProgress}
                    gpuJobs={gpuJobs}
                    setGpuJobs={setGpuJobs}
                    batchSize={batchSize}
                    setBatchSize={setBatchSize}
                    showToast={showToast}
                  />
                  <VectorMaintenanceBar
                    indexedCount={status.indexedCount}
                    gpuJobs={gpuJobs}
                    buildDisabled={buildDisabled}
                    showToast={showToast}
                  />
                </>
              )}

              <ImageSearchStatusBar
                status={status}
                isScanning={isScanning}
                vectorIndexStatus={vectorIndexStatus}
              />

              {experienceMode === 'advanced' && (
                <>
                  <RecentManifestBar
                    manifests={recentManifests}
                    onLoad={handleLoadRecentManifest}
                  />

                  <ImageSearchIndexFooter
                    status={status}
                    manifestPath={manifestPath}
                    autoloadState={autoloadState}
                    onReload={handleReloadIndex}
                    onClear={handleClearIndex}
                    onOpenIndexDir={handleOpenIndexDir}
                  />

                  <ImageHashSmokeTest
                    testImagePath={testImagePath}
                    hashing={hashing}
                    hashResult={hashResult}
                    onSelectTestImage={handleSelectTestImage}
                  />
                </>
              )}
            </CollapsibleSearchSection>
          </aside>

          <main className="image-search-results-pane">
            <SearchProgressBar
              searching={searching}
              lastQueryKind={lastQueryKind}
              semanticProgress={semanticProgress}
              layeredProgress={layeredProgress}
              onStop={handleStopSearch}
            />

            <ImageSearchResultGrid
              results={sortedResults}
              rawResultCount={sortedResults.length}
              queryHash={queryHash}
              statusState={status.state}
              searchQuery={searchQuery}
              searchMetrics={searchMetrics}
              showExtendedScores={showExtendedScores}
              onOpenFile={handleOpenFile}
              onOpenFolder={handleOpenFolder}
              onCopyPath={handleCopyPath}
              onSearchSimilar={handleSearchSimilar}
              onSubjectSearch={handleSubjectSearch}
            />
          </main>
        </div>
      </div>

      {subjectPicker && (
        <SubjectPickerModal
          data={subjectPicker}
          onPick={(subject: SubjectBBox) => {
            const path = subjectPicker.imagePath
            setSubjectPicker(null)
            void runSubjectSearch(path, subject)
          }}
          onSegment={(bbox, segmentationSessionId) => {
            const path = subjectPicker.imagePath
            setSubjectPicker(null)
            void runSubjectSearch(
              path,
              {
                x: bbox.x,
                y: bbox.y,
                w: bbox.w,
                h: bbox.h,
                confidence: 1,
                label: 'sam',
              },
              segmentationSessionId,
            )
          }}
          onAuto={() => {
            const path = subjectPicker.imagePath
            setSubjectPicker(null)
            void runSubjectSearch(path)
          }}
          onCancel={() => setSubjectPicker(null)}
        />
      )}
    </DraggablePanel>
  )
}

export default ImageSearchPanel
