import { BrowserWindow } from 'electron'
import type { MigrationProgress } from './storageDirectoryMigration'
import { migrationProgressView, storageMigrationProgressHtml } from './storageMigrationProgress'

/** Isolated startup UI: no preload, Node access, business stores or network requests. */
export async function createStorageMigrationWindow(onCancel: () => void) {
  const window = new BrowserWindow({
    width: 660,
    height: 450,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    title: 'Siftory · 数据迁移',
    backgroundColor: '#f3f7fb',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: false,
      // Do not initialize the library's normal browser session during a cold copy.
      partition: 'siftory-storage-migration',
    },
  })
  let finished = false
  let cancelled = false
  const requestCancel = () => {
    if (!finished && !cancelled) {
      cancelled = true
      onCancel()
    }
  }
  window.on('closed', requestCancel)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('render-process-gone', requestCancel)
  try {
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(storageMigrationProgressHtml())}`,
    )
    if (window.isDestroyed() || cancelled) throw new Error('Migration window closed before ready')
    window.show()
  } catch (error) {
    finished = true
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
  let lastUpdate = 0
  let lastPhase: MigrationProgress['phase'] | undefined
  return {
    update(value: MigrationProgress) {
      if (window.isDestroyed()) return
      // Bound renderer traffic during large files and very large thumbnail trees.
      const now = Date.now()
      if (value.phase === lastPhase && now - lastUpdate < 150) return
      lastUpdate = now
      lastPhase = value.phase
      try {
        const view = migrationProgressView(value)
        window.setProgressBar(view.fraction ?? 2)
        void window.webContents
          .executeJavaScript(`window.updateMigrationProgress(${JSON.stringify(view)})`)
          .catch(requestCancel)
      } catch {
        requestCancel()
      }
    },
    close() {
      finished = true
      if (!window.isDestroyed()) {
        // Teardown must not change an already committed migration result.
        window.destroy()
      }
    },
  }
}
