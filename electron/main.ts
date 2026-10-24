import { app, BrowserWindow, dialog, globalShortcut, powerMonitor, screen, session } from 'electron'
import { EndUserTermsController } from './endUserTermsWindow'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initImageSearchService, shutdownImageSearchForQuit } from './imageSearchService'
import { shutdownImageSearchDataCatalogForQuit } from './imageSearchDataCatalogService'
import { initAppStorageService } from './appStorageService'
import { loadProfiles } from './remoteTerminalService'
import { registerBatchRenameIpc } from './batchRenameIpc'
import { registerSubjectSearchIpc } from './subjectSearchIpc'
import { registerSamSegmentIpc } from './samSegmentIpc'
import { disposeFileManagerWatchers, registerFileManagerIpc } from './fileManagerIpc'
import { registerImageSearchIpc } from './imageSearchIpc'
import { registerDuplicateFinderIpc } from './duplicateFinderIpc'
import { registerMediaSearchCoreIpc } from './mediaSearchIpc'
import { registerDiscoveryCatalogIpc } from './discoveryCatalogIpc'
import { registerAssetIdentityIpc } from './assetIdentityIpc'
import { getAssetIdentityService } from './assetIdentityService'
import { initSourceCatalogService, shutdownSourceCatalogService } from './sourceCatalogService'
import {
  getUnifiedTaskScheduler,
  initUnifiedSearchRuntime,
  setUnifiedResourcePowerState,
  shutdownUnifiedResourceGovernor,
} from './unifiedSearchRuntime'
import { registerUnifiedSearchIpc } from './unifiedSearchIpc'
import { registerProductHealthIpc } from './productHealthIpc'
import { registerAssetLibraryIpc } from './assetLibraryIpc'
import { registerVectorIpc, shutdownAutomaticMaintenance } from './vectorIpc'
import { shutdownSourceFileSync } from './sourceFileSyncService'
import { shutdownVectorGc } from './vectorGcService'
import { registerRemoteTerminalProfileIpc } from './remoteTerminalProfileIpc'
import { registerRemoteTerminalSftpIpc } from './remoteTerminalSftpIpc'
import { registerRemoteTerminalTransferIpc } from './remoteTerminalTransferIpc'
import { disposeRemoteTransfers } from './remoteTransferService'
import {
  registerAppCoreIpc,
  registerGlobalHotkeys,
  revealGlobalWindow,
  setGlobalWindowVisibility,
  flushWindowVisibilityDiagnostics,
  recoverGlobalWindowTopology,
  suspendGlobalWindowVisibility,
  resumeGlobalWindowVisibility,
} from './appCoreIpc'
import { registerThumbnailIpc } from './thumbnailIpc'
import {
  scheduleThumbCacheMaintenance,
  type ThumbCacheMaintenanceHandle,
} from './thumbnailDiskCache'
import { registerFileDragIpc } from './fileDragIpc'
import { authorizeIpcWebContents, createRendererFrameUrlTrust } from './ipcAuthorization'
import { configureUiSmoke } from './uiSmokeService'
import { warmFfmpegStatusCache } from './ffmpegService'
import { disposeVectorAnnWorker } from './vectorAnnWorkerHost'
import {
  configureAnnPrewarmRuntimePolicy,
  scheduleAuthoritativeAnnPrewarm,
} from './annPrewarmService'
import { getEmbeddingProgress } from './embeddingService'
import { disposeSemanticVectorSearchWorker } from './semanticVectorSearchWorkerHost'
import { disposeSemanticSearchModels } from './semanticSearchService'
import { disposeMultilingualTextEncoder } from './multilingualTextEncoder'
import { disposeUserModelRuntimeChild } from './userModelRuntimeHost'
import {
  approveAiControlConfirmationForSmoke,
  enableAiControlForSmoke,
  getAiControlSettingsSnapshot,
  initAiControlApi,
  registerAiControlIpc,
  rotateAiControlForSmoke,
  shutdownAiControlApi,
} from './aiControlApi'
import { buildWorkspaceTopology, normalizeDisplayScope } from './workspaceDisplay'
import { standardWindowBounds } from './standardWindowGeometry'
import {
  PRODUCT_DISPLAY_NAME,
  PRODUCT_NAME,
  getAllowedDevServerUrl,
  hardenMainSession,
  normalizeWindowsPathEnvironment,
  resolveStableUserDataPath,
  validateStartupSecurity,
} from './startupSecurity'
import type { DisplayScope, WorkspaceTopology, WorkspaceWorkArea } from '../shared/ipc-contract'
import { DISCOVERY_CATALOG_IPC } from '../shared/ipc-contract'

import { initMediaToolConfig } from './mediaToolConfigService'
import { initAssetLibraryService } from './assetLibraryService'
import { closeControlledMediaPlayers } from './mediaPlayerService'
import { registerMediaPlayerExportIpc } from './mediaPlayerExportService'
import { hardenDataDirectoryPermissions } from './dataDirectorySecurity'
import { redactDiagnosticText } from './diagnosticRedaction'
import {
  configureRuntimeMemoryTraceFromEnvironment,
  emitRuntimeMemoryTrace,
  runtimeMemoryRootRunId,
} from './runtimeMemoryTrace'

