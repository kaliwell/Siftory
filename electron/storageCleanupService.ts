import fs from 'fs'
import path from 'path'
import type {
  StorageCleanupPreview,
  StorageCleanupProgress,
  StorageInventoryItem,
} from '../shared/ipc-contract'
import { readCurrentAuthoritativeManifest } from './authoritativeVectorStore'

interface CleanupTarget {
  itemId: string
  path: string
  sizeBytes: number
}

interface StoredPreview {
  preview: StorageCleanupPreview
  targets: CleanupTarget[]
  userDataPath: string
}

const previews = new Map<string, StoredPreview>()
let progress: StorageCleanupProgress = {
  state: 'idle',
  completedFiles: 0,
  totalFiles: 0,
  freedBytes: 0,
  skipped: 0,
  errors: [],
}
let cancelRequested = false

const ITEM_META: Record<
  string,
  {
    label: string
    pathCategory: string
    domain: StorageInventoryItem['domain']
    cleanupRisk: StorageInventoryItem['cleanupRisk']
  }
> = {
  'image-search-logs': {
    label: 'Retired scan logs',
    pathCategory: 'Image Search / rotated logs',
    domain: 'image-search',
    cleanupRisk: 'low',
  },
  'image-search-thumbnails': {
    label: 'Thumbnails',
    pathCategory: 'Image Search / derived thumbnails',
    domain: 'image-search',
    cleanupRisk: 'low',
  },
  'vector-caches': {
    label: 'F32/F16 caches',
    pathCategory: 'Vectors / derived caches',
    domain: 'vectors',
    cleanupRisk: 'medium',
  },
  'vector-ann': {
    label: 'ANN indexes',
    pathCategory: 'Vectors / derived ANN',
    domain: 'vectors',
    cleanupRisk: 'low',
  },
  'vector-gc-backups': {
    label: 'Expired Vector GC snapshots',
    pathCategory: 'Vectors / expired recovery snapshots',
    domain: 'vectors',
    cleanupRisk: 'medium',
  },
  'vector-store-old-generations': {
    label: 'Old vector generations',
    pathCategory: 'Vectors / superseded binary generations',
    domain: 'vectors',
    cleanupRisk: 'medium',
  },
  'media-frames': {
    label: 'Extracted frames',
    pathCategory: 'Media Search / derived frames',
    domain: 'media-search',
    cleanupRisk: 'low',
  },
  'media-vectors': {
    label: 'Frame vectors and manifests',
    pathCategory: 'Media Search / derived vectors and manifests',
    domain: 'media-search',
    cleanupRisk: 'medium',
  },
  'asset-backups': {
    label: 'Old backups',
    pathCategory: 'Asset Library / superseded backups',
    domain: 'asset-library',
    cleanupRisk: 'medium',
  },
  'vector-diagnostics': {
    label: 'Old diagnostics',
    pathCategory: 'Maintenance / retired diagnostic backups',
    domain: 'maintenance',
    cleanupRisk: 'low',
  },
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function collectFiles(root: string): Promise<CleanupTarget[]> {
  const results: CleanupTarget[] = []
  const queue = [root]
  while (queue.length > 0) {
    const batch = queue.splice(0, 64)
    const entries = await Promise.all(
      batch.map(async (target) => {
        try {
          return { target, stat: await fs.promises.lstat(target) }
        } catch {
          return undefined
        }
      }),
    )
    const directories: string[] = []
    for (const entry of entries) {
      if (!entry || entry.stat.isSymbolicLink()) continue
      if (entry.stat.isFile()) {
        results.push({ itemId: '', path: entry.target, sizeBytes: entry.stat.size })
      } else if (entry.stat.isDirectory()) {
        directories.push(entry.target)
      }
    }
    const children = await Promise.all(
      directories.map(async (directory) => {
        try {
          return (await fs.promises.readdir(directory)).map((name) => path.join(directory, name))
        } catch {
          return []
        }
      }),
    )
    for (const group of children) {
      for (const child of group) queue.push(child)
    }
  }
  return results
}

async function directFiles(
  directory: string,
  predicate: (name: string) => boolean,
): Promise<CleanupTarget[]> {
  try {
    const names = (await fs.promises.readdir(directory)).filter(predicate)
    const targets = await Promise.all(
      names.map(async (name): Promise<CleanupTarget | undefined> => {
        const target = path.join(directory, name)
        try {
          const stat = await fs.promises.lstat(target)
          return stat.isFile() && !stat.isSymbolicLink()
            ? { itemId: '', path: target, sizeBytes: stat.size }
            : undefined
        } catch {
          return undefined
        }
      }),
    )
    return targets.filter((target): target is CleanupTarget => Boolean(target))
  } catch {
    return []
  }
}

async function collectCandidates(userDataPath: string): Promise<CleanupTarget[]> {
  const vectorDb = path.join(userDataPath, 'vector-db')
  const embeddingCache = path.join(vectorDb, 'embedding-cache')
  const assign = (itemId: string, targets: CleanupTarget[]) =>
    targets.map((target) => ({ ...target, itemId }))
  const retiredLogs = await directFiles(userDataPath, (name) =>
    /^image-search-scan\.log\.\d+$/.test(name),
  )
  const cacheFiles = await directFiles(
    vectorDb,
    (name) =>
      name === 'clip_embedding_cache.f32' ||
      name === 'clip_embedding_cache.json' ||
      name === 'clip_embedding_paths.jsonl',
  )
  const f16Files = await directFiles(embeddingCache, (name) => !name.includes('.ann-'))
  const annFiles = await directFiles(embeddingCache, (name) => name.includes('.ann-'))
  const mediaRootFiles = await directFiles(path.join(userDataPath, 'media-search'), () => true)
  const diagnosticFiles = (
    await directFiles(vectorDb, (name) => name.startsWith('embedding_diagnostics.jsonl.'))
  )
    .sort((a, b) => b.path.localeCompare(a.path))
    .slice(3)
  const expiredGcBackups: CleanupTarget[] = []
  const embeddingsDirectory = path.join(vectorDb, 'embeddings')
  for (const metadata of await directFiles(embeddingsDirectory, (name) =>
    /\.jsonl\.gc-backup-\d+\.json$/.test(name),
  )) {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(metadata.path, 'utf8')) as {
        expiresAt?: unknown
        backup?: unknown
      }
      if (
        typeof parsed.expiresAt !== 'string' ||
        Date.parse(parsed.expiresAt) > Date.now() ||
        typeof parsed.backup !== 'string' ||
        path.basename(parsed.backup) !== parsed.backup
      ) {
        continue
      }
      const backupPath = path.join(embeddingsDirectory, parsed.backup)
      const backupStat = await fs.promises.lstat(backupPath)
      if (backupStat.isFile() && !backupStat.isSymbolicLink()) {
        expiredGcBackups.push({
          itemId: '',
          path: backupPath,
          sizeBytes: backupStat.size,
        })
        expiredGcBackups.push(metadata)
      }
    } catch {
      /* invalid or incomplete recovery metadata remains protected */
    }
  }

  const oldVectorGenerations: CleanupTarget[] = []
  const vectorStoreRoot = path.join(vectorDb, 'vector-store')
  const currentManifest = readCurrentAuthoritativeManifest(vectorStoreRoot)
  if (currentManifest) {
    const generationsRoot = path.join(vectorStoreRoot, 'generations')
    try {
      for (const name of await fs.promises.readdir(generationsRoot)) {
        if (name === currentManifest.generation || name.startsWith('.')) continue
        oldVectorGenerations.push(...(await collectFiles(path.join(generationsRoot, name))))
      }
    } catch {
      /* no superseded generations */
    }
  }

  let oldBackups: CleanupTarget[] = []
  const backupRoot = path.join(userDataPath, 'asset-library-backups')
  try {
    const backupDirs = await Promise.all(
      (await fs.promises.readdir(backupRoot))
        .filter((name) => name.startsWith('backup-'))
        .map(async (name) => {
          const target = path.join(backupRoot, name)
          try {
            const stat = await fs.promises.stat(target)
            return stat.isDirectory() ? { target } : undefined
          } catch {
            return undefined
          }
        }),
    )
    const ordered = backupDirs
      .filter((item): item is { target: string } => Boolean(item))
      // Managed backup ids begin with a UTC timestamp. Directory mtimes are
      // mutable when old files are removed, so they cannot define retention.
      .sort((a, b) => path.basename(b.target).localeCompare(path.basename(a.target)))
      .slice(1)
    oldBackups = (await Promise.all(ordered.map((item) => collectFiles(item.target)))).flat()
  } catch {
    /* no backups */
  }

  return [
    ...assign('image-search-logs', retiredLogs),
    ...assign('image-search-thumbnails', await collectFiles(path.join(userDataPath, 'thumbcache'))),
    ...assign('vector-caches', [...cacheFiles, ...f16Files]),
    ...assign('vector-ann', annFiles),
    ...assign('vector-gc-backups', expiredGcBackups),
    ...assign('vector-store-old-generations', oldVectorGenerations),
    ...assign(
      'media-frames',
      await collectFiles(path.join(userDataPath, 'media-search', 'frames')),
    ),
    ...assign('media-vectors', mediaRootFiles),
    ...assign('asset-backups', oldBackups),
    ...assign('vector-diagnostics', diagnosticFiles),
  ]
}

