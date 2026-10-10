import path from 'node:path'
import type { ImageSearchStartScanArgs } from '../shared/ipc-contract'
import type { EmbeddingProgress, VectorBuildRequest } from '../shared/vectorTypes'
import { getEmbeddingProgress, onEmbeddingProgress, stopEmbeddingBuild } from './embeddingService'
import { cancelQueuedEmbeddingBuild, queueEmbeddingBuild } from './embeddingTaskScheduling'
import {
  getImageSearchStatus,
  isImageSearchScanLifecycleComplete,
  onImageSearchStatus,
  startImageSearchScan,
  stopImageSearchScan,
  waitForImageSearchPersistence,
} from './imageSearchService'
import type { UnifiedTaskSubmitter } from './unifiedTaskSubmission'
import { buildVectorIndex, clearVectorIndex } from './vectorIndexService'
import { authoritativeVectorStoreRootFromCacheDir } from './authoritativeVectorStore'
import {
  AssetRepairRecoveryJournal,
  executeAssetRepairRecoverySteps,
  type AssetRepairJournalProtectionAdapter,
  type AssetRepairRecoveryRecord,
} from './assetDerivedRebuildGrant'
import { getAssetIdentityService } from './assetIdentityService'
import { requireAssetLibraryStores } from './assetLibraryStorageContext'
import { isImageSearchIndexedPath, repairImageSearchDataPath } from './imageSearchService'
import { getSourceCatalogService } from './sourceCatalogService'
import { repairVectorIndexPathKeys } from './vectorPathKeyRepair'
import { waitForBoundedOperation, waitForBoundedTerminal } from './assetDerivedRebuildCoordinator'

const DEFAULT_SCAN_TIMEOUT_MS = 30 * 60_000
const DEFAULT_PERSISTENCE_TIMEOUT_MS = 5 * 60_000
const DEFAULT_EMBEDDING_TIMEOUT_MS = 60 * 60_000
const DEFAULT_VECTOR_INDEX_TIMEOUT_MS = 30 * 60_000

function timeoutValue(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value as number)) : fallback
}

function cancellationError(label: string, aborted: boolean): Error {
  return new Error(aborted ? `${label} was cancelled` : `${label} timed out`)
}

function waitForImageSearchTerminal(options: {
  timeoutMs: number
  signal?: AbortSignal
}): Promise<void> {
  return waitForBoundedTerminal({
    label: 'Image scan',
    timeoutMs: options.timeoutMs,
    getCurrent: isImageSearchScanLifecycleComplete,
    isTerminal: Boolean,
    subscribe: (listener) =>
      onImageSearchStatus(() => listener(isImageSearchScanLifecycleComplete())),
    cancel: stopImageSearchScan,
    ...(options.signal ? { signal: options.signal } : {}),
  }).then(() => undefined)
}

function embeddingIsTerminal(progress: EmbeddingProgress): boolean {
  return progress.state === 'done' || progress.state === 'error'
}

