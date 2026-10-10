import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type {
  DeferredJsonLinesStore,
  JsonLinesStoreDeferredSnapshot,
} from './vectorDatabaseService'

const JOURNAL_FILENAME = '.jsonl-transaction.json'
const JOURNAL_TMP_FILENAME = `${JOURNAL_FILENAME}.tmp`
const STAGE_PREFIX = '.jsonl-stage-'
const MAX_JOURNAL_BYTES = 1024 * 1024
const MAX_TRANSACTION_FILES = 64

interface TransactionEntry {
  target: string
  staged: string
  bytes?: number
  sha256?: string
}

interface TransactionJournal {
  version: 1 | 2
  id: string
  entries: TransactionEntry[]
}

interface ValidatedTransactionEntry {
  target: string
  staged: string
  targetPath: string
  stagedPath: string
  bytes?: number
  sha256?: string
}

function durableWrite(filePath: string, contents: string): void {
  const handle = fs.openSync(filePath, 'w')
  try {
    fs.writeFileSync(handle, contents, 'utf8')
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
}

function syncDirectory(baseDir: string): void {
  try {
    const handle = fs.openSync(baseDir, 'r')
    try {
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    // Directory fsync is unavailable on some Windows filesystems.
  }
}

function localFilename(value: unknown, prefix?: string): string {
  if (typeof value !== 'string' || !value || path.basename(value) !== value) {
    throw new Error('Invalid JSONL transaction filename')
  }
  if (prefix && !value.startsWith(prefix)) throw new Error('Invalid JSONL transaction stage')
  return value
}

function journalPath(baseDir: string): string {
  return path.join(baseDir, JOURNAL_FILENAME)
}

function fileFingerprint(filePath: string): { bytes: number; sha256: string } {
  const stats = fs.statSync(filePath)
  if (!stats.isFile()) throw new Error(`JSONL transaction path is not a file: ${filePath}`)
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
    if (offset !== stats.size) throw new Error(`Could not fully read transaction file: ${filePath}`)
  } finally {
    fs.closeSync(handle)
  }
  return { bytes: stats.size, sha256: hash.digest('hex') }
}

function verifyExpectedFile(
  filePath: string,
  expected: Pick<ValidatedTransactionEntry, 'bytes' | 'sha256'>,
): void {
  if (expected.bytes === undefined || !expected.sha256) return
  const actual = fileFingerprint(filePath)
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new Error(`JSONL transaction file failed integrity verification: ${filePath}`)
  }
}

function cleanupStages(baseDir: string): void {
  if (!fs.existsSync(baseDir)) return
  for (const filename of fs.readdirSync(baseDir)) {
    if (!filename.startsWith(STAGE_PREFIX)) continue
    try {
      fs.unlinkSync(path.join(baseDir, filename))
    } catch {
      // A later startup can retry orphan cleanup.
    }
  }
}

export function recoverJsonLinesTransaction(baseDir: string): boolean {
  const pendingJournalPath = journalPath(baseDir)
  if (!fs.existsSync(pendingJournalPath)) {
    cleanupStages(baseDir)
    return false
  }

  if (fs.statSync(pendingJournalPath).size > MAX_JOURNAL_BYTES) {
    throw new Error('JSONL transaction journal exceeds its size limit')
  }
  const parsed = JSON.parse(
    fs.readFileSync(pendingJournalPath, 'utf8'),
  ) as Partial<TransactionJournal>
  if (
    (parsed.version !== 1 && parsed.version !== 2) ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length === 0 ||
    parsed.entries.length > MAX_TRANSACTION_FILES
  ) {
    throw new Error('Invalid JSONL transaction journal')
  }
  const entries: ValidatedTransactionEntry[] = parsed.entries.map((rawEntry) => {
    const target = localFilename(rawEntry?.target)
    const staged = localFilename(rawEntry?.staged, STAGE_PREFIX)
    const bytes = rawEntry?.bytes
    const sha256 = rawEntry?.sha256
    if (
      parsed.version === 2 &&
      (!Number.isSafeInteger(bytes) ||
        (bytes as number) < 0 ||
        !/^[a-f\d]{64}$/i.test(sha256 || ''))
    ) {
      throw new Error('Invalid JSONL transaction integrity metadata')
    }
    return {
      target,
      staged,
      targetPath: path.join(baseDir, target),
      stagedPath: path.join(baseDir, staged),
      ...(parsed.version === 2 ? { bytes: bytes as number, sha256 } : {}),
    }
  })

  for (const entry of entries) {
    const recoverablePath = fs.existsSync(entry.stagedPath) ? entry.stagedPath : entry.targetPath
    if (!fs.existsSync(recoverablePath)) {
      throw new Error(`JSONL transaction is missing both staged and target files: ${entry.target}`)
    }
    verifyExpectedFile(recoverablePath, entry)
  }
  for (const entry of entries) {
    if (fs.existsSync(entry.stagedPath)) fs.renameSync(entry.stagedPath, entry.targetPath)
  }
  syncDirectory(baseDir)
  for (const entry of entries) {
    if (!fs.existsSync(entry.targetPath)) {
      throw new Error(`JSONL transaction target was not replaced: ${entry.target}`)
    }
    verifyExpectedFile(entry.targetPath, entry)
  }
  fs.unlinkSync(pendingJournalPath)
  syncDirectory(baseDir)
  cleanupStages(baseDir)
  return true
}

