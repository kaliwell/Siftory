import React, { useState, useEffect, useRef, useMemo } from 'react'
import { isProjectFile } from '../../../shared/projectFileTypes'
import { bucketThumbnailDimension } from '../../../shared/thumbnailPolicy'
import { BoundedBatchScheduler } from '../../utils/boundedBatchScheduler'
import { RendererDataUrlLru } from '../../utils/rendererDataUrlCache'
import { getFileIcon } from './FileIcon'

// ── LRU thumbnail cache ────────────────────────────────────

const MAX_CACHE_SIZE = 500
const MAX_CACHE_BYTES = 128 * 1024 * 1024
const cache = new RendererDataUrlLru(MAX_CACHE_SIZE, MAX_CACHE_BYTES)
const visibilityCallbacks = new Map<Element, () => void>()
let visibilityObserver: IntersectionObserver | null = null
const documentVisibilitySubscribers = new Set<(visible: boolean) => void>()
let documentVisibilityListening = false

function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || !document.hidden
}

function handleDocumentVisibilityChange(): void {
  const visible = isDocumentVisible()
  for (const subscriber of documentVisibilitySubscribers) subscriber(visible)
}

function subscribeDocumentVisibility(subscriber: (visible: boolean) => void): () => void {
  documentVisibilitySubscribers.add(subscriber)
  if (!documentVisibilityListening && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleDocumentVisibilityChange)
    documentVisibilityListening = true
  }
  return () => {
    documentVisibilitySubscribers.delete(subscriber)
    if (
      documentVisibilityListening &&
      documentVisibilitySubscribers.size === 0 &&
      typeof document !== 'undefined'
    ) {
      document.removeEventListener('visibilitychange', handleDocumentVisibilityChange)
      documentVisibilityListening = false
    }
  }
}

function observeNearViewport(element: Element, onVisible: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onVisible()
    return () => {}
  }
  if (!visibilityObserver) {
    visibilityObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          visibilityObserver?.unobserve(entry.target)
          const callback = visibilityCallbacks.get(entry.target)
          visibilityCallbacks.delete(entry.target)
          callback?.()
        }
      },
      { rootMargin: '120px' },
    )
  }
  visibilityCallbacks.set(element, onVisible)
  visibilityObserver.observe(element)
  return () => {
    visibilityObserver?.unobserve(element)
    visibilityCallbacks.delete(element)
  }
}

function cacheSet(key: string, value: string) {
  cache.set(key, value)
}

function cacheGet(key: string): string | undefined {
  return cache.get(key)
}

export function getThumbnailMemoryCacheStats() {
  return cache.stats()
}

export function clearThumbnailCache() {
  cache.clear()
  pendingBatch.clear()
  thumbnailScheduler.clearQueued()
  projectThumbnailScheduler.clearQueued()
}

// ── Batch icon loader ──────────────────────────────────────

type PendingRequest = {
  path: string
  size: 'small' | 'normal' | 'large'
  resolve: (dataUrl: string | null) => void
}

const pendingBatch = new Map<string, PendingRequest>()
let batchTimer: ReturnType<typeof setTimeout> | null = null
const ICON_BATCH_SIZE = 32

// ── Batch thumbnail loader (for image files) ──────────────

type ThumbnailRequest = {
  key: string
  path: string
  maxDim: number
}

const THUMB_BATCH_SIZE = 6
const THUMB_BATCH_MS = 24
const PROJECT_THUMBNAIL_RETRY_DELAYS_MS = [250, 750, 1500] as const
// Deep enough to absorb bursts from non-virtualized grids (NekoSearch
// Clusters renders ~200 cards × 4 thumbnails at once); evicted requests
// resolve null and must not become permanent system icons.
const THUMB_MAX_QUEUED = 512

const thumbnailScheduler = new BoundedBatchScheduler<ThumbnailRequest, string>({
  batchSize: THUMB_BATCH_SIZE,
  delayMs: THUMB_BATCH_MS,
  maxQueued: THUMB_MAX_QUEUED,
  keyOf: (request) => request.key,
  loadBatch: async (requests) => {
    const results = await window.electronAPI.fmGetThumbnailsBatch(
      requests.map(({ path, maxDim }) => ({ path, maxDim })),
    )
    const output = new Map<string, string>()
    for (let index = 0; index < requests.length; index += 1) {
      const dataUrl = results[index]?.dataUrl
      if (dataUrl) output.set(requests[index].key, dataUrl)
    }
    return output
  },
})

