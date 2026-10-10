import crypto, { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface AssetDerivedRebuildGrantRecord {
  token: string
  senderId: number
  assetId: string
  oldPath: string
  newPath: string
  reason: string
  recoveryId?: string
  createdAt: number
  expiresAt: number
}

interface AssetDerivedRebuildGrantStoreOptions {
  now?: () => number
  createToken?: () => string
  ttlMs?: number
  maxEntries?: number
}

export class AssetDerivedRebuildGrantStore {
  private readonly records = new Map<string, AssetDerivedRebuildGrantRecord>()
  private readonly now: () => number
  private readonly createToken: () => string
  private readonly ttlMs: number
  private readonly maxEntries: number

  constructor(options: AssetDerivedRebuildGrantStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.createToken = options.createToken ?? randomUUID
    this.ttlMs = Math.max(1, options.ttlMs ?? 5 * 60_000)
    this.maxEntries = Math.max(1, options.maxEntries ?? 16)
  }

  issue(
    senderId: number,
    repair: Pick<AssetDerivedRebuildGrantRecord, 'assetId' | 'oldPath' | 'newPath' | 'reason'> & {
      recoveryId?: string
    },
  ): AssetDerivedRebuildGrantRecord {
    this.prune()
    if (repair.recoveryId) {
      for (const [token, current] of this.records) {
        if (current.senderId !== senderId || current.recoveryId !== repair.recoveryId) continue
        const refreshed = { ...current, ...repair, expiresAt: this.now() + this.ttlMs }
        this.records.set(token, refreshed)
        return { ...refreshed }
      }
    }
    while (this.records.size >= this.maxEntries) {
      const oldest = this.records.keys().next().value as string | undefined
      if (!oldest) break
      this.records.delete(oldest)
    }
    const createdAt = this.now()
    const record = {
      ...repair,
      token: this.createToken(),
      senderId,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    }
    this.records.set(record.token, record)
    return { ...record }
  }

  peek(senderId: number, token: string): AssetDerivedRebuildGrantRecord | null {
    this.prune()
    const record = this.records.get(token)
    return record?.senderId === senderId ? { ...record } : null
  }

  consume(senderId: number, token: string): AssetDerivedRebuildGrantRecord | null {
    const record = this.peek(senderId, token)
    if (!record) return null
    this.records.delete(token)
    return record
  }

  refresh(senderId: number, token: string): AssetDerivedRebuildGrantRecord | null {
    this.prune()
    const record = this.records.get(token)
    if (!record || record.senderId !== senderId) return null
    const refreshed = { ...record, expiresAt: this.now() + this.ttlMs }
    this.records.set(token, refreshed)
    return { ...refreshed }
  }

  revoke(senderId: number, token: string): boolean {
    const record = this.records.get(token)
    if (!record || record.senderId !== senderId) return false
    return this.records.delete(token)
  }

  private prune(): void {
    const now = this.now()
    for (const [token, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(token)
    }
  }
}

export const assetDerivedRebuildGrants = new AssetDerivedRebuildGrantStore()

export interface AssetDerivedRebuildClaimRecord {
  key: string
  token: string
  senderId: number
  taskId: number | null
  abortController: AbortController
  ready: Promise<number | null>
  resolveReady: (taskId: number | null) => void
}

export class AssetDerivedRebuildClaimStore {
  private readonly byKey = new Map<string, AssetDerivedRebuildClaimRecord>()
  private readonly byToken = new Map<string, AssetDerivedRebuildClaimRecord>()

  claim(
    key: string,
    token: string,
    senderId: number,
  ): { created: boolean; claim: AssetDerivedRebuildClaimRecord } {
    const existing = this.byKey.get(key)
    if (existing) return { created: false, claim: existing }
    let resolveReady: (taskId: number | null) => void = () => undefined
    const claim: AssetDerivedRebuildClaimRecord = {
      key,
      token,
      senderId,
      taskId: null,
      abortController: new AbortController(),
      ready: new Promise<number | null>((resolve) => {
        resolveReady = resolve
      }),
      resolveReady: (taskId) => resolveReady(taskId),
    }
    this.byKey.set(key, claim)
    this.byToken.set(token, claim)
    return { created: true, claim }
  }

  getByToken(token: string): AssetDerivedRebuildClaimRecord | null {
    return this.byToken.get(token) ?? null
  }

  release(claim: AssetDerivedRebuildClaimRecord): void {
    if (this.byKey.get(claim.key) === claim) this.byKey.delete(claim.key)
    if (this.byToken.get(claim.token) === claim) this.byToken.delete(claim.token)
  }
}

export const ASSET_REPAIR_RECOVERY_VERSION = 3
export const ASSET_REPAIR_RECOVERY_LEGACY_VERSION = 2
export const ASSET_REPAIR_RECOVERY_FILENAME = 'asset-repair-recovery.json'
export const ASSET_REPAIR_RECOVERY_KEY_FILENAME = 'asset-repair-journal.key.json'
export const ASSET_REPAIR_RECOVERY_ANCHOR_FILENAME = 'asset-repair-journal.anchor.json'
export const MAX_ASSET_REPAIR_RECOVERY_RECORDS = 64
export const MAX_ASSET_REPAIR_RECOVERY_BYTES = 1024 * 1024
const MAX_RETAINED_COMPLETED_RECORDS = 16
const MAX_PATH_BYTES = 32 * 1024
const MAX_ERROR_BYTES = 4 * 1024
const JOURNAL_AUTH_KEY_BYTES = 32
const ANCHOR_AUTH_DOMAIN = 'asset-repair-journal-anchor'

export type AssetRepairRecoveryState =
  | 'prepared'
  | 'repairing'
  | 'awaiting-rebuild'
  | 'rebuilding'
  | 'failed'
  | 'completed'

export interface AssetRepairRecoverySteps {
  identity: boolean
  assetLibrary: boolean
  sourceCatalog: boolean
  nativeIndex: boolean
  vectorIndex: boolean
  derivedCleared: boolean
  derivedRebuilt: boolean
}

export interface AssetRepairRecoveryRecord {
  id: string
  checksum: string
  assetId: string
  oldPath: string
  newPath: string
  createdAt: number
  updatedAt: number
  attempts: number
  state: AssetRepairRecoveryState
  needsDerivedRebuild: boolean
  rebuildVectorData: boolean
  steps: AssetRepairRecoverySteps
  lastError?: string
  completedAt?: number
}

interface AssetRepairRecoveryFile {
  version: typeof ASSET_REPAIR_RECOVERY_VERSION
  revision: number
  generation: number
  records: AssetRepairRecoveryRecord[]
  authTag: string
}

interface AssetRepairRecoveryFileV2 {
  version: typeof ASSET_REPAIR_RECOVERY_LEGACY_VERSION
  revision: number
  records: AssetRepairRecoveryRecord[]
  stateChecksum: string
}

interface AssetRepairJournalAnchorFile {
  version: 1
  generation: number
  authTag: string
}

/** Protects the journal HMAC key at rest (production: Electron safeStorage/DPAPI). */
export interface AssetRepairJournalProtectionAdapter {
  isAvailable(): boolean
  encrypt(plainBase64: string): string
  decrypt(encryptedBase64: string): string
}

export interface AssetRepairRecoveryJournalOptions {
  now?: () => number
  createId?: () => string
  authKey?: Buffer
  protectionAdapter?: AssetRepairJournalProtectionAdapter
}

export type AssetRepairRecoveryUpdate = Partial<
  Pick<
    AssetRepairRecoveryRecord,
    'state' | 'needsDerivedRebuild' | 'rebuildVectorData' | 'steps' | 'lastError' | 'completedAt'
  >
> & { incrementAttempts?: boolean; markStep?: keyof AssetRepairRecoverySteps }

const writeChains = new Map<string, Promise<void>>()

type AssetRepairRecoveryStateData = Omit<AssetRepairRecoveryFile, 'authTag'>

function emptyFile(): AssetRepairRecoveryStateData {
  return { version: ASSET_REPAIR_RECOVERY_VERSION, revision: 0, generation: 0, records: [] }
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}

function validatePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new Error(`Invalid asset repair recovery ${label}`)
  }
  return path.resolve(value)
}

