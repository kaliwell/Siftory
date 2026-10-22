import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { DataSource } from '../shared/ipc-contract'
import {
  FolderStatsCancelledError,
  scanSourceFolderStats,
  type FolderStatsOptions,
} from './appStorageService'

const MIB = 1024 ** 2
const GIB = 1024 ** 3
const DEFAULT_MIN_BYTES = GIB
const DEFAULT_TOP_N = 100
const DEFAULT_OLDER_THAN_DAYS = 30
const MAX_TOP_N = 200
const MAX_MIN_BYTES = 8_000_000_000_000_000
const DEFAULT_STORAGE_MAX_ENTRIES = 2_000_000
const MAX_STORAGE_MAX_ENTRIES = 5_000_000
const DAY_MS = 24 * 60 * 60 * 1000

export type LargeFileCleanupAssessment = 'low-risk' | 'review' | 'protected'
export type LargeFileAssessmentFilter = 'all' | LargeFileCleanupAssessment

export interface LargeFileCleanupDecision {
  assessment: LargeFileCleanupAssessment
  reasonCode:
    | 'old-cache-or-temporary-file'
    | 'recent-cache-or-temporary-file'
    | 'old-download-installer-or-archive'
    | 'system-managed-file'
    | 'system-managed-directory'
    | 'recycle-bin-content'
    | 'large-user-file'
  suggestedAction:
    | 'close-owner-and-review-delete'
    | 'review-download-and-delete-if-unneeded'
    | 'use-windows-storage-or-system-settings'
    | 'empty-recycle-bin-with-windows'
    | 'do-not-delete-directly'
    | 'review-before-delete'
}

export interface LargeFileInventoryItem extends LargeFileCleanupDecision {
  itemId: string
  name: string
  relativeFile: string
  extension: string
  sizeBytes: number
  sizeBand: 'large' | 'very-large' | 'huge'
  modifiedAt: string
  ageDays: number
}

export interface LargeFileInventoryInput {
  relativePath?: string
  minBytes?: number
  topN?: number
  olderThanDays?: number
  assessment?: LargeFileAssessmentFilter
}

export interface LargeFileAssessmentSummary {
  count: number
  bytes: number
}

export interface LargeFileInventoryResult {
  sourceId: string
  sourceLabel: string
  thresholdBytes: number
  olderThanDays: number
  assessmentFilter: LargeFileAssessmentFilter
  scannedFiles: number
  scannedFolders: number
  scannedBytes: number
  entriesScanned: number
  inaccessibleCount: number
  skippedLinkCount: number
  candidateCount: number
  candidateBytes: number
  matchedCount: number
  matchedBytes: number
  returnedCount: number
  complete: boolean
  partialReason?: string
  durationMs: number
  assessments: Record<LargeFileCleanupAssessment, LargeFileAssessmentSummary>
  items: LargeFileInventoryItem[]
}

export type StorageLargeFileScope = 'computer' | 'user' | 'downloads' | 'temporary'

export interface StorageLargeFileInventoryInput extends Omit<
  LargeFileInventoryInput,
  'relativePath'
> {
  scope: StorageLargeFileScope
  /** Optional opaque root selector, such as drive-c. No filesystem path is accepted. */
  rootId?: string
  maxEntries?: number
}

export interface StorageLargeFileRoot {
  rootId: string
  rootLabel: string
  rootLocator: string
}

export interface StorageLargeFileInventoryOptions extends Pick<FolderStatsOptions, 'isCancelled'> {
  /** Test/embedding seam. Production calls discover roots from the requested scope. */
  roots?: readonly StorageLargeFileRoot[]
}

export interface StorageLargeFileInventoryItem extends LargeFileInventoryItem {
  rootId: string
  rootLabel: string
}

export interface StorageLargeFileRootResult {
  rootId: string
  rootLabel: string
  status: 'scanned' | 'failed'
  scannedFiles: number
  scannedFolders: number
  scannedBytes: number
  entriesScanned: number
  inaccessibleCount: number
  skippedLinkCount: number
  candidateCount: number
  candidateBytes: number
  matchedCount: number
  matchedBytes: number
  returnedCount: number
  complete: boolean
  partialReason?: string
  durationMs: number
}

