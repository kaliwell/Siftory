// ── Asset identity & unified file action IPC (Phase 2) ───
// Thin handlers mirroring the Phase 1 discovery catalog pattern: sender
// authorization and capability declaration come from secureIpcMain (the
// `catalog:` domain is already declared); handlers only clamp inputs and
// forward to the identity/file-action services.

import { safeStorage, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import {
  ASSET_IDENTITY_IPC,
  type AssetFileActionResult,
  type AssetMoveRepairResult,
  type AssetShadowReport,
} from '../shared/ipc/asset-identity'
import { getAssetIdentityService } from './assetIdentityService'
import {
  AssetDerivedRebuildClaimStore,
  AssetRepairRecoveryError,
  assetDerivedRebuildGrants,
} from './assetDerivedRebuildGrant'
import {
  isAssetDerivedRebuildRunning,
  scheduleAssetDerivedRebuild,
} from './assetDerivedRebuildCoordinator'
import { runAssetDerivedRebuild } from './assetDerivedRebuildRuntime'
import { AssetRepairRecoveryRuntime } from './assetDerivedRebuildRuntime'
import type {
  AssetRepairJournalProtectionAdapter,
  AssetRepairRecoveryRecord,
} from './assetDerivedRebuildGrant'
import { requireAssetLibraryStores } from './assetLibraryStorageContext'
import { openOriginalFile, revealOriginalFile } from './fileActionService'
import {
  getImageSearchStatus,
  isImageSearchIndexMutationRunning,
  isImageSearchIndexedPath,
} from './imageSearchService'
import { secureIpcMain } from './ipcAuthorization'
import { clearProcessedImageData, previewProcessedImageData } from './derivedDataResetService'
import type { UnifiedTaskSubmitter } from './unifiedTaskSubmission'
import { getEmbeddingProgress } from './embeddingService'
import { getMediaSearchStatus } from './mediaTaskQueue'
import { getModelStatus } from './modelService'
import { isImageSearchDataCatalogBuildRunning } from './imageSearchDataCatalogService'
import { isImageSearchFolderDataEditRunning } from './imageSearchFolderDataService'
import { isStorageCleanupActiveFor } from './storageCleanupService'
import { isVectorStoreMigrationRunning } from './vectorStoreMigrationService'
import { isSourceFileSyncRunning } from './sourceFileSyncService'
import { runAssetLibraryMutation } from './assetLibraryService'
import { isSourceDerivedDataCleanupRunning } from './sourceDerivedDataCleanupService'
import {
  isVectorMaintenanceReservationActive,
  tryAcquireVectorExclusiveMaintenance,
} from './vectorMaintenanceService'

const EMPTY_SHADOW_REPORT: AssetShadowReport = {
  generatedAt: 0,
  comparedCount: 0,
  matchedCount: 0,
  onlyInLibrary: [],
  onlyInUnified: [],
}

function normalizeRef(raw: unknown): string {
  return typeof raw === 'string' ? raw.slice(0, 4096) : ''
}

function actionFailure(error: string): AssetFileActionResult {
  return { ok: false, error }
}

const REBUILD_TOKEN_PATTERN = /^[0-9a-f-]{20,80}$/i

function normalizeRebuildToken(raw: unknown): string {
  return typeof raw === 'string' && REBUILD_TOKEN_PATTERN.test(raw) ? raw : ''
}

function readRebuildRoots(userDataPath: string, newPath: string): string[] {
  let configured: unknown[]
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(userDataPath, 'floating_clock_settings.json'), 'utf8'),
    ) as { imageSearchScanPaths?: unknown }
    configured = Array.isArray(settings.imageSearchScanPaths) ? settings.imageSearchScanPaths : []
  } catch {
    configured = []
  }
  const roots = [...configured, path.dirname(newPath)]
    .filter((item): item is string => typeof item === 'string' && path.isAbsolute(item))
    .map((item) => path.resolve(item))
  return [...new Map(roots.map((root) => [root.toLowerCase(), root])).values()].slice(0, 256)
}

