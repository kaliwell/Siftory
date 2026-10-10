import crypto from 'crypto'
import fs from 'fs'
import http, { type IncomingMessage, type ServerResponse } from 'http'
import path from 'path'
import { app, safeStorage } from 'electron'
import type {
  AiControlAuditEntry,
  AiControlConfirmation,
  AiControlConfirmationResult,
  AiControlScope,
  AiControlSettings,
  AiControlSettingsResult,
  AssetLibraryListRequest,
  DisplayScope,
  WorkspaceTopology,
} from '../shared/ipc-contract'
import { secureIpcMain } from './ipcAuthorization'
import { readJSON, writeJSON } from './settingsStore'
import { getImageSearchStatus, stopImageSearchScan } from './imageSearchService'
import { getMediaSearchStatus } from './mediaTaskQueue'
import { warmFfmpegStatusCache } from './ffmpegService'
import { searchVideoFramesByText } from './videoFrameSearchService'
import { searchSemanticImages } from './semanticSearchService'
import { getAssetLibraryStats, listAssetLibraryAssets } from './assetLibraryService'
import { buildAiControlOpenApi } from './aiControlOpenApi'
import { listFolderStatsSources, scanSourceFolderStats } from './appStorageService'
import {
  scanSourceLargeFiles,
  scanStorageLargeFiles,
  type LargeFileAssessmentFilter,
  type StorageLargeFileScope,
} from './largeFileInventoryService'
import { getSourceCatalogService } from './sourceCatalogService'
import { getSourceFileSyncMutationEpoch, isSourceFileSyncRunning } from './sourceFileSyncService'
import { tryAcquireVectorSearchReservation } from './vectorMaintenanceService'
import {
  AI_CONTROL_CAPABILITIES,
  AI_CONTROL_SCOPES,
  AiControlAuthFailureGuard,
  AiControlSseLimiter,
  hasAiControlScopes,
  isAllowedLoopbackHost,
  isAllowedLoopbackOrigin,
  isLoopbackAddress,
  normalizeAiControlPort,
  normalizeAiControlScopes,
  redactAiControlValue,
  tokensEqual,
  validateCapabilityInput,
} from './aiControlPolicy'

const CONFIG_FILE = 'ai-control.json'
const AUDIT_FILE = 'ai-control-audit.jsonl'
const BODY_LIMIT = 64 * 1024
const RATE_LIMIT = 120
const RATE_WINDOW_MS = 60_000
const MAX_JOBS = 200
const JOB_TTL_MS = 30 * 60_000
const IDEMPOTENCY_TTL_MS = 30 * 60_000
const CONFIRMATION_TTL_MS = 5 * 60_000
const MAX_CONFIRMATIONS = 50
const SSE_HEARTBEAT_MS = 15_000
const SSE_MAX_BUFFER_BYTES = 256 * 1024
// VAL-029: failed authentications are locked out per address (the generic
// rate bucket only counts authenticated requests) and the SSE fan-out is
// bounded globally and per address.
const AUTH_FAILURE_LIMIT = 8
const AUTH_FAILURE_WINDOW_MS = 10 * 60_000
const AUTH_LOCKOUT_MS = 5 * 60_000
const SSE_MAX_STREAMS = 8
const SSE_MAX_STREAMS_PER_ADDRESS = 4
const STOP_JOB_WAIT_MS = 5_000

interface StoredAiControlConfig {
  version: 1
  enabled: boolean
  port: number
  encryptedToken?: string
  tokenCreatedAt?: string
  tokenScopes: AiControlScope[]
}

interface AiControlApiOptions {
  userDataPath: string
  getDisplayTopology: () => WorkspaceTopology
  setDisplayScope: (scope: DisplayScope) => WorkspaceTopology
  setWindowVisibility: (visible: boolean) => boolean
}

interface AiJob {
  id: string
  capabilityId: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  createdAt: string
  updatedAt: string
  result?: unknown
  error?: { code: string; message: string }
  cancellationRequested?: boolean
}

interface RateBucket {
  startedAt: number
  count: number
}

interface IdempotencyRecord {
  jobId: string
  requestDigest: string
  expiresAt: number
}

interface PendingConfirmation extends AiControlConfirmation {
  requestDigest: string
  tokenSessionId: string
  state: 'pending' | 'approved' | 'denied'
}

