import { secureIpcMain } from './ipcAuthorization'
import { app, nativeImage, shell } from 'electron'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { bucketThumbnailDimension, classifyThumbnailSource } from '../shared/thumbnailPolicy'
import type { ThumbnailRebuildBackend, ThumbnailRebuildProgress } from '../shared/ipc-contract'
import { MAX_THUMBNAIL_BATCH, safeShellPath } from './pathGuards'
import { ThumbnailGpuPool } from './thumbnailGpuService'
import { BoundedAsyncQueue, BoundedLruCache } from './boundedAsyncQueue'
import { ThumbnailCacheWriter } from './thumbnailCacheWriter'
import {
  getNativeThumbnailRebuildProgress,
  startNativeThumbnailRebuild,
  stopNativeThumbnailRebuild,
} from './imageSearchService'
import { getProjectPreviewService } from './projectPreviewService'
import {
  cacheKey,
  evictThumbCache,
  getThumbCacheDir,
  storeThumbnailCache,
  thumbCacheGet,
  thumbCacheSet,
  type ThumbnailCacheSink,
} from './thumbnailDiskCache'
import { extractPsdThumbnailPreview } from './psdThumbnailPreview'
import { submitUnifiedTask, type UnifiedTaskSubmitter } from './unifiedTaskSubmission'

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