// Project formats use a separate, tightly bounded lane. SVG and PDF-compatible
// AI previews are generated from the project-preview manifest, so they should
// not be held behind a burst of ordinary bitmap thumbnail work.
const projectThumbnailScheduler = new BoundedBatchScheduler<ThumbnailRequest, string>({
  batchSize: 4,
  delayMs: 12,
  maxQueued: 128,
  keyOf: (request) => request.key,
  loadBatch: async (requests) => {
    const results = await Promise.allSettled(
      requests.map(({ path, maxDim }) => window.electronAPI.fmGetThumbnail(path, maxDim)),
    )
    const output = new Map<string, string>()
    for (let index = 0; index < requests.length; index += 1) {
      const result = results[index]
      const dataUrl = result?.status === 'fulfilled' ? result.value.dataUrl : null
      if (dataUrl) output.set(requests[index].key, dataUrl)
    }
    return output
  },
})

function batchLoadThumbnail(
  path: string,
  maxDim: number,
  signal: AbortSignal,
  priority: number,
): Promise<string | null> {
  return thumbnailScheduler.request(
    { key: `${path}@${maxDim}`, path, maxDim },
    { priority, signal },
  )
}

function loadProjectThumbnail(
  path: string,
  maxDim: number,
  signal: AbortSignal,
  priority: number,
): Promise<string | null> {
  return projectThumbnailScheduler.request(
    { key: `${path}@${maxDim}`, path, maxDim },
    { priority, signal },
  )
}

function flushBatch() {
  batchTimer = null
  const requests = [...pendingBatch.values()].slice(0, ICON_BATCH_SIZE)
  for (const request of requests) pendingBatch.delete(request.path)
  if (requests.length === 0) return

  const items = requests.map((r) => ({ path: r.path, size: r.size }))
  window.electronAPI
    .fmGetFileIcons(items)
    .then((results) => {
      for (const result of results) {
        const pending = requests.find((r) => r.path === result.path)
        if (pending) pending.resolve(result.dataUrl)
      }
      // Any not returned? Resolve with null
      for (const req of requests) {
        if (!results.some((r) => r.path === req.path)) {
          req.resolve(null)
        }
      }
    })
    .catch(() => {
      for (const req of requests) req.resolve(null)
    })
    .finally(() => {
      if (pendingBatch.size > 0 && !batchTimer) {
        batchTimer = setTimeout(flushBatch, 16)
      }
    })
}

function batchLoadIcon(path: string, size: 'small' | 'normal' | 'large'): Promise<string | null> {
  return new Promise((resolve) => {
    // Dedup: if already queued in this batch, chain resolves so both callers are notified
    const existing = pendingBatch.get(path)
    if (existing) {
      const prev = existing.resolve
      existing.resolve = (dataUrl) => {
        prev(dataUrl)
        resolve(dataUrl)
      }
      return
    }
    pendingBatch.set(path, { path, size, resolve })
    if (!batchTimer) {
      batchTimer = setTimeout(flushBatch, 0)
    }
  })
}

/** Preload icons — skips image files (they need custom thumbnails, not system icons) */
export function preloadFileIcons(
  files: { path: string; isDirectory: boolean }[],
  viewMode: string,
): void {
  const iconSize = iconSizeForView(viewMode)
  // Only preload non-image files — image files need custom thumbnail generation
  const items = files
    .filter((f) => !f.isDirectory)
    .filter((f) => {
      const ext = f.path.split('.').pop()?.toLowerCase() || ''
      return !isImageFile('.' + ext)
    })
    .map((f) => ({ path: f.path, size: iconSize }))

  if (items.length === 0) return

  const thumbDim = bucketThumbnailDimension(thumbnailSizeForView(viewMode))
  for (let i = 0; i < items.length; i += ICON_BATCH_SIZE) {
    const chunk = items.slice(i, i + ICON_BATCH_SIZE)
    window.electronAPI
      .fmGetFileIcons(chunk)
      .then((results) => {
        for (const r of results) {
          if (r.dataUrl) {
            cacheSet(`${r.path}@${thumbDim}`, r.dataUrl)
          }
        }
      })
      .catch(() => {})
  }
}

