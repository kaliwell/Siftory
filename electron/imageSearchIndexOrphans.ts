import fs from 'node:fs'
import path from 'node:path'

/**
 * Manifest-aware Image Search orphan segment/staging cleanup.
 *
 * The authoritative index loads only the segments referenced by
 * `manifest.json`; superseded segments and abandoned staging files keep
 * accumulating next to it. They must never be deleted by extension alone:
 * this module always re-reads the manifest at execution time, re-verifies
 * every target is still unreferenced, inside the index directory and
 * unchanged since the preview, and writes a deletion report for audit.
 */

export const INDEX_ORPHAN_PROTECTION_MS = 24 * 60 * 60 * 1000
const INDEX_MANIFEST_MAX_BYTES = 64 * 1024 * 1024

export interface IndexOrphanFile {
  path: string
  sizeBytes: number
  mtimeMs: number
}

export interface IndexOrphanPreview {
  indexDir: string
  manifestFingerprint: { sizeBytes: number; mtimeMs: number }
  referencedCount: number
  orphans: IndexOrphanFile[]
  totalBytes: number
  createdAt: number
}

export interface IndexOrphanCleanupResult {
  ok: boolean
  error?: string
  deletedFiles: number
  deletedBytes: number
  skipped: number
  errors: string[]
  reportPath?: string
}

/** Read the referenced segment set; null when the manifest is unusable. */
export async function readManifestReferencedFiles(indexDir: string): Promise<Set<string> | null> {
  try {
    const manifestPath = path.join(indexDir, 'manifest.json')
    const stat = await fs.promises.stat(manifestPath)
    if (!stat.isFile() || stat.size > INDEX_MANIFEST_MAX_BYTES) return null
    const parsed = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as {
      segments?: unknown
    }
    if (!Array.isArray(parsed.segments)) return null
    const referenced = new Set<string>()
    for (const rawSegment of parsed.segments) {
      if (!rawSegment || typeof rawSegment !== 'object' || Array.isArray(rawSegment)) return null
      const file = (rawSegment as { file?: unknown }).file
      if (typeof file !== 'string' || !file || path.isAbsolute(file)) return null
      const resolved = path.resolve(indexDir, file)
      if (!resolved.startsWith(path.resolve(indexDir) + path.sep)) return null
      referenced.add(resolved)
    }
    return referenced
  } catch {
    return null
  }
}

async function manifestFingerprint(
  indexDir: string,
): Promise<{ sizeBytes: number; mtimeMs: number } | null> {
  try {
    const stat = await fs.promises.stat(path.join(indexDir, 'manifest.json'))
    return stat.isFile() ? { sizeBytes: stat.size, mtimeMs: stat.mtimeMs } : null
  } catch {
    return null
  }
}

/** Collect unreferenced segment/staging files older than the protection window. */
export async function collectIndexOrphans(
  indexDir: string,
  options: { now?: number; protectionMs?: number } = {},
): Promise<{ referenced: Set<string>; orphans: IndexOrphanFile[] } | null> {
  const referenced = await readManifestReferencedFiles(indexDir)
  if (!referenced) return null
  const now = options.now ?? Date.now()
  const protectionMs = options.protectionMs ?? INDEX_ORPHAN_PROTECTION_MS
  const cutoff = now - protectionMs
  const segmentsRoot = path.resolve(indexDir, 'segments')
  const stagingRoot = path.resolve(indexDir, 'staging')
  const orphans: IndexOrphanFile[] = []
  for (const root of [segmentsRoot, stagingRoot]) {
    const queue = [root]
    while (queue.length > 0) {
      const current = queue.pop()!
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const fullPath = path.join(current, entry.name)
        if (entry.isDirectory()) {
          queue.push(fullPath)
          continue
        }
        if (!entry.isFile()) continue
        try {
          const stat = await fs.promises.stat(fullPath)
          const resolved = path.resolve(fullPath)
          if (!referenced.has(resolved) && stat.mtimeMs < cutoff) {
            orphans.push({ path: resolved, sizeBytes: stat.size, mtimeMs: stat.mtimeMs })
          }
        } catch {
          // File vanished mid-walk; skip it.
        }
      }
    }
  }
  orphans.sort((left, right) => left.path.localeCompare(right.path))
  return { referenced, orphans }
}

