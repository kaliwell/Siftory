import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const SOURCE_VECTOR_INVALIDATION_OUTBOX_VERSION = 2
export const SOURCE_VECTOR_INVALIDATION_OUTBOX_FILENAME = 'source-vector-invalidation-outbox.json'
export const MAX_SOURCE_VECTOR_INVALIDATION_INTENTS = 32
export const MAX_SOURCE_VECTOR_INVALIDATION_ENTRIES = 250_000
export const MAX_SOURCE_VECTOR_INVALIDATION_PATH_BYTES = 32 * 1024
export const MAX_SOURCE_VECTOR_INVALIDATION_VECTOR_PATHS = 4
export const MAX_SOURCE_VECTOR_INVALIDATION_OUTBOX_BYTES = 64 * 1024 * 1024
const MAX_SOURCE_VECTOR_INVALIDATION_PATH_PAYLOAD_BYTES = 48 * 1024 * 1024

export type SourceVectorInvalidationLayer = 'dino' | 'clip'

/**
 * Stable identity of the persisted Native index that an invalidation was
 * prepared against. Device/inode are decimal strings so the identity remains
 * lossless when it is serialized to JSON.
 */
export interface SourceVectorInvalidationIndexIdentity {
  canonicalRoot: string
  realPath: string
  dev: string
  ino: string
}

export interface SourceVectorInvalidationEntryInput {
  /** Exact path passed to Native hasIndexPath after its persisted index is loaded. */
  nativePath: string
  /** Source and/or project-preview paths whose DINO/CLIP rows must be retired. */
  vectorPaths: readonly string[]
}

interface SourceVectorInvalidationEntry {
  nativePath: string
  vectorPaths: string[]
}

export interface SourceVectorInvalidationIntent {
  id: string
  fingerprint: string
  createdAt: number
  updatedAt: number
  attempts: number
  layers: SourceVectorInvalidationLayer[]
  entries: SourceVectorInvalidationEntry[]
  indexIdentity?: SourceVectorInvalidationIndexIdentity
  /** Version-1 intents have no trustworthy index binding and are never replayed. */
  legacyUnbound?: true
  lastError?: string
}

interface SourceVectorInvalidationOutboxState {
  version: typeof SOURCE_VECTOR_INVALIDATION_OUTBOX_VERSION
  revision: number
  intents: SourceVectorInvalidationIntent[]
}

export interface PrepareSourceVectorInvalidationIntentOptions {
  vectorDbDir: string
  indexIdentity: SourceVectorInvalidationIndexIdentity
  entries: readonly SourceVectorInvalidationEntryInput[]
  layers?: readonly SourceVectorInvalidationLayer[]
  now?: number
}

export interface ReconcileSourceVectorInvalidationOutboxOptions {
  vectorDbDir: string
  /** Identity of the Native index currently loaded by hasIndexPath. */
  indexIdentity: SourceVectorInvalidationIndexIdentity
  /** Must reflect the loaded, persisted Native index — never an unpersisted edit view. */
  hasIndexPath: (nativePath: string) => boolean | Promise<boolean>
  invalidatePaths: (
    vectorPaths: readonly string[],
    layers: readonly SourceVectorInvalidationLayer[],
  ) => Promise<unknown>
  now?: number
}

export interface SourceVectorInvalidationOutboxStatus {
  intents: number
  entries: number
  oldestCreatedAt?: number
  lastError?: string
}

export interface SourceVectorInvalidationReconcileResult {
  /** Intents whose identity matched the currently loaded Native index. */
  processedIntents: number
  completedIntents: number
  /** Matching intents that could not be completed during this pass. */
  activePendingIntents: number
  /** Intents bound to another index (including all legacy unbound intents). */
  deferredIntents: number
  /** Total pending count, retained for backwards-compatible callers. */
  pendingIntents: number
  invalidatedEntries: number
  invalidatedVectorPaths: number
  discardedUncommittedEntries: number
  probeFailures: number
  errors: string[]
}

const outboxChains = new Map<string, Promise<void>>()

function emptyState(): SourceVectorInvalidationOutboxState {
  return { version: SOURCE_VECTOR_INVALIDATION_OUTBOX_VERSION, revision: 0, intents: [] }
}

