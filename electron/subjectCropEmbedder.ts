// ── Subject Crop Embedder ──────────────────────────────────
// Persistent DINOv2 embedding child for subject-crop reranking.
// The one-shot spawnEmbedding() in subjectSearchService pays a model
// load per image; this class keeps one child alive and streams tasks
// through it (the child batches up to 16 per inference pass), so
// reranking 100 candidate crops costs one model load total.

import fs from 'fs'
import path from 'path'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import {
  decodeEmbeddingChildVector,
  EmbeddingChildBinaryFrameDecoder,
  type EmbeddingChildBinaryFrame,
} from './embeddingChildBinaryProtocol'
import { getModelInfo, getModelStatus } from './modelService'
import { getVisionModelCapability, type VisionModelName } from './modelRegistry'

const MODEL_NAME: VisionModelName = 'dinov2_vitb14'
const TASK_TIMEOUT_MS = 120_000

function getChildPath(): string {
  const fileName = getVisionModelCapability(MODEL_NAME).childEntry
  const candidates = [
    path.join(__dirname, fileName),
    // dev / plain-node scripts: main bundle lives in dist-electron/
    path.join(__dirname, '..', 'dist-electron', fileName),
    path.join(process.resourcesPath || '', fileName),
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* next */
    }
  }
  return candidates[0]
}

function buildChildEnv(): NodeJS.ProcessEnv {
  const nodePath = [
    process.env.NODE_PATH,
    path.join(process.resourcesPath || '', 'app.asar', 'node_modules'),
    path.join(process.resourcesPath || '', 'app', 'node_modules'),
    path.join(__dirname, '..', 'node_modules'),
  ]
    .filter(Boolean)
    .join(path.delimiter)
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: nodePath }
}

interface PendingTask {
  resolve: (vector: number[] | null) => void
  timer: NodeJS.Timeout
}

export class SubjectCropEmbedder {
  private child: ChildProcessWithoutNullStreams
  private modelPath: string
  private dim: number
  private nextId = 1
  private pending = new Map<number, PendingTask>()
  private readonly stdoutDecoder = new EmbeddingChildBinaryFrameDecoder()
  private stderrTail: string[] = []
  private failed = false

  private constructor(child: ChildProcessWithoutNullStreams, modelPath: string, dim: number) {
    this.child = child
    this.modelPath = modelPath
    this.dim = dim
  }

  /** null when the DINO model is not installed/ready. */
  static async create(): Promise<SubjectCropEmbedder | null> {
    const modelInfo = getModelInfo(MODEL_NAME)
    if (!modelInfo) return null
    const modelStatus = getModelStatus(MODEL_NAME)
    if (modelStatus.state !== 'downloaded' || !modelStatus.installedPath) return null

    const child = spawn(process.execPath, [getChildPath()], {
      env: buildChildEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const embedder = new SubjectCropEmbedder(child, modelStatus.installedPath, modelInfo.dim)
    const ready = await embedder.waitForReady()
    if (!ready) {
      // never leave a spawned-but-unusable child running
      try {
        child.kill()
      } catch {
        /* ok */
      }
      return null
    }
    return embedder
  }

  private waitForReady(): Promise<boolean> {
    return new Promise((resolve) => {
      let ready = false
      let settled = false
      const settle = (value: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        this.failPending()
        settle(false)
      }, TASK_TIMEOUT_MS)

      this.child.stdout.on('data', (chunk: Buffer) => {
        const decoded = this.stdoutDecoder.push(chunk)
        if (decoded.overflow) {
          this.failPending()
          settle(false)
          try {
            this.child.kill()
          } catch {
            /* ok */
          }
          return
        }
        for (const frame of decoded.frames) {
          if (!ready && frame.header.type === 'ready') {
            ready = true
            settle(true)
            continue
          }
          if (ready) this.handleResult(frame)
        }
      })
      this.child.stderr.setEncoding('utf8')
      this.child.stderr.on('data', (chunk: string) => {
        const text = chunk.trim()
        if (text) this.stderrTail.push(text.slice(0, 500))
        if (this.stderrTail.length > 5) this.stderrTail.shift()
      })
      this.child.on('error', () => {
        this.failPending()
        settle(false)
      })
      this.child.on('exit', () => {
        this.failPending()
        settle(false)
      })
    })
  }

  private failPending(): void {
    this.failed = true
    for (const [, task] of this.pending) {
      clearTimeout(task.timer)
      task.resolve(null)
    }
    this.pending.clear()
  }

  private handleResult(frame: EmbeddingChildBinaryFrame): void {
    const { id, ok } = frame.header
    if (!Number.isSafeInteger(id)) return
    const task = this.pending.get(id as number)
    if (!task) return
    this.pending.delete(id as number)
    clearTimeout(task.timer)
    if (ok !== true) {
      task.resolve(null)
      return
    }
    try {
      task.resolve(decodeEmbeddingChildVector(frame, this.dim) ?? null)
    } catch {
      task.resolve(null)
    }
  }

  /** Embed one crop; null on any failure (caller degrades). */
  embed(imagePath: string): Promise<number[] | null> {
    if (this.failed) return Promise.resolve(null)
    const id = this.nextId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(null)
      }, TASK_TIMEOUT_MS)
      this.pending.set(id, { resolve, timer })
      const payload = `${JSON.stringify({
        id,
        imageId: imagePath,
        imagePath,
        modelPath: this.modelPath,
        dim: this.dim,
        batchSize: 16,
      })}\n`
      try {
        this.child.stdin.write(payload, (err) => {
          if (err) {
            this.pending.delete(id)
            clearTimeout(timer)
            resolve(null)
          }
        })
      } catch {
        this.pending.delete(id)
        clearTimeout(timer)
        resolve(null)
      }
    })
  }

  async dispose(): Promise<void> {
    this.failPending()
    try {
      this.child.kill()
    } catch {
      /* ok */
    }
  }
}