function waitForEmbeddingTerminal(options: {
  timeoutMs: number
  signal?: AbortSignal
}): Promise<EmbeddingProgress> {
  return waitForBoundedTerminal({
    label: 'Embedding build',
    timeoutMs: options.timeoutMs,
    getCurrent: getEmbeddingProgress,
    isTerminal: embeddingIsTerminal,
    subscribe: onEmbeddingProgress,
    cancel: () => {
      if (!cancelQueuedEmbeddingBuild()) stopEmbeddingBuild()
    },
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

async function runEmbeddingBuild(
  request: VectorBuildRequest,
  scheduler: UnifiedTaskSubmitter,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<void> {
  const queued = queueEmbeddingBuild(request, scheduler)
  if (!queued.ok) throw new Error(queued.error || queued.runtimeError?.detail || 'Embedding failed')
  const terminal = await waitForEmbeddingTerminal(options)
  if (terminal.state === 'error') throw new Error(terminal.error || 'Embedding failed')
}

export async function runAssetDerivedRebuild(options: {
  roots: string[]
  scheduler: UnifiedTaskSubmitter
  rebuildVectors: boolean
  scanTimeoutMs?: number
  persistenceTimeoutMs?: number
  embeddingTimeoutMs?: number
  vectorIndexTimeoutMs?: number
  signal?: AbortSignal
}): Promise<void> {
  if (options.signal?.aborted) throw cancellationError('Derived rebuild', true)
  const scanRequest: ImageSearchStartScanArgs = {
    paths: options.roots,
    mode: 'balanced',
    scanMode: 'full',
    buildThumbnails: true,
  }
  const started = startImageSearchScan(scanRequest)
  if (started.state === 'error') throw new Error(started.lastError || 'Image scan failed')
  await waitForImageSearchTerminal({
    timeoutMs: timeoutValue(options.scanTimeoutMs, DEFAULT_SCAN_TIMEOUT_MS),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  await waitForBoundedOperation({
    label: 'Image scan persistence',
    timeoutMs: timeoutValue(options.persistenceTimeoutMs, DEFAULT_PERSISTENCE_TIMEOUT_MS),
    operation: waitForImageSearchPersistence(),
    cancel: stopImageSearchScan,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const terminal = getImageSearchStatus()
  if (terminal.state === 'error') throw new Error(terminal.lastError || 'Image scan failed')
  if (!options.rebuildVectors) return

  for (const modelName of ['dinov2_vitb14', 'clip_vit_base_patch32'] as const) {
    await runEmbeddingBuild(
      {
        modelName,
        embeddingType: 'global',
        scanPaths: options.roots,
        backend: 'auto',
        maxConcurrentEmbeddings: 1,
        batchSize: 0,
      },
      options.scheduler,
      {
        timeoutMs: timeoutValue(options.embeddingTimeoutMs, DEFAULT_EMBEDDING_TIMEOUT_MS),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    )
  }
  const index = await waitForBoundedOperation({
    label: 'Vector index build',
    timeoutMs: timeoutValue(options.vectorIndexTimeoutMs, DEFAULT_VECTOR_INDEX_TIMEOUT_MS),
    operation: buildVectorIndex('dinov2_vitb14'),
    cancel: clearVectorIndex,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!index.ok) throw new Error(index.error || 'Vector index build failed')
}

function sameRecoveryPath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

function recoveryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class AssetRepairRecoveryRuntime {
  readonly journal: AssetRepairRecoveryJournal

  constructor(
    readonly userDataPath: string,
    options: { protectionAdapter?: AssetRepairJournalProtectionAdapter } = {},
  ) {
    this.journal = new AssetRepairRecoveryJournal(userDataPath, {
      ...(options.protectionAdapter ? { protectionAdapter: options.protectionAdapter } : {}),
    })
  }

  private async repairIdentity(record: AssetRepairRecoveryRecord): Promise<void> {
    const service = getAssetIdentityService()
    if (!service) throw new Error('Asset identity service is not initialized')
    const current = await service.getByAssetId(record.assetId)
    if (current && sameRecoveryPath(current.path, record.newPath)) return
    const repaired = await service.repairMovedFile(record.newPath)
    if (!repaired || repaired.assetId !== record.assetId) {
      throw new Error('Could not restore the moved asset identity mapping')
    }
  }

  private async repairAssetLibrary(record: AssetRepairRecoveryRecord): Promise<void> {
    const stores = requireAssetLibraryStores()
    await stores.assets.ensureLoaded()
    const oldRecord = stores.assets.getByPath(record.oldPath)
    const newRecord = stores.assets.getByPath(record.newPath)
    if (oldRecord && newRecord && oldRecord.id !== newRecord.id) {
      throw new Error('Asset Library destination is already owned by another asset')
    }
    if (newRecord) return
    if (!oldRecord) return
    const repaired = await stores.assets.repathAsset(oldRecord.id, record.newPath)
    if (!repaired || !sameRecoveryPath(repaired.path, record.newPath)) {
      throw new Error('Asset Library path repair did not commit')
    }
  }

  private repairSourceCatalog(record: AssetRepairRecoveryRecord): void {
    const service = getSourceCatalogService()
    if (!service) throw new Error('Source Catalog service is not initialized')
    service.repairMovedPath(record.oldPath, record.newPath)
  }

  private async repairNativeIndex(record: AssetRepairRecoveryRecord): Promise<void> {
    const status = getImageSearchStatus()
    if (!status.nativeConnected) throw new Error('Native image index is unavailable')
    if (!isImageSearchIndexedPath(record.oldPath)) {
      if (isImageSearchIndexedPath(record.newPath)) return
      throw new Error('Native image index lost the moved path before repair')
    }
    const repaired = await repairImageSearchDataPath(record.oldPath, record.newPath)
    if (!repaired.ok) throw new Error(repaired.error || 'Native index path repair failed')
  }

  private repairVectorIndex(record: AssetRepairRecoveryRecord): void {
    const cacheDir = path.join(this.userDataPath, 'vector-db', 'embedding-cache')
    const repaired = repairVectorIndexPathKeys({
      repairs: [{ oldPath: record.oldPath, newPath: record.newPath }],
      cacheDir,
      storeRoot: authoritativeVectorStoreRootFromCacheDir(cacheDir),
    })
    if (repaired.status === 'refused-corrupt') {
      throw new Error(repaired.detail || 'Vector index path repair refused on corrupt data')
    }
  }

  async resume(recordId: string): Promise<AssetRepairRecoveryRecord> {
    const getRecord = async () => {
      const record = await this.journal.get(recordId)
      if (!record) throw new Error('Asset repair recovery record not found')
      return record
    }
    return executeAssetRepairRecoverySteps({
      journal: this.journal,
      recordId,
      operations: {
        identity: async () => this.repairIdentity(await getRecord()),
        assetLibrary: async () => this.repairAssetLibrary(await getRecord()),
        sourceCatalog: async () => this.repairSourceCatalog(await getRecord()),
        nativeIndex: async () => this.repairNativeIndex(await getRecord()),
        vectorIndex: async () => this.repairVectorIndex(await getRecord()),
      },
    })
  }

  async markRebuilding(
    recordId: string,
    rebuildVectorData: boolean,
  ): Promise<AssetRepairRecoveryRecord> {
    return this.journal.update(recordId, {
      state: 'rebuilding',
      rebuildVectorData,
      incrementAttempts: true,
    })
  }

  async markDerivedCleared(recordId: string): Promise<AssetRepairRecoveryRecord> {
    return this.journal.markStep(recordId, 'derivedCleared')
  }

  async markDerivedRebuilt(recordId: string): Promise<AssetRepairRecoveryRecord> {
    const record = await this.journal.get(recordId)
    if (!record) throw new Error('Asset repair recovery record not found')
    return this.journal.update(recordId, {
      state: 'completed',
      needsDerivedRebuild: false,
      steps: {
        ...record.steps,
        nativeIndex: true,
        vectorIndex: true,
        derivedRebuilt: true,
      },
      completedAt: Date.now(),
      lastError: '',
    })
  }

  async markFailure(recordId: string, error: unknown): Promise<AssetRepairRecoveryRecord> {
    const current = await this.journal.get(recordId)
    if (!current) throw new Error('Asset repair recovery record not found')
    return this.journal.update(recordId, {
      state: current.state === 'rebuilding' ? 'rebuilding' : 'failed',
      lastError: recoveryErrorMessage(error),
    })
  }
}