function pathKey(filePath: string): string {
  return filePath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boundedError(error: unknown): string {
  return errorMessage(error).slice(0, 1_000)
}

function validatePath(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_SOURCE_VECTOR_INVALIDATION_PATH_BYTES
  ) {
    throw new Error(`Invalid source-vector invalidation ${field}`)
  }
  return value
}

function canonicalizeIdentityPath(value: unknown, field: string): string {
  const input = validatePath(value, field)
  if (!path.isAbsolute(input)) {
    throw new Error(`Invalid source-vector invalidation ${field}: path must be absolute`)
  }
  let normalized = path.normalize(path.resolve(input))
  if (normalized !== path.parse(normalized).root) {
    normalized = normalized.replace(/[\\/]+$/, '')
  }
  if (process.platform === 'win32') normalized = normalized.toLowerCase()
  if (input !== normalized) {
    throw new Error(`Invalid source-vector invalidation ${field}: path is not canonical`)
  }
  if (normalized === path.parse(normalized).root) {
    throw new Error(`Invalid source-vector invalidation ${field}: filesystem root is not allowed`)
  }
  return normalized
}

function validateIndexNumber(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{1,40}$/.test(value)) {
    throw new Error(`Invalid source-vector invalidation index ${field}`)
  }
  const normalized = BigInt(value).toString(10)
  if (normalized !== value) {
    throw new Error(`Invalid source-vector invalidation index ${field}: value is not canonical`)
  }
  return normalized
}

function normalizeIndexIdentity(value: unknown): SourceVectorInvalidationIndexIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid source-vector invalidation index identity')
  }
  const identity = value as Partial<SourceVectorInvalidationIndexIdentity>
  const canonicalRoot = canonicalizeIdentityPath(identity.canonicalRoot, 'canonical index root')
  const realPath = canonicalizeIdentityPath(identity.realPath, 'real index root')
  return {
    canonicalRoot,
    realPath,
    dev: validateIndexNumber(identity.dev, 'device'),
    ino: validateIndexNumber(identity.ino, 'inode'),
  }
}

function indexIdentityKey(identity: SourceVectorInvalidationIndexIdentity): string {
  return JSON.stringify([identity.canonicalRoot, identity.realPath, identity.dev, identity.ino])
}

/**
 * Resolves a real on-disk Native index directory into the identity persisted in
 * each outbox intent. Call this again after loading or switching manifests.
 */
export async function resolveSourceVectorInvalidationIndexIdentity(
  indexRoot: string,
): Promise<SourceVectorInvalidationIndexIdentity> {
  const rawRoot = validatePath(indexRoot, 'index root')
  if (!path.isAbsolute(rawRoot)) {
    throw new Error('Invalid source-vector invalidation index root: path must be absolute')
  }
  let resolvedRoot = path.normalize(path.resolve(rawRoot))
  if (resolvedRoot !== path.parse(resolvedRoot).root) {
    resolvedRoot = resolvedRoot.replace(/[\\/]+$/, '')
  }
  let canonicalRoot = resolvedRoot
  if (process.platform === 'win32') canonicalRoot = canonicalRoot.toLowerCase()
  if (canonicalRoot === path.parse(canonicalRoot).root) {
    throw new Error('Invalid source-vector invalidation index root: filesystem root is not allowed')
  }
  const resolvedRealPath = await fs.promises.realpath(resolvedRoot)
  let realPathForStat = path.normalize(path.resolve(resolvedRealPath))
  if (realPathForStat !== path.parse(realPathForStat).root) {
    realPathForStat = realPathForStat.replace(/[\\/]+$/, '')
  }
  let realPath = realPathForStat
  if (process.platform === 'win32') realPath = realPath.toLowerCase()
  const stat = await fs.promises.stat(realPathForStat, { bigint: true })
  if (!stat.isDirectory()) {
    throw new Error('Invalid source-vector invalidation index root: expected a directory')
  }
  return normalizeIndexIdentity({
    canonicalRoot,
    realPath,
    dev: stat.dev.toString(10),
    ino: stat.ino.toString(10),
  })
}

