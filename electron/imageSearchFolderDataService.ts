import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  ImageSearchFolderDataEditPreview,
  ImageSearchFolderDataEditProgress,
  ImageSearchFolderDataEditResult,
  ImageSearchFolderDataLayer,
  ImageSearchFolderDataLayerStats,
} from '../shared/ipc-contract'
import {
  extractJsonStringField,
  isImageDataPathWithin,
  normalizedImageDataPathKey,
} from './imageSearchDataPathUtils'

interface ShardPreview {
  filePath: string
  layer: 'dino' | 'clip'
  modelBase: string
  size: number
  mtimeMs: number
  matchedCount: number
  matchedRecords: number
  matchedBytes: number
  matchedPathKeys: string[]
}

interface StoredPreview {
  preview: ImageSearchFolderDataEditPreview
  userDataPath: string
  folderKeys: string[]
  shards: ShardPreview[]
}

interface NativeStats {
  count: number
  totalBytes: number
}

interface NativeDeleteResult {
  ok: boolean
  removedCount?: number
  error?: string
}

interface AuxiliaryDeleteResult {
  removed: number
  warning?: string
}

export interface FolderDataEditHooks {
  deleteNative?: (folder: string) => Promise<NativeDeleteResult>
  cleanupAuxiliary?: (
    folder: string,
    layers: ImageSearchFolderDataLayer[],
  ) => Promise<AuxiliaryDeleteResult>
  invalidateRuntimeCaches?: (layers: ImageSearchFolderDataLayer[]) => void
}

const PREVIEW_TTL_MS = 15 * 60 * 1000
const BACKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000
const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024
const MAX_EDIT_LINE_BYTES = 8 * 1024 * 1024

