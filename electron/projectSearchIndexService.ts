import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { classifyProjectFile, type ProjectSourceExt } from '../shared/projectFileTypes'
import type { ImageHashResult, ImageSearchResult } from '../shared/ipc-contract'
import type { LayeredSearchResult } from '../shared/vectorTypes'
import type { NativeSearchHit } from './imageSearchNativeTypes'
import type { ProjectPreviewManifestEntry } from './projectPreviewManifest'
import { getProjectPreviewService } from './projectPreviewService'

const PROJECT_INDEX_EXTENSIONS = new Set<ProjectSourceExt>([
  'psd',
  'psb',
  'kra',
  'svg',
  'pdf',
  'ai',
  'eps',
  'tif',
  'tiff',
  'cr2',
  'cr3',
  'nef',
  'arw',
  'dng',
  'raf',
  'orf',
  'rw2',
  'pef',
  'srw',
  'clip',
  'cdr',
  'indd',
])
const PROJECT_HASH_THRESHOLD_SLACK = 2
const SKIPPED_DIRECTORY_NAMES = new Set([
  '$recycle.bin',
  '.git',
  '.next',
  '.nuxt',
  '.venv',
  '.vs',
  '__pycache__',
  'backup',
  'bin',
  'build',
  'cache',
  'caches',
  'cppbackup',
  'debug',
  'demobackup',
  'dist',
  'node_modules',
  'obj',
  'program files',
  'program files (x86)',
  'programdata',
  'release',
  'system volume information',
  'target',
  'temp',
  'tmp',
  'venv',
  'windows',
  'x64',
  'x86',
])
const MAX_PROJECT_SOURCES_PER_SCAN = 200_000

export interface ProjectSearchMetadata {
  sourceKind: 'project'
  sourceId: string
  sourcePath: string
  sourceExt: ProjectSourceExt
  displayType: string
  keywords: string[]
  previewProvider: string
  previewPath: string
  width?: number
  height?: number
  fileSize: number
  modifiedTime: number
}

export interface ProjectIndexAdapter {
  hashImageAsync(filePath: string): Promise<ImageHashResult>
  upsertIndexRecord(
    filePath: string,
    width: number,
    height: number,
    fileSize: number,
    modifiedTime: number,
    diffHash64: string,
    dctHash64: string,
  ): { ok: boolean; error?: string }
  deleteIndexPath(filePath: string): { ok: boolean; error?: string }
  removeSourceVectorData(sourcePath: string): void
}

export interface ProjectIndexProgress {
  phase: 'enumerating' | 'rendering' | 'complete'
  currentPath?: string
  discovered: number
  completed: number
  indexed: number
  unavailable: number
  failed: number
  removed: number
}

export interface ProjectIndexResult extends Omit<ProjectIndexProgress, 'phase' | 'currentPath'> {
  cancelled: boolean
  truncated: boolean
}

let configuredUserDataPath = ''
let previewRoot = ''
let entriesByPreview = new Map<string, ProjectPreviewManifestEntry>()
let entriesBySource = new Map<string, ProjectPreviewManifestEntry>()

export function mapNativeProjectSearchHits(hits: readonly NativeSearchHit[]): ImageSearchResult[] {
  const seenPaths = new Set<string>()
  const results: ImageSearchResult[] = []
  for (const hit of hits) {
    const project = getProjectSearchMetadata(hit.path)
    if (!project && isProjectPreviewProxy(hit.path)) continue
    const resultPath = project?.sourcePath ?? hit.path
    const key =
      process.platform === 'win32'
        ? path.resolve(resultPath).toLowerCase()
        : path.resolve(resultPath)
    if (seenPaths.has(key)) continue
    seenPaths.add(key)
    results.push({
      id: project?.sourceId ?? String(hit.id),
      path: resultPath,
      score: hit.score,
      distance: hit.distance,
      width: project?.width ?? hit.width,
      height: project?.height ?? hit.height,
      fileSize: project?.fileSize ?? hit.fileSize,
      modifiedTime: project?.modifiedTime,
      diffHash64: hit.diffHash64,
      ...(project
        ? {
            sourceKind: project.sourceKind,
            sourceExt: project.sourceExt,
            projectDisplayType: project.displayType,
            keywords: project.keywords,
            previewProvider: project.previewProvider,
          }
        : {}),
    })
  }
  return results
}

