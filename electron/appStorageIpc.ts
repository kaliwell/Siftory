import { secureIpcMain } from './ipcAuthorization'
import { shell } from 'electron'
import {
  clearCachedResult,
  getStatus,
  loadCachedResult,
  resetStatus,
  startScan,
  stopScan,
} from './appStorageService'
import { openSafeShellPath } from './pathGuards'
import type { AppStorageScanStatus } from '../shared/ipc-contract'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function registerAppStorageIpc(getMainWindow: () => Electron.BrowserWindow | null): void {
  secureIpcMain.handle('appStorage:scan', async () => {
    resetStatus()
    const statusCallback = (status: AppStorageScanStatus) => {
      const window = getMainWindow()
      if (window && !window.isDestroyed()) {
        window.webContents.send('appStorage:onStatusChanged', status)
      }
    }
    return startScan(statusCallback)
  })

  secureIpcMain.handle('appStorage:stop', async () => {
    stopScan()
    return { ok: true }
  })

  secureIpcMain.handle('appStorage:getStatus', async () => getStatus())

  secureIpcMain.handle('appStorage:loadCached', async () => loadCachedResult())

  secureIpcMain.handle('appStorage:clearCached', async () => clearCachedResult())

  secureIpcMain.handle('appStorage:openPath', async (_event, rawPath: unknown) => {
    try {
      return await openSafeShellPath(shell, rawPath, { requireExists: true })
    } catch (error: unknown) {
      return { ok: false, error: errorMessage(error) }
    }
  })
}
