import crypto from 'crypto'
import type { AiControlScope } from '../shared/ipc-contract'

export type AiCapabilityRisk = 'read' | 'write' | 'destructive'

export interface AiCapabilityDescriptor {
  id: string
  version: 1
  description: string
  risk: AiCapabilityRisk
  requiredScopes: AiControlScope[]
  confirmationRequired: boolean
  timeoutMs: number
  concurrency: number
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  cancellation: 'cooperative' | 'not_applicable'
  pathPolicy: 'none' | 'redacted'
  idempotency: 'required' | 'not_required'
}

export const AI_CONTROL_CAPABILITIES: readonly AiCapabilityDescriptor[] = Object.freeze([
  capability('system.health', 'Read application health.', 'read', ['read']),
  capability('system.capabilities', 'List callable capabilities and schemas.', 'read', ['read']),
  capability('system.version', 'Read the application version.', 'read', ['read']),
  capability('window.show', 'Show the overlay workspace.', 'write', ['window']),
  capability('window.hide', 'Hide the overlay workspace.', 'write', ['window']),
  capability('window.listDisplays', 'List displays and active workspace scope.', 'read', ['read']),
  capability(
    'window.selectDisplay',
    'Select all, primary, or one display for the workspace.',
    'write',
    ['window'],
    {
      type: 'object',
      properties: {
        mode: { enum: ['all', 'primary', 'display'] },
        displayId: { type: 'string', maxLength: 64 },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  ),
  capability('imageSearch.status', 'Read image-search status.', 'read', ['read']),
  capability(
    'imageSearch.search',
    'Search existing CLIP image embeddings without exposing local file paths.',
    'read',
    ['search'],
    textSearchSchema(),
    120_000,
    { cancellation: 'cooperative', pathPolicy: 'redacted' },
  ),
  capability('imageSearch.stop', 'Stop the active image scan.', 'write', ['control']),
  capability('mediaSearch.status', 'Read media-search status.', 'read', ['read']),
  capability(
    'mediaSearch.search',
    'Search indexed video frames with a text query.',
    'read',
    ['search'],
    textSearchSchema(),
    120_000,
    { cancellation: 'cooperative', pathPolicy: 'redacted' },
  ),
  capability(
    'folder.sources',
    'List registered local folder sources without exposing filesystem locations.',
    'read',
    ['read'],
    { type: 'object', additionalProperties: false },
    15_000,
    {
      pathPolicy: 'none',
      outputSchema: {
        type: 'object',
        properties: {
          ready: { type: 'boolean' },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sourceId: { type: 'string' },
                label: { type: 'string' },
                type: { type: 'string' },
                availability: { type: 'string' },
              },
              required: ['sourceId', 'label', 'type', 'availability'],
              additionalProperties: false,
            },
          },
        },
        required: ['ready', 'sources'],
        additionalProperties: false,
      },
    },
  ),
  capability(
    'folder.stats',
    'Calculate the logical size of a registered source folder on demand.',
    'read',
    ['read'],
    {
      type: 'object',
      properties: {
        sourceId: { type: 'string', minLength: 1, maxLength: 128 },
        relativePath: { type: 'string', maxLength: 2048 },
      },
      required: ['sourceId'],
      additionalProperties: false,
    },
    300_000,
    {
      cancellation: 'cooperative',
      pathPolicy: 'redacted',
      outputSchema: {
        type: 'object',
        properties: {
          sourceId: { type: 'string' },
          sourceLabel: { type: 'string' },
          bytes: { type: 'integer', minimum: 0 },
          fileCount: { type: 'integer', minimum: 0 },
          folderCount: { type: 'integer', minimum: 0 },
          inaccessibleCount: { type: 'integer', minimum: 0 },
          skippedLinkCount: { type: 'integer', minimum: 0 },
          entriesScanned: { type: 'integer', minimum: 0 },
          complete: { type: 'boolean' },
          partialReason: { type: 'string' },
          durationMs: { type: 'integer', minimum: 0 },
        },
        required: [
          'sourceId',
          'sourceLabel',
          'bytes',
          'fileCount',
          'folderCount',
          'inaccessibleCount',
          'skippedLinkCount',
          'entriesScanned',
          'complete',
          'durationMs',
        ],
        additionalProperties: false,
      },
    },
  ),
  capability(
    'storage.largeFiles',
    'Automatically discover local storage roots and find large files in one read-only call.',
    'read',
    ['search'],
    storageLargeFileSearchSchema(),
    1_800_000,
    {
      cancellation: 'cooperative',
      pathPolicy: 'redacted',
      outputSchema: storageLargeFileSearchOutputSchema(),
    },
  ),
  capability(
    'folder.largeFiles',
    'Find the largest files in a registered local source and return conservative cleanup assessments.',
    'read',
    ['search'],
    largeFileSearchSchema(),
    300_000,
    {
      cancellation: 'cooperative',
      pathPolicy: 'redacted',
      outputSchema: largeFileSearchOutputSchema(),
    },
  ),
  capability('assetLibrary.stats', 'Read asset-library aggregate statistics.', 'read', ['read']),
  capability(
    'assetLibrary.search',
    'Search asset metadata without exposing local file paths.',
    'read',
    ['search'],
    {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 500 },
        offset: { type: 'integer', minimum: 0, maximum: 1000000 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        categoryId: { type: 'integer', minimum: 1 },
        tagId: { type: 'integer', minimum: 1 },
        unclassified: { type: 'boolean' },
        archivedOnly: { type: 'boolean' },
        sort: { enum: ['updated_desc', 'name_asc', 'size_desc'] },
      },
      additionalProperties: false,
    },
  ),
])

