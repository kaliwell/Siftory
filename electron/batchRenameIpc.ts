import { secureIpcMain } from './ipcAuthorization'
// ── Batch Rename IPC ─────────────────────────────────────

import { dialog, type BrowserWindow } from 'electron'
import {
  startBatchRename,
  stopBatchRename,
  getBatchRenameProgress,
  getBatchRenameResult,
} from './batchRenameService'
import { normalizeUserPath } from './pathGuards'
import type { BatchRenameProgress, BatchRenameStartRequest } from '../shared/ipc-contract'

type MainWindowProvider = () => BrowserWindow | null

function sendProgress(getMainWindow: MainWindowProvider, progress: BatchRenameProgress): void {
  try {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('batchRename:onProgress', progress)
    }
  } catch {
    /* ignore */
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function registerBatchRenameIpc(getMainWindow: MainWindowProvider): void {
  secureIpcMain.handle('batchRename:start', async (_event, rawReq: unknown) => {
    const req = rawReq as BatchRenameStartRequest
    if (
      !req ||
      typeof req.originDir !== 'string' ||
      typeof req.modifiedDir !== 'string' ||
      typeof req.outputDir !== 'string' ||
      (req.threshold !== undefined &&
        (typeof req.threshold !== 'number' ||
          !Number.isFinite(req.threshold) ||
          req.threshold <= 0 ||
          req.threshold > 1)) ||
      (req.conflictPolicy !== undefined &&
        !['keep-best', 'skip', 'keep-both'].includes(req.conflictPolicy))
    ) {
      return {
        ok: false,
        error: 'Invalid request: originDir, modifiedDir, and outputDir are required',
      }
    }
    const originDir = normalizeUserPath(req.originDir)
    const modifiedDir = normalizeUserPath(req.modifiedDir)
    const outputDir = normalizeUserPath(req.outputDir)
    if (!originDir || !modifiedDir || !outputDir) {
      return { ok: false, error: 'Invalid directory path' }
    }
    try {
      return await startBatchRename(
        {
          originDir,
          modifiedDir,
          outputDir,
          ...(req.threshold !== undefined ? { threshold: req.threshold } : {}),
          ...(req.conflictPolicy !== undefined ? { conflictPolicy: req.conflictPolicy } : {}),
        },
        (progress) => sendProgress(getMainWindow, progress),
      )
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })

  secureIpcMain.handle('batchRename:stop', async () => {
    stopBatchRename()
    return { ok: true }
  })

  secureIpcMain.handle('batchRename:getProgress', async () => {
    return getBatchRenameProgress()
  })

  secureIpcMain.handle('batchRename:getResult', async () => {
    return getBatchRenameResult()
  })

  secureIpcMain.handle('batchRename:selectFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Folder',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
