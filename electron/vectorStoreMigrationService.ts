import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import type {
  VectorStoreMigrationPreview,
  VectorStoreMigrationProgress,
} from '../shared/ipc-contract'
import {
  AUTHORITATIVE_VECTOR_DTYPE,
  AUTHORITATIVE_VECTOR_STORE_VERSION,
  createFileChunkIntegritySync,
  type AuthoritativeVectorStoreEntry,
  openAuthoritativeVectorStore,
  readCurrentAuthoritativeManifest,
  sha256FileSync,
  sha256FileTailSync,
  verifyFileChunkIntegritySync,
} from './authoritativeVectorStore'
import {
  ensureEmbeddingF16Cache,
  extendEmbeddingF16Cache,
  type EnsureEmbeddingF16CacheOptions,
} from './embeddingF16Cache'
import { discardEmbeddingIncrement } from './embeddingIncrementLog'
import { scheduleAuthoritativeAnnPrewarm } from './annPrewarmService'
import { disposeVectorAnnWorker } from './vectorAnnWorkerHost'

interface StoredPreview {
  preview: VectorStoreMigrationPreview
  userDataPath: string
  sources: EnsureEmbeddingF16CacheOptions[]
}

const previews = new Map<string, StoredPreview>()
let cancelRequested = false
let progress: VectorStoreMigrationProgress = {
  state: 'idle',
  completedModels: 0,
  totalModels: 0,
  writtenBytes: 0,
  errors: [],
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
}

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 96) || 'unknown'
}

function sourceStats(paths: string[]): { bytes: number; modifiedAt: number } | null {
  try {
    let bytes = 0
    let modifiedAt = 0
    for (const sourcePath of paths) {
      const stat = fs.statSync(sourcePath)
      if (!stat.isFile()) return null
      bytes += stat.size
      modifiedAt = Math.max(modifiedAt, stat.mtimeMs)
    }
    return { bytes, modifiedAt }
  } catch {
    return null
  }
}

function importWithTailHash(source: {
  path: string
  size: number
  mtimeMs: number
}): AuthoritativeVectorStoreEntry['imports'][number] {
  const stat = fs.statSync(source.path)
  if (!stat.isFile() || stat.size !== source.size || stat.mtimeMs !== source.mtimeMs) {
    throw new Error('Embedding source changed during vector-store migration')
  }
  return {
    ...source,
    tailSha256: sha256FileTailSync(source.path, source.size),
    chunkIntegrity: createFileChunkIntegritySync(source.path, source.size),
  }
}

export function createVectorStoreMigrationPreview(
  userDataPath: string,
  sources: EnsureEmbeddingF16CacheOptions[],
): VectorStoreMigrationPreview {
  const root = path.resolve(userDataPath)
  const storeRoot = path.join(root, 'vector-db', 'vector-store')
  const current = readCurrentAuthoritativeManifest(storeRoot)
  const eligibleSources = sources.filter((source) => Boolean(sourceStats(source.sourcePaths)))
  const models = eligibleSources.flatMap((source) => {
    const stats = sourceStats(source.sourcePaths)
    if (!stats) return []
    const existing = openAuthoritativeVectorStore(
      storeRoot,
      source.modelName,
      source.embeddingType || 'global',
      source.dim,
      false,
      source.sourcePaths,
    )
    return [
      {
        modelName: source.modelName,
        embeddingType: source.embeddingType || 'global',
        dim: source.dim,
        sourceBytes: stats.bytes,
        estimatedBinaryBytes: Math.ceil(stats.bytes * 0.1),
        alreadyCurrent: Boolean(existing),
      },
    ]
  })
  const preview: VectorStoreMigrationPreview = {
    token: randomId('vector-store-preview'),
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000,
    currentGeneration: current?.generation,
    models,
    sourceBytes: models.reduce((sum, model) => sum + model.sourceBytes, 0),
    estimatedBinaryBytes: models.reduce((sum, model) => sum + model.estimatedBinaryBytes, 0),
  }
  previews.clear()
  previews.set(preview.token, { preview, userDataPath: root, sources: eligibleSources })
  return preview
}

async function copyFileWithHash(
  source: string,
  target: string,
  isCancelled: () => boolean,
  onBytes: (bytes: number) => void,
): Promise<{ size: number; sha256: string }> {
  const hash = crypto.createHash('sha256')
  const read = fs.createReadStream(source, { highWaterMark: 1024 * 1024 })
  const write = fs.createWriteStream(target, { flags: 'wx' })
  let size = 0
  try {
    for await (const chunk of read) {
      if (isCancelled()) throw new Error('Vector store migration cancelled')
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (!write.write(buffer)) await new Promise<void>((resolve) => write.once('drain', resolve))
      hash.update(buffer)
      size += buffer.length
      onBytes(buffer.length)
    }
    await new Promise<void>((resolve, reject) => {
      write.once('error', reject)
      write.end(resolve)
    })
    return { size, sha256: hash.digest('hex') }
  } catch (error) {
    read.destroy()
    write.destroy()
    throw error
  }
}

