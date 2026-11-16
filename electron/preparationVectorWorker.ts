import { embeddingCachePathKey } from './embeddingF16Cache'
import { collectExistingEmbeddingIds } from './embeddingExistingIndex'
import fs from 'node:fs'
import readline from 'node:readline'
import { parentPort, workerData } from 'node:worker_threads'
import {
  requireNormalizedEmbeddingVector,
  validateEmbeddingVector,
} from './embeddingVectorValidation'
import { BoundedSemanticCandidateHeap } from './semanticClipScan'

// Each file is pinned by identity and a byte boundary. Appends after that
// boundary are invisible to both passes. Incomplete last lines are not rows.
interface PreparedSnapshotRequest {
  sources: Array<{ path: string; size: number; ino: number; dev: number }>
  model: string
  dim: number
  query: number[]
  topK: number
  stop?: SharedArrayBuffer
  scope?: string[]
  inventory?: boolean
  vectorDbDir?: string
}
export async function scanPreparedVectors(input: PreparedSnapshotRequest) {
  const latest = new Map<string, number>()
  const handles: fs.promises.FileHandle[] = []
  const stop = input.stop && new Int32Array(input.stop)
  const cancelled = () => {
    if (stop && Atomics.load(stop, 0)) throw Error('Vector search cancelled')
  }
  const key = embeddingCachePathKey
  const allowed = input.scope && new Set<string>(input.scope.map(key))
  if (input.inventory) {
    const paths = await collectExistingEmbeddingIds({
      vectorDbDir: input.vectorDbDir!,
      modelName: input.model,
      embeddingType: 'global',
      dim: input.dim,
      sourcePaths: input.sources.map((source) => source.path),
      isCancelled: () => Boolean(stop && Atomics.load(stop, 0)),
    })
    cancelled()
    return { candidates: [], scanned: paths.size, paths: [...paths].map(key) }
  }
  const query = requireNormalizedEmbeddingVector(input.query, input.dim)
  const heap = new BoundedSemanticCandidateHeap(input.topK)
  let rows = 0
  try {
    for (const source of input.sources) {
      const handle = await fs.promises.open(source.path, 'r')
      handles.push(handle)
      const stat = await handle.stat()
      if (stat.ino !== source.ino || stat.dev !== source.dev || stat.size < source.size)
        throw Error('Vector source changed before snapshot acquisition')
    }
    for (let pass = 0; pass < 2; pass++) {
      let ordinal = 0
      for (let file = 0; file < handles.length; file++) {
        const size = input.sources[file].size
        if (!size) continue
        // Find the last committed line; never parse a partially written JSON row.
        const tail = Buffer.alloc(Math.min(size, 1024 * 1024))
        await handles[file].read(tail, 0, tail.length, size - tail.length)
        const newline = tail.lastIndexOf(10)
        if (newline < 0) continue
        const end = size - tail.length + newline
        const reader = readline.createInterface({
          input: fs.createReadStream('', {
            fd: handles[file].fd,
            autoClose: false,
            start: 0,
            end,
          }),
          crlfDelay: Infinity,
        })
        try {
          for await (const line of reader) {
            cancelled()
            if (!line) continue
            let row: {
              modelName?: string
              embeddingType?: string
              imageId?: string
              dim?: number
              vector?: number[]
            }
            try {
              row = JSON.parse(line)
            } catch {
              continue
            }
            if (
              row.modelName !== input.model ||
              row.embeddingType !== 'global' ||
              typeof row.imageId !== 'string'
            )
              continue
            const pathKey = key(row.imageId)
            const id = ++ordinal
            if (allowed && !allowed.has(pathKey)) continue
            const valid = row.dim === input.dim && validateEmbeddingVector(row.vector, input.dim).ok
            if (pass === 0) latest.set(pathKey, valid ? id : -id)
            else if (valid && latest.get(pathKey) === id) {
              const vector = requireNormalizedEmbeddingVector(row.vector, input.dim)
              let dot = 0
              for (let d = 0; d < input.dim; d++) dot += query[d] * vector[d]
              heap.offer(pathKey, row.imageId, Math.max(0, Math.min(1, (dot + 1) / 2)), dot, id)
              rows++
            }
          }
        } finally {
          reader.close()
        }
      }
    }
    return {
      candidates: heap
        .values()
        .sort((a, b) => b.score - a.score || key(a.path).localeCompare(key(b.path))),
      scanned: rows,
    }
  } finally {
    await Promise.all(handles.map((h) => h.close()))
  }
}

if (parentPort)
  scanPreparedVectors(workerData).then(
    (result) => parentPort!.postMessage({ result }),
    (error) =>
      parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }),
  )