configureRuntimeMemoryTraceFromEnvironment()
const startupMemoryTraceRunId = runtimeMemoryRootRunId()
let startupMemoryTraceFinished = false
if (startupMemoryTraceRunId) {
  emitRuntimeMemoryTrace({
    runId: startupMemoryTraceRunId,
    stage: 'startup',
    phase: 'start',
    model: 'app',
    provider: 'electron',
  })
}

const uiSmokeReportPath = process.env.FLOATING_CLOCK_UI_SMOKE_REPORT?.trim()
const uiSmokeLocale = process.env.FLOATING_CLOCK_UI_SMOKE_LOCALE === 'en' ? 'en' : 'zh-CN'
const uiSmokeMode = Boolean(uiSmokeReportPath)
const aiControlSmokeReportPath = process.env.FLOATING_CLOCK_AI_CONTROL_SMOKE_REPORT?.trim()
const aiControlSmokeSemanticQuery =
  process.env.FLOATING_CLOCK_AI_CONTROL_SMOKE_SEMANTIC_QUERY?.trim()
const startupSecurity = validateStartupSecurity({
  argv: process.argv,
  env: process.env,
  noSandboxSwitchPresent: app.commandLine.hasSwitch('no-sandbox'),
  disableSandboxSwitchPresent: app.commandLine.hasSwitch('disable-sandbox'),
})
app.setName(PRODUCT_NAME)
if (startupSecurity.smokeUserDataPath) {
  app.setPath('userData', startupSecurity.smokeUserDataPath)
} else {
  app.setPath('userData', resolveStableUserDataPath(app.getPath('appData')))
}

if (process.platform === 'win32' && normalizeWindowsPathEnvironment(process.env)) {
  console.warn('[Siftory] normalized duplicate PATH environment variables')
}

type VideoDiagnosticMode =
  | 'baseline'
  | 'compact'
  | 'direct-composition'
  | 'no-shape'
  | 'no-topmost'
  | 'software'

const requestedVideoMode = process.env.FLOATING_CLOCK_VIDEO_MODE
const videoDiagnosticMode: VideoDiagnosticMode =
  requestedVideoMode === 'compact' ||
  requestedVideoMode === 'direct-composition' ||
  requestedVideoMode === 'no-shape' ||
  requestedVideoMode === 'no-topmost' ||
  requestedVideoMode === 'software'
    ? requestedVideoMode
    : 'baseline'

// Diagnostic modes isolate one compositor variable at a time. Baseline keeps
// the established workaround so normal launches retain current behavior.
if (videoDiagnosticMode !== 'direct-composition') {
  app.commandLine.appendSwitch('disable-direct-composition')
}
if (videoDiagnosticMode === 'software') {
  app.disableHardwareAcceleration()
}
console.log(`[Siftory] video compositor mode: ${videoDiagnosticMode}`)

