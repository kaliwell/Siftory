import { secureIpcMain } from './ipcAuthorization'
// ── File Manager IPC handlers ────────────────────────────────
// Extracted from main.ts to reduce module size.
// Registers all fm-* IPC handlers: directory listing, file CRUD,
// copy/move with progress, cross-device fallback, and directory watching.

import { shell, BrowserWindow, type WebContents } from 'electron'
import path from 'path'
import fs from 'fs'
import fsp from 'fs/promises'
import { pipeline } from 'stream/promises'
import type {
  FMFolderSizeProgress,
  FMFolderSizeRequest,
  FMFolderSizeResult,
  FMVolumeSpaceResult,
} from '../shared/ipc/file-manager'
import {
  FolderStatsCancelledError,
  scanFolderTree,
  type FolderStatsOptions,
  type FolderTreeStats,
} from './appStorageService'
import {
  isSameOrNestedPath,
  normalizeConflictOption,
  normalizeDirListRequest,
  normalizePathList,
  normalizeUserPath,
  openSafeShellPath,
  revealSafeShellPath,
} from './pathGuards'
import {
  commitPreparedPath,
  createPreparedSiblingPath,
  discardPreparedPath,
  recoverPreparedPathTransactions,
} from './localFileTransaction'
import { compareFileManagerEntries } from './fileManagerSorting'
import { movePathWithoutOverwrite, publishFileWithoutOverwrite } from './localFileNoReplace'

// ═════════════════════════════════════════════════════════════
// Module state
// ═════════════════════════════════════════════════════════════

let currentFileOperation: AbortController | null = null

interface DirWatcherEntry {
  watcher: fs.FSWatcher
  count: number
  timer: ReturnType<typeof setTimeout> | null
  owners: Map<number, number>
  closed: boolean
}

const dirWatchers = new Map<string, DirWatcherEntry>()
const trackedDirWatcherSenders = new Set<number>()

const FILE_MANAGER_FOLDER_SIZE_MAX_ENTRIES = 250_000
const FILE_MANAGER_FOLDER_SIZE_MAX_SCANS = 2
const FILE_MANAGER_FOLDER_SIZE_CACHE_LIMIT = 512
const FILE_MANAGER_FOLDER_SIZE_CACHE_TTL_MS = 60_000
const FILE_MANAGER_FOLDER_SIZE_PARTIAL_CACHE_TTL_MS = 10_000

interface FolderSizeRequestJob {
  controller: AbortController
  active: number
  senderId: number
  requestId: string
}

interface FolderSizeCacheEntry {
  result: FMFolderSizeResult
  expiresAt: number
}

interface FolderSizeSlotWaiter {
  signal: AbortSignal
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  onAbort: () => void
}

const folderSizeRequestJobs = new Map<string, FolderSizeRequestJob>()
const trackedFolderSizeSenders = new Set<number>()
const folderSizeCache = new Map<string, FolderSizeCacheEntry>()
const folderSizeSlotWaiters: FolderSizeSlotWaiter[] = []
let activeFolderSizeScans = 0
let folderSizeCacheEpoch = 0

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined
}

function folderSizeJobKey(senderId: number, requestId: string): string {
  return `${senderId}:${requestId}`
}

