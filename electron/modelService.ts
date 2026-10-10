// ── Model Service ──────────────────────────────────────────
// Manages local vision model lifecycle: download, verify, load, unload.
// Development models live in the app-local ai-models directory. Packaged
// downloads live in userData/models, while Offline bundles are a read-only
// fallback under resources/ai-models.
// Source of truth for available models: models/manifest.json (shipped with app).

import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { ModelInfo, ModelRequiredFile, ModelStatus, ModelState } from '../shared/vectorTypes'
import {
  clearModelFileVerificationCacheUnder,
  downloadPinnedModelFile,
  getModelFilePath,
  getRequiredModelFiles,
  inspectModelStorageRoot,
  recoverModelFileTransactions,
  resetModelFileVerificationCache,
  verifyPinnedModelFileSync,
  type ModelRootState,
} from './modelServiceCompanions'

// ── Types ──────────────────────────────────────────────────

export type ModelStatusCallback = (status: ModelStatus) => void

interface DownloadState {
  modelName: string
  url: string
  destPath: string
  expectedSha256: string
  totalBytes: number
  bytesDownloaded: number
  abortController: AbortController | null
  state: ModelState
  error?: string
}

// ── State ──────────────────────────────────────────────────

let modelDir = ''
let configuredUserDataPath = ''
let manifests: ModelInfo[] = []
let manifestLoaded = false
let currentDownload: DownloadState | null = null
let statusListeners: ModelStatusCallback[] = []

// ── Helpers ────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function getRuntimeApp(): typeof app | null {
  return app && typeof app.getAppPath === 'function' ? app : null
}

function getDevelopmentAppRoot(runtimeApp: typeof app | null): string {
  return runtimeApp?.getAppPath() ?? path.resolve(__dirname, '..')
}

export function getModelStorageDir(): string {
  if (!modelDir) {
    const runtimeApp = getRuntimeApp()
    modelDir = runtimeApp?.isPackaged
      ? path.join(configuredUserDataPath || runtimeApp.getPath('userData'), 'models')
      : path.join(getDevelopmentAppRoot(runtimeApp), 'ai-models')
  }
  return modelDir
}

export function getBundledModelStorageDir(): string | null {
  if (!getRuntimeApp()?.isPackaged || !process.resourcesPath) return null
  return path.resolve(process.resourcesPath, 'ai-models')
}

export function getModelReadStorageDirs(): string[] {
  const roots = [getModelStorageDir(), getBundledModelStorageDir()].filter((root): root is string =>
    Boolean(root),
  )
  return [...new Set(roots.map((root) => path.resolve(root)))]
}

function getModelPathInStorageRoot(
  storageRoot: string,
  modelName: string,
  filename: string,
): string {
  return getModelFilePath(storageRoot, modelName, filename)
}

function getModelPath(modelName: string, filename: string): string {
  return getModelPathInStorageRoot(getModelStorageDir(), modelName, filename)
}

function emit(status: ModelStatus): void {
  for (const cb of statusListeners) {
    try {
      cb(status)
    } catch {
      /* ignore */
    }
  }
}

function findVerifiedModelRoot(info: ModelInfo): ModelRootState | null {
  for (const storageRoot of getModelReadStorageDirs()) {
    const state = inspectModelStorageRoot(info, storageRoot, getModelStorageDir())
    if (state.verified) return state
  }
  return null
}

/** Returns the model-scoped directory only when every manifest file is verified. */
export function getInstalledModelDir(name: string): string | null {
  ensureModelManifestLoaded()
  const info = manifests.find((model) => model.name === name)
  if (!info) return null
  const root = findVerifiedModelRoot(info)
  return root ? path.resolve(root.storageRoot, name) : null
}