export async function runJsonLinesTransaction<T>(
  baseDir: string,
  stores: DeferredJsonLinesStore[],
  action: () => T | Promise<T>,
): Promise<T> {
  const uniqueStores = [...new Set(stores)]
  if (uniqueStores.length === 0) return action()
  if (uniqueStores.length > MAX_TRANSACTION_FILES) {
    throw new Error('JSONL transaction contains too many stores')
  }
  fs.mkdirSync(baseDir, { recursive: true })
  try {
    recoverJsonLinesTransaction(baseDir)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    for (const store of uniqueStores) {
      store.markUnavailable(`Pending transaction recovery failed; restart is required: ${message}`)
    }
    throw new Error(`JSONL transaction cannot start because recovery failed: ${message}`, {
      cause: error,
    })
  }

  const snapshots = new Map<DeferredJsonLinesStore, JsonLinesStoreDeferredSnapshot>()
  try {
    for (const store of uniqueStores) snapshots.set(store, await store.beginDeferredWrites())
  } catch (error) {
    for (const [store, snapshot] of snapshots) store.rollbackDeferredWrites(snapshot)
    throw error
  }

  const transactionId = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`
  const entries: TransactionEntry[] = []
  let result: T | undefined
  let journalPublished = false

  try {
    result = await action()
    for (let index = 0; index < uniqueStores.length; index++) {
      const store = uniqueStores[index]
      const targetPath = store.getPersistenceFilePath()
      if (
        path.resolve(path.dirname(targetPath)).toLowerCase() !== path.resolve(baseDir).toLowerCase()
      ) {
        throw new Error('JSONL transaction target escaped its data directory')
      }
      const target = localFilename(path.basename(targetPath))
      const staged = `${STAGE_PREFIX}${transactionId}-${index}`
      const contents = store.getDeferredSnapshotText()
      durableWrite(path.join(baseDir, staged), contents)
      entries.push({
        target,
        staged,
        bytes: Buffer.byteLength(contents, 'utf8'),
        sha256: crypto.createHash('sha256').update(contents, 'utf8').digest('hex'),
      })
    }

    const journal: TransactionJournal = { version: 2, id: transactionId, entries }
    const temporaryJournalPath = path.join(baseDir, JOURNAL_TMP_FILENAME)
    durableWrite(temporaryJournalPath, JSON.stringify(journal))
    fs.renameSync(temporaryJournalPath, journalPath(baseDir))
    syncDirectory(baseDir)
    journalPublished = true
    recoverJsonLinesTransaction(baseDir)
    for (const store of uniqueStores) store.commitDeferredWrites()
    return result
  } catch (error) {
    if (journalPublished) {
      try {
        recoverJsonLinesTransaction(baseDir)
        for (const store of uniqueStores) store.commitDeferredWrites()
        return result as T
      } catch (recoveryError) {
        const message =
          recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        for (const store of uniqueStores) {
          const snapshot = snapshots.get(store)
          try {
            if (snapshot) store.rollbackDeferredWrites(snapshot)
          } catch {
            // The store is locked below even if its in-memory rollback could not complete.
          }
          store.markUnavailable(`Transaction recovery failed; restart is required: ${message}`)
        }
        throw new Error(`JSONL transaction recovery failed; asset data is locked: ${message}`, {
          cause: recoveryError,
        })
      }
    }

    for (const store of uniqueStores) {
      const snapshot = snapshots.get(store)
      if (snapshot) store.rollbackDeferredWrites(snapshot)
    }
    cleanupStages(baseDir)
    try {
      fs.unlinkSync(path.join(baseDir, JOURNAL_TMP_FILENAME))
    } catch {
      // The temporary journal may not have been created yet.
    }
    throw error
  }
}

export const jsonLinesTransactionFiles = {
  journal: JOURNAL_FILENAME,
  stagePrefix: STAGE_PREFIX,
} as const
