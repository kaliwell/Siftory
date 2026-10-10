import fs from 'fs'
import path from 'path'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type { VectorBuildRequest } from '../shared/vectorTypes'

const CACHE_VERSION = 1
const HEADER_BYTES = 16
const DEFAULT_CONCURRENCY = 48
const MAX_CACHE_ENTRIES = 50_000
const MAX_PREPARATION_CHILD_BUFFER_BYTES = 8 * 1024 * 1024

interface RejectedInputFingerprint {
  size: number
  mtimeMs: number
  updatedAt: number
}

interface RejectedInputCache {
  version: number
  entries: Record<string, RejectedInputFingerprint>
}

export interface EmbeddingInputCandidate {
  imagePath: string
}

export interface EmbeddingInputValidationProgress {
  checked: number
  total: number
  rejected: number
}

export interface FilterEmbeddingInputsOptions {
  cachePath?: string
  concurrency?: number
  isCancelled?: () => boolean
  onProgress?: (progress: EmbeddingInputValidationProgress) => void
}

export interface PreparedEmbeddingScanResult {
  inputs: Array<{ imageId: string; imagePath: string }>
  discovered: number
  skippedExisting: number
  rejected: number
}

export interface PrepareEmbeddingScanInputsOptions {
  request: VectorBuildRequest
  dim: number
  vectorDbDir: string
  sourcePaths: string[]
  isStopping: () => boolean
  onChildState: (child: ChildProcessWithoutNullStreams | null) => void
  onProgress: (message: string) => void
  onDiagnostic: (message: string) => void
  onChunk?: (items: PreparedEmbeddingScanResult['inputs']) => Promise<void>
  chunkSize?: number
}

function normalizedPath(filePath: string): string {
  return path.resolve(filePath).replace(/\//g, '\\').toLowerCase()
}

function hasPrefix(buffer: Uint8Array, values: number[]): boolean {
  return values.every((value, index) => buffer[index] === value)
}

export function hasSupportedEmbeddingImageSignature(buffer: Uint8Array): boolean {
  if (buffer.length < 4) return false
  if (hasPrefix(buffer, [0xff, 0xd8, 0xff])) return true
  if (hasPrefix(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return true
  if (
    hasPrefix(buffer, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    hasPrefix(buffer, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return true
  }
  if (
    hasPrefix(buffer, [0x52, 0x49, 0x46, 0x46]) &&
    buffer.length >= 12 &&
    hasPrefix(buffer.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return true
  }
  if (hasPrefix(buffer, [0x42, 0x4d])) return true
  if (hasPrefix(buffer, [0x49, 0x49, 0x2a, 0x00]) || hasPrefix(buffer, [0x4d, 0x4d, 0x00, 0x2a])) {
    return true
  }
  return false
}

function loadRejectedCache(cachePath: string | undefined): RejectedInputCache {
  if (!cachePath) return { version: CACHE_VERSION, entries: {} }
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as RejectedInputCache
    if (parsed.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') {
      return parsed
    }
  } catch {
    /* A missing or damaged rejection cache is safe to rebuild. */
  }
  return { version: CACHE_VERSION, entries: {} }
}

function saveRejectedCache(cachePath: string | undefined, cache: RejectedInputCache): void {
  if (!cachePath) return
  const entries = Object.entries(cache.entries)
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, MAX_CACHE_ENTRIES)
  const target: RejectedInputCache = {
    version: CACHE_VERSION,
    entries: Object.fromEntries(entries),
  }
  fs.mkdirSync(path.dirname(cachePath), { recursive: true })
  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(target), 'utf8')
  if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath)
  fs.renameSync(temporaryPath, cachePath)
}

async function readImageHeader(filePath: string): Promise<Uint8Array> {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

export async function filterSupportedEmbeddingInputs<T extends EmbeddingInputCandidate>(
  candidates: readonly T[],
  options: FilterEmbeddingInputsOptions = {},
): Promise<{ accepted: T[]; rejected: number; cachedRejected: number }> {
  const cache = loadRejectedCache(options.cachePath)
  const accepted = new Array<T | undefined>(candidates.length)
  const concurrency = Math.max(
    1,
    Math.min(128, Math.floor(options.concurrency || DEFAULT_CONCURRENCY)),
  )
  let cursor = 0
  let checked = 0
  let rejected = 0
  let cachedRejected = 0
  let cacheChanged = false

  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.isCancelled?.()) return
      const index = cursor++
      if (index >= candidates.length) return
      const candidate = candidates[index]
      const key = normalizedPath(candidate.imagePath)
      try {
        const stat = await fs.promises.stat(candidate.imagePath)
        if (!stat.isFile() || stat.size <= 0) throw new Error('not-file')
        const cached = cache.entries[key]
        if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
          rejected++
          cachedRejected++
        } else {
          const header = await readImageHeader(candidate.imagePath)
          if (hasSupportedEmbeddingImageSignature(header)) {
            accepted[index] = candidate
            if (cached) {
              delete cache.entries[key]
              cacheChanged = true
            }
          } else {
            cache.entries[key] = {
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              updatedAt: Date.now(),
            }
            rejected++
            cacheChanged = true
          }
        }
      } catch {
        rejected++
      }
      checked++
      if (checked === candidates.length || checked % 1000 === 0) {
        options.onProgress?.({ checked, total: candidates.length, rejected })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker))
  if (cacheChanged) saveRejectedCache(options.cachePath, cache)
  return {
    accepted: accepted.filter((candidate): candidate is T => candidate !== undefined),
    rejected,
    cachedRejected,
  }
}

