import fs from 'fs'
import path from 'path'
import { app, type BrowserWindow } from 'electron'
import { getImageSearchStatus, shutdownImageSearchForQuit } from './imageSearchService'
import { shutdownImageSearchDataCatalogForQuit } from './imageSearchDataCatalogService'
import { PANEL_DOM_IDS } from '../shared/ipc/app-core'
import { captureUiSmokeListenerDiagnostic } from './uiSmokeListenerDiagnostics'

const UI_SMOKE_EMBEDDED_PATH_PATTERN =
  /(?:[a-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:users|home|root|tmp|var|etc|mnt|volumes)\/)[^\r\n"']*/gi
const UI_SMOKE_SECRET_PATTERN =
  /\b(password|passphrase|token|secret|private[_-]?key|authorization)\b\s*[:=]\s*[^\s,;]+/gi

function redactUiSmokeReportValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replaceAll('\u0000', '')
      .replace(UI_SMOKE_SECRET_PATTERN, '$1=[redacted]')
      .replace(UI_SMOKE_EMBEDDED_PATH_PATTERN, '[path]')
  }
  if (Array.isArray(value)) return value.map(redactUiSmokeReportValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactUiSmokeReportValue(item)]),
    )
  }
  return value
}

interface UiSmokeLocaleEvidence {
  accessibilityNames: Record<string, string>
  backupControls: string
  categoryControls: string
  cleanupControls: string
  clippedTargetDetails: Record<
    string,
    {
      clientWidth: number
      owner: {
        bottom: number
        height: number
        left: number
        right: number
        top: number
        width: number
      } | null
      reasons: string[]
      rect: { height: number; left: number; top: number; width: number }
      scrollWidth: number
    }
  >
  clippedTargets: string[]
  duplicateNames: string[]
  language: string
  licenseControls: string
  licenseEntryValid: boolean
  panelTitles: string
  searchEmpty: string
  searchError: string
  tagControls: string
  unnamedTargets: string[]
}

interface RendererLifecycleMetrics {
  documents: number
  jsEventListeners: number
  nodes: number
  usedHeapBytes: number
}

interface UiSmokeSnapshot {
  licenseAccessCheck: {
    buttonFound: boolean
    keyboardReachable: boolean
    labelMatches: boolean
    preloadAvailable: boolean
    visible: boolean
    unobscured: boolean
    shellLaunchTested: false
    panelRect: { x: number; y: number; width: number; height: number } | null
  }
  bodyTextLength: number
  crashedPanels: string[]
  devicePixelRatio: number
  language: string
  panelCount: number
  panelIds: string[]
  readyState: string
  titles: string[]
  viewport: { height: number; width: number }
  searchModeChecks: Array<{
    panelId: string
    defaultSimple: boolean
    advancedVisible: boolean
    restoredSimple: boolean
    listViewOptionAbsent: boolean
    wideSplitLayout: boolean
    responsiveLayout: boolean
    coreActionParity: boolean
    keyboardReachable: boolean
    sectionedControls: boolean
    collapsibleControls: boolean
  }>
  workspaceNavigationCheck: {
    compositorDragEvidence: {
      after: { height: number; left: number; top: number; transform: string; width: number }
      before: { height: number; left: number; top: number; width: number }
      during: {
        backdropFilter: string
        height: number
        left: number
        top: number
        transform: string
        width: number
      }
      planned: {
        workArea: { x: number; y: number; width: number; height: number }
        deltaX: number
        deltaY: number
      }
      released: boolean
      rootScrollTop: number
    } | null
    compositorDragStable: boolean
    domainWidthEvidence: {
      idle: number
      search: number
      sources: number
      tasks: number
    } | null
    domainWidthStable: boolean
    domainsPresent: boolean
    keyboardReachable: boolean
    legacyModuleNamesAbsent: boolean
    modelInventoryComplete: boolean
    modelLayoutValid: boolean
    modelOcclusionFree: boolean
    modelStatusInNavigator: boolean
    remoteAdvancedFocusEvidence: Record<string, unknown> | null
    remoteAdvancedFocused: boolean
    sourcesExpanded: boolean
    taskSummaryVisible: boolean
    unifiedSearchPageVisible: boolean
    viewportStable: boolean
  }
  firstRunGuideCheck: {
    currentSource: boolean
    dismissedAndHidden: boolean
    fourSteps: boolean
    persistedWithoutContent: boolean
    reopenControlPresent: boolean
    reopenedAndResumed: boolean
    visibleOnFreshProfile: boolean
  }
  languageSwitchCheck: {
    accessibilityValid: boolean
    alternate: UiSmokeLocaleEvidence | null
    controlFound: boolean
    errorTranslated: boolean
    layoutValid: boolean
    requested: UiSmokeLocaleEvidence | null
    restored: boolean
    restoredEvidence: UiSmokeLocaleEvidence | null
    surfacesChanged: boolean
    switched: boolean
    visibleTextChanged: boolean
  }
  materialSwitchCheck: {
    controlsFound: boolean
    restored: boolean
    switched: boolean
  }
  themeSwitchCheck: {
    controlsFound: boolean
    modeSwitched: boolean
    restored: boolean
    semanticTokensChanged: boolean
    themeSwitched: boolean
  }
  lifecycleChurnCheck: {
    completedCycles: number
    domNodeDelta: number
    finalPanelPresent: boolean
    jsHeapDeltaBytes: number | null
    requestedCycles: number
    rendererMetrics: {
      after: RendererLifecycleMetrics | null
      before: RendererLifecycleMetrics | null
      delta: RendererLifecycleMetrics | null
    }
  }
  assetLibraryCheck: {
    panelFound: boolean
    categoryCreated: boolean
    categoryDeleted: boolean
    categoryRestored: boolean
    deletionHistoryVisible: boolean
    mergedNavigation: boolean
    similarEntryVisible: boolean
    categoryClusterEntryVisible: boolean
    tagCreated: boolean
    sampleSearchVisible: boolean
    returnedToAssets: boolean
    smartAlbumCrud: boolean
    collectionCrud: boolean
    shiftRangeSelection: boolean | null
  }
  runtimeCheck: {
    models: {
      dino: boolean
      clip: boolean
      dinoPath: string | null
      clipPath: string | null
    }
    native: { connected: boolean; version: string | null; path: string | null }
    mediaTools: {
      ffmpeg: boolean
      ffprobe: boolean
      ffmpegPath: string | null
      ffprobePath: string | null
    }
    packagedProvenance: {
      required: boolean
      distributionProfile: 'offline' | 'online'
      resourcesPath: string | null
      modelsUnderResources: boolean
      userCandidateModelsAbsent: boolean
      nativeUnderResources: boolean
      ffmpegUnderResources: boolean
      ffprobeUnderResources: boolean
    }
    thumbnailGpu: {
      attempted: boolean
      completed: boolean
      effectiveBackend: string | null
      gpuCompleted: number
      cpuCompleted: number
      fallbackCount: number
      gpuDevice: string | null
      gpuError: string | null
      elapsedMs: number
      total: number
      gpuJobs: number
      gpuLanes: number
      cpuLanes: number
      batchSize: number
      peakInFlight: number
      autoCpuRouted: number
      cacheWrites: number
      cacheWriteFailures: number
    }
    backup: {
      created: boolean
      listed: boolean
      verified: boolean
      restored: boolean
      preRestoreCreated: boolean
      categoryIntact: boolean
    }
  }
}

const REQUIRED_PANEL_IDS = [...PANEL_DOM_IDS]

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]
}

async function waitForNativeVisibility(
  window: BrowserWindow,
  expected: boolean,
  timeoutMs = 1_500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const matches = expected
      ? window.isVisible() && window.getOpacity() >= 0.39
      : !window.isVisible() || window.getOpacity() <= 0.001
    if (matches) return true
    await wait(10)
  }
  return expected
    ? window.isVisible() && window.getOpacity() >= 0.39
    : !window.isVisible() || window.getOpacity() <= 0.001
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tempPath, filePath)
}

async function captureRendererLifecycleMetrics(
  window: BrowserWindow,
  phase: string,
): Promise<RendererLifecycleMetrics | null> {
  const debug = window.webContents.debugger
  const attachedHere = !debug.isAttached()
  try {
    if (attachedHere) debug.attach('1.3')
    await debug.sendCommand('HeapProfiler.enable')
    await debug.sendCommand('HeapProfiler.collectGarbage')
    const heap = (await debug.sendCommand('Runtime.getHeapUsage')) as {
      usedSize?: unknown
    }
    const dom = (await debug.sendCommand('Memory.getDOMCounters')) as {
      documents?: unknown
      jsEventListeners?: unknown
      nodes?: unknown
    }
    const values = {
      documents: Number(dom.documents),
      jsEventListeners: Number(dom.jsEventListeners),
      nodes: Number(dom.nodes),
      usedHeapBytes: Number(heap.usedSize),
    }
    if (!Object.values(values).every(Number.isFinite)) return null
    // Read the original counters first; an optional inventory never substitutes
    // for them or changes the existing lifecycle threshold.
    await captureUiSmokeListenerDiagnostic(window, phase, values, attachedHere)
    return values
  } catch {
    return null
  } finally {
    if (attachedHere && debug.isAttached()) debug.detach()
  }
}