function boundedError(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  let output = value.trim()
  while (Buffer.byteLength(output, 'utf8') > MAX_ERROR_BYTES) {
    output = output.slice(0, Math.max(0, output.length - 64))
  }
  return output || undefined
}

function validateSteps(value: unknown): AssetRepairRecoverySteps {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid asset repair recovery step metadata')
  }
  const steps = value as Partial<AssetRepairRecoverySteps>
  const keys: Array<keyof AssetRepairRecoverySteps> = [
    'identity',
    'assetLibrary',
    'sourceCatalog',
    'nativeIndex',
    'vectorIndex',
    'derivedCleared',
    'derivedRebuilt',
  ]
  if (keys.some((key) => typeof steps[key] !== 'boolean')) {
    throw new Error('Invalid asset repair recovery step metadata')
  }
  return {
    identity: steps.identity as boolean,
    assetLibrary: steps.assetLibrary as boolean,
    sourceCatalog: steps.sourceCatalog as boolean,
    nativeIndex: steps.nativeIndex as boolean,
    vectorIndex: steps.vectorIndex as boolean,
    derivedCleared: steps.derivedCleared as boolean,
    derivedRebuilt: steps.derivedRebuilt as boolean,
  }
}

function recordPayload(
  record: Omit<AssetRepairRecoveryRecord, 'checksum'>,
): Omit<AssetRepairRecoveryRecord, 'checksum'> {
  return {
    id: record.id,
    assetId: record.assetId,
    oldPath: record.oldPath,
    newPath: record.newPath,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    attempts: record.attempts,
    state: record.state,
    needsDerivedRebuild: record.needsDerivedRebuild,
    rebuildVectorData: record.rebuildVectorData,
    steps: { ...record.steps },
    ...(record.lastError ? { lastError: record.lastError } : {}),
    ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
  }
}