function folderSizeCacheKey(folderPath: string): string {
  const resolved = path.resolve(folderPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

interface FileManagerStatFsLike {
  bsize: bigint
  blocks: bigint
  bfree: bigint
  bavail: bigint
}

export function normalizeFileManagerVolumeSpacePath(rawPath: unknown): string | null {
  const normalized = normalizeUserPath(rawPath)
  if (!normalized) return null
  const resolved = path.resolve(normalized)
  const rootPath = path.parse(resolved).root
  if (!rootPath || folderSizeCacheKey(resolved) !== folderSizeCacheKey(rootPath)) return null
  return path.normalize(rootPath)
}

export function fileManagerVolumeSpaceFromStatFs(
  rootPath: string,
  stats: FileManagerStatFsLike,
): FMVolumeSpaceResult {
  const totalBytes = Math.max(0, Number(stats.bsize * stats.blocks))
  const freeBytes = Math.min(totalBytes, Math.max(0, Number(stats.bsize * stats.bfree)))
  const availableBytes = Math.min(totalBytes, Math.max(0, Number(stats.bsize * stats.bavail)))
  if (![totalBytes, freeBytes, availableBytes].every(Number.isFinite)) {
    return {
      path: rootPath,
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      availableBytes: 0,
      error: 'Volume capacity exceeds the supported numeric range',
    }
  }
  return {
    path: rootPath,
    totalBytes,
    usedBytes: Math.max(0, totalBytes - freeBytes),
    freeBytes,
    availableBytes,
  }
}

export async function calculateFileManagerVolumeSpace(
  rawPath: unknown,
): Promise<FMVolumeSpaceResult> {
  const rootPath = normalizeFileManagerVolumeSpacePath(rawPath)
  if (!rootPath) {
    return {
      path: '',
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      availableBytes: 0,
      error: 'Volume space can only be queried for a drive or share root',
    }
  }
  try {
    const stats = await fsp.statfs(rootPath, { bigint: true })
    return fileManagerVolumeSpaceFromStatFs(rootPath, stats)
  } catch (error) {
    return {
      path: rootPath,
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      availableBytes: 0,
      error: errorMessage(error),
    }
  }
}

export function clearFileManagerFolderSizeCache(): void {
  folderSizeCache.clear()
  folderSizeCacheEpoch += 1
}

export function fileManagerFolderSizePathsOverlap(firstPath: string, secondPath: string): boolean {
  const first = folderSizeCacheKey(firstPath)
  const second = folderSizeCacheKey(secondPath)
  return isSameOrNestedPath(first, second) || isSameOrNestedPath(second, first)
}

export function invalidateFileManagerFolderSizeCache(changedPaths: readonly string[]): void {
  if (changedPaths.length === 0) return
  const normalizedChanges = changedPaths.map(folderSizeCacheKey)
  // Prevent a scan that overlapped the mutation from populating the cache afterward.
  folderSizeCacheEpoch += 1
  for (const cachedPath of folderSizeCache.keys()) {
    if (
      normalizedChanges.some(
        (changedPath) =>
          isSameOrNestedPath(cachedPath, changedPath) ||
          isSameOrNestedPath(changedPath, cachedPath),
      )
    ) {
      folderSizeCache.delete(cachedPath)
    }
  }
}

function readCachedFolderSize(folderPath: string): FMFolderSizeResult | undefined {
  const key = folderSizeCacheKey(folderPath)
  const cached = folderSizeCache.get(key)
  if (!cached) return undefined
  if (cached.expiresAt <= Date.now()) {
    folderSizeCache.delete(key)
    return undefined
  }
  // Refresh insertion order so the bounded cache behaves as an LRU.
  folderSizeCache.delete(key)
  folderSizeCache.set(key, cached)
  return cached.result
}

function cacheFolderSize(result: FMFolderSizeResult): void {
  if (result.cancelled || result.error) return
  const key = folderSizeCacheKey(result.path)
  folderSizeCache.delete(key)
  while (folderSizeCache.size >= FILE_MANAGER_FOLDER_SIZE_CACHE_LIMIT) {
    const oldest = folderSizeCache.keys().next().value as string | undefined
    if (!oldest) break
    folderSizeCache.delete(oldest)
  }
  folderSizeCache.set(key, {
    result,
    expiresAt:
      Date.now() +
      (result.complete
        ? FILE_MANAGER_FOLDER_SIZE_CACHE_TTL_MS
        : FILE_MANAGER_FOLDER_SIZE_PARTIAL_CACHE_TTL_MS),
  })
}

function makeFolderSizeFailure(
  folderPath: string,
  error: string,
  cancelled = false,
): FMFolderSizeResult {
  return {
    path: folderPath,
    bytes: 0,
    fileCount: 0,
    folderCount: 0,
    entriesScanned: 0,
    complete: false,
    durationMs: 0,
    ...(cancelled && { cancelled: true }),
    error,
  }
}

function folderTreeStatsToFileManagerResult(
  folderPath: string,
  result: FolderTreeStats,
): FMFolderSizeResult {
  return {
    path: folderPath,
    bytes: result.bytes,
    fileCount: result.fileCount,
    folderCount: result.folderCount,
    entriesScanned: result.entriesScanned,
    complete: result.complete,
    ...(result.partialReason && { partialReason: result.partialReason }),
    durationMs: result.durationMs,
  }
}

function sendFolderSizeProgress(sender: WebContents, progress: FMFolderSizeProgress): void {
  if (sender.isDestroyed()) return
  try {
    sender.send('fm:folder-size-progress', progress)
  } catch {
    // The renderer can be destroyed between the guard and send during shutdown/navigation.
  }
}

export function normalizeFileManagerFolderSizeRequest(
  raw: unknown,
): { ok: true; request: FMFolderSizeRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Invalid folder size request' }
  }
  const candidate = raw as { folderPath?: unknown; requestId?: unknown }
  const folderPath = normalizeUserPath(candidate.folderPath)
  if (!folderPath) return { ok: false, error: 'Invalid folder path' }
  if (
    typeof candidate.requestId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(candidate.requestId)
  ) {
    return { ok: false, error: 'Invalid folder size request id' }
  }
  return { ok: true, request: { folderPath, requestId: candidate.requestId } }
}

function normalizeFolderSizeRequestId(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(raw) ? raw : undefined
}

export async function calculateFileManagerFolderSize(
  folderPath: string,
  options: FolderStatsOptions = {},
): Promise<FMFolderSizeResult> {
  const normalizedPath = normalizeUserPath(folderPath)
  if (!normalizedPath) return makeFolderSizeFailure('', 'Invalid folder path')
  try {
    const result = await scanFolderTree(normalizedPath, '', options)
    return folderTreeStatsToFileManagerResult(normalizedPath, result)
  } catch (error) {
    if (error instanceof FolderStatsCancelledError) {
      return makeFolderSizeFailure(normalizedPath, 'Folder size request was cancelled', true)
    }
    return makeFolderSizeFailure(normalizedPath, errorMessage(error))
  }
}

function createFolderSizeSlotRelease(): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    activeFolderSizeScans = Math.max(0, activeFolderSizeScans - 1)
    drainFolderSizeSlotWaiters()
  }
}

