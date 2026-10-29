import fs from 'node:fs'
import path from 'node:path'

const RETENTION = 7 * 24 * 60 * 60 * 1000

type RetainedReason =
  | 'unsafe-directory'
  | 'unsafe-file'
  | 'invalid-metadata'
  | 'unexpired'
  | 'changed'
  | 'missing-file'
  | 'io-error'
  | 'cancelled'

export interface BackupCleanupReport {
  deletedBackups: number
  freedBytes: number
  retained: Partial<Record<RetainedReason, number>>
  ioErrors: Record<string, number>
}

const diagnosticCodes = new Set(['EACCES', 'EPERM', 'EBUSY', 'EIO', 'ENOSPC', 'EROFS'])

/** Only GC-created, paired, expired recovery files are eligible. Never accepts a path from metadata. */
export async function expireAutomaticMaintenanceBackups(
  userDataPath: string,
  cancelled: () => boolean,
  now = Date.now(),
  onReport: (report: BackupCleanupReport) => void = (report) =>
    console.info('[automatic-maintenance] backup cleanup', JSON.stringify(report)),
): Promise<number> {
  const report: BackupCleanupReport = {
    deletedBackups: 0,
    freedBytes: 0,
    retained: {},
    ioErrors: {},
  }
  const retain = (reason: RetainedReason) => {
    report.retained[reason] = (report.retained[reason] ?? 0) + 1
  }
  const recordError = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') retain('missing-file')
    else {
      retain('io-error')
      // Log bounded codes/counts only; messages and paths can contain user data.
      const safeCode = diagnosticCodes.has(code ?? '') ? code! : 'OTHER'
      report.ioErrors[safeCode] = (report.ioErrors[safeCode] ?? 0) + 1
    }
  }
  const finish = () => {
    if (report.deletedBackups || Object.keys(report.retained).length) onReport(report)
    return report.freedBytes
  }
  let directory: string
  let identity: fs.Stats
  let names: string[]
  try {
    // Canonicalize the trusted profile root, allowing OS temp/drive aliases.
    // Links introduced *inside* that root remain ineligible for deletion.
    const root = await fs.promises.realpath(userDataPath)
    const parent = path.join(root, 'vector-db')
    directory = path.join(parent, 'embeddings')
    const parentStat = await fs.promises.lstat(parent)
    identity = await fs.promises.lstat(directory)
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      !identity.isDirectory() ||
      identity.isSymbolicLink() ||
      path.relative(directory, await fs.promises.realpath(directory)) !== ''
    ) {
      retain('unsafe-directory')
      return finish()
    }
    names = await fs.promises.readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') recordError(error)
    return finish()
  }
  for (const name of names) {
    if (cancelled()) {
      retain('cancelled')
      break
    }
    const match = /^([A-Za-z0-9_.-]+__global\.jsonl)\.gc-backup-(\d+)\.json$/.exec(name)
    if (!match) continue
    const metadataPath = path.join(directory, name)
    const backupName = name.slice(0, -5)
    const backupPath = path.join(directory, backupName)
    try {
      const metadataStat = await fs.promises.lstat(metadataPath)
      if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > 65536) {
        retain('unsafe-file')
        continue
      }
      const text = await fs.promises.readFile(metadataPath, 'utf8')
      const metadata = JSON.parse(text)
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        retain('invalid-metadata')
        continue
      }
      const created = Date.parse(metadata.createdAt),
        expires = Date.parse(metadata.expiresAt),
        stamp = Number(match[2])
      if (
        metadata.version !== 1 ||
        metadata.backup !== backupName ||
        metadata.source !== match[1] ||
        !Number.isFinite(created) ||
        !Number.isFinite(expires) ||
        !Number.isSafeInteger(stamp) ||
        created < stamp ||
        expires < created + RETENTION
      ) {
        retain('invalid-metadata')
        continue
      }
      if (expires > now || Math.max(stamp, metadataStat.mtimeMs) + RETENTION > now) {
        retain('unexpired')
        continue
      }
      const backupStat = await fs.promises.lstat(backupPath)
      if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
        retain('unsafe-file')
        continue
      }
      const currentDirectory = await fs.promises.lstat(directory)
      if (
        currentDirectory.isSymbolicLink() ||
        currentDirectory.ino !== identity.ino ||
        currentDirectory.dev !== identity.dev
      ) {
        retain('changed')
        break
      }
      if (cancelled()) {
        retain('cancelled')
        break
      }
      if ((await fs.promises.readFile(metadataPath, 'utf8')) !== text) {
        retain('changed')
        continue
      }
      const currentBackup = await fs.promises.lstat(backupPath)
      if (
        !currentBackup.isFile() ||
        currentBackup.isSymbolicLink() ||
        currentBackup.ino !== backupStat.ino ||
        currentBackup.size !== backupStat.size ||
        currentBackup.mtimeMs !== backupStat.mtimeMs
      ) {
        retain('changed')
        continue
      }
      await fs.promises.unlink(backupPath)
      report.deletedBackups++
      report.freedBytes += backupStat.size
      await fs.promises.unlink(metadataPath)
      report.freedBytes += metadataStat.size
    } catch (error) {
      if (error instanceof SyntaxError) retain('invalid-metadata')
      else recordError(error)
    }
  }
  return finish()
}