function normalizeLayers(
  layers: readonly SourceVectorInvalidationLayer[] | undefined,
): SourceVectorInvalidationLayer[] {
  const requested: readonly unknown[] = layers || ['dino', 'clip']
  if (
    !Array.isArray(requested) ||
    requested.some((layer) => layer !== 'dino' && layer !== 'clip')
  ) {
    throw new Error('Source-vector invalidation contains an unsupported vector layer')
  }
  const selected = [...new Set(requested)] as SourceVectorInvalidationLayer[]
  if (selected.length === 0) throw new Error('Source-vector invalidation requires a vector layer')
  return selected.sort()
}

function normalizeEntries(
  entries: readonly SourceVectorInvalidationEntryInput[],
): SourceVectorInvalidationEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Source-vector invalidation intent is empty')
  }
  if (entries.length > MAX_SOURCE_VECTOR_INVALIDATION_ENTRIES) {
    throw new Error('Source-vector invalidation intent exceeds its entry limit')
  }
  const byNativePath = new Map<string, SourceVectorInvalidationEntry>()
  let pathPayloadBytes = 0
  for (const rawEntry of entries) {
    const nativePath = validatePath(rawEntry?.nativePath, 'Native path')
    pathPayloadBytes += Buffer.byteLength(nativePath, 'utf8')
    if (!Array.isArray(rawEntry?.vectorPaths) || rawEntry.vectorPaths.length === 0) {
      throw new Error('Source-vector invalidation vector path list is empty')
    }
    if (rawEntry.vectorPaths.length > MAX_SOURCE_VECTOR_INVALIDATION_VECTOR_PATHS) {
      throw new Error('Source-vector invalidation vector path list exceeds its limit')
    }
    const nativeKey = pathKey(nativePath)
    const existing = byNativePath.get(nativeKey) || { nativePath, vectorPaths: [] }
    const vectorKeys = new Set(existing.vectorPaths.map(pathKey))
    for (const rawVectorPath of rawEntry.vectorPaths) {
      const vectorPath = validatePath(rawVectorPath, 'vector path')
      pathPayloadBytes += Buffer.byteLength(vectorPath, 'utf8')
      if (pathPayloadBytes > MAX_SOURCE_VECTOR_INVALIDATION_PATH_PAYLOAD_BYTES) {
        throw new Error('Source-vector invalidation path payload exceeds its byte limit')
      }
      const vectorKey = pathKey(vectorPath)
      if (!vectorKeys.has(vectorKey)) {
        vectorKeys.add(vectorKey)
        existing.vectorPaths.push(vectorPath)
      }
    }
    if (existing.vectorPaths.length > MAX_SOURCE_VECTOR_INVALIDATION_VECTOR_PATHS) {
      throw new Error('Merged source-vector invalidation vector path list exceeds its limit')
    }
    byNativePath.set(nativeKey, existing)
  }
  return [...byNativePath.values()].sort((left, right) =>
    pathKey(left.nativePath).localeCompare(pathKey(right.nativePath)),
  )
}

function intentFingerprint(
  indexIdentity: SourceVectorInvalidationIndexIdentity,
  layers: readonly SourceVectorInvalidationLayer[],
  entries: readonly SourceVectorInvalidationEntry[],
): string {
  const stable = entries.map((entry) => ({
    nativePath: pathKey(entry.nativePath),
    vectorPaths: entry.vectorPaths.map(pathKey).sort(),
  }))
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        indexIdentity: [
          indexIdentity.canonicalRoot,
          indexIdentity.realPath,
          indexIdentity.dev,
          indexIdentity.ino,
        ],
        layers: [...layers].sort(),
        entries: stable,
      }),
      'utf8',
    )
    .digest('hex')
}

function legacyIntentFingerprint(
  layers: readonly SourceVectorInvalidationLayer[],
  entries: readonly SourceVectorInvalidationEntry[],
): string {
  const stable = entries.map((entry) => ({
    nativePath: pathKey(entry.nativePath),
    vectorPaths: entry.vectorPaths.map(pathKey).sort(),
  }))
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ layers: [...layers].sort(), entries: stable }), 'utf8')
    .digest('hex')
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}