export function mergeProjectSearchHashFallback(
  hits: readonly NativeSearchHit[],
  queryDiffHash64: string | undefined,
  queryDctHash64: string | undefined,
  threshold: number,
): NativeSearchHit[] {
  const seen = new Set(hits.map((hit) => path.resolve(hit.path).toLowerCase()))
  const projectHits = searchProjectPreviewHashes(
    queryDiffHash64,
    queryDctHash64,
    threshold,
    25,
  ).filter((hit) => !seen.has(path.resolve(hit.path).toLowerCase()))
  return projectHits.length > 0 ? [...hits, ...projectHits] : [...hits]
}

interface ProjectMappableIndexRecord {
  path: string
  width: number
  height: number
  fileSize: number
  modifiedTime: number
  exists?: boolean
}

/** Map native preview proxies back to the source records exposed by the UI. */
export function mapProjectSearchIndexRecords<T extends ProjectMappableIndexRecord>(
  records: readonly T[],
): T[] {
  const mapped: T[] = []
  for (const record of records) {
    const project = getProjectSearchMetadata(record.path)
    if (!project && isProjectPreviewProxy(record.path)) continue
    mapped.push({
      ...record,
      path: project?.sourcePath ?? record.path,
      width: project?.width ?? record.width,
      height: project?.height ?? record.height,
      fileSize: project?.fileSize ?? record.fileSize,
      modifiedTime: project?.modifiedTime ?? record.modifiedTime,
      exists: project ? fs.existsSync(project.sourcePath) : record.exists,
    })
  }
  return mapped
}

export function collectProjectThumbnailSources(
  folder: string,
  records: readonly Pick<ProjectMappableIndexRecord, 'path' | 'modifiedTime'>[],
): Array<{ path: string; mtimeMs: number }> {
  const normalizedFolder = path.resolve(folder)
  const within = (candidate: string) => {
    const relative = path.relative(normalizedFolder, path.resolve(candidate))
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }
  const sources = new Map<string, { path: string; mtimeMs: number }>()
  for (const record of records) {
    if (typeof record.path !== 'string' || !within(record.path)) continue
    const key =
      process.platform === 'win32'
        ? path.resolve(record.path).toLowerCase()
        : path.resolve(record.path)
    sources.set(key, { path: record.path, mtimeMs: Number(record.modifiedTime) || 0 })
  }
  for (const entry of getProjectSearchEntriesInFolder(folder)) {
    const key =
      process.platform === 'win32'
        ? path.resolve(entry.sourcePath).toLowerCase()
        : path.resolve(entry.sourcePath)
    sources.set(key, { path: entry.sourcePath, mtimeMs: Number(entry.mtimeMs) || 0 })
  }
  return [...sources.values()]
}

export function collectProjectIndexedPaths(
  records: readonly Pick<ProjectMappableIndexRecord, 'path'>[],
): string[] {
  const paths = new Set<string>()
  for (const record of records) {
    if (typeof record.path !== 'string' || !record.path) continue
    paths.add(record.path)
    const project = getProjectSearchMetadata(record.path)
    if (project) paths.add(project.sourcePath)
  }
  return [...paths]
}

