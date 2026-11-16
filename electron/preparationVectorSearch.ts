import { getPreparationSearchRevision } from './preparationSearchState'
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { app } from 'electron'
import { getEmbeddingStorePaths } from './vectorDatabaseService'
import type { SemanticClipCandidate } from './semanticClipScan'

export async function searchPreparedVectorSnapshot(
  model: string,
  dim: number,
  query: number[] | Float32Array,
  topK: number,
  isCancelled?: () => boolean,
  scope?: readonly string[],
): Promise<{ candidates: SemanticClipCandidate[]; scanned: number }> {
  if (isCancelled?.()) throw Error('Vector search cancelled')
  const revision = getPreparationSearchRevision()
  const sources = getEmbeddingStorePaths(model, 'global').map((file) => {
    const stat = fs.statSync(file)
    return { path: file, size: stat.size, ino: stat.ino, dev: stat.dev }
  })
  if (!sources.length) return { candidates: [], scanned: 0 }
  const stop = new SharedArrayBuffer(4)
  const workerFile = app.isPackaged
    ? path.join(process.resourcesPath, 'preparationVectorWorker.js')
    : path.join(__dirname, 'preparationVectorWorker.js')
  const worker = new Worker(workerFile, {
    workerData: { sources, model, dim, query: [...query], topK, stop, scope },
  })
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    const result = await new Promise<{ candidates: SemanticClipCandidate[]; scanned: number }>(
      (resolve, reject) => {
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
      },
    )
    if (isCancelled?.()) throw Error('Vector search cancelled')
    if (getPreparationSearchRevision() !== revision)
      throw Error('Indexed materials changed during search; please retry')
    return result
  } finally {
    clearInterval(timer)
    await worker.terminate()
  }
}
