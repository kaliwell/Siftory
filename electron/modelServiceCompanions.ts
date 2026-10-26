import fs from 'fs'
import path from 'path'
import type { ModelInfo, ModelRequiredFile, ModelStatus } from '../shared/vectorTypes'
import {
  commitPreparedPath,
  createPreparedSiblingPath,
  discardPreparedPath,
  recoverPreparedPathTransactions,
} from './localFileTransaction'
import {
  rememberVerifiedFile,
  streamModelBodyToFile,
  verifyPinnedModelFileSync,
  verifyPinnedModelFileAsync,
} from './modelDownloadStream'
export {
  verifyPinnedModelFileSync,
  verifyPinnedModelFileAsync,
  resetModelFileVerificationCache,
  clearModelFileVerificationCacheUnder,
} from './modelDownloadStream'

const MAX_REQUIRED_MODEL_FILES = 128
const MAX_PINNED_MODEL_FILE_BYTES = 16 * 1024 * 1024 * 1024
const SHA256_PATTERN = /^[a-f\d]{64}$/i

export interface ModelRootState {
  storageRoot: string
  modelPath: string
  installedCount: number
  missingCount: number
  invalidCount: number
  verified: boolean
}

export interface DownloadPinnedModelFileOptions {
  modelName: string
  file: ModelRequiredFile
  writableStorageRoot: string
  signal: AbortSignal
  onProgress?: (bytesDownloaded: number) => void
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return (
    Boolean(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function requireSafeModelName(modelName: string): void {
  if (
    !modelName ||
    modelName === '.' ||
    modelName === '..' ||
    path.basename(modelName) !== modelName ||
    /[\\/]/.test(modelName)
  ) {
    throw new Error(`Unsafe model name: ${modelName}`)
  }
}

function requirePinnedFile(file: ModelRequiredFile, label: string): ModelRequiredFile {
  if (!file || typeof file !== 'object') throw new Error(`${label} must be an object`)
  const filename = typeof file.filename === 'string' ? file.filename.trim() : ''
  if (!filename || path.isAbsolute(filename) || /^[a-z]:[\\/]/i.test(filename)) {
    throw new Error(`${label} has an unsafe filename`)
  }
  const normalized = filename.replace(/\\/g, '/')
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`${label} has an unsafe filename`)
  }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(file.url)
  } catch {
    throw new Error(`${label} has an invalid URL`)
  }
  if (parsedUrl.protocol !== 'https:') throw new Error(`${label} URL must use HTTPS`)
  if (!SHA256_PATTERN.test(file.sha256)) throw new Error(`${label} has an invalid SHA-256`)
  if (
    !Number.isSafeInteger(file.sizeBytes) ||
    file.sizeBytes <= 0 ||
    file.sizeBytes > MAX_PINNED_MODEL_FILE_BYTES
  ) {
    throw new Error(`${label} has an invalid size`)
  }
  return {
    filename: normalized,
    url: parsedUrl.toString(),
    sha256: file.sha256.toLowerCase(),
    sizeBytes: file.sizeBytes,
  }
}

/**
 * Returns the complete, validated file set that defines an installed model.
 * A model is never ready solely because its primary ONNX file exists.
 */
export function getRequiredModelFiles(info: ModelInfo): ModelRequiredFile[] {
  const rawFiles: ModelRequiredFile[] = [
    {
      filename: info.filename,
      url: info.url,
      sha256: info.sha256,
      sizeBytes: info.sizeBytes,
    },
    ...(Array.isArray(info.requiredFiles) ? info.requiredFiles : []),
  ]
  if (rawFiles.length > MAX_REQUIRED_MODEL_FILES) {
    throw new Error(`Model ${info.name} has too many required files`)
  }
  const files = rawFiles.map((file, index) =>
    requirePinnedFile(file, `${info.name} requiredFiles[${index}]`),
  )
  const seen = new Set<string>()
  for (const file of files) {
    const key = file.filename.toLowerCase()
    if (seen.has(key)) throw new Error(`Model ${info.name} repeats required file ${file.filename}`)
    seen.add(key)
  }
  return files
}

export function getModelFilePath(storageRoot: string, modelName: string, filename: string): string {
  requireSafeModelName(modelName)
  const resolvedStorageRoot = path.resolve(storageRoot)
  const modelRoot = path.resolve(resolvedStorageRoot, modelName)
  if (!isPathInside(resolvedStorageRoot, modelRoot)) {
    throw new Error(`Unsafe model name: ${modelName}`)
  }
  const candidate = path.resolve(modelRoot, filename)
  if (!isPathInside(modelRoot, candidate)) throw new Error(`Unsafe model filename: ${filename}`)
  return candidate
}

