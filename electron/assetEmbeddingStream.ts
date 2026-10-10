import fs from 'fs'
import type { EmbeddingEntry } from '../shared/vectorTypes'
import {
  classifyEmbeddingVector,
  EmbeddingVectorValidationError,
  MAX_EMBEDDING_VECTOR_DIM,
  requireNormalizedEmbeddingVectorFloat32,
} from './embeddingVectorValidation'

/**
 * Pure embedding streaming helpers: no Electron imports, so task workers can
 * bundle this module directly. Callers must pass explicit source paths; the
 * Electron-bound wrappers live in assetLibraryEmbeddingSource.ts.
 */

export interface StreamEmbeddingOptions {
  modelName: string
  expectedDim: number
  sourcePaths: string[]
  maxEntries?: number
  isCancelled?: () => boolean
  onProgress?: (scanned: number, totalBytes: number, processedBytes: number) => void
  shouldStop?: () => boolean
  onEntry: (entry: StreamedAssetEmbeddingEntry) => void | Promise<void>
}

export type StreamedAssetEmbeddingEntry = EmbeddingEntry & { vector: Float32Array }

const REVERSE_READ_CHUNK_BYTES = 1024 * 1024
const MAX_EMBEDDING_ROW_BYTES = 4 * 1024 * 1024

async function* readLinesNewestFirst(filePath: string): AsyncGenerator<string> {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const stat = await handle.stat()
    let position = stat.size
    let prefix = Buffer.alloc(0)

    while (position > 0) {
      const chunkSize = Math.min(REVERSE_READ_CHUNK_BYTES, position)
      position -= chunkSize
      const chunk = Buffer.allocUnsafe(chunkSize)
      const { bytesRead } = await handle.read(chunk, 0, chunkSize, position)
      const source =
        prefix.length > 0
          ? Buffer.concat([chunk.subarray(0, bytesRead), prefix])
          : chunk.subarray(0, bytesRead)
      let lineEnd = source.length

      for (let index = source.length - 1; index >= 0; index--) {
        if (source[index] !== 0x0a) continue
        let line = source.subarray(index + 1, lineEnd)
        if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1)
        if (line.length > MAX_EMBEDDING_ROW_BYTES) {
          throw new Error(`Embedding row exceeds ${MAX_EMBEDDING_ROW_BYTES} byte safety limit`)
        }
        if (line.length > 0) yield line.toString('utf8')
        lineEnd = index
      }

      prefix = Buffer.from(source.subarray(0, lineEnd))
      if (prefix.length > MAX_EMBEDDING_ROW_BYTES) {
        throw new Error(`Embedding row exceeds ${MAX_EMBEDDING_ROW_BYTES} byte safety limit`)
      }
    }

    if (prefix.length > 0) {
      let line = prefix
      if (line[line.length - 1] === 0x0d) line = line.subarray(0, -1)
      if (line.length > 0) yield line.toString('utf8')
    }
  } finally {
    await handle.close()
  }
}

export function embeddingPathKey(filePath: string): string {
  return filePath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function assertExpectedDim(expectedDim: number): void {
  if (
    !Number.isSafeInteger(expectedDim) ||
    expectedDim <= 0 ||
    expectedDim > MAX_EMBEDDING_VECTOR_DIM
  ) {
    throw new RangeError(
      `Asset embedding dimension must be a positive safe integer <= ${MAX_EMBEDDING_VECTOR_DIM}`,
    )
  }
}

export function normalizedVector(entry: EmbeddingEntry, expectedDim: number): Float32Array {
  assertExpectedDim(expectedDim)
  if (entry.dim !== expectedDim) {
    throw new RangeError(
      `Asset embedding envelope dimension ${entry.dim} does not match ${expectedDim}`,
    )
  }
  return requireNormalizedEmbeddingVectorFloat32(entry.vector, expectedDim)
}

export function shiftedCosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) {
    throw new RangeError(
      `Asset cosine dimension mismatch: ${left.length} does not match ${right.length}`,
    )
  }
  const leftValidation = classifyEmbeddingVector(left, left.length)
  if (!leftValidation.ok) throw new EmbeddingVectorValidationError(leftValidation)
  const rightValidation = classifyEmbeddingVector(right, right.length)
  if (!rightValidation.ok) throw new EmbeddingVectorValidationError(rightValidation)

  // Work in each vector's scaled space so very large finite components cannot
  // overflow, while avoiding a normalized Float32Array allocation per score.
  let scaledDot = 0
  for (let index = 0; index < left.length; index++) {
    scaledDot += (left[index] / leftValidation.scale) * (right[index] / rightValidation.scale)
  }
  const dot = scaledDot / leftValidation.scaledNorm / rightValidation.scaledNorm
  return Math.max(0, Math.min(1, (dot + 1) / 2))
}