function checksumFor(record: Omit<AssetRepairRecoveryRecord, 'checksum'>): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(recordPayload(record)), 'utf8')
    .digest('hex')
}

function checksumForFileV2(state: Omit<AssetRepairRecoveryFileV2, 'stateChecksum'>): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        version: state.version,
        revision: state.revision,
        records: state.records,
      }),
      'utf8',
    )
    .digest('hex')
}

function authTagForFile(key: Buffer, state: AssetRepairRecoveryStateData): string {
  return crypto
    .createHmac('sha256', key)
    .update(
      JSON.stringify({
        version: state.version,
        revision: state.revision,
        generation: state.generation,
        records: state.records,
      }),
      'utf8',
    )
    .digest('hex')
}

function authTagForAnchor(key: Buffer, generation: number): string {
  return crypto
    .createHmac('sha256', key)
    .update(`${ANCHOR_AUTH_DOMAIN}:${generation}`, 'utf8')
    .digest('hex')
}

function authTagsEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(actual, 'utf8')
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function withChecksum(
  record: Omit<AssetRepairRecoveryRecord, 'checksum'>,
): AssetRepairRecoveryRecord {
  const payload = recordPayload(record)
  return { ...payload, checksum: checksumFor(payload) }
}

function validateRecord(value: unknown): AssetRepairRecoveryRecord {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid asset repair recovery record')
  }
  const raw = value as Partial<AssetRepairRecoveryRecord>
  const validStates: readonly unknown[] = [
    'prepared',
    'repairing',
    'awaiting-rebuild',
    'rebuilding',
    'failed',
    'completed',
  ]
  if (
    typeof raw.id !== 'string' ||
    !/^[0-9a-f-]{20,80}$/i.test(raw.id) ||
    typeof raw.checksum !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(raw.checksum) ||
    typeof raw.assetId !== 'string' ||
    !/^asset_[0-9a-f]{24}$/i.test(raw.assetId) ||
    !isSafeInteger(raw.createdAt, 1) ||
    !isSafeInteger(raw.updatedAt, raw.createdAt) ||
    !isSafeInteger(raw.attempts) ||
    !validStates.includes(raw.state) ||
    typeof raw.needsDerivedRebuild !== 'boolean' ||
    typeof raw.rebuildVectorData !== 'boolean' ||
    (raw.completedAt !== undefined && !isSafeInteger(raw.completedAt, raw.createdAt))
  ) {
    throw new Error('Invalid asset repair recovery metadata')
  }
  const payload: Omit<AssetRepairRecoveryRecord, 'checksum'> = {
    id: raw.id,
    assetId: raw.assetId,
    oldPath: validatePath(raw.oldPath, 'old path'),
    newPath: validatePath(raw.newPath, 'new path'),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    attempts: raw.attempts,
    state: raw.state as AssetRepairRecoveryState,
    needsDerivedRebuild: raw.needsDerivedRebuild,
    rebuildVectorData: raw.rebuildVectorData,
    steps: validateSteps(raw.steps),
    ...(boundedError(raw.lastError) ? { lastError: boundedError(raw.lastError) } : {}),
    ...(raw.completedAt !== undefined ? { completedAt: raw.completedAt } : {}),
  }
  const primaryComplete =
    payload.steps.identity &&
    payload.steps.assetLibrary &&
    payload.steps.sourceCatalog &&
    payload.steps.nativeIndex &&
    payload.steps.vectorIndex
  if (
    (payload.steps.derivedRebuilt && !payload.steps.derivedCleared) ||
    (payload.state === 'completed' &&
      (!primaryComplete || payload.needsDerivedRebuild || payload.completedAt === undefined)) ||
    (payload.state !== 'completed' && payload.completedAt !== undefined)
  ) {
    throw new Error('Invalid asset repair recovery state transition metadata')
  }
  if (checksumFor(payload) !== raw.checksum.toLowerCase()) {
    throw new Error('Asset repair recovery checksum mismatch')
  }
  return { ...payload, checksum: raw.checksum.toLowerCase() }
}

