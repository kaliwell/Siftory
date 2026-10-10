import fs from 'fs'
import path from 'path'
import { Worker } from 'worker_threads'
import { app } from 'electron'

/**
 * Shared host for NekoSearch long-task workers (worker_threads).
 *
 * Follows the duplicateFinder pattern: one-shot workerData input, a
 * SharedArrayBuffer/Atomics stop flag, progress messages relayed to the
 * caller, and a single result message. Database writes stay in the main
 * process; workers only compute.
 */

export type AssetTaskWorkerMessage<TProgress, TResult> =
  | { type: 'progress'; progress: TProgress }
  | { type: 'result'; result: TResult }
  | { type: 'stopped' }
  | { type: 'error'; error: string }

export interface AssetTaskWorkerRunOptions<TProgress> {
  /** Worker bundle file name, e.g. 'assetSimilarSearchWorker.js'. */
  workerFile: string
  /** Structured-cloneable payload passed as workerData.input. */
  input: unknown
  onProgress: (progress: TProgress) => void
}

/** Rejection raised when the task was cancelled through the stop flag. */
export class AssetTaskWorkerCancelledError extends Error {
  constructor() {
    super('Asset library task cancelled')
    this.name = 'AssetTaskWorkerCancelledError'
  }
}

let activeWorkerCancel: (() => void) | null = null

/**
 * Cancels the currently running asset task worker. Called from
 * stopAssetLibraryTask so the worker stop flag mirrors task.cancelled.
 */
export function cancelActiveAssetTaskWorker(): void {
  activeWorkerCancel?.()
}

export function assetTaskWorkerPath(fileName: string): string {
  if (app.isPackaged) return path.join(process.resourcesPath, fileName)
  const local = path.join(__dirname, fileName)
  if (fs.existsSync(local)) return local
  // Scripts that load the service through tests/guard-utils (loadTsModule)
  // resolve electron/ as __dirname while the built worker bundles only exist
  // under dist-electron/.
  return path.join(__dirname, '..', 'dist-electron', fileName)
}

/**
 * Runs one worker task to completion. Progress messages are relayed; a
 * 'stopped' message rejects with AssetTaskWorkerCancelledError (the
 * /cancelled/i message lets startTask classify the outcome as 'stopped').
 */
export function runAssetTaskWorker<TProgress, TResult>(
  options: AssetTaskWorkerRunOptions<TProgress>,
): Promise<TResult> {
  return new Promise((resolve, reject) => {
    const stopBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const stopView = new Int32Array(stopBuffer)
    const cancel = () => {
      Atomics.store(stopView, 0, 1)
    }
    let settled = false
    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      if (activeWorkerCancel === cancel) activeWorkerCancel = null
      finish()
    }
    activeWorkerCancel = cancel

    const worker = new Worker(assetTaskWorkerPath(options.workerFile), {
      workerData: { input: options.input, stopBuffer },
    })
    worker.on('message', (message: AssetTaskWorkerMessage<TProgress, TResult>) => {
      if (message.type === 'progress') {
        options.onProgress(message.progress)
        return
      }
      if (message.type === 'result') {
        settle(() => resolve(message.result))
        return
      }
      if (message.type === 'stopped') {
        settle(() => reject(new AssetTaskWorkerCancelledError()))
        return
      }
      if (message.type === 'error') {
        settle(() => reject(new Error(message.error)))
      }
    })
    worker.once('error', (error) => settle(() => reject(error)))
    worker.once('exit', (code) => {
      if (!settled) settle(() => reject(new Error(`Asset task worker exited (${code})`)))
    })
  })
}