export async function previewStorageCleanup(userDataPath: string): Promise<StorageCleanupPreview> {
  const targets = await collectCandidates(userDataPath)
  const token = randomId('cleanup-preview')
  const grouped = new Map<string, CleanupTarget[]>()
  for (const target of targets) {
    const list = grouped.get(target.itemId) || []
    list.push(target)
    grouped.set(target.itemId, list)
  }
  const items = [...grouped.entries()]
    .map(([id, entries]) => ({
      id,
      ...ITEM_META[id],
      estimatedBytes: entries.reduce((sum, item) => sum + item.sizeBytes, 0),
      fileCount: entries.length,
    }))
    .filter((item) => item.estimatedBytes > 0)
  const preview: StorageCleanupPreview = {
    token,
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000,
    items,
    estimatedBytes: items.reduce((sum, item) => sum + item.estimatedBytes, 0),
  }
  previews.clear()
  previews.set(token, { preview, targets, userDataPath: path.resolve(userDataPath) })
  return preview
}

function setProgress(update: Partial<StorageCleanupProgress>): void {
  progress = { ...progress, ...update, updatedAt: Date.now() }
}

async function runCleanup(stored: StoredPreview, selectedIds: Set<string>): Promise<void> {
  const targets = stored.targets.filter((target) => selectedIds.has(target.itemId))
  setProgress({
    state: 'running',
    completedFiles: 0,
    totalFiles: targets.length,
    freedBytes: 0,
    skipped: 0,
    errors: [],
    startedAt: Date.now(),
    finishedAt: undefined,
  })
  for (const target of targets) {
    if (cancelRequested) {
      setProgress({ state: 'cancelled', finishedAt: Date.now() })
      return
    }
    if (!isContained(stored.userDataPath, target.path)) {
      setProgress({
        skipped: progress.skipped + 1,
        completedFiles: progress.completedFiles + 1,
      })
      continue
    }
    try {
      const realTarget = await fs.promises.realpath(target.path)
      const realRoot = await fs.promises.realpath(stored.userDataPath)
      if (!isContained(realRoot, realTarget)) {
        setProgress({
          skipped: progress.skipped + 1,
          completedFiles: progress.completedFiles + 1,
        })
        continue
      }
      const stat = await fs.promises.lstat(target.path)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        setProgress({ skipped: progress.skipped + 1 })
      } else {
        await fs.promises.unlink(target.path)
        setProgress({ freedBytes: progress.freedBytes + stat.size })
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        setProgress({ skipped: progress.skipped + 1 })
      } else {
        setProgress({
          errors: [
            ...progress.errors,
            error instanceof Error ? error.message : String(error),
          ].slice(-20),
        })
      }
    }
    setProgress({ completedFiles: progress.completedFiles + 1 })
  }
  setProgress({ state: 'completed', finishedAt: Date.now() })
}

