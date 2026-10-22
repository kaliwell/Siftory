import { secureIpcMain } from './ipcAuthorization'
import { app, clipboard, dialog, globalShortcut, shell, type BrowserWindow } from 'electron'
import path from 'path'
import {
  normalizeClipboardText,
  normalizePersistedObject,
  normalizeTransparency,
} from './ipcValidation'
import { openSafeShellPath } from './pathGuards'
import { openThirdPartyLicenseDirectory } from './thirdPartyLicenses'
import { readJSON, writeJSON } from './settingsStore'
import { WindowVisibilityMachine, type WindowVisibilitySnapshot } from './windowVisibilityState'
import { WindowVisibilityDiagnostics } from './windowVisibilityDiagnostics'
import type {
  DisplayScope,
  GlobalHotkeyEntry,
  GlobalHotkeyId,
  GlobalHotkeyStatus,
  WindowVisibilityEvent,
  WindowVisibilityReason,
  WorkspaceTopology,
  WorkspaceWorkArea,
} from '../shared/ipc-contract'

type VideoDiagnosticMode =
  | 'baseline'
  | 'compact'
  | 'direct-composition'
  | 'no-shape'
  | 'no-topmost'
  | 'software'

type GetMainWindow = () => BrowserWindow | null

export interface AppCoreIpcOptions {
  getMainWindow: GetMainWindow
  getWorkArea: () => WorkspaceWorkArea
  getDisplayTopology: () => WorkspaceTopology
  setDisplayScope: (scope: DisplayScope) => WorkspaceTopology
  ensureWindowOnTop: () => void
  getWindowAlwaysOnTop: () => boolean
  setWindowAlwaysOnTop: (value: boolean) => boolean
  videoDiagnosticMode: VideoDiagnosticMode
  userDataPath: string
}

const visibilityMachine = new WindowVisibilityMachine()
let visibilityShowTimer: NodeJS.Timeout | null = null
let lastVisibleShape: Electron.Rectangle[] = []
let prewarmedVisibilityGeneration: number | null = null
let requiredShapeGeneration: number | null = null
let visibleWindowOpacity = 1
const WINDOW_PREWARM_OPACITY = 0.01
let visibilityDiagnostics: WindowVisibilityDiagnostics | null = null
let appliedIgnoreMouse: boolean | null = null

function recordVisibility(
  code: Parameters<WindowVisibilityDiagnostics['record']>[0],
  details?: Parameters<WindowVisibilityDiagnostics['record']>[2],
): void {
  visibilityDiagnostics?.record(code, visibilityMachine.current(), details)
}

function applyMouseTransparency(mainWindow: BrowserWindow, ignore: boolean): void {
  try {
    mainWindow.setIgnoreMouseEvents(ignore, { forward: true })
    if (appliedIgnoreMouse !== ignore) recordVisibility('mouse-applied', { ignoreMouse: ignore })
    appliedIgnoreMouse = ignore
  } catch (error) {
    appliedIgnoreMouse = null
    recordVisibility('mouse-failed')
    throw error
  }
}

function applyWindowShape(mainWindow: BrowserWindow, rects: Electron.Rectangle[]): void {
  try {
    mainWindow.setShape(rects)
    if (visibilityMachine.current().state === 'preparing-show') {
      recordVisibility('shape-applied', { shapeCount: rects.length })
    }
  } catch (error) {
    recordVisibility('shape-failed')
    throw error
  }
}

export async function flushWindowVisibilityDiagnostics(): Promise<void> {
  await visibilityDiagnostics?.close()
}

const hotkeyEntries: GlobalHotkeyEntry[] = [
  { id: 'toggle-primary', accelerator: 'CommandOrControl+Shift+Alt+R', status: 'disabled' },
  { id: 'toggle-legacy', accelerator: 'CommandOrControl+Shift+Alt+Q', status: 'disabled' },
  { id: 'snap-panels', accelerator: 'CommandOrControl+Shift+Alt+P', status: 'disabled' },
  { id: 'show-all', accelerator: 'CommandOrControl+Shift+Alt+S', status: 'disabled' },
  { id: 'arrange-row', accelerator: 'Shift+Alt+Q', status: 'disabled' },
  { id: 'arrange-grid', accelerator: 'Shift+Alt+W', status: 'disabled' },
  { id: 'arrange-column', accelerator: 'Shift+Alt+E', status: 'disabled' },
  { id: 'quit', accelerator: 'Shift+Escape', status: 'disabled' },
]

