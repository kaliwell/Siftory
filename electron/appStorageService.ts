import { execFile } from 'child_process'
import path from 'path'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import type {
  AppStorageEntry,
  AppStoragePathEntry,
  AppStorageScanStatus,
  AppStorageScanResult,
  DataSource,
} from '../shared/ipc-contract'

// ── Types ───────────────────────────────────────────────────

interface RegistryApp {
  DisplayName?: string
  Publisher?: string
  DisplayVersion?: string
  InstallLocation?: string
  UninstallString?: string
  QuietUninstallString?: string
  DisplayIcon?: string
  EstimatedSize?: number // KB
  SystemComponent?: number // 1 = system component (skip)
  ReleaseType?: string // "Security Update" etc (skip)
  ParentKeyName?: string
}

type StatusCallback = (status: AppStorageScanStatus) => void

// ── Paths to skip ──────────────────────────────────────────

const SKIP_ROOTS = new Set([
  'C:\\',
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'D:\\',
  'E:\\',
  'F:\\',
])

const SKIP_PREFIXES = [
  'C:\\Windows\\',
  'C:\\Windows\\System32\\',
  'C:\\Windows\\SysWOW64\\',
  // User profile roots — too broad to attribute to a single app
  `${os.homedir()}\\`,
  `${os.homedir()}\\Desktop\\`,
  `${os.homedir()}\\Downloads\\`,
  `${os.homedir()}\\Documents\\`,
  `${os.homedir()}\\Pictures\\`,
  `${os.homedir()}\\Music\\`,
  `${os.homedir()}\\Videos\\`,
  // Shared game library roots — would double-count every game
  'C:\\Program Files (x86)\\Steam\\',
  'C:\\Program Files\\Steam\\',
  'C:\\Program Files (x86)\\Epic Games\\',
  'C:\\Program Files\\Epic Games\\',
  'C:\\Program Files (x86)\\Ubisoft\\',
  'C:\\Program Files\\Ubisoft\\',
  'C:\\Program Files (x86)\\Origin\\',
  'C:\\Program Files\\Origin\\',
  'C:\\Program Files (x86)\\GOG Galaxy\\',
  'C:\\Program Files\\GOG Galaxy\\',
  'C:\\XboxGames\\',
  // Shared temp / cache roots
  `${os.homedir()}\\AppData\\Local\\Temp\\`,
  'C:\\Windows\\Temp\\',
]

/** Known shared-launcher executable names — scanning their parent dir would capture entire libraries */
const SHARED_LAUNCHER_EXES = new Set([
  'steam.exe',
  'epicgameslauncher.exe',
  'ubisoftconnect.exe',
  'origin.exe',
  'eadesktop.exe',
  'galaxyclient.exe',
  'battle.net.exe',
  'xbox.exe',
])

export function isSkippableRoot(p: string): boolean {
  const normalized = path.normalize(p).toUpperCase()
  if (SKIP_ROOTS.has(normalized)) return true
  for (const prefix of SKIP_PREFIXES) {
    const upperPrefix = prefix.toUpperCase()
    if (normalized === upperPrefix.slice(0, -1) || normalized.startsWith(upperPrefix)) return true
  }
  return false
}

// ── Max limits ─────────────────────────────────────────────

const MAX_CANDIDATE_PATHS = 8
const MAX_APPS = 500
const SCAN_BATCH_SIZE = 50 // files per batch before yielding

// ── Globals for abort ──────────────────────────────────────

let _aborted = false
let _statusCallback: StatusCallback | null = null
let _cachePath = path.join(os.homedir(), 'AppData', 'Local', 'Siftory', 'app-storage-cache.json')

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined
}

// ── Registry reading via PowerShell ────────────────────────

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60000,
        windowsHide: true,
        encoding: 'utf8',
      },
      (err, stdout, _stderr) => {
        if (err && !stdout) {
          reject(err)
          return
        }
        resolve(stdout)
      },
    )
  })
}