function buildStatus(name: string, overrides?: Partial<ModelStatus>): ModelStatus {
  const info = manifests.find((m) => m.name === name)

  // Never inspect or hash a growing partial file while reporting progress.
  if (currentDownload && currentDownload.modelName === name) {
    return {
      state: currentDownload.state,
      name,
      version: info?.version,
      progress:
        currentDownload.totalBytes > 0
          ? Math.round((currentDownload.bytesDownloaded / currentDownload.totalBytes) * 100)
          : 0,
      bytesDownloaded: currentDownload.bytesDownloaded,
      totalBytes: currentDownload.totalBytes,
      error: currentDownload.error,
      installedVersion: undefined,
      installedPath: undefined,
    }
  }

  const rootStates = info
    ? getModelReadStorageDirs().map((storageRoot) =>
        inspectModelStorageRoot(info, storageRoot, getModelStorageDir()),
      )
    : []
  const verifiedRoot = rootStates.find((root) => root.verified)
  const installed = rootStates.some((root) => root.installedCount > 0)
  const invalidCount = rootStates.reduce((sum, root) => sum + root.invalidCount, 0)
  const missingRequiredFiles = rootStates.some(
    (root) => root.installedCount > 0 && root.missingCount > 0,
  )
  const verified = Boolean(verifiedRoot)

  let state: ModelState = 'not-installed'
  if (!info) {
    state = 'not-installed'
  } else if (verified) {
    state = 'downloaded' // verified, available but not loaded into runtime
  } else if (invalidCount > 0) {
    state = 'error' // an existing file failed integrity verification
  }

  return {
    state,
    name,
    version: info?.version,
    installedVersion: verified ? info?.version : undefined,
    installedPath: verifiedRoot?.modelPath,
    error: verified
      ? undefined
      : invalidCount > 0
        ? 'SHA-256 verification failed'
        : installed && missingRequiredFiles
          ? 'Required model files are missing'
          : undefined,
    ...overrides,
  }
}

// ── Manifest ───────────────────────────────────────────────

export function loadModelManifest(): ModelInfo[] {
  const runtimeApp = getRuntimeApp()
  const appRoot = getDevelopmentAppRoot(runtimeApp)
  const packagedManifest = path.join(process.resourcesPath || '', 'models', 'manifest.json')
  const candidates = runtimeApp?.isPackaged
    ? [
        packagedManifest,
        path.join(appRoot, 'models', 'manifest.json'),
        path.join(__dirname, '..', 'models', 'manifest.json'),
      ]
    : [
        path.join(appRoot, 'models', 'manifest.json'),
        path.join(__dirname, '..', 'models', 'manifest.json'),
        packagedManifest,
      ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8')
        const parsed = JSON.parse(raw)
        if (parsed.models && Array.isArray(parsed.models)) {
          const validated = parsed.models as ModelInfo[]
          for (const model of validated) getRequiredModelFiles(model)
          manifests = validated
          manifestLoaded = true
          return manifests
        }
      }
    } catch {
      // try next
    }
  }
  manifests = []
  manifestLoaded = true
  return manifests
}

function ensureModelManifestLoaded(): void {
  if (!manifestLoaded) loadModelManifest()
}

export function getAvailableModels(): ModelInfo[] {
  ensureModelManifestLoaded()
  return manifests
}

export function getModelInfo(name: string): ModelInfo | undefined {
  ensureModelManifestLoaded()
  return manifests.find((m) => m.name === name)
}

// ── Status ─────────────────────────────────────────────────

export function getModelStatus(name: string): ModelStatus {
  ensureModelManifestLoaded()
  const info = manifests.find((model) => model.name === name)
  if (info) recoverModelFileTransactions(info, getModelStorageDir())
  return buildStatus(name)
}

export function onModelStatusChanged(cb: ModelStatusCallback): () => void {
  statusListeners.push(cb)
  return () => {
    statusListeners = statusListeners.filter((l) => l !== cb)
  }
}

// ── Download ───────────────────────────────────────────────

async function downloadRequiredModelFile(
  modelName: string,
  file: ModelRequiredFile,
  downloadState: DownloadState,
  completedBytes: number,
): Promise<void> {
  const destPath = getModelPath(modelName, file.filename)
  downloadState.url = file.url
  downloadState.destPath = destPath
  downloadState.expectedSha256 = file.sha256
  await downloadPinnedModelFile({
    modelName,
    file,
    writableStorageRoot: getModelStorageDir(),
    signal: downloadState.abortController!.signal,
    onProgress: (bytesDownloaded) => {
      downloadState.bytesDownloaded = completedBytes + bytesDownloaded
      if (currentDownload === downloadState) emit(buildStatus(modelName))
    },
  })
}