let options: AiControlApiOptions | null = null
let config: StoredAiControlConfig = {
  version: 1,
  enabled: false,
  port: 32145,
  tokenScopes: [...AI_CONTROL_SCOPES],
}
let server: http.Server | null = null
let plaintextToken = ''
let lastError: string | undefined
let auditEntries: AiControlAuditEntry[] = []
let auditWriteChain: Promise<void> = Promise.resolve()
const jobs = new Map<string, AiJob>()
const idempotencyJobs = new Map<string, IdempotencyRecord>()
const rateBuckets = new Map<string, RateBucket>()
const activeCapabilities = new Set<string>()
const jobControllers = new Map<string, AbortController>()
const jobPromises = new Map<string, Promise<void>>()
const confirmations = new Map<string, PendingConfirmation>()
const eventStreams = new Map<ServerResponse, { heartbeat: NodeJS.Timeout; address: string }>()
const authFailureGuard = new AiControlAuthFailureGuard({
  maxFailures: AUTH_FAILURE_LIMIT,
  windowMs: AUTH_FAILURE_WINDOW_MS,
  lockoutMs: AUTH_LOCKOUT_MS,
})
const sseStreamLimiter = new AiControlSseLimiter(SSE_MAX_STREAMS, SSE_MAX_STREAMS_PER_ADDRESS)
let tokenSessionId = ''

function configPath(): string {
  if (!options) throw new Error('AI control API is not initialized')
  return path.join(options.userDataPath, CONFIG_FILE)
}

function auditPath(): string {
  if (!options) throw new Error('AI control API is not initialized')
  return path.join(options.userDataPath, AUDIT_FILE)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function loadConfig(): void {
  const raw = readJSON(configPath())
  if (raw && typeof raw === 'object') {
    const value = raw as Partial<StoredAiControlConfig>
    config = {
      version: 1,
      enabled: value.enabled === true,
      port: normalizeAiControlPort(value.port),
      tokenScopes: normalizeAiControlScopes(value.tokenScopes),
      ...(typeof value.encryptedToken === 'string' && { encryptedToken: value.encryptedToken }),
      ...(typeof value.tokenCreatedAt === 'string' && { tokenCreatedAt: value.tokenCreatedAt }),
    }
  }
  plaintextToken = decryptToken(config.encryptedToken)
  tokenSessionId = plaintextToken
    ? crypto.createHash('sha256').update(plaintextToken).digest('hex')
    : ''
}

function loadAudit(): void {
  try {
    const rows = fs
      .readFileSync(auditPath(), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-200)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as AiControlAuditEntry]
        } catch {
          return []
        }
      })
    auditEntries = rows
  } catch {
    auditEntries = []
  }
}

function decryptToken(encrypted: string | undefined): string {
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    return ''
  }
}

function persistConfig(): void {
  writeJSON(configPath(), config)
}

function publicSettings(): AiControlSettings {
  return {
    enabled: config.enabled,
    running: server?.listening === true,
    port: config.port,
    address: `http://127.0.0.1:${config.port}/v1`,
    tokenAvailable: Boolean(config.encryptedToken),
    tokenScopes: [...config.tokenScopes],
    ...(config.tokenCreatedAt && { tokenCreatedAt: config.tokenCreatedAt }),
    ...(lastError && { lastError }),
    auditEntries: auditEntries.length,
    pendingConfirmations: listConfirmations().length,
  }
}

function appendAudit(entry: AiControlAuditEntry): void {
  auditEntries = [...auditEntries.slice(-199), entry]
  auditWriteChain = auditWriteChain
    .then(async () => {
      const target = auditPath()
      try {
        if ((await fs.promises.stat(target)).size > 1024 * 1024) {
          await fs.promises.rm(`${target}.1`, { force: true })
          await fs.promises.rename(target, `${target}.1`)
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      }
      await fs.promises.appendFile(target, `${JSON.stringify(entry)}\n`, 'utf8')
    })
    .catch((error) => {
      console.warn('[AI Control] audit write failed:', errorMessage(error))
    })
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(payload)
}

function requestToken(request: IncomingMessage): string {
  const value = request.headers.authorization
  return value?.startsWith('Bearer ') ? value.slice(7).trim() : ''
}

function authorizeRequest(request: IncomingMessage, response: ServerResponse): boolean {
  const remoteAddress = request.socket.remoteAddress
  if (!isLoopbackAddress(remoteAddress)) {
    json(response, 403, { error: { code: 'loopback_required', message: 'Loopback only.' } })
    return false
  }
  if (!isAllowedLoopbackHost(request.headers.host, config.port)) {
    json(response, 400, { error: { code: 'invalid_host', message: 'Invalid Host header.' } })
    return false
  }
  const origin = Array.isArray(request.headers.origin)
    ? request.headers.origin[0]
    : request.headers.origin
  if (!isAllowedLoopbackOrigin(origin, config.port)) {
    json(response, 403, { error: { code: 'invalid_origin', message: 'Origin is not allowed.' } })
    return false
  }
  const token = requestToken(request)
  const authAddress = remoteAddress ?? 'loopback'
  const retryAfterMs = authFailureGuard.lockedRetryAfterMs(authAddress)
  if (retryAfterMs > 0) {
    json(response, 429, {
      error: {
        code: 'auth_locked',
        message: 'Too many failed authentication attempts; retry later.',
        retryAfterMs,
      },
    })
    return false
  }
  if (!plaintextToken || !token || !tokensEqual(plaintextToken, token)) {
    authFailureGuard.recordAuthFailure(authAddress)
    json(response, 401, { error: { code: 'unauthorized', message: 'Invalid bearer token.' } })
    return false
  }
  authFailureGuard.recordAuthSuccess(authAddress)
  const now = Date.now()
  const key = remoteAddress ?? 'loopback'
  const bucket = rateBuckets.get(key)
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 })
  } else {
    bucket.count += 1
    if (bucket.count > RATE_LIMIT) {
      json(response, 429, { error: { code: 'rate_limited', message: 'Too many requests.' } })
      return false
    }
  }
  return true
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = String(request.headers['content-type'] ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  if (contentType !== 'application/json') throw new Error('content_type_required')
  const declaredBytes = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declaredBytes) && declaredBytes > BODY_LIMIT) {
    throw new Error('payload_too_large')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > BODY_LIMIT) throw new Error('payload_too_large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new Error('invalid_json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('invalid_json')
  return parsed as Record<string, unknown>
}

