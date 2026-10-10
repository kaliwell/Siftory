import fs from 'fs'
import path from 'path'
import type { EmbeddingJob } from '../shared/vectorTypes'

export interface EmbeddingLogPolicy {
  maxBytes: number
  maxRecords: number
  ttlMs: number
}

export interface DiagnosticLogPolicy extends EmbeddingLogPolicy {
  maxBackups: number
  compactEvery: number
}

export interface EmbeddingLogHealth {
  name: 'failures' | 'diagnostics'
  ok: boolean
  lastSuccessfulWriteAt?: number
  lastError?: string
  lastErrorAt?: number
  compactions: number
  droppedRecords: number
}

export interface EmbeddingFailureRecord {
  time: string
  imageId: string
  modelName: string
  modelVersion?: string
  dim?: number
  error: string
  count: number
}

export const FAILURE_LOG_POLICY: EmbeddingLogPolicy = {
  maxBytes: 32 * 1024 * 1024,
  maxRecords: 50_000,
  ttlMs: 30 * 24 * 60 * 60 * 1000,
}

export const DIAGNOSTIC_LOG_POLICY: DiagnosticLogPolicy = {
  maxBytes: 20 * 1024 * 1024,
  maxRecords: 100_000,
  ttlMs: 14 * 24 * 60 * 60 * 1000,
  maxBackups: 3,
  compactEvery: 256,
}

const health = new Map<EmbeddingLogHealth['name'], EmbeddingLogHealth>()
const diagnosticStates = new Map<string, { writes: number; records: number }>()
const failureStates = new Map<
  string,
  { records: Map<string, EmbeddingFailureRecord>; fileBytes: number; evaluatedAt: number }
>()

function healthFor(name: EmbeddingLogHealth['name']): EmbeddingLogHealth {
  let state = health.get(name)
  if (!state) {
    state = { name, ok: true, compactions: 0, droppedRecords: 0 }
    health.set(name, state)
  }
  return state
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function recordSuccess(name: EmbeddingLogHealth['name']): void {
  const state = healthFor(name)
  state.ok = true
  state.lastSuccessfulWriteAt = Date.now()
  delete state.lastError
  delete state.lastErrorAt
}

function recordError(name: EmbeddingLogHealth['name'], error: unknown): void {
  const state = healthFor(name)
  state.ok = false
  state.lastError = errorMessage(error)
  state.lastErrorAt = Date.now()
}

function parseRows(filePath: string): Record<string, unknown>[] {
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const row = JSON.parse(line)
          return row && typeof row === 'object' && !Array.isArray(row) ? [row] : []
        } catch {
          return []
        }
      })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw error
  }
}

function rowTime(row: object): number {
  const time = (row as { time?: unknown }).time
  const value = Date.parse(typeof time === 'string' ? time : '')
  return Number.isFinite(value) ? value : 0
}

function boundRows<T extends object>(
  rows: T[],
  policy: EmbeddingLogPolicy,
  now: number,
): { rows: T[]; dropped: number } {
  const cutoff = now - policy.ttlMs
  const eligible = rows.filter((row) => rowTime(row) >= cutoff).slice(-policy.maxRecords)
  const kept: T[] = []
  let bytes = 0
  for (let index = eligible.length - 1; index >= 0; index--) {
    const row = eligible[index]
    const rowBytes = Buffer.byteLength(`${JSON.stringify(row)}\n`, 'utf8')
    if (rowBytes > policy.maxBytes || bytes + rowBytes > policy.maxBytes) break
    kept.push(row)
    bytes += rowBytes
  }
  kept.reverse()
  return { rows: kept, dropped: rows.length - kept.length }
}