export interface StorageLargeFileInventoryResult {
  scope: StorageLargeFileScope
  requestedRootId?: string
  thresholdBytes: number
  entryLimit: number
  olderThanDays: number
  assessmentFilter: LargeFileAssessmentFilter
  rootsDiscovered: number
  rootsScanned: number
  rootsFailed: number
  scannedFiles: number
  scannedFolders: number
  scannedBytes: number
  entriesScanned: number
  inaccessibleCount: number
  skippedLinkCount: number
  candidateCount: number
  candidateBytes: number
  matchedCount: number
  matchedBytes: number
  returnedCount: number
  complete: boolean
  partialReason?: string
  durationMs: number
  assessments: Record<LargeFileCleanupAssessment, LargeFileAssessmentSummary>
  roots: StorageLargeFileRootResult[]
  items: StorageLargeFileInventoryItem[]
}

function normalizeSlashes(value: string): string {
  return path.normalize(value).replace(/\\/g, '/').toLowerCase()
}

function isSameOrNested(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

function isWindowsManagedPath(filePath: string): boolean {
  const normalized = normalizeSlashes(filePath)
  return /^[a-z]:\/(?:windows|program files|program files \(x86\)|programdata)(?:\/|$)/.test(
    normalized,
  )
}

function isRecycleBinPath(filePath: string): boolean {
  return /^[a-z]:\/\$recycle\.bin(?:\/|$)/.test(normalizeSlashes(filePath))
}

function isSystemManagedFilename(name: string): boolean {
  return new Set([
    'pagefile.sys',
    'hiberfil.sys',
    'swapfile.sys',
    'memory.dmp',
    'dumpstack.log.tmp',
  ]).has(name.toLowerCase())
}

function isCacheOrTemporaryPath(filePath: string): boolean {
  const normalized = normalizeSlashes(filePath)
  if (isSameOrNested(os.tmpdir(), filePath)) return true
  return /\/(?:temp|tmp|cache|caches|code cache|gpucache|shadercache|thumbcache|crashpad|crashdumps)(?:\/|$)/.test(
    normalized,
  )
}

function isDownloadInstallerOrArchive(filePath: string, extension: string): boolean {
  const normalized = normalizeSlashes(filePath)
  if (!/\/downloads(?:\/|$)/.test(normalized)) return false
  return new Set([
    '.7z',
    '.appx',
    '.cab',
    '.exe',
    '.gz',
    '.iso',
    '.msi',
    '.msix',
    '.rar',
    '.tar',
    '.zip',
  ]).has(extension)
}

export function assessLargeFileCleanup(
  filePath: string,
  modifiedAt: number,
  olderThanDays = DEFAULT_OLDER_THAN_DAYS,
  now = Date.now(),
): LargeFileCleanupDecision {
  const name = path.posix.basename(filePath.replace(/\\/g, '/'))
  const extension = path.extname(name).toLowerCase()
  const ageDays = Math.max(0, Math.floor((now - modifiedAt) / DAY_MS))

  if (isRecycleBinPath(filePath)) {
    return {
      assessment: 'protected',
      reasonCode: 'recycle-bin-content',
      suggestedAction: 'empty-recycle-bin-with-windows',
    }
  }
  if (isSystemManagedFilename(name)) {
    return {
      assessment: 'protected',
      reasonCode: 'system-managed-file',
      suggestedAction: 'use-windows-storage-or-system-settings',
    }
  }
  if (isWindowsManagedPath(filePath)) {
    return {
      assessment: 'protected',
      reasonCode: 'system-managed-directory',
      suggestedAction: 'do-not-delete-directly',
    }
  }
  if (isCacheOrTemporaryPath(filePath)) {
    return ageDays >= Math.max(0, olderThanDays)
      ? {
          assessment: 'low-risk',
          reasonCode: 'old-cache-or-temporary-file',
          suggestedAction: 'close-owner-and-review-delete',
        }
      : {
          assessment: 'review',
          reasonCode: 'recent-cache-or-temporary-file',
          suggestedAction: 'review-before-delete',
        }
  }
  if (ageDays >= Math.max(0, olderThanDays) && isDownloadInstallerOrArchive(filePath, extension)) {
    return {
      assessment: 'review',
      reasonCode: 'old-download-installer-or-archive',
      suggestedAction: 'review-download-and-delete-if-unneeded',
    }
  }
  return {
    assessment: 'review',
    reasonCode: 'large-user-file',
    suggestedAction: 'review-before-delete',
  }
}

function sizeBand(sizeBytes: number): LargeFileInventoryItem['sizeBand'] {
  if (sizeBytes >= 10 * GIB) return 'huge'
  if (sizeBytes >= GIB) return 'very-large'
  return 'large'
}

function compareInventoryItems(
  left: LargeFileInventoryItem,
  right: LargeFileInventoryItem,
): number {
  return left.sizeBytes - right.sizeBytes || right.relativeFile.localeCompare(left.relativeFile)
}

function siftUp(heap: LargeFileInventoryItem[], index: number): void {
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (compareInventoryItems(heap[parent], heap[index]) <= 0) return
    ;[heap[parent], heap[index]] = [heap[index], heap[parent]]
    index = parent
  }
}