async function measureVisibleFrameCadence(
  window: BrowserWindow,
): Promise<{ elapsedMs: number; fps: number; frames: number }> {
  return (await window.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const sampleMs = 750
      const startedAt = performance.now()
      let frames = 0
      let settled = false
      let timeout = 0
      const finish = (endedAt) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        const elapsedMs = Math.max(1, endedAt - startedAt)
        resolve({ elapsedMs, fps: frames * 1000 / elapsedMs, frames })
      }
      const tick = (now) => {
        frames += 1
        if (now - startedAt >= sampleMs) finish(now)
        else requestAnimationFrame(tick)
      }
      timeout = setTimeout(() => finish(performance.now()), sampleMs + 500)
      requestAnimationFrame(tick)
    })
  `)) as { elapsedMs: number; fps: number; frames: number }
}

export function configureUiSmoke(
  window: BrowserWindow,
  options: {
    expectedLocale: 'en' | 'zh-CN'
    expectedPixelSize?: { height: number; width: number }
    expectedScale: number
    expectedViewport?: { height: number; width: number }
    expectedWorkArea?: { x: number; y: number; height: number; width: number }
    reportPath: string
    screenshotPath?: string
    getWorkArea: () => { width: number; height: number }
    churnCycles?: number
    visibilityCycles?: number
    setWindowVisibility?: (visible: boolean) => boolean
  },
): void {
  const consoleErrors: Array<{ line: number; message: string; sourceId: string }> = []
  const startedAt = Date.now()

  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level !== 3) return
    consoleErrors.push({ line, message, sourceId })
  })

  window.webContents.once('did-finish-load', () => {
    void (async () => {
      let snapshot: UiSmokeSnapshot | null = null
      let screenshotSize: { height: number; width: number } | null = null
      let modelScreenshotPath: string | null = null
      let licenseScreenshotPath: string | null = null
      let licenseAccessCheck: UiSmokeSnapshot['licenseAccessCheck'] = {
        buttonFound: false,
        keyboardReachable: false,
        labelMatches: false,
        preloadAvailable: false,
        visible: false,
        unobscured: false,
        shellLaunchTested: false,
        panelRect: null,
      }
      let nonTransparentPixelSamples = 0
      const visibilityShowLatenciesMs: number[] = []
      let visibilityCycleCheck = {
        attempted: false,
        completedCycles: 0,
        requestedCycles: options.setWindowVisibility ? options.visibilityCycles || 0 : 0,
        generations: [] as number[],
        maxShowLatencyMs: 0,
        p95ShowLatencyMs: 0,
        p99ShowLatencyMs: 0,
        visibleFrameCadence: { elapsedMs: 0, fps: 0, frames: 0 },
        panelsReadyOnShow: true,
        interactionCancelledOnHide: false,
        rendererMetrics: {
          after: null as RendererLifecycleMetrics | null,
          before: null as RendererLifecycleMetrics | null,
          delta: null as RendererLifecycleMetrics | null,
        },
      }
      let searchModeChecks: UiSmokeSnapshot['searchModeChecks'] = []
      let lifecycleChurnCheck: UiSmokeSnapshot['lifecycleChurnCheck'] = {
        completedCycles: 0,
        domNodeDelta: 0,
        finalPanelPresent: true,
        jsHeapDeltaBytes: null,
        requestedCycles: options.churnCycles || 0,
        rendererMetrics: { after: null, before: null, delta: null },
      }
      let workspaceNavigationCheck: UiSmokeSnapshot['workspaceNavigationCheck'] = {
        compositorDragEvidence: null,
        compositorDragStable: false,
        domainWidthEvidence: null,
        domainWidthStable: false,
        domainsPresent: false,
        keyboardReachable: false,
        legacyModuleNamesAbsent: false,
        modelInventoryComplete: false,
        modelLayoutValid: false,
        modelOcclusionFree: false,
        modelStatusInNavigator: false,
        remoteAdvancedFocusEvidence: null,
        remoteAdvancedFocused: false,
        sourcesExpanded: false,
        taskSummaryVisible: false,
        unifiedSearchPageVisible: false,
        viewportStable: false,
      }
      let firstRunGuideCheck: UiSmokeSnapshot['firstRunGuideCheck'] = {
        currentSource: false,
        dismissedAndHidden: false,
        fourSteps: false,
        persistedWithoutContent: false,
        reopenControlPresent: false,
        reopenedAndResumed: false,
        visibleOnFreshProfile: false,
      }
      let languageSwitchCheck: UiSmokeSnapshot['languageSwitchCheck'] = {
        accessibilityValid: false,
        alternate: null,
        controlFound: false,
        errorTranslated: false,
        layoutValid: false,
        requested: null,
        restored: false,
        restoredEvidence: null,
        surfacesChanged: false,
        switched: false,
        visibleTextChanged: false,
      }
      let materialSwitchCheck: UiSmokeSnapshot['materialSwitchCheck'] = {
        controlsFound: false,
        restored: false,
        switched: false,
      }
      let themeSwitchCheck: UiSmokeSnapshot['themeSwitchCheck'] = {
        controlsFound: false,
        modeSwitched: false,
        restored: false,
        semanticTokensChanged: false,
        themeSwitched: false,
      }
      let assetLibraryCheck: UiSmokeSnapshot['assetLibraryCheck'] = {
        panelFound: false,
        categoryCreated: false,
        categoryDeleted: false,
        categoryRestored: false,
        deletionHistoryVisible: false,
        mergedNavigation: false,
        similarEntryVisible: false,
        categoryClusterEntryVisible: false,
        tagCreated: false,
        sampleSearchVisible: false,
        returnedToAssets: false,
        smartAlbumCrud: false,
        collectionCrud: false,
        shiftRangeSelection: null,
      }
      let distributionProfile: 'offline' | 'online' = 'offline'
      if (app.isPackaged) {
        try {
          const runtimeManifest = JSON.parse(
            fs.readFileSync(path.join(process.resourcesPath, 'runtime-manifest.json'), 'utf8'),
          ) as { distributionProfile?: unknown }
          if (runtimeManifest.distributionProfile === 'online') distributionProfile = 'online'
        } catch {
          // The packaged resource smoke reports a missing or malformed manifest separately.
        }
      }
      const runtimeCheck: UiSmokeSnapshot['runtimeCheck'] = {
        models: { dino: false, clip: false, dinoPath: null, clipPath: null },
        native: { connected: false, version: null, path: null },
        mediaTools: {
          ffmpeg: false,
          ffprobe: false,
          ffmpegPath: null,
          ffprobePath: null,
        },
        packagedProvenance: {
          required: app.isPackaged,
          distributionProfile,
          resourcesPath: app.isPackaged ? process.resourcesPath : null,
          modelsUnderResources: false,
          userCandidateModelsAbsent: false,
          nativeUnderResources: false,
          ffmpegUnderResources: false,
          ffprobeUnderResources: false,
        },
        thumbnailGpu: {
          attempted: false,
          completed: false,
          effectiveBackend: null,
          gpuCompleted: 0,
          cpuCompleted: 0,
          fallbackCount: 0,
          gpuDevice: null,
          gpuError: null,
          elapsedMs: 0,
          total: 0,
          gpuJobs: 0,
          gpuLanes: 0,
          cpuLanes: 0,
          batchSize: 0,
          peakInFlight: 0,
          autoCpuRouted: 0,
          cacheWrites: 0,
          cacheWriteFailures: 0,
        },
        backup: {
          created: false,
          listed: false,
          verified: false,
          restored: false,
          preRestoreCreated: false,
          categoryIntact: false,
        },
      }
      let failure: string | null = null
      try {
        await window.webContents.executeJavaScript(`
          new Promise((resolve, reject) => {
            const deadline = Date.now() + 10000
            const poll = () => {
              const root = document.querySelector('[data-testid="app-root"]')
              if (root?.getAttribute('data-ready') === 'true') {
                resolve(true)
                return
              }
              if (Date.now() >= deadline) {
                reject(new Error('Renderer did not reach the ready state'))
                return
              }
              setTimeout(poll, 50)
            }
            poll()
          })
        `)
        window.webContents.send('show-all-panels', options.getWorkArea())
        await window.webContents.executeJavaScript(`
          new Promise((resolve) => {
            const required = ${JSON.stringify(REQUIRED_PANEL_IDS)}
            const deadline = Date.now() + 8000
            const poll = () => {
              const mounted = new Set(
                Array.from(document.querySelectorAll('.panel[data-panel]'))
                  .map((panel) => panel.getAttribute('data-panel'))
                  .filter(Boolean),
              )
              if (required.every((panelId) => mounted.has(panelId))) {
                resolve(true)
                return
              }
              if (Date.now() >= deadline) {
                resolve(false)
                return
              }
              setTimeout(poll, 50)
            }
            poll()
          })
        `)
        workspaceNavigationCheck = (await window.webContents.executeJavaScript(`
          (async () => {
            const byTestId = (id) => document.querySelector('[data-testid="' + id + '"]')
            const domainIds = ['search', 'sources', 'library', 'organize', 'tasks', 'settings']
            const domainButtons = domainIds.map((id) => byTestId('workspace-domain-' + id))
            const domainText = domainButtons.map((button) => button?.textContent?.trim() || '')
            domainButtons[0]?.focus()
            domainButtons[0]?.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
            )
            const keyboardReachable = document.activeElement === domainButtons[1]
            const navigator = document.querySelector('.workspace-navigator')
            const navigatorRect = navigator?.getBoundingClientRect()
            const domainWidthEvidence = navigatorRect
              ? { idle: navigatorRect.width, search: 0, sources: 0, tasks: 0 }
              : null
            const viewportStable = Boolean(
              navigatorRect &&
                navigatorRect.left >= -1 &&
                navigatorRect.top >= -1 &&
                navigatorRect.right <= window.innerWidth + 1 &&
                navigatorRect.width <= window.innerWidth,
            )
            byTestId('workspace-domain-sources')?.click()
            await new Promise((resolve) => setTimeout(resolve, 100))
            if (domainWidthEvidence && navigator) {
              domainWidthEvidence.sources = navigator.getBoundingClientRect().width
            }
            const sourcesExpanded =
              byTestId('workspace-domain-sources')?.getAttribute('aria-pressed') === 'true' &&
              byTestId('image-search-sources-section')?.getAttribute('data-collapsed') === 'false'
            const remotePanel = document.querySelector('.panel[data-panel="remote-terminal"]')
            const focusStarted = performance.now()
            const focusSnapshot = () => ({
              elapsedMs: performance.now() - focusStarted,
              originalConnected: Boolean(remotePanel?.isConnected),
              originalIsCurrent: remotePanel === document.querySelector('.panel[data-panel="remote-terminal"]'),
              documentVisibility: document.visibilityState,
              panels: Array.from(document.querySelectorAll('.panel')).map((panel) => ({
                id: panel.getAttribute('data-panel'),
                zIndex: panel.style.zIndex,
                computedZIndex: getComputedStyle(panel).zIndex,
                display: getComputedStyle(panel).display,
              })),
            })
            const remoteAdvancedFocusEvidence = {
              before: focusSnapshot(),
              events: [],
              at100Ms: null,
              focusedAt100Ms: false,
              after: null,
            }
            const onPanelFocus = (event) => remoteAdvancedFocusEvidence.events.push({
              panel: event.detail?.panel,
              ...focusSnapshot(),
            })
            const remoteIsOnTop = () => {
              // The visibility update may remount a panel. Check the current node,
              // after the navigator's double-rAF event and React's layer commit.
              const currentPanel = document.querySelector('.panel[data-panel="remote-terminal"]')
              const panelZ = Array.from(document.querySelectorAll('.panel')).map((panel) =>
                Number(panel.style.zIndex || 0),
              )
              return Boolean(
                currentPanel?.isConnected &&
                remoteAdvancedFocusEvidence.events.some((event) => event.panel === 'remote-terminal') &&
                Number(currentPanel.style.zIndex || 0) === Math.max(...panelZ),
              )
            }
            let remoteAdvancedFocused = false
            window.addEventListener('panel-focus-request', onPanelFocus)
            try {
              byTestId('workspace-remote-advanced')?.click()
              await new Promise((resolve) => setTimeout(resolve, 100))
              remoteAdvancedFocusEvidence.at100Ms = focusSnapshot()
              remoteAdvancedFocusEvidence.focusedAt100Ms = remoteIsOnTop()
              const focusDeadline = focusStarted + 2000
              while (!(remoteAdvancedFocused = remoteIsOnTop()) && performance.now() < focusDeadline) {
                await new Promise((resolve) => setTimeout(resolve, 25))
              }
              remoteAdvancedFocusEvidence.after = focusSnapshot()
            } finally {
              window.removeEventListener('panel-focus-request', onPanelFocus)
            }
            byTestId('workspace-domain-search')?.click()
            await new Promise((resolve) => setTimeout(resolve, 100))
            if (domainWidthEvidence && navigator) {
              domainWidthEvidence.search = navigator.getBoundingClientRect().width
            }
            const unifiedSearchPageVisible = [
              'unified-search-page',
              'unified-search-query',
              'unified-search-reference',
              'unified-search-collection-select',
              'unified-search-collect-selected',
            ].every((id) => Boolean(byTestId(id)))
            byTestId('workspace-domain-tasks')?.click()
            await new Promise((resolve) => setTimeout(resolve, 100))
            if (domainWidthEvidence && navigator) {
              domainWidthEvidence.tasks = navigator.getBoundingClientRect().width
            }
            const domainWidthStable = Boolean(
              domainWidthEvidence &&
                domainWidthEvidence.tasks > 0 &&
                Object.values(domainWidthEvidence).every(
                  (width) => Math.abs(width - domainWidthEvidence.tasks) <= 1,
                ),
            )
            const taskSummaryVisible = Boolean(byTestId('workspace-task-summary'))
            byTestId('workspace-model-readiness-toggle')?.click()
            await new Promise((resolve) => setTimeout(resolve, 150))
            const modelPanel = byTestId('global-model-readiness')
            const modelItems = Array.from(
              document.querySelectorAll(
                '[data-testid="global-model-readiness"] article[data-testid^="global-model-"]',
              ),
            )
            const modelPanelRect = modelPanel?.getBoundingClientRect()
            const modelInventoryComplete = modelItems.length === 13
            const modelStatusInNavigator = Boolean(
              modelPanel && modelPanel.closest('.workspace-navigator'),
            )
            const modelLayoutValid = Boolean(
              modelPanelRect &&
                modelPanelRect.left >= -1 &&
                modelPanelRect.right <= window.innerWidth + 1 &&
                modelPanelRect.bottom <= window.innerHeight + 1 &&
                modelItems.every((item) => {
                  const rect = item.getBoundingClientRect()
                  return rect.width > 0 && rect.height > 0 && rect.right <= modelPanelRect.right + 1
                }),
            )
            const modelOcclusionFree = Boolean(
              modelItems.length > 0 &&
                modelItems.every((item) => {
                  const rect = item.getBoundingClientRect()
                  const topElement = document.elementFromPoint(
                    rect.left + rect.width / 2,
                    rect.top + rect.height / 2,
                  )
                  return Boolean(topElement && item.contains(topElement))
                }),
            )
            navigator?.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
            )
            await new Promise((resolve) => setTimeout(resolve, 100))
            const moveHandle = byTestId('workspace-navigator-move')
            const beforeDragRect = navigator?.getBoundingClientRect()
            let compositorDragStable = false
            let compositorDragEvidence = null
            if (navigator && moveHandle && beforeDragRect) {
              const handleRect = moveHandle.getBoundingClientRect()
              const startX = handleRect.left + handleRect.width / 2
              const startY = handleRect.top + handleRect.height / 2
              // Plan a destination inside the handle's target display. A display
              // above the primary makes its local top nonzero; a fixed dy=20
              // would correctly clamp there and falsely fail this compositor test.
              const dragWorkArea = await window.electronAPI.getWorkArea()
              const dragAreas = dragWorkArea.displays?.length
                ? dragWorkArea.displays.map((display) => display.localWorkArea)
                : [{ x: 0, y: 0, width: dragWorkArea.width, height: dragWorkArea.height }]
              const distanceToDragPoint = (area) => {
                const dx = Math.max(area.x - (startX + 96), 0, startX + 96 - area.x - area.width)
                const dy = Math.max(area.y - (startY + 20), 0, startY + 20 - area.y - area.height)
                return dx * dx + dy * dy
              }
              const dragArea = dragAreas.reduce((best, area) =>
                distanceToDragPoint(area) < distanceToDragPoint(best) ? area : best,
              )
              const targetLeft = Math.max(
                dragArea.x + 8,
                Math.min(beforeDragRect.left + 96, dragArea.x + dragArea.width - beforeDragRect.width - 8),
              )
              const targetTop = Math.max(
                dragArea.y + 8,
                Math.min(beforeDragRect.top + 20, dragArea.y + dragArea.height - beforeDragRect.height - 8),
              )
              const dragDeltaX = targetLeft - beforeDragRect.left
              const dragDeltaY = targetTop - beforeDragRect.top
              moveHandle.dispatchEvent(
                new MouseEvent('mousedown', {
                  bubbles: true,
                  button: 0,
                  clientX: startX,
                  clientY: startY,
                }),
              )
              window.dispatchEvent(
                new MouseEvent('mousemove', {
                  bubbles: true,
                  buttons: 1,
                  clientX: startX + dragDeltaX,
                  clientY: startY + dragDeltaY,
                }),
              )
              await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              )
              const duringDragRect = navigator.getBoundingClientRect()
              const duringBackdropFilter = getComputedStyle(navigator).backdropFilter
              const duringTransform = navigator.style.transform
              const movingUsesTransform =
                navigator.dataset.moving === 'true' &&
                duringTransform.startsWith('translate3d(') &&
                navigator.style.willChange === 'transform'
              const dragLayerStable =
                Math.abs(duringDragRect.width - beforeDragRect.width) <= 1 &&
                duringBackdropFilter === 'none'
              window.dispatchEvent(
                new MouseEvent('mouseup', {
                  bubbles: true,
                  button: 0,
                  clientX: startX + dragDeltaX,
                  clientY: startY + dragDeltaY,
                }),
              )
              await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              )
              const afterDragRect = navigator.getBoundingClientRect()
              const appRoot = document.querySelector('[data-testid="app-root"]')
              const released = !navigator.dataset.moving && navigator.style.willChange === ''
              compositorDragEvidence = {
                planned: { workArea: dragArea, deltaX: dragDeltaX, deltaY: dragDeltaY },
                before: {
                  height: beforeDragRect.height,
                  left: beforeDragRect.left,
                  top: beforeDragRect.top,
                  width: beforeDragRect.width,
                },
                during: {
                  backdropFilter: duringBackdropFilter,
                  height: duringDragRect.height,
                  left: duringDragRect.left,
                  top: duringDragRect.top,
                  transform: duringTransform,
                  width: duringDragRect.width,
                },
                after: {
                  height: afterDragRect.height,
                  left: afterDragRect.left,
                  top: afterDragRect.top,
                  transform: navigator.style.transform,
                  width: afterDragRect.width,
                },
                released,
                rootScrollTop: appRoot?.scrollTop || 0,
              }
              compositorDragStable = Boolean(
                movingUsesTransform &&
                  dragLayerStable &&
                  released &&
                  (appRoot?.scrollTop || 0) === 0 &&
                  Math.abs(afterDragRect.left - (beforeDragRect.left + dragDeltaX)) <= 2 &&
                  Math.abs(afterDragRect.top - (beforeDragRect.top + dragDeltaY)) <= 2 &&
                  afterDragRect.left >= -1 &&
                  afterDragRect.top >= -1 &&
                  afterDragRect.right <= window.innerWidth + 1,
              )
            }
            return {
              compositorDragEvidence,
              compositorDragStable,
              domainWidthEvidence,
              domainWidthStable,
              domainsPresent: domainButtons.every(Boolean),
              keyboardReachable,
              legacyModuleNamesAbsent: domainText.every(
                (text) => !/Image Search|Media Search|NekoSearch|Remote Terminal/.test(text),
              ),
              modelInventoryComplete,
              modelLayoutValid,
              modelOcclusionFree,
              modelStatusInNavigator,
              remoteAdvancedFocusEvidence,
              remoteAdvancedFocused,
              sourcesExpanded,
              taskSummaryVisible,
              unifiedSearchPageVisible,
              viewportStable,
            }
          })()
        `)) as UiSmokeSnapshot['workspaceNavigationCheck']
        firstRunGuideCheck = (await window.webContents.executeJavaScript(`
          (async () => {
            const byTestId = (id) => document.querySelector('[data-testid="' + id + '"]')
            const waitFor = async (predicate, timeoutMs = 5000) => {
              const deadline = Date.now() + timeoutMs
              while (Date.now() < deadline) {
                if (predicate()) return true
                await new Promise((resolve) => setTimeout(resolve, 50))
              }
              return Boolean(predicate())
            }
            await waitFor(() => byTestId('product-first-run-guide'))
            const initialGuide = byTestId('product-first-run-guide')
            const stepIds = ['source', 'models', 'catalog', 'search']
            const visibleOnFreshProfile = Boolean(initialGuide)
            const fourSteps = stepIds.every((id) => Boolean(byTestId('first-run-step-' + id)))
            const currentSource = initialGuide?.getAttribute('data-current-step') === 'source'

            byTestId('first-run-skip')?.click()
            await waitFor(() => !byTestId('product-first-run-guide'))
            const dismissedAndHidden = !byTestId('product-first-run-guide')
            byTestId('workspace-domain-tasks')?.click()
            await waitFor(() => byTestId('workspace-first-run-guide'))
            const reopenControlPresent = Boolean(byTestId('workspace-first-run-guide'))
            byTestId('workspace-first-run-guide')?.click()
            await waitFor(() => byTestId('product-first-run-guide'))
            const resumedGuide = byTestId('product-first-run-guide')
            const persisted = await window.electronAPI.loadSettings()
            const persistedGuide = persisted?.firstRunGuide
            const persistedWithoutContent = Boolean(
              persistedGuide &&
                !/path|query|filename|dialogue|credential/i.test(JSON.stringify(persistedGuide)),
            )
            const reopenedAndResumed = Boolean(
              resumedGuide &&
                resumedGuide.getAttribute('data-current-step') === 'source' &&
                persistedGuide?.status === 'active' &&
                Array.isArray(persistedGuide.completedSteps),
            )
            byTestId('first-run-skip')?.click()
            await waitFor(() => !byTestId('product-first-run-guide'))
            return {
              currentSource,
              dismissedAndHidden,
              fourSteps,
              persistedWithoutContent,
              reopenControlPresent,
              reopenedAndResumed,
              visibleOnFreshProfile,
            }
          })()
        `)) as UiSmokeSnapshot['firstRunGuideCheck']
        const glassSurfacePreview = process.env.FLOATING_CLOCK_UI_SMOKE_SURFACE === 'glass'
        await window.webContents.executeJavaScript(`
          (() => {
            const required = ${JSON.stringify(REQUIRED_PANEL_IDS)}
            const glassSurfacePreview = ${glassSurfacePreview ? 'true' : 'false'}
            const gap = 20
            const outerX = 20
            const outerY = 24
            // At 150% display scaling the CSS viewport is 1280px wide. Four
            // narrower columns keep all fourteen panels inside the 720px-high
            // viewport, so clipping evidence describes the application rather
            // than an impossible five-row test layout.
            const minimumPanelWidth = window.innerWidth <= 1280 ? 260 : 300
            const columns = Math.max(
              1,
              Math.min(
                4,
                Math.floor(
                  (window.innerWidth - outerX * 2 + gap) / (minimumPanelWidth + gap),
                ),
              ),
            )
            const rows = Math.ceil(required.length / columns)
            const panelWidth = Math.max(
              minimumPanelWidth,
              Math.floor((window.innerWidth - outerX * 2 - gap * (columns - 1)) / columns),
            )
            // A 720px-tall CSS viewport is the limiting case in the 150%
            // matrix run. Let the deterministic panels shrink to their
            // calculated height there instead of forcing the last row 4px
            // beyond the viewport.
            const minimumPanelHeight = window.innerHeight <= 720 ? 140 : 160
            const panelHeight = Math.max(
              minimumPanelHeight,
              Math.floor((window.innerHeight - outerY * 2 - gap * (rows - 1)) / rows),
            )
            const panels = Array.from(document.querySelectorAll('.panel'))
            for (const panel of panels) {
              const panelId = panel.getAttribute('data-panel') || ''
              if (!required.includes(panelId)) continue
              const index = required.indexOf(panelId)
              panel.dataset.uiSmokeIndex = String(index)
            }
            const style = document.createElement('style')
            style.dataset.uiSmokeLayout = 'true'
            style.textContent = [
              ...(glassSurfacePreview ? [
                'html, body, #root { background: radial-gradient(circle at 18% 22%, #255b89 0, #13263d 28%, transparent 52%), radial-gradient(circle at 78% 72%, #5b295f 0, #201229 32%, transparent 58%), linear-gradient(135deg, #101b2b, #0b101b) !important; }',
              ] : []),
              '.panel { display: none !important; }',
              ...required.map((panelId, index) => {
                const left = outerX + (index % columns) * (panelWidth + gap)
                const top = outerY + Math.floor(index / columns) * (panelHeight + gap)
                return '.panel[data-panel="' + panelId + '"] {' +
                  'display: flex !important;' +
                  'left: ' + left + 'px !important;' +
                  'top: ' + top + 'px !important;' +
                  'width: ' + panelWidth + 'px !important;' +
                  'height: ' + panelHeight + 'px !important;' +
                  'transform: none !important;' +
                  // Keep the deterministic smoke-test panel ordering inside the
                  // application's real panel layer range. Utility surfaces such
                  // as the workspace navigator intentionally sit above panels.
                  'z-index: ' + (100 + index) + ' !important;' +
                  (glassSurfacePreview ? '' : 'background: rgb(var(--bg)) !important;') +
                '}'
              }),
            ].join('\\n')
            document.head.appendChild(style)
          })()
        `)
        await window.webContents.executeJavaScript(`
          new Promise((resolve) => {
            const deadline = Date.now() + 8000
            const poll = () => {
              const imageReady = document.querySelector(
                '.panel[data-panel="image-search"] [data-testid="search-mode-simple"]',
              )
              const mediaReady = document.querySelector(
                '.panel[data-panel="media-search"] [data-testid="search-mode-simple"]',
              )
              if (imageReady && mediaReady) return resolve(true)
              if (Date.now() >= deadline) return resolve(false)
              setTimeout(poll, 50)
            }
            poll()
          })
        `)
        searchModeChecks = (await window.webContents.executeJavaScript(`
          (async () => {
            const configs = [
              {
                panelId: 'image-search',
                advancedMarker: 'image-search-start-scan',
                coreContainer: 'image-search-core-actions',
                coreActions: [
                  'image-search-select-folders',
                  'search-prepare-library',
                  'image-search-query-image',
                  'image-search-semantic-query',
                ],
                workspaceClass: 'image-search-workspace',
                controlClass: 'image-search-control-pane',
                resultsClass: 'image-search-results-pane',
                splitBreakpoint: 1050,
                workflowSections: [
                  'image-search-sources-section',
                  'image-search-library-section',
                  'image-search-query-section',
                  'image-search-maintenance-section',
                ],
                collapsibleWorkflowSections: [
                  'image-search-sources-section',
                  'image-search-library-section',
                  'image-search-maintenance-section',
                ],
                pinnedQuerySection: 'image-search-query-section',
              },
              {
                panelId: 'media-search',
                advancedMarker: 'media-search-build-frames',
                coreContainer: 'media-search-core-actions',
                coreActions: [
                  'media-search-select-videos',
                  'search-prepare-library',
                  'media-search-query-image',
                  'media-search-text-query',
                  'media-search-run-query',
                ],
                workspaceClass: 'media-search-workspace',
                controlClass: 'media-search-control-pane',
                resultsClass: 'media-search-results-pane',
                splitBreakpoint: 980,
                workflowSections: [
                  'media-search-sources-section',
                  'media-search-library-section',
                  'media-search-query-section',
                  'media-search-maintenance-section',
                ],
                collapsibleWorkflowSections: [
                  'media-search-sources-section',
                  'media-search-library-section',
                  'media-search-maintenance-section',
                ],
                pinnedQuerySection: 'media-search-query-section',
              },
            ]
            const findPanel = (panelId) =>
              document.querySelector('.panel[data-panel="' + panelId + '"]')
            const byTestId = (panel, testId) =>
              panel?.querySelector('[data-testid="' + testId + '"]')
            const has = (panel, testId) => Boolean(byTestId(panel, testId))
            const visibleCoreActions = (panel, config) =>
              config.coreActions.filter((testId) => {
                const element = byTestId(panel, testId)
                return Boolean(element && element.offsetParent !== null)
              })
            const checks = configs.map((config) => {
              const panel = findPanel(config.panelId)
              return {
                config,
                panel,
                simpleCoreActions: visibleCoreActions(panel, config),
                defaultSimple:
                  has(panel, 'search-prepare-library') && !has(panel, config.advancedMarker),
              }
            })
            const keyboardReachable = []
            for (const check of checks) {
              const simple = byTestId(check.panel, 'search-mode-simple')
              const advanced = byTestId(check.panel, 'search-mode-advanced')
              simple?.focus()
              simple?.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
              )
              await new Promise((resolve) => setTimeout(resolve, 50))
              const reachedAdvanced =
                advanced?.getAttribute('aria-checked') === 'true' && advanced?.tabIndex === 0
              advanced?.focus()
              const advancedFocusable = document.activeElement === advanced
              advanced?.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
              )
              await new Promise((resolve) => setTimeout(resolve, 50))
              keyboardReachable.push(
                reachedAdvanced &&
                  advancedFocusable &&
                  simple?.getAttribute('aria-checked') === 'true' &&
                  simple?.tabIndex === 0,
              )
            }
            for (const check of checks) byTestId(check.panel, 'search-mode-advanced')?.click()
            await new Promise((resolve) => setTimeout(resolve, 100))
            const advancedVisible = checks.map((check) => has(check.panel, check.config.advancedMarker))
            const coreActionParity = checks.map((check) => {
              const advancedActions = visibleCoreActions(check.panel, check.config)
              const declared = (
                byTestId(check.panel, check.config.coreContainer)?.getAttribute('data-core-actions') || ''
              ).split(/\\s+/).filter(Boolean)
              return (
                advancedActions.join('\\n') === check.simpleCoreActions.join('\\n') &&
                declared.join('\\n') === check.config.coreActions.join('\\n')
              )
            })
            const listViewOptionAbsent = checks.map((check) =>
              check.config.panelId !== 'image-search' ||
              !Array.from(check.panel?.querySelectorAll('option') || []).some(
                (option) => option.value === 'list',
              ),
            )
            for (const check of checks) byTestId(check.panel, 'search-mode-simple')?.click()
            await new Promise((resolve) => setTimeout(resolve, 100))
            const responsiveLayout = checks.map((check) => {
              const workspace = check.panel?.querySelector('.' + check.config.workspaceClass)
              const control = check.panel?.querySelector('.' + check.config.controlClass)
              const results = check.panel?.querySelector('.' + check.config.resultsClass)
              if (!workspace || !control || !results) return false
              const workspaceRect = workspace.getBoundingClientRect()
              const controlRect = control.getBoundingClientRect()
              const resultsRect = results.getBoundingClientRect()
              const split = workspaceRect.width >= check.config.splitBreakpoint
              if (split) {
                return (
                  getComputedStyle(workspace).display === 'grid' &&
                  resultsRect.left >= controlRect.right &&
                  resultsRect.width > 0
                )
              }
              return (
                getComputedStyle(workspace).display === 'flex' &&
                getComputedStyle(workspace).flexDirection === 'column' &&
                resultsRect.top >= controlRect.bottom - 2 &&
                controlRect.height <= workspaceRect.height * 0.55 + 2 &&
                resultsRect.height > 0
              )
            })
            const sectionedControls = checks.map((check) =>
              check.config.workflowSections.every((testId) => {
                const section = byTestId(check.panel, testId)
                return Boolean(
                  section &&
                    section.offsetParent !== null &&
                    section.querySelector('.search-control-section__header'),
                )
              }),
            )
            const collapsibleControls = []
            for (const check of checks) {
              byTestId(check.panel, check.config.panelId + '-sections-collapse-all')?.click()
              await new Promise((resolve) => setTimeout(resolve, 50))
              const collapsed = check.config.collapsibleWorkflowSections.every(
                (testId) => byTestId(check.panel, testId)?.getAttribute('data-collapsed') === 'true',
              )
              const pinnedQuery = byTestId(check.panel, check.config.pinnedQuerySection)
              const pinnedQueryRemainsExpanded =
                pinnedQuery?.getAttribute('data-collapsed') === 'false' &&
                pinnedQuery?.getAttribute('data-pinned') === 'true' &&
                pinnedQuery.querySelector('[data-static="true"]') !== null
              byTestId(check.panel, check.config.panelId + '-sections-expand-all')?.click()
              await new Promise((resolve) => setTimeout(resolve, 50))
              const expanded = check.config.workflowSections.every(
                (testId) => byTestId(check.panel, testId)?.getAttribute('data-collapsed') === 'false',
              )
              collapsibleControls.push(collapsed && pinnedQueryRemainsExpanded && expanded)
            }
            return checks.map((check, index) => ({
              panelId: check.config.panelId,
              defaultSimple: check.defaultSimple,
              advancedVisible: advancedVisible[index],
              coreActionParity: coreActionParity[index],
              keyboardReachable: keyboardReachable[index],
              sectionedControls: sectionedControls[index],
              collapsibleControls: collapsibleControls[index],
              listViewOptionAbsent: listViewOptionAbsent[index],
              responsiveLayout: responsiveLayout[index],
              wideSplitLayout: responsiveLayout[index],
              restoredSimple:
                has(check.panel, 'search-prepare-library') &&
                !has(check.panel, check.config.advancedMarker),
            }))
          })()
        `)) as UiSmokeSnapshot['searchModeChecks']
        languageSwitchCheck = (await window.webContents.executeJavaScript(`
          (async () => {
            const requested = ${JSON.stringify(options.expectedLocale)}
            const alternate = requested === 'zh-CN' ? 'en' : 'zh-CN'
            const panel = document.querySelector('.panel[data-panel="settings"]')
            const select = panel?.querySelector('[data-testid="app-language"]')
            const emptyEvidence = () => ({
              accessibilityNames: {},
              backupControls: '',
              categoryControls: '',
              cleanupControls: '',
              clippedTargetDetails: {},
              clippedTargets: [],
              duplicateNames: [],
              language: '',
              licenseControls: '',
              licenseEntryValid: false,
              panelTitles: '',
              searchEmpty: '',
              searchError: '',
              tagControls: '',
              unnamedTargets: [],
            })
            if (!select) return {
              accessibilityValid: false,
              alternate: null,
              controlFound: false,
              errorTranslated: false,
              layoutValid: false,
              requested: null,
              restored: false,
              restoredEvidence: null,
              surfacesChanged: false,
              switched: false,
              visibleTextChanged: false,
            }
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
            const changeTo = async (value) => {
              const currentSelect = panel?.querySelector('[data-testid="app-language"]')
              setter?.call(currentSelect, value)
              currentSelect?.dispatchEvent(new Event('change', { bubbles: true }))
              await new Promise((resolve) => setTimeout(resolve, 180))
              return document.documentElement.lang === value && currentSelect?.value === value
            }
            const collect = async () => {
              const evidence = emptyEvidence()
              evidence.language = document.documentElement.lang
              const byPanel = (panelId, testId) =>
                document.querySelector(
                  '.panel[data-panel="' + panelId + '"] [data-testid="' + testId + '"]',
                )
              const text = (node) => (node?.textContent || '').replace(/\\s+/g, ' ').trim()
              const name = (node) =>
                (
                  node?.getAttribute?.('aria-label') ||
                  node?.getAttribute?.('title') ||
                  node?.getAttribute?.('placeholder') ||
                  text(node)
                ).trim()
              const systemSection = byPanel('settings', 'settings-category-system')
              if (systemSection?.getAttribute('aria-expanded') !== 'true') {
                systemSection?.click()
                await new Promise((resolve) => setTimeout(resolve, 80))
              }
              // Inspect and focus only; opening Explorer is outside this UI smoke's scope.
              const licenseButton = byPanel('settings', 'settings-third-party-licenses')
              const licenseDescription = document.getElementById('third-party-licenses-description')
              const expectedLabel = evidence.language === 'zh-CN' ? '第三方许可' : 'Third-party licenses'
              const expectedDescription = evidence.language === 'zh-CN'
                ? '打开包含第三方许可及声明的文件夹。'
                : 'Open the folder containing third-party licenses and notices.'
              evidence.licenseControls = [name(licenseButton), text(licenseDescription)].join(' | ')
              evidence.licenseEntryValid = Boolean(
                licenseButton && !licenseButton.disabled && licenseButton.offsetParent !== null &&
                name(licenseButton) === expectedLabel && text(licenseDescription) === expectedDescription &&
                typeof window.electronAPI?.openThirdPartyLicenses === 'function',
              )
              const assetBackups = byPanel('neko-search', 'asset-backups-toggle')
              if (byPanel('neko-search', 'asset-backup-view')) {
                assetBackups?.click()
                await new Promise((resolve) => setTimeout(resolve, 100))
              }
              byPanel('neko-search', 'asset-view-library')?.click()
              await new Promise((resolve) => setTimeout(resolve, 50))
              byPanel('neko-search', 'asset-mode-categories')?.click()
              await new Promise((resolve) => setTimeout(resolve, 120))
              const categoryInput = byPanel('neko-search', 'asset-new-category-name')
              const categoryCreate = byPanel('neko-search', 'asset-create-category')
              const tagInput = byPanel('neko-search', 'asset-new-tag-name')
              const tagCreate = byPanel('neko-search', 'asset-create-tag')
              evidence.categoryControls = [name(categoryInput), name(categoryCreate)].join(' | ')
              evidence.tagControls = [name(tagInput), name(tagCreate)].join(' | ')
              const prepareLibrary = byPanel('image-search', 'search-prepare-library')
              const prepareLibraryName = name(prepareLibrary)
              byPanel('image-search', 'search-mode-advanced')?.click()
              await new Promise((resolve) => setTimeout(resolve, 100))
              const manualPath = byPanel('image-search', 'image-search-manual-path')
              const pathSetter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                'value',
              )?.set
              pathSetter?.call(manualPath, 'Z:\\\\floating-clock-smoke-missing')
              manualPath?.dispatchEvent(new Event('input', { bubbles: true }))
              await new Promise((resolve) => setTimeout(resolve, 30))
              byPanel('image-search', 'image-search-add-path')?.click()
              await new Promise((resolve) => setTimeout(resolve, 120))
              evidence.searchError = text(byPanel('image-search', 'image-search-toast'))
              evidence.searchEmpty = text(byPanel('image-search', 'image-search-results'))
              if (!byPanel('image-search', 'vector-cleanup-preview')) {
                byPanel('image-search', 'vector-storage-toggle')?.click()
                await new Promise((resolve) => setTimeout(resolve, 180))
              }
              const storageToggle = byPanel('image-search', 'vector-storage-toggle')
              const cleanupPreview = byPanel('image-search', 'vector-cleanup-preview')
              assetBackups?.click()
              await new Promise((resolve) => setTimeout(resolve, 120))
              evidence.backupControls = text(byPanel('neko-search', 'asset-backup-view'))
              evidence.cleanupControls = name(cleanupPreview)
              evidence.panelTitles = Array.from(
                document.querySelectorAll('.panel[data-panel] .panel-title'),
              )
                .map(text)
                .filter(Boolean)
                .join(' | ')

              const targets = [
                ['settings', 'app-language'],
                ['settings', 'settings-third-party-licenses'],
                ['image-search', 'search-mode-simple'],
                ['image-search', 'search-mode-advanced'],
                ['media-search', 'search-mode-simple'],
                ['media-search', 'search-mode-advanced'],
                ['media-search', 'search-prepare-library'],
                ['neko-search', 'asset-view-library'],
                ['neko-search', 'asset-view-review'],
                ['neko-search', 'asset-view-clusters'],
                ['neko-search', 'asset-backups-toggle'],
              ]
              const detachedTargets = [
                ['neko-search', 'asset-new-category-name', categoryInput],
                ['neko-search', 'asset-create-category', categoryCreate],
                ['neko-search', 'asset-new-tag-name', tagInput],
                ['neko-search', 'asset-create-tag', tagCreate],
                ['image-search', 'search-prepare-library', prepareLibraryName],
                ['image-search', 'vector-storage-toggle', storageToggle],
                ['image-search', 'vector-cleanup-preview', cleanupPreview],
              ]
              const namedByPanel = new Map()
              const inspect = (panelId, testId, node) => {
                const targetName = name(node)
                const key = panelId + ':' + testId
                evidence.accessibilityNames[key] = targetName
                if (!targetName) evidence.unnamedTargets.push(key)
                const names = namedByPanel.get(panelId) || []
                if (targetName && names.includes(targetName)) {
                  evidence.duplicateNames.push(panelId + ':' + targetName)
                }
                if (targetName) names.push(targetName)
                namedByPanel.set(panelId, names)
                if (!node || !node.isConnected || node.offsetParent === null) return
                const rect = node.getBoundingClientRect()
                const owner = node.closest('.panel')?.getBoundingClientRect()
                const reasons = []
                if (!owner) reasons.push('missing-owner')
                if (owner?.left < -1) reasons.push('owner-left')
                if (owner?.top < -1) reasons.push('owner-top')
                if (owner?.right > window.innerWidth + 1) reasons.push('owner-right')
                if (owner?.bottom > window.innerHeight + 1) reasons.push('owner-bottom')
                if (node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1) {
                  reasons.push('text-overflow')
                }
                if (owner && rect.width > 0 && rect.width > owner.width + 1) {
                  reasons.push('wider-than-owner')
                }
                if (reasons.length > 0) {
                  evidence.clippedTargets.push(key)
                  evidence.clippedTargetDetails[key] = {
                    clientWidth: node.clientWidth,
                    owner: owner
                      ? {
                          bottom: owner.bottom,
                          height: owner.height,
                          left: owner.left,
                          right: owner.right,
                          top: owner.top,
                          width: owner.width,
                        }
                      : null,
                    reasons,
                    rect: {
                      height: rect.height,
                      left: rect.left,
                      top: rect.top,
                      width: rect.width,
                    },
                    scrollWidth: node.scrollWidth,
                  }
                }
              }
              for (const [panelId, testId] of targets) {
                inspect(panelId, testId, byPanel(panelId, testId))
              }
              for (const [panelId, testId, node] of detachedTargets) {
                if (typeof node === 'string') {
                  const key = panelId + ':' + testId
                  evidence.accessibilityNames[key] = node
                  if (!node) evidence.unnamedTargets.push(key)
                } else {
                  inspect(panelId, testId, node)
                }
              }
              assetBackups?.click()
              await new Promise((resolve) => setTimeout(resolve, 80))
              byPanel('image-search', 'search-mode-simple')?.click()
              await new Promise((resolve) => setTimeout(resolve, 80))
              return evidence
            }
            await changeTo(requested)
            const requestedEvidence = await collect()
            const switched = await changeTo(alternate)
            const alternateEvidence = await collect()
            const restored = await changeTo(requested)
            const restoredEvidence = await collect()
            const surfaceKeys = [
              'backupControls',
              'categoryControls',
              'cleanupControls',
              'licenseControls',
              'panelTitles',
              'searchEmpty',
              'searchError',
              'tagControls',
            ]
            const changedKeys = surfaceKeys.filter(
              (key) => requestedEvidence[key] !== alternateEvidence[key],
            )
            const accessibilityValid = [requestedEvidence, alternateEvidence].every(
              (item) =>
                item.unnamedTargets.length === 0 &&
                item.duplicateNames.length === 0 &&
                Object.keys(item.accessibilityNames).length >= 13,
            )
            return {
              accessibilityValid,
              alternate: alternateEvidence,
              controlFound: true,
              errorTranslated:
                Boolean(requestedEvidence.searchError) &&
                Boolean(alternateEvidence.searchError) &&
                requestedEvidence.searchError !== alternateEvidence.searchError,
              layoutValid: [requestedEvidence, alternateEvidence, restoredEvidence].every(
                (item) => item.clippedTargets.length === 0,
              ),
              requested: requestedEvidence,
              restored,
              restoredEvidence,
              surfacesChanged: changedKeys.length === surfaceKeys.length,
              switched,
              visibleTextChanged:
                requestedEvidence.panelTitles !== alternateEvidence.panelTitles &&
                requestedEvidence.panelTitles === restoredEvidence.panelTitles,
            }
          })()
        `)) as UiSmokeSnapshot['languageSwitchCheck']
        materialSwitchCheck = (await window.webContents.executeJavaScript(`
          (async () => {
            const requested = ${JSON.stringify(process.env.FLOATING_CLOCK_UI_SMOKE_SURFACE === 'glass' ? 'glass' : 'solid')}
            const solid = document.querySelector('[data-testid="window-material-solid"]')
            const glass = document.querySelector('[data-testid="window-material-glass"]')
            const strength = document.querySelector('[data-testid="window-glass-strength"]')
            if (!solid || !glass || !strength) {
              return { controlsFound: false, switched: false, restored: false }
            }
            const wait = () => new Promise((resolve) => setTimeout(resolve, 80))
            const alternateButton = requested === 'glass' ? solid : glass
            const requestedButton = requested === 'glass' ? glass : solid
            alternateButton.click()
            await wait()
            const switched = document.documentElement.dataset.surface !== requested
            requestedButton.click()
            await wait()
            return {
              controlsFound: true,
              switched,
              restored: document.documentElement.dataset.surface === requested,
            }
          })()
        `)) as UiSmokeSnapshot['materialSwitchCheck']
        themeSwitchCheck = (await window.webContents.executeJavaScript(`
          (async () => {
            const root = document.documentElement
            const buttons = Array.from(document.querySelectorAll('.theme-style-option'))
            const mode = document.querySelector('[data-testid="theme-mode"]')
            const originalTheme = root.dataset.themeId
            const originalMode = root.dataset.themeMode
            const originalCanvas = getComputedStyle(root).getPropertyValue('--color-canvas')
            const originalAccent = getComputedStyle(root).getPropertyValue('--color-accent')
            const alternate = buttons.find((button) => button.getAttribute('aria-pressed') !== 'true')
            const original = buttons.find((button) => button.getAttribute('aria-pressed') === 'true')
            if (!mode || !alternate || !original) {
              return { controlsFound: false, modeSwitched: false, restored: false, semanticTokensChanged: false, themeSwitched: false }
            }
            const wait = () => new Promise((resolve) => setTimeout(resolve, 100))
            alternate.click()
            await wait()
            const themeSwitched = root.dataset.themeId !== originalTheme
            const semanticTokensChanged =
              getComputedStyle(root).getPropertyValue('--color-canvas') !== originalCanvas ||
              getComputedStyle(root).getPropertyValue('--color-accent') !== originalAccent
            const alternateMode = root.dataset.effectiveMode === 'dark' ? 'light' : 'dark'
            mode.value = alternateMode
            mode.dispatchEvent(new Event('change', { bubbles: true }))
            await wait()
            const modeSwitched = root.dataset.effectiveMode === alternateMode
            original.click()
            await wait()
            mode.value = originalMode
            mode.dispatchEvent(new Event('change', { bubbles: true }))
            await wait()
            return {
              controlsFound: true,
              modeSwitched,
              restored: root.dataset.themeId === originalTheme && root.dataset.themeMode === originalMode,
              semanticTokensChanged,
              themeSwitched,
            }
          })()
        `)) as UiSmokeSnapshot['themeSwitchCheck']
        assetLibraryCheck = (await window.webContents.executeJavaScript(`
          (async () => {
            const panel = document.querySelector('.panel[data-panel="neko-search"]')
            if (!panel) return {
              panelFound: false,
              categoryCreated: false,
              categoryDeleted: false,
              categoryRestored: false,
              deletionHistoryVisible: false,
              mergedNavigation: false,
              similarEntryVisible: false,
              categoryClusterEntryVisible: false,
              tagCreated: false,
              sampleSearchVisible: false,
              returnedToAssets: false,
              smartAlbumCrud: false,
              collectionCrud: false,
              shiftRangeSelection: null,
            }
            const byTestId = (testId) => panel.querySelector('[data-testid="' + testId + '"]')
            const setInput = (input, value) => {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
              setter?.call(input, value)
              input.dispatchEvent(new Event('input', { bubbles: true }))
            }
            const setSelect = (select, value) => {
              const setter = Object.getOwnPropertyDescriptor(
                HTMLSelectElement.prototype,
                'value',
              )?.set
              setter?.call(select, value)
              select?.dispatchEvent(new Event('change', { bubbles: true }))
            }
            const mergedNavigation = Boolean(
              byTestId('asset-view-library') && byTestId('asset-view-review'),
            )
            byTestId('asset-mode-categories')?.click()
            await new Promise((resolve) => setTimeout(resolve, 100))
            const categoryInput = byTestId('asset-new-category-name')
            if (categoryInput) {
              setInput(categoryInput, 'Smoke Category')
              byTestId('asset-create-category')?.click()
            }
            await new Promise((resolve) => setTimeout(resolve, 250))
            const smokeCategory = (await window.electronAPI.assetLibrary.listCategories()).find(
              (category) => category.name === 'Smoke Category',
            )
            const categoryCreated = Boolean(smokeCategory)
            let categoryDeleted = false
            let categoryRestored = false
            let deletionHistoryVisible = false
            if (smokeCategory) {
              const deleteResult = await window.electronAPI.assetLibrary.deleteCategory(
                smokeCategory.id,
              )
              categoryDeleted =
                deleteResult.ok &&
                !(await window.electronAPI.assetLibrary.listCategories()).some(
                  (category) => category.name === 'Smoke Category',
                )
              byTestId('asset-history-toggle')?.click()
              await new Promise((resolve) => setTimeout(resolve, 150))
              deletionHistoryVisible =
                Boolean(byTestId('asset-history-restore')) &&
                (panel.textContent || '').includes('Smoke Category')
              byTestId('asset-history-restore')?.click()
              await new Promise((resolve) => setTimeout(resolve, 300))
              categoryRestored =
                (await window.electronAPI.assetLibrary.listCategories()).some(
                  (category) => category.name === 'Smoke Category',
                )
            }
            const tagInput = byTestId('asset-new-tag-name')
            if (tagInput) {
              setInput(tagInput, 'Smoke Tag')
              byTestId('asset-create-tag')?.click()
            }
            await new Promise((resolve) => setTimeout(resolve, 250))
            const tagCreated = (await window.electronAPI.assetLibrary.listTags()).some(
              (tag) => tag.name === 'Smoke Tag',
            )
            byTestId('asset-view-review')?.click()
            await new Promise((resolve) => setTimeout(resolve, 80))
            byTestId('asset-mode-sampleSearch')?.click()
            await new Promise((resolve) => setTimeout(resolve, 100))
            const sampleCategorySelect = byTestId('asset-search-category')
            const sampleSearchVisible =
              Boolean(byTestId('asset-search-run')) &&
              Array.from(sampleCategorySelect?.querySelectorAll('option') || []).some(
                (option) => option.value === '0',
              )
            const similarEntryVisible = Boolean(byTestId('asset-mode-similar'))
            byTestId('asset-view-clusters')?.click()
            await new Promise((resolve) => setTimeout(resolve, 100))
            const clusterCategorySelect = byTestId('asset-cluster-category')
            const categoryClusterEntryVisible =
              Boolean(byTestId('asset-cluster-build-category')) &&
              Array.from(clusterCategorySelect?.querySelectorAll('option') || []).some(
                (option) => option.value === '0',
              )
            byTestId('asset-view-library')?.click()
            await new Promise((resolve) => setTimeout(resolve, 50))
            byTestId('asset-mode-assets')?.click()
            await new Promise((resolve) => setTimeout(resolve, 80))
            const smartAlbumName = byTestId('asset-smart-album-name')
            let smartAlbumCrud = false
            if (smartAlbumName) {
              setSelect(byTestId('asset-filter-source'), 'manual')
              setSelect(byTestId('asset-filter-kind'), 'video_frame')
              setSelect(byTestId('asset-filter-rating'), '4')
              byTestId('asset-filter-favorite')?.click()
              await new Promise((resolve) => setTimeout(resolve, 50))
              setInput(smartAlbumName, 'Smoke Smart Album')
              byTestId('asset-smart-album-bar')
                ?.querySelector('button')
                ?.click()
              await new Promise((resolve) => setTimeout(resolve, 180))
              const createdAlbum = (await window.electronAPI.assetLibrary.listSmartAlbums()).find(
                (album) => album.name === 'Smoke Smart Album',
              )
              if (createdAlbum) {
                const select = byTestId('asset-smart-album-select')
                if (select) {
                  const setter = Object.getOwnPropertyDescriptor(
                    HTMLSelectElement.prototype,
                    'value',
                  )?.set
                  setter?.call(select, String(createdAlbum.id))
                  select.dispatchEvent(new Event('change', { bubbles: true }))
                }
                await window.electronAPI.assetLibrary.updateSmartAlbum(createdAlbum.id, {
                  name: 'Smoke Smart Album Updated',
                })
                const deleted = await window.electronAPI.assetLibrary.deleteSmartAlbum(
                  createdAlbum.id,
                )
                smartAlbumCrud =
                  createdAlbum.rules.source === 'manual' &&
                  createdAlbum.rules.kind === 'video_frame' &&
                  createdAlbum.rules.minRating === 4 &&
                  createdAlbum.rules.favoriteOnly === true &&
                  deleted.ok &&
                  !(await window.electronAPI.assetLibrary.listSmartAlbums()).some(
                    (album) => album.id === createdAlbum.id,
                  )
              }
            }
            let shiftRangeSelection = null
            let collectionCrud = false
            const smokeCollection = await window.electronAPI.assetLibrary.createCollection(
              'Smoke Collection ' + Date.now(),
            )
            const secondCollection = await window.electronAPI.assetLibrary.createCollection(
              'Smoke Collection Second ' + Date.now(),
            )
            const renamedCollection = await window.electronAPI.assetLibrary.updateCollection(
              smokeCollection.id,
              'Smoke Collection Renamed ' + Date.now(),
            )
            await window.electronAPI.assetLibrary.reorderCollections([
              secondCollection.id,
              smokeCollection.id,
            ])
            const collected = await window.electronAPI.assetLibrary.addCollectionItems(
              smokeCollection.id,
              [
                {
                  fileEntryId: '1',
                  mediaType: 'image',
                  displayName: 'smoke.jpg',
                  displayPath: '/smoke/smoke.jpg',
                  sizeBytes: 1,
                  modifiedAt: 1,
                  source: {
                    id: 'smoke-source',
                    name: 'Smoke',
                    type: 'sftp',
                    availability: 'offline',
                  },
                },
                {
                  fileEntryId: '2',
                  mediaType: 'image',
                  displayName: 'smoke-two.jpg',
                  displayPath: '/smoke/smoke-two.jpg',
                  sizeBytes: 2,
                  modifiedAt: 2,
                  source: {
                    id: 'smoke-source',
                    name: 'Smoke',
                    type: 'sftp',
                    availability: 'offline',
                  },
                },
              ],
            )
            const orderedCollections = await window.electronAPI.assetLibrary.listCollections()
            const listedCollectionItems =
              await window.electronAPI.assetLibrary.listCollectionItems(smokeCollection.id)
            const removedCollectionItem = await window.electronAPI.assetLibrary.removeCollectionItem(
              collected[0].id,
            )
            const deletedCollection =
              await window.electronAPI.assetLibrary.deleteCollection(smokeCollection.id)
            const deletedSecondCollection =
              await window.electronAPI.assetLibrary.deleteCollection(secondCollection.id)
            collectionCrud =
              renamedCollection.name.startsWith('Smoke Collection Renamed') &&
              orderedCollections[0]?.id === secondCollection.id &&
              listedCollectionItems.length === 2 &&
              Boolean(document.querySelector('[data-testid="asset-collection-rename"]')) &&
              Boolean(document.querySelector('[data-testid="asset-collection-move-up"]')) &&
              Boolean(document.querySelector('[data-testid="asset-collection-move-down"]')) &&
              Boolean(document.querySelector('[data-testid="asset-collection-tray"]')) &&
              Boolean(byTestId('asset-library-collection-select')) &&
              Boolean(byTestId('asset-library-collect-selected')) &&
              Boolean(document.querySelector('[data-testid="media-search-collection-select"]')) &&
              removedCollectionItem.ok &&
              deletedCollection.ok &&
              deletedSecondCollection.ok
            let assetCheckboxes = Array.from(panel.querySelectorAll('[data-testid="asset-select"]'))
            if (assetCheckboxes.length >= 4) {
              assetCheckboxes[0].click()
              await new Promise((resolve) => setTimeout(resolve, 40))
              assetCheckboxes = Array.from(panel.querySelectorAll('[data-testid="asset-select"]'))
              assetCheckboxes[3].dispatchEvent(
                new MouseEvent('click', { bubbles: true, shiftKey: true }),
              )
              await new Promise((resolve) => setTimeout(resolve, 60))
              assetCheckboxes = Array.from(panel.querySelectorAll('[data-testid="asset-select"]'))
              const selectedRange = assetCheckboxes.slice(0, 4).every((input) => input.checked)
              assetCheckboxes[3].dispatchEvent(
                new MouseEvent('click', { bubbles: true, shiftKey: true }),
              )
              await new Promise((resolve) => setTimeout(resolve, 60))
              assetCheckboxes = Array.from(panel.querySelectorAll('[data-testid="asset-select"]'))
              shiftRangeSelection =
                selectedRange && assetCheckboxes.slice(0, 4).every((input) => !input.checked)
            }
            return {
              panelFound: true,
              categoryCreated,
              categoryDeleted,
              categoryRestored,
              deletionHistoryVisible,
              mergedNavigation,
              similarEntryVisible,
              categoryClusterEntryVisible,
              tagCreated,
              sampleSearchVisible,
              returnedToAssets: Boolean(byTestId('asset-filter-query')),
              smartAlbumCrud,
              collectionCrud,
              shiftRangeSelection,
            }
          })()
        `)) as UiSmokeSnapshot['assetLibraryCheck']
        try {
          runtimeCheck.models = (await window.webContents.executeJavaScript(`
            (async () => {
              const requireResourcesPath = ${app.isPackaged ? 'true' : 'false'}
              const resourcesPath = ${JSON.stringify(app.isPackaged ? process.resourcesPath : '')}
              const normalize = (value) => (value || '').replace(/\\\\/g, '/')
              const check = async (name) => {
                try {
                  const status = await window.electronAPI.vector.getModelStatus(name)
                  const installedPath =
                    typeof status?.installedPath === 'string' ? status.installedPath : null
                  const downloaded = status?.state === 'downloaded'
                  return {
                    ok:
                      downloaded &&
                      (!requireResourcesPath ||
                        normalize(installedPath).startsWith(normalize(resourcesPath) + '/')),
                    installedPath,
                  }
                } catch (error) {
                  return { ok: false, installedPath: null }
                }
              }
              const dino = await check('dinov2_vitb14')
              const clip = await check('clip_vit_base_patch32')
              return {
                dino: dino.ok,
                clip: clip.ok,
                dinoPath: dino.installedPath,
                clipPath: clip.installedPath,
              }
            })()
          `)) as UiSmokeSnapshot['runtimeCheck']['models']
        } catch {
          /* keep default false values so the report still records the failed check */
        }
        try {
          const imageSearchStatus = getImageSearchStatus()
          runtimeCheck.native = {
            connected: imageSearchStatus.nativeConnected === true,
            version: imageSearchStatus.nativeVersion ?? null,
            path: imageSearchStatus.nativePath ?? null,
          }
        } catch {
          /* keep default false values */
        }
        try {
          runtimeCheck.mediaTools = (await window.webContents.executeJavaScript(`
            (async () => {
              const status = await window.electronAPI.mediaSearch.getStatus({
                includeCounts: false,
              })
              return {
                ffmpeg: status?.ffmpegConfigured === true,
                ffprobe: status?.ffprobeConfigured === true,
                ffmpegPath:
                  typeof status?.ffmpegCommand === 'string' ? status.ffmpegCommand : null,
                ffprobePath:
                  typeof status?.ffprobeCommand === 'string' ? status.ffprobeCommand : null,
              }
            })()
          `)) as UiSmokeSnapshot['runtimeCheck']['mediaTools']
        } catch {
          /* keep default false values */
        }
        if (app.isPackaged) {
          const resourcesRoot = path.resolve(process.resourcesPath)
          const isUnderResources = (candidate: string | null): boolean => {
            if (!candidate || !path.isAbsolute(candidate)) return false
            const relative = path.relative(resourcesRoot, path.resolve(candidate))
            // path.relative returns an absolute path when the candidate sits on another drive.
            if (path.isAbsolute(relative)) return false
            return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`))
          }
          runtimeCheck.packagedProvenance.modelsUnderResources =
            isUnderResources(runtimeCheck.models.dinoPath) &&
            isUnderResources(runtimeCheck.models.clipPath)
          runtimeCheck.packagedProvenance.userCandidateModelsAbsent = [
            'models/yolov8n/model.onnx',
            'models/yolov8n-face/model.onnx',
            'models/adaface/model.onnx',
            'models/osnet/model.onnx',
            'models/mobilesam/encoder.onnx',
            'models/mobilesam/decoder.onnx',
          ].every((relativePath) => !fs.existsSync(path.join(resourcesRoot, relativePath)))
          runtimeCheck.packagedProvenance.nativeUnderResources = isUnderResources(
            runtimeCheck.native.path,
          )
          runtimeCheck.packagedProvenance.ffmpegUnderResources = isUnderResources(
            runtimeCheck.mediaTools.ffmpegPath,
          )
          runtimeCheck.packagedProvenance.ffprobeUnderResources = isUnderResources(
            runtimeCheck.mediaTools.ffprobePath,
          )
        }
        const thumbnailGpuSmokeManifest =
          process.env.FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_MANIFEST?.trim()
        let thumbnailGpuSmokeSources: string[] = []
        if (thumbnailGpuSmokeManifest) {
          const manifestEntry = fs.lstatSync(thumbnailGpuSmokeManifest)
          const manifestRoot = fs.realpathSync.native(app.getPath('userData'))
          const manifestRealPath = fs.realpathSync.native(thumbnailGpuSmokeManifest)
          const relativeManifest = path.relative(manifestRoot, manifestRealPath)
          if (
            manifestEntry.isFile() &&
            !manifestEntry.isSymbolicLink() &&
            relativeManifest &&
            !relativeManifest.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relativeManifest) &&
            manifestEntry.size > 2 &&
            manifestEntry.size <= 4 * 1024 * 1024
          ) {
            const parsed = JSON.parse(fs.readFileSync(manifestRealPath, 'utf8')) as unknown
            if (
              Array.isArray(parsed) &&
              parsed.length > 0 &&
              parsed.length <= 10_000 &&
              parsed.every((value) => typeof value === 'string' && value.length <= 32_768)
            ) {
              const validatedSources = parsed.filter((value) => {
                try {
                  const entry = fs.lstatSync(value)
                  return entry.isFile() && !entry.isSymbolicLink()
                } catch {
                  return false
                }
              })
              if (validatedSources.length === parsed.length) {
                thumbnailGpuSmokeSources = validatedSources
              }
            }
          }
        }
        if (thumbnailGpuSmokeSources.length > 0) {
          runtimeCheck.thumbnailGpu.attempted = true
          const thumbnailGpuSmokeJobs =
            Math.floor(Number(process.env.FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_JOBS)) || 4
          const thumbnailGpuSmokeBatch =
            Math.floor(Number(process.env.FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_BATCH)) || 2
          const thumbnailGpuSmokePolls = Math.max(
            1,
            Math.min(
              2400,
              Math.floor(Number(process.env.FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_POLLS)) || 200,
            ),
          )
          const thumbnailGpuSmokeBackend =
            process.env.FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_BACKEND === 'cpu' ||
            process.env.FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_BACKEND === 'auto'
              ? process.env.FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_BACKEND
              : 'gpu'
          try {
            runtimeCheck.thumbnailGpu = (await window.webContents.executeJavaScript(`
              (async () => {
                const startedAt = Date.now()
                const result = {
                  attempted: true,
                  completed: false,
                  effectiveBackend: null,
                  gpuCompleted: 0,
                  cpuCompleted: 0,
                  fallbackCount: 0,
                  gpuDevice: null,
                  gpuError: null,
                  elapsedMs: 0,
                  total: 0,
                  gpuJobs: 0,
                  gpuLanes: 0,
                  cpuLanes: 0,
                  batchSize: 0,
                  peakInFlight: 0,
                  autoCpuRouted: 0,
                  cacheWrites: 0,
                  cacheWriteFailures: 0,
                }
                const started = await window.electronAPI.imageSearch.startThumbnailRebuild(
                  ${JSON.stringify(thumbnailGpuSmokeSources)},
                  ${JSON.stringify(thumbnailGpuSmokeBackend)},
                  ${thumbnailGpuSmokeJobs},
                  ${thumbnailGpuSmokeBatch},
                )
                if (!started?.ok) {
                  result.gpuError = started?.error || 'GPU thumbnail smoke could not start'
                  return result
                }
                let progress = started.progress
                for (let attempt = 0; attempt < ${thumbnailGpuSmokePolls}; attempt += 1) {
                  if (progress?.state === 'done' || progress?.state === 'error') break
                  await new Promise((resolve) => setTimeout(resolve, 50))
                  progress = await window.electronAPI.imageSearch.getThumbnailRebuildProgress()
                }
                result.completed =
                  progress?.state === 'done' &&
                  progress.completed > 0 &&
                  progress.failed === 0
                result.effectiveBackend = progress?.effectiveBackend || null
                result.gpuCompleted = progress?.gpuCompleted || 0
                result.cpuCompleted = progress?.cpuCompleted || 0
                result.fallbackCount = progress?.fallbackCount || 0
                result.gpuDevice = progress?.gpuDevice || null
                result.gpuError = progress?.gpuError || progress?.error || null
                result.elapsedMs = Date.now() - startedAt
                result.total = progress?.total || 0
                result.gpuJobs = progress?.gpuJobs || 0
                result.gpuLanes = progress?.gpuLanes || 0
                result.cpuLanes = progress?.cpuLanes || 0
                result.batchSize = progress?.batchSize || 0
                result.peakInFlight = progress?.peakInFlight || 0
                result.autoCpuRouted = progress?.autoCpuRouted || 0
                result.cacheWrites = progress?.cacheWrites || 0
                result.cacheWriteFailures = progress?.cacheWriteFailures || 0
                return result
              })()
            `)) as UiSmokeSnapshot['runtimeCheck']['thumbnailGpu']
          } catch (error) {
            runtimeCheck.thumbnailGpu.gpuError =
              error instanceof Error ? error.message : String(error)
          }
          await window.webContents.executeJavaScript(`
            (() => {
              const panel = document.querySelector('.panel[data-panel="image-search"]')
              panel?.querySelector('[data-testid="image-search-data-manager-toggle"]')?.click()
            })()
          `)
          await wait(100)
        }
        try {
          // restoreAssetLibraryBackup requires the backup to contain the asset
          // metadata index (assets.jsonl). A smoke library only has categories
          // and tags, so seed an empty index file before the backup runs.
          const assetLibraryDir = path.join(app.getPath('userData'), 'asset-library')
          const assetsIndexPath = path.join(assetLibraryDir, 'assets.jsonl')
          if (!fs.existsSync(assetsIndexPath)) {
            fs.mkdirSync(assetLibraryDir, { recursive: true })
            fs.writeFileSync(assetsIndexPath, '', 'utf8')
          }
        } catch {
          /* the backup check below will record the failure */
        }
        try {
          runtimeCheck.backup = (await window.webContents.executeJavaScript(`
            (async () => {
              const result = {
                created: false,
                listed: false,
                verified: false,
                restored: false,
                preRestoreCreated: false,
                categoryIntact: false,
              }
              try {
                const api = window.electronAPI.assetLibrary
                const created = await api.createBackup()
                if (!created || !created.ok || !created.backup || !created.backup.id) return result
                result.created = true
                const backups = await api.listBackups()
                result.listed =
                  Array.isArray(backups) &&
                  backups.some((backup) => backup.id === created.backup.id)
                const verification = await api.verifyBackup(created.backup.id)
                result.verified = Boolean(verification && verification.ok)
                const restored = await api.restoreBackup(created.backup.id)
                result.restored = Boolean(restored && restored.ok)
                const afterRestore = await api.listBackups()
                result.preRestoreCreated = Boolean(
                  (restored &&
                    restored.protectiveBackupId &&
                    afterRestore.some((backup) => backup.id === restored.protectiveBackupId)) ||
                  afterRestore.some((backup) => backup.reason === 'pre_restore'),
                )
                const categories = await api.listCategories()
                result.categoryIntact = categories.some(
                  (category) => category.name === 'Smoke Category',
                )
              } catch (error) {
                /* keep false values */
              }
              return result
            })()
          `)) as UiSmokeSnapshot['runtimeCheck']['backup']
        } catch {
          /* keep default false values */
        }
        await window.webContents.executeJavaScript(`
          (async () => {
            const toggle = document.querySelector(
              '[data-testid="workspace-model-readiness-toggle"]',
            )
            if (!document.querySelector('[data-testid="global-model-readiness"]')) toggle?.click()
            const deadline = Date.now() + 3000
            while (
              !document.querySelector('[data-testid="global-model-readiness"]') &&
              Date.now() < deadline
            ) {
              await new Promise((resolve) => setTimeout(resolve, 50))
            }
          })()
        `)
        if ((options.churnCycles || 0) > 0) {
          // Warm lazy navigation and panel listeners before the measured 600
          // cycles. Otherwise one-time initialization is misclassified as a
          // lifecycle leak, especially after the thumbnail data manager ran.
          await window.webContents.executeJavaScript(`
            (async () => {
              const panelSelector = '.panel[data-panel="image-search"]'
              const panelIsVisible = () => {
                const panel = document.querySelector(panelSelector)
                return panel instanceof HTMLElement && panel.offsetParent !== null
              }
              const waitFor = async (predicate, timeoutMs = 2000) => {
                const deadline = Date.now() + timeoutMs
                while (Date.now() < deadline) {
                  if (predicate()) return true
                  await new Promise((resolve) => setTimeout(resolve, 0))
                }
                return Boolean(predicate())
              }
              for (let index = 0; index < 5; index += 1) {
                document.querySelector(panelSelector + ' .panel-control-close')?.click()
                if (!(await waitFor(() => !panelIsVisible()))) break
                document.querySelector('[data-testid="workspace-domain-search"]')?.click()
                await new Promise((resolve) => setTimeout(resolve, 0))
                if (!document.querySelector('[data-testid="workspace-search-images"]')) {
                  document.querySelector('[data-testid="workspace-search-advanced-toggle"]')?.click()
                  if (!(await waitFor(() => document.querySelector('[data-testid="workspace-search-images"]')))) break
                }
                document.querySelector('[data-testid="workspace-search-images"]')?.click()
                if (!(await waitFor(panelIsVisible))) break
              }
            })()
          `)
        }
        const rendererMetricsBefore =
          (options.churnCycles || 0) > 0
            ? await captureRendererLifecycleMetrics(window, 'churn-before')
            : null
        const lifecycleChurnResult = (await window.webContents.executeJavaScript(`
          (async () => {
            const requestedCycles = ${Math.max(0, Math.min(600, options.churnCycles || 0))}
            const panelSelector = '.panel[data-panel="image-search"]'
            const closeSelector = panelSelector + ' .panel-control-close'
            const panelIsVisible = () => {
              const panel = document.querySelector(panelSelector)
              return panel instanceof HTMLElement && panel.offsetParent !== null
            }
            const waitFor = async (predicate, timeoutMs = 2000) => {
              const deadline = Date.now() + timeoutMs
              while (Date.now() < deadline) {
                if (predicate()) return true
                await new Promise((resolve) => setTimeout(resolve, 0))
              }
              return Boolean(predicate())
            }
            const beforeNodes = document.querySelectorAll('*').length
            const beforeHeap = Number(performance.memory?.usedJSHeapSize)
            let completedCycles = 0
            for (let index = 0; index < requestedCycles; index += 1) {
              const close = document.querySelector(closeSelector)
              if (!close) break
              close.click()
              // Task-owning panels intentionally stay mounted while hidden so
              // closing a window cannot discard active work. Observe layout
              // visibility instead of incorrectly requiring DOM removal.
              if (!(await waitFor(() => !panelIsVisible()))) break
              document.querySelector('[data-testid="workspace-domain-search"]')?.click()
              await new Promise((resolve) => setTimeout(resolve, 0))
              if (!document.querySelector('[data-testid="workspace-search-images"]')) {
                document.querySelector('[data-testid="workspace-search-advanced-toggle"]')?.click()
                if (
                  !(await waitFor(() =>
                    document.querySelector('[data-testid="workspace-search-images"]'),
                  ))
                ) break
              }
              document.querySelector('[data-testid="workspace-search-images"]')?.click()
              if (!(await waitFor(panelIsVisible))) break
              completedCycles += 1
            }
            const afterNodes = document.querySelectorAll('*').length
            const afterHeap = Number(performance.memory?.usedJSHeapSize)
            return {
              completedCycles,
              domNodeDelta: afterNodes - beforeNodes,
              finalPanelPresent: panelIsVisible(),
              jsHeapDeltaBytes:
                Number.isFinite(beforeHeap) && Number.isFinite(afterHeap)
                  ? afterHeap - beforeHeap
                  : null,
              requestedCycles,
            }
          })()
        `)) as UiSmokeSnapshot['lifecycleChurnCheck']
        if ((options.churnCycles || 0) > 0) await wait(1_000)
        const rendererMetricsAfter =
          (options.churnCycles || 0) > 0
            ? await captureRendererLifecycleMetrics(window, 'churn-after')
            : null
        const rendererMetricsDelta =
          rendererMetricsBefore && rendererMetricsAfter
            ? {
                documents: rendererMetricsAfter.documents - rendererMetricsBefore.documents,
                jsEventListeners:
                  rendererMetricsAfter.jsEventListeners - rendererMetricsBefore.jsEventListeners,
                nodes: rendererMetricsAfter.nodes - rendererMetricsBefore.nodes,
                usedHeapBytes:
                  rendererMetricsAfter.usedHeapBytes - rendererMetricsBefore.usedHeapBytes,
              }
            : null
        lifecycleChurnCheck = {
          ...lifecycleChurnResult,
          rendererMetrics: {
            after: rendererMetricsAfter,
            before: rendererMetricsBefore,
            delta: rendererMetricsDelta,
          },
        }

        window.showInactive()
        await wait(250)
        if (options.setWindowVisibility) {
          visibilityCycleCheck.attempted = true
          const interactionStarted = (await window.webContents.executeJavaScript(`
            (() => {
              const handle = document.querySelector('[data-testid="workspace-navigator-move"]')
              const navigator = handle?.closest('.workspace-navigator')
              if (!(handle instanceof HTMLElement) || !(navigator instanceof HTMLElement)) return false
              const rect = handle.getBoundingClientRect()
              handle.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true,
                button: 0,
                clientX: rect.left + 4,
                clientY: rect.top + 4,
              }))
              window.dispatchEvent(new MouseEvent('mousemove', {
                bubbles: true,
                clientX: rect.left + 20,
                clientY: rect.top + 12,
              }))
              return navigator.dataset.moving === 'true'
            })()
          `)) as boolean
          if (interactionStarted && options.setWindowVisibility(false)) {
            await waitForNativeVisibility(window, false)
            await wait(20)
            visibilityCycleCheck.interactionCancelledOnHide = (await window.webContents
              .executeJavaScript(`
                (() => {
                  const navigator = document.querySelector('.workspace-navigator')
                  return navigator instanceof HTMLElement &&
                    navigator.dataset.moving !== 'true' &&
                    document.documentElement.dataset.panelInteraction !== 'active'
                })()
              `)) as boolean
            options.setWindowVisibility(true)
            await waitForNativeVisibility(window, true)
          }
          // The first visible cycle releases renderer idle work that Chromium held
          // while the transparent window was occluded. Take the leak baseline only
          // after that one-time initialization, so the soak measures cycle growth.
          await wait(250)
          visibilityCycleCheck.rendererMetrics.before = await captureRendererLifecycleMetrics(
            window,
            'visibility-before',
          )
          for (let cycle = 0; cycle < visibilityCycleCheck.requestedCycles; cycle += 1) {
            if (!options.setWindowVisibility(false)) break
            if (!(await waitForNativeVisibility(window, false))) break
            const showStartedAt = Date.now()
            if (!options.setWindowVisibility(true)) break
            if (!(await waitForNativeVisibility(window, true))) break
            const showLatencyMs = Date.now() - showStartedAt
            visibilityShowLatenciesMs.push(showLatencyMs)
            visibilityCycleCheck.maxShowLatencyMs = Math.max(
              visibilityCycleCheck.maxShowLatencyMs,
              showLatencyMs,
            )
            const visibleState = (await window.webContents.executeJavaScript(`
              (() => ({
                generation: Number(document.documentElement.dataset.windowVisibilityGeneration),
                panelCount: Array.from(document.querySelectorAll('.panel')).filter(
                  (panel) => panel instanceof HTMLElement && panel.offsetParent !== null,
                ).length,
              }))()
            `)) as { generation: number; panelCount: number }
            visibilityCycleCheck.generations.push(visibleState.generation)
            visibilityCycleCheck.panelsReadyOnShow &&=
              visibleState.panelCount >= REQUIRED_PANEL_IDS.length
            visibilityCycleCheck.completedCycles += 1
          }
          visibilityCycleCheck.p95ShowLatencyMs = percentile(visibilityShowLatenciesMs, 0.95)
          visibilityCycleCheck.p99ShowLatencyMs = percentile(visibilityShowLatenciesMs, 0.99)
          visibilityCycleCheck.visibleFrameCadence = await measureVisibleFrameCadence(window)
          visibilityCycleCheck.rendererMetrics.after = await captureRendererLifecycleMetrics(
            window,
            'visibility-after',
          )
          const before = visibilityCycleCheck.rendererMetrics.before
          const after = visibilityCycleCheck.rendererMetrics.after
          if (before && after) {
            visibilityCycleCheck.rendererMetrics.delta = {
              documents: after.documents - before.documents,
              jsEventListeners: after.jsEventListeners - before.jsEventListeners,
              nodes: after.nodes - before.nodes,
              usedHeapBytes: after.usedHeapBytes - before.usedHeapBytes,
            }
          }
        }
        snapshot = (await window.webContents.executeJavaScript(`
          (() => {
            const panels = Array.from(document.querySelectorAll('.panel'))
              .filter((panel) => panel instanceof HTMLElement && panel.offsetParent !== null)
            const titles = panels
              .map((panel) => panel.querySelector('.panel-title')?.textContent?.trim() || '')
              .filter(Boolean)
            const panelIds = panels
              .map((panel) => panel.getAttribute('data-panel') || '')
              .filter(Boolean)
            const crashedPanels = Array.from(
              document.querySelectorAll('[data-testid="error-boundary"]'),
            ).map(
              (node) =>
                node.getAttribute('data-boundary-name') || node.textContent?.trim() || 'unknown',
            )
            return {
              bodyTextLength: (document.body.innerText || '').trim().length,
              crashedPanels: Array.from(new Set(crashedPanels)),
              devicePixelRatio: window.devicePixelRatio,
              language: document.documentElement.lang,
              panelCount: panels.length,
              panelIds,
              readyState: document.readyState,
              titles,
              viewport: { width: window.innerWidth, height: window.innerHeight },
            }
          })()
        `)) as UiSmokeSnapshot
        snapshot.searchModeChecks = searchModeChecks
        snapshot.workspaceNavigationCheck = workspaceNavigationCheck
        snapshot.firstRunGuideCheck = firstRunGuideCheck
        snapshot.languageSwitchCheck = languageSwitchCheck
        snapshot.materialSwitchCheck = materialSwitchCheck
        snapshot.themeSwitchCheck = themeSwitchCheck
        snapshot.lifecycleChurnCheck = lifecycleChurnCheck
        snapshot.assetLibraryCheck = assetLibraryCheck
        snapshot.runtimeCheck = runtimeCheck

        if (options.screenshotPath) {
          const modelRect = (await window.webContents.executeJavaScript(`
            (() => {
              const navigator = document.querySelector('.workspace-navigator')
              const panel = document.querySelector('[data-testid="global-model-readiness"]')
              if (!navigator || !panel) return null
              const rect = navigator.getBoundingClientRect()
              return {
                x: Math.max(0, Math.floor(rect.left - 8)),
                y: Math.max(0, Math.floor(rect.top - 8)),
                width: Math.min(window.innerWidth, Math.ceil(rect.width + 16)),
                height: Math.min(window.innerHeight, Math.ceil(rect.height + 16)),
              }
            })()
          `)) as { x: number; y: number; width: number; height: number } | null
          if (modelRect && modelRect.width > 0 && modelRect.height > 0) {
            modelScreenshotPath = path.join(
              path.dirname(options.screenshotPath),
              'model-readiness.png',
            )
            const modelImage = await window.capturePage(modelRect)
            fs.mkdirSync(path.dirname(modelScreenshotPath), { recursive: true })
            fs.writeFileSync(modelScreenshotPath, modelImage.toPNG())
          }
          const image = await window.capturePage()
          screenshotSize = image.getSize()
          const bitmap = image.toBitmap()
          for (let offset = 3; offset < bitmap.length; offset += 4 * 16) {
            if (bitmap[offset] > 0) nonTransparentPixelSamples += 1
          }
          fs.mkdirSync(path.dirname(options.screenshotPath), { recursive: true })
          fs.writeFileSync(options.screenshotPath, image.toPNG())
        }
        licenseAccessCheck = (await window.webContents.executeJavaScript(`
          (async () => {
            const panel = document.querySelector('.panel[data-panel="settings"]')
            const section = panel?.querySelector('[data-testid="settings-category-system"]')
            if (section?.getAttribute('aria-expanded') !== 'true') section?.click()
            await new Promise((resolve) => setTimeout(resolve, 80))
            const button = panel?.querySelector('[data-testid="settings-third-party-licenses"]')
            // Raise the settings panel and focus the control without clicking it or invoking IPC.
            panel?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
            button?.scrollIntoView({ block: 'center', inline: 'nearest' })
            button?.focus({ preventScroll: true })
            await new Promise((resolve) => setTimeout(resolve, 100))
            const rect = button?.getBoundingClientRect()
            const panelRect = panel?.getBoundingClientRect()
            const visible = Boolean(rect && rect.width > 0 && rect.height > 0 &&
              rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth &&
              rect.bottom <= window.innerHeight && button?.offsetParent !== null)
            const hit = visible ? document.elementFromPoint(rect.left + rect.width / 2,
              rect.top + rect.height / 2) : null
            const expected = document.documentElement.lang === 'zh-CN'
              ? '第三方许可' : 'Third-party licenses'
            return {
              buttonFound: Boolean(button),
              keyboardReachable: Boolean(button && !button.disabled && button.tabIndex >= 0 &&
                document.activeElement === button),
              labelMatches: button?.textContent?.trim() === expected,
              preloadAvailable: typeof window.electronAPI?.openThirdPartyLicenses === 'function',
              visible,
              unobscured: Boolean(hit && (hit === button || button?.contains(hit))),
              shellLaunchTested: false,
              panelRect: panelRect ? {
                x: Math.max(0, Math.floor(panelRect.left)),
                y: Math.max(0, Math.floor(panelRect.top)),
                width: Math.max(0, Math.min(window.innerWidth, Math.ceil(panelRect.right)) -
                  Math.max(0, Math.floor(panelRect.left))),
                height: Math.max(0, Math.min(window.innerHeight, Math.ceil(panelRect.bottom)) -
                  Math.max(0, Math.floor(panelRect.top))),
              } : null,
            }
          })()
        `)) as UiSmokeSnapshot['licenseAccessCheck']
        snapshot.licenseAccessCheck = licenseAccessCheck
        if (
          options.screenshotPath &&
          licenseAccessCheck.panelRect &&
          licenseAccessCheck.panelRect.width > 0 &&
          licenseAccessCheck.panelRect.height > 0
        ) {
          licenseScreenshotPath = path.join(
            path.dirname(options.screenshotPath),
            'third-party-licenses.png',
          )
          const licenseImage = await window.capturePage(licenseAccessCheck.panelRect)
          fs.writeFileSync(licenseScreenshotPath, licenseImage.toPNG())
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }

      const missingPanels = REQUIRED_PANEL_IDS.filter(
        (panelId) => !snapshot?.panelIds.includes(panelId),
      )
      const windowBounds = window.getBounds()
      const expectedFixtureBytes = Number(process.env.FLOATING_CLOCK_UI_SMOKE_FILE_FIXTURE_BYTES)
      const fileFixtureCheck = {
        required: Number.isFinite(expectedFixtureBytes) && expectedFixtureBytes > 0,
        directoryShown: false,
        sizeComplete: false,
        totalBytes: null as number | null,
      }
      if (fileFixtureCheck.required && !window.isDestroyed()) {
        const expectedDirectory = path.join(
          path.dirname(app.getPath('userData')),
          'file-manager-fixture',
        )
        const evidence = await window.webContents
          .executeJavaScript(
            `(() => {
          const panel = document.querySelector('.panel[data-panel="file-manager"]')
          const total = panel?.querySelector('[data-testid="fm-current-total-size"]')
          return {
            directoryShown: Array.from(panel?.querySelectorAll('button[title]') || [])
              .some(button => button.getAttribute('title') === ${JSON.stringify(expectedDirectory)}),
            sizeComplete: total?.getAttribute('data-total-size-complete') === 'true',
            totalBytes: total ? Number(total.getAttribute('data-total-size-bytes')) : null
          }
        })()`,
          )
          .catch(() => null)
        if (evidence) Object.assign(fileFixtureCheck, evidence)
      }
      const workAreaMatches =
        !options.expectedWorkArea ||
        (Math.abs(windowBounds.x - options.expectedWorkArea.x) <= 4 &&
          Math.abs(windowBounds.y - options.expectedWorkArea.y) <= 4 &&
          Math.abs(windowBounds.width - options.expectedWorkArea.width) <= 4 &&
          Math.abs(windowBounds.height - options.expectedWorkArea.height) <= 4)
      const ok = Boolean(
        !failure &&
        (!fileFixtureCheck.required ||
          (fileFixtureCheck.directoryShown &&
            fileFixtureCheck.sizeComplete &&
            fileFixtureCheck.totalBytes === expectedFixtureBytes)) &&
        snapshot &&
        snapshot.readyState === 'complete' &&
        snapshot.language === options.expectedLocale &&
        snapshot.bodyTextLength > 0 &&
        snapshot.panelCount >= REQUIRED_PANEL_IDS.length &&
        snapshot.crashedPanels.length === 0 &&
        missingPanels.length === 0 &&
        searchModeChecks.length === 2 &&
        searchModeChecks.every(
          (check) =>
            check.defaultSimple &&
            check.advancedVisible &&
            check.coreActionParity &&
            check.keyboardReachable &&
            check.sectionedControls &&
            check.collapsibleControls &&
            check.restoredSimple &&
            check.listViewOptionAbsent &&
            check.wideSplitLayout &&
            check.responsiveLayout,
        ) &&
        workspaceNavigationCheck.domainsPresent &&
        workspaceNavigationCheck.compositorDragStable &&
        workspaceNavigationCheck.domainWidthStable &&
        workspaceNavigationCheck.keyboardReachable &&
        workspaceNavigationCheck.legacyModuleNamesAbsent &&
        workspaceNavigationCheck.modelInventoryComplete &&
        workspaceNavigationCheck.modelLayoutValid &&
        workspaceNavigationCheck.modelOcclusionFree &&
        workspaceNavigationCheck.modelStatusInNavigator &&
        workspaceNavigationCheck.remoteAdvancedFocused &&
        workspaceNavigationCheck.sourcesExpanded &&
        workspaceNavigationCheck.taskSummaryVisible &&
        workspaceNavigationCheck.unifiedSearchPageVisible &&
        workspaceNavigationCheck.viewportStable &&
        firstRunGuideCheck.visibleOnFreshProfile &&
        firstRunGuideCheck.fourSteps &&
        firstRunGuideCheck.currentSource &&
        firstRunGuideCheck.dismissedAndHidden &&
        firstRunGuideCheck.reopenControlPresent &&
        firstRunGuideCheck.reopenedAndResumed &&
        firstRunGuideCheck.persistedWithoutContent &&
        languageSwitchCheck.controlFound &&
        languageSwitchCheck.switched &&
        languageSwitchCheck.restored &&
        languageSwitchCheck.visibleTextChanged &&
        languageSwitchCheck.surfacesChanged &&
        languageSwitchCheck.errorTranslated &&
        languageSwitchCheck.accessibilityValid &&
        languageSwitchCheck.layoutValid &&
        [
          languageSwitchCheck.requested,
          languageSwitchCheck.alternate,
          languageSwitchCheck.restoredEvidence,
        ].every((evidence) => evidence?.licenseEntryValid) &&
        licenseAccessCheck.buttonFound &&
        licenseAccessCheck.keyboardReachable &&
        licenseAccessCheck.labelMatches &&
        licenseAccessCheck.preloadAvailable &&
        licenseAccessCheck.visible &&
        licenseAccessCheck.unobscured &&
        materialSwitchCheck.controlsFound &&
        materialSwitchCheck.switched &&
        materialSwitchCheck.restored &&
        themeSwitchCheck.controlsFound &&
        themeSwitchCheck.themeSwitched &&
        themeSwitchCheck.modeSwitched &&
        themeSwitchCheck.semanticTokensChanged &&
        themeSwitchCheck.restored &&
        lifecycleChurnCheck.completedCycles === lifecycleChurnCheck.requestedCycles &&
        lifecycleChurnCheck.finalPanelPresent &&
        (lifecycleChurnCheck.requestedCycles === 0 ||
          (lifecycleChurnCheck.rendererMetrics.delta !== null &&
            lifecycleChurnCheck.rendererMetrics.delta.documents <= 1 &&
            lifecycleChurnCheck.rendererMetrics.delta.nodes <= 500 &&
            lifecycleChurnCheck.rendererMetrics.delta.jsEventListeners <= 50 &&
            lifecycleChurnCheck.rendererMetrics.delta.usedHeapBytes <= 64 * 1024 * 1024)) &&
        assetLibraryCheck.panelFound &&
        assetLibraryCheck.categoryCreated &&
        assetLibraryCheck.categoryDeleted &&
        assetLibraryCheck.categoryRestored &&
        assetLibraryCheck.deletionHistoryVisible &&
        assetLibraryCheck.mergedNavigation &&
        assetLibraryCheck.similarEntryVisible &&
        assetLibraryCheck.categoryClusterEntryVisible &&
        assetLibraryCheck.tagCreated &&
        assetLibraryCheck.sampleSearchVisible &&
        assetLibraryCheck.returnedToAssets &&
        assetLibraryCheck.smartAlbumCrud &&
        assetLibraryCheck.collectionCrud &&
        assetLibraryCheck.shiftRangeSelection !== false &&
        (!runtimeCheck.packagedProvenance.required ||
          runtimeCheck.packagedProvenance.distributionProfile === 'online' ||
          (runtimeCheck.models.dino && runtimeCheck.models.clip)) &&
        runtimeCheck.native.connected &&
        (!runtimeCheck.packagedProvenance.required ||
          (runtimeCheck.packagedProvenance.distributionProfile === 'online'
            ? !runtimeCheck.packagedProvenance.modelsUnderResources &&
              runtimeCheck.packagedProvenance.nativeUnderResources &&
              !runtimeCheck.packagedProvenance.ffmpegUnderResources &&
              !runtimeCheck.packagedProvenance.ffprobeUnderResources
            : runtimeCheck.mediaTools.ffmpeg &&
              runtimeCheck.mediaTools.ffprobe &&
              runtimeCheck.packagedProvenance.modelsUnderResources &&
              runtimeCheck.packagedProvenance.userCandidateModelsAbsent &&
              runtimeCheck.packagedProvenance.nativeUnderResources &&
              runtimeCheck.packagedProvenance.ffmpegUnderResources &&
              runtimeCheck.packagedProvenance.ffprobeUnderResources)) &&
        (!runtimeCheck.thumbnailGpu.attempted || runtimeCheck.thumbnailGpu.completed) &&
        runtimeCheck.backup.created &&
        runtimeCheck.backup.listed &&
        runtimeCheck.backup.verified &&
        runtimeCheck.backup.restored &&
        runtimeCheck.backup.preRestoreCreated &&
        runtimeCheck.backup.categoryIntact &&
        visibilityCycleCheck.completedCycles === visibilityCycleCheck.requestedCycles &&
        visibilityCycleCheck.panelsReadyOnShow &&
        visibilityCycleCheck.interactionCancelledOnHide &&
        visibilityCycleCheck.p95ShowLatencyMs <= 120 &&
        visibilityCycleCheck.p99ShowLatencyMs <= 200 &&
        visibilityCycleCheck.visibleFrameCadence.fps >= 30 &&
        (visibilityCycleCheck.requestedCycles <= 3 ||
          (visibilityCycleCheck.rendererMetrics.delta !== null &&
            visibilityCycleCheck.rendererMetrics.delta.documents <= 1 &&
            visibilityCycleCheck.rendererMetrics.delta.nodes <= 500 &&
            visibilityCycleCheck.rendererMetrics.delta.jsEventListeners <= 50 &&
            visibilityCycleCheck.rendererMetrics.delta.usedHeapBytes <= 64 * 1024 * 1024)) &&
        visibilityCycleCheck.generations.every(
          (generation, index, generations) => index === 0 || generation > generations[index - 1],
        ) &&
        consoleErrors.length === 0 &&
        Math.abs(snapshot.devicePixelRatio - options.expectedScale) < 0.05 &&
        (!options.expectedViewport ||
          (Math.abs(snapshot.viewport.width - options.expectedViewport.width) <= 4 &&
            Math.abs(snapshot.viewport.height - options.expectedViewport.height) <= 4)) &&
        (!options.expectedPixelSize ||
          (Math.abs((screenshotSize?.width || 0) - options.expectedPixelSize.width) <= 4 &&
            Math.abs((screenshotSize?.height || 0) - options.expectedPixelSize.height) <= 4)) &&
        workAreaMatches &&
        (!options.screenshotPath ||
          (screenshotSize?.width && screenshotSize.height && nonTransparentPixelSamples > 100)),
      )
      writeJsonAtomic(
        options.reportPath,
        redactUiSmokeReportValue({
          ok,
          startedAt,
          completedAt: Date.now(),
          processVersions: process.versions,
          elapsedMs: Date.now() - startedAt,
          expectedLocale: options.expectedLocale,
          expectedPixelSize: options.expectedPixelSize,
          expectedScale: options.expectedScale,
          expectedViewport: options.expectedViewport,
          expectedWorkArea: options.expectedWorkArea,
          windowBounds,
          workAreaMatches,
          fileFixtureCheck,
          requiredPanels: REQUIRED_PANEL_IDS,
          missingPanels,
          consoleErrors,
          failure,
          screenshotPath: options.screenshotPath
            ? path.basename(options.screenshotPath)
            : undefined,
          modelScreenshotPath: modelScreenshotPath ? path.basename(modelScreenshotPath) : null,
          licenseScreenshotPath: licenseScreenshotPath
            ? path.basename(licenseScreenshotPath)
            : null,
          screenshotSize,
          nonTransparentPixelSamples,
          visibilityCycleCheck,
          runtimeCheck,
          snapshot,
        }),
      )
      // app.exit() bypasses will-quit, so the image-search shutdown handshake
      // in main.ts never runs in smoke mode. Run the same idempotent
      // handshake (cancelAsyncWork, stop scan/rebuild, bounded persistence
      // drain) before exiting; both functions degrade safely when idle or
      // when the native addon was never loaded.
      void Promise.all([shutdownImageSearchForQuit(), shutdownImageSearchDataCatalogForQuit()])
        .catch((error) => {
          console.warn('[UiSmoke] Image-search shutdown handshake failed:', error)
        })
        .finally(() => app.exit(ok ? 0 : 1))
    })()
  })
}