const previews = new Map<string, StoredPreview>()
let cancelRequested = false
let progress: ImageSearchFolderDataEditProgress = {
  state: 'idle',
  processedBytes: 0,
  totalBytes: 0,
  removedRecords: 0,
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(12).toString('hex')}`
}

function updateProgress(update: Partial<ImageSearchFolderDataEditProgress>): void {
  progress = { ...progress, ...update, updatedAt: Date.now() }
}

function isWithinFolderKey(candidate: string, folderKey: string): boolean {
  return isImageDataPathWithin(candidate, folderKey)
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!path.isAbsolute(relative) && !relative.startsWith('..'))
}

function isFilesystemRootKey(folderKey: string): boolean {
  if (!folderKey) return false
  return normalizedImageDataPathKey(path.win32.parse(folderKey).root) === folderKey
}

export function isImageSearchFolderWithinRoots(folder: string, roots: readonly string[]): boolean {
  const folderKey = normalizedImageDataPathKey(folder)
  return roots.some((root) => isWithinFolderKey(folderKey, normalizedImageDataPathKey(root)))
}

// Embedding JSONL rows place imageId near the front while the vector can be
// tens of kilobytes. Decode only the JSON string field so a folder preview does
// not parse and allocate every vector in a multi-gigabyte shard.
function layerForShardName(name: string): 'dino' | 'clip' | null {
  const lowered = name.toLowerCase()
  if (!lowered.endsWith('__global.jsonl')) return null
  if (lowered.includes('dino')) return 'dino'
  if (lowered.includes('clip')) return 'clip'
  return null
}

async function* readBoundedJsonLines(
  filePath: string,
): AsyncGenerator<{ line: string; raw: Buffer; physicalBytes: number }> {
  let pending = Buffer.alloc(0)
  const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })
  for await (const chunkValue of stream) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue)
    const buffer = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
    let lineStart = 0
    for (let cursor = 0; cursor < buffer.length; cursor++) {
      if (buffer[cursor] !== 0x0a) continue
      const rawLine = buffer.subarray(lineStart, cursor)
      if (rawLine.length > MAX_EDIT_LINE_BYTES) {
        throw new Error(
          `Embedding row exceeds the safe 8 MiB edit limit: ${path.basename(filePath)}`,
        )
      }
      const content = rawLine.at(-1) === 0x0d ? rawLine.subarray(0, rawLine.length - 1) : rawLine
      yield {
        line: content.toString('utf8'),
        raw: buffer.subarray(lineStart, cursor + 1),
        physicalBytes: rawLine.length + 1,
      }
      lineStart = cursor + 1
    }
    const remaining = buffer.length - lineStart
    if (remaining > MAX_EDIT_LINE_BYTES) {
      throw new Error(`Embedding row exceeds the safe 8 MiB edit limit: ${path.basename(filePath)}`)
    }
    pending = remaining > 0 ? Buffer.from(buffer.subarray(lineStart)) : Buffer.alloc(0)
  }
  if (pending.length > 0) {
    const content = pending.at(-1) === 0x0d ? pending.subarray(0, pending.length - 1) : pending
    yield { line: content.toString('utf8'), raw: pending, physicalBytes: pending.length }
  }
}

async function listEmbeddingShards(
  userDataPath: string,
  selected: ReadonlySet<ImageSearchFolderDataLayer>,
): Promise<
  Array<Omit<ShardPreview, 'matchedCount' | 'matchedRecords' | 'matchedBytes' | 'matchedPathKeys'>>
> {
  const resolvedUserData = path.resolve(userDataPath)
  let trustedRoot: string
  let directory: string
  let entries: fs.Dirent[]
  try {
    trustedRoot = await fs.promises.realpath(resolvedUserData)
    const requestedDirectory = path.join(resolvedUserData, 'vector-db', 'embeddings')
    const directoryStat = await fs.promises.lstat(requestedDirectory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return []
    directory = await fs.promises.realpath(requestedDirectory)
    if (!isPathInside(trustedRoot, directory)) return []
    entries = await fs.promises.readdir(directory, { withFileTypes: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw error
  }
  const result: Array<
    Omit<ShardPreview, 'matchedCount' | 'matchedRecords' | 'matchedBytes' | 'matchedPathKeys'>
  > = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue
    const layer = layerForShardName(entry.name)
    if (!layer || !selected.has(layer)) continue
    const filePath = path.join(directory, entry.name)
    const stat = await fs.promises.lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) continue
    const realFile = await fs.promises.realpath(filePath)
    if (!isPathInside(trustedRoot, realFile)) continue
    result.push({
      filePath: realFile,
      layer,
      modelBase: entry.name.slice(0, -'.jsonl'.length),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    })
  }
  return result.sort((left, right) => left.filePath.localeCompare(right.filePath))
}

async function scanShardForFolder(
  shard: Omit<ShardPreview, 'matchedCount' | 'matchedRecords' | 'matchedBytes' | 'matchedPathKeys'>,
  folderKeys: readonly string[],
  baseProcessedBytes: number,
  totalBytes: number,
): Promise<ShardPreview> {
  const matchedPaths = new Set<string>()
  let matchedRecords = 0
  let matchedBytes = 0
  let processedBytes = 0
  let rows = 0
  for await (const { line, physicalBytes: lineBytes } of readBoundedJsonLines(shard.filePath)) {
    if (cancelRequested) throw new Error('Folder index edit cancelled')
    processedBytes += lineBytes
    const imageId = extractJsonStringField(line, 'imageId')
    const imageKey = imageId ? normalizedImageDataPathKey(imageId) : ''
    if (folderKeys.some((folderKey) => isWithinFolderKey(imageKey, folderKey))) {
      matchedRecords++
      matchedBytes += lineBytes
      matchedPaths.add(imageKey)
    }
    rows++
    if (rows % 1000 === 0) {
      updateProgress({
        currentFile: path.basename(shard.filePath),
        processedBytes: Math.min(totalBytes, baseProcessedBytes + processedBytes),
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  updateProgress({
    currentFile: path.basename(shard.filePath),
    processedBytes: Math.min(totalBytes, baseProcessedBytes + shard.size),
  })
  return {
    ...shard,
    matchedCount: matchedPaths.size,
    matchedRecords,
    matchedBytes,
    matchedPathKeys: [...matchedPaths],
  }
}

function emptyLayerStats(): ImageSearchFolderDataLayerStats {
  return { count: 0, recordCount: 0, matchedBytes: 0, sourceBytes: 0, fileCount: 0 }
}

function aggregateLayerStats(shards: ShardPreview[], layer: 'dino' | 'clip') {
  const selected = shards.filter((shard) => shard.layer === layer)
  const uniquePaths = new Set(selected.flatMap((shard) => shard.matchedPathKeys))
  return selected.reduce<ImageSearchFolderDataLayerStats>(
    (sum, shard) => ({
      count: uniquePaths.size,
      recordCount: sum.recordCount + shard.matchedRecords,
      matchedBytes: sum.matchedBytes + shard.matchedBytes,
      sourceBytes: sum.sourceBytes + shard.size,
      fileCount: sum.fileCount + 1,
    }),
    emptyLayerStats(),
  )
}

function selectedLayers(
  value: readonly ImageSearchFolderDataLayer[],
): ImageSearchFolderDataLayer[] {
  const allowed = new Set<ImageSearchFolderDataLayer>(['native', 'dino', 'clip'])
  return [...new Set(value.filter((layer) => allowed.has(layer)))]
}

export async function previewImageSearchFolderDataEdit(options: {
  userDataPath: string
  folder: string
  layers: ImageSearchFolderDataLayer[]
  allowedRoots: string[]
  nativeStats: NativeStats
  /** Reserved for the source cleanup flow, which has a separate two-step confirmation. */
  allowFilesystemRoot?: boolean
  /** Additional generated-image roots (for example video frame directories). */
  additionalFolders?: string[]
}): Promise<ImageSearchFolderDataEditPreview> {
  if (isImageSearchFolderDataEditRunning()) {
    return { ok: false, error: 'Another folder index operation is already running' }
  }
  const layers = selectedLayers(options.layers)
  if (layers.length === 0) return { ok: false, error: 'Select at least one index layer' }
  const folder = path.resolve(options.folder)
  const folderKey = normalizedImageDataPathKey(folder)
  const additionalFolderKeys = (options.additionalFolders || [])
    .map((value) => normalizedImageDataPathKey(value))
    .filter(Boolean)
  const folderKeys = [...new Set([folderKey, ...additionalFolderKeys])]
  if (!folderKey) return { ok: false, error: 'Invalid folder path' }
  if (isFilesystemRootKey(folderKey) && !options.allowFilesystemRoot) {
    return { ok: false, error: 'Select a folder below the drive or network-share root' }
  }

  cancelRequested = false
  const startedAt = Date.now()
  progress = {
    state: 'previewing',
    phase: 'scan',
    folder,
    processedBytes: 0,
    totalBytes: 0,
    removedRecords: 0,
    startedAt,
    updatedAt: startedAt,
  }
  try {
    const selected = new Set(layers)
    const sources = await listEmbeddingShards(options.userDataPath, selected)
    const totalBytes = sources.reduce((sum, shard) => sum + shard.size, 0)
    updateProgress({ totalBytes })
    const shards: ShardPreview[] = []
    let baseProcessedBytes = 0
    for (const shard of sources) {
      const scanned = await scanShardForFolder(shard, folderKeys, baseProcessedBytes, totalBytes)
      shards.push(scanned)
      baseProcessedBytes += shard.size
    }

    const native: ImageSearchFolderDataLayerStats = selected.has('native')
      ? {
          count: Math.max(0, options.nativeStats.count),
          recordCount: Math.max(0, options.nativeStats.count),
          matchedBytes: Math.max(0, options.nativeStats.totalBytes),
          sourceBytes: 0,
          fileCount: options.nativeStats.count > 0 ? 1 : 0,
        }
      : emptyLayerStats()
    const dino = aggregateLayerStats(shards, 'dino')
    const clip = aggregateLayerStats(shards, 'clip')
    const matched = native.count + dino.count + clip.count
    if (!isImageSearchFolderWithinRoots(folder, options.allowedRoots) && matched === 0) {
      throw new Error('Folder is outside the configured scan paths and has no indexed data')
    }
    const changedShards = shards.filter((shard) => shard.matchedRecords > 0)
    const cacheInventory = await inventoryDerivedCacheFiles(options.userDataPath, changedShards)

    const createdAt = Date.now()
    const preview: ImageSearchFolderDataEditPreview = {
      ok: true,
      token: randomId('folder-data-edit-preview'),
      folder,
      createdAt,
      expiresAt: createdAt + PREVIEW_TTL_MS,
      selectedLayers: layers,
      native,
      dino,
      clip,
      temporaryBytes: shards
        .filter((shard) => shard.matchedRecords > 0)
        .reduce((sum, shard) => sum + Math.max(0, shard.size - shard.matchedBytes), 0),
      invalidatedCacheFiles: cacheInventory.fileCount,
      invalidatedCacheBytes: cacheInventory.bytes,
    }
    previews.clear()
    previews.set(preview.token!, {
      preview,
      userDataPath: path.resolve(options.userDataPath),
      folderKeys,
      shards,
    })
    updateProgress({
      state: 'ready',
      processedBytes: totalBytes,
      currentFile: undefined,
      finishedAt: Date.now(),
    })
    return preview
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    updateProgress({
      state: cancelRequested ? 'cancelled' : 'error',
      error: message,
      finishedAt: Date.now(),
    })
    return { ok: false, error: message }
  }
}

function sameFingerprint(shard: ShardPreview, stat: fs.Stats): boolean {
  return stat.isFile() && stat.size === shard.size && stat.mtimeMs === shard.mtimeMs
}

async function finishWriter(writer: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      writer.off('finish', onFinish)
      reject(error)
    }
    const onFinish = () => {
      writer.off('error', onError)
      resolve()
    }
    writer.once('error', onError)
    writer.once('finish', onFinish)
    writer.end()
  })
}

async function writeChunk(writer: fs.WriteStream, value: Uint8Array): Promise<void> {
  if (writer.write(value)) return
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      writer.off('drain', onDrain)
      reject(error)
    }
    const onDrain = () => {
      writer.off('error', onError)
      resolve()
    }
    writer.once('error', onError)
    writer.once('drain', onDrain)
  })
}

interface SwitchedShard {
  sourcePath: string
  backupPath: string
  metadataPath: string
  removedPathKeys: string[]
  removedRecords: number
  removedBytes: number
}

async function rewriteShard(
  shard: ShardPreview,
  folderKeys: readonly string[],
  baseProcessedBytes: number,
  baseRemovedRecords: number,
  totalBytes: number,
): Promise<SwitchedShard> {
  const stamp = Date.now()
  const temporaryPath = `${shard.filePath}.folder-edit-${process.pid}-${stamp}.tmp`
  const backupPath = `${shard.filePath}.gc-backup-${stamp}`
  const metadataPath = `${backupPath}.json`
  const writer = fs.createWriteStream(temporaryPath, { encoding: 'utf8', flags: 'wx' })
  let streamError: Error | null = null
  writer.on('error', (error) => {
    streamError = error
  })
  const removedPaths = new Set<string>()
  let removedRecords = 0
  let processedBytes = 0
  let rows = 0
  try {
    for await (const { line, raw, physicalBytes: lineBytes } of readBoundedJsonLines(
      shard.filePath,
    )) {
      if (cancelRequested) throw new Error('Folder index edit cancelled')
      if (streamError) throw streamError
      processedBytes += lineBytes
      const imageId = extractJsonStringField(line, 'imageId')
      const imageKey = imageId ? normalizedImageDataPathKey(imageId) : ''
      if (folderKeys.some((folderKey) => isWithinFolderKey(imageKey, folderKey))) {
        removedRecords++
        removedPaths.add(imageKey)
      } else {
        await writeChunk(writer, raw)
      }
      rows++
      if (rows % 1000 === 0) {
        updateProgress({
          currentFile: path.basename(shard.filePath),
          processedBytes: Math.min(totalBytes, baseProcessedBytes + processedBytes),
          removedRecords: baseRemovedRecords + removedRecords,
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    if (streamError) throw streamError
    await finishWriter(writer)
    if (removedRecords !== shard.matchedRecords || removedPaths.size !== shard.matchedCount) {
      throw new Error(
        `Folder preview changed for ${path.basename(shard.filePath)}; scan again before confirming`,
      )
    }
    const sourceStat = await fs.promises.lstat(shard.filePath)
    if (!sameFingerprint(shard, sourceStat)) {
      throw new Error(
        `Embedding shard changed during rewrite: ${path.basename(shard.filePath)}; analyze again`,
      )
    }
    await fs.promises.rename(shard.filePath, backupPath)
    try {
      await fs.promises.rename(temporaryPath, shard.filePath)
      await fs.promises.writeFile(
        metadataPath,
        JSON.stringify(
          {
            version: 1,
            kind: 'folder-data-edit',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + BACKUP_TTL_MS).toISOString(),
            source: path.basename(shard.filePath),
            backup: path.basename(backupPath),
            folder: folderKeys[0],
            additionalFolders: folderKeys.slice(1),
            removedRecords,
            removedImages: removedPaths.size,
          },
          null,
          2,
        ),
        { encoding: 'utf8', flag: 'wx' },
      )
    } catch (error) {
      try {
        await fs.promises.unlink(shard.filePath)
      } catch {
        /* the edited target may not have been installed */
      }
      await fs.promises.rename(backupPath, shard.filePath)
      throw error
    }
    updateProgress({
      processedBytes: Math.min(totalBytes, baseProcessedBytes + shard.size),
      removedRecords: baseRemovedRecords + removedRecords,
    })
    return {
      sourcePath: shard.filePath,
      backupPath,
      metadataPath,
      removedPathKeys: [...removedPaths],
      removedRecords,
      removedBytes: shard.matchedBytes,
    }
  } catch (error) {
    writer.destroy()
    try {
      await fs.promises.unlink(temporaryPath)
    } catch {
      /* temporary output may not exist */
    }
    throw error
  }
}

async function rollbackSwitchedShards(switched: SwitchedShard[]): Promise<string[]> {
  const errors: string[] = []
  for (const item of [...switched].reverse()) {
    const editedPath = `${item.sourcePath}.folder-edit-rollback-${process.pid}-${Date.now()}.tmp`
    try {
      await fs.promises.rename(item.sourcePath, editedPath)
      try {
        await fs.promises.rename(item.backupPath, item.sourcePath)
      } catch (error) {
        // Never leave the authoritative pathname empty if restoring the backup
        // is interrupted by antivirus, permissions, or a transient file lock.
        try {
          await fs.promises.rename(editedPath, item.sourcePath)
        } catch {
          /* the combined rollback error below retains the recovery paths */
        }
        throw error
      }
      try {
        await fs.promises.unlink(editedPath)
      } catch (error: unknown) {
        errors.push(
          `${path.basename(item.sourcePath)} edited-copy cleanup warning: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
      try {
        await fs.promises.unlink(item.metadataPath)
      } catch {
        /* recovery metadata may not have been written */
      }
    } catch (error: unknown) {
      errors.push(
        `${path.basename(item.sourcePath)} rollback failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  return errors
}

async function purgeSwitchedBackups(switched: SwitchedShard[]): Promise<string[]> {
  const warnings: string[] = []
  for (const item of switched) {
    for (const target of [item.backupPath, item.metadataPath]) {
      try {
        await fs.promises.unlink(target)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          warnings.push(
            `Could not purge folder-edit backup ${path.basename(target)}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
      }
    }
  }
  return warnings
}