function siftDown(heap: LargeFileInventoryItem[], index: number): void {
  while (true) {
    const left = index * 2 + 1
    const right = left + 1
    let smallest = index
    if (left < heap.length && compareInventoryItems(heap[left], heap[smallest]) < 0) {
      smallest = left
    }
    if (right < heap.length && compareInventoryItems(heap[right], heap[smallest]) < 0) {
      smallest = right
    }
    if (smallest === index) return
    ;[heap[index], heap[smallest]] = [heap[smallest], heap[index]]
    index = smallest
  }
}

function retainLargest(
  heap: LargeFileInventoryItem[],
  item: LargeFileInventoryItem,
  limit: number,
): void {
  if (heap.length < limit) {
    heap.push(item)
    siftUp(heap, heap.length - 1)
    return
  }
  if (compareInventoryItems(item, heap[0]) <= 0) return
  heap[0] = item
  siftDown(heap, 0)
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback
}

function normalizeAssessment(value: unknown): LargeFileAssessmentFilter {
  return ['all', 'low-risk', 'review', 'protected'].includes(String(value ?? ''))
    ? (value as LargeFileAssessmentFilter)
    : 'all'
}

function accessibleDirectory(folderPath: string): boolean {
  try {
    return fs.statSync(folderPath).isDirectory()
  } catch {
    return false
  }
}

function rootDescriptor(
  rootLocator: string,
  rootId: string,
  rootLabel: string,
): StorageLargeFileRoot {
  return { rootId, rootLabel, rootLocator: path.resolve(rootLocator) }
}

export function discoverStorageLargeFileRoots(
  scope: StorageLargeFileScope,
): StorageLargeFileRoot[] {
  if (scope === 'user') {
    return [rootDescriptor(os.homedir(), 'user-home', 'User files')]
  }
  if (scope === 'downloads') {
    return [rootDescriptor(path.join(os.homedir(), 'Downloads'), 'user-downloads', 'Downloads')]
  }
  if (scope === 'temporary') {
    return [rootDescriptor(os.tmpdir(), 'temporary-files', 'Temporary files')]
  }
  if (process.platform !== 'win32') {
    return [rootDescriptor(path.parse(os.homedir()).root || '/', 'filesystem-root', 'Computer')]
  }

  const roots: StorageLargeFileRoot[] = []
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    const letter = String.fromCharCode(code)
    const rootLocator = `${letter}:\\`
    if (!accessibleDirectory(rootLocator)) continue
    roots.push(rootDescriptor(rootLocator, `drive-${letter.toLowerCase()}`, `Disk ${letter}`))
  }
  return roots
}

function emptyAssessments(): StorageLargeFileInventoryResult['assessments'] {
  return {
    'low-risk': { count: 0, bytes: 0 },
    review: { count: 0, bytes: 0 },
    protected: { count: 0, bytes: 0 },
  }
}

function storagePartialReason(
  rootsDiscovered: number,
  rootsFailed: number,
  hasPartialRoot: boolean,
): string | undefined {
  if (rootsDiscovered === 0) return 'no-accessible-roots'
  if (rootsFailed > 0 && hasPartialRoot) return 'root-scan-failed-and-partial-root-scan'
  if (rootsFailed > 0) return 'root-scan-failed'
  if (hasPartialRoot) return 'partial-root-scan'
  return undefined
}

