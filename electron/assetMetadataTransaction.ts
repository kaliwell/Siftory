import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const JOURNAL_FILENAME = '.asset-metadata-transaction.json'
const JOURNAL_TMP_FILENAME = `${JOURNAL_FILENAME}.tmp`
const STAGE_PREFIX = '.asset-metadata-stage-'
const REQUIRED_TARGET_FILENAMES = ['assets.jsonl', 'state.json'] as const
const TARGET_FILENAMES = [...REQUIRED_TARGET_FILENAMES, 'archived-assets.json'] as const
const MAX_JOURNAL_BYTES = 64 * 1024

type AssetMetadataTarget = (typeof TARGET_FILENAMES)[number]

interface AssetMetadataTransactionEntry {
  target: AssetMetadataTarget
  staged: string
  bytes: number
  sha256: string
}

interface AssetMetadataTransactionJournal {
  version: 1
  id: string
  entries: AssetMetadataTransactionEntry[]
}

interface ValidatedEntry extends AssetMetadataTransactionEntry {
  targetPath: string
  stagedPath: string
}

export interface AssetMetadataStagePaths {
  assetsPath: string
  statePath: string
  archivePath: string
}

export interface AssetMetadataPreparedFiles {
  assets: { bytes: number; sha256: string }
  state: { bytes: number; sha256: string }
  archive?: { bytes: number; sha256: string }
}

export interface AssetMetadataTransactionOptions {
  includeArchive?: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function localFilename(value: unknown, prefix?: string): string {
  if (typeof value !== 'string' || !value || path.basename(value) !== value) {
    throw new Error('Invalid asset metadata transaction filename')
  }
  if (prefix && !value.startsWith(prefix)) {
    throw new Error('Invalid asset metadata transaction stage')
  }
  return value
}

function journalPath(baseDir: string): string {
  return path.join(baseDir, JOURNAL_FILENAME)
}

function assertRegularFile(filePath: string): fs.Stats {
  const stats = fs.lstatSync(filePath)
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Asset metadata transaction path is not a regular file: ${filePath}`)
  }
  return stats
}

function fingerprintFileSync(filePath: string): { bytes: number; sha256: string } {
  const stats = assertRegularFile(filePath)
  const hash = crypto.createHash('sha256')
  const handle = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let offset = 0
    while (offset < stats.size) {
      const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, offset)
      if (bytesRead <= 0) break
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
    if (offset !== stats.size) {
      throw new Error(`Could not fully read asset metadata transaction file: ${filePath}`)
    }
  } finally {
    fs.closeSync(handle)
  }
  return { bytes: stats.size, sha256: hash.digest('hex') }
}

async function fingerprintFile(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const stats = await fs.promises.lstat(filePath)
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Asset metadata transaction path is not a regular file: ${filePath}`)
  }
  const hash = crypto.createHash('sha256')
  let bytes = 0
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    hash.update(buffer)
    bytes += buffer.length
  }
  if (bytes !== stats.size) {
    throw new Error(`Could not fully read asset metadata transaction file: ${filePath}`)
  }
  return { bytes, sha256: hash.digest('hex') }
}

function validateFingerprint(
  actual: { bytes: number; sha256: string },
  expected: Pick<AssetMetadataTransactionEntry, 'bytes' | 'sha256'>,
  filePath: string,
): void {
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new Error(`Asset metadata transaction file failed integrity verification: ${filePath}`)
  }
}

function fileExistsSync(filePath: string): boolean {
  try {
    fs.lstatSync(filePath)
    return true
  } catch (error) {
    if (isMissingError(error)) return false
    throw error
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filePath)
    return true
  } catch (error) {
    if (isMissingError(error)) return false
    throw error
  }
}

function cleanupOrphansSync(baseDir: string): void {
  if (!fs.existsSync(baseDir)) return
  const removable = new Set([
    JOURNAL_TMP_FILENAME,
    'assets.jsonl.tmp',
    'state.json.tmp',
    'archived-assets.json.tmp',
  ])
  for (const filename of fs.readdirSync(baseDir)) {
    if (!filename.startsWith(STAGE_PREFIX) && !removable.has(filename)) continue
    try {
      fs.unlinkSync(path.join(baseDir, filename))
    } catch {
      // A later startup can retry cleanup.
    }
  }
}

async function cleanupFiles(filePaths: string[]): Promise<void> {
  await Promise.all(filePaths.map((filePath) => fs.promises.unlink(filePath).catch(() => {})))
}