let mainWindow: BrowserWindow | null = null
let termsController: EndUserTermsController | undefined
let applicationStarting = true
let applicationServicesStarted = false
let thumbCacheMaintenance: ThumbCacheMaintenanceHandle | null = null
let displayScope: DisplayScope = { mode: 'primary' }
let workspaceTopology: WorkspaceTopology = {
  scope: displayScope,
  primaryDisplayId: '',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1080, displays: [] },
  displays: [],
}
let workArea: WorkspaceWorkArea = workspaceTopology.workArea
let appCoreOptions: Parameters<typeof registerAppCoreIpc>[0] | null = null
let windowAlwaysOnTop = false

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function runAiControlSmoke(reportPath: string): Promise<void> {
  const before = getAiControlSettingsSnapshot()
  const enabled = await enableAiControlForSmoke()
  const address = enabled.settings.address
  const token = enabled.token ?? ''
  const unauthorized = await fetch(`${address}/capabilities`)
  const headers = { Authorization: `Bearer ${token}` }
  const capabilitiesResponse = await fetch(`${address}/capabilities`, { headers })
  const capabilities = (await capabilitiesResponse.json()) as { capabilities?: unknown[] }
  const openApiResponse = await fetch(`${address}/openapi.json`, { headers })
  const openApi = (await openApiResponse.json()) as {
    openapi?: string
    paths?: Record<string, unknown>
  }
  const confirmationKey = `confirmation-${Date.now()}`
  const confirmationResponse = await fetch(`${address}/actions/window.show`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'Idempotency-Key': confirmationKey,
    },
    body: '{}',
  })
  const confirmationPayload = (await confirmationResponse.json()) as {
    confirmation?: { id?: string }
  }
  const predictableConfirmationResponse = await fetch(`${address}/actions/window.show`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'Idempotency-Key': confirmationKey,
      'X-Reasonix-Confirm': 'window.show',
    },
    body: '{}',
  })
  const confirmationApproved = confirmationPayload.confirmation?.id
    ? approveAiControlConfirmationForSmoke(confirmationPayload.confirmation.id)
    : false
  const confirmedWriteResponse = await fetch(`${address}/actions/window.show`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'Idempotency-Key': confirmationKey,
      'X-Reasonix-Confirm': confirmationPayload.confirmation?.id ?? '',
    },
    body: '{}',
  })
  const confirmedWrite = (await confirmedWriteResponse.json()) as { jobId?: string }
  const idempotentReplayResponse = await fetch(`${address}/actions/window.show`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'Idempotency-Key': confirmationKey,
    },
    body: '{}',
  })
  const idempotentReplay = (await idempotentReplayResponse.json()) as {
    jobId?: string
    replayed?: boolean
  }
  let confirmedWriteJob: { state?: string } = {}
  for (let attempt = 0; attempt < 50 && confirmedWrite.jobId; attempt += 1) {
    const response = await fetch(`${address}/jobs/${confirmedWrite.jobId}`, { headers })
    confirmedWriteJob = (await response.json()) as { state?: string }
    if (confirmedWriteJob.state === 'succeeded' || confirmedWriteJob.state === 'failed') break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const conflictKey = `conflict-${Date.now()}`
  const conflictPreviewResponse = await fetch(`${address}/actions/window.selectDisplay`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'Idempotency-Key': conflictKey,
    },
    body: JSON.stringify({ mode: 'all' }),
  })
  const conflictPreview = (await conflictPreviewResponse.json()) as {
    confirmation?: { id?: string }
  }
  const conflictApproved = conflictPreview.confirmation?.id
    ? approveAiControlConfirmationForSmoke(conflictPreview.confirmation.id)
    : false
  const conflictAcceptedResponse = await fetch(`${address}/actions/window.selectDisplay`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'Idempotency-Key': conflictKey,
      'X-Reasonix-Confirm': conflictPreview.confirmation?.id ?? '',
    },
    body: JSON.stringify({ mode: 'all' }),
  })
  const idempotencyConflictResponse = await fetch(`${address}/actions/window.selectDisplay`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'Idempotency-Key': conflictKey,
    },
    body: JSON.stringify({ mode: 'primary' }),
  })
  const actionResponse = await fetch(`${address}/actions/system.version`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'Idempotency-Key': `smoke-${Date.now()}`,
    },
    body: '{}',
  })
  const action = (await actionResponse.json()) as { jobId?: string }
  let job: { state?: string } = {}
  for (let attempt = 0; attempt < 50 && action.jobId; attempt += 1) {
    const response = await fetch(`${address}/jobs/${action.jobId}`, { headers })
    job = (await response.json()) as { state?: string }
    if (job.state === 'succeeded' || job.state === 'failed') break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  let semanticImageJob: {
    state?: string
    result?: {
      totalCandidates?: number
      returnedCount?: number
      degradationReasons?: unknown[]
      results?: unknown[]
    }
  } = {}
  let semanticImageActionStatus: number | undefined
  if (aiControlSmokeSemanticQuery) {
    const semanticResponse = await fetch(`${address}/actions/imageSearch.search`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: aiControlSmokeSemanticQuery, topK: 5 }),
    })
    semanticImageActionStatus = semanticResponse.status
    const semanticAction = (await semanticResponse.json()) as { jobId?: string }
    for (let attempt = 0; attempt < 600 && semanticAction.jobId; attempt += 1) {
      const response = await fetch(`${address}/jobs/${semanticAction.jobId}`, { headers })
      semanticImageJob = (await response.json()) as typeof semanticImageJob
      if (
        semanticImageJob.state === 'succeeded' ||
        semanticImageJob.state === 'failed' ||
        semanticImageJob.state === 'cancelled'
      ) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  const scoped = await rotateAiControlForSmoke(['read', 'search'])
  const scopedToken = scoped.token ?? ''
  const scopedHeaders = { Authorization: `Bearer ${scopedToken}` }
  await new Promise((resolve) => setTimeout(resolve, 100))
  const oldTokenAfterRotation = await fetch(`${address}/capabilities`, { headers })
  const scopedCapabilitiesResponse = await fetch(`${address}/capabilities`, {
    headers: scopedHeaders,
  })
  const scopedCapabilities = (await scopedCapabilitiesResponse.json()) as {
    capabilities?: Array<{ id?: string }>
  }
  const oldJobAfterRotation = confirmedWrite.jobId
    ? await fetch(`${address}/jobs/${confirmedWrite.jobId}`, { headers: scopedHeaders })
    : null
  const scopeDeniedResponse = await fetch(`${address}/actions/window.show`, {
    method: 'POST',
    headers: {
      ...scopedHeaders,
      'Content-Type': 'application/json',
      'Idempotency-Key': `scope-${Date.now()}`,
      'X-Reasonix-Confirm': 'window.show',
    },
    body: '{}',
  })
  const report = {
    ok:
      before.enabled === false &&
      before.running === false &&
      enabled.ok &&
      unauthorized.status === 401 &&
      capabilitiesResponse.status === 200 &&
      Array.isArray(capabilities.capabilities) &&
      capabilities.capabilities.length > 0 &&
      openApiResponse.status === 200 &&
      openApi.openapi === '3.1.0' &&
      Boolean(openApi.paths?.['/v1/actions/imageSearch.search']) &&
      Boolean(openApi.paths?.['/v1/actions/storage.largeFiles']) &&
      Boolean(openApi.paths?.['/v1/actions/folder.largeFiles']) &&
      confirmationResponse.status === 428 &&
      predictableConfirmationResponse.status === 403 &&
      confirmationApproved &&
      confirmedWriteResponse.status === 202 &&
      idempotentReplayResponse.status === 202 &&
      idempotentReplay.replayed === true &&
      idempotentReplay.jobId === confirmedWrite.jobId &&
      conflictPreviewResponse.status === 428 &&
      conflictApproved &&
      conflictAcceptedResponse.status === 202 &&
      idempotencyConflictResponse.status === 409 &&
      confirmedWriteJob.state === 'succeeded' &&
      actionResponse.status === 202 &&
      job.state === 'succeeded' &&
      (!aiControlSmokeSemanticQuery ||
        (semanticImageActionStatus === 202 &&
          semanticImageJob.state === 'succeeded' &&
          Number(semanticImageJob.result?.totalCandidates ?? 0) > 0 &&
          Number(semanticImageJob.result?.returnedCount ?? 0) > 0 &&
          !JSON.stringify(semanticImageJob.result).includes('D:\\\\'))) &&
      scoped.ok &&
      oldTokenAfterRotation.status === 401 &&
      oldJobAfterRotation?.status === 404 &&
      scopedCapabilitiesResponse.status === 200 &&
      !scopedCapabilities.capabilities?.some((capability) => capability.id === 'window.show') &&
      scopeDeniedResponse.status === 403,
    before,
    enabled: enabled.settings,
    unauthorizedStatus: unauthorized.status,
    capabilityCount: capabilities.capabilities?.length ?? 0,
    openApiStatus: openApiResponse.status,
    openApiVersion: openApi.openapi,
    semanticImageSearchDocumented: Boolean(openApi.paths?.['/v1/actions/imageSearch.search']),
    folderStatsDocumented: Boolean(openApi.paths?.['/v1/actions/folder.stats']),
    directLargeFilesDocumented: Boolean(openApi.paths?.['/v1/actions/storage.largeFiles']),
    largeFilesDocumented: Boolean(openApi.paths?.['/v1/actions/folder.largeFiles']),
    confirmationStatus: confirmationResponse.status,
    predictableConfirmationStatus: predictableConfirmationResponse.status,
    confirmationApproved,
    confirmedWriteStatus: confirmedWriteResponse.status,
    idempotentReplayStatus: idempotentReplayResponse.status,
    idempotentReplayMatched:
      idempotentReplay.replayed === true && idempotentReplay.jobId === confirmedWrite.jobId,
    idempotencyConflictStatus: idempotencyConflictResponse.status,
    confirmedWriteJobState: confirmedWriteJob.state,
    actionStatus: actionResponse.status,
    jobState: job.state,
    ...(aiControlSmokeSemanticQuery && {
      semanticImageActionStatus,
      semanticImageJobState: semanticImageJob.state,
      semanticImageTotalCandidates: semanticImageJob.result?.totalCandidates,
      semanticImageReturnedCount: semanticImageJob.result?.returnedCount,
      semanticImageDegradationReasons: semanticImageJob.result?.degradationReasons,
      semanticImageResultContainsLocalPath: JSON.stringify(semanticImageJob.result).includes(
        'D:\\\\',
      ),
    }),
    rotatedTokenScopes: scoped.settings.tokenScopes,
    oldTokenAfterRotationStatus: oldTokenAfterRotation.status,
    oldJobAfterRotationStatus: oldJobAfterRotation?.status,
    scopedCapabilityCount: scopedCapabilities.capabilities?.length ?? 0,
    scopedWindowCapabilityVisible:
      scopedCapabilities.capabilities?.some((capability) => capability.id === 'window.show') ??
      false,
    scopeDeniedStatus: scopeDeniedResponse.status,
  }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
}