function hotkeyStatus(): GlobalHotkeyStatus {
  const entries = hotkeyEntries.map((entry) => ({ ...entry }))
  return {
    active: entries.some((entry) => entry.id === 'toggle-primary' && entry.status === 'registered'),
    entries,
  }
}

function visibilityEvent(): WindowVisibilityEvent {
  const snapshot = visibilityMachine.current()
  return {
    generation: snapshot.generation,
    state: snapshot.state,
    reason: snapshot.reason,
  }
}

function clearVisibilityShowTimer(): void {
  if (!visibilityShowTimer) return
  clearTimeout(visibilityShowTimer)
  visibilityShowTimer = null
}

function completeGlobalWindowReveal(options: AppCoreIpcOptions, generation: number): boolean {
  const mainWindow = options.getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const snapshot = visibilityMachine.current()
  if (snapshot.state === 'visible' && snapshot.generation === generation) {
    clearVisibilityShowTimer()
    mainWindow.setOpacity(visibleWindowOpacity)
    mainWindow.webContents.setBackgroundThrottling(false)
    return true
  }
  if (prewarmedVisibilityGeneration !== generation || !mainWindow.isVisible()) {
    recordVisibility('stale-ack')
    return false
  }
  if (snapshot.state !== 'preparing-show' || snapshot.generation !== generation) return false
  try {
    mainWindow.setOpacity(visibleWindowOpacity)
    mainWindow.webContents.setBackgroundThrottling(false)
  } catch {
    recordVisibility('recovery-failed')
    try {
      mainWindow.setOpacity(0)
    } catch {
      /* Native teardown may already be in progress. */
    }
    return false
  }
  if (!visibilityMachine.completeVisible(generation)) return false
  clearVisibilityShowTimer()
  prewarmedVisibilityGeneration = null
  recordVisibility('visible', { shapeCount: lastVisibleShape.length })
  return true
}

function prewarmGlobalWindowShow(options: AppCoreIpcOptions, generation: number): boolean {
  const mainWindow = options.getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const snapshot = visibilityMachine.current()
  if (snapshot.state !== 'preparing-show' || snapshot.generation !== generation) {
    recordVisibility('stale-ack')
    return false
  }
  if (requiredShapeGeneration === generation) return false
  if (prewarmedVisibilityGeneration === generation && mainWindow.isVisible()) return true
  mainWindow.setOpacity(WINDOW_PREWARM_OPACITY)
  if (!mainWindow.isVisible()) {
    mainWindow.showInactive()
    options.ensureWindowOnTop()
  }
  prewarmedVisibilityGeneration = generation
  recordVisibility('prewarmed')
  mainWindow.webContents.send('global-window-shown-for-paint', visibilityEvent())
  return true
}

function scheduleSafeShowFallback(options: AppCoreIpcOptions, generation: number): void {
  clearVisibilityShowTimer()
  visibilityShowTimer = setTimeout(() => {
    const snapshot = visibilityMachine.current()
    if (snapshot.state !== 'preparing-show' || snapshot.generation !== generation) return
    visibilityShowTimer = null
    const mainWindow = options.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return
    recordVisibility('show-timeout')
    try {
      applyMouseTransparency(mainWindow, true)
      if (lastVisibleShape.length === 0) {
        // Electron treats setShape([]) as removing the custom region, not a
        // zero-pixel native window. Keep the surface transparent until a valid
        // renderer shape/ACK arrives instead of revealing a full-window surface.
        mainWindow.setOpacity(0)
        recordVisibility('fallback-without-shape')
        return
      }
      applyWindowShape(mainWindow, lastVisibleShape)
      console.warn('[Siftory] Window show handshake timed out; using safe click-through fallback')
      prewarmGlobalWindowShow(options, generation)
      if (completeGlobalWindowReveal(options, generation)) {
        // The timeout can commit after renderer paint retries have stopped.
        // Publish the authoritative state on the existing visibility channel
        // so the renderer also re-enables interaction.
        mainWindow.webContents.send('global-window-shown-for-paint', visibilityEvent())
      }
    } catch {
      // Native shape/mouse errors are already recorded with fixed event codes.
      console.warn('[Siftory] Window show fallback failed; awaiting renderer recovery')
    }
  }, 900)
  visibilityShowTimer.unref?.()
}