export function startStorageCleanup(
  userDataPath: string,
  request: { token: string; selectedIds: string[] },
  blockedDomains: Set<StorageInventoryItem['domain']> = new Set(),
): { ok: boolean; taskId?: string; error?: string } {
  if (progress.state === 'running')
    return { ok: false, error: 'Storage cleanup is already running' }
  const stored = previews.get(request.token)
  if (!stored || stored.userDataPath !== path.resolve(userDataPath)) {
    return { ok: false, error: 'Cleanup preview is missing or no longer valid' }
  }
  if (stored.preview.expiresAt < Date.now()) {
    previews.delete(request.token)
    return { ok: false, error: 'Cleanup preview expired; scan again before confirming' }
  }
  const selectedIds = new Set(request.selectedIds.filter((id) => ITEM_META[id]))
  if (selectedIds.size === 0) return { ok: false, error: 'Select at least one cleanup item' }
  for (const id of selectedIds) {
    if (blockedDomains.has(ITEM_META[id].domain)) {
      return { ok: false, error: `${ITEM_META[id].label} is in use by an active task` }
    }
  }
  const taskId = randomId('storage-cleanup')
  const snapshotDir = path.join(userDataPath, 'storage-cleanup-snapshots')
  const snapshotPath = path.join(snapshotDir, `${taskId}.json`)
  const selectedTargets = stored.targets.filter((target) => selectedIds.has(target.itemId))
  const snapshot = JSON.stringify(
    {
      taskId,
      createdAt: new Date().toISOString(),
      previewToken: request.token,
      selectedIds: [...selectedIds],
      targets: selectedTargets.map((target) => ({
        path: target.path,
        sizeBytes: target.sizeBytes,
      })),
    },
    null,
    2,
  )
  try {
    const disk = fs.statfsSync(userDataPath)
    const availableBytes = disk.bavail * disk.bsize
    if (availableBytes < Buffer.byteLength(snapshot) + 1024 * 1024) {
      return { ok: false, error: 'Not enough free space to create the cleanup snapshot' }
    }
    fs.mkdirSync(snapshotDir, { recursive: true })
    fs.writeFileSync(snapshotPath, snapshot, { encoding: 'utf8', flag: 'wx' })
  } catch (error: unknown) {
    return {
      ok: false,
      error: `Could not create cleanup snapshot: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  previews.delete(request.token)
  cancelRequested = false
  progress = {
    taskId,
    state: 'running',
    selectedIds: [...selectedIds],
    completedFiles: 0,
    totalFiles: selectedTargets.length,
    freedBytes: 0,
    skipped: 0,
    errors: [],
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
  void runCleanup(stored, selectedIds).catch((error: unknown) => {
    setProgress({
      state: 'error',
      finishedAt: Date.now(),
      errors: [...progress.errors, error instanceof Error ? error.message : String(error)].slice(
        -20,
      ),
    })
  })
  return { ok: true, taskId }
}

export function cancelStorageCleanup(): { ok: boolean } {
  if (progress.state === 'running') cancelRequested = true
  return { ok: true }
}

export function getStorageCleanupProgress(): StorageCleanupProgress {
  return { ...progress, errors: [...progress.errors] }
}

export function isStorageCleanupActiveFor(domain: StorageInventoryItem['domain']): boolean {
  if (progress.state !== 'running' || !progress.selectedIds) return false
  return progress.selectedIds.some((id) => ITEM_META[id]?.domain === domain)
}

export function resetStorageCleanupForTests(): void {
  previews.clear()
  cancelRequested = false
  progress = {
    state: 'idle',
    completedFiles: 0,
    totalFiles: 0,
    freedBytes: 0,
    skipped: 0,
    errors: [],
  }
}
