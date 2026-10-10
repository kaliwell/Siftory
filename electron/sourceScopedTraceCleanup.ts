import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  extractJsonStringField,
  isImageDataPathWithin,
  normalizedImageDataPathKey,
} from './imageSearchDataPathUtils'
import {
  blockSubjectEmbeddingWritesForSource,
  flushSubjectEmbeddingStoreWrites,
  invalidateSubjectEmbeddingsForSource,
  subjectEmbeddingPathFromKey,
} from './subjectEmbeddingStore'

const MAX_LINE_BYTES = 32 * 1024 * 1024
const MAX_MANAGED_HISTORY_FILE_BYTES = 64 * 1024 * 1024
const REDACTED_SOURCE_PATH = '[source path removed]'

export type ManagedAutomationHistoryPolicy = 'preserve-audit' | 'remove-source-traces'

export interface SourceScopedFilePlan {
  filePath: string
  size: number
  mtimeMs: number
  matchedRecords: number
  matchedBytes: number
}

interface ManagedHistoryFilePlan extends SourceScopedFilePlan {
  kind: 'json' | 'log'
}

export interface ManagedAutomationHistoryPlan {
  policy: ManagedAutomationHistoryPolicy
  sourceKey: string
  files: ManagedHistoryFilePlan[]
  traceRecords: number
  traceBytes: number
  warnings: string[]
}

interface PhysicalLine {
  text: string
  raw: Buffer
  physicalBytes: number
}

function fileFingerprint(
  filePath: string,
): Omit<SourceScopedFilePlan, 'matchedRecords' | 'matchedBytes'> | null {
  try {
    const stat = fs.lstatSync(filePath)
    return stat.isFile() && !stat.isSymbolicLink()
      ? { filePath: path.resolve(filePath), size: stat.size, mtimeMs: stat.mtimeMs }
      : null
  } catch {
    return null
  }
}

function sameFingerprint(plan: SourceScopedFilePlan): boolean {
  const current = fileFingerprint(plan.filePath)
  return Boolean(current && current.size === plan.size && current.mtimeMs === plan.mtimeMs)
}

async function* readPhysicalLines(filePath: string): AsyncGenerator<PhysicalLine> {
  let pending = Buffer.alloc(0)
  const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })
  for await (const chunkValue of stream) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue)
    const buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk
    let lineStart = 0
    for (let cursor = 0; cursor < buffer.length; cursor += 1) {
      if (buffer[cursor] !== 0x0a) continue
      const raw = buffer.subarray(lineStart, cursor + 1)
      const content = buffer.subarray(lineStart, cursor)
      if (content.length > MAX_LINE_BYTES) {
        throw new Error(`Managed generated-data row exceeds 32 MiB: ${path.basename(filePath)}`)
      }
      const line = content.at(-1) === 0x0d ? content.subarray(0, content.length - 1) : content
      yield { text: line.toString('utf8'), raw, physicalBytes: raw.length }
      lineStart = cursor + 1
    }
    const remaining = buffer.length - lineStart
    if (remaining > MAX_LINE_BYTES) {
      throw new Error(`Managed generated-data row exceeds 32 MiB: ${path.basename(filePath)}`)
    }
    pending = remaining ? Buffer.from(buffer.subarray(lineStart)) : Buffer.alloc(0)
  }
  if (pending.length) {
    const content = pending.at(-1) === 0x0d ? pending.subarray(0, pending.length - 1) : pending
    yield { text: content.toString('utf8'), raw: pending, physicalBytes: pending.length }
  }
}

function subjectLineMatchesSource(line: string, sourceKey: string): boolean {
  const key = extractJsonStringField(line, 'key')
  const imagePath = key ? subjectEmbeddingPathFromKey(key) : null
  return Boolean(imagePath && isImageDataPathWithin(imagePath, sourceKey))
}

export async function previewSubjectEmbeddingSourceCleanup(
  userDataPath: string,
  sourcePath: string,
): Promise<SourceScopedFilePlan | null> {
  await flushSubjectEmbeddingStoreWrites()
  const filePath = path.join(path.resolve(userDataPath), 'subject-embeddings', 'embeddings.jsonl')
  const fingerprint = fileFingerprint(filePath)
  if (!fingerprint) return null
  const sourceKey = normalizedImageDataPathKey(sourcePath)
  let matchedRecords = 0
  let matchedBytes = 0
  for await (const line of readPhysicalLines(filePath)) {
    if (subjectLineMatchesSource(line.text, sourceKey)) {
      matchedRecords += 1
      matchedBytes += line.physicalBytes
    }
  }
  return { ...fingerprint, matchedRecords, matchedBytes }
}

