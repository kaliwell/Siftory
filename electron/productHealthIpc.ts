import fs from 'fs'
import path from 'path'
import { app, BrowserWindow, dialog } from 'electron'
import { PRODUCT_HEALTH_IPC } from '../shared/ipc/product-health'
import { authoritativeVectorStoreRootFromCacheDir } from './authoritativeVectorStore'
import { secureIpcMain } from './ipcAuthorization'
import {
  commitPreparedPath,
  createPreparedSiblingPath,
  discardPreparedPath,
} from './localFileTransaction'
import { getModelStatus } from './modelService'
import { ProductHealthService } from './productHealthService'
import { serializeProductHealthReport } from './productHealthReport'
import { getSourceCatalogService } from './sourceCatalogService'
import { getUnifiedTaskScheduler } from './unifiedSearchRuntime'
import { probeVectorIndexHealth } from './vectorIndexHealth'
import { hardenDataDirectoryPermissions, probeDataDirectorySecurity } from './dataDirectorySecurity'

// Mirrors the startup gate in main.ts: development roots and smoke-test
// sandboxes intentionally keep their established permissions.
function dataDirectoryProtectionEnabled(): boolean {
  return Boolean(
    app.isPackaged &&
    !process.env.FLOATING_CLOCK_UI_SMOKE_REPORT?.trim() &&
    !process.env.FLOATING_CLOCK_AI_CONTROL_SMOKE_REPORT?.trim(),
  )
}

function createProductHealthService(userDataPath: string): ProductHealthService {
  return new ProductHealthService({
    readInput: async () => {
      const sourceService = getSourceCatalogService()
      const sources = sourceService?.listSources() ?? []
      let catalog
      try {
        catalog = sourceService?.getConsistencyReport()
      } catch {
        catalog = undefined
      }
      const scheduler = getUnifiedTaskScheduler().stats()
      const storeRoot = authoritativeVectorStoreRootFromCacheDir(
        path.join(userDataPath, 'vector-db', 'embedding-cache'),
      )
      let freeBytes: number | undefined
      try {
        const disk = fs.statfsSync(userDataPath)
        freeBytes = Math.max(0, disk.bavail * disk.bsize)
      } catch {
        freeBytes = undefined
      }
      // Live probe so ACL drift after startup is visible instead of a stale cache.
      const dataProtection = await probeDataDirectorySecurity(userDataPath, {
        enabled: dataDirectoryProtectionEnabled(),
      })
      return {
        generatedAt: Date.now(),
        appVersion: app.getVersion(),
        platform: process.platform,
        architecture: process.arch,
        sources: sources.map((source) => ({ availability: source.availability })),
        catalog,
        vector: probeVectorIndexHealth(storeRoot, {
          modelName: 'clip_vit_base_patch32',
          embeddingType: 'global',
        }),
        models: ['dinov2_vitb14', 'clip_vit_base_patch32'].map((name) => ({
          state: getModelStatus(name).state,
        })),
        scheduler: {
          failed: scheduler.lanes.local.failed + scheduler.lanes.gpu.failed,
          queued: scheduler.lanes.local.queued + scheduler.lanes.gpu.queued,
          running: scheduler.lanes.local.running + scheduler.lanes.gpu.running,
          backgroundPaused: scheduler.resource.backgroundPaused,
          pressureReasonCount: scheduler.resource.pressureReasons.length,
        },
        dataProtection,
        ...(freeBytes === undefined
          ? {}
          : {
              storage: {
                freeBytes,
                minimumFreeBytes: scheduler.resource.policy.minFreeDiskBytes,
              },
            }),
      }
    },
    reconnectSources: async () => {
      const sourceService = getSourceCatalogService()
      if (!sourceService) return 0
      let affected = 0
      for (const source of sourceService.listSources()) {
        const result = await sourceService.probeSource(source.id)
        if (result.ok) affected += 1
      }
      return affected
    },
    cancelBackground: () => getUnifiedTaskScheduler().cancelBackgroundTasks(),
    repairDataProtection: async () => {
      await hardenDataDirectoryPermissions(userDataPath, {
        enabled: dataDirectoryProtectionEnabled(),
      })
      await probeDataDirectorySecurity(userDataPath, {
        enabled: dataDirectoryProtectionEnabled(),
      })
    },
  })
}

function normalizedReportPath(selectedPath: string): string | null {
  if (!path.isAbsolute(selectedPath) || selectedPath.includes('\0')) return null
  return selectedPath.toLowerCase().endsWith('.json') ? selectedPath : `${selectedPath}.json`
}

export function registerProductHealthIpc(userDataPath: string): void {
  const service = createProductHealthService(path.resolve(userDataPath))

  secureIpcMain.handle(PRODUCT_HEALTH_IPC.REPORT_GET, async () => {
    return service.getReport()
  })

  secureIpcMain.handle(PRODUCT_HEALTH_IPC.REPAIR_RUN, async (_event, raw: unknown) => {
    return service.runRepair(raw)
  })

  secureIpcMain.handle(PRODUCT_HEALTH_IPC.REPORT_SAVE_DIALOG, async (event) => {
    let payload: string
    try {
      payload = serializeProductHealthReport(await service.getReport())
    } catch {
      return { ok: false, errorCode: 'unsafe-report' as const }
    }
    const options = {
      title: 'Save privacy-redacted health report',
      defaultPath: 'siftory-health-report.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['showOverwriteConfirmation' as const],
    }
    const parent = BrowserWindow.fromWebContents(event.sender)
    const selected = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (selected.canceled || !selected.filePath) {
      return { ok: false, errorCode: 'cancelled' as const }
    }
    const finalPath = normalizedReportPath(selected.filePath)
    if (!finalPath) return { ok: false, errorCode: 'write-failed' as const }
    const preparedPath = createPreparedSiblingPath(finalPath)
    try {
      await fs.promises.writeFile(preparedPath, payload, { encoding: 'utf8', flag: 'wx' })
      await commitPreparedPath(preparedPath, finalPath)
      return { ok: true, saved: true as const }
    } catch {
      await discardPreparedPath(preparedPath)
      return { ok: false, errorCode: 'write-failed' as const }
    }
  })
}