function notifyJob(job: AiJob): void {
  const payload = `event: job\ndata: ${JSON.stringify(redactAiControlValue(job))}\n\n`
  for (const stream of eventStreams.keys()) {
    if (stream.destroyed || stream.writableEnded || stream.writableLength > SSE_MAX_BUFFER_BYTES) {
      closeEventStream(stream)
      continue
    }
    stream.write(payload)
  }
}

function closeEventStream(stream: ServerResponse): void {
  const entry = eventStreams.get(stream)
  if (entry) {
    clearInterval(entry.heartbeat)
    sseStreamLimiter.release(entry.address)
  }
  eventStreams.delete(stream)
  if (!stream.writableEnded) stream.end()
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function requestDigest(
  capabilityId: string,
  input: Record<string, unknown>,
  idempotencyKey: string,
): string {
  return crypto
    .createHash('sha256')
    .update(`${capabilityId}\n${idempotencyKey}\n${canonicalJson(input)}`)
    .digest('hex')
}

function publicConfirmation(confirmation: PendingConfirmation): AiControlConfirmation {
  return {
    id: confirmation.id,
    capabilityId: confirmation.capabilityId,
    createdAt: confirmation.createdAt,
    expiresAt: confirmation.expiresAt,
    requestId: confirmation.requestId,
    inputKeys: [...confirmation.inputKeys],
    inputPreview: confirmation.inputPreview,
  }
}

function listConfirmations(): AiControlConfirmation[] {
  pruneRuntimeState()
  return [...confirmations.values()]
    .filter(
      (confirmation) =>
        confirmation.state === 'pending' && confirmation.tokenSessionId === tokenSessionId,
    )
    .map(publicConfirmation)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

function resolveConfirmationDecision(
  confirmationId: unknown,
  approved: unknown,
): AiControlConfirmationResult {
  pruneRuntimeState()
  if (typeof confirmationId !== 'string' || typeof approved !== 'boolean') {
    return {
      ok: false,
      confirmations: listConfirmations(),
      error: 'Invalid confirmation decision',
    }
  }
  const confirmation = confirmations.get(confirmationId)
  if (
    !confirmation ||
    confirmation.state !== 'pending' ||
    confirmation.tokenSessionId !== tokenSessionId
  ) {
    return {
      ok: false,
      confirmations: listConfirmations(),
      error: 'Confirmation is missing or expired',
    }
  }
  confirmation.state = approved ? 'approved' : 'denied'
  appendAudit({
    timestamp: new Date().toISOString(),
    capabilityId: confirmation.capabilityId,
    outcome: approved ? 'confirmation_approved' : 'confirmation_denied',
    durationMs: 0,
    requestId: confirmation.requestId,
    inputKeys: confirmation.inputKeys,
  })
  return { ok: true, confirmations: listConfirmations() }
}

function pruneRuntimeState(now = Date.now()): void {
  for (const [id, confirmation] of confirmations) {
    if (
      Date.parse(confirmation.expiresAt) <= now ||
      confirmation.tokenSessionId !== tokenSessionId
    ) {
      confirmations.delete(id)
    }
  }
  for (const [key, record] of idempotencyJobs) {
    if (record.expiresAt <= now || !jobs.has(record.jobId)) idempotencyJobs.delete(key)
  }
  for (const [id, job] of jobs) {
    if (
      (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') &&
      Date.parse(job.updatedAt) + JOB_TTL_MS <= now
    ) {
      jobs.delete(id)
    }
  }
  while (jobs.size > MAX_JOBS) {
    const removable = [...jobs.entries()].find(([, job]) =>
      ['succeeded', 'failed', 'cancelled'].includes(job.state),
    )
    if (!removable) break
    jobs.delete(removable[0])
  }
  for (const [key, record] of idempotencyJobs) {
    if (!jobs.has(record.jobId)) idempotencyJobs.delete(key)
  }
}

function clearRuntimeState(): void {
  jobs.clear()
  idempotencyJobs.clear()
  rateBuckets.clear()
  confirmations.clear()
  activeCapabilities.clear()
  jobControllers.clear()
  jobPromises.clear()
  sseStreamLimiter.reset()
}

function capabilityById(id: string) {
  return AI_CONTROL_CAPABILITIES.find((capability) => capability.id === id)
}

function allowedCapabilities() {
  return AI_CONTROL_CAPABILITIES.filter((capability) =>
    hasAiControlScopes(capability.requiredScopes, config.tokenScopes),
  )
}

function numeric(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback
}

async function executeCapability(
  id: string,
  input: Record<string, unknown>,
  isCancelled: () => boolean = () => false,
): Promise<unknown> {
  if (!options) throw new Error('AI control API is not initialized')
  switch (id) {
    case 'system.health':
      return { ok: true, version: app.getVersion(), uptimeSeconds: Math.floor(process.uptime()) }
    case 'system.capabilities':
      return allowedCapabilities()
    case 'system.version':
      return { version: app.getVersion() }
    case 'window.show': {
      return { visible: options.setWindowVisibility(true) }
    }
    case 'window.hide': {
      const accepted = options.setWindowVisibility(false)
      return { visible: false, accepted }
    }
    case 'window.listDisplays':
      return options.getDisplayTopology()
    case 'window.selectDisplay': {
      const mode = input.mode
      const scope: DisplayScope =
        mode === 'primary'
          ? { mode: 'primary' }
          : mode === 'display' && typeof input.displayId === 'string'
            ? { mode: 'display', displayId: input.displayId }
            : { mode: 'all' }
      return options.setDisplayScope(scope)
    }
    case 'imageSearch.status':
      return getImageSearchStatus()
    case 'imageSearch.search': {
      const text = typeof input.text === 'string' ? input.text.trim().slice(0, 500) : ''
      if (!text) throw new Error('Text query is required')
      if (isSourceFileSyncRunning()) throw new Error('Source file synchronization is running')
      const releaseSearch = tryAcquireVectorSearchReservation()
      if (!releaseSearch) throw new Error('Vector maintenance is running')
      const sourceSyncEpoch = getSourceFileSyncMutationEpoch()
      try {
        const response = await searchSemanticImages({
          text,
          topK: numeric(input.topK, 20, 1, 100),
          requestId: crypto.randomUUID(),
          isCancelled,
        })
        if (isSourceFileSyncRunning() || sourceSyncEpoch !== getSourceFileSyncMutationEpoch()) {
          throw new Error(
            'Search results were discarded because source synchronization changed the index',
          )
        }
        return {
          query: response.query,
          totalCandidates: response.totalCandidates,
          returnedCount: response.returnedCount ?? response.results.length,
          totalMs: response.totalMs,
          degraded: response.degraded,
          degradationReasons: response.degradationReasons,
          textEncoderUsed: response.textEncoderUsed,
          results: response.results.map((result, index) => ({
            id: crypto.createHash('sha256').update(result.path).digest('hex').slice(0, 24),
            rank: index + 1,
            score: result.finalScore,
            matchLevel: result.matchLevel,
            reasons: result.reasons,
          })),
        }
      } finally {
        releaseSearch()
      }
    }
    case 'imageSearch.stop':
      return stopImageSearchScan()
    case 'mediaSearch.status':
      await warmFfmpegStatusCache()
      return getMediaSearchStatus()
    case 'mediaSearch.search': {
      const text = typeof input.text === 'string' ? input.text.trim().slice(0, 500) : ''
      if (!text) throw new Error('Text query is required')
      if (isSourceFileSyncRunning()) throw new Error('Source file synchronization is running')
      const releaseSearch = tryAcquireVectorSearchReservation()
      if (!releaseSearch) throw new Error('Vector maintenance is running')
      const sourceSyncEpoch = getSourceFileSyncMutationEpoch()
      try {
        const response = await searchVideoFramesByText({
          textQuery: text,
          topK: numeric(input.topK, 20, 1, 100),
          isCancelled,
        })
        if (isSourceFileSyncRunning() || sourceSyncEpoch !== getSourceFileSyncMutationEpoch()) {
          throw new Error(
            'Search results were discarded because source synchronization changed the index',
          )
        }
        return response
      } finally {
        releaseSearch()
      }
    }
    case 'folder.sources': {
      const service = getSourceCatalogService()
      return {
        ready: service !== null,
        sources: listFolderStatsSources(service?.listSources() ?? []),
      }
    }
    case 'folder.stats': {
      const service = getSourceCatalogService()
      if (!service) throw new Error('Folder source catalog is not ready')
      const sourceId = typeof input.sourceId === 'string' ? input.sourceId.trim() : ''
      const source = service.listSources().find((candidate) => candidate.id === sourceId)
      if (!source) throw new Error('Registered folder source was not found')
      return scanSourceFolderStats(
        source,
        typeof input.relativePath === 'string' ? input.relativePath : '',
        { isCancelled },
      )
    }
    case 'storage.largeFiles': {
      const scope: StorageLargeFileScope =
        input.scope === 'user' || input.scope === 'downloads' || input.scope === 'temporary'
          ? input.scope
          : 'computer'
      const assessment: LargeFileAssessmentFilter =
        input.assessment === 'low-risk' ||
        input.assessment === 'review' ||
        input.assessment === 'protected'
          ? input.assessment
          : 'all'
      return scanStorageLargeFiles(
        {
          scope,
          ...(typeof input.rootId === 'string' && { rootId: input.rootId }),
          maxEntries: numeric(input.maxEntries, 2_000_000, 1_000, 5_000_000),
          minBytes: numeric(input.minBytes, 1024 ** 3, 1024 ** 2, 8_000_000_000_000_000),
          topN: numeric(input.topN, 100, 1, 200),
          olderThanDays: numeric(input.olderThanDays, 30, 0, 36_500),
          assessment,
        },
        { isCancelled },
      )
    }
    case 'folder.largeFiles': {
      const service = getSourceCatalogService()
      if (!service) throw new Error('Folder source catalog is not ready')
      const sourceId = typeof input.sourceId === 'string' ? input.sourceId.trim() : ''
      const source = service.listSources().find((candidate) => candidate.id === sourceId)
      if (!source) throw new Error('Registered folder source was not found')
      const assessment: LargeFileAssessmentFilter =
        input.assessment === 'low-risk' ||
        input.assessment === 'review' ||
        input.assessment === 'protected'
          ? input.assessment
          : 'all'
      return scanSourceLargeFiles(
        source,
        {
          relativePath: typeof input.relativePath === 'string' ? input.relativePath : '',
          minBytes: numeric(input.minBytes, 1024 ** 3, 1024 ** 2, 8_000_000_000_000_000),
          topN: numeric(input.topN, 100, 1, 200),
          olderThanDays: numeric(input.olderThanDays, 30, 0, 36_500),
          assessment,
        },
        { isCancelled },
      )
    }
    case 'assetLibrary.stats':
      return getAssetLibraryStats()
    case 'assetLibrary.search': {
      const request: AssetLibraryListRequest = {
        ...(typeof input.query === 'string' && { query: input.query.slice(0, 500) }),
        offset: numeric(input.offset, 0, 0, 1_000_000),
        limit: numeric(input.limit, 20, 1, 100),
        ...(typeof input.categoryId === 'number' && {
          categoryId: numeric(input.categoryId, 1, 1, 1_000_000_000),
        }),
        ...(typeof input.tagId === 'number' && {
          tagId: numeric(input.tagId, 1, 1, 1_000_000_000),
        }),
        ...(typeof input.unclassified === 'boolean' && { unclassified: input.unclassified }),
        ...(typeof input.archivedOnly === 'boolean' && { archivedOnly: input.archivedOnly }),
        ...(input.sort === 'updated_desc' || input.sort === 'name_asc' || input.sort === 'size_desc'
          ? { sort: input.sort }
          : {}),
      }
      return listAssetLibraryAssets(request)
    }
    default:
      throw new Error('Unknown capability')
  }
}

async function runJob(
  job: AiJob,
  input: Record<string, unknown>,
  requestId: string,
): Promise<void> {
  const capability = capabilityById(job.capabilityId)
  if (!capability) return
  const startedAt = Date.now()
  if (job.cancellationRequested) {
    job.state = 'cancelled'
    job.updatedAt = new Date().toISOString()
    notifyJob(job)
    return
  }
  job.state = 'running'
  job.updatedAt = new Date().toISOString()
  activeCapabilities.add(job.capabilityId)
  notifyJob(job)
  let outcome = 'succeeded'
  let timeoutHandle: NodeJS.Timeout | undefined
  let timedOut = false
  const controller = new AbortController()
  jobControllers.set(job.id, controller)
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(new Error('Capability timed out'))
      }, capability.timeoutMs)
    })
    const result = await Promise.race([
      executeCapability(job.capabilityId, input, () => controller.signal.aborted),
      timeout,
    ])
    job.result = redactAiControlValue(result)
    job.state = job.cancellationRequested ? 'cancelled' : 'succeeded'
    outcome = job.state
  } catch (error) {
    const cancelled = job.cancellationRequested || (controller.signal.aborted && !timedOut)
    job.state = cancelled ? 'cancelled' : 'failed'
    if (!cancelled) {
      job.error = {
        code: timedOut ? 'timed_out' : 'execution_failed',
        message: errorMessage(error),
      }
    }
    outcome = job.state
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    activeCapabilities.delete(job.capabilityId)
    jobControllers.delete(job.id)
    job.updatedAt = new Date().toISOString()
    appendAudit({
      timestamp: job.updatedAt,
      capabilityId: job.capabilityId,
      outcome,
      durationMs: Date.now() - startedAt,
      requestId,
      inputKeys: Object.keys(input).sort(),
    })
    notifyJob(job)
  }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!authorizeRequest(request, response)) return
  pruneRuntimeState()
  const requestId = crypto.randomUUID()
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${config.port}`)
  if (request.method === 'GET' && url.pathname === '/v1/health') {
    json(response, 200, await executeCapability('system.health', {}))
    return
  }
  if (request.method === 'GET' && url.pathname === '/v1/version') {
    json(response, 200, await executeCapability('system.version', {}))
    return
  }
  if (request.method === 'GET' && url.pathname === '/v1/capabilities') {
    json(response, 200, {
      capabilities: allowedCapabilities(),
      tokenScopes: config.tokenScopes,
      availableScopes: AI_CONTROL_SCOPES,
    })
    return
  }
  if (request.method === 'GET' && url.pathname === '/v1/openapi.json') {
    json(response, 200, buildAiControlOpenApi(allowedCapabilities(), config.port))
    return
  }
  if (request.method === 'GET' && url.pathname === '/v1/events') {
    const streamAddress = request.socket.remoteAddress ?? 'loopback'
    if (!sseStreamLimiter.acquire(streamAddress)) {
      json(response, 429, {
        error: {
          code: 'sse_concurrency_limit',
          message: 'Too many concurrent event streams.',
        },
      })
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    })
    response.write(': connected\n\n')
    const heartbeat = setInterval(() => {
      if (
        response.destroyed ||
        response.writableEnded ||
        response.writableLength > SSE_MAX_BUFFER_BYTES
      ) {
        closeEventStream(response)
        return
      }
      response.write(`: heartbeat ${Date.now()}\n\n`)
    }, SSE_HEARTBEAT_MS)
    heartbeat.unref()
    eventStreams.set(response, { heartbeat, address: streamAddress })
    request.once('close', () => closeEventStream(response))
    return
  }
  const jobMatch = url.pathname.match(/^\/v1\/jobs\/([a-f0-9-]+)$/)
  if (jobMatch && request.method === 'GET') {
    const job = jobs.get(jobMatch[1])
    json(
      response,
      job ? 200 : 404,
      job ? redactAiControlValue(job) : { error: { code: 'not_found' } },
    )
    return
  }
  if (jobMatch && request.method === 'POST' && url.searchParams.get('action') === 'cancel') {
    const job = jobs.get(jobMatch[1])
    if (!job) {
      json(response, 404, { error: { code: 'not_found' } })
      return
    }
    if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') {
      json(response, 409, {
        error: { code: 'job_not_cancellable', message: `Job is already ${job.state}.` },
      })
      return
    }
    job.cancellationRequested = true
    jobControllers.get(job.id)?.abort()
    if (job.state === 'queued') job.state = 'cancelled'
    job.updatedAt = new Date().toISOString()
    notifyJob(job)
    json(response, 202, redactAiControlValue(job))
    return
  }
  const actionMatch = url.pathname.match(/^\/v1\/actions\/([A-Za-z0-9.]+)$/)
  if (!actionMatch || request.method !== 'POST') {
    json(response, 404, { error: { code: 'not_found', message: 'Unknown endpoint.' } })
    return
  }
  const capability = capabilityById(actionMatch[1])
  if (!capability || capability.risk === 'destructive') {
    json(response, 404, { error: { code: 'capability_not_found' } })
    return
  }
  if (!hasAiControlScopes(capability.requiredScopes, config.tokenScopes)) {
    appendAudit({
      timestamp: new Date().toISOString(),
      capabilityId: capability.id,
      outcome: 'scope_denied',
      durationMs: 0,
      requestId,
      inputKeys: [],
    })
    json(response, 403, {
      error: {
        code: 'scope_denied',
        message: `Capability requires: ${capability.requiredScopes.join(', ')}`,
      },
    })
    return
  }
  let input: Record<string, unknown>
  try {
    input = await readJsonBody(request)
  } catch (error) {
    const code = errorMessage(error)
    json(response, code === 'payload_too_large' ? 413 : 400, { error: { code } })
    return
  }
  const validationError = validateCapabilityInput(capability, input)
  if (validationError) {
    json(response, 400, { error: { code: 'invalid_input', detail: validationError } })
    return
  }
  const rawIdempotencyKey = request.headers['idempotency-key']
  const idempotencyKey = typeof rawIdempotencyKey === 'string' ? rawIdempotencyKey.trim() : ''
  if (capability.risk === 'write' && !idempotencyKey) {
    json(response, 400, { error: { code: 'idempotency_key_required' } })
    return
  }
  if (idempotencyKey && !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
    json(response, 400, { error: { code: 'invalid_idempotency_key' } })
    return
  }
  const digest = requestDigest(capability.id, input, idempotencyKey)
  const idempotencyLookup = idempotencyKey ? `${capability.id}:${idempotencyKey}` : ''
  const previous = idempotencyLookup ? idempotencyJobs.get(idempotencyLookup) : undefined
  if (previous) {
    if (previous.requestDigest !== digest) {
      json(response, 409, {
        error: {
          code: 'idempotency_conflict',
          message: 'This idempotency key was already used with a different request.',
        },
      })
      return
    }
    if (jobs.has(previous.jobId)) {
      json(response, 202, { jobId: previous.jobId, replayed: true })
      return
    }
  }
  // Check after the asynchronous body read and idempotent replay handling.
  // No await occurs between this check and runJob's synchronous reservation.
  // Checking before readJsonBody lets simultaneous bodies both pass the gate.
  if (activeCapabilities.has(capability.id)) {
    json(response, 409, {
      error: { code: 'concurrency_limit', message: 'Capability is already running.' },
    })
    return
  }
  if (capability.confirmationRequired) {
    const rawConfirmationId = request.headers['x-reasonix-confirm']
    const confirmationId = typeof rawConfirmationId === 'string' ? rawConfirmationId.trim() : ''
    if (confirmationId) {
      const confirmation = confirmations.get(confirmationId)
      if (
        !confirmation ||
        confirmation.capabilityId !== capability.id ||
        confirmation.requestDigest !== digest ||
        confirmation.tokenSessionId !== tokenSessionId
      ) {
        json(response, 403, {
          error: {
            code: 'invalid_confirmation',
            message: 'Confirmation is missing, expired, or does not match this request.',
          },
        })
        return
      }
      if (confirmation.state === 'pending') {
        json(response, 428, {
          error: {
            code: 'confirmation_pending',
            message: 'Approve this request in Settings > AI Control.',
          },
          confirmation: publicConfirmation(confirmation),
        })
        return
      }
      if (confirmation.state === 'denied') {
        json(response, 403, { error: { code: 'confirmation_denied' } })
        return
      }
      confirmations.delete(confirmation.id)
    } else {
      let confirmation = [...confirmations.values()].find(
        (item) =>
          item.capabilityId === capability.id &&
          item.requestDigest === digest &&
          item.tokenSessionId === tokenSessionId,
      )
      if (confirmation?.state === 'denied') {
        json(response, 403, { error: { code: 'confirmation_denied' } })
        return
      }
      if (!confirmation) {
        if (confirmations.size >= MAX_CONFIRMATIONS) {
          json(response, 429, { error: { code: 'confirmation_queue_full' } })
          return
        }
        const createdAt = new Date()
        confirmation = {
          id: crypto.randomUUID(),
          capabilityId: capability.id,
          createdAt: createdAt.toISOString(),
          expiresAt: new Date(createdAt.getTime() + CONFIRMATION_TTL_MS).toISOString(),
          requestId,
          inputKeys: Object.keys(input).sort(),
          inputPreview: redactAiControlValue(input),
          requestDigest: digest,
          tokenSessionId,
          state: 'pending',
        }
        confirmations.set(confirmation.id, confirmation)
        appendAudit({
          timestamp: confirmation.createdAt,
          capabilityId: capability.id,
          outcome: 'confirmation_required',
          durationMs: 0,
          requestId,
          inputKeys: confirmation.inputKeys,
        })
      }
      json(response, 428, {
        error: {
          code: 'confirmation_required',
          message: 'Approve this request in Settings > AI Control, then repeat it unchanged.',
        },
        confirmation: publicConfirmation(confirmation),
      })
      return
    }
  }
  const now = new Date().toISOString()
  const job: AiJob = {
    id: crypto.randomUUID(),
    capabilityId: capability.id,
    state: 'queued',
    createdAt: now,
    updatedAt: now,
  }
  jobs.set(job.id, job)
  pruneRuntimeState()
  if (idempotencyLookup) {
    idempotencyJobs.set(idempotencyLookup, {
      jobId: job.id,
      requestDigest: digest,
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    })
  }
  const jobPromise = runJob(job, input, requestId).finally(() => jobPromises.delete(job.id))
  jobPromises.set(job.id, jobPromise)
  json(response, 202, { jobId: job.id, state: job.state, requestId })
}

async function startServer(): Promise<void> {
  if (server?.listening) return
  if (!plaintextToken) throw new Error('Create an AI control token before enabling the API')
  await new Promise<void>((resolve, reject) => {
    const candidate = http.createServer((request, response) => {
      void handleRequest(request, response).catch((error) => {
        if (!response.headersSent) json(response, 500, { error: { code: 'internal_error' } })
        else response.end()
        console.warn('[AI Control] request failed:', errorMessage(error))
      })
    })
    candidate.requestTimeout = 30_000
    candidate.headersTimeout = 10_000
    candidate.keepAliveTimeout = 5_000
    candidate.maxHeadersCount = 64
    candidate.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'))
    candidate.once('error', reject)
    candidate.listen(config.port, '127.0.0.1', () => {
      candidate.removeListener('error', reject)
      candidate.on('error', (error) => {
        lastError = errorMessage(error)
      })
      server = candidate
      lastError = undefined
      resolve()
    })
  })
}

async function stopServer(): Promise<void> {
  const current = server
  server = null
  for (const stream of [...eventStreams.keys()]) closeEventStream(stream)
  for (const [jobId, controller] of jobControllers) {
    const job = jobs.get(jobId)
    if (job) job.cancellationRequested = true
    controller.abort()
  }
  if (current) {
    await new Promise<void>((resolve) => {
      current.close(() => resolve())
      current.closeAllConnections()
    })
  }
  if (jobPromises.size > 0) {
    let stopWait: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.allSettled([...jobPromises.values()]),
      new Promise<void>((resolve) => {
        stopWait = setTimeout(resolve, STOP_JOB_WAIT_MS)
        stopWait.unref()
      }),
    ])
    if (stopWait) clearTimeout(stopWait)
  }
  clearRuntimeState()
}

function createToken(scopes: unknown = config.tokenScopes): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Operating-system credential encryption is unavailable')
  }
  const token = crypto.randomBytes(32).toString('base64url')
  plaintextToken = token
  tokenSessionId = crypto.createHash('sha256').update(token).digest('hex')
  config.tokenScopes = normalizeAiControlScopes(scopes)
  config.encryptedToken = safeStorage.encryptString(token).toString('base64')
  config.tokenCreatedAt = new Date().toISOString()
  persistConfig()
  return token
}

export async function initAiControlApi(initOptions: AiControlApiOptions): Promise<void> {
  options = initOptions
  loadConfig()
  loadAudit()
  if (!config.enabled) return
  try {
    await startServer()
  } catch (error) {
    lastError = errorMessage(error)
    config.enabled = false
    persistConfig()
  }
}

export function getAiControlSettingsSnapshot(): AiControlSettings {
  return publicSettings()
}

export async function enableAiControlForSmoke(): Promise<AiControlSettingsResult> {
  if (!process.env.FLOATING_CLOCK_AI_CONTROL_SMOKE_REPORT) {
    throw new Error('AI control smoke mode is not enabled')
  }
  try {
    const token = createToken(AI_CONTROL_SCOPES)
    config.enabled = true
    persistConfig()
    await startServer()
    return { ok: true, settings: publicSettings(), token }
  } catch (error) {
    lastError = errorMessage(error)
    return { ok: false, settings: publicSettings(), error: lastError }
  }
}

export async function rotateAiControlForSmoke(
  scopes: AiControlScope[],
): Promise<AiControlSettingsResult> {
  if (!process.env.FLOATING_CLOCK_AI_CONTROL_SMOKE_REPORT) {
    throw new Error('AI control smoke mode is not enabled')
  }
  try {
    await stopServer()
    const token = createToken(scopes)
    await startServer()
    return { ok: true, settings: publicSettings(), token }
  } catch (error) {
    lastError = errorMessage(error)
    return { ok: false, settings: publicSettings(), error: lastError }
  }
}

export function approveAiControlConfirmationForSmoke(confirmationId: string): boolean {
  if (!process.env.FLOATING_CLOCK_AI_CONTROL_SMOKE_REPORT) {
    throw new Error('AI control smoke mode is not enabled')
  }
  return resolveConfirmationDecision(confirmationId, true).ok
}

export function registerAiControlIpc(): void {
  secureIpcMain.handle('aiControl:getSettings', () => publicSettings())
  secureIpcMain.handle(
    'aiControl:setEnabled',
    async (_event, enabled: unknown, port: unknown, scopes: unknown) => {
      if (typeof enabled !== 'boolean') {
        return { ok: false, settings: publicSettings(), error: 'Invalid enabled flag' }
      }
      config.port = normalizeAiControlPort(port ?? config.port)
      let token: string | undefined
      try {
        if (enabled && !plaintextToken) token = createToken(scopes)
        config.enabled = enabled
        persistConfig()
        if (enabled) await startServer()
        else await stopServer()
        return { ok: true, settings: publicSettings(), ...(token && { token }) }
      } catch (error) {
        config.enabled = false
        persistConfig()
        await stopServer()
        lastError = errorMessage(error)
        return { ok: false, settings: publicSettings(), error: lastError }
      }
    },
  )
  secureIpcMain.handle(
    'aiControl:rotateToken',
    async (_event, scopes: unknown): Promise<AiControlSettingsResult> => {
      try {
        if (config.enabled) await stopServer()
        const token = createToken(scopes)
        if (config.enabled) await startServer()
        return { ok: true, settings: publicSettings(), token }
      } catch (error) {
        lastError = errorMessage(error)
        return { ok: false, settings: publicSettings(), error: lastError }
      }
    },
  )
  secureIpcMain.handle('aiControl:getAudit', () => auditEntries.slice(-100).reverse())
  secureIpcMain.handle('aiControl:getConfirmations', () => listConfirmations())
  secureIpcMain.handle(
    'aiControl:resolveConfirmation',
    (_event, confirmationId: unknown, approved: unknown): AiControlConfirmationResult =>
      resolveConfirmationDecision(confirmationId, approved),
  )
}

export async function shutdownAiControlApi(): Promise<void> {
  await stopServer()
  await auditWriteChain
  plaintextToken = ''
  tokenSessionId = ''
}
