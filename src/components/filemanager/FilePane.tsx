import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useFMStore } from '../../stores/useFMStore'
import type { FileEntry, SortState, SortField, ViewMode, GroupMode, GroupInfo } from './types'
import { VIEW_MODE_LABELS, GROUP_MODE_LABELS } from './types'
import FileContextMenu from './FileContextMenu'
import { getFileCategory } from './FileIcon'
import ThumbnailImage, { thumbnailSizeForView, preloadFileIcons } from './ThumbnailImage'
import GroupHeader from './GroupHeader'
import { useTranslation } from '../../i18n/useTranslation'
import {
  createFolderSizeSortSnapshot,
  sortEntriesBySizeSnapshot,
  summarizeCurrentFolderSize,
  type FolderSizeDisplayState,
} from './folderSizeAggregation'
import { DirectoryLoadCoordinator } from './directoryLoadCoordinator'
import type { FMVolumeSpaceResult } from '../../../shared/ipc/file-manager'

const PAGE_SIZE = 500
const FOLDER_SIZE_REQUEST_CONCURRENCY = 2
const FOLDER_SIZE_AUTO_QUEUE_LIMIT = 64
let folderSizeRequestSequence = 0

interface FolderSizeRequestGeneration {
  id: string
  queue: string[]
  queued: Set<string>
  active: number
  cancelled: boolean
}