function validateIntent(raw: unknown, fromLegacyState = false): SourceVectorInvalidationIntent {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid source-vector intent')
  const intent = raw as Partial<SourceVectorInvalidationIntent>
  if (
    typeof intent.id !== 'string' ||
    !/^[a-f\d-]{16,64}$/i.test(intent.id) ||
    typeof intent.fingerprint !== 'string' ||
    !/^[a-f\d]{64}$/.test(intent.fingerprint) ||
    !isSafeInteger(intent.createdAt, 1) ||
    !isSafeInteger(intent.updatedAt, 1) ||
    !isSafeInteger(intent.attempts) ||
    !Array.isArray(intent.entries) ||
    intent.entries.length === 0 ||
    intent.entries.length > MAX_SOURCE_VECTOR_INVALIDATION_ENTRIES
  ) {
    throw new Error('Invalid source-vector invalidation intent metadata')
  }
  const layers = normalizeLayers(intent.layers)
  const entries = normalizeEntries(intent.entries)
  if (
    fromLegacyState &&
    (Object.prototype.hasOwnProperty.call(intent, 'indexIdentity') ||
      Object.prototype.hasOwnProperty.call(intent, 'legacyUnbound'))
  ) {
    throw new Error('Legacy source-vector invalidation intent contains identity metadata')
  }
  const legacyUnbound = fromLegacyState || intent.legacyUnbound === true
  let indexIdentity: SourceVectorInvalidationIndexIdentity | undefined
  let fingerprint: string
  if (legacyUnbound) {
    if (!fromLegacyState && intent.legacyUnbound !== true) {
      throw new Error('Invalid legacy source-vector invalidation binding')
    }
    if (intent.indexIdentity !== undefined) {
      throw new Error('Legacy source-vector invalidation intent cannot carry an index identity')
    }
    fingerprint = legacyIntentFingerprint(layers, entries)
  } else {
    if (intent.legacyUnbound !== undefined) {
      throw new Error('Invalid source-vector invalidation legacy marker')
    }
    indexIdentity = normalizeIndexIdentity(intent.indexIdentity)
    fingerprint = intentFingerprint(indexIdentity, layers, entries)
  }
  if (fingerprint !== intent.fingerprint) {
    throw new Error('Source-vector invalidation intent fingerprint mismatch')
  }
  if (intent.lastError !== undefined && typeof intent.lastError !== 'string') {
    throw new Error('Invalid source-vector invalidation error metadata')
  }
  return {
    id: intent.id,
    fingerprint,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
    attempts: intent.attempts,
    layers,
    entries,
    ...(indexIdentity ? { indexIdentity } : { legacyUnbound: true as const }),
    ...(intent.lastError ? { lastError: intent.lastError.slice(0, 1_000) } : {}),
  }
}

function validateState(raw: unknown): SourceVectorInvalidationOutboxState {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid source-vector outbox')
  const state = raw as {
    version?: unknown
    revision?: unknown
    intents?: unknown
  }
  const legacyState = state.version === 1
  if (
    (!legacyState && state.version !== SOURCE_VECTOR_INVALIDATION_OUTBOX_VERSION) ||
    !isSafeInteger(state.revision) ||
    !Array.isArray(state.intents) ||
    state.intents.length > MAX_SOURCE_VECTOR_INVALIDATION_INTENTS
  ) {
    throw new Error('Invalid source-vector invalidation outbox metadata')
  }
  const intents = state.intents.map((intent) => validateIntent(intent, legacyState))
  const totalEntries = intents.reduce((sum, intent) => sum + intent.entries.length, 0)
  if (totalEntries > MAX_SOURCE_VECTOR_INVALIDATION_ENTRIES) {
    throw new Error('Source-vector invalidation outbox exceeds its total entry limit')
  }
  if (new Set(intents.map((intent) => intent.id)).size !== intents.length) {
    throw new Error('Source-vector invalidation outbox contains duplicate intent IDs')
  }
  return { version: SOURCE_VECTOR_INVALIDATION_OUTBOX_VERSION, revision: state.revision, intents }
}

export function sourceVectorInvalidationOutboxPath(vectorDbDir: string): string {
  const resolved = path.resolve(vectorDbDir)
  if (!resolved || path.parse(resolved).root === resolved) {
    throw new Error('Refusing to place source-vector outbox at a filesystem root')
  }
  return path.join(resolved, SOURCE_VECTOR_INVALIDATION_OUTBOX_FILENAME)
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.promises.open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is unavailable on some Windows filesystems.
  }
}

