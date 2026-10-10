import fs from 'fs'
import path from 'path'

interface PersistedStatsEnvelope {
  signature?: unknown
  stats?: unknown
  updatedAt?: unknown
}

export function readPersistedStats<T>(
  filePath: string,
  signature: string,
  isValidStats?: (value: unknown) => value is T,
): T | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const value = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PersistedStatsEnvelope
    if (value.signature !== signature) return null
    if (isValidStats && !isValidStats(value.stats)) return null
    if (!value.stats || typeof value.stats !== 'object') return null
    return value.stats as T
  } catch {
    return null
  }
}

export function writePersistedStats<T>(filePath: string, signature: string, stats: T): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ signature, stats, updatedAt: Date.now() }), 'utf-8')
    fs.renameSync(tmp, filePath)
  } catch {
    /* stats cache writes are best-effort */
  }
}