interface CacheInvalidationPlan {
  movedMarkers: Array<{ original: string; stale: string }>
  deleteTargets: string[]
}

async function inventoryDerivedCacheFiles(
  userDataPath: string,
  changedShards: readonly ShardPreview[],
): Promise<{ fileCount: number; bytes: number }> {
  if (changedShards.length === 0) return { fileCount: 0, bytes: 0 }
  const requestedUserData = path.resolve(userDataPath)
  const trustedRoot = await fs.promises.realpath(requestedUserData)
  const requestedVectorDb = path.join(requestedUserData, 'vector-db')
  let vectorDb: string
  try {
    const stat = await fs.promises.lstat(requestedVectorDb)
    vectorDb = await fs.promises.realpath(requestedVectorDb)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isPathInside(trustedRoot, vectorDb)) {
      throw new Error('Vector data directory is linked outside the application data directory')
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { fileCount: 0, bytes: 0 }
    throw error
  }

  const modelBases = [...new Set(changedShards.map((shard) => shard.modelBase))]
  const candidates = new Set<string>([
    path.join(vectorDb, 'vector_index_manifest.json'),
    ...modelBases.map((base) => path.join(vectorDb, 'embedding-cache', `${base}.f16.json`)),
  ])
  if (changedShards.some((shard) => shard.layer === 'clip')) {
    candidates.add(path.join(vectorDb, 'clip_embedding_cache.json'))
    candidates.add(path.join(vectorDb, 'clip_embedding_cache.f32'))
    candidates.add(path.join(vectorDb, 'clip_embedding_paths.jsonl'))
  }
  const cacheDir = path.join(vectorDb, 'embedding-cache')
  try {
    const cacheStat = await fs.promises.lstat(cacheDir)
    const realCacheDir = await fs.promises.realpath(cacheDir)
    if (
      !cacheStat.isDirectory() ||
      cacheStat.isSymbolicLink() ||
      !isPathInside(trustedRoot, realCacheDir)
    ) {
      throw new Error('Vector cache directory is linked outside the application data directory')
    }
    for (const entry of await fs.promises.readdir(realCacheDir, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        modelBases.some((base) => entry.name.startsWith(`${base}.`))
      ) {
        candidates.add(path.join(realCacheDir, entry.name))
      }
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }

  let fileCount = 0
  let bytes = 0
  for (const candidate of candidates) {
    try {
      const stat = await fs.promises.lstat(candidate)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      const realFile = await fs.promises.realpath(candidate)
      if (!isPathInside(trustedRoot, realFile)) {
        throw new Error('Vector cache file is linked outside the application data directory')
      }
      fileCount += 1
      bytes += stat.size
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
  }
  return { fileCount, bytes }
}

async function prepareDerivedCacheInvalidation(
  userDataPath: string,
  changedShards: ShardPreview[],
): Promise<CacheInvalidationPlan> {
  const trustedRoot = await fs.promises.realpath(path.resolve(userDataPath))
  const requestedVectorDb = path.join(path.resolve(userDataPath), 'vector-db')
  const vectorDbStat = await fs.promises.lstat(requestedVectorDb)
  const vectorDb = await fs.promises.realpath(requestedVectorDb)
  if (
    !vectorDbStat.isDirectory() ||
    vectorDbStat.isSymbolicLink() ||
    !isPathInside(trustedRoot, vectorDb)
  ) {
    throw new Error('Vector data directory is linked outside the application data directory')
  }
  const requestedCacheDir = path.join(vectorDb, 'embedding-cache')
  let cacheDir = requestedCacheDir
  try {
    const cacheStat = await fs.promises.lstat(requestedCacheDir)
    const realCacheDir = await fs.promises.realpath(requestedCacheDir)
    if (
      !cacheStat.isDirectory() ||
      cacheStat.isSymbolicLink() ||
      !isPathInside(trustedRoot, realCacheDir)
    ) {
      throw new Error('Vector cache directory is linked outside the application data directory')
    }
    cacheDir = realCacheDir
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const stamp = Date.now()
  const modelBases = [...new Set(changedShards.map((shard) => shard.modelBase))]
  const markers = modelBases.map((base) => path.join(cacheDir, `${base}.f16.json`))
  if (changedShards.some((shard) => shard.layer === 'clip')) {
    markers.push(path.join(vectorDb, 'clip_embedding_cache.json'))
  }
  markers.push(path.join(vectorDb, 'vector_index_manifest.json'))

  const movedMarkers: CacheInvalidationPlan['movedMarkers'] = []
  try {
    for (const marker of [...new Set(markers)]) {
      try {
        const stat = await fs.promises.lstat(marker)
        if (!stat.isFile() || stat.isSymbolicLink()) continue
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue
        throw error
      }
      const realMarker = await fs.promises.realpath(marker)
      if (!isPathInside(trustedRoot, realMarker)) {
        throw new Error('Vector cache file is linked outside the application data directory')
      }
      const stale = `${realMarker}.folder-edit-stale-${stamp}.bak`
      await fs.promises.rename(realMarker, stale)
      movedMarkers.push({ original: realMarker, stale })
    }
  } catch (error) {
    for (const item of [...movedMarkers].reverse()) {
      try {
        await fs.promises.rename(item.stale, item.original)
      } catch {
        /* surfaced by the original invalidation failure */
      }
    }
    throw error
  }

  const deleteTargets = movedMarkers.map((item) => item.stale)
  try {
    const entries = await fs.promises.readdir(cacheDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !modelBases.some((base) => entry.name.startsWith(`${base}.`))) continue
      deleteTargets.push(path.join(cacheDir, entry.name))
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      await restoreCacheMarkers({ movedMarkers, deleteTargets: [] })
      throw error
    }
  }
  if (changedShards.some((shard) => shard.layer === 'clip')) {
    deleteTargets.push(
      path.join(vectorDb, 'clip_embedding_cache.f32'),
      path.join(vectorDb, 'clip_embedding_paths.jsonl'),
    )
  }
  return { movedMarkers, deleteTargets: [...new Set(deleteTargets)] }
}

async function restoreCacheMarkers(plan: CacheInvalidationPlan): Promise<void> {
  for (const item of [...plan.movedMarkers].reverse()) {
    try {
      await fs.promises.rename(item.stale, item.original)
    } catch {
      /* rollback errors are reported through the shard rollback path */
    }
  }
}

async function deleteDerivedCacheFiles(plan: CacheInvalidationPlan): Promise<{
  removed: number
  freedBytes: number
  warnings: string[]
}> {
  let removed = 0
  let freedBytes = 0
  const warnings: string[] = []
  for (const target of plan.deleteTargets) {
    try {
      const stat = await fs.promises.lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      await fs.promises.unlink(target)
      removed++
      freedBytes += stat.size
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        warnings.push(
          `Could not remove derived cache ${path.basename(target)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
  }
  return { removed, freedBytes, warnings }
}

function resultRecords(): Record<ImageSearchFolderDataLayer, number> {
  return { native: 0, dino: 0, clip: 0 }
}

export async function executeImageSearchFolderDataEdit(options: {
  userDataPath: string
  token: string
  allowedRoots: string[]
  hooks?: FolderDataEditHooks
  /** Source-scoped deletion is final, so it must not retain copies of removed vectors. */
  purgeBackupsOnSuccess?: boolean
  /** Run the Native hook even when this source is already hidden by a persisted overlay. */
  forceNativeMaintenance?: boolean
}): Promise<ImageSearchFolderDataEditResult> {
  if (isImageSearchFolderDataEditRunning()) {
    return { ok: false, error: 'Another folder index operation is already running' }
  }
  const stored = previews.get(options.token)
  if (!stored || stored.userDataPath !== path.resolve(options.userDataPath)) {
    return { ok: false, error: 'Folder edit preview is missing or invalid' }
  }
  const preview = stored.preview
  if (!preview.folder || !preview.expiresAt || preview.expiresAt < Date.now()) {
    previews.delete(options.token)
    return { ok: false, error: 'Folder edit preview expired; analyze the folder again' }
  }
  const layers = selectedLayers(preview.selectedLayers || [])
  const previewMatches = layers.reduce((sum, layer) => sum + (preview[layer]?.count || 0), 0)
  if (
    !isImageSearchFolderWithinRoots(preview.folder, options.allowedRoots) &&
    previewMatches === 0
  ) {
    return { ok: false, error: 'Folder is outside the configured scan paths' }
  }
  previews.delete(options.token)
  cancelRequested = false
  const startedAt = Date.now()
  const shardsToRewrite = stored.shards.filter((shard) => shard.matchedRecords > 0)
  const totalBytes = shardsToRewrite.reduce((sum, shard) => sum + shard.size, 0)
  progress = {
    state: 'rewriting',
    phase: 'rewrite',
    folder: preview.folder,
    processedBytes: 0,
    totalBytes,
    removedRecords: 0,
    startedAt,
    updatedAt: startedAt,
  }
  const removed = resultRecords()
  const removedRecords = resultRecords()
  const removedPathKeys = {
    dino: new Set<string>(),
    clip: new Set<string>(),
  }
  const warnings: string[] = []
  const switched: SwitchedShard[] = []
  let cachePlan: CacheInvalidationPlan | null = null
  let invalidatedCacheFiles = 0
  let invalidatedCacheBytes = 0
  let auxiliaryRemoved = 0
  try {
    for (const shard of stored.shards) {
      const stat = await fs.promises.lstat(shard.filePath)
      if (!sameFingerprint(shard, stat)) {
        throw new Error(
          `Embedding shard changed after preview: ${path.basename(shard.filePath)}; analyze again`,
        )
      }
    }
    if (shardsToRewrite.length > 0) {
      const directory = path.dirname(shardsToRewrite[0].filePath)
      const disk = fs.statfsSync(directory)
      const availableBytes = disk.bavail * disk.bsize
      const requiredBytes = (preview.temporaryBytes || 0) + FREE_SPACE_MARGIN_BYTES
      if (availableBytes < requiredBytes) {
        throw new Error(
          `Not enough free space for atomic folder edit (${requiredBytes.toLocaleString()} bytes required)`,
        )
      }
      try {
        // Stop readers and release process-local handles before the first
        // authoritative shard is rewritten, not after the switch.
        options.hooks?.invalidateRuntimeCaches?.(layers)
      } catch (error: unknown) {
        warnings.push(
          `Runtime cache reset warning: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    let baseProcessedBytes = 0
    let baseRemovedRecords = 0
    for (const shard of shardsToRewrite) {
      const result = await rewriteShard(
        shard,
        stored.folderKeys,
        baseProcessedBytes,
        baseRemovedRecords,
        totalBytes,
      )
      switched.push(result)
      for (const imageKey of result.removedPathKeys) removedPathKeys[shard.layer].add(imageKey)
      removed[shard.layer] = removedPathKeys[shard.layer].size
      removedRecords[shard.layer] += result.removedRecords
      baseProcessedBytes += shard.size
      baseRemovedRecords += result.removedRecords
    }
    if (cancelRequested) throw new Error('Folder index edit cancelled')

    if (shardsToRewrite.length > 0) {
      updateProgress({ state: 'finalizing', phase: 'cache', currentFile: undefined })
      cachePlan = await prepareDerivedCacheInvalidation(options.userDataPath, shardsToRewrite)
      const cacheResult = await deleteDerivedCacheFiles(cachePlan)
      invalidatedCacheFiles = cacheResult.removed
      invalidatedCacheBytes = cacheResult.freedBytes
      warnings.push(...cacheResult.warnings)
    }

    updateProgress({ state: 'finalizing', phase: 'cache' })
    if (options.hooks?.cleanupAuxiliary) {
      try {
        const auxiliary = await options.hooks.cleanupAuxiliary(preview.folder, layers)
        auxiliaryRemoved = auxiliary.removed
        if (auxiliary.warning) warnings.push(auxiliary.warning)
      } catch (error: unknown) {
        warnings.push(
          `Auxiliary vector data cleanup warning: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }

    if (
      layers.includes('native') &&
      ((preview.native?.count || 0) > 0 || options.forceNativeMaintenance) &&
      options.hooks?.deleteNative
    ) {
      updateProgress({ state: 'finalizing', phase: 'native' })
      let nativeResult: NativeDeleteResult
      try {
        nativeResult = await options.hooks.deleteNative(preview.folder)
      } catch (error: unknown) {
        nativeResult = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (!nativeResult.ok) {
        const partial = removed.dino + removed.clip
        const message = `${nativeResult.error || 'Native folder index deletion failed'}${
          partial > 0
            ? '; DINO/CLIP changes were committed; analyze again before retrying Native'
            : ''
        }`
        updateProgress({ state: 'error', error: message, finishedAt: Date.now() })
        return {
          ok: false,
          folder: preview.folder,
          removedCount: removed.dino + removed.clip,
          removed,
          removedRecords,
          auxiliaryRemoved,
          invalidatedCacheFiles,
          invalidatedCacheBytes,
          backupCount: switched.length,
          pendingReleaseBytes: switched.reduce((sum, item) => sum + item.removedBytes, 0),
          warnings,
          error: message,
        }
      }
      removed.native = Math.max(0, nativeResult.removedCount || 0)
      removedRecords.native = removed.native
    }

    const removedCount = removed.native + removed.dino + removed.clip
    if (options.purgeBackupsOnSuccess) warnings.push(...(await purgeSwitchedBackups(switched)))
    const retainedBackups = options.purgeBackupsOnSuccess
      ? switched.filter((item) => fs.existsSync(item.backupPath))
      : switched
    updateProgress({
      state: 'completed',
      processedBytes: totalBytes,
      removedRecords: removedRecords.native + removedRecords.dino + removedRecords.clip,
      currentFile: undefined,
      finishedAt: Date.now(),
    })
    return {
      ok: true,
      folder: preview.folder,
      removedCount,
      removed,
      removedRecords,
      auxiliaryRemoved,
      invalidatedCacheFiles,
      invalidatedCacheBytes,
      backupCount: retainedBackups.length,
      pendingReleaseBytes: retainedBackups.reduce((sum, item) => sum + item.removedBytes, 0),
      warnings,
    }
  } catch (error: unknown) {
    if (cachePlan) await restoreCacheMarkers(cachePlan)
    const rollbackErrors = await rollbackSwitchedShards(switched)
    const message = error instanceof Error ? error.message : String(error)
    warnings.push(...rollbackErrors)
    updateProgress({
      state: cancelRequested ? 'cancelled' : 'error',
      error: rollbackErrors.length > 0 ? `${message}; ${rollbackErrors.join('; ')}` : message,
      finishedAt: Date.now(),
    })
    return {
      ok: false,
      folder: preview.folder,
      removedCount: 0,
      removed: resultRecords(),
      removedRecords: resultRecords(),
      warnings,
      error: rollbackErrors.length > 0 ? `${message}; ${rollbackErrors.join('; ')}` : message,
    }
  }
}

export function getImageSearchFolderDataEditProgress(): ImageSearchFolderDataEditProgress {
  return { ...progress }
}

export function cancelImageSearchFolderDataEdit(): { ok: boolean } {
  if (isImageSearchFolderDataEditRunning() && progress.state !== 'finalizing') {
    cancelRequested = true
  }
  return { ok: true }
}

export function isImageSearchFolderDataEditRunning(): boolean {
  return (
    progress.state === 'previewing' ||
    progress.state === 'rewriting' ||
    progress.state === 'finalizing'
  )
}

export function resetImageSearchFolderDataEditForTests(): void {
  previews.clear()
  cancelRequested = false
  progress = {
    state: 'idle',
    processedBytes: 0,
    totalBytes: 0,
    removedRecords: 0,
  }
}