export async function downloadModel(modelName: string): Promise<{ ok: boolean; error?: string }> {
  ensureModelManifestLoaded()
  const info = manifests.find((m) => m.name === modelName)
  if (!info) {
    return { ok: false, error: `Unknown model: ${modelName}` }
  }

  // The service has one progress channel and one cancellation token.
  if (currentDownload) {
    return {
      ok: false,
      error:
        currentDownload.modelName === modelName
          ? 'Download already in progress'
          : `Another model download is in progress: ${currentDownload.modelName}`,
    }
  }

  // Already installed and verified?
  const existing = buildStatus(modelName)
  if (existing.state === 'downloaded') {
    return { ok: true } // nothing to do
  }

  const requiredFiles = getRequiredModelFiles(info)
  fs.mkdirSync(path.resolve(getModelStorageDir(), modelName), { recursive: true })
  const abortController = new AbortController()
  const totalBytes = requiredFiles.reduce((sum, file) => sum + file.sizeBytes, 0)
  let completedBytes = requiredFiles.reduce(
    (sum, file) =>
      sum +
      (verifyPinnedModelFileSync(getModelPath(modelName, file.filename), file, getModelStorageDir())
        ? file.sizeBytes
        : 0),
    0,
  )

  const downloadState: DownloadState = {
    modelName,
    url: info.url,
    destPath: getModelPath(modelName, info.filename),
    expectedSha256: info.sha256,
    totalBytes,
    bytesDownloaded: completedBytes,
    abortController,
    state: 'downloading',
  }
  currentDownload = downloadState

  emit(buildStatus(modelName))

  try {
    for (const file of requiredFiles) {
      const filePath = getModelPath(modelName, file.filename)
      if (verifyPinnedModelFileSync(filePath, file, getModelStorageDir())) continue
      await downloadRequiredModelFile(modelName, file, downloadState, completedBytes)
      completedBytes += file.sizeBytes
      downloadState.bytesDownloaded = completedBytes
    }

    if (currentDownload === downloadState) currentDownload = null
    const installed = buildStatus(modelName)
    emit(installed)
    return installed.state === 'downloaded'
      ? { ok: true }
      : { ok: false, error: installed.error || 'Model installation is incomplete' }
  } catch (err: unknown) {
    const message = errorMessage(err)

    if (currentDownload === downloadState) {
      downloadState.state = 'error'
      downloadState.error = message
      emit(buildStatus(modelName))
      currentDownload = null
    } else {
      emit(buildStatus(modelName))
    }
    return { ok: false, error: message }
  }
}

export function cancelDownload(): { ok: boolean } {
  if (!currentDownload) {
    return { ok: false }
  }
  if (currentDownload.abortController) {
    currentDownload.abortController.abort()
  }
  return { ok: true }
}

// ── Delete ─────────────────────────────────────────────────

export function deleteModel(modelName: string): { ok: boolean; error?: string } {
  ensureModelManifestLoaded()
  const info = manifests.find((m) => m.name === modelName)
  if (!info) {
    return { ok: false, error: `Unknown model: ${modelName}` }
  }

  if (currentDownload && currentDownload.modelName === modelName) {
    return { ok: false, error: 'Download in progress; cancel first' }
  }

  const modelDirPath = path.join(getModelStorageDir(), modelName)
  try {
    if (fs.existsSync(modelDirPath)) {
      fs.rmSync(modelDirPath, { recursive: true, force: true })
    }
    clearModelFileVerificationCacheUnder(modelDirPath)
    emit(buildStatus(modelName))
    return { ok: true }
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) }
  }
}

// ── Init ───────────────────────────────────────────────────

export function initModelService(userDataPath?: string): void {
  modelDir = ''
  configuredUserDataPath = userDataPath ? path.resolve(userDataPath) : ''
  manifestLoaded = false
  manifests = []
  resetModelFileVerificationCache()
  fs.mkdirSync(getModelStorageDir(), { recursive: true })
  loadModelManifest()
}
