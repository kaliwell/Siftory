import fs from 'fs'
import path from 'path'
import type { StorageInventoryItem, StorageInventoryTaskState } from '../shared/ipc-contract'
import { readVectorGcEstimate } from './vectorGcEstimate'
import { INDEX_ORPHAN_PROTECTION_MS, readManifestReferencedFiles } from './imageSearchIndexOrphans'

export interface StorageInventoryOccupancy {
  imageSearch?: StorageInventoryTaskState
  vectors?: StorageInventoryTaskState
  mediaSearch?: StorageInventoryTaskState
  assetLibrary?: StorageInventoryTaskState
}

interface PathSummary {
  totalBytes: number
  lastModifiedAt?: number
  fileCount: number
}

interface InventoryDefinition {
  id: string
  domain: StorageInventoryItem['domain']
  label: string
  pathCategory: string
  paths: string[]
  rebuildable: boolean
  cleanupRisk: StorageInventoryItem['cleanupRisk']
  taskState: StorageInventoryTaskState
  active?: (summaries: PathSummary[]) => number
  reclaimable: (summaries: PathSummary[]) => number
  detail?: string
  summaryOverride?: PathSummary & { activeBytes: number; reclaimableBytes: number }
}

interface ImageSearchIndexBreakdown {
  manifestReadable: boolean
  totalBytes: number
  orphanBytes: number
  fileCount: number
  lastModifiedAt?: number
}

async function summarizeImageSearchIndex(indexDir: string): Promise<ImageSearchIndexBreakdown> {
  const empty = { manifestReadable: true, totalBytes: 0, orphanBytes: 0, fileCount: 0 }
  try {
    if (!(await fs.promises.stat(indexDir)).isDirectory()) return empty
  } catch {
    return empty
  }
  const referenced = await readManifestReferencedFiles(indexDir)
  const orphanCutoff = Date.now() - INDEX_ORPHAN_PROTECTION_MS
  let totalBytes = 0
  let orphanBytes = 0
  let fileCount = 0
  let lastModifiedAt: number | undefined
  const segmentsRoot = path.resolve(indexDir, 'segments')
  const stagingRoot = path.resolve(indexDir, 'staging')
  const queue = [indexDir]
  while (queue.length > 0) {
    const current = queue.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stat = await fs.promises.stat(fullPath)
        totalBytes += stat.size
        fileCount++
        lastModifiedAt = Math.max(lastModifiedAt || 0, stat.mtimeMs)
        if (referenced) {
          const resolved = path.resolve(fullPath)
          const inSegmentArea =
            resolved.startsWith(segmentsRoot + path.sep) ||
            resolved.startsWith(stagingRoot + path.sep)
          if (inSegmentArea && !referenced.has(resolved) && stat.mtimeMs < orphanCutoff) {
            orphanBytes += stat.size
          }
        }
      } catch {
        // File vanished mid-walk; skip it.
      }
    }
  }
  return {
    manifestReadable: referenced !== null,
    totalBytes,
    orphanBytes,
    fileCount,
    lastModifiedAt,
  }
}

function mediaSearchSidecarPaths(mediaDir: string): string[] {
  try {
    const paths: string[] = []
    for (const entry of fs.readdirSync(mediaDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const fullPath = path.join(mediaDir, entry.name)
      // Extracted frames stay in their own inventory item; every other
      // top-level file or subdirectory (manifests, vectors, OCR,
      // transcripts, stats, thumbnails, temp) belongs to this one.
      if (entry.isFile()) paths.push(fullPath)
      else if (entry.isDirectory() && entry.name !== 'frames') paths.push(fullPath)
    }
    return paths
  } catch {
    return []
  }
}

async function summarizePath(targetPath: string): Promise<PathSummary> {
  let totalBytes = 0
  let lastModifiedAt: number | undefined
  let fileCount = 0
  const queue = [targetPath]
  const concurrency = 64
  while (queue.length > 0) {
    const batch = queue.splice(0, concurrency)
    const stats = await Promise.all(
      batch.map(async (current) => {
        try {
          return { current, stat: await fs.promises.stat(current) }
        } catch {
          return undefined
        }
      }),
    )
    const directories: string[] = []
    for (const result of stats) {
      if (!result) continue
      if (result.stat.isFile()) {
        totalBytes += result.stat.size
        fileCount++
        lastModifiedAt = Math.max(lastModifiedAt || 0, result.stat.mtimeMs)
      } else if (result.stat.isDirectory()) {
        directories.push(result.current)
      }
    }
    const children = await Promise.all(
      directories.map(async (directory) => {
        try {
          return (await fs.promises.readdir(directory, { withFileTypes: true }))
            .filter((entry) => !entry.isSymbolicLink())
            .map((entry) => path.join(directory, entry.name))
        } catch {
          return []
        }
      }),
    )
    for (const entries of children) {
      for (const entry of entries) queue.push(entry)
    }
  }
  return { totalBytes, lastModifiedAt, fileCount }
}

function filesMatching(directory: string, predicate: (name: string) => boolean): string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && predicate(entry.name))
      .map((entry) => path.join(directory, entry.name))
  } catch {
    return []
  }
}