export function setGlobalWindowVisibility(
  options: AppCoreIpcOptions,
  visible: boolean,
  reason: WindowVisibilityReason,
): boolean {
  const mainWindow = options.getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const previousSnapshot = visibilityMachine.current()
  if (!visible && previousSnapshot.state === 'visible') {
    const currentOpacity = mainWindow.getOpacity()
    if (Number.isFinite(currentOpacity) && currentOpacity > 0) visibleWindowOpacity = currentOpacity
  }
  let transition = visibilityMachine.begin(visible, reason)
  if (!transition && visible && !mainWindow.isVisible()) {
    transition = visibilityMachine.restartVisible(reason)
  }
  if (!transition) {
    if (visible && visibilityMachine.current().state === 'visible') {
      options.ensureWindowOnTop()
    }
    return true
  }

  clearVisibilityShowTimer()
  prewarmedVisibilityGeneration = null
  requiredShapeGeneration = lastVisibleShape.length === 0 ? transition.generation : null
  recordVisibility('transition')
  mainWindow.webContents.setBackgroundThrottling(true)
  applyMouseTransparency(mainWindow, true)
  applyWindowShape(mainWindow, [])
  if (transition.state !== 'preparing-show') {
    mainWindow.setOpacity(0)
    mainWindow.webContents.send('toggle-global-visibility', visibilityEvent())
    visibilityMachine.completeHidden(transition.generation)
    recordVisibility('hidden')
    return true
  }

  mainWindow.webContents.setBackgroundThrottling(false)
  mainWindow.webContents.send('show-global-visibility', visibilityEvent())
  scheduleSafeShowFallback(options, transition.generation)
  return true
}

function recoverWindowVisibility(
  options: AppCoreIpcOptions,
  transition: WindowVisibilitySnapshot | null,
  installTopology: () => void,
): boolean {
  if (!transition) return true
  clearVisibilityShowTimer()
  prewarmedVisibilityGeneration = null
  requiredShapeGeneration = transition.generation
  lastVisibleShape = []
  recordVisibility('transition')
  const mainWindow = options.getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return false
  try {
    // setShape([]) removes the native region. Make it invisible and release
    // hit testing first; neither the old surface nor its fallback is reusable.
    applyMouseTransparency(mainWindow, true)
    mainWindow.setOpacity(0)
    applyWindowShape(mainWindow, [])
    mainWindow.webContents.setBackgroundThrottling(transition.state !== 'preparing-show')
    mainWindow.webContents.send('toggle-global-visibility', visibilityEvent())
    installTopology()
    if (options.getMainWindow() !== mainWindow || mainWindow.isDestroyed()) return false
    if (transition.state === 'preparing-show') {
      mainWindow.webContents.send('show-global-visibility', visibilityEvent())
      scheduleSafeShowFallback(options, transition.generation)
    } else {
      recordVisibility('hidden')
    }
    return true
  } catch {
    // One failed native operation must not prevent the independent attempt to
    // hide the surface and release hit testing. A later recovery can retry.
    if (!mainWindow.isDestroyed()) {
      try {
        mainWindow.setOpacity(0)
      } catch {
        /* Native teardown may already be in progress. */
      }
      try {
        applyMouseTransparency(mainWindow, true)
      } catch {
        /* Keep the failed generation uncommitted. */
      }
    }
    recordVisibility('recovery-failed')
    console.warn('[Siftory] Window recovery failed; awaiting a new workspace recovery')
    return false
  }
}

