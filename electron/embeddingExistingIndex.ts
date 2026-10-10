import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { validateEmbeddingVector } from './embeddingVectorValidation'
import { EMBEDDING_F16_CACHE_VERSION, embeddingCachePathKey } from './embeddingF16Cache'

interface ExistingIndexDescriptor {
  pathIndexPath: string
  sourceOffsets: Map<string, number>
}

export interface ExistingEmbeddingIdStore {
  add(value: string): unknown
  delete(value: string): unknown
  readonly size: number
}

export interface ExistingEmbeddingIndexProgress {
  phase: 'index' | 'tail'
  scanned: number
  bytesRead: number
  totalBytes: number
  existingCount: number
}

export interface CollectExistingEmbeddingIdsOptions {
  vectorDbDir: string
  modelName: string
  embeddingType: string
  dim: number
  sourcePaths: string[]
  isCancelled?: () => boolean
  onProgress?: (progress: ExistingEmbeddingIndexProgress) => void
  onDiagnostic?: (event: string, data: Record<string, unknown>) => void
  onStatus?: (message: string) => void
}

function pathKey(filePath: string): string {
  return path.resolve(filePath).replace(/\//g, '\\').toLowerCase()
}

function dinoDescriptor(
  options: CollectExistingEmbeddingIdsOptions,
): ExistingIndexDescriptor | null {
  const base = `${options.modelName.replace(/[^a-zA-Z0-9_.-]/g, '_')}__${options.embeddingType.replace(
    /[^a-zA-Z0-9_.-]/g,
    '_',
  )}`
  const cacheDir = path.join(options.vectorDbDir, 'embedding-cache')
  const metaPath = path.join(cacheDir, `${base}.f16.json`)
  const pathIndexPath = path.join(cacheDir, `${base}.paths.jsonl`)
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
      version?: number
      modelName?: string
      embeddingType?: string
      dim?: number
      count?: number
      sourceFiles?: Array<{ path?: string; size?: number }>
    }
    if (
      meta.version !== EMBEDDING_F16_CACHE_VERSION ||
      meta.modelName !== options.modelName ||
      meta.embeddingType !== options.embeddingType ||
      meta.dim !== options.dim ||
      !Number.isInteger(meta.count) ||
      !fs.statSync(pathIndexPath).isFile()
    ) {
      return null
    }
    const sourceOffsets = new Map<string, number>()
    for (const source of meta.sourceFiles || []) {
      if (typeof source.path === 'string' && Number.isInteger(source.size) && source.size! >= 0) {
        sourceOffsets.set(pathKey(source.path), source.size!)
      }
    }
    return { pathIndexPath, sourceOffsets }
  } catch {
    return null
  }
}

function descriptor(options: CollectExistingEmbeddingIdsOptions): ExistingIndexDescriptor | null {
  return dinoDescriptor(options)
}