function normalizedKey(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  // path.relative returns an absolute path when the candidate sits on another drive.
  if (path.isAbsolute(relative)) return false
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function isWithinAnyRoot(roots: readonly string[], candidate: string): boolean {
  return roots.some((root) => isWithin(root, candidate))
}

function metadataForEntry(entry: ProjectPreviewManifestEntry): ProjectSearchMetadata | null {
  if (entry.status !== 'ready' || !entry.previewPath) return null
  const classification = classifyProjectFile(entry.sourcePath)
  if (!classification) return null
  return {
    sourceKind: 'project',
    sourceId: entry.sourceId,
    sourcePath: entry.sourcePath,
    sourceExt: entry.sourceExt,
    displayType: classification.displayType,
    keywords: [...entry.keywords],
    previewProvider: entry.provider,
    previewPath: entry.previewPath,
    width: entry.width,
    height: entry.height,
    fileSize: entry.size,
    modifiedTime: entry.mtimeMs,
  }
}

export async function initProjectSearchIndex(userDataPath: string): Promise<void> {
  configuredUserDataPath = path.resolve(userDataPath)
  const service = getProjectPreviewService(configuredUserDataPath)
  previewRoot = path.resolve(service.manifest.previewsDir)
  await refreshProjectSearchIndex()
}

export async function refreshProjectSearchIndex(): Promise<void> {
  if (!configuredUserDataPath) return
  const entries = await getProjectPreviewService(configuredUserDataPath).manifest.list()
  const nextByPreview = new Map<string, ProjectPreviewManifestEntry>()
  const nextBySource = new Map<string, ProjectPreviewManifestEntry>()
  for (const entry of entries) {
    if (entry.status !== 'ready' || !entry.previewPath) continue
    nextByPreview.set(normalizedKey(entry.previewPath), entry)
    nextBySource.set(normalizedKey(entry.sourcePath), entry)
  }
  entriesByPreview = nextByPreview
  entriesBySource = nextBySource
}

export function isProjectPreviewProxy(filePath: string): boolean {
  if (!previewRoot) return false
  return isWithin(previewRoot, filePath)
}

export function getProjectSearchMetadata(filePath: string): ProjectSearchMetadata | null {
  const key = normalizedKey(filePath)
  const entry = entriesByPreview.get(key) ?? entriesBySource.get(key)
  return entry ? metadataForEntry(entry) : null
}

export function resolveProjectSearchInputPath(filePath: string): string {
  return getProjectSearchMetadata(filePath)?.previewPath ?? filePath
}

/**
 * Entries whose sourcePath is the folder itself or lives under it. Used when a
 * folder is purged from the image index: project records are indexed under the
 * userData preview root, outside the purged folder prefix, so they must be
 * matched by their source path instead (H2). Returns an empty list when the
 * project preview lookup was never initialized.
 */
export function getProjectSearchEntriesInFolder(folder: string): ProjectPreviewManifestEntry[] {
  const normalizedFolder = path.resolve(folder).toLowerCase()
  const matches: ProjectPreviewManifestEntry[] = []
  for (const entry of entriesBySource.values()) {
    const normalizedSource = path.resolve(entry.sourcePath).toLowerCase()
    const rel = path.relative(normalizedFolder, normalizedSource)
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) matches.push(entry)
  }
  return matches
}