function validateJournal(baseDir: string, raw: unknown): ValidatedEntry[] {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid asset metadata transaction journal')
  const parsed = raw as Partial<AssetMetadataTransactionJournal>
  if (
    parsed.version !== 1 ||
    typeof parsed.id !== 'string' ||
    !/^[a-z\d-]{8,128}$/i.test(parsed.id) ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length < REQUIRED_TARGET_FILENAMES.length ||
    parsed.entries.length > TARGET_FILENAMES.length
  ) {
    throw new Error('Invalid asset metadata transaction journal')
  }
  const targets = new Set<string>()
  const entries = parsed.entries.map((rawEntry): ValidatedEntry => {
    if (!rawEntry || typeof rawEntry !== 'object') {
      throw new Error('Invalid asset metadata transaction entry')
    }
    const target = localFilename(rawEntry.target) as AssetMetadataTarget
    if (!TARGET_FILENAMES.includes(target)) {
      throw new Error('Invalid asset metadata transaction target')
    }
    if (targets.has(target)) throw new Error('Duplicate asset metadata transaction target')
    targets.add(target)
    const staged = localFilename(rawEntry.staged, STAGE_PREFIX)
    if (
      !Number.isSafeInteger(rawEntry.bytes) ||
      rawEntry.bytes < 0 ||
      typeof rawEntry.sha256 !== 'string' ||
      !/^[a-f\d]{64}$/i.test(rawEntry.sha256)
    ) {
      throw new Error('Invalid asset metadata transaction integrity metadata')
    }
    return {
      target,
      staged,
      bytes: rawEntry.bytes,
      sha256: rawEntry.sha256,
      targetPath: path.join(baseDir, target),
      stagedPath: path.join(baseDir, staged),
    }
  })
  if (REQUIRED_TARGET_FILENAMES.some((target) => !targets.has(target))) {
    throw new Error('Asset metadata transaction is missing a required target')
  }
  return entries
}

function readJournalSync(baseDir: string): ValidatedEntry[] | null {
  const pendingJournalPath = journalPath(baseDir)
  let stats: fs.Stats
  try {
    stats = assertRegularFile(pendingJournalPath)
  } catch (error) {
    if (isMissingError(error)) return null
    throw error
  }
  if (stats.size > MAX_JOURNAL_BYTES) {
    throw new Error('Asset metadata transaction journal exceeds its size limit')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(pendingJournalPath, 'utf8'))
  } catch (error) {
    throw new Error(`Could not read asset metadata transaction journal: ${errorMessage(error)}`, {
      cause: error,
    })
  }
  return validateJournal(baseDir, parsed)
}