const IMAGE_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.svg',
  '.avif',
  '.ico',
  '.tiff',
  '.tif',
  '.psd',
  '.psb',
  '.kra',
  '.pdf',
  '.ai',
  '.eps',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.dng',
  '.raf',
  '.orf',
  '.rw2',
  '.pef',
  '.srw',
  '.clip',
  '.cdr',
  '.indd',
])

export function isImageFile(ext: string): boolean {
  return IMAGE_EXTS.has(ext.toLowerCase())
}

// ── Determine thumbnail size based on view mode ────────────

export function thumbnailSizeForView(mode: string): number {
  switch (mode) {
    case 'xlarge-icon':
      return 192
    case 'large-icon':
      return 128
    case 'medium-icon':
      return 80
    case 'small-icon':
      return 48
    case 'thumbnail-grid':
      return 160
    default:
      return 24
  }
}

function iconSizeForView(mode: string): 'small' | 'normal' | 'large' {
  switch (mode) {
    case 'small-icon':
      return 'normal'
    case 'medium-icon':
      return 'large'
    case 'list':
    case 'details':
      return 'normal'
    case 'xlarge-icon':
    case 'large-icon':
    case 'thumbnail-grid':
      return 'large'
    default:
      return 'normal'
  }
}

interface ThumbnailImageProps {
  deferLoading?: boolean
  filePath: string
  ext: string
  isDirectory: boolean
  viewMode: string
  folderThumbs?: string[]
  loadPriority?: number
  style?: React.CSSProperties
  /** Extra style for the inner <img> (e.g. force it to fill the container). */
  imgStyle?: React.CSSProperties
  /** The caller already virtualizes its children, so every rendered item is close enough to load. */
  loadWhenRendered?: boolean
  targetSize?: number
}

/**
 * File icon/thumbnail loader.
 * - Non-directory files: loads system file icon via fmGetFileIcon (shows OS-associated icon + thumbnails)
 * - Image files: tries custom thumbnail generation as fallback if system icon fails
 * - Folders: loads folder thumbnail preview
 * - Loading is lazy by default; virtualized callers may load their bounded rendered window directly
 */