/** Reinstall geometry before asking the renderer to prepare a new generation. */
function hasRecoveryWindow(options: AppCoreIpcOptions): boolean {
  const mainWindow = options.getMainWindow()
  if (mainWindow && !mainWindow.isDestroyed()) return true
  // Startup power events cannot advance a generation that a not-yet-created
  // renderer would have no way to learn. Retire native work from a lost window.
  clearVisibilityShowTimer()
  prewarmedVisibilityGeneration = null
  requiredShapeGeneration = null
  lastVisibleShape = []
  return false
}

export function recoverGlobalWindowTopology(
  options: AppCoreIpcOptions,
  installTopology: () => void,
): boolean {
  if (!hasRecoveryWindow(options)) return false
  return recoverWindowVisibility(options, visibilityMachine.invalidate(), installTopology)
}

export function suspendGlobalWindowVisibility(options: AppCoreIpcOptions): boolean {
  if (!hasRecoveryWindow(options)) return false
  return recoverWindowVisibility(options, visibilityMachine.suspend(), () => {})
}

export function resumeGlobalWindowVisibility(
  options: AppCoreIpcOptions,
  installTopology: () => void,
): boolean {
  if (!hasRecoveryWindow(options)) return false
  // Resume can be the first event observed after startup/listener registration.
  // Refresh geometry even when no suspend was observed, preserving user intent.
  return recoverWindowVisibility(
    options,
    visibilityMachine.resume() ?? visibilityMachine.invalidate(),
    installTopology,
  )
}

export function revealGlobalWindow(options: AppCoreIpcOptions): boolean {
  return setGlobalWindowVisibility(options, true, 'second-instance')
}

function getSettingsPath(userDataPath: string): string {
  return path.join(userDataPath, 'floating_clock_settings.json')
}

function getConfigPath(userDataPath: string): string {
  return path.join(userDataPath, 'clock_config.json')
}

export function registerGlobalHotkeys(options: AppCoreIpcOptions): GlobalHotkeyStatus {
  const failures: string[] = []
  const { getMainWindow, getWorkArea } = options
  let lastGlobalToggleAt = 0

  const toggleWindow = () => {
    const now = Date.now()
    const repeated = now - lastGlobalToggleAt < 350
    lastGlobalToggleAt = now
    if (repeated) {
      recordVisibility('hotkey-repeat')
      return
    }
    setGlobalWindowVisibility(options, !visibilityMachine.wantsVisible(), 'hotkey')
  }
  const callbacks: Record<GlobalHotkeyId, () => void> = {
    'toggle-primary': toggleWindow,
    'toggle-legacy': toggleWindow,
    'snap-panels': () => {
      const mainWindow = getMainWindow()
      if (mainWindow) mainWindow.webContents.send('snap-panels', getWorkArea())
    },
    'show-all': () => {
      const mainWindow = getMainWindow()
      if (mainWindow) mainWindow.webContents.send('show-all-panels', getWorkArea())
    },
    'arrange-row': () => {
      getMainWindow()?.webContents.send('arrange-horizontal')
    },
    'arrange-grid': () => {
      getMainWindow()?.webContents.send('arrange-grid')
    },
    'arrange-column': () => {
      getMainWindow()?.webContents.send('arrange-vertical')
    },
    quit: () => {
      app.quit()
    },
  }

  for (const entry of hotkeyEntries) {
    if (globalShortcut.isRegistered(entry.accelerator)) {
      entry.status = 'registered'
      recordVisibility('hotkey-registered', { hotkey: entry.id })
      continue
    }
    try {
      const registered = globalShortcut.register(entry.accelerator, callbacks[entry.id])
      entry.status = registered ? 'registered' : 'conflicted'
      recordVisibility(registered ? 'hotkey-registered' : 'hotkey-conflicted', { hotkey: entry.id })
    } catch {
      entry.status = 'conflicted'
      recordVisibility('hotkey-failed', { hotkey: entry.id })
    }
    if (entry.status === 'conflicted') failures.push(`${entry.accelerator} (${entry.id})`)
  }

  if (failures.length > 0) {
    console.error('[Siftory] Failed hotkeys:', failures.join(', '))
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hotkey-warnings', failures)
    }
  }
  return hotkeyStatus()
}