async function finishWriter(writer: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    writer.once('error', reject)
    writer.once('finish', resolve)
    writer.end()
  })
}

async function writeChunk(writer: fs.WriteStream, value: Uint8Array): Promise<void> {
  if (writer.write(value)) return
  await new Promise<void>((resolve, reject) => {
    writer.once('error', reject)
    writer.once('drain', resolve)
  })
}

async function installPreparedFile(
  sourcePath: string,
  temporaryPath: string,
  backupPath: string,
): Promise<void> {
  await fs.promises.rename(sourcePath, backupPath)
  try {
    await fs.promises.rename(temporaryPath, sourcePath)
  } catch (error) {
    await fs.promises.rename(backupPath, sourcePath)
    throw error
  }
}

export async function executeSubjectEmbeddingSourceCleanup(
  plan: SourceScopedFilePlan | null,
  sourcePath: string,
): Promise<{ removedRecords: number; freedBytes: number; warnings: string[] }> {
  if (!plan || plan.matchedRecords === 0) {
    return { removedRecords: 0, freedBytes: 0, warnings: [] }
  }
  const releaseWriteBlock = blockSubjectEmbeddingWritesForSource(sourcePath)
  const sourceKey = normalizedImageDataPathKey(sourcePath)
  const stamp = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
  const temporaryPath = `${plan.filePath}.source-cleanup-${process.pid}-${stamp}.tmp`
  const backupPath = `${plan.filePath}.source-cleanup-backup-${stamp}`
  let writer: fs.WriteStream | null = null
  try {
    await flushSubjectEmbeddingStoreWrites()
    if (!sameFingerprint(plan)) {
      throw new Error('Subject embedding data changed after preview; analyze the source again')
    }
    writer = fs.createWriteStream(temporaryPath, { flags: 'wx' })
    let removedRecords = 0
    let removedBytes = 0
    for await (const line of readPhysicalLines(plan.filePath)) {
      if (subjectLineMatchesSource(line.text, sourceKey)) {
        removedRecords += 1
        removedBytes += line.physicalBytes
      } else {
        await writeChunk(writer, line.raw)
      }
    }
    await finishWriter(writer)
    writer = null
    if (removedRecords !== plan.matchedRecords || removedBytes !== plan.matchedBytes) {
      throw new Error('Subject embedding preview no longer matches the generated data')
    }
    if (!sameFingerprint(plan)) {
      throw new Error('Subject embedding data changed during cleanup; analyze the source again')
    }
    await installPreparedFile(plan.filePath, temporaryPath, backupPath)
    invalidateSubjectEmbeddingsForSource(sourcePath)
    const warnings: string[] = []
    try {
      await fs.promises.unlink(backupPath)
    } catch (error) {
      warnings.push(
        `Could not purge subject embedding cleanup backup: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    return { removedRecords, freedBytes: removedBytes, warnings }
  } catch (error) {
    writer?.destroy()
    await fs.promises.unlink(temporaryPath).catch(() => {})
    throw error
  } finally {
    releaseWriteBlock()
  }
}

const MANAGED_HISTORY_FILES: ReadonlyArray<{
  pattern: RegExp
  kind: ManagedHistoryFilePlan['kind']
}> = [
  {
    pattern: /^vector-rebuild-state\.json(?:\.\d+\.(?:tmp|partial))?$/i,
    kind: 'json',
  },
  {
    pattern: /^vector-coverage-repair-state\.json(?:\.\d+\.(?:tmp|partial))?$/i,
    kind: 'json',
  },
  {
    pattern: /^vector-rebuild(?:-resume-\d{8}|-watchdog)?\.(?:stdout|stderr)\.log$/i,
    kind: 'log',
  },
  {
    pattern: /^value-observations(?:-current)?\.(?:stdout|stderr)\.log$/i,
    kind: 'log',
  },
]

function managedHistoryKind(name: string): ManagedHistoryFilePlan['kind'] | null {
  return MANAGED_HISTORY_FILES.find((item) => item.pattern.test(name))?.kind || null
}

function normalizedTraceText(value: string): string {
  let normalized = value.toLowerCase().replace(/\//g, '\\')
  while (normalized.includes('\\\\')) normalized = normalized.replace(/\\\\/g, '\\')
  return normalized
}

function sourceTraceCount(value: string, sourceKey: string): number {
  const normalized = normalizedTraceText(value)
  const scope = normalizedImageDataPathKey(sourceKey)
  if (!scope) return 0
  let count = 0
  let cursor = 0
  while (cursor < normalized.length) {
    const index = normalized.indexOf(scope, cursor)
    if (index < 0) break
    const next = normalized[index + scope.length]
    if (
      scope.endsWith('\\') ||
      next === undefined ||
      next === '\\' ||
      /[\s"'`,;:)\]}]/.test(next)
    ) {
      count += 1
    }
    cursor = index + Math.max(1, scope.length)
  }
  return count
}