function capability(
  id: string,
  description: string,
  risk: AiCapabilityRisk,
  requiredScopes: AiControlScope[],
  inputSchema: Record<string, unknown> = { type: 'object', additionalProperties: false },
  timeoutMs = 15_000,
  metadata: Partial<
    Pick<AiCapabilityDescriptor, 'cancellation' | 'pathPolicy' | 'outputSchema'>
  > = {},
): AiCapabilityDescriptor {
  return {
    id,
    version: 1,
    description,
    risk,
    requiredScopes,
    confirmationRequired: risk === 'write',
    timeoutMs,
    concurrency: 1,
    inputSchema,
    outputSchema: metadata.outputSchema ?? { type: 'object' },
    cancellation: metadata.cancellation ?? 'not_applicable',
    pathPolicy: metadata.pathPolicy ?? 'redacted',
    idempotency: risk === 'write' ? 'required' : 'not_required',
  }
}

export const AI_CONTROL_SCOPES: readonly AiControlScope[] = Object.freeze([
  'read',
  'window',
  'search',
  'control',
])

export function normalizeAiControlScopes(value: unknown): AiControlScope[] {
  if (!Array.isArray(value)) return [...AI_CONTROL_SCOPES]
  const requested = new Set(
    value.filter((scope): scope is AiControlScope =>
      AI_CONTROL_SCOPES.includes(scope as AiControlScope),
    ),
  )
  requested.add('read')
  return AI_CONTROL_SCOPES.filter((scope) => requested.has(scope))
}

export function hasAiControlScopes(
  requiredScopes: readonly AiControlScope[],
  tokenScopes: readonly AiControlScope[],
): boolean {
  const available = new Set(tokenScopes)
  return requiredScopes.every((scope) => available.has(scope))
}

function textSearchSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 500 },
      topK: { type: 'integer', minimum: 1, maximum: 100 },
    },
    required: ['text'],
    additionalProperties: false,
  }
}

function largeFileSearchSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      sourceId: { type: 'string', minLength: 1, maxLength: 128 },
      relativePath: { type: 'string', maxLength: 2048 },
      minBytes: { type: 'integer', minimum: 1_048_576, maximum: 8_000_000_000_000_000 },
      topN: { type: 'integer', minimum: 1, maximum: 200 },
      olderThanDays: { type: 'integer', minimum: 0, maximum: 36_500 },
      assessment: { enum: ['all', 'low-risk', 'review', 'protected'] },
    },
    required: ['sourceId'],
    additionalProperties: false,
  }
}

function storageLargeFileSearchSchema(): Record<string, unknown> {
  const driveRootIds = Array.from(
    { length: 26 },
    (_, index) => `drive-${String.fromCharCode('a'.charCodeAt(0) + index)}`,
  )
  return {
    type: 'object',
    properties: {
      scope: { enum: ['computer', 'user', 'downloads', 'temporary'] },
      rootId: { enum: driveRootIds },
      maxEntries: { type: 'integer', minimum: 1_000, maximum: 5_000_000 },
      minBytes: { type: 'integer', minimum: 1_048_576, maximum: 8_000_000_000_000_000 },
      topN: { type: 'integer', minimum: 1, maximum: 200 },
      olderThanDays: { type: 'integer', minimum: 0, maximum: 36_500 },
      assessment: { enum: ['all', 'low-risk', 'review', 'protected'] },
    },
    required: ['scope'],
    additionalProperties: false,
  }
}