function unregisterGlobalHotkeys(): void {
  for (const entry of hotkeyEntries) {
    globalShortcut.unregister(entry.accelerator)
    entry.status = 'disabled'
    recordVisibility('hotkey-disabled', { hotkey: entry.id })
  }
}

export function registerAppCoreIpc(options: AppCoreIpcOptions): void {
  visibilityDiagnostics = new WindowVisibilityDiagnostics(options.userDataPath)
  recordVisibility('initialized')
  secureIpcMain.handle('open-folder', async (_event, rawPath: unknown) => {
    return openSafeShellPath(shell, rawPath)
  })

  secureIpcMain.handle('app:openThirdPartyLicenses', (_event, ...args: unknown[]) =>
    openThirdPartyLicenseDirectory(
      {
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
      },
      shell,
      args,
    ),
  )

  secureIpcMain.handle('copy-to-clipboard', (_event, rawText: unknown) => {
    const text = normalizeClipboardText(rawText)
    if (text === null) return { ok: false, error: 'Invalid clipboard text' }
    clipboard.writeText(text)
    return { ok: true }
  })

  secureIpcMain.handle('browse-folder', async () => {
    const mainWindow = options.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  secureIpcMain.handle('hide-window', () => {
    return setGlobalWindowVisibility(options, false, 'settings')
  })

  secureIpcMain.handle('show-window', (_event, rawGeneration: unknown) => {
    const generation = Number(rawGeneration)
    if (!Number.isSafeInteger(generation) || generation < 0) return false
    return prewarmGlobalWindowShow(options, generation)
  })

  secureIpcMain.handle('reveal-window', (_event, rawGeneration: unknown) => {
    const generation = Number(rawGeneration)
    if (!Number.isSafeInteger(generation) || generation < 0) return false
    return completeGlobalWindowReveal(options, generation)
  })

  secureIpcMain.handle('get-window-always-on-top', () => options.getWindowAlwaysOnTop())

  secureIpcMain.handle('set-window-always-on-top', (_event, value: unknown) => {
    if (typeof value !== 'boolean') return options.getWindowAlwaysOnTop()
    return options.setWindowAlwaysOnTop(value)
  })

  secureIpcMain.handle('set-transparency', (_event, rawOpacity: unknown) => {
    const opacity = normalizeTransparency(rawOpacity)
    if (opacity === null) return { ok: false, error: 'Invalid opacity' }
    visibleWindowOpacity = 1 - opacity / 100
    if (visibilityMachine.current().state === 'visible') {
      options.getMainWindow()?.setOpacity(visibleWindowOpacity)
    }
    return { ok: true }
  })

  secureIpcMain.handle('set-ignore-mouse', (_event, rawIgnore: unknown, rawGeneration: unknown) => {
    const generation = Number(rawGeneration)
    const mainWindow = options.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return
    const ignore = typeof rawIgnore === 'boolean' ? rawIgnore : true
    if (
      !Number.isSafeInteger(generation) ||
      !visibilityMachine.acceptsRendererMutation(generation) ||
      visibilityMachine.current().state !== 'visible'
    ) {
      recordVisibility('stale-mouse')
      applyMouseTransparency(mainWindow, true)
      return
    }
    applyMouseTransparency(mainWindow, ignore)
  })

  secureIpcMain.handle(
    'set-overlay-shape',
    (_event, rects: Electron.Rectangle[], rawGeneration: unknown) => {
      const generation = Number(rawGeneration)
      const workArea = options.getWorkArea()
      const emptyViewport = { x: 0, y: 0, width: workArea.width, height: workArea.height }
      const mainWindow = options.getMainWindow()
      if (
        !mainWindow ||
        mainWindow.isDestroyed() ||
        !Array.isArray(rects) ||
        !Number.isSafeInteger(generation) ||
        !visibilityMachine.acceptsRendererMutation(generation)
      ) {
        recordVisibility('stale-shape')
        return emptyViewport
      }
      if (options.videoDiagnosticMode === 'no-shape') {
        // Explicit diagnostic mode intentionally disables native clipping.
        // Its renderer still acknowledges the new layout before prewarm.
        requiredShapeGeneration = null
        return emptyViewport
      }
      const bounds = mainWindow.getContentBounds()
      const workspaceRects = rects
        .slice(0, 64)
        .map((rect) => {
          const x = Math.max(0, Math.floor(Number(rect.x) || 0))
          const y = Math.max(0, Math.floor(Number(rect.y) || 0))
          const width = Math.max(
            1,
            Math.min(workArea.width - x, Math.ceil(Number(rect.width) || 1)),
          )
          const height = Math.max(
            1,
            Math.min(workArea.height - y, Math.ceil(Number(rect.height) || 1)),
          )
          return { x, y, width, height }
        })
        .filter((rect) => rect.x < workArea.width && rect.y < workArea.height)

      if (options.videoDiagnosticMode !== 'compact' || workspaceRects.length === 0) {
        applyWindowShape(mainWindow, workspaceRects)
        if (workspaceRects.length > 0) {
          lastVisibleShape = workspaceRects.map((rect) => ({ ...rect }))
          requiredShapeGeneration = null
        }
        return { x: 0, y: 0, width: bounds.width, height: bounds.height }
      }

      const left = Math.min(...workspaceRects.map((rect) => rect.x))
      const top = Math.min(...workspaceRects.map((rect) => rect.y))
      const right = Math.max(...workspaceRects.map((rect) => rect.x + rect.width))
      const bottom = Math.max(...workspaceRects.map((rect) => rect.y + rect.height))
      const viewport = {
        x: left,
        y: top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
      }
      const targetBounds = {
        x: workArea.x + viewport.x,
        y: workArea.y + viewport.y,
        width: viewport.width,
        height: viewport.height,
      }
      const currentBounds = mainWindow.getBounds()
      if (
        currentBounds.x !== targetBounds.x ||
        currentBounds.y !== targetBounds.y ||
        currentBounds.width !== targetBounds.width ||
        currentBounds.height !== targetBounds.height
      ) {
        mainWindow.setBounds(targetBounds, false)
      }
      applyWindowShape(
        mainWindow,
        workspaceRects.map((rect) => ({
          x: rect.x - viewport.x,
          y: rect.y - viewport.y,
          width: rect.width,
          height: rect.height,
        })),
      )
      lastVisibleShape = workspaceRects.map((rect) => ({
        x: rect.x - viewport.x,
        y: rect.y - viewport.y,
        width: rect.width,
        height: rect.height,
      }))
      requiredShapeGeneration = null
      return viewport
    },
  )

  secureIpcMain.handle('get-hotkey-status', () => {
    return hotkeyStatus()
  })

  secureIpcMain.handle('register-hotkey', () => {
    return registerGlobalHotkeys(options)
  })

  secureIpcMain.handle('unregister-hotkey', () => {
    unregisterGlobalHotkeys()
  })

  secureIpcMain.handle('load-settings', () => {
    return readJSON(getSettingsPath(options.userDataPath), true)
  })

  secureIpcMain.handle('save-settings', (_event, rawSettings: unknown) => {
    const settings = normalizePersistedObject(rawSettings, 'settings')
    if (!settings) throw new TypeError('Invalid settings payload')
    if (!writeJSON(getSettingsPath(options.userDataPath), settings)) {
      throw new Error('Could not save local settings')
    }
  })

  secureIpcMain.handle('load-config', () => {
    return readJSON(getConfigPath(options.userDataPath))
  })

  secureIpcMain.handle('save-config', (_event, rawConfig: unknown) => {
    const config = normalizePersistedObject(rawConfig, 'config')
    if (!config) throw new TypeError('Invalid config payload')
    writeJSON(getConfigPath(options.userDataPath), config)
  })

  secureIpcMain.handle('get-work-area', () => {
    return options.getWorkArea()
  })

  secureIpcMain.handle('get-display-topology', () => options.getDisplayTopology())

  secureIpcMain.handle('set-display-scope', (_event, rawScope: unknown) => {
    const scope = rawScope as DisplayScope
    return options.setDisplayScope(scope)
  })

  secureIpcMain.handle('open-config-dir', () =>
    openSafeShellPath(shell, options.userDataPath, { requireExists: true }),
  )
}