function readWorkspaceTopology(): WorkspaceTopology {
  return buildWorkspaceTopology(
    screen.getAllDisplays(),
    screen.getPrimaryDisplay().id,
    !uiSmokeMode && displayScope.mode === 'all' ? { mode: 'primary' } : displayScope,
  )
}

function installWorkspaceTopology(notifyRenderer: boolean): WorkspaceTopology {
  if (!uiSmokeMode) workspaceTopology = readWorkspaceTopology()
  displayScope = workspaceTopology.scope
  workArea = workspaceTopology.workArea
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (uiSmokeMode) {
      mainWindow.setBounds(workspaceTopology.bounds, false)
    } else if (!mainWindow.isMaximized()) {
      const current = mainWindow.getBounds()
      const display = screen.getDisplayMatching(current)
      mainWindow.setBounds(standardWindowBounds(display.workArea, current), false)
    }
    if (notifyRenderer) mainWindow.webContents.send('work-area-changed', clientWorkArea())
  }
  return workspaceTopology
}

function applyWorkspaceTopology(notifyRenderer: boolean): WorkspaceTopology {
  if (appCoreOptions) {
    recoverGlobalWindowTopology(appCoreOptions, () => installWorkspaceTopology(notifyRenderer))
  } else {
    installWorkspaceTopology(notifyRenderer)
  }
  return workspaceTopology
}