function storageLargeFileSearchOutputSchema(): Record<string, unknown> {
  const countAndBytes = {
    type: 'object',
    properties: {
      count: { type: 'integer', minimum: 0 },
      bytes: { type: 'integer', minimum: 0 },
    },
    required: ['count', 'bytes'],
    additionalProperties: false,
  }
  const aggregateProperties = {
    scannedFiles: { type: 'integer', minimum: 0 },
    scannedFolders: { type: 'integer', minimum: 0 },
    scannedBytes: { type: 'integer', minimum: 0 },
    entriesScanned: { type: 'integer', minimum: 0 },
    inaccessibleCount: { type: 'integer', minimum: 0 },
    skippedLinkCount: { type: 'integer', minimum: 0 },
    candidateCount: { type: 'integer', minimum: 0 },
    candidateBytes: { type: 'integer', minimum: 0 },
    matchedCount: { type: 'integer', minimum: 0 },
    matchedBytes: { type: 'integer', minimum: 0 },
    returnedCount: { type: 'integer', minimum: 0 },
    complete: { type: 'boolean' },
    partialReason: { type: 'string' },
    durationMs: { type: 'integer', minimum: 0 },
  }
  const aggregateRequired = [
    'scannedFiles',
    'scannedFolders',
    'scannedBytes',
    'entriesScanned',
    'inaccessibleCount',
    'skippedLinkCount',
    'candidateCount',
    'candidateBytes',
    'matchedCount',
    'matchedBytes',
    'returnedCount',
    'complete',
    'durationMs',
  ]
  return {
    type: 'object',
    properties: {
      scope: { enum: ['computer', 'user', 'downloads', 'temporary'] },
      requestedRootId: { type: 'string' },
      thresholdBytes: { type: 'integer', minimum: 0 },
      entryLimit: { type: 'integer', minimum: 1_000, maximum: 5_000_000 },
      olderThanDays: { type: 'integer', minimum: 0 },
      assessmentFilter: { enum: ['all', 'low-risk', 'review', 'protected'] },
      rootsDiscovered: { type: 'integer', minimum: 0 },
      rootsScanned: { type: 'integer', minimum: 0 },
      rootsFailed: { type: 'integer', minimum: 0 },
      ...aggregateProperties,
      assessments: {
        type: 'object',
        properties: {
          'low-risk': countAndBytes,
          review: countAndBytes,
          protected: countAndBytes,
        },
        required: ['low-risk', 'review', 'protected'],
        additionalProperties: false,
      },
      roots: {
        type: 'array',
        maxItems: 26,
        items: {
          type: 'object',
          properties: {
            rootId: { type: 'string' },
            rootLabel: { type: 'string' },
            status: { enum: ['scanned', 'failed'] },
            ...aggregateProperties,
          },
          required: ['rootId', 'rootLabel', 'status', ...aggregateRequired],
          additionalProperties: false,
        },
      },
      items: {
        type: 'array',
        maxItems: 200,
        items: {
          type: 'object',
          properties: {
            rootId: { type: 'string' },
            rootLabel: { type: 'string' },
            itemId: { type: 'string' },
            name: { type: 'string' },
            relativeFile: { type: 'string' },
            extension: { type: 'string' },
            sizeBytes: { type: 'integer', minimum: 0 },
            sizeBand: { enum: ['large', 'very-large', 'huge'] },
            modifiedAt: { type: 'string', format: 'date-time' },
            ageDays: { type: 'integer', minimum: 0 },
            assessment: { enum: ['low-risk', 'review', 'protected'] },
            reasonCode: { type: 'string' },
            suggestedAction: { type: 'string' },
          },
          required: [
            'rootId',
            'rootLabel',
            'itemId',
            'name',
            'relativeFile',
            'extension',
            'sizeBytes',
            'sizeBand',
            'modifiedAt',
            'ageDays',
            'assessment',
            'reasonCode',
            'suggestedAction',
          ],
          additionalProperties: false,
        },
      },
    },
    required: [
      'scope',
      'thresholdBytes',
      'entryLimit',
      'olderThanDays',
      'assessmentFilter',
      'rootsDiscovered',
      'rootsScanned',
      'rootsFailed',
      ...aggregateRequired,
      'assessments',
      'roots',
      'items',
    ],
    additionalProperties: false,
  }
}