interface ScrubbedJson {
  value: unknown
  matchedRecords: number
  matchedBytes: number
}

function scrubJsonValue(value: unknown, sourceKey: string): ScrubbedJson {
  if (typeof value === 'string') {
    const matches = sourceTraceCount(value, sourceKey)
    return {
      value: matches > 0 ? REDACTED_SOURCE_PATH : value,
      matchedRecords: matches > 0 ? 1 : 0,
      matchedBytes: matches > 0 ? Buffer.byteLength(value) : 0,
    }
  }
  if (Array.isArray(value)) {
    const next: unknown[] = []
    let matchedRecords = 0
    let matchedBytes = 0
    for (const item of value) {
      const scrubbed = scrubJsonValue(item, sourceKey)
      next.push(scrubbed.value)
      matchedRecords += scrubbed.matchedRecords
      matchedBytes += scrubbed.matchedBytes
    }
    return { value: next, matchedRecords, matchedBytes }
  }
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {}
    let matchedRecords = 0
    let matchedBytes = 0
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const keyMatches = sourceTraceCount(key, sourceKey)
      if (keyMatches > 0) {
        matchedRecords += 1
        matchedBytes += Buffer.byteLength(key)
        continue
      }
      const scrubbed = scrubJsonValue(item, sourceKey)
      next[key] = scrubbed.value
      matchedRecords += scrubbed.matchedRecords
      matchedBytes += scrubbed.matchedBytes
    }
    return { value: next, matchedRecords, matchedBytes }
  }
  return { value, matchedRecords: 0, matchedBytes: 0 }
}