function validateRecords(value: unknown): AssetRepairRecoveryRecord[] {
  if (!Array.isArray(value) || value.length > MAX_ASSET_REPAIR_RECOVERY_RECORDS) {
    throw new Error('Invalid asset repair recovery journal metadata')
  }
  const records = value.map(validateRecord)
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw new Error('Asset repair recovery journal contains duplicate IDs')
  }
  return records
}

function validateFile(value: unknown, key: Buffer): AssetRepairRecoveryStateData {
  if (!value || typeof value !== 'object') throw new Error('Invalid asset repair recovery journal')
  const raw = value as Partial<AssetRepairRecoveryFile>
  if (
    raw.version !== ASSET_REPAIR_RECOVERY_VERSION ||
    !isSafeInteger(raw.revision) ||
    !isSafeInteger(raw.generation, 1) ||
    typeof raw.authTag !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(raw.authTag)
  ) {
    throw new Error('Invalid asset repair recovery journal metadata')
  }
  const payload: AssetRepairRecoveryStateData = {
    version: ASSET_REPAIR_RECOVERY_VERSION,
    revision: raw.revision,
    generation: raw.generation,
    records: validateRecords(raw.records),
  }
  if (!authTagsEqual(authTagForFile(key, payload), raw.authTag.toLowerCase())) {
    throw new Error('Asset repair recovery journal authentication mismatch')
  }
  return payload
}

function validateFileV2(value: unknown): Omit<AssetRepairRecoveryFileV2, 'stateChecksum'> {
  if (!value || typeof value !== 'object') throw new Error('Invalid asset repair recovery journal')
  const raw = value as Partial<AssetRepairRecoveryFileV2>
  if (
    raw.version !== ASSET_REPAIR_RECOVERY_LEGACY_VERSION ||
    !isSafeInteger(raw.revision) ||
    typeof raw.stateChecksum !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(raw.stateChecksum)
  ) {
    throw new Error('Invalid asset repair recovery journal metadata')
  }
  const payload: Omit<AssetRepairRecoveryFileV2, 'stateChecksum'> = {
    version: ASSET_REPAIR_RECOVERY_LEGACY_VERSION,
    revision: raw.revision,
    records: validateRecords(raw.records),
  }
  if (checksumForFileV2(payload) !== raw.stateChecksum.toLowerCase()) {
    throw new Error('Asset repair recovery journal state checksum mismatch')
  }
  return payload
}

function normalizedPathKey(value: string): string {
  return path
    .resolve(value)
    .replace(/^\\\\\?\\/, '')
    .toLowerCase()
}