const ThumbnailImage: React.FC<ThumbnailImageProps> = ({
  deferLoading = false,
  filePath,
  ext,
  isDirectory,
  viewMode,
  folderThumbs,
  loadPriority = 0,
  style,
  imgStyle,
  loadWhenRendered = false,
  targetSize,
}) => {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [retryVersion, setRetryVersion] = useState(0)
  const activeRequestKey = useRef<string | null>(null)
  const projectRetryState = useRef({ key: '', attempt: 0 })
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)
  const [documentVisible, setDocumentVisible] = useState(isDocumentVisible)
  const thumbDim = bucketThumbnailDimension(targetSize ?? thumbnailSizeForView(viewMode))
  const requestKey = isDirectory ? `folder:${filePath}` : `file:${filePath}@${thumbDim}`
  const imageFile = isImageFile(ext)
  const projectFile = isProjectFile(filePath)

  useEffect(() => {
    if (loadWhenRendered) return
    const el = rootRef.current
    if (!el) return
    return observeNearViewport(el, () => setVisible(true))
  }, [loadWhenRendered])

  useEffect(() => subscribeDocumentVisibility(setDocumentVisible), [])

  // A virtualized card can be reused for another result. Never leave the old
  // preview or terminal error attached to the new source path.
  useEffect(() => {
    setDataUrl(null)
    setError(false)
    projectRetryState.current = { key: requestKey, attempt: 0 }
  }, [requestKey])

  // Load only when near the visible viewport.
  useEffect(() => {
    if ((!loadWhenRendered && !visible) || deferLoading || !documentVisible) return
    if (activeRequestKey.current === requestKey) return
    activeRequestKey.current = requestKey
    const controller = new AbortController()
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const release = () => {
      cancelled = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      if (activeRequestKey.current === requestKey) activeRequestKey.current = null
      controller.abort()
    }
    const scheduleProjectRetry = () => {
      if (!projectFile || cancelled) return
      if (projectRetryState.current.key !== requestKey) {
        projectRetryState.current = { key: requestKey, attempt: 0 }
      }
      const attempt = projectRetryState.current.attempt
      const delayMs = PROJECT_THUMBNAIL_RETRY_DELAYS_MS[attempt]
      if (delayMs === undefined) return
      projectRetryState.current.attempt += 1
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (cancelled) return
        if (activeRequestKey.current === requestKey) activeRequestKey.current = null
        setRetryVersion((version) => version + 1)
      }, delayMs)
    }
    setError(false)

    if (isDirectory) {
      if (folderThumbs && folderThumbs.length > 0) {
        setDataUrl(folderThumbs[0])
        return release
      }
      window.electronAPI
        .fmGetFolderThumbnails(filePath, 4)
        .then((results) => {
          if (cancelled) return
          const valid = results.filter((r) => r.dataUrl).map((r) => r.dataUrl!)
          if (valid.length > 0) setDataUrl(valid[0])
          else setError(true)
        })
        .catch(() => {
          if (!cancelled) setError(true)
        })
      return release
    }

    const cacheKey = `${filePath}@${thumbDim}`
    const cached = cacheGet(cacheKey)
    if (cached) {
      projectRetryState.current = { key: requestKey, attempt: 0 }
      setDataUrl(cached)
      return release
    }

    const iconSize = iconSizeForView(viewMode)
    const trySystemIcon = () => batchLoadIcon(filePath, iconSize)

    // Smart degradation: for tiny thumbnails (list/detail ≤32px), skip expensive decode
    const skipThumbnail = thumbDim <= 32
    const tryThumbnail = skipThumbnail
      ? () => Promise.resolve(null as string | null)
      : projectFile
        ? () => loadProjectThumbnail(filePath, thumbDim, controller.signal, loadPriority)
        : () => batchLoadThumbnail(filePath, thumbDim, controller.signal, loadPriority)

    const primary = imageFile ? tryThumbnail : trySystemIcon
    const secondary = imageFile ? trySystemIcon : tryThumbnail

    void (async () => {
      try {
        let url = await primary()
        const fromPrimary = Boolean(url)
        if (fromPrimary) projectRetryState.current = { key: requestKey, attempt: 0 }
        if (!url && !cancelled) url = await secondary()
        if (cancelled) return
        if (url) {
          // Only cache real thumbnails for image files: a transient scheduler
          // eviction (or one-off decode failure) falls back to the system
          // icon, and caching that icon would pin it as the file's thumbnail
          // for the rest of the session.
          if (fromPrimary || !imageFile) cacheSet(cacheKey, url)
          setError(false)
          setDataUrl(url)
        } else {
          setError(true)
        }
        if (!fromPrimary) scheduleProjectRetry()
      } catch {
        if (!cancelled) {
          setError(true)
          scheduleProjectRetry()
        }
      }
    })()
    return release
  }, [
    deferLoading,
    documentVisible,
    ext,
    filePath,
    folderThumbs,
    imageFile,
    isDirectory,
    loadPriority,
    loadWhenRendered,
    projectFile,
    requestKey,
    retryVersion,
    targetSize,
    thumbDim,
    viewMode,
    visible,
  ])

  const size = thumbnailSizeForView(viewMode)
  const fallbackIcon = useMemo(() => getFileIcon(ext, isDirectory), [ext, isDirectory])

  return (
    <div
      ref={rootRef}
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        flexShrink: 0,
        borderRadius: 2,
        background:
          dataUrl && !error
            ? isImageFile(ext)
              ? 'transparent'
              : 'rgba(255,255,255,0.12)'
            : 'transparent',
        ...(dataUrl && !error && !isImageFile(ext)
          ? { boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)' }
          : {}),
        ...style,
      }}
    >
      {dataUrl && !error ? (
        <img
          src={dataUrl}
          alt=""
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', ...imgStyle }}
          onError={() => setError(true)}
        />
      ) : (
        <span
          style={{
            fontSize: size * (isDirectory ? 0.6 : 0.55),
            lineHeight: 1,
            opacity: error ? 1 : 0.5,
          }}
        >
          {fallbackIcon}
        </span>
      )}
    </div>
  )
}

export default React.memo(ThumbnailImage)