async function writePathIndexWithOffsets(
  source: string,
  target: string,
  rowBytes: number,
  expectedCount: number,
  isCancelled: () => boolean,
  onBytes: (bytes: number) => void,
): Promise<{ size: number; sha256: string }> {
  const hash = crypto.createHash('sha256')
  const input = readline.createInterface({
    input: fs.createReadStream(source, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  const output = fs.createWriteStream(target, { flags: 'wx', encoding: 'utf8' })
  let count = 0
  let size = 0
  try {
    for await (const line of input) {
      if (isCancelled()) throw new Error('Vector store migration cancelled')
      if (!line) continue
      const parsed = JSON.parse(line) as { row?: unknown; path?: unknown }
      if (parsed.row !== count || typeof parsed.path !== 'string') {
        throw new Error('Float16 path index is not contiguous')
      }
      const encoded = `${JSON.stringify({
        row: count,
        path: parsed.path,
        offset: count * rowBytes,
      })}\n`
      if (!output.write(encoded)) {
        await new Promise<void>((resolve) => output.once('drain', resolve))
      }
      const bytes = Buffer.byteLength(encoded)
      hash.update(encoded)
      size += bytes
      onBytes(bytes)
      count += 1
    }
    if (count !== expectedCount) throw new Error('Float16 path count mismatch')
    await new Promise<void>((resolve, reject) => {
      output.once('error', reject)
      output.end(resolve)
    })
    return { size, sha256: hash.digest('hex') }
  } catch (error) {
    input.close()
    output.destroy()
    throw error
  }
}

async function executeMigration(stored: StoredPreview, taskId: string): Promise<void> {
  const storeRoot = path.join(stored.userDataPath, 'vector-db', 'vector-store')
  const generation = `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${crypto
    .randomBytes(4)
    .toString('hex')}`
  const generationsRoot = path.join(storeRoot, 'generations')
  const staging = path.join(generationsRoot, `.${generation}.tmp`)
  const finalDir = path.join(generationsRoot, generation)
  fs.mkdirSync(staging, { recursive: true })
  const entries: AuthoritativeVectorStoreEntry[] = []
  let writtenBytes = 0
  const addBytes = (bytes: number) => {
    writtenBytes += bytes
    progress = { ...progress, writtenBytes, updatedAt: Date.now() }
  }
  try {
    for (const source of stored.sources) {
      if (cancelRequested) throw new Error('Vector store migration cancelled')
      progress = {
        ...progress,
        currentModel: source.modelName,
        updatedAt: Date.now(),
      }
      const extension = await extendEmbeddingF16Cache({
        ...source,
        isCancelled: () => cancelRequested || Boolean(source.isCancelled?.()),
      })
      const cache =
        extension ??
        (await ensureEmbeddingF16Cache({
          ...source,
          preferAuthoritative: false,
          isCancelled: () => cancelRequested || Boolean(source.isCancelled?.()),
        }))
      if (!cache) throw new Error(`Could not build ${source.modelName} Float16 import`)
      const base = `${safePart(source.modelName)}__${safePart(source.embeddingType || 'global')}`
      const vectorName = `${base}.f16`
      const pathName = `${base}.paths.jsonl`
      const vectors = await copyFileWithHash(
        cache.vectorPath,
        path.join(staging, vectorName),
        () => cancelRequested,
        addBytes,
      )
      const paths = await writePathIndexWithOffsets(
        cache.pathIndexPath,
        path.join(staging, pathName),
        cache.meta.dim * 2,
        cache.meta.count,
        () => cancelRequested,
        addBytes,
      )
      const imports = cache.meta.sourceFiles.map(importWithTailHash)
      entries.push({
        modelName: cache.meta.modelName,
        embeddingType: cache.meta.embeddingType,
        dim: cache.meta.dim,
        dtype: AUTHORITATIVE_VECTOR_DTYPE,
        count: cache.meta.count,
        sourceRecordCount: cache.meta.sourceRecordCount,
        imports,
        vectors: { name: vectorName, ...vectors },
        paths: { name: pathName, ...paths },
      })
      progress = {
        ...progress,
        completedModels: progress.completedModels + 1,
        updatedAt: Date.now(),
      }
    }
    for (const entry of entries) {
      for (const source of entry.imports) {
        const current = importWithTailHash(source)
        if (
          current.tailSha256 !== source.tailSha256 ||
          !source.chunkIntegrity ||
          !verifyFileChunkIntegritySync(source.path, source.size, source.chunkIntegrity)
        ) {
          throw new Error('Embedding source integrity changed during vector-store migration')
        }
      }
    }
    const manifestPath = path.join(staging, 'manifest.json')
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          version: AUTHORITATIVE_VECTOR_STORE_VERSION,
          generation,
          createdAt: Date.now(),
          entries,
        },
        null,
        2,
      ),
      { encoding: 'utf8', flag: 'wx' },
    )
    const manifestSha256 = sha256FileSync(manifestPath)
    fs.renameSync(staging, finalDir)
    if (!readCurrentAuthoritativeManifestFromGeneration(finalDir, generation, manifestSha256)) {
      throw new Error('New vector generation validation failed')
    }
    fs.mkdirSync(storeRoot, { recursive: true })
    const currentTmp = path.join(storeRoot, `CURRENT.${taskId}.tmp`)
    fs.writeFileSync(
      currentTmp,
      JSON.stringify(
        {
          version: AUTHORITATIVE_VECTOR_STORE_VERSION,
          generation,
          manifestSha256,
          switchedAt: Date.now(),
        },
        null,
        2,
      ),
      { encoding: 'utf8', flag: 'wx' },
    )
    // The old generation may still be held by the ANN worker. Release it
    // before CURRENT changes so no old vectors, paths, or projections remain reachable.
    disposeVectorAnnWorker()
    fs.renameSync(currentTmp, path.join(storeRoot, 'CURRENT'))
    // CURRENT switched: every increment directory anchored on the previous
    // generation is permanently stale (its base generation and source anchors
    // can never match again), so the executor removes it instead of leaving
    // an orphan (D3 stage 2 housekeeping rule).
    for (const source of stored.sources) {
      discardEmbeddingIncrement(storeRoot, source.modelName, source.embeddingType || 'global')
    }
    // VAL-031: the new generation is live — warm its ANN index in the
    // background (deduplicated per generation, preemptible by real searches)
    // so the first similarity search skips the cold full build.
    void scheduleAuthoritativeAnnPrewarm(
      path.join(stored.userDataPath, 'vector-db', 'embedding-cache'),
    )
    progress = {
      ...progress,
      state: 'completed',
      generation,
      currentModel: undefined,
      finishedAt: Date.now(),
      updatedAt: Date.now(),
    }
  } catch (error) {
    const cancelled = cancelRequested || String(error).toLowerCase().includes('cancelled')
    progress = {
      ...progress,
      state: cancelled ? 'cancelled' : 'error',
      currentModel: undefined,
      errors: cancelled
        ? []
        : [...progress.errors, error instanceof Error ? error.message : String(error)].slice(-20),
      finishedAt: Date.now(),
      updatedAt: Date.now(),
    }
  } finally {
    try {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true })
    } catch {
      /* An incomplete staging generation is never referenced by CURRENT. */
    }
  }
}

