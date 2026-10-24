import fs from 'node:fs'
import path from 'node:path'

const RETENTION = 7 * 24 * 60 * 60 * 1000

/** Only GC-created, paired, expired recovery files are eligible. Never accepts a path from metadata. */
export async function expireAutomaticMaintenanceBackups(
  userDataPath: string,
  cancelled: () => boolean,
  now = Date.now(),
): Promise<number> {
  const directory = path.resolve(userDataPath, 'vector-db', 'embeddings')
  if (!fs.existsSync(directory)) return 0
  if ((await fs.promises.realpath(directory)).toLowerCase() !== directory.toLowerCase()) return 0
  const identity = await fs.promises.lstat(directory)
  let freed = 0
  for (const name of await fs.promises.readdir(directory)) {
    if (cancelled()) break
    const match = /^([A-Za-z0-9_.-]+__global\.jsonl)\.gc-backup-(\d+)\.json$/.exec(name)
    if (!match) continue
    const metadataPath = path.join(directory, name)
    const backupName = name.slice(0, -5)
    const backupPath = path.join(directory, backupName)
    try {
      const metadataStat = await fs.promises.lstat(metadataPath)
      if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > 65536)
        continue
      const text = await fs.promises.readFile(metadataPath, 'utf8')
      const metadata = JSON.parse(text)
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
        expires < created + RETENTION ||
        expires > now ||
        Math.max(stamp, metadataStat.mtimeMs) + RETENTION > now
      )
        continue
      const backupStat = await fs.promises.lstat(backupPath)
      if (!backupStat.isFile() || backupStat.isSymbolicLink()) continue
      const currentDirectory = await fs.promises.lstat(directory)
      if (
        currentDirectory.isSymbolicLink() ||
        currentDirectory.ino !== identity.ino ||
        currentDirectory.dev !== identity.dev
      )
        throw new Error('Recovery directory changed during maintenance')
      if (cancelled()) break
      if ((await fs.promises.readFile(metadataPath, 'utf8')) !== text) continue
      const currentBackup = await fs.promises.lstat(backupPath)
      if (
        !currentBackup.isFile() ||
        currentBackup.isSymbolicLink() ||
        currentBackup.ino !== backupStat.ino ||
        currentBackup.size !== backupStat.size ||
        currentBackup.mtimeMs !== backupStat.mtimeMs
      )
        continue
      await fs.promises.unlink(backupPath)
      await fs.promises.unlink(metadataPath)
      freed += backupStat.size + metadataStat.size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      // Invalid or incomplete metadata stays protected. Permission errors may be retried later.
      continue
    }
  }
  return freed
}