function validateJournalDirectorySync(directory: string): string {
  let stats: fs.Stats
  let realDirectory: string
  try {
    stats = fs.lstatSync(directory)
    realDirectory = fs.realpathSync.native(directory)
  } catch (error) {
    throw new Error('Asset repair recovery directory is unavailable', { cause: error })
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    normalizedPathKey(realDirectory) !== normalizedPathKey(directory)
  ) {
    throw new Error('Asset repair recovery directory must not be a symlink or reparse alias')
  }
  return path.resolve(realDirectory)
}

async function validateJournalDirectory(directory: string): Promise<void> {
  let stats: fs.Stats
  let realDirectory: string
  try {
    ;[stats, realDirectory] = await Promise.all([
      fs.promises.lstat(directory),
      fs.promises.realpath(directory),
    ])
  } catch (error) {
    throw new Error('Asset repair recovery directory is unavailable', { cause: error })
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    normalizedPathKey(realDirectory) !== normalizedPathKey(directory)
  ) {
    throw new Error('Asset repair recovery directory changed or became a reparse alias')
  }
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

async function readAnchor(anchorPath: string, key: Buffer): Promise<number> {
  let stats: fs.Stats
  try {
    stats = await fs.promises.lstat(anchorPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 4096) {
    throw new Error('Invalid asset repair recovery anti-rollback anchor')
  }
  const parsed: unknown = JSON.parse(await fs.promises.readFile(anchorPath, 'utf8'))
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid asset repair recovery anti-rollback anchor')
  }
  const raw = parsed as Partial<AssetRepairJournalAnchorFile>
  if (
    raw.version !== 1 ||
    !isSafeInteger(raw.generation, 1) ||
    typeof raw.authTag !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(raw.authTag)
  ) {
    throw new Error('Invalid asset repair recovery anti-rollback anchor')
  }
  if (!authTagsEqual(authTagForAnchor(key, raw.generation), raw.authTag.toLowerCase())) {
    throw new Error('Asset repair recovery anti-rollback anchor authentication mismatch')
  }
  return raw.generation
}

async function writeAnchor(anchorPath: string, key: Buffer, generation: number): Promise<void> {
  if (!isSafeInteger(generation, 1)) {
    throw new Error('Invalid asset repair recovery anti-rollback generation')
  }
  const payload: AssetRepairJournalAnchorFile = {
    version: 1,
    generation,
    authTag: authTagForAnchor(key, generation),
  }
  const directory = path.dirname(anchorPath)
  await validateJournalDirectory(directory)
  const temporary = `${anchorPath}.${process.pid}.${crypto.randomUUID()}.tmp`
  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(payload), 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await validateJournalDirectory(directory)
    await fs.promises.rename(temporary, anchorPath)
    await syncDirectory(directory)
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.promises.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

interface JournalReadResult {
  state: AssetRepairRecoveryStateData
  migratedFromLegacy: boolean
}

async function readFile(filePath: string, key: Buffer): Promise<JournalReadResult> {
  await validateJournalDirectory(path.dirname(filePath))
  const anchorPath = path.join(path.dirname(filePath), ASSET_REPAIR_RECOVERY_ANCHOR_FILENAME)
  let stats: fs.Stats
  try {
    stats = await fs.promises.lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const anchorGeneration = await readAnchor(anchorPath, key)
      return { state: { ...emptyFile(), generation: anchorGeneration }, migratedFromLegacy: false }
    }
    throw error
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_ASSET_REPAIR_RECOVERY_BYTES) {
    throw new Error('Invalid or oversized asset repair recovery journal')
  }
  const handle = await fs.promises.open(filePath, 'r')
  let serialized: string
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino) {
      throw new Error('Asset repair recovery journal changed while it was being opened')
    }
    serialized = await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ASSET_REPAIR_RECOVERY_BYTES) {
    throw new Error('Asset repair recovery journal exceeds its file limit')
  }
  const parsed: unknown = JSON.parse(serialized)
  const version =
    parsed && typeof parsed === 'object' ? (parsed as { version?: unknown }).version : undefined
  const anchorGeneration = await readAnchor(anchorPath, key)
  if (version === ASSET_REPAIR_RECOVERY_LEGACY_VERSION) {
    const legacy = validateFileV2(parsed)
    // Legacy journals carry no generation; resume above the highest generation the
    // anchor has ever seen so a swapped-in old v2 file cannot roll the journal back.
    return {
      state: {
        version: ASSET_REPAIR_RECOVERY_VERSION,
        revision: legacy.revision,
        generation: anchorGeneration,
        records: legacy.records,
      },
      migratedFromLegacy: true,
    }
  }
  const state = validateFile(parsed, key)
  if (anchorGeneration === 0) {
    throw new Error('Asset repair recovery journal anti-rollback anchor is missing')
  }
  if (state.generation < anchorGeneration) {
    throw new Error('Asset repair recovery journal was rolled back to an older generation')
  }
  return { state, migratedFromLegacy: false }
}