async function readState(filePath: string): Promise<SourceVectorInvalidationOutboxState> {
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw error
  }
  if (!stat.isFile() || stat.size > MAX_SOURCE_VECTOR_INVALIDATION_OUTBOX_BYTES) {
    throw new Error('Source-vector invalidation outbox exceeds its file limit')
  }
  const serialized = await fs.promises.readFile(filePath, 'utf8')
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SOURCE_VECTOR_INVALIDATION_OUTBOX_BYTES) {
    throw new Error('Source-vector invalidation outbox exceeds its file limit')
  }
  return validateState(JSON.parse(serialized))
}

async function writeState(
  filePath: string,
  state: SourceVectorInvalidationOutboxState,
): Promise<void> {
  const serialized = JSON.stringify(validateState(state))
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SOURCE_VECTOR_INVALIDATION_OUTBOX_BYTES) {
    throw new Error('Source-vector invalidation outbox exceeds its file limit')
  }
  const directory = path.dirname(filePath)
  await fs.promises.mkdir(directory, { recursive: true })
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(temporary, 'wx')
    await handle.writeFile(serialized, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await fs.promises.rename(temporary, filePath)
    await syncDirectory(directory)
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.promises.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

async function serializeOutbox<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath).toLowerCase()
  const previous = outboxChains.get(key) || Promise.resolve()
  const run = previous.catch(() => {}).then(action)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  outboxChains.set(key, tail)
  try {
    return await run
  } finally {
    if (outboxChains.get(key) === tail) outboxChains.delete(key)
  }
}

/**
 * Durably records a vector cleanup intent before Native persistence. Callers
 * may prepare it immediately before the in-memory mutation (strongest WAL
 * ordering) or after that mutation but before persist. A restart can then
 * distinguish a committed delete from an abandoned edit with hasIndexPath.
 */
export async function prepareSourceVectorInvalidationIntent(
  options: PrepareSourceVectorInvalidationIntentOptions,
): Promise<SourceVectorInvalidationIntent> {
  const filePath = sourceVectorInvalidationOutboxPath(options.vectorDbDir)
  const indexIdentity = normalizeIndexIdentity(options.indexIdentity)
  const layers = normalizeLayers(options.layers)
  const entries = normalizeEntries(options.entries)
  const fingerprint = intentFingerprint(indexIdentity, layers, entries)
  const now = options.now ?? Date.now()
  if (!isSafeInteger(now, 1)) throw new Error('Invalid source-vector invalidation timestamp')
  return serializeOutbox(filePath, async () => {
    const state = await readState(filePath)
    const duplicate = state.intents.find((intent) => intent.fingerprint === fingerprint)
    if (duplicate) return duplicate
    const totalEntries = state.intents.reduce((sum, intent) => sum + intent.entries.length, 0)
    if (state.intents.length >= MAX_SOURCE_VECTOR_INVALIDATION_INTENTS) {
      throw new Error('Source-vector invalidation outbox is full')
    }
    if (totalEntries + entries.length > MAX_SOURCE_VECTOR_INVALIDATION_ENTRIES) {
      throw new Error('Source-vector invalidation outbox entry capacity exceeded')
    }
    const intent: SourceVectorInvalidationIntent = {
      id: crypto.randomUUID(),
      fingerprint,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      layers,
      entries,
      indexIdentity,
    }
    await writeState(filePath, {
      ...state,
      revision: state.revision + 1,
      intents: [...state.intents, intent],
    })
    return intent
  })
}

/**
 * Reconciles only against a loaded, persisted Native index. Entries still in
 * Native are abandoned edits and are discarded. Missing entries are safe to
 * invalidate; a failed or partially successful invalidation remains queued in
 * full because replaying tombstones is logically idempotent.
 */