export function inspectModelStorageRoot(
  info: ModelInfo,
  storageRoot: string,
  writableStorageRoot: string,
): ModelRootState {
  const requiredFiles = getRequiredModelFiles(info)
  const fileStates = requiredFiles.map((file) => {
    const filePath = getModelFilePath(storageRoot, info.name, file.filename)
    const exists = fs.existsSync(filePath)
    return {
      exists,
      verified: exists && verifyPinnedModelFileSync(filePath, file, writableStorageRoot),
    }
  })
  const installedCount = fileStates.filter(({ exists }) => exists).length
  const invalidCount = fileStates.filter(({ exists, verified }) => exists && !verified).length
  return {
    storageRoot,
    modelPath: getModelFilePath(storageRoot, info.name, info.filename),
    installedCount,
    missingCount: fileStates.length - installedCount,
    invalidCount,
    verified: fileStates.length > 0 && fileStates.every((file) => file.verified),
  }
}

export function recoverModelFileTransactions(info: ModelInfo, writableStorageRoot: string): void {
  for (const file of getRequiredModelFiles(info)) {
    recoverPreparedPathTransactions(
      path.dirname(getModelFilePath(writableStorageRoot, info.name, file.filename)),
    )
  }
}

async function* boundedResponseBody(
  body: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let received = 0
  for await (const chunk of body) {
    if (signal.aborted) throw signal.reason ?? new Error('Model download aborted')
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
    received += bytes.byteLength
    if (received > expectedBytes) {
      throw new Error(`Download exceeded pinned size of ${expectedBytes} bytes`)
    }
    yield bytes
  }
}

export async function downloadPinnedModelFile(
  options: DownloadPinnedModelFileOptions,
): Promise<void> {
  const file = requirePinnedFile(options.file, `${options.modelName} download`)
  const destPath = getModelFilePath(options.writableStorageRoot, options.modelName, file.filename)
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  const preparedPath = createPreparedSiblingPath(destPath)
  try {
    const response = await (options.fetch ?? fetch)(file.url, {
      signal: options.signal,
      headers: { 'User-Agent': 'Siftory/1.0.0' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    if (!response.body) throw new Error('No response body')
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > file.sizeBytes) {
      throw new Error(`HTTP body exceeds pinned size of ${file.sizeBytes} bytes`)
    }
    const streamed = await streamModelBodyToFile(
      boundedResponseBody(
        response.body as unknown as AsyncIterable<Uint8Array>,
        file.sizeBytes,
        options.signal,
      ),
      preparedPath,
      {
        signal: options.signal,
        totalBytes: file.sizeBytes,
        onProgress: ({ bytesDownloaded }) => options.onProgress?.(bytesDownloaded),
      },
    )
    if (streamed.bytesDownloaded !== file.sizeBytes) {
      throw new Error(`Size mismatch: expected ${file.sizeBytes}, got ${streamed.bytesDownloaded}`)
    }
    if (streamed.sha256 !== file.sha256) {
      throw new Error(
        `SHA-256 mismatch: expected ${file.sha256.slice(0, 16)}..., got ${streamed.sha256.slice(0, 16)}...`,
      )
    }
    await commitPreparedPath(preparedPath, destPath)
    rememberVerifiedFile(destPath, file, options.writableStorageRoot)
  } catch (error) {
    await discardPreparedPath(preparedPath)
    throw error
  }
}

interface ModelStatusReaderContext {
  getModelInfo(name: string): ModelInfo | undefined
  getModelStorageDir(): string
  getModelReadStorageDirs(): string[]
  isDownloading(name: string): boolean
  buildStatus(name: string, roots?: ModelRootState[]): ModelStatus
}

/** Shares a complete asynchronous integrity check between simultaneous status consumers. */
export function createAsyncModelStatusReader(context: ModelStatusReaderContext) {
  const pending = new Map<string, Promise<ModelStatus>>()
  async function inspect(name: string): Promise<ModelStatus> {
    const info = context.getModelInfo(name)
    if (!info || context.isDownloading(name)) return context.buildStatus(name)
    const writable = context.getModelStorageDir()
    recoverModelFileTransactions(info, writable)
    const roots: ModelRootState[] = []
    for (const storageRoot of context.getModelReadStorageDirs()) {
      let installedCount = 0,
        missingCount = 0,
        invalidCount = 0
      for (const file of getRequiredModelFiles(info)) {
        const target = getModelFilePath(storageRoot, name, file.filename)
        if (!fs.existsSync(target)) {
          missingCount++
          continue
        }
        installedCount++
        if (!(await verifyPinnedModelFileAsync(target, file, writable))) invalidCount++
      }
      roots.push({
        storageRoot,
        modelPath: getModelFilePath(storageRoot, name, info.filename),
        installedCount,
        missingCount,
        invalidCount,
        verified: missingCount === 0 && invalidCount === 0,
      })
    }
    return context.buildStatus(name, roots)
  }
  return (name: string): Promise<ModelStatus> => {
    const existing = pending.get(name)
    if (existing) return existing
    const request = inspect(name).finally(() => pending.delete(name))
    pending.set(name, request)
    return request
  }
}
