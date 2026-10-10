import { secureIpcMain } from './ipcAuthorization'
import { shell, type BrowserWindow } from 'electron'
import { normalizeDuplicateScanOptions, normalizeLargestOptions } from './ipcValidation'
import {
  findLargestFiles,
  getDupProgress,
  getDupResults,
  startDuplicateScan,
  stopDuplicateScan,
} from './duplicateFinderService'
import { revealSafeShellPath } from './pathGuards'

type MainWindowProvider = () => BrowserWindow | null

function sendDuplicateProgress(getMainWindow: MainWindowProvider, progress: unknown): void {
  try {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('duplicates:onProgress', progress)
    }
  } catch {
    /* ignore */
  }
}

export function registerDuplicateFinderIpc(getMainWindow: MainWindowProvider): void {
  secureIpcMain.handle('duplicates:scan', async (_event, rawOpts: unknown) => {
    const opts = normalizeDuplicateScanOptions(rawOpts)
    if (!opts) return { ok: false, error: 'Invalid scan options' }
    return startDuplicateScan(opts, (progress) => sendDuplicateProgress(getMainWindow, progress))
  })

  secureIpcMain.handle('duplicates:stop', async () => stopDuplicateScan())
  secureIpcMain.handle('duplicates:getProgress', async () => getDupProgress())
  secureIpcMain.handle('duplicates:getResults', async () => getDupResults())

  secureIpcMain.handle('duplicates:findLargest', async (_event, rawOpts: unknown) => {
    const opts = normalizeLargestOptions(rawOpts)
    if (!opts) return { ok: false, files: [], error: 'Invalid scan options' }
    return findLargestFiles(opts.dirPath, opts.topN, (progress) =>
      sendDuplicateProgress(getMainWindow, progress),
    )
  })

  secureIpcMain.handle('duplicates:openPath', async (_event, rawPath: unknown) => {
    return revealSafeShellPath(shell, rawPath, { requireExists: true })
  })
}