function largeFileSearchOutputSchema(): Record<string, unknown> {
  const assessmentSummary = {
    type: 'object',
    properties: {
      count: { type: 'integer', minimum: 0 },
      bytes: { type: 'integer', minimum: 0 },
    },
    required: ['count', 'bytes'],
    additionalProperties: false,
  }
  return {
    type: 'object',
    properties: {
      sourceId: { type: 'string' },
      sourceLabel: { type: 'string' },
      thresholdBytes: { type: 'integer', minimum: 0 },
      olderThanDays: { type: 'integer', minimum: 0 },
      assessmentFilter: { enum: ['all', 'low-risk', 'review', 'protected'] },
      scannedFiles: { type: 'integer', minimum: 0 },
      scannedFolders: { type: 'integer', minimum: 0 },
      scannedBytes: { type: 'integer', minimum: 0 },
      entriesScanned: { type: 'integer', minimum: 0 },
      inaccessibleCount: { type: 'integer', minimum: 0 },
      skippedLinkCount: { type: 'integer', minimum: 0 },
      candidateCount: { type: 'integer', minimum: 0 },
      candidateBytes: { type: 'integer', minimum: 0 },
      matchedCount: { type: 'integer', minimum: 0 },
      matchedBytes: { type: 'integer', minimum: 0 },
      returnedCount: { type: 'integer', minimum: 0 },
      complete: { type: 'boolean' },
      partialReason: { type: 'string' },
      durationMs: { type: 'integer', minimum: 0 },
      assessments: {
        type: 'object',
        properties: {
          'low-risk': assessmentSummary,
          review: assessmentSummary,
          protected: assessmentSummary,
        },
        required: ['low-risk', 'review', 'protected'],
        additionalProperties: false,
      },
      items: {
        type: 'array',
        maxItems: 200,
        items: {
          type: 'object',
          properties: {
            itemId: { type: 'string' },
            name: { type: 'string' },
            relativeFile: { type: 'string' },
            extension: { type: 'string' },
            sizeBytes: { type: 'integer', minimum: 0 },
            sizeBand: { enum: ['large', 'very-large', 'huge'] },
            modifiedAt: { type: 'string', format: 'date-time' },
            ageDays: { type: 'integer', minimum: 0 },
            assessment: { enum: ['low-risk', 'review', 'protected'] },
            reasonCode: { type: 'string' },
            suggestedAction: { type: 'string' },
          },
          required: [
            'itemId',
            'name',
            'relativeFile',
            'extension',
            'sizeBytes',
            'sizeBand',
            'modifiedAt',
            'ageDays',
            'assessment',
            'reasonCode',
            'suggestedAction',
          ],
          additionalProperties: false,
        },
      },
    },
    required: [
      'sourceId',
      'sourceLabel',
      'thresholdBytes',
      'olderThanDays',
      'assessmentFilter',
      'scannedFiles',
      'scannedFolders',
      'scannedBytes',
      'entriesScanned',
      'inaccessibleCount',
      'skippedLinkCount',
      'candidateCount',
      'candidateBytes',
      'matchedCount',
      'matchedBytes',
      'returnedCount',
      'complete',
      'durationMs',
      'assessments',
      'items',
    ],
    additionalProperties: false,
  }
}

export function normalizeAiControlPort(value: unknown): number {
  const port = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 32145
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function isAllowedLoopbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false
  const normalized = host.toLowerCase()
  return (
    normalized === `127.0.0.1:${port}` ||
    normalized === `localhost:${port}` ||
    normalized === `[::1]:${port}`
  )
}

export function isAllowedLoopbackOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.hostname === '127.0.0.1' ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === '::1') &&
      Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)) === port
    )
  } catch {
    return false
  }
}

export function tokensEqual(expected: string, actual: string): boolean {
  const expectedHash = crypto.createHash('sha256').update(expected).digest()
  const actualHash = crypto.createHash('sha256').update(actual).digest()
  return crypto.timingSafeEqual(expectedHash, actualHash)
}

export function validateCapabilityInput(
  descriptor: AiCapabilityDescriptor,
  input: Record<string, unknown>,
): string | null {
  const schema = descriptor.inputSchema
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  for (const key of required) {
    if (!(key in input)) return `missing_property:${key}`
  }
  if (schema.additionalProperties === false) {
    const unexpected = Object.keys(input).find((key) => !(key in properties))
    if (unexpected) return `unexpected_property:${unexpected}`
  }
  for (const [key, value] of Object.entries(input)) {
    const rule = properties[key]
    if (!rule) continue
    if (rule.type === 'string' && typeof value !== 'string') return `invalid_type:${key}`
    if (rule.type === 'integer' && (!Number.isInteger(value) || typeof value !== 'number')) {
      return `invalid_type:${key}`
    }
    if (rule.type === 'boolean' && typeof value !== 'boolean') return `invalid_type:${key}`
    if (typeof value === 'string') {
      if (typeof rule.minLength === 'number' && value.length < rule.minLength) {
        return `too_short:${key}`
      }
      if (typeof rule.maxLength === 'number' && value.length > rule.maxLength) {
        return `too_long:${key}`
      }
    }
    if (typeof value === 'number') {
      if (typeof rule.minimum === 'number' && value < rule.minimum) return `too_small:${key}`
      if (typeof rule.maximum === 'number' && value > rule.maximum) return `too_large:${key}`
    }
    if (Array.isArray(rule.enum) && !rule.enum.includes(value)) return `invalid_value:${key}`
  }
  return null
}