function derivedRebuildBusyError(
  options: { ignoreAssetDerivedRebuild?: boolean } = {},
): string | null {
  if (isSourceFileSyncRunning()) return 'Source file synchronization is running'
  if (isSourceDerivedDataCleanupRunning()) return 'Source-derived data cleanup is running'
  if (!options.ignoreAssetDerivedRebuild && isAssetDerivedRebuildRunning()) {
    return 'A derived index rebuild is already running'
  }
  if (isVectorMaintenanceReservationActive()) return 'Vector maintenance is running'
  if (isImageSearchDataCatalogBuildRunning()) return 'Image Search data catalog analysis is running'
  if (isImageSearchFolderDataEditRunning()) return 'A folder index edit is running'
  if (isImageSearchIndexMutationRunning()) return 'An Image Search index edit is running'
  if (isVectorStoreMigrationRunning()) return 'Vector store migration is running'
  if (isStorageCleanupActiveFor('image-search') || isStorageCleanupActiveFor('vectors')) {
    return 'Storage cleanup is running'
  }
  if (
    ['queued', 'scanning', 'indexing', 'searching', 'paused'].includes(getImageSearchStatus().state)
  ) {
    return 'An Image Search task is running'
  }
  if (['queued', 'running', 'paused', 'stopping'].includes(getEmbeddingProgress().state)) {
    return 'An embedding task is running'
  }
  if (getMediaSearchStatus({ includeCounts: false }).state === 'running') {
    return 'A Media Search task is running'
  }
  return null
}

const assetDerivedRebuildClaims = new AssetDerivedRebuildClaimStore()

// Protects the asset repair recovery journal HMAC key with the OS keychain
// (DPAPI on Windows) so a userData-write attacker cannot forge journal entries.
const assetRepairJournalProtection: AssetRepairJournalProtectionAdapter = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plainBase64) => safeStorage.encryptString(plainBase64).toString('base64'),
  decrypt: (encryptedBase64) => safeStorage.decryptString(Buffer.from(encryptedBase64, 'base64')),
}