async function readRegistryApps(): Promise<RegistryApp[]> {
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$keys = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$apps = @()
foreach ($keyPath in $keys) {
  try {
    $items = Get-ItemProperty -Path $keyPath -ErrorAction SilentlyContinue
    foreach ($item in $items) {
      if (-not $item.DisplayName -or $item.DisplayName -eq '') { continue }
      if ($item.SystemComponent -eq 1) { continue }
      if ($item.ReleaseType -match 'Update|Hotfix') { continue }
      $apps += [PSCustomObject]@{
        DisplayName         = $item.DisplayName
        Publisher           = $item.Publisher
        DisplayVersion      = $item.DisplayVersion
        InstallLocation     = $item.InstallLocation
        UninstallString     = $item.UninstallString
        QuietUninstallString = $item.QuietUninstallString
        DisplayIcon         = $item.DisplayIcon
        EstimatedSize       = [int]$item.EstimatedSize
        SystemComponent     = $item.SystemComponent
        ReleaseType         = $item.ReleaseType
        ParentKeyName       = $item.PSParentPath -replace '.*\\\\'
      }
    }
  } catch {}
}
$apps | ConvertTo-Json -Compress -Depth 3
`
  const raw = await runPowerShell(script)
  if (!raw || raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw)
    let apps: RegistryApp[] = []
    if (Array.isArray(parsed)) apps = parsed
    else if (parsed && typeof parsed === 'object' && parsed.DisplayName) apps = [parsed]

    // Filter entries with Unicode replacement characters (garbled text)
    apps = apps.filter((app) => {
      const name = app.DisplayName || ''
      if (name.includes('\uFFFD')) return false
      // Remove leading BOM or whitespace noise
      return name.trim().length > 0
    })
    return apps
  } catch {
    return []
  }
}

// ── Path inference ─────────────────────────────────────────

export function extractExePath(str: string): string | null {
  if (!str || typeof str !== 'string') return null
  // "C:\Path\app.exe" or "C:\Path\app.exe" /options or "C:\Path\app.exe,0"
  const cleaned = str.replace(/["']/g, '').trim()
  // Try to find a .exe path
  const exeMatch = cleaned.match(/^(.+?\.exe)/i)
  if (exeMatch) {
    const exeName = path.basename(exeMatch[1]).toLowerCase()
    // Skip shared launcher executables — their parent dir is the entire library root
    if (SHARED_LAUNCHER_EXES.has(exeName)) return null
    return path.dirname(exeMatch[1])
  }
  return null
}

export function extractIconPath(str: string): string | null {
  if (!str || typeof str !== 'string') return null
  const cleaned = str.replace(/["']/g, '').trim()
  // Remove trailing ",0" or ",1" etc
  const iconPath = cleaned.replace(/,\s*-?\d+$/, '')
  if (iconPath && path.extname(iconPath)) {
    return path.dirname(iconPath)
  }
  return null
}

interface CandidatePath {
  dir: string
  kind: 'app' | 'data' | 'cache' | 'unknown'
  source: string
}

function inferCandidatePaths(app: RegistryApp): CandidatePath[] {
  const candidates: CandidatePath[] = []
  const seen = new Set<string>()
  const name = (app.DisplayName || '').replace(/[\\/:*?"<>|]/g, '_').trim()
  const publisher = (app.Publisher || '').replace(/[\\/:*?"<>|]/g, '_').trim()

  const add = (dir: string, kind: CandidatePath['kind'], source: string) => {
    if (!dir || dir.trim() === '') return
    const normalized = path.normalize(dir.trim())
    if (isSkippableRoot(normalized)) return
    const key = normalized.toUpperCase()
    if (seen.has(key)) return
    if (candidates.length >= MAX_CANDIDATE_PATHS) return
    seen.add(key)
    candidates.push({ dir: normalized, kind, source })
  }

  // 1. InstallLocation
  if (app.InstallLocation) {
    add(app.InstallLocation, 'app', 'InstallLocation')
  }

  // 2. From UninstallString
  if (app.UninstallString) {
    const uninstallDir = extractExePath(app.UninstallString)
    if (uninstallDir) add(uninstallDir, 'app', 'UninstallString')
  }

  // 3. From DisplayIcon
  if (app.DisplayIcon) {
    const iconDir = extractIconPath(app.DisplayIcon)
    if (iconDir && iconDir !== path.dirname(app.InstallLocation || '')) {
      add(iconDir, 'app', 'DisplayIcon')
    }
  }

  // 4. User data: %APPDATA%/<AppName>
  if (name) {
    add(path.join(os.homedir(), 'AppData', 'Roaming', name), 'data', 'AppData/Roaming')
    add(path.join(os.homedir(), 'AppData', 'Local', name), 'data', 'AppData/Local')
  }

  // 5. ProgramData/<AppName>
  if (name) {
    add(path.join('C:\\', 'ProgramData', name), 'data', 'ProgramData')
  }

  // 6. Publisher/AppName in Local
  if (publisher && name) {
    add(
      path.join(os.homedir(), 'AppData', 'Local', publisher, name),
      'data',
      'AppData/Local/Publisher',
    )
  }

  // 7. Common cache locations
  if (name) {
    add(path.join(os.homedir(), 'AppData', 'Local', name, 'Cache'), 'cache', 'Cache')
    add(path.join(os.homedir(), 'AppData', 'Local', name, 'cache'), 'cache', 'Cache')
    add(path.join(os.homedir(), 'AppData', 'Roaming', name, 'Cache'), 'cache', 'Cache')
  }

  return candidates
}

// ── Directory size scanning ────────────────────────────────

interface DirSizeResult {
  bytes: number
  fileCount: number
  dirCount: number
  inaccessible: number
}

async function scanDirSize(dirPath: string): Promise<DirSizeResult> {
  const result: DirSizeResult = { bytes: 0, fileCount: 0, dirCount: 0, inaccessible: 0 }

  let batchCount = 0
  const stack: string[] = [dirPath]

  while (stack.length > 0) {
    if (_aborted) break
    const current = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = (await fsp.readdir(current, { withFileTypes: true })) as unknown as fs.Dirent[]
    } catch {
      result.inaccessible++
      continue
    }

    for (const entry of entries) {
      if (_aborted) break
      const fullPath = path.join(current, entry.name)
      try {
        if (entry.isSymbolicLink() || entry.isBlockDevice() || entry.isCharacterDevice()) {
          // Skip reparse points / block devices for safety
          continue
        }
        if (entry.isDirectory()) {
          result.dirCount++
          stack.push(fullPath)
        } else if (entry.isFile()) {
          if (entry.name.toLowerCase().endsWith('.asar')) {
            continue
          }
          const stat = await fsp.stat(fullPath)
          result.bytes += stat.size
          result.fileCount++
        }
      } catch {
        result.inaccessible++
      }
    }

    batchCount++
    if (batchCount >= SCAN_BATCH_SIZE) {
      batchCount = 0
      // Yield to event loop
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  return result
}

// ── Authorized on-demand folder statistics ────────────────

const DEFAULT_FOLDER_STATS_MAX_ENTRIES = 2_000_000
const DEFAULT_FOLDER_STATS_CONCURRENCY = 16
const DEFAULT_FOLDER_STATS_YIELD_EVERY = 256

const LOCAL_FOLDER_SOURCE_TYPES = new Set<DataSource['type']>([
  'local-ntfs',
  'local-generic',
  'removable',
  'mounted-network',
])

export interface FolderStatsSourceSummary {
  sourceId: string
  label: string
  type: DataSource['type']
  availability: DataSource['availability']
}

export interface FolderTreeStats {
  bytes: number
  fileCount: number
  folderCount: number
  inaccessibleCount: number
  skippedLinkCount: number
  entriesScanned: number
  complete: boolean
  partialReason?: 'entry-limit' | 'inaccessible' | 'entry-limit-and-inaccessible'
  durationMs: number
}

export interface FolderStatsResult extends FolderTreeStats {
  sourceId: string
  sourceLabel: string
}

export interface FolderStatsProgress {
  bytes: number
  fileCount: number
  folderCount: number
  entriesScanned: number
}

export interface FolderStatsFile {
  absolutePath: string
  size: number
  modifiedAt: number
}

export interface FolderStatsOptions {
  isCancelled?: () => boolean
  maxEntries?: number
  statConcurrency?: number
  yieldEvery?: number
  onProgress?: (progress: FolderStatsProgress) => void
  /** Optional bounded observer used by read-only inventory scans. */
  onFile?: (file: FolderStatsFile) => void
  /** Receives post-order subtree snapshots so callers can reuse child-folder results. */
  onDirectoryStats?: (folderPath: string, stats: FolderTreeStats) => void
  /** Bounds callback/cache churn; the shallowest snapshots, including the root, are retained. */
  maxDirectorySnapshots?: number
}

export class FolderStatsCancelledError extends Error {
  constructor() {
    super('Folder statistics request was cancelled')
    this.name = 'FolderStatsCancelledError'
  }
}

export function listFolderStatsSources(sources: readonly DataSource[]): FolderStatsSourceSummary[] {
  return sources
    .filter((source) => LOCAL_FOLDER_SOURCE_TYPES.has(source.type))
    .map((source) => ({
      sourceId: source.id,
      label: source.displayName,
      type: source.type,
      availability: source.availability,
    }))
}

function isWithinFolderStatsRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

function resolveFolderStatsTarget(rootPath: string, relativePath: string): string {
  if (relativePath.includes('\0')) throw new Error('Relative folder contains an invalid character')
  if (
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw new Error('Only a relative folder inside the registered source is allowed')
  }
  const root = path.resolve(rootPath)
  const target = path.resolve(root, relativePath || '.')
  if (!isWithinFolderStatsRoot(root, target)) {
    throw new Error('Relative folder escapes the registered source')
  }
  return target
}

function folderStatsPartialReason(
  entryLimitReached: boolean,
  inaccessibleCount: number,
): FolderTreeStats['partialReason'] {
  if (entryLimitReached && inaccessibleCount > 0) return 'entry-limit-and-inaccessible'
  if (entryLimitReached) return 'entry-limit'
  if (inaccessibleCount > 0) return 'inaccessible'
  return undefined
}

function yieldFolderStats(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

interface FolderStatsAccumulator {
  path: string
  parentPath?: string
  depth: number
  bytes: number
  fileCount: number
  folderCount: number
  inaccessibleCount: number
  skippedLinkCount: number
  entriesScanned: number
  enumerated: boolean
  entryLimitReached: boolean
}

function createFolderStatsAccumulator(
  folderPath: string,
  parentPath?: string,
  depth = 0,
): FolderStatsAccumulator {
  return {
    path: folderPath,
    ...(parentPath && { parentPath }),
    depth,
    bytes: 0,
    fileCount: 0,
    folderCount: 0,
    inaccessibleCount: 0,
    skippedLinkCount: 0,
    entriesScanned: 0,
    enumerated: false,
    entryLimitReached: false,
  }
}

export async function scanFolderTree(
  rootPath: string,
  relativePath = '',
  options: FolderStatsOptions = {},
): Promise<FolderTreeStats> {
  const startedAt = Date.now()
  const isCancelled = options.isCancelled ?? (() => false)
  const maxEntries = Math.max(
    1,
    Math.min(10_000_000, options.maxEntries ?? DEFAULT_FOLDER_STATS_MAX_ENTRIES),
  )
  const statConcurrency = Math.max(
    1,
    Math.min(64, options.statConcurrency ?? DEFAULT_FOLDER_STATS_CONCURRENCY),
  )
  const yieldEvery = Math.max(
    1,
    Math.min(10_000, options.yieldEvery ?? DEFAULT_FOLDER_STATS_YIELD_EVERY),
  )
  const requestedMaxDirectorySnapshots = Number.isFinite(options.maxDirectorySnapshots)
    ? Math.floor(options.maxDirectorySnapshots!)
    : maxEntries + 1
  const maxDirectorySnapshots = Math.max(
    1,
    Math.min(maxEntries + 1, requestedMaxDirectorySnapshots),
  )

  const checkCancelled = (): void => {
    if (isCancelled()) throw new FolderStatsCancelledError()
  }

  checkCancelled()
  const root = path.resolve(rootPath)
  const target = resolveFolderStatsTarget(root, relativePath)
  let rootReal: string
  let targetReal: string
  try {
    ;[rootReal, targetReal] = await Promise.all([fsp.realpath(root), fsp.realpath(target)])
  } catch (error) {
    throw new Error('Registered source or selected folder is not accessible', { cause: error })
  }
  if (!isWithinFolderStatsRoot(rootReal, targetReal)) {
    throw new Error('Selected folder resolves outside the registered source')
  }
  try {
    const targetStat = await fsp.lstat(target)
    if (target !== root && targetStat.isSymbolicLink()) {
      throw new Error('Symbolic-link folders cannot be queried')
    }
    if (!targetStat.isDirectory()) throw new Error('Selected target is not a folder')
  } catch (error) {
    if (error instanceof Error && /cannot be queried|not a folder/.test(error.message)) throw error
    throw new Error('Selected folder is not accessible', { cause: error })
  }

  let bytes = 0
  let fileCount = 0
  let folderCount = 0
  let inaccessibleCount = 0
  let skippedLinkCount = 0
  let entriesScanned = 0
  let entryLimitReached = false
  const pendingStats = new Set<Promise<void>>()
  const folders = [target]
  const directoryAccumulators = options.onDirectoryStats
    ? new Map<string, FolderStatsAccumulator>([[target, createFolderStatsAccumulator(target)]])
    : undefined

  const reportProgress = (): void => {
    if (!options.onProgress) return
    try {
      options.onProgress({ bytes, fileCount, folderCount, entriesScanned })
    } catch {
      // Progress observers must never be able to fail the filesystem scan.
    }
  }

  const registerDirectory = (entryPath: string, parentPath: string): void => {
    folderCount += 1
    folders.push(entryPath)
    if (!directoryAccumulators) return
    const parent = directoryAccumulators.get(parentPath)
    if (parent) parent.folderCount += 1
    directoryAccumulators.set(
      entryPath,
      createFolderStatsAccumulator(entryPath, parentPath, (parent?.depth ?? 0) + 1),
    )
  }

  const scheduleStat = (entryPath: string, parentPath: string): void => {
    const parent = directoryAccumulators?.get(parentPath)
    let task: Promise<void>
    task = fsp
      .lstat(entryPath)
      .then((stat) => {
        if (stat.isSymbolicLink()) {
          skippedLinkCount += 1
          if (parent) parent.skippedLinkCount += 1
        } else if (stat.isDirectory()) {
          registerDirectory(entryPath, parentPath)
        } else if (stat.isFile()) {
          fileCount += 1
          bytes += stat.size
          if (parent) {
            parent.fileCount += 1
            parent.bytes += stat.size
          }
          if (options.onFile) {
            try {
              options.onFile({ absolutePath: entryPath, size: stat.size, modifiedAt: stat.mtimeMs })
            } catch {
              // Inventory observers are optional side effects and cannot fail the tree scan.
            }
          }
        }
      })
      .catch(() => {
        inaccessibleCount += 1
        if (parent) parent.inaccessibleCount += 1
      })
      .finally(() => pendingStats.delete(task))
    pendingStats.add(task)
  }

  while ((folders.length > 0 || pendingStats.size > 0) && !entryLimitReached) {
    checkCancelled()
    if (folders.length === 0) {
      await Promise.race(pendingStats)
      continue
    }
    const current = folders.pop()!
    const currentAccumulator = directoryAccumulators?.get(current)
    try {
      const currentReal = await fsp.realpath(current)
      if (!isWithinFolderStatsRoot(rootReal, currentReal)) {
        skippedLinkCount += 1
        if (currentAccumulator) {
          currentAccumulator.skippedLinkCount += 1
          currentAccumulator.enumerated = true
        }
        continue
      }
      const directory = await fsp.opendir(current, { bufferSize: 64 })
      let enumerated = true
      for await (const entry of directory) {
        checkCancelled()
        if (entriesScanned >= maxEntries) {
          entryLimitReached = true
          enumerated = false
          if (currentAccumulator) currentAccumulator.entryLimitReached = true
          break
        }
        entriesScanned += 1
        if (currentAccumulator) currentAccumulator.entriesScanned += 1
        const entryPath = path.join(current, entry.name)
        if (entry.isSymbolicLink()) {
          skippedLinkCount += 1
          if (currentAccumulator) currentAccumulator.skippedLinkCount += 1
        } else if (entry.isDirectory()) {
          registerDirectory(entryPath, current)
        } else {
          scheduleStat(entryPath, current)
          if (pendingStats.size >= statConcurrency) await Promise.race(pendingStats)
        }
        if (entriesScanned % yieldEvery === 0) {
          await yieldFolderStats()
          reportProgress()
        }
      }
      if (currentAccumulator) currentAccumulator.enumerated = enumerated
    } catch (error) {
      if (error instanceof FolderStatsCancelledError) throw error
      inaccessibleCount += 1
      if (currentAccumulator) currentAccumulator.inaccessibleCount += 1
    }
  }

  if (pendingStats.size > 0) await Promise.all(pendingStats)
  checkCancelled()
  if (entryLimitReached && directoryAccumulators) {
    for (const pendingFolder of folders) {
      const accumulator = directoryAccumulators.get(pendingFolder)
      if (accumulator) accumulator.entryLimitReached = true
    }
  }
  reportProgress()
  const reason = folderStatsPartialReason(entryLimitReached, inaccessibleCount)
  const durationMs = Date.now() - startedAt
  const result: FolderTreeStats = {
    bytes,
    fileCount,
    folderCount,
    inaccessibleCount,
    skippedLinkCount,
    entriesScanned,
    complete: reason === undefined,
    ...(reason && { partialReason: reason }),
    durationMs,
  }

  if (directoryAccumulators && options.onDirectoryStats) {
    const ordered = [...directoryAccumulators.values()].sort((a, b) => b.depth - a.depth)
    const snapshots: Array<{ folderPath: string; stats: FolderTreeStats }> = []
    const firstSnapshotIndex = Math.max(0, ordered.length - maxDirectorySnapshots)
    for (const [index, accumulator] of ordered.entries()) {
      const accumulatorReason = folderStatsPartialReason(
        accumulator.entryLimitReached,
        accumulator.inaccessibleCount,
      )
      if (index >= firstSnapshotIndex) {
        snapshots.push({
          folderPath: accumulator.path,
          stats: {
            bytes: accumulator.bytes,
            fileCount: accumulator.fileCount,
            folderCount: accumulator.folderCount,
            inaccessibleCount: accumulator.inaccessibleCount,
            skippedLinkCount: accumulator.skippedLinkCount,
            entriesScanned: accumulator.entriesScanned,
            complete: accumulator.enumerated && accumulatorReason === undefined,
            ...(accumulatorReason && { partialReason: accumulatorReason }),
            durationMs,
          },
        })
      }
      if (!accumulator.parentPath) continue
      const parent = directoryAccumulators.get(accumulator.parentPath)
      if (!parent) continue
      parent.bytes += accumulator.bytes
      parent.fileCount += accumulator.fileCount
      parent.folderCount += accumulator.folderCount
      parent.inaccessibleCount += accumulator.inaccessibleCount
      parent.skippedLinkCount += accumulator.skippedLinkCount
      parent.entriesScanned += accumulator.entriesScanned
      parent.entryLimitReached ||= accumulator.entryLimitReached
    }
    for (const snapshot of snapshots) {
      try {
        options.onDirectoryStats(snapshot.folderPath, snapshot.stats)
      } catch {
        // Cache observers are optional side effects and cannot invalidate the scan result.
      }
    }
  }

  return result
}

export async function scanSourceFolderStats(
  source: DataSource,
  relativePath = '',
  options: FolderStatsOptions = {},
): Promise<FolderStatsResult> {
  if (!LOCAL_FOLDER_SOURCE_TYPES.has(source.type)) {
    throw new Error('This source type does not support local folder statistics')
  }
  const stats = await scanFolderTree(source.rootLocator, relativePath, options)
  return {
    sourceId: source.id,
    sourceLabel: source.displayName,
    ...stats,
  }
}

// ── Main scan orchestrator ─────────────────────────────────

let _lastStatus: AppStorageScanStatus | null = null
let _lastResult: AppStorageScanResult | null = null

function emitStatus(status: AppStorageScanStatus): void {
  _lastStatus = status
  _statusCallback?.(status)
}

export function initAppStorageService(userDataPath?: string): void {
  if (userDataPath) _cachePath = path.join(userDataPath, 'app-storage-cache.json')
}

async function saveCache(result: AppStorageScanResult): Promise<void> {
  const payload: AppStorageScanResult = {
    ...result,
    savedAt: Date.now(),
    cachePath: _cachePath,
  }
  await fsp.mkdir(path.dirname(_cachePath), { recursive: true })
  await fsp.writeFile(_cachePath, JSON.stringify(payload), 'utf8')
  _lastResult = payload
}

export async function loadCachedResult(): Promise<AppStorageScanResult | null> {
  if (_lastResult) return _lastResult
  try {
    const raw = await fsp.readFile(_cachePath, 'utf8')
    const parsed = JSON.parse(raw) as AppStorageScanResult
    if (!parsed || !Array.isArray(parsed.apps) || !parsed.status) return null
    _lastResult = { ...parsed, cachePath: parsed.cachePath || _cachePath }
    _lastStatus = _lastResult.status
    return _lastResult
  } catch {
    return null
  }
}

export async function clearCachedResult(): Promise<{ ok: boolean; error?: string }> {
  _lastResult = null
  try {
    await fsp.unlink(_cachePath)
    return { ok: true }
  } catch (e: unknown) {
    if (errorCode(e) === 'ENOENT') return { ok: true }
    return { ok: false, error: errorMessage(e) }
  }
}

export function buildAppEntry(app: RegistryApp, idx: number): AppStorageEntry {
  const name = app.DisplayName || `Unknown ${idx}`
  const id = `app-${idx}-${name.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}`
  const estBytes = app.EstimatedSize ? app.EstimatedSize * 1024 : undefined

  const candidates = inferCandidatePaths(app)
  const pathEntries: AppStoragePathEntry[] = candidates.map((c) => ({
    path: c.dir,
    kind: c.kind,
    bytes: 0,
    exists: false,
    accessible: false,
    source: c.source,
  }))

  return {
    id,
    name,
    publisher: app.Publisher || undefined,
    version: app.DisplayVersion || undefined,
    installLocation: app.InstallLocation || undefined,
    uninstallString: app.UninstallString || undefined,
    estimatedRegistryBytes: estBytes,
    // Start at 0 — totalBytes is set after scanning, or kept at estimatedRegistryBytes
    // only if ALL candidate paths are unavailable (registry-only app)
    totalBytes: 0,
    scannedBytes: 0,
    dataBytes: 0,
    cacheBytes: 0,
    inaccessibleCount: 0,
    paths: pathEntries,
    tags: [],
  }
}

export function computeTags(entry: AppStorageEntry): string[] {
  const tags: string[] = []
  const displayBytes =
    entry.scannedBytes > 0 ? entry.scannedBytes : entry.estimatedRegistryBytes || 0

  if (displayBytes >= 5 * 1024 * 1024 * 1024) tags.push('Huge')
  else if (displayBytes >= 1 * 1024 * 1024 * 1024) tags.push('Large')
  if (entry.cacheBytes + entry.dataBytes > entry.scannedBytes * 0.5 && entry.scannedBytes > 0)
    tags.push('Cache heavy')
  if (entry.inaccessibleCount > 0) tags.push('Partial')

  // Check if all candidate paths are missing
  const anyPathExists = entry.paths.some((p) => p.exists)
  const anyPathScanned = entry.scannedBytes > 0

  if (!anyPathExists) {
    tags.push('Missing paths')
    if (entry.estimatedRegistryBytes) {
      tags.push('Registry estimate')
    } else {
      tags.push('Registry only')
    }
  } else if (!anyPathScanned && entry.estimatedRegistryBytes) {
    tags.push('Registry estimate')
  }

  if (!entry.uninstallString && entry.installLocation) tags.push('Portable-like')
  if (!entry.installLocation && !entry.uninstallString && anyPathExists) tags.push('Registry only')

  return tags
}

export async function startScan(onStatus: StatusCallback): Promise<AppStorageScanResult> {
  _aborted = false
  _statusCallback = onStatus

  const apps: AppStorageEntry[] = []

  // 1. Read registry
  emitStatus({
    state: 'scanning',
    appCount: 0,
    scannedCount: 0,
    totalBytes: 0,
    currentApp: 'Reading registry...',
    warnings: 0,
    errors: 0,
  })

  let registryApps: RegistryApp[]
  try {
    registryApps = await readRegistryApps()
  } catch (e: unknown) {
    emitStatus({
      state: 'error',
      appCount: 0,
      scannedCount: 0,
      totalBytes: 0,
      message: `Registry read failed: ${errorMessage(e)}`,
      warnings: 0,
      errors: 1,
    })
    return { apps: [], status: _lastStatus! }
  }

  if (_aborted) {
    return finalize(apps)
  }

  // Deduplicate by DisplayName (keep first occurrence)
  const seen = new Set<string>()
  const deduped: RegistryApp[] = []
  for (const app of registryApps) {
    const key = (app.DisplayName || '').toLowerCase().trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    deduped.push(app)
    if (deduped.length >= MAX_APPS) break
  }

  // Build entry objects
  for (let i = 0; i < deduped.length; i++) {
    apps.push(buildAppEntry(deduped[i], i))
  }

  emitStatus({
    state: 'scanning',
    appCount: apps.length,
    scannedCount: 0,
    totalBytes: 0,
    currentApp: 'Scanning directories...',
    warnings: 0,
    errors: 0,
  })

  // 2. Scan each app's candidate paths
  let totalBytes = 0
  let warnings = 0

  for (let i = 0; i < apps.length; i++) {
    if (_aborted) break
    const entry = apps[i]
    let scannedBytes = 0
    let dataBytes = 0
    let cacheBytes = 0
    let inaccessibleCount = 0

    for (let j = 0; j < entry.paths.length; j++) {
      if (_aborted) break
      const pe = entry.paths[j]

      // Check path exists and is accessible
      try {
        await fsp.access(pe.path)
        pe.exists = true
        pe.accessible = true
      } catch {
        pe.exists = false
        pe.accessible = false
        inaccessibleCount++
        continue
      }

      // Skip too-large root dirs
      if (isSkippableRoot(pe.path)) {
        warnings++
        pe.accessible = false
        continue
      }

      const sizeResult = await scanDirSize(pe.path)
      pe.bytes = sizeResult.bytes
      pe.accessible = true
      inaccessibleCount += sizeResult.inaccessible

      scannedBytes += sizeResult.bytes
      if (pe.kind === 'data') dataBytes += sizeResult.bytes
      else if (pe.kind === 'cache') cacheBytes += sizeResult.bytes
      // 'app' and 'unknown' go into scannedBytes but not separately tracked
    }

    entry.scannedBytes = scannedBytes
    entry.dataBytes = dataBytes
    entry.cacheBytes = cacheBytes
    entry.inaccessibleCount = inaccessibleCount
    // totalBytes: scanned size takes priority; fall back to registry estimate only if nothing was scanned
    if (scannedBytes > 0) {
      entry.totalBytes = scannedBytes
    } else if (entry.estimatedRegistryBytes) {
      entry.totalBytes = entry.estimatedRegistryBytes
    }
    entry.tags = computeTags(entry)
    totalBytes += scannedBytes

    // Push status update every few apps
    if (i % 5 === 0 || i === apps.length - 1) {
      emitStatus({
        state: _aborted ? 'stopping' : 'scanning',
        appCount: apps.length,
        scannedCount: i + 1,
        totalBytes,
        currentApp: entry.name,
        warnings,
        errors: 0,
      })
    }
  }

  if (_aborted) {
    return finalize(apps)
  }

  // Sort by totalBytes descending
  apps.sort((a, b) => b.totalBytes - a.totalBytes)

  const result = finalize(apps)
  try {
    await saveCache(result)
  } catch {
    // Cache write failure should not invalidate the scan result.
  }
  return result
}

function finalize(apps: AppStorageEntry[]): AppStorageScanResult {
  _lastStatus = {
    state: 'done',
    appCount: apps.length,
    scannedCount: apps.length,
    totalBytes: apps.reduce((s, a) => s + a.totalBytes, 0),
    warnings: apps.reduce((s, a) => s + a.inaccessibleCount, 0),
    errors: 0,
    message: `Scanned ${apps.length} apps`,
  }
  _lastResult = { apps, status: _lastStatus, cachePath: _cachePath }
  return _lastResult
}

export function stopScan(): void {
  _aborted = true
  emitStatus({
    ...getStatus(),
    state: 'stopping',
    message: 'Stopping...',
  })
}

export function getStatus(): AppStorageScanStatus {
  return (
    _lastStatus || {
      state: 'idle',
      appCount: 0,
      scannedCount: 0,
      totalBytes: 0,
      warnings: 0,
      errors: 0,
    }
  )
}

export function resetStatus(): void {
  _lastStatus = {
    state: 'idle',
    appCount: 0,
    scannedCount: 0,
    totalBytes: 0,
    warnings: 0,
    errors: 0,
  }
}