/** Read-only preview; returns null when the manifest is unreadable (fail closed). */
export async function previewIndexOrphanCleanup(
  indexDir: string,
  options: { now?: number; protectionMs?: number } = {},
): Promise<IndexOrphanPreview | null> {
  const fingerprint = await manifestFingerprint(indexDir)
  if (!fingerprint) return null
  const collected = await collectIndexOrphans(indexDir, options)
  if (!collected) return null
  return {
    indexDir: path.resolve(indexDir),
    manifestFingerprint: fingerprint,
    referencedCount: collected.referenced.size,
    orphans: collected.orphans,
    totalBytes: collected.orphans.reduce((sum, file) => sum + file.sizeBytes, 0),
    createdAt: options.now ?? Date.now(),
  }
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Execute a previewed cleanup. The manifest is re-read and its fingerprint
 * compared with the preview; any drift aborts before the first delete.
 * Every file is then re-verified individually (contained via realpath,
 * still unreferenced, identical mtime/size) before unlink. A JSON report
 * is written next to the index for audit and recovery decisions.
 */
export async function executeIndexOrphanCleanup(
  preview: IndexOrphanPreview,
  options: { reportDir?: string; protectionMs?: number } = {},
): Promise<IndexOrphanCleanupResult> {
  const result: IndexOrphanCleanupResult = {
    ok: false,
    deletedFiles: 0,
    deletedBytes: 0,
    skipped: 0,
    errors: [],
  }
  const indexDir = path.resolve(preview.indexDir)
  const fingerprint = await manifestFingerprint(indexDir)
  if (
    !fingerprint ||
    fingerprint.sizeBytes !== preview.manifestFingerprint.sizeBytes ||
    fingerprint.mtimeMs !== preview.manifestFingerprint.mtimeMs
  ) {
    result.error = 'Image Search manifest changed since the preview; run a new preview'
    return result
  }
  const collected = await collectIndexOrphans(indexDir, {
    now: Date.now(),
    protectionMs: options.protectionMs,
  })
  if (!collected) {
    result.error = 'Image Search manifest became unreadable; cleanup aborted'
    return result
  }
  const stillOrphan = new Map(collected.orphans.map((file) => [file.path, file]))
  let realRoot: string
  try {
    realRoot = await fs.promises.realpath(indexDir)
  } catch (error) {
    result.error = `Image Search index directory is unavailable: ${error}`
    return result
  }
  for (const target of preview.orphans) {
    try {
      const fresh = stillOrphan.get(target.path)
      if (!fresh || fresh.sizeBytes !== target.sizeBytes || fresh.mtimeMs !== target.mtimeMs) {
        result.skipped++
        continue
      }
      const realTarget = await fs.promises.realpath(target.path)
      if (!isContained(realRoot, realTarget)) {
        result.skipped++
        continue
      }
      const stat = await fs.promises.lstat(target.path)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        result.skipped++
        continue
      }
      await fs.promises.unlink(target.path)
      result.deletedFiles++
      result.deletedBytes += stat.size
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') result.skipped++
      else result.errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  try {
    const reportDir =
      options.reportDir ?? path.join(path.dirname(indexDir), 'image-search-orphan-reports')
    await fs.promises.mkdir(reportDir, { recursive: true })
    const reportPath = path.join(
      reportDir,
      `orphan-cleanup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    )
    await fs.promises.writeFile(
      reportPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          indexDir,
          manifestFingerprint: preview.manifestFingerprint,
          previewCreatedAt: new Date(preview.createdAt).toISOString(),
          deletedFiles: result.deletedFiles,
          deletedBytes: result.deletedBytes,
          skipped: result.skipped,
          errors: result.errors,
          targets: preview.orphans,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    result.reportPath = reportPath
  } catch (error) {
    result.errors.push(`report write failed: ${error instanceof Error ? error.message : error}`)
  }
  result.ok = result.errors.length === 0
  return result
}
