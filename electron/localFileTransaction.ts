import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import fsp from 'fs/promises'

const JOURNAL_SUFFIX = '.transaction.json'
const MAX_JOURNAL_BYTES = 16 * 1024

interface PreparedPathJournal {
  version: 1
  final: string
  prepared: string
  backup: string
  hadTarget: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.access(targetPath)
    return true
  } catch {
    return false
  }
}

function syncDirectory(directory: string): void {
  try {
    const handle = fs.openSync(directory, 'r')
    try {
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    // Directory fsync is unavailable on some Windows filesystems.
  }
}

async function durableWrite(filePath: string, contents: string): Promise<void> {
  const handle = await fsp.open(filePath, 'wx')
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  syncDirectory(path.dirname(filePath))
}

function localName(value: unknown): string {
  if (typeof value !== 'string' || !value || path.basename(value) !== value) {
    throw new Error('Invalid prepared-path transaction filename')
  }
  return value
}

function validateJournal(directory: string, journalPath: string): PreparedPathJournal {
  const stat = fs.statSync(journalPath)
  if (!stat.isFile() || stat.size > MAX_JOURNAL_BYTES) {
    throw new Error('Invalid prepared-path transaction journal')
  }
  const parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Partial<PreparedPathJournal>
  const final = localName(parsed.final)
  const prepared = localName(parsed.prepared)
  const backup = localName(parsed.backup)
  if (
    parsed.version !== 1 ||
    typeof parsed.hadTarget !== 'boolean' ||
    !prepared.startsWith(`.${final}.floatingclock-`) ||
    !prepared.endsWith('.part') ||
    !backup.startsWith(`.${final}.floatingclock-`) ||
    !backup.endsWith('.bak') ||
    path.dirname(path.resolve(directory, final)) !== path.resolve(directory)
  ) {
    throw new Error('Invalid prepared-path transaction journal')
  }
  return { version: 1, final, prepared, backup, hadTarget: parsed.hadTarget }
}

function recoverJournal(directory: string, journalPath: string): void {
  const journal = validateJournal(directory, journalPath)
  const finalPath = path.join(directory, journal.final)
  const preparedPath = path.join(directory, journal.prepared)
  const backupPath = path.join(directory, journal.backup)
  const finalExists = fs.existsSync(finalPath)
  const preparedExists = fs.existsSync(preparedPath)
  const backupExists = fs.existsSync(backupPath)

  if (preparedExists) {
    if (finalExists) {
      if (backupExists) throw new Error('Prepared-path transaction has ambiguous target state')
      fs.renameSync(finalPath, backupPath)
    }
    fs.renameSync(preparedPath, finalPath)
    syncDirectory(directory)
  } else if (!finalExists) {
    if (!journal.hadTarget && !backupExists) {
      fs.unlinkSync(journalPath)
      syncDirectory(directory)
      return
    }
    if (!backupExists) {
      throw new Error('Prepared-path transaction cannot recover its target')
    }
    fs.renameSync(backupPath, finalPath)
    syncDirectory(directory)
  }

  if (!fs.existsSync(finalPath)) throw new Error('Prepared-path transaction target is missing')
  if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { recursive: true, force: true })
  fs.unlinkSync(journalPath)
  syncDirectory(directory)
}

/** Recovers every pending prepared-path replacement directly in one directory. */
export function recoverPreparedPathTransactions(directory: string): number {
  const resolved = path.resolve(directory)
  if (!fs.existsSync(resolved)) return 0
  const journals = fs
    .readdirSync(resolved)
    .filter(
      (name) =>
        name.startsWith('.') && name.includes('.floatingclock-') && name.endsWith(JOURNAL_SUFFIX),
    )
    .sort()
  for (const name of journals) recoverJournal(resolved, path.join(resolved, name))
  return journals.length
}

export function createPreparedSiblingPath(finalPath: string): string {
  const directory = path.dirname(path.resolve(finalPath))
  recoverPreparedPathTransactions(directory)
  const token = crypto.randomUUID()
  return path.join(directory, `.${path.basename(finalPath)}.floatingclock-${token}.part`)
}

function transactionPaths(finalPath: string): { backupPath: string; journalPath: string } {
  const token = crypto.randomUUID()
  const directory = path.dirname(finalPath)
  const prefix = `.${path.basename(finalPath)}.floatingclock-${token}`
  return {
    backupPath: path.join(directory, `${prefix}.bak`),
    journalPath: path.join(directory, `${prefix}${JOURNAL_SUFFIX}`),
  }
}

export async function discardPreparedPath(preparedPath: string): Promise<void> {
  await fsp.rm(preparedPath, { recursive: true, force: true }).catch(() => {})
}

/**
 * Commits a fully prepared file or directory to its final path. The durable
 * sibling journal makes the final->backup window recoverable after a crash.
 */
export async function commitPreparedPath(
  preparedPath: string,
  finalPath: string,
): Promise<{ backupCleanupError?: string }> {
  const resolvedFinal = path.resolve(finalPath)
  const resolvedPrepared = path.resolve(preparedPath)
  const directory = path.dirname(resolvedFinal)
  if (path.dirname(resolvedPrepared) !== directory) {
    throw new Error('Prepared path must be a sibling of the final path')
  }
  recoverPreparedPathTransactions(directory)
  const { backupPath, journalPath } = transactionPaths(resolvedFinal)
  const hadTarget = await pathExists(resolvedFinal)
  const journal: PreparedPathJournal = {
    version: 1,
    final: path.basename(resolvedFinal),
    prepared: path.basename(resolvedPrepared),
    backup: path.basename(backupPath),
    hadTarget,
  }
  await durableWrite(journalPath, JSON.stringify(journal))

  try {
    if (hadTarget) await fsp.rename(resolvedFinal, backupPath)
    await fsp.rename(resolvedPrepared, resolvedFinal)
    syncDirectory(directory)
  } catch (commitError) {
    try {
      if (hadTarget && !(await pathExists(resolvedFinal)) && (await pathExists(backupPath))) {
        await fsp.rename(backupPath, resolvedFinal)
      }
      await fsp.rm(journalPath, { force: true })
      syncDirectory(directory)
    } catch (rollbackError) {
      throw new Error(
        `File replace failed and rollback failed: ${errorMessage(commitError)}; ${errorMessage(rollbackError)}`,
        { cause: rollbackError },
      )
    }
    throw commitError
  }

  let backupCleanupError: string | undefined
  if (hadTarget) {
    try {
      await fsp.rm(backupPath, { recursive: true, force: true })
    } catch (cleanupError) {
      backupCleanupError = errorMessage(cleanupError)
    }
  }
  await fsp.rm(journalPath, { force: true })
  syncDirectory(directory)
  return backupCleanupError ? { backupCleanupError } : {}
}