async function syncDirectory(baseDir: string): Promise<void> {
  try {
    const handle = await fs.promises.open(baseDir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is unavailable on some Windows filesystems.
  }
}

async function durableWrite(filePath: string, contents: string): Promise<void> {
  const handle = await fs.promises.open(filePath, 'wx')
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function completeTransaction(baseDir: string, entries: ValidatedEntry[]): Promise<void> {
  for (const entry of entries) {
    const recoverablePath = (await fileExists(entry.stagedPath))
      ? entry.stagedPath
      : entry.targetPath
    if (!(await fileExists(recoverablePath))) {
      throw new Error(`Asset metadata transaction cannot recover ${entry.target}`)
    }
    validateFingerprint(await fingerprintFile(recoverablePath), entry, recoverablePath)
  }
  for (const entry of entries) {
    if (await fileExists(entry.stagedPath)) {
      await fs.promises.rename(entry.stagedPath, entry.targetPath)
    }
  }
  await syncDirectory(baseDir)
  for (const entry of entries) {
    if (!(await fileExists(entry.targetPath))) {
      throw new Error(`Asset metadata transaction did not replace ${entry.target}`)
    }
    validateFingerprint(await fingerprintFile(entry.targetPath), entry, entry.targetPath)
  }
  await fs.promises.unlink(journalPath(baseDir))
  await syncDirectory(baseDir)
}

export function recoverAssetMetadataTransaction(baseDir: string): boolean {
  const entries = readJournalSync(baseDir)
  if (!entries) {
    cleanupOrphansSync(baseDir)
    return false
  }
  for (const entry of entries) {
    const recoverablePath = fileExistsSync(entry.stagedPath) ? entry.stagedPath : entry.targetPath
    if (!fileExistsSync(recoverablePath)) {
      throw new Error(`Asset metadata transaction cannot recover ${entry.target}`)
    }
    validateFingerprint(fingerprintFileSync(recoverablePath), entry, recoverablePath)
  }
  for (const entry of entries) {
    if (fileExistsSync(entry.stagedPath)) fs.renameSync(entry.stagedPath, entry.targetPath)
  }
  for (const entry of entries) {
    if (!fileExistsSync(entry.targetPath)) {
      throw new Error(`Asset metadata transaction did not replace ${entry.target}`)
    }
    validateFingerprint(fingerprintFileSync(entry.targetPath), entry, entry.targetPath)
  }
  fs.unlinkSync(journalPath(baseDir))
  cleanupOrphansSync(baseDir)
  return true
}

export async function runAssetMetadataTransaction(
  baseDir: string,
  prepare: (stagePaths: AssetMetadataStagePaths) => Promise<AssetMetadataPreparedFiles | undefined>,
  options: AssetMetadataTransactionOptions = {},
): Promise<void> {
  await fs.promises.mkdir(baseDir, { recursive: true })
  recoverAssetMetadataTransaction(baseDir)
  const transactionId = `${Date.now()}-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  const assetsStage = `${STAGE_PREFIX}${transactionId}-assets`
  const stateStage = `${STAGE_PREFIX}${transactionId}-state`
  const archiveStage = `${STAGE_PREFIX}${transactionId}-archive`
  const stagePaths = {
    assetsPath: path.join(baseDir, assetsStage),
    statePath: path.join(baseDir, stateStage),
    archivePath: path.join(baseDir, archiveStage),
  }
  const temporaryJournalPath = path.join(baseDir, JOURNAL_TMP_FILENAME)
  let journalPublished = false

  try {
    const prepared = await prepare(stagePaths)
    const [assetsFingerprint, stateFingerprint] = prepared
      ? [prepared.assets, prepared.state]
      : await Promise.all([
          fingerprintFile(stagePaths.assetsPath),
          fingerprintFile(stagePaths.statePath),
        ])
    const archiveFingerprint = options.includeArchive
      ? (prepared?.archive ?? (await fingerprintFile(stagePaths.archivePath)))
      : undefined
    for (const fingerprint of [assetsFingerprint, stateFingerprint, archiveFingerprint]) {
      if (!fingerprint) continue
      if (
        !Number.isSafeInteger(fingerprint.bytes) ||
        fingerprint.bytes < 0 ||
        !/^[a-f\d]{64}$/i.test(fingerprint.sha256)
      ) {
        throw new Error('Invalid prepared asset metadata fingerprint')
      }
    }
    const journalEntries: AssetMetadataTransactionEntry[] = [
      { target: 'assets.jsonl', staged: assetsStage, ...assetsFingerprint },
      { target: 'state.json', staged: stateStage, ...stateFingerprint },
    ]
    if (archiveFingerprint) {
      journalEntries.push({
        target: 'archived-assets.json',
        staged: archiveStage,
        ...archiveFingerprint,
      })
    }
    const journal: AssetMetadataTransactionJournal = {
      version: 1,
      id: transactionId,
      entries: journalEntries,
    }
    await durableWrite(temporaryJournalPath, JSON.stringify(journal))
    await fs.promises.rename(temporaryJournalPath, journalPath(baseDir))
    await syncDirectory(baseDir)
    journalPublished = true
    const validatedEntries = validateJournal(baseDir, journal)
    await completeTransaction(baseDir, validatedEntries)
  } catch (error) {
    if (journalPublished) {
      try {
        const entries = readJournalSync(baseDir)
        if (!entries) {
          throw new Error('Asset metadata transaction journal disappeared', { cause: error })
        }
        await completeTransaction(baseDir, entries)
        return
      } catch (recoveryError) {
        throw new Error(
          `Asset metadata transaction recovery failed; restart is required: ${errorMessage(recoveryError)}`,
          { cause: recoveryError },
        )
      }
    }
    await cleanupFiles([
      stagePaths.assetsPath,
      stagePaths.statePath,
      stagePaths.archivePath,
      temporaryJournalPath,
    ])
    throw error
  }
}

export const assetMetadataTransactionFiles = {
  journal: JOURNAL_FILENAME,
  stagePrefix: STAGE_PREFIX,
} as const