const PROJECT_PREVIEW_EXTS = new Set([
  '.psd',
  '.psb',
  '.kra',
  '.svg',
  '.pdf',
  '.ai',
  '.eps',
  '.tif',
  '.tiff',
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

const THUMB_MAX = 256
const THUMB_MIN_DIM = 32
const MAX_FOLDER_THUMBNAILS = 32
const THUMBNAIL_DECODE_CONCURRENCY = 3
const DEFAULT_THUMBNAIL_GPU_JOBS = 4
const MAX_THUMBNAIL_GPU_JOBS = 20
const DEFAULT_THUMBNAIL_BATCH_SIZE = 2
const MAX_THUMBNAIL_BATCH_SIZE = 20
const MAX_THUMBNAIL_IN_FLIGHT = 40
const AUTO_GPU_MAX_FILE_BYTES = 2 * 1024 * 1024
const THUMBNAIL_CACHE_WRITE_CONCURRENCY = 2
const THUMBNAIL_CACHE_WRITE_CAPACITY = 32
const AUTO_THIRD_CPU_LANE_MIN_FREE_BYTES = 1536 * 1024 * 1024

function clampThumbDim(input: unknown, fallback: number): number {
  const value = Number(input)
  const bounded = Number.isFinite(value)
    ? Math.max(THUMB_MIN_DIM, Math.min(THUMB_MAX, Math.floor(value)))
    : fallback
  return bucketThumbnailDimension(bounded)
}

function clampEvenThumbnailSetting(input: unknown, fallback: number, maximum: number): number {
  const parsed = Math.floor(Number(input))
  const value = Number.isFinite(parsed) && parsed >= 2 ? parsed : fallback
  return Math.max(2, Math.min(maximum, Math.floor(value / 2) * 2))
}

function clampThumbnailGpuJobs(input: unknown): number {
  const parsed = Math.floor(Number(input))
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.min(MAX_THUMBNAIL_GPU_JOBS, parsed)
    : DEFAULT_THUMBNAIL_GPU_JOBS
}

/** Validates a renderer-supplied path for thumbnail/icon reads, or returns null. */
function safeThumbnailPath(rawPath: unknown): string | null {
  return safeShellPath(rawPath)
}

interface ThumbnailResult {
  path: string
  dataUrl: string | null
  error?: string
  backend?: 'gpu' | 'cpu'
  gpuFallback?: boolean
}

const GPU_IMAGE_MIME = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'],
])

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function generateSharpThumbnailDataUrl(
  filePath: string,
  dim: number,
  fileBytes: number,
): Promise<{ dataUrl: string | null; terminalError?: string }> {
  try {
    const sharpModule = await import('sharp')
    const sharp = sharpModule.default || sharpModule
    const image = sharp(filePath, {
      animated: false,
      limitInputPixels: 80_000_000,
      sequentialRead: true,
    })
    const metadata = await image.metadata()
    const policy = classifyThumbnailSource({
      fileBytes,
      width: metadata.width,
      height: metadata.height,
    })
    if (!policy.safeToDecode) {
      return { dataUrl: null, terminalError: 'Image dimensions exceed thumbnail safety limit' }
    }
    const buffer = await image
      .rotate()
      .resize(dim, dim, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({
        effort: 2,
        lossless: metadata.hasAlpha === true,
        quality: 80,
      })
      .toBuffer()
    return { dataUrl: `data:image/webp;base64,${buffer.toString('base64')}` }
  } catch {
    return { dataUrl: null }
  }
}

async function generateGpuThumbnailDataUrl(
  gpuPool: ThumbnailGpuPool,
  filePath: string,
  dim: number,
  fileBytes: number,
  mime: string,
): Promise<{ dataUrl: string | null; terminalError?: string; error?: string }> {
  try {
    return gpuPool.withSourceBudget(fileBytes, async () => {
      // Acquire the global byte budget before reading the source so queued GPU
      // lanes do not retain multiple 64 MiB buffers in the main process.
      const sourceBytes = await fsp.readFile(filePath)
      const sharpModule = await import('sharp')
      const sharp = sharpModule.default || sharpModule
      const metadata = await sharp(sourceBytes, {
        animated: false,
        limitInputPixels: 80_000_000,
        sequentialRead: true,
      }).metadata()
      const policy = classifyThumbnailSource({
        fileBytes,
        width: metadata.width,
        height: metadata.height,
      })
      if (!policy.safeToDecode) {
        return { dataUrl: null, terminalError: 'Image dimensions exceed thumbnail safety limit' }
      }
      const orientedWidth = metadata.autoOrient?.width ?? metadata.width ?? 1
      const orientedHeight = metadata.autoOrient?.height ?? metadata.height ?? 1
      const ratio = Math.min(1, dim / orientedWidth, dim / orientedHeight)
      const targetWidth = Math.max(1, Math.round(orientedWidth * ratio))
      const targetHeight = Math.max(1, Math.round(orientedHeight * ratio))
      const result = await gpuPool.renderReserved(sourceBytes, mime, dim, targetWidth, targetHeight)
      return { dataUrl: result.dataUrl }
    })
  } catch (error) {
    return { dataUrl: null, error: errorMessage(error) }
  }
}

async function generateImageThumbnail(
  userDataPath: string,
  filePath: string,
  maxDim: number,
  force = false,
  preferredBackend: ThumbnailRebuildBackend = 'cpu',
  gpuPool?: ThumbnailGpuPool,
  cpuSlotManagedExternally = true,
  deferCpuFallback = false,
  cacheSink?: ThumbnailCacheSink,
): Promise<ThumbnailResult> {
  try {
    const st = await fsp.stat(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const dim = Math.min(maxDim, THUMB_MAX)
    if (!force) {
      const cached = thumbCacheGet(userDataPath, filePath, st.mtimeMs, dim)
      if (cached) return { path: filePath, dataUrl: cached }
    }
    if (PROJECT_PREVIEW_EXTS.has(ext)) {
      const projectPreview = await getProjectPreviewService(userDataPath).getOrCreate(filePath)
      if (projectPreview.status === 'ready' && projectPreview.previewPath) {
        const preview = await generateSharpThumbnailDataUrl(
          projectPreview.previewPath,
          dim,
          (await fsp.stat(projectPreview.previewPath)).size,
        )
        if (preview.dataUrl) {
          await storeThumbnailCache(
            userDataPath,
            filePath,
            st.mtimeMs,
            dim,
            preview.dataUrl,
            cacheSink,
          )
          return { path: filePath, dataUrl: preview.dataUrl, backend: 'cpu' }
        }
      }
      return {
        path: filePath,
        dataUrl: null,
        error: projectPreview.errorCode || 'Project preview is unavailable',
      }
    }
    const sharpPreferred = [
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.webp',
      '.avif',
      '.tiff',
      '.tif',
    ].includes(ext)
    const maxBytes = sharpPreferred ? 300 * 1024 * 1024 : 50 * 1024 * 1024
    if (st.size > maxBytes) {
      return { path: filePath, dataUrl: null, error: 'File too large for thumbnail' }
    }

    const gpuMime = GPU_IMAGE_MIME.get(ext)
    let gpuFallback = false
    const gpuRequested =
      preferredBackend === 'gpu' ||
      (preferredBackend === 'auto' && st.size <= AUTO_GPU_MAX_FILE_BYTES)
    if (gpuRequested && gpuPool && gpuMime) {
      const gpuResult = await generateGpuThumbnailDataUrl(gpuPool, filePath, dim, st.size, gpuMime)
      if (gpuResult.dataUrl) {
        await storeThumbnailCache(
          userDataPath,
          filePath,
          st.mtimeMs,
          dim,
          gpuResult.dataUrl,
          cacheSink,
        )
        return { path: filePath, dataUrl: gpuResult.dataUrl, backend: 'gpu' }
      }
      if (gpuResult.terminalError) {
        return { path: filePath, dataUrl: null, error: gpuResult.terminalError }
      }
      gpuFallback = true
      if (deferCpuFallback) {
        return {
          path: filePath,
          dataUrl: null,
          error: gpuResult.error || 'GPU fallback required',
          gpuFallback: true,
        }
      }
    } else if (preferredBackend === 'gpu') {
      gpuFallback = true
    }

    const generateCpuThumbnail = async (): Promise<ThumbnailResult> => {
      if (sharpPreferred) {
        const sharpResult = await generateSharpThumbnailDataUrl(filePath, dim, st.size)
        if (sharpResult.dataUrl) {
          await storeThumbnailCache(
            userDataPath,
            filePath,
            st.mtimeMs,
            dim,
            sharpResult.dataUrl,
            cacheSink,
          )
          return {
            path: filePath,
            dataUrl: sharpResult.dataUrl,
            backend: 'cpu',
            gpuFallback,
          }
        }
        if (sharpResult.terminalError) {
          return { path: filePath, dataUrl: null, error: sharpResult.terminalError }
        }
      }

      if (ext === '.svg') {
        const buf = await fsp.readFile(filePath)
        const dataUrl = `data:image/svg+xml;base64,${buf.toString('base64')}`
        await storeThumbnailCache(userDataPath, filePath, st.mtimeMs, dim, dataUrl, cacheSink)
        return { path: filePath, dataUrl, backend: 'cpu', gpuFallback }
      }

      let img = nativeImage.createFromBuffer(await fsp.readFile(filePath))
      if (img.isEmpty() && ext === '.psd') {
        const jpeg = await extractPsdThumbnailPreview(filePath)
        if (jpeg) img = nativeImage.createFromBuffer(jpeg)
      }
      if (img.isEmpty()) {
        const sharpResult = await generateSharpThumbnailDataUrl(filePath, dim, st.size)
        if (sharpResult.dataUrl) {
          await storeThumbnailCache(
            userDataPath,
            filePath,
            st.mtimeMs,
            dim,
            sharpResult.dataUrl,
            cacheSink,
          )
          return {
            path: filePath,
            dataUrl: sharpResult.dataUrl,
            backend: 'cpu',
            gpuFallback,
          }
        }
      }
      if (img.isEmpty()) {
        img = nativeImage.createFromPath(filePath)
      }
      if (img.isEmpty()) {
        return { path: filePath, dataUrl: null, error: 'Cannot decode' }
      }

      const size = img.getSize()
      if (size.width > dim || size.height > dim) {
        const ratio = Math.min(dim / size.width, dim / size.height)
        img = img.resize({
          width: Math.max(1, Math.round(size.width * ratio)),
          height: Math.max(1, Math.round(size.height * ratio)),
          quality: 'good',
        })
      }

      const dataUrl = img.toDataURL()
      await storeThumbnailCache(userDataPath, filePath, st.mtimeMs, dim, dataUrl, cacheSink)
      return { path: filePath, dataUrl, backend: 'cpu', gpuFallback }
    }

    return cpuSlotManagedExternally
      ? generateCpuThumbnail()
      : withThumbnailDecodeSlot(generateCpuThumbnail)
  } catch (e: unknown) {
    return { path: filePath, dataUrl: null, error: errorMessage(e) }
  }
}

let activeThumbnailDecodes = 0
const thumbnailDecodeWaiters: Array<() => void> = []

async function withThumbnailDecodeSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeThumbnailDecodes >= THUMBNAIL_DECODE_CONCURRENCY) {
    await new Promise<void>((resolve) => thumbnailDecodeWaiters.push(resolve))
  }
  activeThumbnailDecodes += 1
  try {
    return await task()
  } finally {
    activeThumbnailDecodes -= 1
    thumbnailDecodeWaiters.shift()?.()
  }
}

