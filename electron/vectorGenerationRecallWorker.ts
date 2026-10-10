import { parentPort } from 'node:worker_threads'
import {
  evaluateGenerationRecall,
  RecallEvaluationCancelledError,
  type GenerationRecallVectorSource,
  type RecallThresholds,
} from './vectorGenerationRecall'

/**
 * Low-priority host for the VAL-003 recall observation cycle. The heavy F32
 * scan runs off the main thread; the host stops it cooperatively through a
 * SharedArrayBuffer flag and recycles the worker after an idle timeout.
 */

interface RecallWorkerOptions {
  queryCount?: number
  topK?: number
  seed?: number
  thresholds?: RecallThresholds
  memoryCeilingBytes?: number
  matrixCacheDir?: string
}

interface EvaluateMessage {
  type: 'evaluate'
  requestId: number
  jsonlPaths: string[]
  handle: GenerationRecallVectorSource
  options: RecallWorkerOptions
  stopBuffer: SharedArrayBuffer
}

const port = parentPort
if (!port) throw new Error('vectorGenerationRecallWorker must run inside a worker thread')

port.on('message', async (message: EvaluateMessage) => {
  if (!message || message.type !== 'evaluate') return
  const stopView = new Int32Array(message.stopBuffer)
  try {
    const report = await evaluateGenerationRecall(message.jsonlPaths, message.handle, {
      ...message.options,
      isCancelled: () => Atomics.load(stopView, 0) === 1,
      onProgress: (info) => {
        port.postMessage({ type: 'progress', requestId: message.requestId, ...info })
      },
    })
    port.postMessage({ type: 'result', requestId: message.requestId, report })
  } catch (error) {
    if (error instanceof RecallEvaluationCancelledError) {
      port.postMessage({ type: 'cancelled', requestId: message.requestId })
      return
    }
    port.postMessage({
      type: 'error',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