export function redactAiControlValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]'
  if (
    typeof value === 'string' &&
    /(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\|\/(?:Users|home|root|var|tmp)\/)/.test(value)
  ) {
    return '[redacted-path]'
  }
  if (Array.isArray(value))
    return value.slice(0, 200).map((item) => redactAiControlValue(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:token|secret|credential|password|command|path|directory|cacheDir)/i.test(key)) {
      output[key] = '[redacted]'
    } else {
      output[key] = redactAiControlValue(child, depth + 1)
    }
  }
  return output
}

// ── Pre-auth flood and SSE concurrency guards (VAL-029) ──

export interface AiControlAuthFailureGuardOptions {
  /** Consecutive failures inside the window that trigger a lockout. */
  maxFailures?: number
  /** Sliding window for counting failures. */
  windowMs?: number
  /** Lockout duration once the threshold is reached. */
  lockoutMs?: number
  /** Clock injection for tests. */
  now?: () => number
}

/**
 * Per-address lockout for repeated authentication failures (401). The AI
 * control endpoint previously answered an unlimited number of bad-token
 * requests — the generic rate bucket only counted requests that already
 * passed authentication — so bearer tokens could be brute-forced at full
 * speed. After maxFailures failures inside windowMs the address is locked
 * out for lockoutMs; a successful authentication clears the record.
 */
export class AiControlAuthFailureGuard {
  private readonly maxFailures: number
  private readonly windowMs: number
  private readonly lockoutMs: number
  private readonly now: () => number
  private readonly records = new Map<string, { failures: number[]; lockedUntil: number }>()

  constructor(options: AiControlAuthFailureGuardOptions = {}) {
    this.maxFailures = Math.max(1, Math.floor(options.maxFailures ?? 8))
    this.windowMs = Math.max(1_000, Math.floor(options.windowMs ?? 10 * 60_000))
    this.lockoutMs = Math.max(1_000, Math.floor(options.lockoutMs ?? 5 * 60_000))
    this.now = options.now ?? (() => Date.now())
  }

  /** Milliseconds until the address may authenticate again; 0 when not locked. */
  lockedRetryAfterMs(address: string): number {
    const record = this.records.get(address)
    if (!record) return 0
    return Math.max(0, record.lockedUntil - this.now())
  }

  /** Records a failed authentication; returns the resulting lockout (0 when not locked). */
  recordAuthFailure(address: string): number {
    const now = this.now()
    const record = this.records.get(address) ?? { failures: [], lockedUntil: 0 }
    record.failures = record.failures.filter((timestamp) => now - timestamp < this.windowMs)
    record.failures.push(now)
    if (record.failures.length >= this.maxFailures) {
      record.lockedUntil = now + this.lockoutMs
      record.failures = []
    }
    this.records.set(address, record)
    return Math.max(0, record.lockedUntil - now)
  }

  recordAuthSuccess(address: string): void {
    this.records.delete(address)
  }
}

/**
 * Bounded SSE fan-out for /v1/events: the stream set was unbounded, letting a
 * local client pin an arbitrary number of long-lived connections. Caps apply
 * globally and per remote address; acquire/release must pair (closeEventStream
 * releases exactly once per acquired stream).
 */
export class AiControlSseLimiter {
  private total = 0
  private readonly perAddress = new Map<string, number>()

  constructor(
    private readonly maxTotal = 8,
    private readonly maxPerAddress = 4,
  ) {}

  get activeCount(): number {
    return this.total
  }

  acquire(address: string): boolean {
    const current = this.perAddress.get(address) ?? 0
    if (this.total >= this.maxTotal || current >= this.maxPerAddress) return false
    this.total += 1
    this.perAddress.set(address, current + 1)
    return true
  }

  release(address: string): void {
    const current = this.perAddress.get(address) ?? 0
    if (current <= 0) return
    this.total -= 1
    if (current === 1) this.perAddress.delete(address)
    else this.perAddress.set(address, current - 1)
  }

  reset(): void {
    this.total = 0
    this.perAddress.clear()
  }
}