function readCurrentAuthoritativeManifestFromGeneration(
  generationDir: string,
  generation: string,
  manifestSha256: string,
): boolean {
  try {
    if (sha256FileSync(path.join(generationDir, 'manifest.json')) !== manifestSha256) return false
    const manifest = JSON.parse(
      fs.readFileSync(path.join(generationDir, 'manifest.json'), 'utf8'),
    ) as { generation?: unknown; entries?: Array<AuthoritativeVectorStoreEntry> }
    if (manifest.generation !== generation || !Array.isArray(manifest.entries)) return false
    return manifest.entries.every(
      (entry) =>
        sha256FileSync(path.join(generationDir, entry.vectors.name)) === entry.vectors.sha256 &&
        sha256FileSync(path.join(generationDir, entry.paths.name)) === entry.paths.sha256,
    )
  } catch {
    return false
  }
}

export function startVectorStoreMigration(
  userDataPath: string,
  token: string,
): { ok: boolean; taskId?: string; error?: string } {
  if (progress.state === 'running') {
    return { ok: false, error: 'Vector store migration is already running' }
  }
  const stored = previews.get(token)
  if (!stored || stored.userDataPath !== path.resolve(userDataPath)) {
    return { ok: false, error: 'Migration preview is missing or no longer valid' }
  }
  if (stored.preview.expiresAt < Date.now()) {
    previews.delete(token)
    return { ok: false, error: 'Migration preview expired; scan again before confirming' }
  }
  if (stored.sources.length === 0) return { ok: false, error: 'No vector sources are available' }
  try {
    const disk = fs.statfsSync(stored.userDataPath)
    const availableBytes = disk.bavail * disk.bsize
    const requiredBytes = stored.preview.estimatedBinaryBytes + 256 * 1024 * 1024
    if (availableBytes < requiredBytes) {
      return {
        ok: false,
        error: `Not enough free space for migration (${requiredBytes.toLocaleString()} bytes required)`,
      }
    }
  } catch (error: unknown) {
    return {
      ok: false,
      error: `Could not verify free space: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const taskId = randomId('vector-store-migration')
  previews.delete(token)
  cancelRequested = false
  progress = {
    taskId,
    state: 'running',
    completedModels: 0,
    totalModels: stored.sources.length,
    writtenBytes: 0,
    errors: [],
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
  void executeMigration(stored, taskId)
  return { ok: true, taskId }
}

export function getVectorStoreMigrationProgress(): VectorStoreMigrationProgress {
  return { ...progress, errors: [...progress.errors] }
}

export function cancelVectorStoreMigration(): { ok: boolean } {
  if (progress.state !== 'running') return { ok: false }
  cancelRequested = true
  return { ok: true }
}

export function isVectorStoreMigrationRunning(): boolean {
  return progress.state === 'running'
}

export function resetVectorStoreMigrationForTests(): void {
  previews.clear()
  cancelRequested = false
  progress = {
    state: 'idle',
    completedModels: 0,
    totalModels: 0,
    writtenBytes: 0,
    errors: [],
  }
}