export async function deleteProjectSearchDataInFolder(folder: string): Promise<{
  removedEntries: number
  deletedFiles: number
  freedBytes: number
  warnings: string[]
}> {
  if (!configuredUserDataPath) {
    return { removedEntries: 0, deletedFiles: 0, freedBytes: 0, warnings: [] }
  }
  const entries = getProjectSearchEntriesInFolder(folder)
  if (entries.length === 0) {
    return { removedEntries: 0, deletedFiles: 0, freedBytes: 0, warnings: [] }
  }
  const warnings: string[] = []
  let deletedFiles = 0
  let freedBytes = 0
  const resolvedPreviewRoot = path.resolve(previewRoot)
  for (const entry of entries) {
    if (!entry.previewPath) continue
    const candidate = path.resolve(entry.previewPath)
    if (!isWithin(resolvedPreviewRoot, candidate) || candidate === resolvedPreviewRoot) {
      warnings.push(`Skipped project preview outside the managed preview directory`)
      continue
    }
    try {
      const stat = await fsp.lstat(candidate)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      await fsp.unlink(candidate)
      deletedFiles += 1
      freedBytes += stat.size
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        warnings.push(
          `Could not remove project preview: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
  }
  const removedEntries = await getProjectPreviewService(configuredUserDataPath).manifest.removeMany(
    entries.map((entry) => entry.sourcePath),
  )
  await refreshProjectSearchIndex()
  return { removedEntries, deletedFiles, freedBytes, warnings }
}

function hamming64(left: string, right: string): number {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`)
  let count = 0
  while (value) {
    value &= value - 1n
    count += 1
  }
  return count
}

export interface ProjectHashSearchHit {
  id: number
  path: string
  score: number
  distance: number
  dctDistance: number
  width: number
  height: number
  fileSize: number
  diffHash64: string
  dctHash64: string
}

export function searchProjectPreviewHashes(
  queryDiffHash64: string | undefined,
  queryDctHash64: string | undefined,
  threshold: number,
  limit = 25,
): ProjectHashSearchHit[] {
  if (!queryDiffHash64 || !/^[0-9a-f]{16}$/i.test(queryDiffHash64)) return []
  const effectiveThreshold = Math.min(64, threshold + PROJECT_HASH_THRESHOLD_SLACK)
  const hits: ProjectHashSearchHit[] = []
  let id = 0
  for (const entry of entriesByPreview.values()) {
    if (entry.status !== 'ready' || !entry.previewPath || !entry.diffHash64 || !entry.dctHash64) {
      continue
    }
    const distance = hamming64(queryDiffHash64, entry.diffHash64)
    if (distance > effectiveThreshold) continue
    const dctDistance =
      queryDctHash64 && /^[0-9a-f]{16}$/i.test(queryDctHash64)
        ? hamming64(queryDctHash64, entry.dctHash64)
        : 64
    hits.push({
      id: --id,
      path: entry.previewPath,
      score: ((64 - distance) / 64) * 0.7 + ((64 - dctDistance) / 64) * 0.3,
      distance,
      dctDistance,
      width: entry.width ?? 0,
      height: entry.height ?? 0,
      fileSize: entry.size,
      diffHash64: entry.diffHash64,
      dctHash64: entry.dctHash64,
    })
  }
  return hits
    .sort((left, right) => right.score - left.score || left.distance - right.distance)
    .slice(0, Math.max(1, limit))
}

export function mapProjectLayeredResults(
  results: readonly LayeredSearchResult[],
): LayeredSearchResult[] {
  return results.flatMap((result) => {
    const project = getProjectSearchMetadata(result.path)
    if (!project && isProjectPreviewProxy(result.path)) return []
    if (!project) return [result]
    return [
      {
        ...result,
        imageId: project.sourceId,
        path: project.sourcePath,
        width: project.width ?? result.width,
        height: project.height ?? result.height,
        fileSize: project.fileSize,
        modifiedTime: project.modifiedTime,
        sourceKind: project.sourceKind,
        sourceExt: project.sourceExt,
        projectDisplayType: project.displayType,
        keywords: project.keywords,
        previewProvider: project.previewProvider,
      },
    ]
  })
}

export async function prepareProjectSearchInput(filePath: string): Promise<string | null> {
  const classification = classifyProjectFile(filePath)
  if (!classification) return filePath
  if (!PROJECT_INDEX_EXTENSIONS.has(classification.sourceExt) || !configuredUserDataPath)
    return null
  const entry = await getProjectPreviewService(configuredUserDataPath).getOrCreate(filePath)
  await refreshProjectSearchIndex()
  return entry.status === 'ready' && entry.previewPath ? entry.previewPath : null
}

async function enumerateProjectSources(
  roots: readonly string[],
  isCancelled: () => boolean,
  onProgress?: (progress: ProjectIndexProgress) => void,
): Promise<{ sources: string[]; truncated: boolean }> {
  const stack = [...roots]
  const sources: string[] = []
  let scannedDirectories = 0
  let truncated = false
  while (stack.length > 0 && !isCancelled()) {
    const directory = stack.pop()!
    if (previewRoot && isWithin(previewRoot, directory)) continue
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    scannedDirectories += 1
    if (scannedDirectories === 1 || scannedDirectories % 100 === 0) {
      onProgress?.({
        phase: 'enumerating',
        currentPath: directory,
        discovered: sources.length,
        completed: 0,
        indexed: 0,
        unavailable: 0,
        failed: 0,
        removed: 0,
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    for (const entry of entries) {
      if (isCancelled()) break
      const candidate = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) stack.push(candidate)
        continue
      }
      if (!entry.isFile()) continue
      const classification = classifyProjectFile(candidate)
      if (!classification || !PROJECT_INDEX_EXTENSIONS.has(classification.sourceExt)) continue
      sources.push(candidate)
      if (sources.length >= MAX_PROJECT_SOURCES_PER_SCAN) {
        truncated = true
        stack.length = 0
        break
      }
    }
  }
  return { sources, truncated }
}

export async function indexProjectPreviews(
  roots: readonly string[],
  adapter: ProjectIndexAdapter,
  options: {
    isCancelled?: () => boolean
    onProgress?: (progress: ProjectIndexProgress) => void
  } = {},
): Promise<ProjectIndexResult> {
  const isCancelled = options.isCancelled ?? (() => false)
  const resolvedRoots = roots.map((root) => path.resolve(root))
  const service = getProjectPreviewService(configuredUserDataPath)
  const { sources, truncated } = await enumerateProjectSources(
    resolvedRoots,
    isCancelled,
    options.onProgress,
  )
  const state = {
    discovered: sources.length,
    completed: 0,
    indexed: 0,
    unavailable: 0,
    failed: 0,
    removed: 0,
  }

  for (const sourcePath of sources) {
    if (isCancelled()) break
    options.onProgress?.({
      phase: 'rendering',
      currentPath: sourcePath,
      ...state,
    })
    const previous = await service.manifest.get(sourcePath)
    try {
      const current = await service.getOrCreate(sourcePath)
      if (previous?.previewPath && previous.previewPath !== current.previewPath) {
        adapter.deleteIndexPath(previous.previewPath)
        adapter.removeSourceVectorData(sourcePath)
      }
      if (current.status !== 'ready' || !current.previewPath) {
        state.unavailable += 1
      } else {
        adapter.deleteIndexPath(sourcePath)
        const hashed = await adapter.hashImageAsync(current.previewPath)
        if (!hashed.ok || !hashed.diffHash64 || !hashed.dctHash64) {
          state.failed += 1
        } else {
          const upserted = adapter.upsertIndexRecord(
            current.previewPath,
            hashed.width || current.width || 0,
            hashed.height || current.height || 0,
            current.size,
            current.mtimeMs,
            hashed.diffHash64,
            hashed.dctHash64,
          )
          if (upserted.ok) {
            await service.manifest.upsert({
              ...current,
              diffHash64: hashed.diffHash64,
              dctHash64: hashed.dctHash64,
            })
            state.indexed += 1
          } else state.failed += 1
        }
      }
    } catch {
      state.failed += 1
    }
    state.completed += 1
  }

  if (!isCancelled()) {
    const staleEntries = (await service.manifest.list()).filter(
      (entry) =>
        isWithinAnyRoot(resolvedRoots, entry.sourcePath) && !fs.existsSync(entry.sourcePath),
    )
    for (const entry of staleEntries) {
      if (entry.previewPath) {
        adapter.deleteIndexPath(entry.previewPath)
        if (isWithin(service.manifest.previewsDir, entry.previewPath)) {
          await fsp.unlink(entry.previewPath).catch(() => {})
        }
      }
      adapter.removeSourceVectorData(entry.sourcePath)
    }
    if (staleEntries.length > 0) {
      state.removed = await service.manifest.removeMany(
        staleEntries.map((entry) => entry.sourcePath),
      )
    }
  }

  await refreshProjectSearchIndex()
  options.onProgress?.({ phase: 'complete', ...state })
  return {
    ...state,
    cancelled: isCancelled(),
    truncated,
  }
}