function setDisplayScope(scope: DisplayScope): WorkspaceTopology {
  displayScope = normalizeDisplayScope(scope)
  if (!uiSmokeMode) {
    if (displayScope.mode === 'all') displayScope = { mode: 'primary' }
    workspaceTopology = readWorkspaceTopology()
    workArea = workspaceTopology.workArea
    if (mainWindow && !mainWindow.isDestroyed()) {
      const current = mainWindow.getBounds()
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      mainWindow.setBounds(
        standardWindowBounds(workArea, {
          ...current,
          x: workArea.x + (workArea.width - current.width) / 2,
          y: workArea.y + (workArea.height - current.height) / 2,
        }),
        false,
      )
      mainWindow.webContents.send('work-area-changed', clientWorkArea())
    }
    return workspaceTopology
  }
  return applyWorkspaceTopology(true)
}

function clientWorkArea(): WorkspaceWorkArea {
  if (uiSmokeMode || !mainWindow || mainWindow.isDestroyed()) return workArea
  const { width, height } = mainWindow.getContentBounds()
  return { x: 0, y: 0, width, height, displays: [] }
}

/**
 * Reaffirm always-on-top after show / showInactive.
 * On Windows, the topmost flag can be lost when the window is hidden
 * and shown again, or when another window grabs foreground.  Calling
 * Use the screen-saver level because the app is an overlay workspace. Some
 * normal topmost windows can cover the regular floating level on Windows.
 */
function ensureWindowOnTop() {
  if (!windowAlwaysOnTop) return
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(true, 'screen-saver')
    mainWindow.moveTop()
  }
}

function setWindowAlwaysOnTop(value: boolean): boolean {
  windowAlwaysOnTop = !uiSmokeMode && videoDiagnosticMode !== 'no-topmost' && value
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(windowAlwaysOnTop, windowAlwaysOnTop ? 'screen-saver' : 'normal')
    if (windowAlwaysOnTop) mainWindow.moveTop()
  }
  return windowAlwaysOnTop
}

