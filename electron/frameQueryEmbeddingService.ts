import fs from 'fs'
import path from 'path'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { getModelInfo, getModelStatus } from './modelService'
import { getVisionModelCapability, type VisionModelName } from './modelRegistry'
import { requireNormalizedEmbeddingVector } from './embeddingVectorValidation'
import {
  decodeEmbeddingChildVector,
  EmbeddingChildBinaryFrameDecoder,
  type EmbeddingChildBinaryFrame,
} from './embeddingChildBinaryProtocol'

type MediaFrameModelName = VisionModelName

interface QueryEmbeddingResult {
  ok: boolean
  vector?: number[]
  dim?: number
  error?: string
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function getChildPath(modelName: MediaFrameModelName): string {
  const fileName = getVisionModelCapability(modelName).childEntry
  const candidates = [
    path.join(__dirname, fileName),
    path.join(process.resourcesPath || '', fileName),
  ]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* try next */
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

function spawnEmbeddingChild(modelName: MediaFrameModelName): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [getChildPath(modelName)], {
    env: buildChildEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stderr.setEncoding('utf8')
  return child
}

export async function embedImageForMediaSearch(input: {
  imagePath: string
  modelName: MediaFrameModelName
  backend?: 'cpu' | 'gpu'
  timeoutMs?: number
}): Promise<QueryEmbeddingResult> {
  const modelInfo = getModelInfo(input.modelName)
  if (!modelInfo) return { ok: false, error: `Unknown model: ${input.modelName}` }
  const dim = modelInfo.dim

  const modelStatus = getModelStatus(input.modelName)
  if (modelStatus.state !== 'downloaded' || !modelStatus.installedPath) {
    return { ok: false, error: `Model not ready: ${modelStatus.state}` }
  }
  if (!fs.existsSync(input.imagePath)) {
    return { ok: false, error: 'Query image file is missing' }
  }

  return new Promise<QueryEmbeddingResult>((resolve) => {
    const child = spawnEmbeddingChild(input.modelName)
    let lastStderr = ''
    const stdoutFramer = new EmbeddingChildBinaryFrameDecoder()
    let settled = false
    let taskSent = false
    const timeout = setTimeout(
      () => {
        finish({ ok: false, error: 'Query image embedding timed out' })
      },
      Math.max(10_000, input.timeoutMs ?? 120_000),
    )

    function finish(result: QueryEmbeddingResult): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      try {
        child.kill()
      } catch {
        /* already exited */
      }
      resolve(result)
    }

    function sendTask(): void {
      if (settled || taskSent) return
      taskSent = true
      const payload = `${JSON.stringify({
        id: 1,
        imageId: input.imagePath,
        imagePath: input.imagePath,
        modelPath: modelStatus.installedPath,
        dim,
        batchSize: 1,
        backend: input.backend,
      })}\n`
      try {
        child.stdin.write(payload, (err) => {
          if (err)
            finish({ ok: false, error: `Query image embedding write failed: ${err.message}` })
        })
      } catch (err: unknown) {
        finish({ ok: false, error: `Query image embedding write failed: ${errorMessage(err)}` })
      }
    }

    function handleFrame(frame: EmbeddingChildBinaryFrame): void {
      if (settled) return
      const message = frame.header
      if (message.type === 'ready') {
        sendTask()
        return
      }
      if (message.id !== 1) return
      if (message.ok === true) {
        try {
          const vector = decodeEmbeddingChildVector(frame, dim)
          finish({ ok: true, vector: requireNormalizedEmbeddingVector(vector, dim), dim })
        } catch (error) {
          finish({ ok: false, error: `Query image embedding is invalid: ${errorMessage(error)}` })
        }
        return
      }
      finish({
        ok: false,
        error:
          typeof message.error === 'string'
            ? message.error
            : lastStderr || 'Query image embedding failed',
      })
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const frame = stdoutFramer.push(chunk)
      if (frame.overflow) {
        finish({
          ok: false,
          error: 'Query image embedding child emitted an invalid or oversized binary frame',
        })
        return
      }
      for (const message of frame.frames) handleFrame(message)
    })
    child.stdin.on('error', (err) => {
      finish({ ok: false, error: `Query image embedding write failed: ${err.message}` })
    })
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text) lastStderr = text.slice(-1000)
    })
    child.on('error', (err) => {
      finish({ ok: false, error: `Query image embedding child failed: ${err.message}` })
    })
    child.on('exit', (code, signal) => {
      if (settled) return
      finish({
        ok: false,
        error: `Query image embedding child exited: code=${code ?? 'null'} signal=${signal ?? 'null'}${
          lastStderr ? ` ${lastStderr}` : ''
        }`,
      })
    })
  })
}