export async function streamAssetEmbeddingsFromPaths(options: StreamEmbeddingOptions): Promise<{
  scanned: number
  processedBytes: number
  totalBytes: number
}> {
  assertExpectedDim(options.expectedDim)
  // getEmbeddingStorePaths returns oldest-to-newest so forward readers can
  // apply latest-wins semantics. This reader walks rows newest-first, so it
  // must also walk the source files newest-first.
  const filePaths = [...new Set(options.sourcePaths)].reverse()
  const totalBytes = filePaths.reduce((sum, filePath) => {
    try {
      return sum + fs.statSync(filePath).size
    } catch {
      return sum
    }
  }, 0)
  const seen = new Set<string>()
  let scanned = 0
  let processedBytes = 0
  let lastProgressAt = 0

  outer: for (const filePath of filePaths) {
    for await (const line of readLinesNewestFirst(filePath)) {
      if (options.isCancelled?.()) throw new Error('Asset library task cancelled')
      processedBytes += Buffer.byteLength(line, 'utf8') + 1
      if (!line) continue
      let entry: EmbeddingEntry
      try {
        entry = JSON.parse(line) as EmbeddingEntry
        if (
          entry.modelName !== options.modelName ||
          entry.embeddingType !== 'global' ||
          typeof entry.imageId !== 'string' ||
          entry.imageId.length === 0
        ) {
          continue
        }
      } catch {
        /* malformed and unrelated rows are skipped */
        continue
      }
      const key = embeddingPathKey(entry.imageId)
      if (seen.has(key)) continue
      // A recognizable latest row owns the key even when its vector is
      // invalid. Mark it seen before validation so an older valid revision
      // cannot be resurrected from this file or an older source file.
      seen.add(key)
      let vector: Float32Array
      try {
        vector = normalizedVector(entry, options.expectedDim)
      } catch {
        continue
      }
      scanned += 1
      await options.onEntry({ ...entry, dim: options.expectedDim, vector, norm: 1 })
      if (options.shouldStop?.()) {
        break outer
      }
      if (options.maxEntries && scanned >= options.maxEntries) {
        break outer
      }

      const now = Date.now()
      if (now - lastProgressAt >= 250) {
        lastProgressAt = now
        options.onProgress?.(scanned, totalBytes, processedBytes)
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
  }
  options.onProgress?.(scanned, totalBytes, processedBytes)
  return { scanned, processedBytes, totalBytes }
}

export async function loadAssetEmbeddingsForPathsFromPaths(
  modelName: string,
  expectedDim: number,
  sourcePaths: string[],
  paths: Iterable<string>,
  isCancelled?: () => boolean,
  onProgress?: (scanned: number, totalBytes: number, processedBytes: number) => void,
): Promise<Map<string, Float32Array>> {
  const pending = new Set([...paths].map(embeddingPathKey))
  const result = new Map<string, Float32Array>()
  if (pending.size === 0) return result

  await streamAssetEmbeddingsFromPaths({
    modelName,
    expectedDim,
    sourcePaths,
    isCancelled,
    onProgress,
    shouldStop: () => pending.size === 0,
    onEntry: (entry) => {
      const key = embeddingPathKey(entry.imageId)
      if (!pending.has(key)) return
      result.set(key, entry.vector)
      pending.delete(key)
    },
  })
  return result
}