function loadDevServerUrlWithRetry(window: BrowserWindow, devServerUrl: string): void {
  let retryCount = 0
  let retryTimer: NodeJS.Timeout | null = null
  const maxRetries = 40

  const clearRetryTimer = () => {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  const scheduleRetry = (reason: string) => {
    if (window.isDestroyed() || retryCount >= maxRetries) return
    if (retryTimer) return
    const delayMs = Math.min(250 + retryCount * 250, 2000)
    retryCount += 1
    console.warn(
      `[Siftory] Dev server not ready (${reason}); retry ${retryCount}/${maxRetries} in ${delayMs}ms`,
    )
    clearRetryTimer()
    retryTimer = setTimeout(() => {
      retryTimer = null
      void load()
    }, delayMs)
  }

  const load = async () => {
    if (window.isDestroyed()) return
    try {
      await window.loadURL(devServerUrl)
    } catch (error) {
      scheduleRetry(errorMessage(error))
    }
  }

  window.webContents.once('did-finish-load', () => {
    clearRetryTimer()
    if (startupMemoryTraceRunId && !startupMemoryTraceFinished) {
      startupMemoryTraceFinished = true
      emitRuntimeMemoryTrace({
        runId: startupMemoryTraceRunId,
        stage: 'startup',
        phase: 'finish',
        model: 'app',
        provider: 'electron',
      })
    }
    if (process.env.FLOATING_CLOCK_OPEN_DEVTOOLS === '1') {
      window.webContents.openDevTools({ mode: 'detach' })
    }
  })

  window.on('closed', clearRetryTimer)
  void load()
}

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay()
  const smokeViewportMatch = process.env.FLOATING_CLOCK_UI_SMOKE_VIEWPORT?.match(/^(\d+)x(\d+)$/)
  const smokeScale = Number(process.env.FLOATING_CLOCK_UI_SMOKE_SCALE) || 1
  const smokeWorkAreaMatch = process.env.FLOATING_CLOCK_UI_SMOKE_WORK_AREA?.match(
    /^(-?\d+),(-?\d+),(\d+),(\d+)$/,
  )
  const smokeWorkArea = smokeWorkAreaMatch
    ? {
        x: Number(smokeWorkAreaMatch[1]),
        y: Number(smokeWorkAreaMatch[2]),
        width: Number(smokeWorkAreaMatch[3]),
        height: Number(smokeWorkAreaMatch[4]),
      }
    : undefined
  const smokePixelSize = smokeViewportMatch
    ? {
        width: Number(smokeViewportMatch[1]),
        height: Number(smokeViewportMatch[2]),
      }
    : undefined
  const smokeCssViewport = smokePixelSize
    ? {
        width: Math.round(smokePixelSize.width / smokeScale),
        height: Math.round(smokePixelSize.height / smokeScale),
      }
    : undefined
  const smokeArea =
    smokeWorkArea ??
    (smokeCssViewport
      ? { x: 0, y: 0, width: smokeCssViewport.width, height: smokeCssViewport.height }
      : undefined)
  if (uiSmokeMode && smokeArea) {
    const displayId = String(primaryDisplay.id)
    const display = {
      id: displayId,
      bounds: smokeArea,
      workArea: smokeArea,
      scaleFactor: smokeScale,
      rotation: 0,
      internal: false,
      primary: true,
    }
    workspaceTopology = {
      scope: { mode: 'all' },
      primaryDisplayId: displayId,
      bounds: smokeArea,
      workArea: {
        ...smokeArea,
        displays: [
          {
            ...display,
            localWorkArea: { x: 0, y: 0, width: smokeArea.width, height: smokeArea.height },
          },
        ],
      },
      displays: [display],
    }
  } else {
    workspaceTopology = readWorkspaceTopology()
  }
  workArea = workspaceTopology.workArea
  const { x, y, width, height } = uiSmokeMode ? workArea : standardWindowBounds(workArea)
  const windowIconPath = path.join(app.getAppPath(), 'build', 'icon.ico')

  // Packaged builds never load renderer code from an environment-controlled URL.
  // Resolved before window creation so the IPC origin trust below can pin the
  // exact renderer origin (VAL-029).
  const devServerUrl = getAllowedDevServerUrl(app.isPackaged, process.env.VITE_DEV_SERVER_URL)
  mainWindow = new BrowserWindow({
    title: `${PRODUCT_DISPLAY_NAME} · v${app.getVersion()}`,
    x,
    y,
    width,
    height,
    minWidth: uiSmokeMode ? width : Math.min(960, width),
    minHeight: uiSmokeMode ? height : Math.min(640, height),
    useContentSize: uiSmokeMode,
    transparent: uiSmokeMode,
    frame: !uiSmokeMode,
    alwaysOnTop: windowAlwaysOnTop,
    show: !uiSmokeMode,
    paintWhenInitiallyHidden: true,
    skipTaskbar: uiSmokeMode,
    // Legacy overlay diagnostics retain panel-owned geometry. The normal app
    // uses the system title bar, resize borders, and taskbar presence.
    resizable: !uiSmokeMode,
    movable: !uiSmokeMode,
    maximizable: !uiSmokeMode,
    fullscreenable: !uiSmokeMode,
    thickFrame: !uiSmokeMode,
    hasShadow: !uiSmokeMode,
    backgroundColor: uiSmokeMode ? '#00000000' : '#f5f7fb',
    icon: fs.existsSync(windowIconPath) ? windowIconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  authorizeIpcWebContents(
    mainWindow.webContents,
    createRendererFrameUrlTrust({ appPath: app.getAppPath(), devServerUrl }),
  )

  if (uiSmokeReportPath) {
    const requestedChurnCycles = Number(process.env.FLOATING_CLOCK_UI_SMOKE_CHURN_CYCLES) || 0
    const requestedVisibilityCycles =
      Number(process.env.FLOATING_CLOCK_UI_SMOKE_VISIBILITY_CYCLES) || 0
    configureUiSmoke(mainWindow, {
      expectedLocale: uiSmokeLocale,
      expectedPixelSize: smokePixelSize,
      expectedScale: smokeScale,
      expectedViewport: smokeCssViewport,
      expectedWorkArea: smokeWorkArea,
      reportPath: path.resolve(uiSmokeReportPath),
      screenshotPath: process.env.FLOATING_CLOCK_UI_SMOKE_SCREENSHOT?.trim(),
      getWorkArea: () => workArea,
      churnCycles: Math.max(0, Math.min(600, Math.trunc(requestedChurnCycles))),
      visibilityCycles: Math.max(0, Math.min(500, Math.trunc(requestedVisibilityCycles))),
      setWindowVisibility: (visible) =>
        appCoreOptions ? setGlobalWindowVisibility(appCoreOptions, visible, 'recovery') : false,
    })
  }

  // This application has no browser surface. Keep untrusted navigation away from
  // the renderer because the preload bridge intentionally exposes privileged APIs.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const currentUrl = mainWindow?.webContents.getURL()
    if (!currentUrl) return
    try {
      const target = new URL(targetUrl)
      const current = new URL(currentUrl)
      const allowed =
        current.protocol === 'file:'
          ? target.href === current.href
          : target.protocol === current.protocol && target.origin === current.origin
      if (allowed) return
    } catch {
      // Invalid or non-standard targets are never valid top-level navigation here.
    }
    event.preventDefault()
  })

  // Packaged builds never load renderer code from an environment-controlled URL.
  if (devServerUrl) {
    const rendererUrl = new URL(devServerUrl)
    if (uiSmokeMode) rendererUrl.searchParams.set('legacyOverlay', '1')
    loadDevServerUrlWithRetry(mainWindow, rendererUrl.href)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'), {
      query: uiSmokeMode ? { legacyOverlay: '1' } : {},
    })
  }

  mainWindow.setIgnoreMouseEvents(uiSmokeMode, { forward: true })
  if (!uiSmokeMode) {
    mainWindow.setMenuBarVisibility(false)
    mainWindow.on('resize', () => {
      mainWindow?.webContents.send('work-area-changed', clientWorkArea())
    })
  }

  ensureWindowOnTop()

  mainWindow.on('focus', ensureWindowOnTop)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (termsController?.focus()) return
    if (appCoreOptions && revealGlobalWindow(appCoreOptions)) return
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.showInactive()
      ensureWindowOnTop()
    }
  })

  void app.whenReady().then(async () => {
    const dataDirectorySecurity = await hardenDataDirectoryPermissions(app.getPath('userData'), {
      enabled: app.isPackaged && !uiSmokeMode && !aiControlSmokeReportPath,
    })
    if (!dataDirectorySecurity.applied && dataDirectorySecurity.reason === 'failed') {
      console.warn(
        `[Security] Application data permission hardening failed: ${redactDiagnosticText(dataDirectorySecurity.error)}`,
      )
    }
    // Apply permissions before the agreement window or any application renderer loads.
    hardenMainSession(session.defaultSession)
    termsController = new EndUserTermsController({
      resourcesRoot: app.isPackaged ? process.resourcesPath : app.getAppPath(),
      userDataPath: app.getPath('userData'),
      appPath: app.getAppPath(),
      devServerUrl:
        getAllowedDevServerUrl(app.isPackaged, process.env.VITE_DEV_SERVER_URL) ?? undefined,
      language: (uiSmokeMode ? uiSmokeLocale : app.getLocale()).startsWith('zh') ? 'zh-CN' : 'en',
    })
    termsController.register()
    try {
      if (!(await termsController.ensureAccepted())) {
        app.quit()
        return
      }
    } catch {
      dialog.showErrorBox(
        'Siftory',
        app.getLocale().startsWith('zh')
          ? '用户协议文件缺失或无效，请恢复应用文件后重试。'
          : 'The user agreement files are missing or invalid. Restore the application files and try again.',
      )
      app.quit()
      return
    }
    applicationServicesStarted = true
    initMediaToolConfig()
    void warmFfmpegStatusCache()
    // Init ImageSearch service with callback to push status to renderer
    initImageSearchService((status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('imageSearch:onStatusChanged', status)
      }
    }, app.getPath('userData'))
    initAppStorageService(app.getPath('userData'))
    initAssetLibraryService(app.getPath('userData'))
    appCoreOptions = {
      standardWindow: !uiSmokeMode,
      getMainWindow: () => mainWindow,
      getWorkArea: clientWorkArea,
      getDisplayTopology: () => workspaceTopology,
      setDisplayScope,
      ensureWindowOnTop,
      getWindowAlwaysOnTop: () => windowAlwaysOnTop,
      setWindowAlwaysOnTop,
      videoDiagnosticMode,
      userDataPath: app.getPath('userData'),
    }
    await initAiControlApi({
      userDataPath: app.getPath('userData'),
      getDisplayTopology: () => workspaceTopology,
      setDisplayScope,
      setWindowVisibility: (visible) =>
        appCoreOptions ? setGlobalWindowVisibility(appCoreOptions, visible, 'ai-control') : false,
    })
    if (aiControlSmokeReportPath) {
      const reportPath = path.resolve(aiControlSmokeReportPath)
      try {
        await runAiControlSmoke(reportPath)
      } catch (error) {
        fs.mkdirSync(path.dirname(reportPath), { recursive: true })
        fs.writeFileSync(
          reportPath,
          JSON.stringify({ ok: false, error: errorMessage(error) }, null, 2),
          'utf8',
        )
      } finally {
        app.quit()
      }
      return
    }
    registerAiControlIpc()
    registerImageSearchIpc(() => mainWindow, getUnifiedTaskScheduler())
    registerDuplicateFinderIpc(() => mainWindow)
    registerMediaSearchCoreIpc(() => mainWindow, getUnifiedTaskScheduler())
    registerMediaPlayerExportIpc()
    const profilesReady = loadProfiles(app.getPath('userData'))
    initSourceCatalogService(app.getPath('userData'), {
      taskScheduler: getUnifiedTaskScheduler(),
    }).onScanStatus((scanStatus) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(DISCOVERY_CATALOG_IPC.SCAN_STATUS_EVENT, scanStatus)
      }
    })
    registerDiscoveryCatalogIpc(app.getPath('userData'), profilesReady, getUnifiedTaskScheduler())
    // Phase 3 unified staged tasks & unified search.
    initUnifiedSearchRuntime(app.getPath('userData'))
    configureAnnPrewarmRuntimePolicy({
      preferredModelName: 'dinov2_vitb14',
      canStart: () => {
        const embeddingState = getEmbeddingProgress().state
        const schedulerStats = getUnifiedTaskScheduler().stats()
        return (
          os.freemem() >= 4 * 1024 ** 3 &&
          !['queued', 'running', 'paused', 'stopping'].includes(embeddingState) &&
          schedulerStats.lanes.gpu.running === 0 &&
          !schedulerStats.resource.pressureReasons.some((reason) =>
            ['memory', 'vram'].includes(reason),
          )
        )
      },
    })
    setUnifiedResourcePowerState(powerMonitor.isOnBatteryPower())
    powerMonitor.on('on-battery', () => setUnifiedResourcePowerState(true))
    powerMonitor.on('on-ac', () => setUnifiedResourcePowerState(false))
    powerMonitor.on('suspend', () => {
      if (appCoreOptions) suspendGlobalWindowVisibility(appCoreOptions)
      disposeVectorAnnWorker()
      disposeSemanticVectorSearchWorker()
    })
    powerMonitor.on('resume', () => {
      if (appCoreOptions) {
        resumeGlobalWindowVisibility(appCoreOptions, () => installWorkspaceTopology(true))
      }
      const resumePrewarm = setTimeout(
        () =>
          void scheduleAuthoritativeAnnPrewarm(
            path.join(app.getPath('userData'), 'vector-db', 'embedding-cache'),
          ),
        5_000,
      )
      resumePrewarm.unref?.()
    })
    registerUnifiedSearchIpc()
    registerProductHealthIpc(app.getPath('userData'))
    // Phase 2 stable asset identity: mapping lives next to the asset library.
    getAssetIdentityService(path.join(app.getPath('userData'), 'asset-library'))
    registerAssetIdentityIpc(app.getPath('userData'), getUnifiedTaskScheduler())
    registerAssetLibraryIpc(() => mainWindow)
    registerThumbnailIpc(app.getPath('userData'), getUnifiedTaskScheduler())
    registerFileDragIpc(
      () => mainWindow,
      fs.existsSync(path.join(app.getAppPath(), 'build', 'icon.ico'))
        ? path.join(app.getAppPath(), 'build', 'icon.ico')
        : undefined,
      app.getPath('userData'),
    )
    registerAppCoreIpc(appCoreOptions)
    // Register handlers before loading the renderer. Profile-dependent handlers
    // share the same asynchronous initialization barrier.
    registerRemoteTerminalProfileIpc(app.getPath('userData'), profilesReady)
    registerRemoteTerminalSftpIpc(app.getPath('userData'), profilesReady)
    registerRemoteTerminalTransferIpc(() => mainWindow, app.getPath('userData'), profilesReady)
    registerFileManagerIpc(() => mainWindow)
    registerBatchRenameIpc(() => mainWindow)
    registerSubjectSearchIpc(() => mainWindow)
    registerSamSegmentIpc(() => mainWindow)

    registerVectorIpc(() => mainWindow, app.getPath('userData'), getUnifiedTaskScheduler())
    // VAL-029: the main session grants no web permissions by default. Install
    // the deny-by-default handlers before any renderer content loads.
    createWindow()
    applicationStarting = false
    // A large cache can contain hundreds of thousands of files. Walking and
    // statting all of them during first paint creates visible disk and event-
    // loop contention, so maintenance starts later and is deduplicated daily.
    thumbCacheMaintenance = scheduleThumbCacheMaintenance(app.getPath('userData'))
    // VAL-031: warm the CURRENT authoritative generation's ANN index in the
    // background so the first similarity search skips the cold full build.
    // No-op without a live generation, never blocks startup, and real
    // searches always preempt the warm-up.
    void scheduleAuthoritativeAnnPrewarm(
      path.join(app.getPath('userData'), 'vector-db', 'embedding-cache'),
    )
    if (!uiSmokeMode) registerGlobalHotkeys(appCoreOptions)

    // 閳光偓閳光偓 Display metrics changed (resolution / monitor change) 閳光偓
    screen.on('display-metrics-changed', () => {
      applyWorkspaceTopology(true)
    })
    screen.on('display-added', () => applyWorkspaceTopology(true))
    screen.on('display-removed', () => applyWorkspaceTopology(true))

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (!applicationStarting && process.platform !== 'darwin') app.quit()
})