export function registerAssetIdentityIpc(
  userDataPath?: string,
  taskScheduler?: UnifiedTaskSubmitter,
): void {
  const repairRecovery = userDataPath
    ? new AssetRepairRecoveryRuntime(userDataPath, {
        protectionAdapter: assetRepairJournalProtection,
      })
    : null
  const recoveryForGrant = async (
    grant: ReturnType<typeof assetDerivedRebuildGrants.peek>,
  ): Promise<AssetRepairRecoveryRecord | null> => {
    if (!grant?.recoveryId) return null
    if (!repairRecovery) throw new Error('Application data path is unavailable')
    const record = await repairRecovery.journal.get(grant.recoveryId)
    if (!record || record.state === 'completed') {
      throw new Error('Asset repair recovery is no longer pending')
    }
    const samePath = (left: string, right: string) =>
      path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    if (
      record.assetId !== grant.assetId ||
      !samePath(record.oldPath, grant.oldPath) ||
      !samePath(record.newPath, grant.newPath)
    ) {
      throw new Error('Asset repair recovery authorization does not match its journal')
    }
    return record
  }
  secureIpcMain.handle(ASSET_IDENTITY_IPC.RESOLVE, async (_event, raw: unknown) => {
    const service = getAssetIdentityService()
    const ref = normalizeRef(raw)
    if (!service) return { ok: false, error: 'Asset identity service is not initialized' }
    if (!ref) return { ok: false, error: 'Invalid path' }
    try {
      return { ok: true, identity: await service.resolveForPath(ref) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  secureIpcMain.handle(ASSET_IDENTITY_IPC.SHADOW_REPORT, async () => {
    const service = getAssetIdentityService()
    if (!service) return EMPTY_SHADOW_REPORT
    try {
      const stores = requireAssetLibraryStores()
      await stores.assets.ensureLoaded()
      const active = stores.assets.activePathIndexEntries()
      const inactive = stores.assets.getMany(stores.assets.inactiveIds())
      const all = [
        ...active.map((entry) => ({ id: entry.id, path: entry.path })),
        ...inactive.map((record) => ({ id: record.id, path: record.path })),
      ]
      return await service.buildShadowReport(all)
    } catch {
      return EMPTY_SHADOW_REPORT
    }
  })

  secureIpcMain.handle(ASSET_IDENTITY_IPC.FILE_OPEN, async (_event, raw: unknown) => {
    const service = getAssetIdentityService()
    if (!service) return actionFailure('Asset identity service is not initialized')
    return openOriginalFile(service, shell, normalizeRef(raw))
  })

  secureIpcMain.handle(ASSET_IDENTITY_IPC.FILE_REVEAL, async (_event, raw: unknown) => {
    const service = getAssetIdentityService()
    if (!service) return actionFailure('Asset identity service is not initialized')
    return revealOriginalFile(service, shell, normalizeRef(raw))
  })

  secureIpcMain.handle(ASSET_IDENTITY_IPC.REPAIR_MOVED, async (event, raw: unknown) => {
    const service = getAssetIdentityService()
    const newPath = normalizeRef(raw)
    if (!service) {
      return { ok: false, repaired: false, error: 'Asset identity service is not initialized' }
    }
    if (!newPath) return { ok: false, repaired: false, error: 'Invalid path' }
    try {
      return await runAssetLibraryMutation(async () => {
        const busy = derivedRebuildBusyError()
        if (busy) return { ok: false, repaired: false, error: busy }
        const releaseVectorMaintenance = tryAcquireVectorExclusiveMaintenance()
        if (!releaseVectorMaintenance) {
          return { ok: false, repaired: false, error: 'Vector maintenance is running' }
        }
        try {
          const recoveryHolder: { record: AssetRepairRecoveryRecord | null } = { record: null }
          let repair: Awaited<ReturnType<typeof service.repairMovedFile>> = null
          try {
            repair = await service.repairMovedFile(newPath, async (prepared) => {
              if (!repairRecovery) {
                throw new Error('Application data path is unavailable for durable repair recovery')
              }
              recoveryHolder.record = await repairRecovery.journal.prepare({
                assetId: prepared.assetId,
                oldPath: prepared.oldPath,
                newPath: prepared.newPath,
                nativeIndexRequired:
                  getImageSearchStatus().nativeConnected &&
                  isImageSearchIndexedPath(prepared.oldPath),
              })
            })
            if (!repair) return { ok: true, repaired: false }
            const recoveryRecord = recoveryHolder.record
            if (!repairRecovery || !recoveryRecord) {
              throw new Error('Durable asset repair recovery was not prepared')
            }
            await repairRecovery.journal.markStep(recoveryRecord.id, 'identity')
            await repairRecovery.resume(recoveryRecord.id)
          } catch (error) {
            const recoveryRecord = recoveryHolder.record
            if (!repair || !repairRecovery || !recoveryRecord) throw error
            const reason = error instanceof Error ? error.message : String(error)
            await repairRecovery.markFailure(recoveryRecord.id, error).catch(() => undefined)
            const grant = assetDerivedRebuildGrants.issue(event.sender.id, {
              assetId: repair.assetId,
              oldPath: repair.oldPath,
              newPath: repair.newPath,
              reason,
              recoveryId: recoveryRecord.id,
            })
            return {
              ok: false,
              repaired: true,
              assetId: repair.assetId,
              oldPath: repair.oldPath,
              newPath: repair.newPath,
              derivedRebuildGrant: { token: grant.token, expiresAt: grant.expiresAt },
              error: reason,
            }
          }
          const result: AssetMoveRepairResult = {
            ok: true,
            repaired: true,
            assetId: repair.assetId,
            oldPath: repair.oldPath,
            newPath: repair.newPath,
          }
          return result
        } finally {
          releaseVectorMaintenance()
        }
      })
    } catch (error) {
      return {
        ok: false,
        repaired: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  secureIpcMain.handle(ASSET_IDENTITY_IPC.REPAIR_RECOVERY_LIST, async (event) => {
    if (!repairRecovery) {
      return { ok: false, pending: [], error: 'Application data path is unavailable' }
    }
    try {
      const records = await repairRecovery.journal.listPending()
      return {
        ok: true,
        pending: records.map((record) => {
          const grant = assetDerivedRebuildGrants.issue(event.sender.id, {
            assetId: record.assetId,
            oldPath: record.oldPath,
            newPath: record.newPath,
            reason: record.lastError || 'Interrupted asset repair requires recovery',
            recoveryId: record.id,
          })
          return {
            recoveryId: record.id,
            assetId: record.assetId,
            oldPath: record.oldPath,
            newPath: record.newPath,
            state: record.state,
            ...(record.lastError ? { lastError: record.lastError } : {}),
            grant: { token: grant.token, expiresAt: grant.expiresAt },
          }
        }),
      }
    } catch (error) {
      return {
        ok: false,
        pending: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  secureIpcMain.handle(ASSET_IDENTITY_IPC.DERIVED_REBUILD_PREVIEW, async (event, raw: unknown) => {
    if (!userDataPath) return { ok: false, error: 'Application data path is unavailable' }
    const grant = assetDerivedRebuildGrants.peek(event.sender.id, normalizeRebuildToken(raw))
    if (!grant) return { ok: false, error: 'Rebuild authorization is invalid or expired' }
    try {
      const recovery = await recoveryForGrant(grant)
      const preview = await previewProcessedImageData(userDataPath)
      return {
        ok: true,
        assetId: grant.assetId,
        ...(recovery
          ? {
              recoveryId: recovery.id,
              requiresDerivedRebuild:
                recovery.needsDerivedRebuild || recovery.state === 'rebuilding',
            }
          : {}),
        roots: readRebuildRoots(userDataPath, grant.newPath),
        expiresAt: grant.expiresAt,
        ...preview,
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  secureIpcMain.handle(ASSET_IDENTITY_IPC.DERIVED_REBUILD_START, async (event, raw: unknown) => {
    if (!userDataPath || !taskScheduler) {
      return { ok: false, scheduled: false, error: 'Task scheduler is unavailable' }
    }
    const token = normalizeRebuildToken(raw)
    const grant = assetDerivedRebuildGrants.peek(event.sender.id, token)
    if (!grant) {
      return { ok: false, scheduled: false, error: 'Rebuild authorization is invalid or expired' }
    }
    const claimKey = grant.recoveryId ? `recovery:${grant.recoveryId}` : `token:${token}`
    const claimed = assetDerivedRebuildClaims.claim(claimKey, token, event.sender.id)
    const claim = claimed.claim
    if (!claimed.created) {
      const existingClaim = claim
      if (existingClaim.senderId !== event.sender.id || existingClaim.token !== token) {
        return {
          ok: false,
          scheduled: false,
          error: 'This asset repair recovery is already scheduled by another window',
        }
      }
      const taskId = existingClaim.taskId ?? (await existingClaim.ready)
      return taskId === null
        ? { ok: false, scheduled: false, error: 'Derived rebuild could not be scheduled' }
        : { ok: true, scheduled: true, taskId }
    }

    let scheduled = false
    try {
      const recoveryRecord = await recoveryForGrant(grant)
      if (claim.abortController.signal.aborted) throw new Error('Derived rebuild was cancelled')
      const busy = derivedRebuildBusyError()
      if (busy) return { ok: false, scheduled: false, error: busy }
      const dataPreview = await previewProcessedImageData(userDataPath)
      if (claim.abortController.signal.aborted) throw new Error('Derived rebuild was cancelled')
      const rebuildVectors =
        Boolean(recoveryRecord?.rebuildVectorData) ||
        dataPreview.categories.some(
          (category) => category.id === 'vector-db' && category.fileCount > 0,
        )
      const mayNeedDerivedRebuild =
        !recoveryRecord ||
        recoveryRecord.needsDerivedRebuild ||
        recoveryRecord.state === 'rebuilding'
      if (mayNeedDerivedRebuild && rebuildVectors) {
        for (const modelName of ['dinov2_vitb14', 'clip_vit_base_patch32'] as const) {
          const model = getModelStatus(modelName)
          if (!['downloaded', 'loaded', 'verified'].includes(model.state)) {
            return {
              ok: false,
              scheduled: false,
              error: `${modelName} must be ready before rebuilding vector data`,
            }
          }
        }
      }
      const refreshed = assetDerivedRebuildGrants.refresh(event.sender.id, token)
      if (!refreshed) {
        return { ok: false, scheduled: false, error: 'Rebuild authorization is invalid or expired' }
      }
      const roots = readRebuildRoots(userDataPath, refreshed.newPath)
      if (roots.length === 0) {
        return { ok: false, scheduled: false, error: 'No safe image roots are available' }
      }
      let rebuildVectorsAtRun = rebuildVectors
      let skipDerivedRebuild = false
      const taskId = scheduleAssetDerivedRebuild({
        scheduler: taskScheduler,
        assetId: refreshed.assetId,
        roots,
        ensureReady: () => derivedRebuildBusyError({ ignoreAssetDerivedRebuild: true }),
        acquireMaintenance: tryAcquireVectorExclusiveMaintenance,
        clear: async () => {
          if (claim.abortController.signal.aborted) throw new Error('Derived rebuild was cancelled')
          if (recoveryRecord && repairRecovery) {
            const current = await repairRecovery.journal.get(recoveryRecord.id)
            if (!current) throw new Error('Asset repair recovery record not found')
            if (current.state !== 'rebuilding') {
              try {
                await repairRecovery.resume(current.id)
                skipDerivedRebuild = true
                return { ok: true, freedBytes: 0, deletedFiles: 0, errors: [] }
              } catch (error) {
                if (
                  !(error instanceof AssetRepairRecoveryError) ||
                  !error.record.needsDerivedRebuild
                ) {
                  throw error
                }
              }
            }
            const beforeClear = await repairRecovery.journal.get(current.id)
            if (!beforeClear) throw new Error('Asset repair recovery record not found')
            rebuildVectorsAtRun =
              beforeClear.rebuildVectorData ||
              dataPreview.categories.some(
                (category) => category.id === 'vector-db' && category.fileCount > 0,
              )
            await repairRecovery.markRebuilding(beforeClear.id, rebuildVectorsAtRun)
            if (beforeClear.steps.derivedCleared) {
              return { ok: true, freedBytes: 0, deletedFiles: 0, errors: [] }
            }
          }
          const currentPreview = await previewProcessedImageData(userDataPath)
          rebuildVectorsAtRun =
            rebuildVectorsAtRun ||
            currentPreview.categories.some(
              (category) => category.id === 'vector-db' && category.fileCount > 0,
            )
          if (rebuildVectorsAtRun) {
            for (const modelName of ['dinov2_vitb14', 'clip_vit_base_patch32'] as const) {
              const model = getModelStatus(modelName)
              if (!['downloaded', 'loaded', 'verified'].includes(model.state)) {
                throw new Error(`${modelName} must be ready before rebuilding vector data`)
              }
            }
          }
          const cleared = await clearProcessedImageData(userDataPath)
          if (claim.abortController.signal.aborted) throw new Error('Derived rebuild was cancelled')
          if (cleared.ok && recoveryRecord && repairRecovery) {
            await repairRecovery.markDerivedCleared(recoveryRecord.id)
          }
          return cleared
        },
        rebuild: async () => {
          if (skipDerivedRebuild) return
          await runAssetDerivedRebuild({
            roots,
            scheduler: taskScheduler,
            rebuildVectors: rebuildVectorsAtRun,
            signal: claim.abortController.signal,
          })
          if (recoveryRecord && repairRecovery) {
            await repairRecovery.markDerivedRebuilt(recoveryRecord.id)
          }
        },
        onSettled: (error) => {
          assetDerivedRebuildClaims.release(claim)
          if (error) {
            if (recoveryRecord && repairRecovery) {
              void repairRecovery.markFailure(recoveryRecord.id, error).catch(() => undefined)
            }
            assetDerivedRebuildGrants.refresh(claim.senderId, token)
          } else {
            assetDerivedRebuildGrants.revoke(claim.senderId, token)
          }
        },
      })
      claim.taskId = taskId
      claim.resolveReady(taskId)
      scheduled = true
      return { ok: true, scheduled: true, taskId }
    } catch (error) {
      assetDerivedRebuildGrants.refresh(event.sender.id, token)
      return {
        ok: false,
        scheduled: false,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      if (!scheduled) {
        assetDerivedRebuildClaims.release(claim)
        claim.resolveReady(null)
      }
    }
  })

  secureIpcMain.handle(ASSET_IDENTITY_IPC.DERIVED_REBUILD_CANCEL, async (event, raw: unknown) => {
    const token = normalizeRebuildToken(raw)
    const claim = assetDerivedRebuildClaims.getByToken(token)
    if (!claim || claim.senderId !== event.sender.id) {
      return { ok: false, cancelled: false, error: 'Rebuild authorization is invalid' }
    }
    claim.abortController.abort()
    if (claim.taskId !== null) taskScheduler?.cancel?.(claim.taskId)
    return { ok: true, cancelled: true }
  })
}