function writeRowsAtomic(filePath: string, rows: object[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  const body = rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : ''
  fs.writeFileSync(temporaryPath, body, 'utf8')
  fs.renameSync(temporaryPath, filePath)
}

function failureKey(row: Pick<EmbeddingFailureRecord, 'modelName' | 'imageId' | 'error'>): string {
  return `${row.modelName}\u001f${row.imageId}\u001f${row.error}`
}

function loadFailureState(
  filePath: string,
  policy: EmbeddingLogPolicy,
  now: number,
): { records: Map<string, EmbeddingFailureRecord>; fileBytes: number; evaluatedAt: number } {
  const currentBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
  const existingState = failureStates.get(filePath)
  if (
    existingState &&
    existingState.fileBytes === currentBytes &&
    now - existingState.evaluatedAt < 60 * 60 * 1000
  ) {
    return existingState
  }

  const parsed = parseRows(filePath)
  const deduplicated = new Map<string, EmbeddingFailureRecord>()
  for (const raw of parsed) {
    if (rowTime(raw) < now - policy.ttlMs) continue
    if (
      typeof raw.modelName !== 'string' ||
      typeof raw.imageId !== 'string' ||
      typeof raw.error !== 'string'
    ) {
      continue
    }
    const row = raw as unknown as EmbeddingFailureRecord
    const key = failureKey(row)
    const previous = deduplicated.get(key)
    deduplicated.set(key, {
      ...row,
      count: previous
        ? Math.max(1, Number(previous.count || 1)) + Math.max(1, Number(row.count || 1))
        : Math.max(1, Number(row.count || 1)),
    })
  }
  const bounded = boundRows([...deduplicated.values()], policy, now)
  writeRowsAtomic(filePath, bounded.rows)
  const state = {
    records: new Map(bounded.rows.map((row) => [failureKey(row), row])),
    fileBytes: fs.statSync(filePath).size,
    evaluatedAt: now,
  }
  failureStates.set(filePath, state)
  const logHealth = healthFor('failures')
  logHealth.compactions += 1
  logHealth.droppedRecords += Math.max(bounded.dropped, parsed.length - bounded.rows.length)
  return state
}

export function enforceEmbeddingFailureRetention(
  filePath: string,
  policy: EmbeddingLogPolicy = FAILURE_LOG_POLICY,
  now = Date.now(),
): boolean {
  try {
    loadFailureState(filePath, policy, now)
    recordSuccess('failures')
    return true
  } catch (error) {
    failureStates.delete(filePath)
    recordError('failures', error)
    return false
  }
}

export function appendEmbeddingFailure(
  filePath: string,
  incoming: Omit<EmbeddingFailureRecord, 'count'>,
  policy: EmbeddingLogPolicy = FAILURE_LOG_POLICY,
  now = Date.now(),
): boolean {
  try {
    const state = loadFailureState(filePath, policy, now)

    const key = failureKey(incoming)
    const previous = state.records.get(key)
    const updated: EmbeddingFailureRecord = {
      ...previous,
      ...incoming,
      count: Math.max(1, Number(previous?.count || 0) + 1),
    }
    const serialized = `${JSON.stringify(updated)}\n`
    const serializedBytes = Buffer.byteLength(serialized, 'utf8')
    if (serializedBytes > policy.maxBytes) {
      healthFor('failures').droppedRecords += 1
      recordSuccess('failures')
      return true
    }

    if (
      !previous &&
      state.records.size < policy.maxRecords &&
      state.fileBytes + serializedBytes <= policy.maxBytes
    ) {
      fs.appendFileSync(filePath, serialized, 'utf8')
      state.records.set(key, updated)
      state.fileBytes += serializedBytes
      recordSuccess('failures')
      return true
    }

    state.records.set(key, updated)
    const bounded = boundRows([...state.records.values()], policy, now)
    writeRowsAtomic(filePath, bounded.rows)
    state.records = new Map(bounded.rows.map((row) => [failureKey(row), row]))
    state.fileBytes = fs.statSync(filePath).size
    state.evaluatedAt = now
    const logHealth = healthFor('failures')
    logHealth.compactions += 1
    logHealth.droppedRecords += bounded.dropped
    recordSuccess('failures')
    return true
  } catch (error) {
    failureStates.delete(filePath)
    recordError('failures', error)
    return false
  }
}

function diagnosticBackups(filePath: string): string[] {
  const directory = path.dirname(filePath)
  const prefix = `${path.basename(filePath)}.`
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.bak'),
      )
      .map((entry) => path.join(directory, entry.name))
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
  } catch {
    return []
  }
}

function nextDiagnosticBackupPath(filePath: string, now: number): string {
  let candidate = `${filePath}.${now}.bak`
  let suffix = 1
  while (fs.existsSync(candidate)) {
    candidate = `${filePath}.${now}-${suffix}.bak`
    suffix += 1
  }
  return candidate
}