const SHORTCUT_CACHE_MAX_ENTRIES = 1024
const SHORTCUT_CACHE_MAX_BYTES = 4 * 1024 * 1024
const shortcutCache = new BoundedLruCache<string, string | null>(
  SHORTCUT_CACHE_MAX_ENTRIES,
  SHORTCUT_CACHE_MAX_BYTES,
)

function cacheShortcutResult(shortcutPath: string, target: string | null): void {
  const retainedBytes =
    Buffer.byteLength(shortcutPath, 'utf8') + (target ? Buffer.byteLength(target, 'utf8') : 0) + 32
  shortcutCache.set(shortcutPath, target, retainedBytes)
}

let thumbnailRebuildStopRequested = false
let nativeThumbnailRebuildActive = false
let thumbnailRebuildProgress: ThumbnailRebuildProgress = {
  state: 'idle',
  total: 0,
  completed: 0,
  skipped: 0,
  failed: 0,
}

function isSameOrNestedThumbnailPath(candidate: string, root: string): boolean {
  const normalizedCandidate = path.resolve(candidate).toLowerCase()
  const normalizedRoot = path.resolve(root).toLowerCase()
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(normalizedRoot + path.sep)
  )
}

async function enumerateThumbnailSources(
  roots: string[],
  output: string[],
  excludedRoot: string,
): Promise<void> {
  const pending = [...roots]
  while (pending.length > 0 && !thumbnailRebuildStopRequested) {
    const current = pending.pop()
    if (!current) continue
    if (isSameOrNestedThumbnailPath(current, excludedRoot)) {
      thumbnailRebuildProgress.skipped += 1
      continue
    }
    let stat: fs.Stats
    try {
      stat = await fsp.stat(current)
    } catch {
      thumbnailRebuildProgress.skipped += 1
      continue
    }
    if (stat.isFile()) {
      if (IMAGE_EXTS.has(path.extname(current).toLowerCase())) output.push(current)
      continue
    }
    if (!stat.isDirectory()) continue
    try {
      const entries = await fsp.readdir(current, { withFileTypes: true })
      for (const entry of entries) {
        const child = path.join(current, entry.name)
        if (isSameOrNestedThumbnailPath(child, excludedRoot)) {
          thumbnailRebuildProgress.skipped += 1
        } else if (entry.isDirectory()) pending.push(child)
        else if (entry.isFile() && IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
          output.push(child)
        }
      }
    } catch {
      thumbnailRebuildProgress.skipped += 1
    }
    thumbnailRebuildProgress.currentPath = current
  }
}

