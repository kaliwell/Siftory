import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { classifyProjectFile } from '../shared/projectFileTypes'
import { populateExistingEmbeddingIdsFromFastIndex } from './embeddingExistingIndex'
import { filterSupportedEmbeddingInputs } from './embeddingInputValidation'
import { ProjectPreviewManifestStore } from './projectPreviewManifest'
import { validateEmbeddingVector } from './embeddingVectorValidation'
import { embeddingCachePathKey } from './embeddingF16Cache'
import { EmbeddingPreparationSpool } from './embeddingPreparationSpool'

interface PreparationRequest {
  scanPaths: string[]
  userDataPath: string
  vectorDbDir: string
  modelName: string
  embeddingType: string
  dim: number
  sourcePaths: string[]
  chunkSize?: number
}

interface AckWaiter {
  resolve: () => void
  reject: (error: Error) => void
}

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.psd',
  '.psb',
  '.kra',
  '.svg',
  '.pdf',
  '.ai',
  '.eps',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.dng',
  '.raf',
  '.orf',
  '.rw2',
  '.pef',
  '.srw',
  '.clip',
  '.cdr',
  '.indd',
])

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function pathKey(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

async function collectExisting(
  request: PreparationRequest,
  spool: EmbeddingPreparationSpool,
): Promise<number> {
  if (request.sourcePaths.length === 0) return 0
  spool.beginExistingLoad()
  const fast = await populateExistingEmbeddingIdsFromFastIndex(
    {
      vectorDbDir: request.vectorDbDir,
      modelName: request.modelName,
      embeddingType: request.embeddingType,
      dim: request.dim,
      sourcePaths: request.sourcePaths,
      onProgress: ({ phase, bytesRead, totalBytes, existingCount }) => {
        send({
          type: 'progress',
          message: `Reading existing vector ${phase}: ${
            totalBytes > 0 ? Math.round((bytesRead / totalBytes) * 100) : 0
          }% (${existingCount.toLocaleString()} found)`,
        })
      },
    },
    spool,
  )
  if (fast) {
    spool.endExistingLoad()
    return spool.size
  }

  for (const filePath of request.sourcePaths) {
    const lines = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    for await (const line of lines) {
      if (!line) continue
      try {
        const row = JSON.parse(line) as {
          imageId?: unknown
          modelName?: unknown
          embeddingType?: unknown
          dim?: unknown
          vector?: unknown
        }
        if (
          row.modelName === request.modelName &&
          row.embeddingType === request.embeddingType &&
          typeof row.imageId === 'string'
        ) {
          const key = embeddingCachePathKey(row.imageId)
          if (row.dim === request.dim && validateEmbeddingVector(row.vector, request.dim).ok) {
            spool.add(key)
          } else spool.delete(key)
        }
      } catch {
        // Ignore a damaged JSONL row and continue preparing the remaining files.
      }
    }
  }
  spool.endExistingLoad()
  return spool.size
}

async function run(
  request: PreparationRequest,
  waitForAck: (sequence: number) => Promise<void>,
): Promise<void> {
  const spool = new EmbeddingPreparationSpool()
  try {
    const manifest = new ProjectPreviewManifestStore(request.userDataPath)
    for (const entry of await manifest.list()) {
      if (entry.status === 'ready' && entry.previewPath) {
        spool.addProjectPreview(pathKey(entry.sourcePath), entry.previewPath)
      }
    }
    const existingCount = await collectExisting(request, spool)
    const stack = request.scanPaths.map((item) => path.resolve(item))
    let scannedDirs = 0
    let discovered = 0
    let skippedExisting = 0

    while (stack.length > 0) {
      const directory = stack.pop()!
      scannedDirs++
      if (scannedDirs === 1 || scannedDirs % 250 === 0) {
        send({
          type: 'progress',
          message: `Preparing in data process: ${discovered.toLocaleString()} files, ${scannedDirs.toLocaleString()} dirs`,
        })
      }
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const fullPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          stack.push(fullPath)
        } else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          discovered++
          if (spool.hasExisting(embeddingCachePathKey(fullPath))) {
            skippedExisting++
            continue
          }
          const project = classifyProjectFile(fullPath)
          const imagePath = project ? spool.findProjectPreview(pathKey(fullPath)) : fullPath
          if (!imagePath) continue
          spool.addCandidate(embeddingCachePathKey(fullPath), { imageId: fullPath, imagePath })
        }
      }
    }

    let checked = 0
    let rejected = 0
    let accepted = 0
    let sequence = 1
    const chunkSize = Math.max(1, Math.min(256, Math.floor(request.chunkSize || 256)))
    while (spool.candidateCount() > 0) {
      const window = spool.peekCandidates(chunkSize)
      const validation = await filterSupportedEmbeddingInputs(window.items, {
        cachePath: path.join(request.vectorDbDir, 'embedding-input-rejections.json'),
      })
      checked += window.items.length
      rejected += validation.rejected
      accepted += validation.accepted.length
      if (validation.accepted.length > 0) {
        const acknowledged = waitForAck(sequence)
        send({
          type: 'chunk',
          sequence,
          items: validation.accepted,
        })
        await acknowledged
        sequence++
      }
      spool.acknowledgeCandidates(window.ids)
      if (checked === window.items.length || checked % 4096 < window.items.length) {
        send({
          type: 'progress',
          message: `Validating in data process: ${checked.toLocaleString()} / ${(checked + spool.candidateCount()).toLocaleString()} (${rejected.toLocaleString()} rejected)`,
        })
      }
    }
    send({
      type: 'done',
      discovered,
      skippedExisting,
      rejected,
      accepted,
      existing: existingCount,
    })
  } finally {
    spool.dispose()
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const ackWaiters = new Map<number, AckWaiter>()
let requestStarted = false

function waitForAck(sequence: number): Promise<void> {
  return new Promise((resolve, reject) => ackWaiters.set(sequence, { resolve, reject }))
}

input.on('line', (line) => {
  if (requestStarted) {
    try {
      const message = JSON.parse(line) as { type?: unknown; sequence?: unknown }
      if (message.type !== 'ack' || !Number.isSafeInteger(message.sequence)) return
      const waiter = ackWaiters.get(message.sequence as number)
      if (!waiter) return
      ackWaiters.delete(message.sequence as number)
      waiter.resolve()
    } catch {
      // Ignore malformed control lines; the parent timeout/exit boundary remains authoritative.
    }
    return
  }
  requestStarted = true
  let request: PreparationRequest
  try {
    request = JSON.parse(line) as PreparationRequest
  } catch (error) {
    send({ type: 'error', error: error instanceof Error ? error.message : String(error) })
    process.exitCode = 1
    return
  }
  void run(request, waitForAck)
    .catch((error) => {
      send({ type: 'error', error: error instanceof Error ? error.message : String(error) })
      process.exitCode = 1
    })
    .finally(() => input.close())
})

input.on('close', () => {
  for (const waiter of ackWaiters.values()) waiter.reject(new Error('Preparation parent closed'))
  ackWaiters.clear()
})