function pruneDiagnosticBackups(
  filePath: string,
  policy: DiagnosticLogPolicy,
  now: number,
): number {
  let removed = 0
  diagnosticBackups(filePath).forEach((backup, index) => {
    try {
      if (index >= policy.maxBackups || fs.statSync(backup).mtimeMs < now - policy.ttlMs) {
        fs.unlinkSync(backup)
        removed += 1
      }
    } catch {
      /* the health state is reserved for active-log write failures */
    }
  })
  return removed
}

export function appendEmbeddingDiagnostic(
  filePath: string,
  row: Record<string, unknown>,
  policy: DiagnosticLogPolicy = DIAGNOSTIC_LOG_POLICY,
  now = Date.now(),
): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    let state = diagnosticStates.get(filePath)
    if (!state) {
      const bounded = boundRows(parseRows(filePath), policy, now)
      writeRowsAtomic(filePath, bounded.rows)
      state = { writes: 0, records: bounded.rows.length }
      diagnosticStates.set(filePath, state)
      const logHealth = healthFor('diagnostics')
      logHealth.compactions += 1
      logHealth.droppedRecords += bounded.dropped
    }

    const serialized = `${JSON.stringify(row)}\n`
    const serializedBytes = Buffer.byteLength(serialized, 'utf8')
    if (serializedBytes > policy.maxBytes) {
      healthFor('diagnostics').droppedRecords += 1
      recordSuccess('diagnostics')
      return true
    }
    const currentBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
    if (currentBytes + serializedBytes > policy.maxBytes || state.records + 1 > policy.maxRecords) {
      const backupPath = nextDiagnosticBackupPath(filePath, now)
      if (fs.existsSync(filePath)) fs.renameSync(filePath, backupPath)
      state.records = 0
      state.writes = 0
      healthFor('diagnostics').compactions += 1
    }
    fs.appendFileSync(filePath, serialized, 'utf8')
    state.records += 1
    state.writes += 1

    if (state.writes >= policy.compactEvery) {
      const bounded = boundRows(parseRows(filePath), policy, now)
      writeRowsAtomic(filePath, bounded.rows)
      state.records = bounded.rows.length
      state.writes = 0
      const logHealth = healthFor('diagnostics')
      logHealth.compactions += 1
      logHealth.droppedRecords += bounded.dropped
    }
    healthFor('diagnostics').droppedRecords += pruneDiagnosticBackups(filePath, policy, now)
    recordSuccess('diagnostics')
    return true
  } catch (error) {
    recordError('diagnostics', error)
    return false
  }
}

export function selectRetainedEmbeddingJobs(
  jobs: EmbeddingJob[],
  now = Date.now(),
  options: {
    failedTtlMs?: number
    completedTtlMs?: number
    maxFailed?: number
    maxCompleted?: number
  } = {},
): EmbeddingJob[] {
  const failedCutoff = now - (options.failedTtlMs ?? 30 * 24 * 60 * 60 * 1000)
  const completedCutoff = now - (options.completedTtlMs ?? 7 * 24 * 60 * 60 * 1000)
  const active = jobs.filter((job) => job.status === 'pending' || job.status === 'running')
  const failed = jobs
    .filter(
      (job) =>
        job.status === 'failed' &&
        (job.finishedAt || job.startedAt || job.createdAt) >= failedCutoff,
    )
    .sort(
      (left, right) => (right.finishedAt || right.createdAt) - (left.finishedAt || left.createdAt),
    )
    .slice(0, options.maxFailed ?? 5_000)
  const completed = jobs
    .filter(
      (job) =>
        (job.status === 'completed' || job.status === 'skipped') &&
        (job.finishedAt || job.startedAt || job.createdAt) >= completedCutoff,
    )
    .sort(
      (left, right) => (right.finishedAt || right.createdAt) - (left.finishedAt || left.createdAt),
    )
    .slice(0, options.maxCompleted ?? 0)
  return [...active, ...failed, ...completed]
}

export function getEmbeddingLogHealth(): EmbeddingLogHealth[] {
  const names: EmbeddingLogHealth['name'][] = ['failures', 'diagnostics']
  return names.map((name) => ({ ...healthFor(name) }))
}

/** Drop process-local snapshots after a scoped maintenance rewrite. */
export function invalidateEmbeddingLogRetentionCaches(): void {
  failureStates.clear()
  diagnosticStates.clear()
}

export function resetEmbeddingLogRetentionForTests(): void {
  health.clear()
  invalidateEmbeddingLogRetentionCaches()
}