async function runThumbnailRebuild(
  userDataPath: string,
  roots: string[],
  backend: ThumbnailRebuildBackend,
  gpuJobs: number,
  batchSize: number,
): Promise<void> {
  const files: string[] = []
  let gpuPool: ThumbnailGpuPool | undefined
  let cacheWriter: ThumbnailCacheWriter | undefined
  try {
    await enumerateThumbnailSources(roots, files, getThumbCacheDir(userDataPath))
    thumbnailRebuildProgress.total = files.length
    if (thumbnailRebuildStopRequested) {
      thumbnailRebuildProgress.state = 'done'
      thumbnailRebuildProgress.finishedAt = Date.now()
      return
    }
    const requestedGpuJobs =
      backend === 'cpu' || files.length === 0
        ? 0
        : Math.min(gpuJobs, Math.max(1, Math.ceil(files.length / Math.max(1, batchSize))))
    if (requestedGpuJobs > 0) {
      gpuPool = new ThumbnailGpuPool(requestedGpuJobs)
      const capability = await gpuPool.initialize()
      thumbnailRebuildProgress.gpuDevice = capability.device
      thumbnailRebuildProgress.gpuError = capability.available ? undefined : capability.error
      if (!capability.available) {
        thumbnailRebuildProgress.effectiveBackend = 'cpu'
        gpuPool.dispose()
        gpuPool = undefined
      }
    }
    const gpuLaneCount = gpuPool?.size || 0
    const autoCpuLaneCount =
      backend === 'auto' && os.freemem() >= AUTO_THIRD_CPU_LANE_MIN_FREE_BYTES ? 3 : 2
    const cpuLaneCount = gpuPool ? autoCpuLaneCount : THUMBNAIL_DECODE_CONCURRENCY
    thumbnailRebuildProgress.gpuJobs = gpuPool ? gpuJobs : 0
    thumbnailRebuildProgress.gpuLanes = gpuLaneCount
    thumbnailRebuildProgress.cpuLanes = cpuLaneCount
    // Batch is the producer refill size. It is intentionally not rewritten to
    // match the in-flight limit; queue backpressure controls memory separately.
    thumbnailRebuildProgress.batchSize = batchSize
    let activeTasks = 0
    let activeCpuTasks = 0
    const gpuQueue = new BoundedAsyncQueue<string>(MAX_THUMBNAIL_IN_FLIGHT)
    const cpuQueue = new BoundedAsyncQueue<{ filePath: string; gpuFallback: boolean }>(
      MAX_THUMBNAIL_IN_FLIGHT,
    )
    const cacheDir = getThumbCacheDir(userDataPath)
    cacheWriter = new ThumbnailCacheWriter(
      THUMBNAIL_CACHE_WRITE_CONCURRENCY,
      THUMBNAIL_CACHE_WRITE_CAPACITY,
    )
    const updatePipelineProgress = () => {
      thumbnailRebuildProgress.inFlight = activeTasks
      thumbnailRebuildProgress.peakInFlight = Math.max(
        thumbnailRebuildProgress.peakInFlight || 0,
        activeTasks,
      )
      thumbnailRebuildProgress.gpuQueueDepth = gpuQueue.size
      thumbnailRebuildProgress.cpuQueueDepth = cpuQueue.size
      thumbnailRebuildProgress.cacheQueueDepth = cacheWriter?.depth || 0
      thumbnailRebuildProgress.cacheWrites = cacheWriter?.completed || 0
      thumbnailRebuildProgress.cacheWriteFailures = cacheWriter?.failed || 0
    }
    const cacheSink: ThumbnailCacheSink = async (filePath, mtimeMs, maxDim, dataUrl) => {
      const destination = path.join(cacheDir, cacheKey(filePath, mtimeMs, maxDim) + '.thumb')
      await cacheWriter?.enqueue(destination, dataUrl)
      updatePipelineProgress()
    }
    const runTracked = async <T>(task: () => Promise<T>): Promise<T> => {
      activeTasks += 1
      updatePipelineProgress()
      try {
        return await task()
      } finally {
        activeTasks -= 1
        updatePipelineProgress()
      }
    }
    const recordResult = (result: ThumbnailResult) => {
      if (result.dataUrl) {
        thumbnailRebuildProgress.completed += 1
        if (result.backend === 'gpu') {
          thumbnailRebuildProgress.gpuCompleted = (thumbnailRebuildProgress.gpuCompleted || 0) + 1
        } else {
          thumbnailRebuildProgress.cpuCompleted = (thumbnailRebuildProgress.cpuCompleted || 0) + 1
        }
        if (result.gpuFallback) {
          thumbnailRebuildProgress.fallbackCount = (thumbnailRebuildProgress.fallbackCount || 0) + 1
        }
        const gpuCompleted = thumbnailRebuildProgress.gpuCompleted || 0
        const cpuCompleted = thumbnailRebuildProgress.cpuCompleted || 0
        thumbnailRebuildProgress.effectiveBackend =
          gpuCompleted > 0 && cpuCompleted > 0 ? 'mixed' : gpuCompleted > 0 ? 'gpu' : 'cpu'
      } else {
        thumbnailRebuildProgress.failed += 1
      }
    }

    const cpuWorkers = Array.from({ length: cpuLaneCount }, async () => {
      for (;;) {
        const item = await cpuQueue.take()
        updatePipelineProgress()
        if (!item) return
        if (thumbnailRebuildStopRequested) continue
        thumbnailRebuildProgress.currentPath = item.filePath
        activeCpuTasks += 1
        updatePipelineProgress()
        try {
          const result = await runTracked(() =>
            generateImageThumbnail(
              userDataPath,
              item.filePath,
              THUMB_MAX,
              true,
              'cpu',
              undefined,
              true,
              false,
              cacheSink,
            ),
          )
          recordResult(item.gpuFallback ? { ...result, gpuFallback: true } : result)
        } finally {
          activeCpuTasks -= 1
          updatePipelineProgress()
        }
      }
    })

    const gpuWorkers =
      gpuPool &&
      Array.from({ length: gpuLaneCount }, async () => {
        for (;;) {
          const filePath = await gpuQueue.take()
          updatePipelineProgress()
          if (!filePath) return
          if (thumbnailRebuildStopRequested) continue
          thumbnailRebuildProgress.currentPath = filePath
          let stat: fs.Stats
          try {
            stat = await fsp.stat(filePath)
          } catch {
            recordResult({ path: filePath, dataUrl: null, error: 'Cannot stat image' })
            continue
          }
          const ext = path.extname(filePath).toLowerCase()
          const gpuEligible =
            GPU_IMAGE_MIME.has(ext) &&
            (backend === 'gpu' || (backend === 'auto' && stat.size <= AUTO_GPU_MAX_FILE_BYTES))
          if (!gpuEligible) {
            await cpuQueue.push({ filePath, gpuFallback: backend === 'gpu' })
            updatePipelineProgress()
            continue
          }
          const result = await runTracked(() =>
            generateImageThumbnail(
              userDataPath,
              filePath,
              THUMB_MAX,
              true,
              backend,
              gpuPool,
              false,
              true,
              cacheSink,
            ),
          )
          if (result.dataUrl || !result.gpuFallback) {
            recordResult(result)
          } else {
            await cpuQueue.push({ filePath, gpuFallback: true })
            updatePipelineProgress()
          }
        }
      })

    for (let startIndex = 0; startIndex < files.length && !thumbnailRebuildStopRequested; ) {
      const batch = files.slice(startIndex, startIndex + batchSize)
      startIndex += batch.length
      for (const filePath of batch) {
        if (!gpuPool) {
          await cpuQueue.push({ filePath, gpuFallback: false })
          continue
        }
        const gpuCongested = gpuQueue.size >= Math.max(8, gpuLaneCount * 2)
        const cpuPressure = activeCpuTasks + cpuQueue.size
        const routeAutoTaskToCpu =
          backend === 'auto' && gpuCongested && cpuPressure < cpuLaneCount * 2
        if (routeAutoTaskToCpu) {
          await cpuQueue.push({ filePath, gpuFallback: false })
          thumbnailRebuildProgress.autoCpuRouted = (thumbnailRebuildProgress.autoCpuRouted || 0) + 1
        } else {
          await gpuQueue.push(filePath)
        }
        updatePipelineProgress()
      }
      updatePipelineProgress()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    if (gpuPool) {
      gpuQueue.close()
      await Promise.all(gpuWorkers || [])
    }
    cpuQueue.close()
    await Promise.all(cpuWorkers)
    await cacheWriter.closeAndDrain()
    thumbnailRebuildProgress.inFlight = 0
    thumbnailRebuildProgress.gpuQueueDepth = 0
    thumbnailRebuildProgress.cpuQueueDepth = 0
    thumbnailRebuildProgress.cacheQueueDepth = 0
    thumbnailRebuildProgress.cacheWrites = cacheWriter.completed
    thumbnailRebuildProgress.cacheWriteFailures = cacheWriter.failed
    thumbnailRebuildProgress.state = 'done'
    thumbnailRebuildProgress.finishedAt = Date.now()
    thumbnailRebuildProgress.currentPath = undefined
    await evictThumbCache(userDataPath)
  } catch (error: unknown) {
    thumbnailRebuildProgress.state = 'error'
    thumbnailRebuildProgress.error = errorMessage(error)
    thumbnailRebuildProgress.finishedAt = Date.now()
  } finally {
    await cacheWriter?.closeAndDrain()
    gpuPool?.dispose()
  }
}

function resolveShortcut(shortcutPath: string): string | null {
  const cached = shortcutCache.get(shortcutPath)
  if (cached !== undefined) return cached

  try {
    const detail = shell.readShortcutLink(shortcutPath)
    const target = detail.target || null
    cacheShortcutResult(shortcutPath, target)
    return target
  } catch {
    cacheShortcutResult(shortcutPath, null)
    return null
  }
}

export function registerThumbnailIpc(
  userDataPath: string,
  taskScheduler?: UnifiedTaskSubmitter,
): void {
  secureIpcMain.handle(
    'imageSearch:startThumbnailRebuild',
    async (
      _event,
      rawPaths: unknown,
      rawBackend: unknown,
      rawGpuJobs: unknown,
      rawBatchSize: unknown,
    ) => {
      if (
        thumbnailRebuildProgress.state === 'running' ||
        thumbnailRebuildProgress.state === 'stopping'
      ) {
        return {
          ok: false,
          progress: { ...thumbnailRebuildProgress },
          error: 'Thumbnail rebuild is already running',
        }
      }
      const roots = Array.isArray(rawPaths)
        ? rawPaths
            .slice(0, 64)
            .map((item) => safeThumbnailPath(item))
            .filter((item): item is string => Boolean(item))
        : []
      if (roots.length === 0) return { ok: false, error: 'No valid source paths' }
      const backend: ThumbnailRebuildBackend =
        rawBackend === 'cpu' ||
        rawBackend === 'gpu' ||
        rawBackend === 'native' ||
        rawBackend === 'cuda'
          ? rawBackend
          : 'auto'
      const gpuJobs = clampThumbnailGpuJobs(rawGpuJobs)
      const batchSize = clampEvenThumbnailSetting(
        rawBatchSize,
        DEFAULT_THUMBNAIL_BATCH_SIZE,
        MAX_THUMBNAIL_BATCH_SIZE,
      )
      thumbnailRebuildStopRequested = false
      if (backend === 'native' || backend === 'cuda') {
        const started = startNativeThumbnailRebuild(roots, gpuJobs, backend === 'cuda')
        if (!started.ok)
          return { ok: false, error: started.error || 'Native rebuild failed to start' }
        nativeThumbnailRebuildActive = true
        const native = getNativeThumbnailRebuildProgress()
        thumbnailRebuildProgress = {
          state: native?.state || 'running',
          total: native?.total || 0,
          completed: native?.completed || 0,
          skipped: native?.skipped || 0,
          failed: native?.failed || 0,
          requestedBackend: backend,
          effectiveBackend: native?.effectiveBackend || 'native-cpp',
          gpuCompleted: native?.effectiveBackend === 'cuda' ? native.completed : 0,
          cpuCompleted: native?.effectiveBackend === 'cuda' ? 0 : native?.completed || 0,
          fallbackCount: backend === 'cuda' && !native?.cudaAvailable ? 1 : 0,
          gpuJobs,
          gpuLanes: native?.effectiveBackend === 'cuda' ? native.workers : 0,
          cpuLanes: native?.effectiveBackend === 'native-cpp' ? native.workers : 0,
          batchSize,
          inFlight: native?.pending || 0,
          peakInFlight: native?.pending || 0,
          gpuQueueDepth: 0,
          cpuQueueDepth: native?.pending || 0,
          cacheQueueDepth: 0,
          cacheWrites: native?.completed || 0,
          cacheWriteFailures: native?.failed || 0,
          gpuDevice: native?.cudaAvailable ? 'NVIDIA CUDA / nvJPEG' : undefined,
          gpuError: native?.cudaError,
          currentPath: native?.currentPath,
          error: native?.error,
          startedAt: native?.startedAt || Date.now(),
          finishedAt: native?.finishedAt || undefined,
        }
        return { ok: true, progress: { ...thumbnailRebuildProgress } }
      }
      nativeThumbnailRebuildActive = false
      thumbnailRebuildProgress = {
        state: 'running',
        total: 0,
        completed: 0,
        skipped: 0,
        failed: 0,
        requestedBackend: backend,
        effectiveBackend: backend === 'cpu' ? 'cpu' : undefined,
        gpuCompleted: 0,
        cpuCompleted: 0,
        fallbackCount: 0,
        gpuJobs: backend === 'cpu' ? 0 : gpuJobs,
        gpuLanes: 0,
        cpuLanes: backend === 'cpu' ? THUMBNAIL_DECODE_CONCURRENCY : 0,
        batchSize,
        inFlight: 0,
        peakInFlight: 0,
        gpuQueueDepth: 0,
        cpuQueueDepth: 0,
        cacheQueueDepth: 0,
        cacheWrites: 0,
        cacheWriteFailures: 0,
        autoCpuRouted: 0,
        currentPath: 'Enumerating image sources...',
        startedAt: Date.now(),
      }
      void runThumbnailRebuild(userDataPath, roots, backend, gpuJobs, batchSize)
      return { ok: true, progress: { ...thumbnailRebuildProgress } }
    },
  )

  secureIpcMain.handle('imageSearch:getThumbnailRebuildProgress', async () => {
    if (nativeThumbnailRebuildActive) {
      const native = getNativeThumbnailRebuildProgress()
      if (native) {
        const cuda = native.effectiveBackend === 'cuda'
        thumbnailRebuildProgress = {
          ...thumbnailRebuildProgress,
          state: native.state,
          total: native.total,
          completed: native.completed,
          skipped: native.skipped,
          failed: native.failed,
          effectiveBackend: native.effectiveBackend,
          gpuCompleted: cuda ? native.completed : 0,
          cpuCompleted: cuda ? 0 : native.completed,
          fallbackCount:
            thumbnailRebuildProgress.requestedBackend === 'cuda' && !native.cudaAvailable ? 1 : 0,
          gpuLanes: cuda ? native.workers : 0,
          cpuLanes: cuda ? 0 : native.workers,
          inFlight: native.pending,
          peakInFlight: Math.max(thumbnailRebuildProgress.peakInFlight || 0, native.pending),
          gpuQueueDepth: 0,
          cpuQueueDepth: native.pending,
          cacheWrites: native.completed,
          cacheWriteFailures: native.failed,
          gpuDevice: native.cudaAvailable ? 'NVIDIA CUDA / nvJPEG' : undefined,
          gpuError: native.cudaError,
          currentPath: native.currentPath,
          error: native.error,
          startedAt: native.startedAt,
          finishedAt: native.finishedAt || undefined,
        }
        if (native.state === 'done' || native.state === 'error')
          nativeThumbnailRebuildActive = false
      }
    }
    return { ...thumbnailRebuildProgress }
  })

  secureIpcMain.handle('imageSearch:stopThumbnailRebuild', async () => {
    if (thumbnailRebuildProgress.state === 'running') {
      thumbnailRebuildStopRequested = true
      thumbnailRebuildProgress.state = 'stopping'
      if (nativeThumbnailRebuildActive) stopNativeThumbnailRebuild()
    }
    return { ...thumbnailRebuildProgress }
  })

  secureIpcMain.handle('imageSearch:clearThumbnailCache', async (_event, confirm: unknown) => {
    if (confirm !== true) return { ok: false, error: 'Explicit confirmation is required' }
    if (
      thumbnailRebuildProgress.state === 'running' ||
      thumbnailRebuildProgress.state === 'stopping'
    ) {
      return { ok: false, error: 'Stop thumbnail rebuild before clearing its cache' }
    }
    const cacheDir = getThumbCacheDir(userDataPath)
    const retiredDir = path.join(userDataPath, `.thumbcache-retired-${Date.now()}`)
    try {
      await fsp.rename(cacheDir, retiredDir)
      await fsp.mkdir(cacheDir, { recursive: true })
      void fsp.rm(retiredDir, { recursive: true, force: true }).catch((error) => {
        console.warn('[Thumbnail] Background cleanup failed:', retiredDir, error)
      })
      return { ok: true, cleanupStarted: true }
    } catch (error) {
      if (!fs.existsSync(cacheDir)) await fsp.mkdir(cacheDir, { recursive: true })
      return { ok: false, error: errorMessage(error) }
    }
  })

  secureIpcMain.handle(
    'fm-get-thumbnail',
    async (_event, filePath: string, maxDim: number = THUMB_MAX): Promise<ThumbnailResult> => {
      const safePath = safeThumbnailPath(filePath)
      if (!safePath) return { path: String(filePath ?? ''), dataUrl: null, error: 'Invalid path' }
      return submitUnifiedTask(taskScheduler, {
        stage: 'preview',
        priority: 0,
        paths: [safePath],
        label: `visible thumbnail: ${path.basename(safePath).slice(0, 80)}`,
        run: () =>
          withThumbnailDecodeSlot(() =>
            generateImageThumbnail(userDataPath, safePath, clampThumbDim(maxDim, THUMB_MAX)),
          ),
      })
    },
  )

  secureIpcMain.handle(
    'fm-get-folder-thumbnails',
    async (
      _event,
      folderPath: string,
      maxCount: number = 4,
      maxDim: number = THUMB_MAX,
    ): Promise<ThumbnailResult[]> => {
      const safeFolder = safeThumbnailPath(folderPath)
      if (!safeFolder) return []
      const boundedCount = Math.max(
        1,
        Math.min(MAX_FOLDER_THUMBNAILS, Math.floor(Number(maxCount)) || 4),
      )
      const boundedDim = clampThumbDim(maxDim, THUMB_MAX)
      const results: ThumbnailResult[] = []
      try {
        const entries = await fsp.readdir(safeFolder, { withFileTypes: true })
        const files = entries
          .filter((e) => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
          .map((e) => path.join(safeFolder, e.name))
        files.sort((a, b) => a.localeCompare(b))

        const selectedFiles = files.slice(0, boundedCount)
        const generated = await submitUnifiedTask(taskScheduler, {
          stage: 'preview',
          priority: 0,
          paths: selectedFiles,
          label: `visible folder thumbnails: ${path.basename(safeFolder).slice(0, 80)}`,
          run: () =>
            Promise.all(
              selectedFiles.map((filePath) =>
                withThumbnailDecodeSlot(() =>
                  generateImageThumbnail(userDataPath, filePath, boundedDim),
                ),
              ),
            ),
        })
        results.push(...generated.filter((result) => result.dataUrl))
      } catch {
        /* folder read error */
      }
      return results
    },
  )

  secureIpcMain.handle(
    'fm-get-file-icons',
    async (
      _event,
      requests: { path: string; size?: 'small' | 'normal' | 'large' }[],
    ): Promise<ThumbnailResult[]> => {
      const dimMap = { small: 16, normal: 32, large: 48 }
      const results: ThumbnailResult[] = []
      const boundedRequests = Array.isArray(requests) ? requests.slice(0, MAX_THUMBNAIL_BATCH) : []
      for (const req of boundedRequests) {
        const safeReqPath = safeThumbnailPath(req?.path)
        if (!safeReqPath) {
          results.push({ path: String(req?.path ?? ''), dataUrl: null, error: 'Invalid path' })
          continue
        }
        try {
          let iconPath = safeReqPath
          if (safeReqPath.toLowerCase().endsWith('.lnk')) {
            const target = resolveShortcut(safeReqPath)
            if (target) iconPath = target
          }
          const dim = dimMap[req.size || 'large']

          try {
            const st = await fsp.stat(iconPath)
            const cached = thumbCacheGet(userDataPath, safeReqPath, st.mtimeMs, dim)
            if (cached) {
              results.push({ path: safeReqPath, dataUrl: cached })
              continue
            }
          } catch {
            /* skip */
          }

          const icon = await app.getFileIcon(iconPath, { size: req.size || 'large' })
          if (!icon.isEmpty()) {
            const dataUrl = icon.toDataURL()
            results.push({ path: safeReqPath, dataUrl })
            try {
              const st = await fsp.stat(iconPath)
              thumbCacheSet(userDataPath, safeReqPath, st.mtimeMs, dim, dataUrl)
            } catch {
              /* skip */
            }
          } else {
            results.push({ path: safeReqPath, dataUrl: null, error: 'No icon available' })
          }
        } catch (e: unknown) {
          results.push({ path: safeReqPath, dataUrl: null, error: errorMessage(e) })
        }
      }
      return results
    },
  )

  secureIpcMain.handle(
    'fm-get-thumbnails-batch',
    async (_event, requests: { path: string; maxDim: number }[]): Promise<ThumbnailResult[]> => {
      const boundedRequests = Array.isArray(requests) ? requests.slice(0, MAX_THUMBNAIL_BATCH) : []

      const safeBatchPaths = boundedRequests.flatMap((request) => {
        const safePath = safeThumbnailPath(request?.path)
        return safePath ? [safePath] : []
      })
      return submitUnifiedTask(taskScheduler, {
        stage: 'preview',
        priority: 0,
        paths: safeBatchPaths,
        label: `visible thumbnail batch: ${safeBatchPaths.length}`,
        run: () =>
          Promise.all(
            boundedRequests.map(async (req) => {
              const safeReqPath = safeThumbnailPath(req?.path)
              const boundedDim = clampThumbDim(req?.maxDim, THUMB_MAX)
              if (!safeReqPath) {
                return { path: String(req?.path ?? ''), dataUrl: null, error: 'Invalid path' }
              }
              return withThumbnailDecodeSlot(() =>
                generateImageThumbnail(userDataPath, safeReqPath, boundedDim),
              )
            }),
          ),
      })
    },
  )
}
