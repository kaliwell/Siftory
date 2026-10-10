import path from 'path'
import type {
  AssetLibraryBackupCreateResult,
  AssetLibraryBackupRestoreResult,
  AssetLibraryBackupSummary,
  AssetLibraryBackupVerification,
} from '../shared/ipc/asset-library'
import {
  assetLibraryBackupDefaults,
  createAssetLibraryBackupIfDue,
  getAssetLibraryBackupRoot,
  listAssetLibraryBackups,
  redactAssetLibraryBackupSources,
  restoreAssetLibraryBackup,
  verifyAssetLibraryBackupById,
} from './assetLibraryBackup'
import {
  closeAssetLibraryStorage,
  hasAssetLibraryInitializationError,
  requireAssetLibraryStores,
} from './assetLibraryStorageContext'
import { redactDiagnosticError } from './diagnosticRedaction'

export interface AssetLibraryBackupHost {
  hasActiveWork(): boolean
  runMutation<T>(runner: () => Promise<T> | T): Promise<T>
  reinitialize(userDataPath: string): void
  validateRestoredLibrary(): Promise<unknown>
  failRestore(error: Error): never
}

let baseDir = ''
let backupTimer: NodeJS.Timeout | null = null
let host: AssetLibraryBackupHost | null = null

function errorMessage(error: unknown): string {
  return redactDiagnosticError(error)
}

function requireBaseDir(): string {
  if (!baseDir) throw new Error('Asset library service is not initialized')
  return baseDir
}

function requireHost(): AssetLibraryBackupHost {
  if (!host) throw new Error('Asset library backup coordinator is not initialized')
  return host
}

async function flushAssetLibraryMetadataWrites(): Promise<void> {
  const stores = requireAssetLibraryStores()
  await Promise.all([
    stores.assets.flush(),
    stores.categories.flush(),
    stores.tags.flush(),
    stores.categoryAssignments.flush(),
    stores.tagAssignments.flush(),
    stores.references.flush(),
    stores.suggestions.flush(),
    stores.clusters.flush(),
    stores.clusterMembers.flush(),
    stores.clusterLineage.flush(),
    stores.referenceEmbeddings.flush(),
    stores.metadataDeletions.flush(),
    stores.smartAlbums.flush(),
    stores.collections.flush(),
    stores.collectionItems.flush(),
  ])
}

function scheduleAssetLibraryBackup(delayMs = 30_000): void {
  if (backupTimer) clearTimeout(backupTimer)
  backupTimer = setTimeout(() => {
    backupTimer = null
    const activeHost = requireHost()
    if (activeHost.hasActiveWork()) {
      scheduleAssetLibraryBackup()
      return
    }
    void activeHost
      .runMutation(async () => {
        await flushAssetLibraryMetadataWrites()
        return createAssetLibraryBackupIfDue(requireBaseDir())
      })
      .then((result) => {
        if (result.created) {
          console.info(
            `[AssetLibrary] Metadata backup created: ${result.fileCount} files, ${result.totalBytes} bytes`,
          )
        }
      })
      .catch((error: unknown) => {
        console.error(`[AssetLibrary] Metadata backup failed: ${errorMessage(error)}`)
        scheduleAssetLibraryBackup(15 * 60 * 1000)
      })
  }, delayMs)
  backupTimer.unref?.()
}

export function resetAssetLibraryBackupCoordinator(): void {
  if (backupTimer) clearTimeout(backupTimer)
  backupTimer = null
  baseDir = ''
  host = null
}

export function initAssetLibraryBackupCoordinator(
  libraryBaseDir: string,
  backupHost: AssetLibraryBackupHost,
): void {
  resetAssetLibraryBackupCoordinator()
  baseDir = libraryBaseDir
  host = backupHost
  void redactAssetLibraryBackupSources(libraryBaseDir)
    .then((redacted) => {
      if (redacted > 0)
        console.info(`[AssetLibrary] Redacted ${redacted} legacy backup manifest(s)`)
    })
    .catch((error: unknown) => {
      console.warn(`[AssetLibrary] Backup manifest redaction failed: ${errorMessage(error)}`)
    })
  scheduleAssetLibraryBackup()
}

export function listAssetLibraryMetadataBackups(): Promise<AssetLibraryBackupSummary[]> {
  return listAssetLibraryBackups(requireBaseDir())
}

export async function createAssetLibraryMetadataBackup(): Promise<AssetLibraryBackupCreateResult> {
  await flushAssetLibraryMetadataWrites()
  const result = await createAssetLibraryBackupIfDue(requireBaseDir(), {
    minimumIntervalMs: 0,
    reason: 'manual',
  })
  if (!result.created || !result.backup) {
    return { ok: false, error: 'No asset metadata is available to back up' }
  }
  return { ok: true, backup: result.backup }
}

export function verifyAssetLibraryMetadataBackup(
  backupId: string,
): Promise<AssetLibraryBackupVerification> {
  return verifyAssetLibraryBackupById(requireBaseDir(), backupId)
}

export function getAssetLibraryMetadataBackupRoot(): string {
  return getAssetLibraryBackupRoot(requireBaseDir())
}

export async function restoreAssetLibraryMetadataBackup(
  backupId: string,
): Promise<AssetLibraryBackupRestoreResult> {
  if (!baseDir) return { ok: false, error: 'Asset library service is not initialized' }
  const activeHost = requireHost()
  const verification = await verifyAssetLibraryBackupById(baseDir, backupId)
  if (!verification.ok) return { ok: false, error: verification.error || 'Backup is invalid' }
  if (!hasAssetLibraryInitializationError()) await flushAssetLibraryMetadataWrites()
  const protective = await createAssetLibraryBackupIfDue(baseDir, {
    minimumIntervalMs: 0,
    maxBackups: assetLibraryBackupDefaults.maxBackups + 1,
    reason: 'pre_restore',
  })
  if (!protective.created || !protective.backup) {
    return { ok: false, error: 'Could not create the required pre-restore backup' }
  }
  const userDataPath = path.dirname(baseDir)
  try {
    // Windows refuses to replace asset-library.sqlite while its handle is open.
    closeAssetLibraryStorage()
    const restored = await restoreAssetLibraryBackup(baseDir, backupId)
    activeHost.reinitialize(userDataPath)
    await activeHost.validateRestoredLibrary()
    return {
      ok: true,
      restoredFiles: restored.restoredFiles,
      deletedFiles: restored.deletedFiles,
      protectiveBackupId: protective.backup.id,
    }
  } catch (error) {
    resetAssetLibraryBackupCoordinator()
    return activeHost.failRestore(
      new Error(
        `Asset library restore did not complete; restart is required to recover it: ${errorMessage(error)}`,
      ),
    )
  }
}