async function previewManagedHistoryFile(
  filePath: string,
  kind: ManagedHistoryFilePlan['kind'],
  sourceKey: string,
): Promise<{ plan?: ManagedHistoryFilePlan; warning?: string }> {
  const fingerprint = fileFingerprint(filePath)
  if (!fingerprint) return {}
  if (fingerprint.size > MAX_MANAGED_HISTORY_FILE_BYTES) {
    return { warning: `Preserved oversized managed history file: ${path.basename(filePath)}` }
  }
  try {
    if (kind === 'json') {
      const parsed: unknown = JSON.parse(await fs.promises.readFile(filePath, 'utf8'))
      const scrubbed = scrubJsonValue(parsed, sourceKey)
      if (scrubbed.matchedRecords === 0) return {}
      return {
        plan: {
          ...fingerprint,
          kind,
          matchedRecords: scrubbed.matchedRecords,
          matchedBytes: scrubbed.matchedBytes,
        },
      }
    }
    let matchedRecords = 0
    let matchedBytes = 0
    for await (const line of readPhysicalLines(filePath)) {
      if (sourceTraceCount(line.text, sourceKey) > 0) {
        matchedRecords += 1
        matchedBytes += line.physicalBytes
      }
    }
    if (matchedRecords === 0) return {}
    return { plan: { ...fingerprint, kind, matchedRecords, matchedBytes } }
  } catch (error) {
    return {
      warning: `Preserved unreadable managed history file ${path.basename(filePath)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}

export async function previewManagedAutomationHistory(
  userDataPath: string,
  sourcePath: string,
  policy: ManagedAutomationHistoryPolicy,
): Promise<ManagedAutomationHistoryPlan> {
  const root = path.join(path.resolve(userDataPath), 'value-automation')
  const sourceKey = normalizedImageDataPathKey(sourcePath)
  const files: ManagedHistoryFilePlan[] = []
  const warnings: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true })
  } catch {
    return { policy, sourceKey, files, traceRecords: 0, traceBytes: 0, warnings }
  }
  for (const entry of entries) {
    const kind = entry.isFile() && !entry.isSymbolicLink() ? managedHistoryKind(entry.name) : null
    if (!kind) continue
    const inspected = await previewManagedHistoryFile(path.join(root, entry.name), kind, sourceKey)
    if (inspected.plan) files.push(inspected.plan)
    if (inspected.warning) warnings.push(inspected.warning)
  }
  files.sort((a, b) => a.filePath.localeCompare(b.filePath))
  return {
    policy,
    sourceKey,
    files,
    traceRecords: files.reduce((sum, item) => sum + item.matchedRecords, 0),
    traceBytes: files.reduce((sum, item) => sum + item.matchedBytes, 0),
    warnings,
  }
}

interface PreparedHistoryFile {
  plan: ManagedHistoryFilePlan
  temporaryPath: string
  backupPath: string
  removedBytes: number
}

async function prepareManagedHistoryFile(
  plan: ManagedHistoryFilePlan,
  sourceKey: string,
): Promise<PreparedHistoryFile> {
  const stamp = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
  const temporaryPath = `${plan.filePath}.source-cleanup-${process.pid}-${stamp}.tmp`
  const backupPath = `${plan.filePath}.source-cleanup-backup-${stamp}`
  let outputBytes = 0
  if (plan.kind === 'json') {
    const parsed: unknown = JSON.parse(await fs.promises.readFile(plan.filePath, 'utf8'))
    const scrubbed = scrubJsonValue(parsed, sourceKey)
    if (scrubbed.matchedRecords !== plan.matchedRecords) {
      throw new Error(`Managed history preview no longer matches ${path.basename(plan.filePath)}`)
    }
    const serialized = `${JSON.stringify(scrubbed.value, null, 2)}\n`
    outputBytes = Buffer.byteLength(serialized)
    await fs.promises.writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' })
  } else {
    const writer = fs.createWriteStream(temporaryPath, { flags: 'wx' })
    let removedRecords = 0
    try {
      for await (const line of readPhysicalLines(plan.filePath)) {
        if (sourceTraceCount(line.text, sourceKey) > 0) removedRecords += 1
        else {
          outputBytes += line.physicalBytes
          await writeChunk(writer, line.raw)
        }
      }
      await finishWriter(writer)
    } catch (error) {
      writer.destroy()
      await fs.promises.unlink(temporaryPath).catch(() => {})
      throw error
    }
    if (removedRecords !== plan.matchedRecords) {
      await fs.promises.unlink(temporaryPath).catch(() => {})
      throw new Error(`Managed history preview no longer matches ${path.basename(plan.filePath)}`)
    }
  }
  return {
    plan,
    temporaryPath,
    backupPath,
    removedBytes: Math.max(0, plan.size - outputBytes),
  }
}

export async function executeManagedAutomationHistoryCleanup(
  plan: ManagedAutomationHistoryPlan,
): Promise<{ removedRecords: number; freedBytes: number; warnings: string[] }> {
  if (plan.policy !== 'remove-source-traces' || plan.files.length === 0) {
    return { removedRecords: 0, freedBytes: 0, warnings: [...plan.warnings] }
  }
  for (const item of plan.files) {
    if (!sameFingerprint(item)) {
      throw new Error(
        `Managed automation history changed after preview: ${path.basename(item.filePath)}`,
      )
    }
  }
  const prepared: PreparedHistoryFile[] = []
  const switched: PreparedHistoryFile[] = []
  try {
    for (const item of plan.files)
      prepared.push(await prepareManagedHistoryFile(item, plan.sourceKey))
    for (const item of plan.files) {
      if (!sameFingerprint(item)) {
        throw new Error(
          `Managed automation history changed during cleanup: ${path.basename(item.filePath)}`,
        )
      }
    }
    for (const item of prepared) {
      await installPreparedFile(item.plan.filePath, item.temporaryPath, item.backupPath)
      switched.push(item)
    }
  } catch (error) {
    for (const item of [...switched].reverse()) {
      await fs.promises.unlink(item.plan.filePath).catch(() => {})
      await fs.promises.rename(item.backupPath, item.plan.filePath).catch(() => {})
    }
    for (const item of prepared) await fs.promises.unlink(item.temporaryPath).catch(() => {})
    throw error
  }
  const warnings = [...plan.warnings]
  for (const item of switched) {
    try {
      await fs.promises.unlink(item.backupPath)
    } catch (error) {
      warnings.push(
        `Could not purge managed history cleanup backup ${path.basename(item.backupPath)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  return {
    removedRecords: plan.files.reduce((sum, item) => sum + item.matchedRecords, 0),
    freedBytes: switched.reduce((sum, item) => sum + item.removedBytes, 0),
    warnings,
  }
}