export async function reconcileSourceVectorInvalidationOutbox(
  options: ReconcileSourceVectorInvalidationOutboxOptions,
): Promise<SourceVectorInvalidationReconcileResult> {
  const filePath = sourceVectorInvalidationOutboxPath(options.vectorDbDir)
  const currentIndexIdentity = normalizeIndexIdentity(options.indexIdentity)
  const currentIndexIdentityKey = indexIdentityKey(currentIndexIdentity)
  const now = options.now ?? Date.now()
  if (!isSafeInteger(now, 1)) throw new Error('Invalid source-vector reconciliation timestamp')
  return serializeOutbox(filePath, async () => {
    const state = await readState(filePath)
    const nextIntents: SourceVectorInvalidationIntent[] = []
    const errors: string[] = []
    let completedIntents = 0
    let invalidatedEntries = 0
    let invalidatedVectorPaths = 0
    let discardedUncommittedEntries = 0
    let probeFailures = 0
    let activePendingIntents = 0
    let deferredIntents = 0

    for (const intent of state.intents) {
      if (
        !intent.indexIdentity ||
        indexIdentityKey(intent.indexIdentity) !== currentIndexIdentityKey
      ) {
        deferredIntents += 1
        nextIntents.push(intent)
        continue
      }
      const committed: SourceVectorInvalidationEntry[] = []
      const unknown: SourceVectorInvalidationEntry[] = []
      const probeErrors: string[] = []
      for (let index = 0; index < intent.entries.length; index++) {
        const entry = intent.entries[index]
        try {
          if (await options.hasIndexPath(entry.nativePath)) discardedUncommittedEntries += 1
          else committed.push(entry)
        } catch (error) {
          probeFailures += 1
          unknown.push(entry)
          probeErrors.push(`${entry.nativePath}: ${boundedError(error)}`)
        }
        if ((index + 1) % 2_048 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }

      const vectorPaths = [
        ...new Map(
          committed
            .flatMap((entry) => entry.vectorPaths)
            .map((vectorPath) => [pathKey(vectorPath), vectorPath]),
        ).values(),
      ]
      let invalidationError: string | undefined
      if (vectorPaths.length > 0) {
        try {
          await options.invalidatePaths(vectorPaths, intent.layers)
          invalidatedEntries += committed.length
          invalidatedVectorPaths += vectorPaths.length
        } catch (error) {
          invalidationError = boundedError(error)
          errors.push(`${intent.id}: ${invalidationError}`)
        }
      }
      if (probeErrors.length > 0) errors.push(...probeErrors.slice(0, 20))

      const remaining = [...(invalidationError ? committed : []), ...unknown]
      if (remaining.length === 0) {
        completedIntents += 1
        continue
      }
      activePendingIntents += 1
      nextIntents.push({
        ...intent,
        entries: remaining,
        fingerprint: intentFingerprint(
          intent.indexIdentity,
          intent.layers,
          normalizeEntries(remaining),
        ),
        attempts: intent.attempts + 1,
        updatedAt: now,
        lastError: invalidationError || probeErrors[0] || 'Native path probe was incomplete',
      })
    }

    if (
      nextIntents.length !== state.intents.length ||
      nextIntents.some((intent, index) => intent !== state.intents[index])
    ) {
      await writeState(filePath, {
        ...state,
        revision: state.revision + 1,
        intents: nextIntents,
      })
    }
    return {
      processedIntents: state.intents.length - deferredIntents,
      completedIntents,
      activePendingIntents,
      deferredIntents,
      pendingIntents: nextIntents.length,
      invalidatedEntries,
      invalidatedVectorPaths,
      discardedUncommittedEntries,
      probeFailures,
      errors,
    }
  })
}

export async function getSourceVectorInvalidationOutboxStatus(
  vectorDbDir: string,
): Promise<SourceVectorInvalidationOutboxStatus> {
  const filePath = sourceVectorInvalidationOutboxPath(vectorDbDir)
  return serializeOutbox(filePath, async () => {
    const state = await readState(filePath)
    const lastError = [...state.intents].reverse().find((intent) => intent.lastError)?.lastError
    return {
      intents: state.intents.length,
      entries: state.intents.reduce((sum, intent) => sum + intent.entries.length, 0),
      ...(state.intents[0] ? { oldestCreatedAt: state.intents[0].createdAt } : {}),
      ...(lastError ? { lastError } : {}),
    }
  })
}

/** Explicit rollback hook; callers must first prove the Native edit was not persisted. */
export async function discardSourceVectorInvalidationIntent(
  vectorDbDir: string,
  intentId: string,
): Promise<boolean> {
  const filePath = sourceVectorInvalidationOutboxPath(vectorDbDir)
  return serializeOutbox(filePath, async () => {
    const state = await readState(filePath)
    const intents = state.intents.filter((intent) => intent.id !== intentId)
    if (intents.length === state.intents.length) return false
    await writeState(filePath, { ...state, revision: state.revision + 1, intents })
    return true
  })
}