export async function scanSourceLargeFiles(
  source: DataSource,
  input: LargeFileInventoryInput = {},
  options: Pick<FolderStatsOptions, 'isCancelled' | 'maxEntries'> = {},
): Promise<LargeFileInventoryResult> {
  const minBytes = boundedInteger(input.minBytes, DEFAULT_MIN_BYTES, MIB, MAX_MIN_BYTES)
  const topN = boundedInteger(input.topN, DEFAULT_TOP_N, 1, MAX_TOP_N)
  const olderThanDays = boundedInteger(input.olderThanDays, DEFAULT_OLDER_THAN_DAYS, 0, 36_500)
  const assessmentFilter = normalizeAssessment(input.assessment)
  const root = path.resolve(source.rootLocator)
  const heap: LargeFileInventoryItem[] = []
  const assessments: LargeFileInventoryResult['assessments'] = {
    'low-risk': { count: 0, bytes: 0 },
    review: { count: 0, bytes: 0 },
    protected: { count: 0, bytes: 0 },
  }
  let candidateCount = 0
  let candidateBytes = 0
  let matchedCount = 0
  let matchedBytes = 0
  const now = Date.now()

  const stats = await scanSourceFolderStats(source, input.relativePath ?? '', {
    ...options,
    onFile: (file) => {
      if (file.size < minBytes) return
      const relativeFile = path.relative(root, file.absolutePath)
      if (
        !relativeFile ||
        relativeFile === '..' ||
        relativeFile.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeFile)
      ) {
        return
      }
      const decision = assessLargeFileCleanup(
        file.absolutePath,
        file.modifiedAt,
        olderThanDays,
        now,
      )
      candidateCount += 1
      candidateBytes += file.size
      assessments[decision.assessment].count += 1
      assessments[decision.assessment].bytes += file.size
      if (assessmentFilter !== 'all' && decision.assessment !== assessmentFilter) return
      matchedCount += 1
      matchedBytes += file.size
      const name = path.basename(file.absolutePath)
      retainLargest(
        heap,
        {
          itemId: crypto
            .createHash('sha256')
            .update(`${source.id}\0${relativeFile}`)
            .digest('hex')
            .slice(0, 24),
          name,
          relativeFile,
          extension: path.extname(name).toLowerCase(),
          sizeBytes: file.size,
          sizeBand: sizeBand(file.size),
          modifiedAt: new Date(file.modifiedAt).toISOString(),
          ageDays: Math.max(0, Math.floor((now - file.modifiedAt) / DAY_MS)),
          ...decision,
        },
        topN,
      )
    },
  })

  const items = heap.sort((left, right) => compareInventoryItems(right, left))
  return {
    sourceId: source.id,
    sourceLabel: source.displayName,
    thresholdBytes: minBytes,
    olderThanDays,
    assessmentFilter,
    scannedFiles: stats.fileCount,
    scannedFolders: stats.folderCount,
    scannedBytes: stats.bytes,
    entriesScanned: stats.entriesScanned,
    inaccessibleCount: stats.inaccessibleCount,
    skippedLinkCount: stats.skippedLinkCount,
    candidateCount,
    candidateBytes,
    matchedCount,
    matchedBytes,
    returnedCount: items.length,
    complete: stats.complete,
    ...(stats.partialReason && { partialReason: stats.partialReason }),
    durationMs: stats.durationMs,
    assessments,
    items,
  }
}

/**
 * One-call storage inventory used by AI Control. It discovers the requested roots internally,
 * scans them sequentially to avoid saturating all disks, and never returns absolute paths.
 */