function getPreparationChildPath(): string {
  const candidates = [
    path.join(__dirname, 'embeddingPreparationChild.js'),
    path.join(process.resourcesPath || '', 'embeddingPreparationChild.js'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}

export function prepareEmbeddingScanInputsInChild(
  options: PrepareEmbeddingScanInputsOptions,
): Promise<PreparedEmbeddingScanResult> {
  return new Promise((resolve, reject) => {
    const nodePath = [
      process.env.NODE_PATH,
      path.join(process.resourcesPath || '', 'app.asar', 'node_modules'),
      path.join(process.resourcesPath || '', 'app', 'node_modules'),
      path.join(__dirname, '..', 'node_modules'),
    ]
      .filter(Boolean)
      .join(path.delimiter)
    const child = spawn(process.execPath, [getPreparationChildPath()], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: nodePath },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    options.onChildState(child)
    const inputs: PreparedEmbeddingScanResult['inputs'] = []
    let settled = false
    let stdoutBuffer = ''
    const fail = (error: string): void => {
      if (settled) return
      settled = true
      options.onChildState(null)
      reject(new Error(error))
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      if (Buffer.byteLength(stdoutBuffer, 'utf8') > MAX_PREPARATION_CHILD_BUFFER_BYTES) {
        fail('Embedding preparation process output exceeded its byte limit')
        child.kill()
        return
      }
      let index = stdoutBuffer.indexOf('\n')
      while (index >= 0) {
        const line = stdoutBuffer.slice(0, index).trim()
        stdoutBuffer = stdoutBuffer.slice(index + 1)
        index = stdoutBuffer.indexOf('\n')
        if (!line) continue
        try {
          const message = JSON.parse(line) as {
            type?: string
            message?: string
            error?: string
            items?: PreparedEmbeddingScanResult['inputs']
            sequence?: number
            discovered?: number
            skippedExisting?: number
            rejected?: number
          }
          if (message.type === 'progress' && message.message) {
            options.onProgress(message.message)
          } else if (message.type === 'chunk' && Array.isArray(message.items)) {
            const sequence = Number(message.sequence)
            if (!Number.isSafeInteger(sequence) || sequence <= 0 || message.items.length > 256) {
              fail('Embedding preparation process emitted an invalid chunk')
              child.kill()
              return
            }
            child.stdout.pause()
            void (
              options.onChunk
                ? options.onChunk(message.items)
                : Promise.resolve().then(() => inputs.push(...message.items!))
            )
              .then(() => {
                if (settled || !child.stdin.writable) return
                child.stdin.write(`${JSON.stringify({ type: 'ack', sequence })}\n`)
                child.stdout.resume()
              })
              .catch((error: unknown) => {
                fail(error instanceof Error ? error.message : String(error))
                child.kill()
              })
          } else if (message.type === 'error') {
            fail(message.error || 'Embedding preparation failed')
          } else if (message.type === 'done' && !settled) {
            settled = true
            options.onChildState(null)
            child.stdin.end()
            resolve({
              inputs,
              discovered: Number(message.discovered) || 0,
              skippedExisting: Number(message.skippedExisting) || 0,
              rejected: Number(message.rejected) || 0,
            })
          }
        } catch {
          // Ignore non-protocol output from the data process.
        }
      }
    })
    child.stderr.on('data', (chunk: string) => {
      options.onDiagnostic(chunk.trim().slice(0, 1000))
    })
    child.on('error', (error) => fail(error.message))
    child.on('exit', (code, signal) => {
      if (!settled) {
        fail(
          options.isStopping()
            ? 'Build stopped'
            : `Embedding preparation process exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        )
      }
    })
    child.stdin.write(
      `${JSON.stringify({
        scanPaths: options.request.scanPaths,
        userDataPath: path.dirname(options.vectorDbDir),
        vectorDbDir: options.vectorDbDir,
        modelName: options.request.modelName,
        embeddingType: options.request.embeddingType,
        dim: options.dim,
        sourcePaths: options.sourcePaths,
        chunkSize: Math.max(1, Math.min(256, Math.floor(options.chunkSize || 256))),
      })}\n`,
    )
  })
}