// will-quit is synchronous; prevent the first quit, run the async image-search
// shutdown handshake (cancelAsyncWork + stop scan + drain persistence), then
// quit again. The flag lets the second quit pass through to normal cleanup.
let imageSearchShutdownRequested = false
app.on('will-quit', (event) => {
  if (!applicationServicesStarted) return
  thumbCacheMaintenance?.cancel()
  thumbCacheMaintenance = null
  if (!imageSearchShutdownRequested) {
    imageSearchShutdownRequested = true
    event.preventDefault()
    void shutdownAutomaticMaintenance()
      .then(() => shutdownSourceFileSync())
      .then(() => shutdownVectorGc())
      .then(() =>
        Promise.all([
          shutdownImageSearchForQuit(),
          shutdownImageSearchDataCatalogForQuit(),
          shutdownAiControlApi(),
          disposeSemanticSearchModels(),
          disposeMultilingualTextEncoder(),
          flushWindowVisibilityDiagnostics(),
        ]),
      )
      .catch((error) => {
        console.warn('[ImageSearch] shutdown handshake failed:', error)
      })
      .finally(() => app.quit())
    return
  }
  closeControlledMediaPlayers()
  disposeVectorAnnWorker()
  disposeSemanticVectorSearchWorker()
  disposeUserModelRuntimeChild()
  shutdownSourceCatalogService()
  shutdownUnifiedResourceGovernor()
  disposeFileManagerWatchers()
  disposeRemoteTransfers()
  globalShortcut.unregisterAll()
})