export async function scanStorageLargeFiles(
  input: StorageLargeFileInventoryInput,
  options: StorageLargeFileInventoryOptions = {},
): Promise<StorageLargeFileInventoryResult> {
  const startedAt = Date.now()
  const minBytes = boundedInteger(input.minBytes, DEFAULT_MIN_BYTES, MIB, MAX_MIN_BYTES)
  const topN = boundedInteger(input.topN, DEFAULT_TOP_N, 1, MAX_TOP_N)
  const olderThanDays = boundedInteger(input.olderThanDays, DEFAULT_OLDER_THAN_DAYS, 0, 36_500)
  const maxEntries = boundedInteger(
    input.maxEntries,
    DEFAULT_STORAGE_MAX_ENTRIES,
    1_000,
    MAX_STORAGE_MAX_ENTRIES,
  )
  const assessmentFilter = normalizeAssessment(input.assessment)
  const availableRoots = [...(options.roots ?? discoverStorageLargeFileRoots(input.scope))]
  const discoveredRoots = input.rootId
    ? availableRoots.filter((root) => root.rootId === input.rootId)
    : availableRoots
  const assessments = emptyAssessments()
  const roots: StorageLargeFileRootResult[] = []
  const candidates: StorageLargeFileInventoryItem[] = []
  let rootsScanned = 0
  let rootsFailed = 0
  let scannedFiles = 0
  let scannedFolders = 0
  let scannedBytes = 0
  let entriesScanned = 0
  let inaccessibleCount = 0
  let skippedLinkCount = 0
  let candidateCount = 0
  let candidateBytes = 0
  let matchedCount = 0
  let matchedBytes = 0
  let hasPartialRoot = false

  for (const [index, root] of discoveredRoots.entries()) {
    if (options.isCancelled?.()) throw new FolderStatsCancelledError()
    const source: DataSource = {
      id: root.rootId || `storage-root-${index + 1}`,
      type: 'local-generic',
      displayName: root.rootLabel || `Storage ${index + 1}`,
      rootLocator: root.rootLocator,
      readOnly: true,
      availability: 'online',
      scanCapability: 'directory',
    }
    const rootStartedAt = Date.now()
    try {
      const result = await scanSourceLargeFiles(
        source,
        { minBytes, topN, olderThanDays, assessment: assessmentFilter },
        { isCancelled: options.isCancelled, maxEntries },
      )
      rootsScanned += 1
      scannedFiles += result.scannedFiles
      scannedFolders += result.scannedFolders
      scannedBytes += result.scannedBytes
      entriesScanned += result.entriesScanned
      inaccessibleCount += result.inaccessibleCount
      skippedLinkCount += result.skippedLinkCount
      candidateCount += result.candidateCount
      candidateBytes += result.candidateBytes
      matchedCount += result.matchedCount
      matchedBytes += result.matchedBytes
      hasPartialRoot ||= !result.complete
      for (const assessment of ['low-risk', 'review', 'protected'] as const) {
        assessments[assessment].count += result.assessments[assessment].count
        assessments[assessment].bytes += result.assessments[assessment].bytes
      }
      roots.push({
        rootId: source.id,
        rootLabel: source.displayName,
        status: 'scanned',
        scannedFiles: result.scannedFiles,
        scannedFolders: result.scannedFolders,
        scannedBytes: result.scannedBytes,
        entriesScanned: result.entriesScanned,
        inaccessibleCount: result.inaccessibleCount,
        skippedLinkCount: result.skippedLinkCount,
        candidateCount: result.candidateCount,
        candidateBytes: result.candidateBytes,
        matchedCount: result.matchedCount,
        matchedBytes: result.matchedBytes,
        returnedCount: result.returnedCount,
        complete: result.complete,
        ...(result.partialReason && { partialReason: result.partialReason }),
        durationMs: result.durationMs,
      })
      candidates.push(
        ...result.items.map((item) => ({
          rootId: source.id,
          rootLabel: source.displayName,
          ...item,
        })),
      )
    } catch (error) {
      if (error instanceof FolderStatsCancelledError || options.isCancelled?.()) throw error
      rootsFailed += 1
      inaccessibleCount += 1
      roots.push({
        rootId: source.id,
        rootLabel: source.displayName,
        status: 'failed',
        scannedFiles: 0,
        scannedFolders: 0,
        scannedBytes: 0,
        entriesScanned: 0,
        inaccessibleCount: 1,
        skippedLinkCount: 0,
        candidateCount: 0,
        candidateBytes: 0,
        matchedCount: 0,
        matchedBytes: 0,
        returnedCount: 0,
        complete: false,
        partialReason: 'unavailable-or-inaccessible',
        durationMs: Date.now() - rootStartedAt,
      })
    }
  }

  const items = candidates
    .sort(
      (left, right) =>
        compareInventoryItems(right, left) || left.rootId.localeCompare(right.rootId),
    )
    .slice(0, topN)
  const partialReason = storagePartialReason(discoveredRoots.length, rootsFailed, hasPartialRoot)
  return {
    scope: input.scope,
    ...(input.rootId && { requestedRootId: input.rootId }),
    thresholdBytes: minBytes,
    entryLimit: maxEntries,
    olderThanDays,
    assessmentFilter,
    rootsDiscovered: discoveredRoots.length,
    rootsScanned,
    rootsFailed,
    scannedFiles,
    scannedFolders,
    scannedBytes,
    entriesScanned,
    inaccessibleCount,
    skippedLinkCount,
    candidateCount,
    candidateBytes,
    matchedCount,
    matchedBytes,
    returnedCount: items.length,
    complete: partialReason === undefined,
    ...(partialReason && { partialReason }),
    durationMs: Date.now() - startedAt,
    assessments,
    roots,
    items,
  }
}