function drainFolderSizeSlotWaiters(): void {
  while (
    activeFolderSizeScans < FILE_MANAGER_FOLDER_SIZE_MAX_SCANS &&
    folderSizeSlotWaiters.length > 0
  ) {
    const waiter = folderSizeSlotWaiters.shift()!
    waiter.signal.removeEventListener('abort', waiter.onAbort)
    if (waiter.signal.aborted) {
      waiter.reject(new FolderStatsCancelledError())
      continue
    }
    activeFolderSizeScans += 1
    waiter.resolve(createFolderSizeSlotRelease())
  }
}

function acquireFolderSizeSlot(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) return Promise.reject(new FolderStatsCancelledError())
  if (activeFolderSizeScans < FILE_MANAGER_FOLDER_SIZE_MAX_SCANS) {
    activeFolderSizeScans += 1
    return Promise.resolve(createFolderSizeSlotRelease())
  }
  return new Promise((resolve, reject) => {
    const waiter: FolderSizeSlotWaiter = {
      signal,
      resolve,
      reject,
      onAbort: () => {
        const index = folderSizeSlotWaiters.indexOf(waiter)
        if (index >= 0) folderSizeSlotWaiters.splice(index, 1)
        reject(new FolderStatsCancelledError())
      },
    }
    signal.addEventListener('abort', waiter.onAbort, { once: true })
    folderSizeSlotWaiters.push(waiter)
  })
}

function getFolderSizeRequestJob(senderId: number, requestId: string): FolderSizeRequestJob {
  const key = folderSizeJobKey(senderId, requestId)
  let job = folderSizeRequestJobs.get(key)
  if (!job) {
    job = { controller: new AbortController(), active: 0, senderId, requestId }
    folderSizeRequestJobs.set(key, job)
  }
  job.active += 1
  return job
}

function releaseFolderSizeRequestJob(job: FolderSizeRequestJob): void {
  job.active = Math.max(0, job.active - 1)
  if (job.active > 0) return
  const key = folderSizeJobKey(job.senderId, job.requestId)
  if (folderSizeRequestJobs.get(key) === job) folderSizeRequestJobs.delete(key)
}

function cancelFolderSizeRequestJob(senderId: number, requestId: string): void {
  const job = folderSizeRequestJobs.get(folderSizeJobKey(senderId, requestId))
  if (!job) return
  job.controller.abort()
  if (job.active === 0) folderSizeRequestJobs.delete(folderSizeJobKey(senderId, requestId))
}

function trackFolderSizeSender(sender: WebContents): void {
  if (trackedFolderSizeSenders.has(sender.id)) return
  trackedFolderSizeSenders.add(sender.id)
  sender.once('destroyed', () => {
    for (const job of folderSizeRequestJobs.values()) {
      if (job.senderId === sender.id) job.controller.abort()
    }
    trackedFolderSizeSenders.delete(sender.id)
  })
}

// ═════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════

async function copyFileWithProgress(
  src: string,
  dest: string,
  event: Electron.IpcMainInvokeEvent,
  signal: AbortSignal,
): Promise<{ success: boolean; error?: string }> {
  try {
    signal.throwIfAborted()
    const st = await fsp.stat(src)
    const totalSize = st.size
    let copied = 0

    const readStream = fs.createReadStream(src)
    const writeStream = fs.createWriteStream(dest)

    readStream.on('data', (chunk: string | Buffer) => {
      copied += Buffer.byteLength(chunk)
      const pct = totalSize > 0 ? Math.round((copied / totalSize) * 100) : 100
      event.sender.send('fm-copy-progress', {
        currentFile: path.basename(src),
        completed: copied,
        total: totalSize,
        percentage: pct,
        status: 'running',
      })
    })

    await pipeline(readStream, writeStream, { signal })
    // Preserve mtime
    await fsp.utimes(dest, st.atime, st.mtime)
    return { success: true }
  } catch (e: unknown) {
    if (signal.aborted) await fsp.rm(dest, { force: true }).catch(() => {})
    return { success: false, error: errorMessage(e) }
  }
}