async function readPathIndex(
  descriptorValue: ExistingIndexDescriptor,
  existing: ExistingEmbeddingIdStore,
  options: CollectExistingEmbeddingIdsOptions,
): Promise<void> {
  const totalBytes = fs.statSync(descriptorValue.pathIndexPath).size
  let bytesRead = 0
  let scanned = 0
  const reader = readline.createInterface({
    input: fs.createReadStream(descriptorValue.pathIndexPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of reader) {
    if (options.isCancelled?.()) {
      reader.close()
      throw new Error('Existing embedding index scan cancelled')
    }
    bytesRead += Buffer.byteLength(line, 'utf8') + 1
    scanned++
    if (line) {
      try {
        const row = JSON.parse(line) as { path?: unknown }
        if (typeof row.path === 'string') existing.add(embeddingCachePathKey(row.path))
      } catch {
        /* Ignore malformed derived path rows. */
      }
    }
    if (scanned === 1 || scanned % 20_000 === 0) {
      options.onProgress?.({
        phase: 'index',
        scanned,
        bytesRead,
        totalBytes,
        existingCount: existing.size,
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
}

async function readSourceTail(
  sourcePath: string,
  offset: number,
  existing: ExistingEmbeddingIdStore,
  options: CollectExistingEmbeddingIdsOptions,
): Promise<void> {
  const stat = fs.statSync(sourcePath)
  if (stat.size < offset) throw new Error('Embedding source was truncated')
  if (stat.size === offset) return
  let bytesRead = 0
  let scanned = 0
  const reader = readline.createInterface({
    input: fs.createReadStream(sourcePath, { encoding: 'utf8', start: offset }),
    crlfDelay: Infinity,
  })
  for await (const line of reader) {
    if (options.isCancelled?.()) {
      reader.close()
      throw new Error('Existing embedding tail scan cancelled')
    }
    bytesRead += Buffer.byteLength(line, 'utf8') + 1
    scanned++
    if (line) {
      try {
        const row = JSON.parse(line) as {
          modelName?: unknown
          embeddingType?: unknown
          imageId?: unknown
          dim?: unknown
          vector?: unknown
        }
        if (
          row.modelName === options.modelName &&
          row.embeddingType === options.embeddingType &&
          typeof row.imageId === 'string'
        ) {
          const key = embeddingCachePathKey(row.imageId)
          if (row.dim === options.dim && validateEmbeddingVector(row.vector, options.dim).ok) {
            existing.add(key)
          } else existing.delete(key)
        }
      } catch {
        /* Ignore malformed appended rows. */
      }
    }
    if (scanned === 1 || scanned % 5000 === 0) {
      options.onProgress?.({
        phase: 'tail',
        scanned,
        bytesRead,
        totalBytes: stat.size - offset,
        existingCount: existing.size,
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
}

export async function collectExistingEmbeddingIdsFromFastIndex(
  options: CollectExistingEmbeddingIdsOptions,
): Promise<Set<string> | null> {
  const existing = new Set<string>()
  return (await populateExistingEmbeddingIdsFromFastIndex(options, existing)) ? existing : null
}

export async function populateExistingEmbeddingIdsFromFastIndex(
  options: CollectExistingEmbeddingIdsOptions,
  existing: ExistingEmbeddingIdStore,
): Promise<boolean> {
  const descriptorValue = descriptor(options)
  if (!descriptorValue) return false
  for (const sourcePath of options.sourcePaths) {
    const offset = descriptorValue.sourceOffsets.get(pathKey(sourcePath))
    if (offset === undefined) return false
    try {
      if (!fs.statSync(sourcePath).isFile() || fs.statSync(sourcePath).size < offset) return false
    } catch {
      return false
    }
  }
  await readPathIndex(descriptorValue, existing, options)
  for (const sourcePath of options.sourcePaths) {
    await readSourceTail(
      sourcePath,
      descriptorValue.sourceOffsets.get(pathKey(sourcePath))!,
      existing,
      options,
    )
  }
  return true
}

/** Resolve current IDs through the compact index and fall back to JSONL safely. */
export async function collectExistingEmbeddingIds(
  options: CollectExistingEmbeddingIdsOptions,
): Promise<Set<string>> {
  const startedAt = Date.now()
  if (options.sourcePaths.length === 0) {
    options.onDiagnostic?.('existing-scan:skip', {
      modelName: options.modelName,
      embeddingType: options.embeddingType,
      reason: 'missing-store',
    })
    return new Set()
  }
  const fastExisting = await collectExistingEmbeddingIdsFromFastIndex({
    ...options,
    onProgress: ({ phase, scanned, bytesRead, totalBytes, existingCount }) => {
      const percent = totalBytes > 0 ? Math.min(100, Math.round((bytesRead / totalBytes) * 100)) : 0
      options.onStatus?.(
        `Reading existing vector ${phase}: ${percent}% (${existingCount.toLocaleString()} found)`,
      )
      if (scanned === 1 || scanned % 100_000 === 0) {
        options.onDiagnostic?.('existing-fast-scan:progress', {
          modelName: options.modelName,
          embeddingType: options.embeddingType,
          phase,
          scanned,
          bytesRead,
          totalBytes,
          existingCount,
        })
      }
    },
  })
  if (fastExisting) {
    options.onDiagnostic?.('existing-fast-scan:done', {
      modelName: options.modelName,
      embeddingType: options.embeddingType,
      existingCount: fastExisting.size,
      elapsedMs: Date.now() - startedAt,
    })
    return fastExisting
  }

  const existing = new Set<string>()
  const totalBytes = options.sourcePaths.reduce((sum, filePath) => {
    try {
      return sum + fs.statSync(filePath).size
    } catch {
      return sum
    }
  }, 0)
  let scannedLines = 0
  let approxBytes = 0
  let lastReport = 0
  options.onDiagnostic?.('existing-scan:start', {
    modelName: options.modelName,
    embeddingType: options.embeddingType,
    filePaths: options.sourcePaths,
    totalBytes,
  })
  for (const filePath of options.sourcePaths) {
    const reader = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    for await (const line of reader) {
      if (!line) continue
      scannedLines++
      approxBytes += Buffer.byteLength(line, 'utf8') + 1
      const now = Date.now()
      if (now - lastReport > 2000 || scannedLines === 1) {
        lastReport = now
        const percent =
          totalBytes > 0 ? Math.min(100, Math.round((approxBytes / totalBytes) * 100)) : 0
        options.onDiagnostic?.('existing-scan:progress', {
          modelName: options.modelName,
          embeddingType: options.embeddingType,
          filePath,
          scannedLines,
          existingCount: existing.size,
          approxBytes,
          totalBytes,
          percent,
          elapsedMs: now - startedAt,
        })
        options.onStatus?.(
          `Scanning existing embeddings: ${percent}% (${existing.size.toLocaleString()} found)`,
        )
      }
      try {
        const row = JSON.parse(line) as {
          modelName?: unknown
          embeddingType?: unknown
          imageId?: unknown
          dim?: unknown
          vector?: unknown
        }
        if (
          row.modelName === options.modelName &&
          row.embeddingType === options.embeddingType &&
          typeof row.imageId === 'string'
        ) {
          const key = embeddingCachePathKey(row.imageId)
          if (row.dim === options.dim && validateEmbeddingVector(row.vector, options.dim).ok) {
            existing.add(key)
          } else existing.delete(key)
        }
      } catch {
        /* Ignore malformed source rows. */
      }
    }
  }
  options.onDiagnostic?.('existing-scan:done', {
    modelName: options.modelName,
    embeddingType: options.embeddingType,
    scannedLines,
    existingCount: existing.size,
    totalBytes,
    elapsedMs: Date.now() - startedAt,
  })
  return existing
}