interface FolderSizeCellProps {
  folderPath: string
  state?: FolderSizeDisplayState
  observe: (element: Element, folderPath: string) => () => void
  calculatingLabel: string
  queuedLabel: string
  scanningLabel: (count: string) => string
  unavailableLabel: string
  partialLabel: string
  style?: React.CSSProperties
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const FolderSizeCell = React.memo<FolderSizeCellProps>(
  ({
    folderPath,
    state,
    observe,
    calculatingLabel,
    queuedLabel,
    scanningLabel,
    unavailableLabel,
    partialLabel,
    style,
  }) => {
    const cellRef = useRef<HTMLSpanElement | null>(null)

    useEffect(() => {
      if (state) return
      const cell = cellRef.current
      if (!cell) return
      return observe(cell, folderPath)
    }, [folderPath, observe, state])

    let text = '…'
    let title = calculatingLabel
    if (state?.status === 'queued') {
      text = queuedLabel
      title = queuedLabel
    } else if (state?.status === 'loading') {
      text = `≥ ${formatSize(state.bytes)}`
      title = `${scanningLabel(state.entriesScanned.toLocaleString())} · ${formatSize(state.bytes)}`
    } else if (state?.status === 'ready') {
      text = `${state.complete ? '' : '≥ '}${formatSize(state.bytes)}`
      title = state.complete ? text : `${partialLabel}: ${formatSize(state.bytes)}`
    } else if (state?.status === 'error') {
      text = '—'
      title = `${unavailableLabel}: ${state.error}`
    }

    return (
      <span
        ref={cellRef}
        data-testid="fm-folder-size"
        data-folder-size-state={state?.status ?? 'waiting'}
        data-folder-size-bytes={
          state?.status === 'loading' || state?.status === 'ready' ? state.bytes : undefined
        }
        title={title}
        style={style}
      >
        {text}
      </span>
    )
  },
)

FolderSizeCell.displayName = 'FolderSizeCell'

function createFolderSizeGeneration(paneIndex: number): FolderSizeRequestGeneration {
  folderSizeRequestSequence += 1
  return {
    id: `pane-${paneIndex}-${Date.now()}-${folderSizeRequestSequence}`,
    queue: [],
    queued: new Set(),
    active: 0,
    cancelled: false,
  }
}

function formatTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ── Grouping helpers ───────────────────────────────────────

function groupFiles(files: FileEntry[], mode: GroupMode): GroupInfo[] {
  if (mode === 'none') {
    return [{ key: '__all__', label: '', count: files.length, files }]
  }

  const groups = new Map<string, FileEntry[]>()

  for (const f of files) {
    let key: string
    switch (mode) {
      case 'type':
        key = f.isDirectory ? '📁 文件夹' : f.type || '?'
        break
      case 'ext':
        key = f.isDirectory ? '文件夹' : f.type || '?'
        break
      case 'category':
        key = getFileCategory(f.type, f.isDirectory)
        break
      case 'mtime': {
        const d = new Date(f.mtime)
        const now = new Date()
        const dayMs = 24 * 60 * 60 * 1000
        const diff = now.getTime() - d.getTime()
        if (diff < dayMs) key = '今天'
        else if (diff < 2 * dayMs) key = '昨天'
        else if (diff < 7 * dayMs) key = '本周'
        else if (diff < 30 * dayMs) key = '本月'
        else if (d.getFullYear() === now.getFullYear())
          key = `${d.getFullYear()}年${d.getMonth() + 1}月`
        else key = `${d.getFullYear()}年`
        break
      }
      case 'size': {
        if (f.isDirectory) {
          key = '文件夹'
          break
        }
        const s = f.size
        if (s === 0) key = '空文件'
        else if (s < 1024) key = '小于 1 KB'
        else if (s < 1024 * 1024) key = '1 KB - 1 MB'
        else if (s < 10 * 1024 * 1024) key = '1 MB - 10 MB'
        else if (s < 100 * 1024 * 1024) key = '10 MB - 100 MB'
        else if (s < 1024 * 1024 * 1024) key = '100 MB - 1 GB'
        else key = '大于 1 GB'
        break
      }
      case 'folder-first':
        key = f.isDirectory ? '📁 文件夹' : '📄 文件'
        break
      default:
        key = '__other__'
    }
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(f)
  }

  // Sort groups: folders first, then alphabetically
  const entries = [...groups.entries()]
  entries.sort((a, b) => {
    const aIsDir = a[0].includes('文件夹') || a[0].startsWith('📁')
    const bIsDir = b[0].includes('文件夹') || b[0].startsWith('📁')
    if (aIsDir && !bIsDir) return -1
    if (!aIsDir && bIsDir) return 1
    if (mode === 'mtime') {
      return b[0].localeCompare(a[0])
    }
    return a[0].localeCompare(b[0])
  })

  return entries.map(([key, groupFiles]) => ({
    key,
    label: key,
    count: groupFiles.length,
    files: groupFiles,
  }))
}

interface FilePaneProps {
  paneIndex: number
  path: string
  tabs?: string[]
  activeTabIdx?: number
  isActive?: boolean
  sort: SortState
  viewMode: ViewMode
  groupMode: GroupMode
  onNavigate: (newPath: string) => void
  onSortChange: (sort: SortState) => void
  onViewModeChange: (mode: ViewMode) => void
  onGroupModeChange: (mode: GroupMode) => void
  selectedPaths: Set<string>
  onSelectionChange: (paths: Set<string>) => void
  onOpenFile: (filePath: string) => void
  showHidden: boolean
  onActivate?: () => void
  onAddTab?: (path: string) => void
  onRemoveTab?: (tabIdx: number) => void
  onSetActiveTab?: (tabIdx: number) => void
  refreshKey?: number
  fontScale?: number
}

const FilePane: React.FC<FilePaneProps> = ({
  paneIndex,
  path: currentPath,
  tabs = [],
  activeTabIdx = 0,
  isActive = false,
  sort,
  viewMode,
  groupMode,
  onNavigate,
  onSortChange,
  onViewModeChange,
  onGroupModeChange,
  selectedPaths,
  onSelectionChange,
  onOpenFile,
  showHidden,
  onActivate,
  onAddTab,
  onRemoveTab,
  onSetActiveTab,
  refreshKey,
  fontScale = 1.0,
}) => {
  const { t } = useTranslation()
  const fs = (px: number) => px * fontScale
  const [files, setFiles] = useState<FileEntry[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; file: FileEntry | null } | null>(
    null,
  )
  const [lastClicked, setLastClicked] = useState<string | null>(null)
  const [editingPath, setEditingPath] = useState(false)
  const [pathInput, setPathInput] = useState('')
  const [folderThumbs, setFolderThumbs] = useState<Map<string, string[]>>(new Map())
  const [folderSizeStates, setFolderSizeStates] = useState<Map<string, FolderSizeDisplayState>>(
    new Map(),
  )
  const [folderSizeSortSnapshot, setFolderSizeSortSnapshot] = useState<Map<string, number>>(
    new Map(),
  )
  const [volumeSpace, setVolumeSpace] = useState<FMVolumeSpaceResult | null>(null)
  const [renameFile, setRenameFile] = useState<{ path: string; name: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameError, setRenameError] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  useEffect(() => setRenameError(''), [renameFile])
  const fmGroupExpanded = useFMStore((s) => s.fmGroupExpanded)
  const [initialFolderSizeGeneration] = useState(() => createFolderSizeGeneration(paneIndex))
  const folderSizeGenerationRef = useRef<FolderSizeRequestGeneration>(initialFolderSizeGeneration)
  const [directoryLoadCoordinator] = useState(() => new DirectoryLoadCoordinator())
  const folderSizePumpRef = useRef<() => void>(() => {})
  const volumeSpaceRequestRef = useRef(0)
  const viewModeRef = useRef(viewMode)
  viewModeRef.current = viewMode
  const filesLengthRef = useRef(files.length)
  filesLengthRef.current = files.length
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const folderSizeObserverRef = useRef<IntersectionObserver | null>(null)
  const observedFolderSizeCellsRef = useRef<Map<Element, string>>(new Map())
  const scheduleFolderSizeRef = useRef<(folderPath: string) => void>(() => {})
  const listedDirectoryRef = useRef<string | null>(null)
  // Initialized as no-op — overwritten by loadDir once it's defined below
  const loadDirRef = useRef<
    (dir: string, reset?: boolean | 'silent', preserveFolderSizes?: boolean) => void
  >(() => {})

  const cancelFolderSizeGeneration = useCallback((generation: FolderSizeRequestGeneration) => {
    if (generation.cancelled) return
    generation.cancelled = true
    generation.queue.length = 0
    void window.electronAPI.fmCancelFolderSizeRequests(generation.id).catch(() => {})
  }, [])

  const pumpFolderSizeQueue = useCallback(() => {
    const generation = folderSizeGenerationRef.current
    while (
      !generation.cancelled &&
      generation.active < FOLDER_SIZE_REQUEST_CONCURRENCY &&
      generation.queue.length > 0
    ) {
      const folderPath = generation.queue.shift()!
      generation.active += 1
      void window.electronAPI
        .fmGetFolderSize({ folderPath, requestId: generation.id })
        .then((result) => {
          if (generation.cancelled || folderSizeGenerationRef.current !== generation) return
          setFolderSizeStates((previous) => {
            const next = new Map(previous)
            if (result.error || result.cancelled) {
              next.set(folderPath, {
                status: 'error',
                error: result.error || 'Folder size request was cancelled',
              })
            } else {
              next.set(folderPath, {
                status: 'ready',
                bytes: result.bytes,
                complete: result.complete,
                ...(result.partialReason && { partialReason: result.partialReason }),
              })
            }
            return next
          })
        })
        .catch((requestError: unknown) => {
          if (generation.cancelled || folderSizeGenerationRef.current !== generation) return
          setFolderSizeStates((previous) => {
            const next = new Map(previous)
            next.set(folderPath, { status: 'error', error: errorMessage(requestError) })
            return next
          })
        })
        .finally(() => {
          generation.active = Math.max(0, generation.active - 1)
          if (!generation.cancelled && folderSizeGenerationRef.current === generation) {
            folderSizePumpRef.current()
          }
        })
    }
  }, [])

  folderSizePumpRef.current = pumpFolderSizeQueue

  const scheduleFolderSize = useCallback((folderPath: string) => {
    const generation = folderSizeGenerationRef.current
    if (generation.cancelled || generation.queued.has(folderPath)) return
    generation.queued.add(folderPath)
    generation.queue.push(folderPath)
    setFolderSizeStates((previous) => {
      if (previous.has(folderPath)) return previous
      const next = new Map(previous)
      next.set(folderPath, { status: 'queued' })
      return next
    })
    folderSizePumpRef.current()
  }, [])

  scheduleFolderSizeRef.current = scheduleFolderSize

  useEffect(
    () =>
      window.electronAPI.onFMFolderSizeProgress((progress) => {
        const generation = folderSizeGenerationRef.current
        if (
          generation.cancelled ||
          progress.requestId !== generation.id ||
          !generation.queued.has(progress.path)
        ) {
          return
        }
        setFolderSizeStates((previous) => {
          const current = previous.get(progress.path)
          if (progress.phase === 'queued' && current?.status === 'loading') return previous
          const next = new Map(previous)
          next.set(
            progress.path,
            progress.phase === 'queued'
              ? { status: 'queued' }
              : {
                  status: 'loading',
                  entriesScanned: progress.entriesScanned,
                  bytes: progress.bytes,
                },
          )
          return next
        })
      }),
    [],
  )

  const observeFolderSizeCell = useCallback((element: Element, folderPath: string) => {
    if (typeof IntersectionObserver === 'undefined') {
      scheduleFolderSizeRef.current(folderPath)
      return () => {}
    }
    let observer = folderSizeObserverRef.current
    if (!observer) {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue
            const visibleFolderPath = observedFolderSizeCellsRef.current.get(entry.target)
            if (!visibleFolderPath) continue
            observer?.unobserve(entry.target)
            observedFolderSizeCellsRef.current.delete(entry.target)
            scheduleFolderSizeRef.current(visibleFolderPath)
          }
        },
        { root: scrollRef.current, rootMargin: '96px' },
      )
      folderSizeObserverRef.current = observer
    }
    observedFolderSizeCellsRef.current.set(element, folderPath)
    observer.observe(element)
    return () => {
      if (observedFolderSizeCellsRef.current.get(element) !== folderPath) return
      observedFolderSizeCellsRef.current.delete(element)
      observer?.unobserve(element)
    }
  }, [])

  const resetFolderSizeRequests = useCallback(
    (_dir: string) => {
      cancelFolderSizeGeneration(folderSizeGenerationRef.current)
      folderSizeGenerationRef.current = createFolderSizeGeneration(paneIndex)
      setFolderSizeStates(new Map())
      setFolderSizeSortSnapshot(new Map())
    },
    [cancelFolderSizeGeneration, paneIndex],
  )

  const refreshVolumeSpace = useCallback((dir: string) => {
    const requestSequence = volumeSpaceRequestRef.current + 1
    volumeSpaceRequestRef.current = requestSequence
    setVolumeSpace(null)
    if (!dir || typeof window.electronAPI.fmGetVolumeSpace !== 'function') return
    void window.electronAPI
      .fmGetVolumeSpace(dir)
      .then((result) => {
        if (volumeSpaceRequestRef.current !== requestSequence) return
        setVolumeSpace(result.error ? null : result)
      })
      .catch(() => {
        if (volumeSpaceRequestRef.current === requestSequence) setVolumeSpace(null)
      })
  }, [])

  useEffect(
    () => () => {
      directoryLoadCoordinator.invalidate()
      cancelFolderSizeGeneration(folderSizeGenerationRef.current)
      volumeSpaceRequestRef.current += 1
      folderSizeObserverRef.current?.disconnect()
      folderSizeObserverRef.current = null
      observedFolderSizeCellsRef.current.clear()
    },
    [cancelFolderSizeGeneration, directoryLoadCoordinator],
  )

  const folderSizeLabels = useMemo(
    () => ({
      calculatingLabel: t('Calculating folder size...'),
      queuedLabel: t('Queued'),
      scanningLabel: (count: string) => t('Scanning folder size: {count} items', { count }),
      unavailableLabel: t('Folder size unavailable'),
      partialLabel: t('Partial folder size'),
    }),
    [t],
  )

  // ── Load directory (paged) ─────────────────────
  // reset: true = full reload (navigate/sort), false = append (load more), 'silent' = replace without clearing (watch)
  const loadDir = useCallback(
    async (dir: string, reset: boolean | 'silent' = true, preserveFolderSizes = false) => {
      const isFullReset = reset === true
      const isSilent = reset === 'silent'
      const loadTicket = directoryLoadCoordinator.begin(reset)
      if (!loadTicket) return

      if ((isFullReset || isSilent) && !preserveFolderSizes) {
        resetFolderSizeRequests(dir)
        refreshVolumeSpace(dir)
      }
      if (isFullReset) {
        setLoading(true)
        setFiles([])
        setTotal(0)
        setHasMore(false)
      } else if (!isSilent) {
        setLoadingMore(true)
      }
      setError('')
      if (isFullReset) setFolderThumbs(new Map())

      try {
        const offset = isFullReset || isSilent ? 0 : filesLengthRef.current
        const result = await window.electronAPI.fmListDirectoryPaged({
          dirPath: dir,
          sort: { field: sort.field, direction: sort.direction },
          offset,
          limit: PAGE_SIZE,
        })
        if (!directoryLoadCoordinator.isCurrent(loadTicket)) return
        if (result.error) {
          setError(result.error)
          if (isFullReset) setFiles([])
        } else {
          if (isFullReset || isSilent) {
            setFiles(result.files)
          } else {
            setFiles((prev) => [...prev, ...result.files])
          }
          setTotal(result.total)
          setHasMore(result.hasMore)
          // Background: preload icons for first page (deferred 200ms to avoid frame drop)
          if (isFullReset && result.files.length > 0) {
            const mode = viewModeRef.current
            const slice = result.files.slice(0, 100)
            setTimeout(() => {
              if (directoryLoadCoordinator.isCurrent(loadTicket)) preloadFileIcons(slice, mode)
            }, 200)
          }
        }
      } catch (e: unknown) {
        if (!directoryLoadCoordinator.isCurrent(loadTicket)) return
        setError(errorMessage(e))
        if (isFullReset) setFiles([])
      } finally {
        directoryLoadCoordinator.finish(loadTicket)
        if (directoryLoadCoordinator.isCurrent(loadTicket)) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [directoryLoadCoordinator, refreshVolumeSpace, resetFolderSizeRequests, sort],
  )

  // Keep ref in sync after loadDir is defined
  loadDirRef.current = loadDir

  useEffect(() => {
    if (!currentPath) return
    const directoryKey = currentPath.replace(/\//g, '\\').replace(/\\+$/, '').toLocaleLowerCase()
    const sameDirectory = listedDirectoryRef.current === directoryKey
    listedDirectoryRef.current = directoryKey
    loadDir(currentPath, sameDirectory ? 'silent' : true, sameDirectory)
  }, [currentPath, loadDir])

  // Keep a ref to the latest path so the refresh effect always loads the current directory
  const currentPathRef = useRef(currentPath)
  currentPathRef.current = currentPath

  // Re-load on external refresh trigger (e.g. after drop)
  useEffect(() => {
    if (currentPathRef.current && refreshKey !== undefined)
      loadDirRef.current(currentPathRef.current, true)
  }, [refreshKey])

  // ── Auto-refresh on directory changes (fs.watch) ──
  useEffect(() => {
    if (!currentPath) return

    // Watch the current directory
    window.electronAPI.fmWatchDir(currentPath).catch(() => {})

    // Listen for change events
    const unsub = window.electronAPI.onDirChanged((changedPath: string) => {
      if (changedPath === currentPathRef.current) {
        loadDirRef.current(currentPathRef.current, 'silent')
      }
    })

    return () => {
      unsub()
      window.electronAPI.fmUnwatchDir(currentPath).catch(() => {})
    }
  }, [currentPath])

  // ── Sentinel: auto-load next page when scrolled near bottom ──
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !hasMore || loadingMore) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && hasMore && !loadingMore) {
          loadDirRef.current(currentPathRef.current, false)
        }
      },
      { root: scrollRef.current, rootMargin: '200px' },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loadingMore])

  // ── Ctrl+A / F2: global keyboard shortcuts in active pane ─
  useEffect(() => {
    if (!isActive) return
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.ctrlKey && e.key === 'a') {
        e.preventDefault()
        const selectableFiles = showHidden ? files : files.filter((f) => !f.name.startsWith('.'))
        onSelectionChange(new Set(selectableFiles.map((f) => f.path)))
      }
      // F2: rename single selected file
      if (e.key === 'F2' && selectedPaths.size === 1) {
        e.preventDefault()
        const targetPath = [...selectedPaths][0]
        const entry = files.find((f) => f.path === targetPath)
        if (entry && !entry.isDirectory) {
          setRenameFile({ path: entry.path, name: entry.name })
          setRenameValue(entry.name)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isActive, files, showHidden, onSelectionChange, selectedPaths])

  // ── Filter + sort is done server-side via fmListDirectoryPaged ──
  // The client applies the frozen recursive-folder-size snapshot without mutating server pages.
  const visibleFiles = useMemo(() => {
    const filtered = showHidden ? files : files.filter((f) => !f.name.startsWith('.'))
    return sort.field === 'size'
      ? sortEntriesBySizeSnapshot(filtered, sort.direction, folderSizeSortSnapshot)
      : filtered
  }, [files, folderSizeSortSnapshot, showHidden, sort.direction, sort.field])

  // Small directories (including drive roots) can safely queue every child folder.
  // Large directories remain viewport-driven so opening them never creates an unbounded scan queue.
  useEffect(() => {
    if (loading || hasMore) return
    const folders = visibleFiles.filter((entry) => entry.isDirectory)
    if (folders.length === 0 || folders.length > FOLDER_SIZE_AUTO_QUEUE_LIMIT) return
    for (const folder of folders) scheduleFolderSizeRef.current(folder.path)
  }, [hasMore, loading, visibleFiles])

  const currentSizeSummary = useMemo(
    () =>
      summarizeCurrentFolderSize(
        visibleFiles,
        folderSizeStates,
        hasMore || loading || Boolean(error),
      ),
    [visibleFiles, folderSizeStates, hasMore, loading, error],
  )

  // ── Groups ─────────────────────────────────────
  const groups = useMemo(() => groupFiles(visibleFiles, groupMode), [visibleFiles, groupMode])

  // ── Selection ──────────────────────────────────
  const handleClick = useCallback(
    (e: React.MouseEvent, f: FileEntry) => {
      onActivate?.()
      if (e.ctrlKey) {
        const next = new Set(selectedPaths)
        if (next.has(f.path)) next.delete(f.path)
        else next.add(f.path)
        onSelectionChange(next)
        setLastClicked(f.path)
      } else if (e.shiftKey && lastClicked) {
        const flat: FileEntry[] = []
        for (const g of groups) flat.push(...g.files)
        const idx1 = flat.findIndex((x) => x.path === lastClicked)
        const idx2 = flat.findIndex((x) => x.path === f.path)
        if (idx1 >= 0 && idx2 >= 0) {
          const start = Math.min(idx1, idx2)
          const end = Math.max(idx1, idx2)
          const next = new Set(selectedPaths)
          for (let i = start; i <= end; i++) next.add(flat[i].path)
          onSelectionChange(next)
        }
        setLastClicked(null)
      } else {
        onSelectionChange(new Set([f.path]))
        setLastClicked(f.path)
      }
    },
    [selectedPaths, onSelectionChange, groups, lastClicked, onActivate],
  )

  const handleDoubleClick = useCallback(
    (f: FileEntry) => {
      onActivate?.()
      if (f.isDirectory) {
        onNavigate(f.path)
        onSelectionChange(new Set())
      } else {
        onOpenFile(f.path)
      }
    },
    [onNavigate, onOpenFile, onSelectionChange, onActivate],
  )

  // ── Drag source ────────────────────────────────
  const handleDragStart = useCallback(
    (e: React.DragEvent, f: FileEntry) => {
      if (!selectedPaths.has(f.path)) {
        onSelectionChange(new Set([f.path]))
      }
      const paths = selectedPaths.has(f.path) ? [...selectedPaths] : [f.path]
      e.dataTransfer.setData('text/plain', paths.join('\n'))
      e.dataTransfer.effectAllowed = 'copyMove'
    },
    [selectedPaths, onSelectionChange],
  )

  // ── Context menu ───────────────────────────────
  const handleContext = useCallback(
    (e: React.MouseEvent, file: FileEntry | null) => {
      e.preventDefault()
      e.stopPropagation() // prevent bubbling to parent (empty-space) handler
      onActivate?.()
      if (file && !selectedPaths.has(file.path)) {
        onSelectionChange(new Set([file.path]))
      }
      setCtxMenu({ x: e.clientX, y: e.clientY, file })
    },
    [selectedPaths, onSelectionChange, onActivate],
  )

  // ── Column header click ───────────────────────
  const headerClick = (field: SortField) => {
    const dir = sort.field === field ? (sort.direction === 'asc' ? 'desc' : 'asc') : 'asc'
    if (field === 'size') {
      setFolderSizeSortSnapshot(createFolderSizeSortSnapshot(folderSizeStates))
    }
    onSortChange({ field, direction: dir })
  }

  const sortArrow = (field: SortField) =>
    sort.field === field ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : ''

  // ── Path bar ────────────────────────────────────
  const goUp = () => {
    const parts = currentPath.replace(/\\/g, '/').split('/').filter(Boolean)
    if (parts.length <= 1 && currentPath.match(/^[A-Za-z]:/)) return
    parts.pop()
    const up =
      parts.length === 0
        ? currentPath.substring(0, currentPath.indexOf(':') + 1) + '\\'
        : parts.join('\\') + '\\'
    onNavigate(up)
  }

  const handleBrowse = async () => {
    const folder = await window.electronAPI.browseFolder()
    if (folder) onNavigate(folder)
  }

  const startEditPath = () => {
    setPathInput(currentPath)
    setEditingPath(true)
  }

  const commitPath = () => {
    setEditingPath(false)
    const trimmed = pathInput.trim()
    if (trimmed && trimmed !== currentPath) {
      window.electronAPI.fmExpandPath(trimmed).then((expanded: string) => {
        onNavigate(expanded)
      })
    }
  }

  // ── Flat list for shift-range ────────────────────
  const flatFileList = useMemo(() => {
    const flat: FileEntry[] = []
    for (const g of groups) flat.push(...g.files)
    return flat
  }, [groups])

  // ── Determine if we should show columns ─────────
  const isIconView =
    viewMode === 'xlarge-icon' ||
    viewMode === 'large-icon' ||
    viewMode === 'medium-icon' ||
    viewMode === 'small-icon' ||
    viewMode === 'thumbnail-grid'
  const currentTotalSize = `${currentSizeSummary.complete ? '' : '≥ '}${formatSize(currentSizeSummary.bytes)}`
  const currentTotalSizeTitle = currentSizeSummary.complete
    ? t('Current displayed item sizes are fully counted')
    : currentSizeSummary.folderCount > 0
      ? t('Current total is updating: {complete}/{total} loaded folders complete', {
          complete: currentSizeSummary.completeFolderCount.toLocaleString(),
          total: currentSizeSummary.folderCount.toLocaleString(),
        })
      : t('Current total is updating as more items load')
  const volumeSpaceTitle = volumeSpace
    ? t(
        'Volume usage: {used} used of {total}; {free} free. Current logical item total: {logical}',
        {
          used: formatSize(volumeSpace.usedBytes),
          total: formatSize(volumeSpace.totalBytes),
          free: formatSize(volumeSpace.availableBytes),
          logical: currentTotalSize,
        },
      )
    : ''

  const submitRename = async () => {
    if (!renameFile || renameBusy) return
    const trimmed = renameValue.trim()
    if (!trimmed) return
    if (trimmed === renameFile.name) {
      setRenameFile(null)
      return
    }
    setRenameBusy(true)
    setRenameError('')
    try {
      const result = await window.electronAPI.fmRenameFile(renameFile.path, trimmed)
      if (!result.success) {
        setRenameError(result.error || t('Rename failed'))
        return
      }
      setRenameFile(null)
      void loadDir(currentPath)
    } catch (e) {
      setRenameError(errorMessage(e))
    } finally {
      setRenameBusy(false)
    }
  }

  // ── Render ─────────────────────────────────────
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        border: '1px solid rgba(var(--date), 0.2)',
        borderRadius: 2,
      }}
    >
      {/* Tab bar — always visible so empty panes can get their first tab */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          background: isActive ? 'rgba(var(--fg), 0.06)' : 'transparent',
          borderBottom: '1px solid rgba(var(--date), 0.12)',
          flexShrink: 0,
          padding: '0 2px',
          fontSize: fs(10),
          minHeight: 20,
        }}
        onClick={onActivate}
      >
        {tabs.length > 0 &&
          tabs.map((tab, ti) => {
            const name = tab
              ? tab.replace(/\\/g, '/').split('/').filter(Boolean).pop() || tab
              : 'New'
            const active = ti === activeTabIdx
            return (
              <span key={ti} style={{ display: 'flex', alignItems: 'center' }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onActivate?.()
                    onSetActiveTab?.(ti)
                  }}
                  style={{
                    fontSize: fs(9),
                    padding: '1px 6px',
                    borderRadius: '2px 2px 0 0',
                    background: active ? 'rgba(var(--fg), 0.12)' : 'transparent',
                    color: active ? 'rgb(var(--fg))' : 'rgba(var(--fg), 0.5)',
                    maxWidth: 80,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                  title={tab}
                >
                  {name}
                </button>
                {tabs.length > 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onActivate?.()
                      onRemoveTab?.(ti)
                    }}
                    style={{
                      fontSize: fs(8),
                      padding: '0 2px',
                      opacity: 0.4,
                      border: 'none',
                      background: 'none',
                      color: 'inherit',
                      cursor: 'pointer',
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
            )
          })}
        <button
          onClick={(e) => {
            e.stopPropagation()
            onActivate?.()
            onAddTab?.(currentPath || 'C:\\')
          }}
          style={{
            fontSize: fs(10),
            padding: '0 4px',
            opacity: tabs.length === 0 ? 0.6 : 0.4,
            border: 'none',
            background: 'none',
            color: 'inherit',
            cursor: 'pointer',
            marginLeft: 'auto',
          }}
          title={t(tabs.length === 0 ? 'Add first tab' : 'New Tab')}
        >
          +
        </button>
      </div>

      {/* Path bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '2px 4px',
          borderBottom: '1px solid rgba(var(--date), 0.15)',
          flexShrink: 0,
          background: isActive ? 'rgba(var(--fg), 0.04)' : 'transparent',
        }}
        onClick={onActivate}
      >
        <button onClick={goUp} title={t('Up')} style={{ fontSize: fs(11), padding: '1px 4px' }}>
          ↑
        </button>
        <button
          onClick={() => loadDir(currentPath)}
          title={t('Refresh')}
          style={{ fontSize: fs(11), padding: '1px 4px' }}
        >
          ↻
        </button>
        <button
          onClick={handleBrowse}
          title={t('Browse')}
          style={{ fontSize: fs(11), padding: '1px 4px' }}
        >
          …
        </button>
        {editingPath ? (
          <input
            autoFocus
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitPath()
              if (e.key === 'Escape') setEditingPath(false)
            }}
            onBlur={commitPath}
            style={{ flex: 1, fontSize: fs(10), padding: '1px 4px', height: 18 }}
          />
        ) : (
          <span
            onClick={startEditPath}
            title={t('Click to edit path')}
            style={{
              flex: 1,
              fontSize: fs(10),
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              opacity: 0.7,
              paddingLeft: 4,
              cursor: 'text',
            }}
          >
            {currentPath || '—'}
          </span>
        )}
        <span style={{ fontSize: fs(9), opacity: 0.4, whiteSpace: 'nowrap' }}>
          {total > 0 ? `${files.length.toLocaleString()}/${total.toLocaleString()}` : files.length}{' '}
          {t('items')}
          {selectedPaths.size > 0 ? ` · ${selectedPaths.size} ${t('selected')}` : ''}
        </span>
      </div>

      {/* Logical file total and, at volume roots, filesystem capacity use different accounting. */}
      <div
        data-testid="fm-size-summary"
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          columnGap: 10,
          rowGap: 1,
          padding: '1px 5px',
          minHeight: 18,
          borderBottom: '1px solid rgba(var(--date), 0.12)',
          background: 'rgba(var(--fg), 0.025)',
          flexShrink: 0,
          fontSize: fs(9),
        }}
      >
        <span
          data-testid="fm-current-total-size"
          data-total-size-source="logical"
          data-total-size-complete={currentSizeSummary.complete ? 'true' : 'false'}
          data-total-size-bytes={currentSizeSummary.bytes}
          title={currentTotalSizeTitle}
          aria-label={currentTotalSizeTitle}
          style={{ opacity: 0.92, whiteSpace: 'nowrap', fontWeight: 600 }}
        >
          {t('Calculated total {size}', { size: currentTotalSize })}
        </span>
        {currentSizeSummary.folderCount > 0 && !currentSizeSummary.complete && (
          <span
            data-testid="fm-size-progress"
            data-size-progress-processed={currentSizeSummary.processedFolderCount}
            data-size-progress-total={currentSizeSummary.folderCount}
            style={{ opacity: 0.68, whiteSpace: 'nowrap' }}
          >
            {t('Size progress {processed}/{total}', {
              processed: currentSizeSummary.processedFolderCount.toLocaleString(),
              total: currentSizeSummary.folderCount.toLocaleString(),
            })}
          </span>
        )}
        {volumeSpace && (
          <span
            data-testid="fm-volume-space"
            data-volume-used-bytes={volumeSpace.usedBytes}
            data-volume-total-bytes={volumeSpace.totalBytes}
            title={volumeSpaceTitle}
            aria-label={volumeSpaceTitle}
            style={{ opacity: 0.76, whiteSpace: 'nowrap', marginLeft: 'auto' }}
          >
            {t('Disk used {used} / {total} · Free {free}', {
              used: formatSize(volumeSpace.usedBytes),
              total: formatSize(volumeSpace.totalBytes),
              free: formatSize(volumeSpace.availableBytes),
            })}
          </span>
        )}
      </div>

      {/* View toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '1px 4px',
          borderBottom: '1px solid rgba(var(--date), 0.12)',
          flexShrink: 0,
          fontSize: fs(10),
        }}
      >
        <span style={{ opacity: 0.4, marginRight: 2 }}>{t('View')}:</span>
        {(Object.keys(VIEW_MODE_LABELS) as ViewMode[]).map((k) => (
          <button
            key={k}
            onClick={() => onViewModeChange(k)}
            title={k}
            style={{
              fontSize: fs(9),
              padding: '1px 4px',
              background: viewMode === k ? 'rgba(var(--fg), 0.2)' : 'transparent',
              border: 'none',
              borderRadius: 2,
              cursor: 'pointer',
              color: 'inherit',
            }}
          >
            {t(VIEW_MODE_LABELS[k])}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ opacity: 0.4, marginRight: 2 }}>{t('Group')}:</span>
        <select
          value={groupMode}
          onChange={(e) => onGroupModeChange(e.target.value as GroupMode)}
          style={{
            fontSize: fs(9),
            padding: '1px 2px',
            background: 'rgba(var(--bg), 0.8)',
            color: 'rgb(var(--fg))',
            border: '0.5px solid rgba(var(--date), 0.45)',
            borderRadius: 2,
            maxWidth: 100,
          }}
        >
          {(Object.keys(GROUP_MODE_LABELS) as GroupMode[]).map((k) => (
            <option key={k} value={k}>
              {t(GROUP_MODE_LABELS[k])}
            </option>
          ))}
        </select>
      </div>

      {/* Column headers (list/details views only) */}
      {!isIconView && (
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid rgba(var(--date), 0.12)',
            fontSize: fs(10),
            opacity: 0.6,
            padding: '2px 0',
            flexShrink: 0,
          }}
        >
          <span
            style={{ flex: 2, padding: '0 4px', cursor: 'pointer' }}
            onClick={() => headerClick('name')}
          >
            {t('Name')}
            {sortArrow('name')}
          </span>
          <span
            style={{ width: 60, textAlign: 'center', cursor: 'pointer' }}
            onClick={() => headerClick('type')}
          >
            {t('Type')}
            {sortArrow('type')}
          </span>
          <span
            style={{ width: 70, textAlign: 'right', cursor: 'pointer' }}
            onClick={() => headerClick('size')}
          >
            {t('Size')}
            {sortArrow('size')}
          </span>
          <span
            style={{ width: 110, textAlign: 'right', cursor: 'pointer', paddingRight: 4 }}
            onClick={() => headerClick('mtime')}
          >
            {t('Modified')}
            {sortArrow('mtime')}
          </span>
        </div>
      )}

      {/* File list / groups */}
      <div
        ref={scrollRef}
        onClick={onActivate}
        onContextMenu={(e) => handleContext(e, null)}
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          fontSize: fs(11),
          contain: 'layout style',
          contentVisibility: 'auto',
          containIntrinsicSize: 'auto 300px',
        }}
      >
        {loading && <div style={{ padding: 8, opacity: 0.4 }}>{t('Loading')}...</div>}
        {error && <div style={{ padding: 8, color: 'rgb(255, 100, 100)' }}>{error}</div>}
        {!loading && !error && flatFileList.length === 0 && (
          <div style={{ padding: 8, opacity: 0.3, textAlign: 'center' }}>
            {t('Empty directory')}
          </div>
        )}

        {!loading && !error && hasMore && (
          <div
            style={{
              padding: '4px 8px',
              fontSize: fs(10),
              background: 'rgba(100, 200, 255, 0.1)',
              borderBottom: '1px solid rgba(100, 200, 255, 0.2)',
              textAlign: 'center',
            }}
          >
            {loadingMore
              ? t('Loading more...')
              : t('Scroll for more ({loaded} of {total} loaded)', {
                  loaded: files.length.toLocaleString(),
                  total: total.toLocaleString(),
                })}
          </div>
        )}

        {!loading &&
          !error &&
          groups.map((group) => {
            const groupKey = `${paneIndex}-${currentPath}-${group.key}`
            const isExpanded = groupMode === 'none' || fmGroupExpanded[groupKey] !== false
            return (
              <div key={groupKey}>
                {/* Group header */}
                {groupMode !== 'none' && (
                  <GroupHeader
                    groupKey={groupKey}
                    label={t(group.label)}
                    count={group.count}
                    defaultExpanded={true}
                  />
                )}

                {/* Group files (hidden if collapsed) */}
                {isExpanded &&
                  (isIconView ? (
                    /* ── Icon / Thumbnail Grid views ── */
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 4,
                        padding: 4,
                        alignContent: 'flex-start',
                      }}
                    >
                      {group.files.map((f) => {
                        const sel = selectedPaths.has(f.path)
                        const thumbSize = thumbnailSizeForView(viewMode)
                        return (
                          <div
                            key={f.path}
                            onClick={(e) => handleClick(e, f)}
                            onDoubleClick={() => handleDoubleClick(f)}
                            onContextMenu={(e) => handleContext(e, f)}
                            draggable
                            onDragStart={(e) => handleDragStart(e, f)}
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              width: thumbSize + 20,
                              padding: 4,
                              cursor: 'default',
                              userSelect: 'none',
                              background: sel ? 'rgba(var(--fg), 0.15)' : 'transparent',
                              borderRadius: 4,
                              overflow: 'hidden',
                            }}
                          >
                            <ThumbnailImage
                              filePath={f.path}
                              ext={f.type}
                              isDirectory={f.isDirectory}
                              viewMode={viewMode}
                              folderThumbs={f.isDirectory ? folderThumbs.get(f.path) : undefined}
                            />
                            <span
                              style={{
                                fontSize: fs(9),
                                textAlign: 'center',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                maxWidth: thumbSize + 16,
                                marginTop: 2,
                                lineHeight: 1.3,
                                wordBreak: 'break-all',
                              }}
                            >
                              {f.name}
                            </span>
                            {f.isDirectory ? (
                              <FolderSizeCell
                                folderPath={f.path}
                                state={folderSizeStates.get(f.path)}
                                observe={observeFolderSizeCell}
                                {...folderSizeLabels}
                                style={{
                                  fontSize: fs(8),
                                  lineHeight: 1.2,
                                  opacity: 0.5,
                                  maxWidth: thumbSize + 16,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              />
                            ) : (
                              <span style={{ fontSize: fs(8), lineHeight: 1.2, opacity: 0.5 }}>
                                {formatSize(f.size)}
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    /* ── List / Details view ── */
                    group.files.map((f) => {
                      const sel = selectedPaths.has(f.path)
                      return (
                        <div
                          key={f.path}
                          onClick={(e) => handleClick(e, f)}
                          onDoubleClick={() => handleDoubleClick(f)}
                          onContextMenu={(e) => handleContext(e, f)}
                          draggable
                          onDragStart={(e) => handleDragStart(e, f)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            cursor: 'default',
                            padding: '1px 0',
                            background: sel ? 'rgba(var(--fg), 0.15)' : 'transparent',
                            userSelect: 'none',
                          }}
                        >
                          <span
                            style={{
                              flex: 2,
                              padding: '0 4px',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            <ThumbnailImage
                              filePath={f.path}
                              ext={f.type}
                              isDirectory={f.isDirectory}
                              viewMode="list"
                              folderThumbs={f.isDirectory ? folderThumbs.get(f.path) : undefined}
                              style={{ width: 18, height: 18, fontSize: fs(14) }}
                            />
                            {f.name}
                          </span>
                          <span
                            style={{
                              width: 60,
                              textAlign: 'center',
                              opacity: 0.6,
                              fontSize: fs(9),
                            }}
                          >
                            {f.type === '文件夹' ? '' : t(f.type)}
                          </span>
                          <span
                            style={{
                              width: 70,
                              textAlign: 'right',
                              opacity: 0.5,
                              fontSize: fs(9),
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {f.isDirectory ? (
                              <FolderSizeCell
                                folderPath={f.path}
                                state={folderSizeStates.get(f.path)}
                                observe={observeFolderSizeCell}
                                {...folderSizeLabels}
                              />
                            ) : (
                              formatSize(f.size)
                            )}
                          </span>
                          <span
                            style={{
                              width: 110,
                              textAlign: 'right',
                              opacity: 0.5,
                              fontSize: fs(9),
                              paddingRight: 4,
                            }}
                          >
                            {formatTime(f.mtime)}
                          </span>
                        </div>
                      )
                    })
                  ))}
              </div>
            )
          })}
        {/* Sentinel for auto-loading next page */}
        <div ref={sentinelRef} style={{ height: 1 }} />
      </div>

      {/* Context menu (portal to body to avoid panel overflow clip) */}
      {ctxMenu &&
        createPortal(
          <div style={{ pointerEvents: 'auto' }} data-portal="">
            <FileContextMenu
              x={ctxMenu.x}
              y={ctxMenu.y}
              file={ctxMenu.file}
              currentDir={currentPath}
              selectedPaths={[...selectedPaths]}
              onClose={() => setCtxMenu(null)}
              onRefresh={() => loadDir(currentPath)}
              onNavigate={onNavigate}
            />
          </div>,
          document.body,
        )}

      {/* Rename dialog (F2 or context menu) */}
      {renameFile &&
        createPortal(
          <>
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 1001 }}
              onClick={() => {
                if (!renameBusy) setRenameFile(null)
              }}
            />
            <div
              style={{
                position: 'fixed',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                zIndex: 1002,
                background: 'rgba(var(--bg), 0.97)',
                border: '1px solid rgba(var(--date), 0.5)',
                borderRadius: 6,
                padding: 16,
                minWidth: 360,
              }}
            >
              <div style={{ marginBottom: 8, fontSize: 13 }}>{t('Rename')}</div>
              <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 8, wordBreak: 'break-all' }}>
                {renameFile.path}
              </div>
              <input
                autoFocus
                value={renameValue}
                disabled={renameBusy}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitRename()
                  if (e.key === 'Escape' && !renameBusy) setRenameFile(null)
                }}
                style={{ width: '100%', marginBottom: 10 }}
              />
              {renameError && (
                <div role="alert">
                  {t('Rename failed')}: {renameError}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button disabled={renameBusy} onClick={() => void submitRename()}>
                  {t('OK')}
                </button>
                <button disabled={renameBusy} onClick={() => setRenameFile(null)}>
                  {t('Cancel')}
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  )
}

export default React.memo(FilePane)