async function writeFile(
  filePath: string,
  state: AssetRepairRecoveryStateData,
  key: Buffer,
): Promise<void> {
  const authored: AssetRepairRecoveryFile = { ...state, authTag: authTagForFile(key, state) }
  const validated = validateFile(authored, key)
  const serialized = JSON.stringify({ ...validated, authTag: authored.authTag })
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ASSET_REPAIR_RECOVERY_BYTES) {
    throw new Error('Asset repair recovery journal exceeds its file limit')
  }
  const directory = path.dirname(filePath)
  await validateJournalDirectory(directory)
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600)
    await handle.writeFile(serialized, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await validateJournalDirectory(directory)
    try {
      const destination = await fs.promises.lstat(filePath)
      if (!destination.isFile() || destination.isSymbolicLink()) {
        throw new Error('Asset repair recovery journal destination is not a regular file')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await fs.promises.rename(temporary, filePath)
    // The anchor is only ever written after the journal it describes; a crash in
    // between leaves the anchor behind, which the read side explicitly tolerates.
    await writeAnchor(
      path.join(directory, ASSET_REPAIR_RECOVERY_ANCHOR_FILENAME),
      key,
      state.generation,
    )
    await syncDirectory(directory)
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.promises.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

const JOURNAL_KEY_FILE_MAX_BYTES = 8 * 1024
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

function parseJournalKeyFile(raw: unknown, adapter?: AssetRepairJournalProtectionAdapter): Buffer {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid asset repair journal key file')
  const parsed = raw as { version?: unknown; protected?: unknown; key?: unknown }
  if (
    parsed.version !== 1 ||
    typeof parsed.protected !== 'boolean' ||
    typeof parsed.key !== 'string' ||
    parsed.key.length > JOURNAL_KEY_FILE_MAX_BYTES ||
    !BASE64_PATTERN.test(parsed.key)
  ) {
    throw new Error('Invalid asset repair journal key file')
  }
  const material = parsed.protected
    ? (() => {
        if (!adapter || !adapter.isAvailable()) {
          throw new Error('Asset repair journal key is protected but no protection is available')
        }
        return adapter.decrypt(parsed.key as string)
      })()
    : (parsed.key as string)
  if (!BASE64_PATTERN.test(material)) throw new Error('Invalid asset repair journal key file')
  const key = Buffer.from(material, 'base64')
  if (key.length !== JOURNAL_AUTH_KEY_BYTES) {
    throw new Error('Invalid asset repair journal key file')
  }
  return key
}

function resolveJournalAuthKey(
  directory: string,
  options: AssetRepairRecoveryJournalOptions,
): Buffer {
  if (options.authKey) {
    if (options.authKey.length !== JOURNAL_AUTH_KEY_BYTES) {
      throw new Error('Asset repair journal auth key must be 32 bytes')
    }
    return options.authKey
  }
  const keyPath = path.join(directory, ASSET_REPAIR_RECOVERY_KEY_FILENAME)
  let stats: fs.Stats | null = null
  try {
    stats = fs.lstatSync(keyPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (stats) {
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > JOURNAL_KEY_FILE_MAX_BYTES) {
      throw new Error('Invalid asset repair journal key file')
    }
    return parseJournalKeyFile(
      JSON.parse(fs.readFileSync(keyPath, 'utf8')),
      options.protectionAdapter,
    )
  }
  const key = crypto.randomBytes(JOURNAL_AUTH_KEY_BYTES)
  const adapter = options.protectionAdapter
  const protect = adapter?.isAvailable() === true
  const serialized = JSON.stringify({
    version: 1,
    protected: protect,
    key: protect ? adapter.encrypt(key.toString('base64')) : key.toString('base64'),
  })
  const temporary = `${keyPath}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, keyPath)
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      // Best-effort cleanup of the temporary key file.
    }
    // A concurrent creator may have won the race; prefer the committed file.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' || fs.existsSync(keyPath)) {
      return parseJournalKeyFile(
        JSON.parse(fs.readFileSync(keyPath, 'utf8')),
        options.protectionAdapter,
      )
    }
    throw error
  }
  return key
}

function serialize<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const key = filePath.toLowerCase()
  const previous = writeChains.get(key) || Promise.resolve()
  const current = previous.catch(() => undefined).then(action)
  const tail = current.then(
    () => undefined,
    () => undefined,
  )
  writeChains.set(key, tail)
  void tail.finally(() => {
    if (writeChains.get(key) === tail) writeChains.delete(key)
  })
  return current
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

export class AssetRepairRecoveryJournal {
  readonly filePath: string
  private readonly authKey: Buffer
  private readonly now: () => number
  private readonly createId: () => string

  constructor(userDataPath: string, options: AssetRepairRecoveryJournalOptions = {}) {
    const resolved = path.resolve(userDataPath)
    if (!resolved || path.parse(resolved).root === resolved) {
      throw new Error('Refusing to place asset repair recovery journal at a filesystem root')
    }
    const realUserDataPath = validateJournalDirectorySync(resolved)
    this.filePath = path.join(realUserDataPath, ASSET_REPAIR_RECOVERY_FILENAME)
    this.authKey = resolveJournalAuthKey(realUserDataPath, options)
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? crypto.randomUUID
  }

  private async readState(): Promise<AssetRepairRecoveryStateData> {
    const result = await readFile(this.filePath, this.authKey)
    if (!result.migratedFromLegacy) return result.state
    // Fully validated legacy journals are re-committed once as an authenticated v3
    // file above the highest anchor generation; invalid legacy data still fails closed.
    const migrated = { ...result.state, generation: result.state.generation + 1 }
    await writeFile(this.filePath, migrated, this.authKey)
    return migrated
  }

  async prepare(input: {
    assetId: string
    oldPath: string
    newPath: string
    nativeIndexRequired?: boolean
  }): Promise<AssetRepairRecoveryRecord> {
    return serialize(this.filePath, async () => {
      const state = await this.readState()
      const existing = state.records.find(
        (record) =>
          record.state !== 'completed' &&
          record.assetId.toLowerCase() === input.assetId.toLowerCase() &&
          samePath(record.oldPath, input.oldPath) &&
          samePath(record.newPath, input.newPath),
      )
      if (existing) return { ...existing, steps: { ...existing.steps } }

      const completed = state.records
        .filter((record) => record.state === 'completed')
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_RETAINED_COMPLETED_RECORDS)
      const active = state.records.filter((record) => record.state !== 'completed')
      if (active.length >= MAX_ASSET_REPAIR_RECOVERY_RECORDS - MAX_RETAINED_COMPLETED_RECORDS) {
        throw new Error('Asset repair recovery journal is full; retry pending recoveries first')
      }
      const now = this.now()
      const record = withChecksum({
        id: this.createId(),
        assetId: input.assetId,
        oldPath: validatePath(input.oldPath, 'old path'),
        newPath: validatePath(input.newPath, 'new path'),
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        state: 'prepared',
        needsDerivedRebuild: false,
        rebuildVectorData: false,
        steps: {
          identity: false,
          assetLibrary: false,
          sourceCatalog: false,
          nativeIndex: input.nativeIndexRequired === false,
          vectorIndex: false,
          derivedCleared: false,
          derivedRebuilt: false,
        },
      })
      const next = {
        ...state,
        revision: state.revision + 1,
        generation: state.generation + 1,
        records: [...active, ...completed, record],
      }
      await writeFile(this.filePath, next, this.authKey)
      return { ...record, steps: { ...record.steps } }
    })
  }

  async get(id: string): Promise<AssetRepairRecoveryRecord | null> {
    const state = await serialize(this.filePath, () => this.readState())
    const record = state.records.find((candidate) => candidate.id === id)
    return record ? { ...record, steps: { ...record.steps } } : null
  }

  async listPending(): Promise<AssetRepairRecoveryRecord[]> {
    const state = await serialize(this.filePath, () => this.readState())
    return state.records
      .filter((record) => record.state !== 'completed')
      .map((record) => ({ ...record, steps: { ...record.steps } }))
  }

  async update(id: string, update: AssetRepairRecoveryUpdate): Promise<AssetRepairRecoveryRecord> {
    return serialize(this.filePath, async () => {
      const state = await this.readState()
      const index = state.records.findIndex((record) => record.id === id)
      if (index < 0) throw new Error('Asset repair recovery record not found')
      const current = state.records[index]
      const now = this.now()
      const lastError =
        update.lastError === undefined ? current.lastError : boundedError(update.lastError)
      const steps = update.steps !== undefined ? validateSteps(update.steps) : { ...current.steps }
      if (update.markStep) steps[update.markStep] = true
      const currentPayload = recordPayload(current)
      delete currentPayload.lastError
      delete currentPayload.completedAt
      const nextRecord = withChecksum({
        ...currentPayload,
        ...(update.state !== undefined ? { state: update.state } : {}),
        ...(update.needsDerivedRebuild !== undefined
          ? { needsDerivedRebuild: update.needsDerivedRebuild }
          : {}),
        ...(update.rebuildVectorData !== undefined
          ? { rebuildVectorData: update.rebuildVectorData }
          : {}),
        steps,
        updatedAt: now,
        attempts: current.attempts + (update.incrementAttempts ? 1 : 0),
        ...(lastError ? { lastError } : {}),
        ...(update.completedAt !== undefined
          ? { completedAt: update.completedAt }
          : current.completedAt !== undefined
            ? { completedAt: current.completedAt }
            : {}),
      })
      const records = [...state.records]
      records[index] = nextRecord
      await writeFile(
        this.filePath,
        {
          ...state,
          revision: state.revision + 1,
          generation: state.generation + 1,
          records,
        },
        this.authKey,
      )
      return { ...nextRecord, steps: { ...nextRecord.steps } }
    })
  }

  async markStep(
    id: string,
    step: keyof AssetRepairRecoverySteps,
  ): Promise<AssetRepairRecoveryRecord> {
    return this.update(id, { markStep: step })
  }
}

export type AssetRepairPrimaryStep = Exclude<
  keyof AssetRepairRecoverySteps,
  'derivedCleared' | 'derivedRebuilt'
>

export class AssetRepairRecoveryError extends Error {
  constructor(
    message: string,
    readonly step: AssetRepairPrimaryStep,
    readonly record: AssetRepairRecoveryRecord,
    options: ErrorOptions = {},
  ) {
    super(message, options)
    this.name = 'AssetRepairRecoveryError'
  }
}

function repairErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function executeAssetRepairRecoverySteps(options: {
  journal: AssetRepairRecoveryJournal
  recordId: string
  operations: Record<AssetRepairPrimaryStep, () => void | Promise<void>>
  now?: () => number
}): Promise<AssetRepairRecoveryRecord> {
  const initial = await options.journal.get(options.recordId)
  if (!initial) throw new Error('Asset repair recovery record not found')
  if (initial.state === 'completed') return initial
  if (initial.state === 'rebuilding') {
    throw new Error('Asset repair recovery must continue its interrupted derived rebuild')
  }
  let record = await options.journal.update(initial.id, {
    state: 'repairing',
    incrementAttempts: true,
    lastError: '',
  })
  const steps: AssetRepairPrimaryStep[] = [
    'identity',
    'assetLibrary',
    'sourceCatalog',
    'nativeIndex',
    'vectorIndex',
  ]
  for (const step of steps) {
    if (record.steps[step]) continue
    try {
      await options.operations[step]()
      record = await options.journal.markStep(record.id, step)
    } catch (error) {
      const reason = `${step}: ${repairErrorMessage(error)}`
      record = await options.journal.update(record.id, {
        state: 'awaiting-rebuild',
        needsDerivedRebuild:
          record.needsDerivedRebuild || step === 'nativeIndex' || step === 'vectorIndex',
        lastError: reason,
      })
      throw new AssetRepairRecoveryError(reason, step, record, { cause: error })
    }
  }
  return options.journal.update(record.id, {
    state: 'completed',
    needsDerivedRebuild: false,
    completedAt: (options.now ?? Date.now)(),
    lastError: '',
  })
}
