import { embeddingCachePathKey } from './embeddingF16Cache'
import {
  getPreparationSearchRevision,
  isPreparedSearchMutationActive,
} from './preparationSearchState'
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { app } from 'electron'
import {
  getEmbeddingStorePaths,
  removeImageDataBatch,
  appendGlobalEmbeddingInvalidationTombstonesAsync,
  flushVectorDatabaseWrites,
} from './vectorDatabaseService'
import { invalidatePreparedInputs } from './preparationSearchState'
import type { SemanticClipCandidate } from './semanticClipScan'

export async function searchPreparedVectorSnapshot(
  model: string,
  dim: number,
  query: number[] | Float32Array,
  topK: number,
  isCancelled?: () => boolean,
  scope?: readonly string[],
  inventory = false,
): Promise<{ candidates: SemanticClipCandidate[]; scanned: number; paths?: string[] }> {
  if (isCancelled?.()) throw Error('Vector search cancelled')
  if (isPreparedSearchMutationActive()) throw Error('Indexed materials are updating; please retry')
  const revision = getPreparationSearchRevision()
  const sources = getEmbeddingStorePaths(model, 'global').map((file) => {
    const stat = fs.statSync(file)
    return { path: file, size: stat.size, ino: stat.ino, dev: stat.dev }
  })
  if (!sources.length) return { candidates: [], scanned: 0 }
  const stop = new SharedArrayBuffer(4)
  const workerFile = app.isPackaged
    ? path.join(process.resourcesPath, 'preparationVectorWorker.js')
    : fs.existsSync(path.join(__dirname, 'preparationVectorWorker.js'))
      ? path.join(__dirname, 'preparationVectorWorker.js')
      : path.join(__dirname, '..', 'dist-electron', 'preparationVectorWorker.js')
  const worker = new Worker(workerFile, {
    workerData: {
      sources,
      model,
      dim,
      query: [...query],
      topK,
      stop,
      scope,
      inventory,
      vectorDbDir: path.join(app.getPath('userData'), 'vector-db'),
    },
  })
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    const result = await new Promise<{
      candidates: SemanticClipCandidate[]
      scanned: number
      paths?: string[]
    }>((resolve, reject) => {
      worker.once('message', (message) =>
        message.error ? reject(Error(message.error)) : resolve(message.result),
      )
      worker.once('error', reject)
      worker.once('exit', () =>
        reject(Error('Prepared vector worker exited before returning results')),
      )
      timer = setInterval(() => {
        if (isCancelled?.()) {
          Atomics.store(new Int32Array(stop), 0, 1)
          reject(Error('Vector search cancelled'))
        }
      }, 50)
    })
    if (isCancelled?.()) throw Error('Vector search cancelled')
    if (getPreparationSearchRevision() !== revision)
      throw Error('Indexed materials changed during search; please retry')
    return result
  } finally {
    clearInterval(timer)
    await worker.terminate()
  }
}

export async function collectPreparedInputPaths(
  isCancelled?: () => boolean,
): Promise<ReadonlySet<string>> {
  const snapshots = await Promise.all([
    searchPreparedVectorSnapshot('dinov2_vitb14', 768, [1], 1, isCancelled, undefined, true),
    searchPreparedVectorSnapshot(
      'clip_vit_base_patch32',
      512,
      [1],
      1,
      isCancelled,
      undefined,
      true,
    ),
  ])
  return new Set(snapshots.flatMap((snapshot) => snapshot.paths || []))
}
export async function invalidatePreparedVectorPaths(
  paths: readonly string[],
  known?: ReadonlySet<string>,
): Promise<void> {
  const previous = known
    ? paths.filter((file) => known.has(embeddingCachePathKey(file)))
    : [...paths]
  await invalidatePreparedInputs(
    () => {
      removeImageDataBatch(paths)
      return previous.length
    },
    async () => {
      if (previous.length) await appendGlobalEmbeddingInvalidationTombstonesAsync(previous)
      await flushVectorDatabaseWrites()
    },
  )
}
