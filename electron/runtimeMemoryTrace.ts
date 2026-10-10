import fs from 'fs'
import path from 'path'
import { performance } from 'perf_hooks'

export type RuntimeMemoryTraceStage =
  | 'startup'
  | 'prewarm'
  | 'search'
  | 'rerank'
  | 'idle'
  | 'dispose'
  | 'decode'
  | 'preprocess'
  | 'inference'
  | 'commit'

export type RuntimeMemoryTracePhase = 'start' | 'finish' | 'cancel' | 'error' | 'point'

export interface RuntimeMemoryTraceEvent {
  runId: string
  stage: RuntimeMemoryTraceStage
  phase: RuntimeMemoryTracePhase
  model?: string
  provider?: string
  pid?: number
  durationMs?: number
  metrics?: Record<string, number | boolean | null>
}

export interface RuntimeMemoryTraceWriterOptions {
  directory: string
  maxLineBytes?: number
  maxFileBytes?: number
  maxFiles?: number
}

const DEFAULT_MAX_LINE_BYTES = 16 * 1024
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_FILES = 4
const MAX_METRIC_FIELDS = 32
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (!Number.isInteger(value)) return fallback
  return Math.max(minimum, Math.min(maximum, value!))
}

function safeIdentifier(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined
  if (!SAFE_ID.test(value)) throw new Error(`Runtime memory trace ${label} is invalid`)
  return value
}

function safeMetrics(
  values: Record<string, number | boolean | null> | undefined,
): Record<string, number | boolean | null> | undefined {
  if (!values) return undefined
  const entries = Object.entries(values)
  if (entries.length > MAX_METRIC_FIELDS)
    throw new Error('Runtime memory trace has too many metrics')
  const output: Record<string, number | boolean | null> = {}
  for (const [key, value] of entries) {
    if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(key)) {
      throw new Error('Runtime memory trace metric name is invalid')
    }
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
      throw new Error('Runtime memory trace metric value is invalid')
    }
    if (value !== null && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error('Runtime memory trace metric value is invalid')
    }
    output[key] = value
  }
  return output
}

export class RuntimeMemoryTraceWriter {
  readonly directory: string
  readonly maxLineBytes: number
  readonly maxFileBytes: number
  readonly maxFiles: number
  private slot = 0
  private bytesInSlot = 0
  private sequence = 0
  private dropped = 0

  constructor(options: RuntimeMemoryTraceWriterOptions) {
    const resolved = path.resolve(options.directory)
    const entry = fs.lstatSync(resolved)
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error('Runtime memory trace directory must be a regular directory')
    }
    if (fs.realpathSync.native(resolved) !== resolved) {
      throw new Error('Runtime memory trace directory identity changed')
    }
    this.directory = resolved
    this.maxLineBytes = boundedInteger(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES, 256, 64 * 1024)
    this.maxFileBytes = boundedInteger(
      options.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
      this.maxLineBytes,
      64 * 1024 * 1024,
    )
    this.maxFiles = boundedInteger(options.maxFiles, DEFAULT_MAX_FILES, 1, 16)
    for (let index = 0; index < this.maxFiles; index++) {
      const target = this.filePath(index)
      if (fs.existsSync(target)) {
        throw new Error('Runtime memory trace target already exists')
      }
    }
    fs.writeFileSync(this.filePath(0), '', { encoding: 'utf8', flag: 'wx' })
  }

  private filePath(slot: number): string {
    return path.join(this.directory, `runtime-memory-events-${String(slot).padStart(2, '0')}.jsonl`)
  }

  emit(event: RuntimeMemoryTraceEvent): boolean {
    const runId = safeIdentifier(event.runId, 'runId')!
    const model = safeIdentifier(event.model, 'model')
    const provider = safeIdentifier(event.provider, 'provider')
    const pid = event.pid ?? process.pid
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Runtime memory trace PID is invalid')
    if (
      event.durationMs !== undefined &&
      (!Number.isFinite(event.durationMs) || event.durationMs < 0)
    ) {
      throw new Error('Runtime memory trace duration is invalid')
    }
    const record = {
      schema: 'siftory-runtime-memory-event/v1',
      sequence: this.sequence++,
      sampledAt: new Date().toISOString(),
      monotonicMs: Math.round(performance.now() * 1000) / 1000,
      runId,
      stage: event.stage,
      phase: event.phase,
      pid,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...(event.metrics ? { metrics: safeMetrics(event.metrics) } : {}),
    }
    const line = `${JSON.stringify(record)}\n`
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (lineBytes > this.maxLineBytes) {
      this.dropped += 1
      return false
    }
    if (this.bytesInSlot + lineBytes > this.maxFileBytes) {
      this.slot = (this.slot + 1) % this.maxFiles
      fs.writeFileSync(this.filePath(this.slot), '', 'utf8')
      this.bytesInSlot = 0
    }
    fs.appendFileSync(this.filePath(this.slot), line, 'utf8')
    this.bytesInSlot += lineBytes
    return true
  }

  stats(): {
    sequence: number
    dropped: number
    activeSlot: number
    retainedBytes: number
    files: number
  } {
    let retainedBytes = 0
    let files = 0
    for (let index = 0; index < this.maxFiles; index++) {
      const target = this.filePath(index)
      if (!fs.existsSync(target)) continue
      files += 1
      retainedBytes += fs.statSync(target).size
    }
    return {
      sequence: this.sequence,
      dropped: this.dropped,
      activeSlot: this.slot,
      retainedBytes,
      files,
    }
  }
}

let activeWriter: RuntimeMemoryTraceWriter | null = null
let configuredRunId = ''
let childRunSequence = 0

export function configureRuntimeMemoryTraceFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const directory = environment.SIFTORY_RUNTIME_MEMORY_TRACE_DIR?.trim()
  const runId = environment.SIFTORY_RUNTIME_MEMORY_RUN_ID?.trim()
  if (!directory && !runId) return false
  if (!directory || !runId) return false
  try {
    activeWriter = new RuntimeMemoryTraceWriter({ directory })
    configuredRunId = safeIdentifier(runId, 'runId')!
    return true
  } catch {
    activeWriter = null
    configuredRunId = ''
    return false
  }
}

export function runtimeMemoryRootRunId(): string | null {
  return configuredRunId || null
}

export function createRuntimeMemoryChildRunId(kind: string): string | null {
  if (!configuredRunId) return null
  const safeKind = safeIdentifier(kind, 'child run kind')!
  childRunSequence += 1
  return `${configuredRunId}.${safeKind}.${childRunSequence}`
}

export function emitRuntimeMemoryTrace(event: RuntimeMemoryTraceEvent): boolean {
  if (!activeWriter) return false
  try {
    return activeWriter.emit(event)
  } catch {
    return false
  }
}

export function runtimeMemoryTraceStats(): ReturnType<RuntimeMemoryTraceWriter['stats']> | null {
  return activeWriter?.stats() ?? null
}