async function copyDirRecursive(
  srcDir: string,
  destDir: string,
  event: Electron.IpcMainInvokeEvent,
  signal: AbortSignal,
): Promise<{ success: boolean; error?: string }> {
  try {
    signal.throwIfAborted()
    await fsp.mkdir(destDir, { recursive: true })
    const entries = await fsp.readdir(srcDir, { withFileTypes: true })
    for (const ent of entries) {
      signal.throwIfAborted()
      const srcPath = path.join(srcDir, ent.name)
      const destPath = path.join(destDir, ent.name)
      if (ent.isDirectory()) {
        const r = await copyDirRecursive(srcPath, destPath, event, signal)
        if (!r.success) return r
      } else {
        const r = await copyFileWithProgress(srcPath, destPath, event, signal)
        if (!r.success) return r
      }
    }
    return { success: true }
  } catch (e: unknown) {
    return { success: false, error: errorMessage(e) }
  }
}

async function getNonConflictingPath(destPath: string): Promise<string> {
  try {
    await fsp.access(destPath)
  } catch {
    return destPath
  }

  const dir = path.dirname(destPath)
  const ext = path.extname(destPath)
  const base = path.basename(destPath, ext)
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`)
    try {
      await fsp.access(candidate)
    } catch {
      return candidate
    }
  }
  // Extreme edge case: >999 copies exist → fall back to timestamp suffix
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(dir, `${base}_${ts}${ext}`)
}

// ═════════════════════════════════════════════════════════════
// Directory watcher helper (exported for testing)
// ═════════════════════════════════════════════════════════════

/**
 * Creates a debounced directory-change sender.  The returned function
 * operates directly on an `entry` object (the same object that holds the
 * fs.FSWatcher reference), mutating its `.timer` property so that debounce
 * state survives across calls and `fm-unwatch-dir` can clearTimeout it.
 *
 * The `getWindow` getter is called *at send-time*, so window close /
 * recreate cycles route events to the current window.
 */
export function createDirChangeSender(
  getWindow: () => BrowserWindow | null,
  dirPath: string,
  debounceMs = 300,
): (entry: { timer: ReturnType<typeof setTimeout> | null }) => void {
  return (entry) => {
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('fm:dir-changed', dirPath)
      }
    }, debounceMs)
  }
}

export function disposeDirWatcherEntry(entry: {
  watcher: { close: () => void }
  timer: ReturnType<typeof setTimeout> | null
  closed?: boolean
}): void {
  if (entry.closed) return
  entry.closed = true
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  try {
    entry.watcher.close()
  } catch {
    // A watcher may already have been closed by the operating system.
  }
}

function removeDirWatcher(normalizedDir: string, entry: DirWatcherEntry): void {
  if (dirWatchers.get(normalizedDir) !== entry) return
  dirWatchers.delete(normalizedDir)
  disposeDirWatcherEntry(entry)
}

function retainDirWatcherOwner(entry: DirWatcherEntry, senderId: number): void {
  entry.count += 1
  entry.owners.set(senderId, (entry.owners.get(senderId) ?? 0) + 1)
}

function releaseDirWatcherOwner(
  normalizedDir: string,
  entry: DirWatcherEntry,
  senderId: number,
  releaseAll = false,
): void {
  const ownedCount = entry.owners.get(senderId) ?? 0
  if (ownedCount < 1) return
  const releasedCount = releaseAll ? ownedCount : 1
  if (releasedCount >= ownedCount) entry.owners.delete(senderId)
  else entry.owners.set(senderId, ownedCount - releasedCount)
  entry.count = Math.max(0, entry.count - releasedCount)
  if (entry.count === 0) removeDirWatcher(normalizedDir, entry)
}

function trackDirWatcherSender(sender: WebContents): void {
  if (trackedDirWatcherSenders.has(sender.id)) return
  trackedDirWatcherSenders.add(sender.id)
  sender.once('destroyed', () => {
    for (const [normalizedDir, entry] of [...dirWatchers]) {
      releaseDirWatcherOwner(normalizedDir, entry, sender.id, true)
    }
    trackedDirWatcherSenders.delete(sender.id)
  })
}

export function disposeFileManagerWatchers(): void {
  for (const [normalizedDir, entry] of [...dirWatchers]) {
    removeDirWatcher(normalizedDir, entry)
  }
  for (const job of folderSizeRequestJobs.values()) job.controller.abort()
  clearFileManagerFolderSizeCache()
}

// ═════════════════════════════════════════════════════════════
// Handler registration
// ═════════════════════════════════════════════════════════════

export function registerFileManagerIpc(getWindow: () => BrowserWindow | null): void {
  secureIpcMain.handle('fm-expand-path', (_e, p: string) => normalizeUserPath(p) || '')

  secureIpcMain.handle('fm-path-exists', async (_e, p: string) => {
    const normalized = normalizeUserPath(p)
    if (!normalized) return false
    try {
      await fsp.access(normalized)
      return true
    } catch {
      return false
    }
  })

  secureIpcMain.handle('fm-list-directory', async (_e, dirPath: string) => {
    const normalizedDir = normalizeUserPath(dirPath)
    if (!normalizedDir) return { path: '', files: [], error: 'Invalid directory path' }
    try {
      recoverPreparedPathTransactions(normalizedDir)
      const names = await fsp.readdir(normalizedDir)
      const BATCH = 128
      const entries: Array<{
        name: string
        path: string
        isDirectory: boolean
        size: number
        mtime: number
        type: string
      }> = []

      for (let i = 0; i < names.length; i += BATCH) {
        const batch = names.slice(i, i + BATCH)
        const batchResults = await Promise.all(
          batch.map(async (name) => {
            const full = path.join(normalizedDir, name)
            try {
              const st = await fsp.stat(full)
              const ext = path.extname(name).toLowerCase()
              return {
                name,
                path: full,
                isDirectory: st.isDirectory(),
                size: st.isDirectory() ? 0 : st.size,
                mtime: st.mtimeMs,
                type: st.isDirectory() ? '文件夹' : ext,
              }
            } catch {
              return {
                name,
                path: full,
                isDirectory: false,
                size: 0,
                mtime: 0,
                type: '?',
              }
            }
          }),
        )
        entries.push(...batchResults)
      }
      return { path: normalizedDir, files: entries }
    } catch (e: unknown) {
      return { path: normalizedDir, files: [], error: errorMessage(e) }
    }
  })

  // ── Paged directory listing (for 10K+ file directories) ──
  secureIpcMain.handle('fm-list-directory-paged', async (_e, rawReq: unknown) => {
    const normalized = normalizeDirListRequest(rawReq)
    if (!normalized.ok) {
      return { path: '', files: [], total: 0, hasMore: false, error: normalized.error }
    }
    const req = normalized.req
    try {
      recoverPreparedPathTransactions(req.dirPath)
      const names = await fsp.readdir(req.dirPath)
      const total = names.length

      const BATCH = 256
      const entries: Array<{
        name: string
        path: string
        isDirectory: boolean
        size: number
        mtime: number
        type: string
      }> = []

      if (!req.sort || req.sort.field === 'name') {
        const sorted = [...names].sort((a, b) => {
          const r = a.localeCompare(b)
          return req.sort?.direction === 'desc' ? -r : r
        })
        const slice = sorted.slice(req.offset, req.offset + req.limit)
        for (let i = 0; i < slice.length; i += BATCH) {
          const batch = slice.slice(i, i + BATCH)
          const results = await Promise.all(
            batch.map(async (name) => {
              const full = path.join(req.dirPath, name)
              try {
                const st = await fsp.stat(full)
                return {
                  name,
                  path: full,
                  isDirectory: st.isDirectory(),
                  size: st.isDirectory() ? 0 : st.size,
                  mtime: st.mtimeMs,
                  type: st.isDirectory() ? '文件夹' : path.extname(name).toLowerCase(),
                }
              } catch {
                return { name, path: full, isDirectory: false, size: 0, mtime: 0, type: '?' }
              }
            }),
          )
          entries.push(...results)
        }
      } else {
        for (let i = 0; i < names.length; i += BATCH) {
          const batch = names.slice(i, i + BATCH)
          const results = await Promise.all(
            batch.map(async (name) => {
              const full = path.join(req.dirPath, name)
              try {
                const st = await fsp.stat(full)
                return {
                  name,
                  path: full,
                  isDirectory: st.isDirectory(),
                  size: st.isDirectory() ? 0 : st.size,
                  mtime: st.mtimeMs,
                  type: st.isDirectory() ? '文件夹' : path.extname(name).toLowerCase(),
                }
              } catch {
                return { name, path: full, isDirectory: false, size: 0, mtime: 0, type: '?' }
              }
            }),
          )
          entries.push(...results)
        }
        entries.sort((a, b) => compareFileManagerEntries(a, b, req.sort!))
        const sliced = entries.slice(req.offset, req.offset + req.limit)
        entries.length = 0
        entries.push(...sliced)
      }

      return { path: req.dirPath, files: entries, total, hasMore: req.offset + req.limit < total }
    } catch (e: unknown) {
      return {
        path: req.dirPath,
        files: [],
        total: 0,
        hasMore: false,
        error: errorMessage(e),
      }
    }
  })

  secureIpcMain.handle('fm-get-volume-space', (_event, rawPath: unknown) =>
    calculateFileManagerVolumeSpace(rawPath),
  )

  secureIpcMain.handle('fm-get-folder-size', async (event, rawRequest: unknown) => {
    const normalized = normalizeFileManagerFolderSizeRequest(rawRequest)
    if (!normalized.ok) return makeFolderSizeFailure('', normalized.error)
    const { folderPath, requestId } = normalized.request
    const cached = readCachedFolderSize(folderPath)
    if (cached) return cached

    trackFolderSizeSender(event.sender)
    const job = getFolderSizeRequestJob(event.sender.id, requestId)
    const scanCacheEpoch = folderSizeCacheEpoch
    sendFolderSizeProgress(event.sender, {
      requestId,
      path: folderPath,
      phase: 'queued',
      entriesScanned: 0,
      bytes: 0,
    })
    let releaseSlot: (() => void) | undefined
    try {
      releaseSlot = await acquireFolderSizeSlot(job.controller.signal)
      sendFolderSizeProgress(event.sender, {
        requestId,
        path: folderPath,
        phase: 'scanning',
        entriesScanned: 0,
        bytes: 0,
      })
      let lastProgressAt = 0
      const result = await calculateFileManagerFolderSize(folderPath, {
        isCancelled: () => job.controller.signal.aborted,
        maxEntries: FILE_MANAGER_FOLDER_SIZE_MAX_ENTRIES,
        statConcurrency: 8,
        yieldEvery: 128,
        maxDirectorySnapshots: FILE_MANAGER_FOLDER_SIZE_CACHE_LIMIT,
        onProgress: (progress) => {
          const now = Date.now()
          if (now - lastProgressAt < 200) return
          lastProgressAt = now
          sendFolderSizeProgress(event.sender, {
            requestId,
            path: folderPath,
            phase: 'scanning',
            entriesScanned: progress.entriesScanned,
            bytes: progress.bytes,
          })
        },
        onDirectoryStats: (snapshotPath, stats) => {
          if (scanCacheEpoch !== folderSizeCacheEpoch) return
          cacheFolderSize(folderTreeStatsToFileManagerResult(snapshotPath, stats))
        },
      })
      if (scanCacheEpoch === folderSizeCacheEpoch) cacheFolderSize(result)
      return result
    } catch (error) {
      if (error instanceof FolderStatsCancelledError) {
        return makeFolderSizeFailure(folderPath, 'Folder size request was cancelled', true)
      }
      return makeFolderSizeFailure(folderPath, errorMessage(error))
    } finally {
      releaseSlot?.()
      releaseFolderSizeRequestJob(job)
    }
  })

  secureIpcMain.handle('fm-cancel-folder-size-requests', (event, rawRequestId: unknown) => {
    const requestId = normalizeFolderSizeRequestId(rawRequestId)
    if (!requestId) return
    cancelFolderSizeRequestJob(event.sender.id, requestId)
  })

  secureIpcMain.handle('fm-get-file-info', async (_e, filePath: string) => {
    const normalizedPath = normalizeUserPath(filePath)
    if (!normalizedPath) return { error: 'Invalid file path' }
    try {
      const st = await fsp.stat(normalizedPath)
      return {
        name: path.basename(normalizedPath),
        path: normalizedPath,
        isDirectory: st.isDirectory(),
        size: st.size,
        mtime: st.mtimeMs,
        type: st.isDirectory() ? '文件夹' : path.extname(normalizedPath).toLowerCase(),
      }
    } catch (e: unknown) {
      return { error: errorMessage(e) }
    }
  })

  secureIpcMain.handle('fm-open-file', async (_e, filePath: string) => {
    const result = await openSafeShellPath(shell, filePath, { requireExists: true })
    if (!result.ok) return { error: result.error || 'Unable to open file' }
  })

  secureIpcMain.handle('fm-open-in-explorer', async (_e, filePath: string) => {
    const result = revealSafeShellPath(shell, filePath, { requireExists: true })
    if (!result.ok) return { error: result.error || 'Unable to reveal file' }
  })

  secureIpcMain.handle('fm-create-directory', async (_e, parentDir: string, name: string) => {
    const normalizedParent = normalizeUserPath(parentDir)
    if (!normalizedParent) return { success: false, error: 'Invalid parent directory' }
    const safe = path.basename(name)
    if (safe !== name || !safe || safe === '.' || safe === '..') {
      return { success: false, error: 'Invalid folder name' }
    }
    const full = path.join(normalizedParent, safe)
    try {
      await fsp.mkdir(full, { recursive: true })
      invalidateFileManagerFolderSizeCache([full])
      return { success: true, path: full }
    } catch (e: unknown) {
      return { success: false, error: errorMessage(e) }
    }
  })

  secureIpcMain.handle('fm-rename-file', async (_e, oldPath: string, newName: string) => {
    const normalizedOldPath = normalizeUserPath(oldPath)
    if (!normalizedOldPath) return { success: false, error: 'Invalid file path' }
    const safe = path.basename(newName)
    if (safe !== newName || !safe || safe === '.' || safe === '..') {
      return { success: false, error: 'Invalid file name' }
    }
    const dir = path.dirname(normalizedOldPath)
    const newPath = path.join(dir, safe)
    try {
      await movePathWithoutOverwrite(normalizedOldPath, newPath, true)
      invalidateFileManagerFolderSizeCache([normalizedOldPath, newPath])
      return { success: true, newPath }
    } catch (e: unknown) {
      return { success: false, error: errorMessage(e) }
    }
  })

  secureIpcMain.handle('fm-delete-files', async (_e, rawPaths: unknown) => {
    const paths = normalizePathList(rawPaths)
    if (paths.length === 0) return []
    const results: { path: string; success: boolean; error?: string }[] = []
    for (const p of paths) {
      try {
        await shell.trashItem(p)
        results.push({ path: p, success: true })
      } catch (e: unknown) {
        results.push({ path: p, success: false, error: errorMessage(e) })
      }
    }
    invalidateFileManagerFolderSizeCache(
      results.filter((result) => result.success).map((result) => result.path),
    )
    return results
  })

  // ── Abort controller for cancelling long operations ──

  secureIpcMain.handle('fm-abort-operation', () => {
    currentFileOperation?.abort()
  })

  // ── Copy files with progress ─────────────────────

  secureIpcMain.handle(
    'fm-copy-files',
    async (event, rawSources: unknown, rawDestDir: unknown, rawOptions?: unknown) => {
      currentFileOperation?.abort()
      const controller = new AbortController()
      currentFileOperation = controller

      const sources = normalizePathList(rawSources)
      const destDir = normalizeUserPath(rawDestDir)
      const conflict = normalizeConflictOption(rawOptions)
      const results: { path: string; success: boolean; error?: string }[] = []
      if (!destDir) {
        if (currentFileOperation === controller) currentFileOperation = null
        return sources.length > 0
          ? sources.map((src) => ({
              path: src,
              success: false,
              error: 'Invalid destination directory',
            }))
          : [{ path: '', success: false, error: 'Invalid destination directory' }]
      }
      for (const src of sources) {
        if (controller.signal.aborted) {
          results.push({ path: src, success: false, error: 'Cancelled' })
          continue
        }
        const basename = path.basename(src)
        let dest: string
        try {
          const requestedDest = path.join(destDir, basename)
          const st = await fsp.stat(src)
          if (path.resolve(src).toLowerCase() === path.resolve(requestedDest).toLowerCase()) {
            throw new Error('Source and destination are the same')
          }
          dest = conflict === 'rename' ? await getNonConflictingPath(requestedDest) : requestedDest
          if (st.isDirectory() && isSameOrNestedPath(src, dest)) {
            throw new Error('Cannot copy a folder into itself')
          }
          const writeDest = conflict === 'overwrite' ? createPreparedSiblingPath(dest) : dest
          if (st.isDirectory()) {
            const r = await copyDirRecursive(src, writeDest, event, controller.signal)
            if (!r.success) {
              await discardPreparedPath(writeDest)
              results.push({ path: src, success: false, error: r.error })
              continue
            }
          } else {
            const r = await copyFileWithProgress(src, writeDest, event, controller.signal)
            if (!r.success) {
              await discardPreparedPath(writeDest)
              results.push({ path: src, success: false, error: r.error })
              continue
            }
          }
          if (conflict === 'overwrite') {
            try {
              await commitPreparedPath(writeDest, dest)
            } catch (commitError) {
              await discardPreparedPath(writeDest)
              throw commitError
            }
          }
          results.push({ path: src, success: true })
        } catch (e: unknown) {
          results.push({ path: src, success: false, error: errorMessage(e) })
        }
      }
      if (results.some((result) => result.success)) {
        invalidateFileManagerFolderSizeCache([destDir])
      }
      if (currentFileOperation === controller) currentFileOperation = null
      return results
    },
  )

  // ── Move files (cross-device fallback) ──────────

  secureIpcMain.handle(
    'fm-move-files',
    async (event, rawSources: unknown, rawDestDir: unknown, rawOptions?: unknown) => {
      currentFileOperation?.abort()
      const controller = new AbortController()
      currentFileOperation = controller
      const sources = normalizePathList(rawSources)
      const destDir = normalizeUserPath(rawDestDir)
      const conflict = normalizeConflictOption(rawOptions)
      const results: { path: string; success: boolean; error?: string }[] = []
      if (!destDir) {
        if (currentFileOperation === controller) currentFileOperation = null
        return sources.length > 0
          ? sources.map((src) => ({
              path: src,
              success: false,
              error: 'Invalid destination directory',
            }))
          : [{ path: '', success: false, error: 'Invalid destination directory' }]
      }
      for (const src of sources) {
        if (controller.signal.aborted) {
          results.push({ path: src, success: false, error: 'Cancelled' })
          continue
        }
        const basename = path.basename(src)
        let dest = path.join(destDir, basename)
        try {
          const requestedDest = path.join(destDir, basename)
          const st = await fsp.stat(src)
          if (path.resolve(src).toLowerCase() === path.resolve(requestedDest).toLowerCase()) {
            throw new Error('Source and destination are the same')
          }
          dest = conflict === 'rename' ? await getNonConflictingPath(requestedDest) : requestedDest
          if (st.isDirectory() && isSameOrNestedPath(src, dest)) {
            throw new Error('Cannot move a folder into itself')
          }
          controller.signal.throwIfAborted()
          await movePathWithoutOverwrite(src, dest)
          results.push({ path: src, success: true })
        } catch (e: unknown) {
          if (
            !['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'].includes(errorCode(e) || '') &&
            !(conflict === 'overwrite' && errorCode(e) === 'EEXIST')
          ) {
            results.push({ path: src, success: false, error: errorMessage(e) })
            continue
          }
          // Cross-device move → copy + delete (source goes to recycle bin, per app FS rule)
          let preparedFallback: string | null = null
          try {
            const st = await fsp.stat(src)
            preparedFallback = createPreparedSiblingPath(dest)
            const writeDest = preparedFallback
            if (st.isDirectory()) {
              const r = await copyDirRecursive(src, writeDest, event, controller.signal)
              if (r.success) {
                controller.signal.throwIfAborted()
                if (conflict === 'overwrite') await commitPreparedPath(writeDest, dest)
                else await movePathWithoutOverwrite(writeDest, dest)
                await shell.trashItem(src)
                results.push({ path: src, success: true })
              } else {
                await discardPreparedPath(writeDest)
                results.push({ path: src, success: false, error: r.error })
              }
            } else {
              const r = await copyFileWithProgress(src, writeDest, event, controller.signal)
              if (r.success) {
                controller.signal.throwIfAborted()
                if (conflict === 'overwrite') await commitPreparedPath(writeDest, dest)
                else {
                  await publishFileWithoutOverwrite(writeDest, dest)
                  await fsp.unlink(writeDest)
                }
                await shell.trashItem(src)
                results.push({ path: src, success: true })
              } else {
                await discardPreparedPath(writeDest)
                results.push({ path: src, success: false, error: r.error })
              }
            }
          } catch (e2: unknown) {
            if (preparedFallback) await discardPreparedPath(preparedFallback)
            results.push({ path: src, success: false, error: errorMessage(e2) })
          }
        }
      }
      const movedSources = results.filter((result) => result.success).map((result) => result.path)
      if (movedSources.length > 0) {
        invalidateFileManagerFolderSizeCache([...movedSources, destDir])
      }
      if (currentFileOperation === controller) currentFileOperation = null
      return results
    },
  )

  // ═════════════════════════════════════════════════════════════
  // Directory watcher — auto-refresh when files change
  // ═════════════════════════════════════════════════════════════

  secureIpcMain.handle('fm-watch-dir', (event, dirPath: string) => {
    const normalizedDir = normalizeUserPath(dirPath)
    if (!normalizedDir) return
    trackDirWatcherSender(event.sender)
    const existing = dirWatchers.get(normalizedDir)
    if (existing) {
      retainDirWatcherOwner(existing, event.sender.id)
      return
    }

    let entry: DirWatcherEntry

    const sendChange = createDirChangeSender(getWindow, normalizedDir)

    const watcher = fs.watch(normalizedDir, { persistent: false }, (_eventType, filename) => {
      const changedName = filename?.toString()
      const candidate = changedName ? path.resolve(normalizedDir, changedName) : normalizedDir
      const changedPath =
        changedName && !changedName.includes('\0') && isSameOrNestedPath(normalizedDir, candidate)
          ? candidate
          : normalizedDir
      invalidateFileManagerFolderSizeCache([changedPath])
      sendChange(entry)
    })

    entry = {
      watcher,
      count: 1,
      timer: null,
      owners: new Map([[event.sender.id, 1]]),
      closed: false,
    }
    dirWatchers.set(normalizedDir, entry)

    watcher.on('error', () => {
      removeDirWatcher(normalizedDir, entry)
    })
  })

  secureIpcMain.handle('fm-unwatch-dir', (event, dirPath: string) => {
    const normalizedDir = normalizeUserPath(dirPath)
    if (!normalizedDir) return
    const entry = dirWatchers.get(normalizedDir)
    if (!entry) return
    releaseDirWatcherOwner(normalizedDir, entry, event.sender.id)
  })
}