function boundedLogReclaimable(limitBytes: number): (summaries: PathSummary[]) => number {
  return (summaries) =>
    Math.max(0, summaries.reduce((sum, item) => sum + item.totalBytes, 0) - limitBytes)
}

function olderBackupBytes(summaries: PathSummary[]): number {
  return summaries.slice(1).reduce((sum, item) => sum + item.totalBytes, 0)
}

function newestBackupBytes(summaries: PathSummary[]): number {
  return summaries[0]?.totalBytes || 0
}

function assetBackupPaths(userDataPath: string): string[] {
  const root = path.join(userDataPath, 'asset-library-backups')
  try {
    return (
      fs
        .readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith('backup-'),
        )
        .map((entry) => path.join(root, entry.name))
        // Backup ids embed UTC creation time; preserve this order even if a
        // cleanup changes an older directory's mutable mtime.
        .sort((left, right) => path.basename(right).localeCompare(path.basename(left)))
    )
  } catch {
    return []
  }
}

export async function buildStorageInventory(
  userDataPath: string,
  occupancy: StorageInventoryOccupancy = {},
): Promise<{ items: StorageInventoryItem[]; totalBytes: number; reclaimableBytes: number }> {
  const vectorDb = path.join(userDataPath, 'vector-db')
  const embeddingCache = path.join(vectorDb, 'embedding-cache')
  const assetLibrary = path.join(userDataPath, 'asset-library')
  const imageState = occupancy.imageSearch || 'unknown'
  const vectorState = occupancy.vectors || 'unknown'
  const mediaState = occupancy.mediaSearch || 'unknown'
  const assetState = occupancy.assetLibrary || 'unknown'
  const [gcEstimate, indexBreakdown] = await Promise.all([
    readVectorGcEstimate(userDataPath),
    summarizeImageSearchIndex(path.join(userDataPath, 'image-search-index')),
  ])
  const gcEstimateDetail =
    gcEstimate.matchedShards > 0
      ? `Active-set GC preview from ${new Date(gcEstimate.estimatedAt || 0).toISOString()} ` +
        `covers ${gcEstimate.matchedShards}/${gcEstimate.totalShards} unchanged shards; ` +
        'run a new Vector GC preview to refresh the estimate.'
      : 'No unchanged-shard GC estimate; run a Vector GC preview to estimate reclaimable bytes.'
  const indexDetail = !indexBreakdown.manifestReadable
    ? 'Manifest unreadable; orphan estimate disabled (fail-closed). ' +
      'Rebuildable, but removing it makes image search unavailable until a rescan completes.'
    : indexBreakdown.orphanBytes > 0
      ? 'Unreferenced segment/staging files older than 24h are the reclaimable estimate; ' +
        'actual removal requires idle tasks and a fresh manifest check.'
      : 'Rebuildable, but removing it makes image search unavailable until a rescan completes.'
  const definitions: InventoryDefinition[] = [
    {
      id: 'image-search-logs',
      domain: 'image-search',
      label: 'Scan logs',
      pathCategory: 'Image Search / logs',
      paths: filesMatching(userDataPath, (name) => name.startsWith('image-search-scan.log')),
      rebuildable: false,
      cleanupRisk: 'low',
      taskState: imageState,
      reclaimable: boundedLogReclaimable(24 * 1024 * 1024),
      detail: 'Only bytes beyond the retained log budget are reclaimable.',
    },
    {
      id: 'image-search-index',
      domain: 'image-search',
      label: 'Hash index',
      pathCategory: 'Image Search / authoritative index',
      paths: [],
      rebuildable: true,
      cleanupRisk: 'high',
      taskState: imageState,
      reclaimable: () => 0,
      detail: indexDetail,
      summaryOverride: {
        totalBytes: indexBreakdown.totalBytes,
        lastModifiedAt: indexBreakdown.lastModifiedAt,
        fileCount: indexBreakdown.fileCount,
        activeBytes: Math.max(0, indexBreakdown.totalBytes - indexBreakdown.orphanBytes),
        reclaimableBytes: indexBreakdown.orphanBytes,
      },
    },
    {
      id: 'image-search-thumbnails',
      domain: 'image-search',
      label: 'Thumbnails',
      pathCategory: 'Image Search / derived thumbnails',
      paths: [path.join(userDataPath, 'thumbcache')],
      rebuildable: true,
      cleanupRisk: 'low',
      taskState: imageState,
      reclaimable: (summaries) => summaries.reduce((sum, item) => sum + item.totalBytes, 0),
    },
    {
      id: 'vector-jsonl',
      domain: 'vectors',
      label: 'CLIP/DINO embeddings',
      pathCategory: 'Vectors / authoritative JSONL',
      paths: filesMatching(path.join(vectorDb, 'embeddings'), (name) => name.endsWith('.jsonl')),
      rebuildable: true,
      cleanupRisk: 'high',
      taskState: vectorState,
      active: (summaries) =>
        Math.max(
          0,
          summaries.reduce((sum, item) => sum + item.totalBytes, 0) - gcEstimate.reclaimableBytes,
        ),
      reclaimable: () => gcEstimate.reclaimableBytes,
      detail: gcEstimateDetail,
    },
    {
      id: 'vector-gc-backups',
      domain: 'vectors',
      label: 'Vector GC recovery snapshots',
      pathCategory: 'Vectors / recovery snapshots',
      paths: filesMatching(path.join(vectorDb, 'embeddings'), (name) =>
        name.includes('.jsonl.gc-backup-'),
      ),
      rebuildable: false,
      cleanupRisk: 'medium',
      taskState: vectorState,
      reclaimable: () => 0,
      detail: 'Recovery snapshots remain protected until their recorded expiry.',
    },
    {
      id: 'vector-caches',
      domain: 'vectors',
      label: 'F32/F16 caches',
      pathCategory: 'Vectors / derived caches',
      paths: [
        path.join(vectorDb, 'clip_embedding_cache.f32'),
        path.join(vectorDb, 'clip_embedding_cache.json'),
        path.join(vectorDb, 'clip_embedding_paths.jsonl'),
        ...filesMatching(embeddingCache, (name) => !name.includes('.ann-')),
      ],
      rebuildable: true,
      cleanupRisk: 'medium',
      taskState: vectorState,
      reclaimable: (summaries) => summaries.reduce((sum, item) => sum + item.totalBytes, 0),
    },
    {
      id: 'vector-ann',
      domain: 'vectors',
      label: 'ANN indexes',
      pathCategory: 'Vectors / derived ANN',
      paths: filesMatching(embeddingCache, (name) => name.includes('.ann-')),
      rebuildable: true,
      cleanupRisk: 'low',
      taskState: vectorState,
      reclaimable: (summaries) => summaries.reduce((sum, item) => sum + item.totalBytes, 0),
    },
    {
      id: 'media-frames',
      domain: 'media-search',
      label: 'Extracted frames',
      pathCategory: 'Media Search / derived frames',
      paths: [path.join(userDataPath, 'media-search', 'frames')],
      rebuildable: true,
      cleanupRisk: 'low',
      taskState: mediaState,
      reclaimable: (summaries) => summaries.reduce((sum, item) => sum + item.totalBytes, 0),
    },
    {
      id: 'media-vectors',
      domain: 'media-search',
      label: 'Frame vectors and manifests',
      pathCategory: 'Media Search / vectors, manifests and sidecars',
      paths: mediaSearchSidecarPaths(path.join(userDataPath, 'media-search')),
      rebuildable: true,
      cleanupRisk: 'medium',
      taskState: mediaState,
      reclaimable: (summaries) => summaries.reduce((sum, item) => sum + item.totalBytes, 0),
      detail:
        'Includes manifests, frame vectors, OCR, transcripts, stats, thumbnails and temp ' +
        'sidecars; extracted frames are listed separately.',
    },
    {
      id: 'asset-backups',
      domain: 'asset-library',
      label: 'Backups',
      pathCategory: 'Asset Library / backups',
      paths: assetBackupPaths(userDataPath),
      rebuildable: false,
      cleanupRisk: 'medium',
      taskState: assetState,
      active: newestBackupBytes,
      reclaimable: olderBackupBytes,
      detail: 'The newest backup is protected; older backups are the reclaimable estimate.',
    },
    {
      id: 'asset-recovery',
      domain: 'asset-library',
      label: 'Recovery data',
      pathCategory: 'Asset Library / recovery',
      paths: [path.join(userDataPath, 'asset-library-recovery')],
      rebuildable: false,
      cleanupRisk: 'high',
      taskState: assetState,
      reclaimable: () => 0,
    },
    {
      id: 'asset-deletion-history',
      domain: 'asset-library',
      label: 'Deletion history',
      pathCategory: 'Asset Library / deletion history',
      paths: [
        path.join(assetLibrary, 'metadata_deletion_trash.jsonl'),
        path.join(assetLibrary, 'asset-library.sqlite'),
        path.join(assetLibrary, 'asset-library.sqlite-wal'),
      ],
      rebuildable: false,
      cleanupRisk: 'high',
      taskState: assetState,
      reclaimable: () => 0,
      detail: 'SQLite size is included because deletion history shares the authoritative database.',
    },
    {
      id: 'vector-failures',
      domain: 'maintenance',
      label: 'Embedding failures',
      pathCategory: 'Maintenance / failure log',
      paths: [path.join(vectorDb, 'embedding_failures.jsonl')],
      rebuildable: false,
      cleanupRisk: 'medium',
      taskState: vectorState,
      reclaimable: boundedLogReclaimable(32 * 1024 * 1024),
    },
    {
      id: 'vector-diagnostics',
      domain: 'maintenance',
      label: 'Embedding diagnostics',
      pathCategory: 'Maintenance / diagnostics',
      paths: [
        path.join(vectorDb, 'embedding_diagnostics.jsonl'),
        ...filesMatching(vectorDb, (name) => name.startsWith('embedding_diagnostics.jsonl.')),
      ],
      rebuildable: false,
      cleanupRisk: 'low',
      taskState: vectorState,
      reclaimable: boundedLogReclaimable(80 * 1024 * 1024),
    },
    {
      id: 'vector-jobs',
      domain: 'maintenance',
      label: 'Embedding jobs',
      pathCategory: 'Maintenance / job history',
      paths: [path.join(vectorDb, 'embedding_jobs.jsonl')],
      rebuildable: false,
      cleanupRisk: 'high',
      taskState: vectorState,
      reclaimable: () => 0,
      detail: 'Pending and running jobs remain active and are never estimated as reclaimable.',
    },
    {
      id: 'user-models',
      domain: 'maintenance',
      label: 'User AI models',
      pathCategory: 'Model Platform / user-supplied models',
      paths: [path.join(userDataPath, 'models')],
      rebuildable: false,
      cleanupRisk: 'high',
      taskState: 'unknown',
      reclaimable: () => 0,
      detail:
        'User-installed ONNX models; removing them disables dependent features until reinstalled.',
    },
  ]

  const items = await Promise.all(
    definitions.map(async (definition): Promise<StorageInventoryItem> => {
      const summaries = await Promise.all(definition.paths.map(summarizePath))
      const totalBytes =
        definition.summaryOverride?.totalBytes ??
        summaries.reduce((sum, item) => sum + item.totalBytes, 0)
      const reclaimableBytes = Math.min(
        totalBytes,
        Math.max(
          0,
          definition.summaryOverride?.reclaimableBytes ?? definition.reclaimable(summaries),
        ),
      )
      const lastModifiedAt = summaries.reduce<number | undefined>(
        (latest, item) =>
          item.lastModifiedAt && (!latest || item.lastModifiedAt > latest)
            ? item.lastModifiedAt
            : latest,
        definition.summaryOverride?.lastModifiedAt,
      )
      return {
        id: definition.id,
        domain: definition.domain,
        label: definition.label,
        pathCategory: definition.pathCategory,
        totalBytes,
        activeBytes: Math.min(
          totalBytes,
          Math.max(
            0,
            definition.summaryOverride?.activeBytes ??
              (definition.active ? definition.active(summaries) : totalBytes),
          ),
        ),
        reclaimableBytes,
        lastModifiedAt,
        rebuildable: definition.rebuildable,
        cleanupRisk: definition.cleanupRisk,
        taskState: definition.taskState,
        fileCount:
          definition.summaryOverride?.fileCount ??
          summaries.reduce((sum, item) => sum + item.fileCount, 0),
        detail: definition.detail,
      }
    }),
  )
  return {
    items,
    totalBytes: items.reduce((sum, item) => sum + item.totalBytes, 0),
    reclaimableBytes: items.reduce((sum, item) => sum + item.reclaimableBytes, 0),
  }
}
