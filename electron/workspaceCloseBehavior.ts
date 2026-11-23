import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import { setGlobalWindowVisibility, shouldCloseToTray, type AppCoreIpcOptions } from './appCoreIpc'
import { PRODUCT_DISPLAY_NAME } from './startupSecurity'

export function attachWorkspaceCloseBehavior(
  window: BrowserWindow,
  options: AppCoreIpcOptions,
  iconPath: string,
): void {
  let tray: Tray | undefined
  let quitting = false
  let quitScheduled = false
  const releaseTray = () => {
    tray?.destroy()
    tray = undefined
  }
  const beforeQuit = () => {
    quitting = true
    releaseTray()
  }
  const openWorkspace = () => setGlobalWindowVisibility(options, true, 'tray')

  app.on('before-quit', beforeQuit)
  window.on('show', releaseTray)
  window.once('closed', () => {
    releaseTray()
    app.removeListener('before-quit', beforeQuit)
  })
  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    if (quitScheduled || tray) return

    if (shouldCloseToTray(options)) {
      try {
        const icon = nativeImage.createFromPath(iconPath)
        if (!icon.isEmpty()) {
          tray = new Tray(icon)
          const chinese = app.getLocale().startsWith('zh')
          tray.setToolTip(PRODUCT_DISPLAY_NAME)
          tray.setContextMenu(
            Menu.buildFromTemplate([
              { label: chinese ? '打开寻藏' : 'Open Siftory', click: openWorkspace },
              { label: chinese ? '退出' : 'Quit', click: () => app.quit() },
            ]),
          )
          tray.on('click', openWorkspace)
          if (setGlobalWindowVisibility(options, false, 'tray')) return
        }
      } catch {
        // Keep close usable if Windows cannot create the notification icon.
      }
      releaseTray()
    }

    // Quit the workspace and any auxiliary windows through the normal shutdown handler.
    quitScheduled = true
    setImmediate(() => app.quit())
  })
}
