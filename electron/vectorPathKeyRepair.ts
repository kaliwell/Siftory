// ── Vector / manifest path-key repair (Phase 3, Phase 2 leftover) ──
// After a same-volume move, AssetIdentityService.repairMovedFile re-points
// the identity mapping, assets.jsonl and the discovery catalog. This module
// closes the remaining gap: the image-search embedding path indexes (derived
// F16 cache `*.paths.jsonl` + meta proofs) and the authoritative vector store
// generation path files still key vectors by the OLD path. Vector bytes stay
// valid (same content, same row order), so the repair rewrites only the path
// keys and then re-commits every affected content proof:
// - derived cache: rewrite `*.paths.jsonl`, re-pin `integrity.pathsSha256` in
//   the sibling `*.f16.json` meta;
// - authoritative store: verify the CURRENT generation proofs first (fail
//   closed on corruption — we never "repair" on top of corrupt bytes), rewrite
//   the pinned paths file, update the entry proof + matching import anchors,
//   rewrite manifest.json and re-pin CURRENT.manifestSha256.
// Vector stores are rebuildable derivatives per the storage authority
// boundary, so re-pinning their proofs is a reconcile, not an authority
// transfer. Pure module: no electron imports.

import fs from 'fs'
import path from 'path'
import {
  AUTHORITATIVE_VECTOR_STORE_VERSION,
  readCurrentAuthoritativeManifest,
  sha256FileSync,
  sha256FileTailSync,
  type AuthoritativeVectorStoreManifest,
} from './authoritativeVectorStore'
import {
  createEmbeddingCacheFileProof,
  verifyEmbeddingCacheFileProof,
} from './embeddingCacheIntegrity'
import { embeddingCachePathKey } from './embeddingF16Cache'

export interface VectorPathKeyRepair {
  oldPath: string
  newPath: string
}

export interface VectorPathKeyRepairReport {
  status: 'ok' | 'noop' | 'refused-corrupt'
  repairedRows: number
  files: string[]
  detail?: string
}

function preflightAuthoritativeStorePathRepair(
  storeRoot: string,
): VectorPathKeyRepairReport | null {
  const currentPath = path.join(storeRoot, 'CURRENT')
  if (!fs.existsSync(currentPath)) return null
  // Validate the complete pinned generation before any derived cache is
  // changed. Without this preflight, repairVectorIndexPathKeys could rewrite
  // an F16 cache and only then discover that the authoritative generation is
  // corrupt, leaving a misleading half-completed repair on disk.
  if (!readCurrentAuthoritativeManifest(storeRoot, true)) {
    return {
      status: 'refused-corrupt',
      repairedRows: 0,
      files: [],
      detail: 'Pinned authoritative generation failed validation before path repair',
    }
  }
  return null
}

interface RepairedSourceFile {
  path: string
  size: number
  mtimeMs: number
}

function rewritePathIndexFile(filePath: string, repairKeys: Map<string, string>): number {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n')
  let repaired = 0
  const output = lines.map((line) => {
    if (!line.trim()) return line
    let parsed: { row?: unknown; path?: unknown }
    try {
      parsed = JSON.parse(line) as { row?: unknown; path?: unknown }
    } catch {
      return line
    }
    if (typeof parsed.path !== 'string') return line
    const replacement = repairKeys.get(embeddingCachePathKey(parsed.path))
    if (!replacement) return line
    repaired += 1
    return JSON.stringify({ row: parsed.row, path: replacement })
  })
  if (repaired === 0) return 0
  const temporary = `${filePath}.repath-tmp`
  fs.writeFileSync(temporary, output.join('\n'), 'utf8')
  fs.renameSync(temporary, filePath)
  return repaired
}

/**
 * Rewrite path keys in every derived F16 cache under `cacheDir`
 * (`<model>__<type>.paths.jsonl`) and re-pin the sibling meta integrity proof.
 */
export function repairF16CachePathKeys(
  cacheDir: string,
  repairs: readonly VectorPathKeyRepair[],
): { repairedRows: number; files: string[]; sources: RepairedSourceFile[] } {
  const repairKeys = new Map(
    repairs.map((repair) => [embeddingCachePathKey(repair.oldPath), path.resolve(repair.newPath)]),
  )
  const result = { repairedRows: 0, files: [] as string[], sources: [] as RepairedSourceFile[] }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.paths.jsonl')) continue
    const pathsFile = path.join(cacheDir, entry.name)
    const metaFile = path.join(cacheDir, entry.name.replace(/\.paths\.jsonl$/, '.f16.json'))
    if (!fs.existsSync(metaFile)) continue
    const repaired = rewritePathIndexFile(pathsFile, repairKeys)
    if (repaired === 0) continue
    // Re-pin the derived proof: the meta stays valid only because we commit
    // the new paths sha; readers keep verifying before serving the cache.
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as {
      integrity?: { pathsSha256?: string }
      updatedAt?: number
    }
    meta.integrity = {
      ...meta.integrity,
      pathsSha256: createEmbeddingCacheFileProof(pathsFile).sha256,
    }
    meta.updatedAt = Date.now()
    const metaTemporary = `${metaFile}.repath-tmp`
    fs.writeFileSync(metaTemporary, JSON.stringify(meta, null, 2), 'utf8')
    fs.renameSync(metaTemporary, metaFile)
    const stat = fs.statSync(pathsFile)
    result.repairedRows += repaired
    result.files.push(pathsFile)
    result.sources.push({ path: pathsFile, size: stat.size, mtimeMs: stat.mtimeMs })
  }
  return result
}

/**
 * Rewrite path keys inside the CURRENT authoritative generation. Fails closed
 * ('refused-corrupt') when the pinned proofs do not match before the repair.
 * `updatedSources` re-anchors import proofs for cache files rewritten by
 * repairF16CachePathKeys, keeping extend-from-authoritative viable.
 */
export function repairAuthoritativeStorePathKeys(
  storeRoot: string,
  repairs: readonly VectorPathKeyRepair[],
  updatedSources: readonly RepairedSourceFile[] = [],
): VectorPathKeyRepairReport {
  const noop: VectorPathKeyRepairReport = { status: 'noop', repairedRows: 0, files: [] }
  const currentPath = path.join(storeRoot, 'CURRENT')
  if (!fs.existsSync(currentPath)) return noop
  let current: { version?: number; generation?: string; manifestSha256?: string }
  try {
    current = JSON.parse(fs.readFileSync(currentPath, 'utf8'))
  } catch {
    return { status: 'refused-corrupt', repairedRows: 0, files: [], detail: 'CURRENT unreadable' }
  }
  if (
    current.version !== AUTHORITATIVE_VECTOR_STORE_VERSION ||
    !current.generation ||
    !current.manifestSha256
  ) {
    return { status: 'refused-corrupt', repairedRows: 0, files: [], detail: 'CURRENT malformed' }
  }
  const generationDir = path.join(storeRoot, 'generations', current.generation)
  const manifestPath = path.join(generationDir, 'manifest.json')
  if (!fs.existsSync(manifestPath) || sha256FileSync(manifestPath) !== current.manifestSha256) {
    return {
      status: 'refused-corrupt',
      repairedRows: 0,
      files: [],
      detail: 'Pinned manifest fails its sha256 proof; refusing to repair on corrupt bytes',
    }
  }
  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, 'utf8'),
  ) as AuthoritativeVectorStoreManifest
  // Fail closed: every pinned file must still match its committed proof.
  for (const entry of manifest.entries) {
    for (const file of [entry.vectors, entry.paths]) {
      if (!verifyEmbeddingCacheFileProof(path.join(generationDir, file.name), file)) {
        return {
          status: 'refused-corrupt',
          repairedRows: 0,
          files: [],
          detail: `Generation file ${file.name} fails its content proof`,
        }
      }
    }
  }
  const repairKeys = new Map(
    repairs.map((repair) => [embeddingCachePathKey(repair.oldPath), path.resolve(repair.newPath)]),
  )
  const sourceByPath = new Map(
    updatedSources.map((source) => [path.resolve(source.path), source] as const),
  )
  let repairedRows = 0
  const files: string[] = []
  for (const entry of manifest.entries) {
    const pathsFile = path.join(generationDir, entry.paths.name)
    const repaired = rewritePathIndexFile(pathsFile, repairKeys)
    if (repaired > 0) {
      entry.paths = { name: entry.paths.name, ...createEmbeddingCacheFileProof(pathsFile) }
      repairedRows += repaired
      files.push(pathsFile)
    }
    // Re-anchor imports that point at cache files rewritten in the same run.
    for (const imported of entry.imports) {
      const updated = sourceByPath.get(path.resolve(imported.path))
      if (!updated) continue
      imported.size = updated.size
      imported.mtimeMs = updated.mtimeMs
      if (imported.tailSha256 !== undefined) {
        imported.tailSha256 = sha256FileTailSync(imported.path, imported.size)
      }
    }
  }
  if (repairedRows === 0 && updatedSources.length === 0) return noop
  const manifestTemporary = `${manifestPath}.repath-tmp`
  fs.writeFileSync(manifestTemporary, JSON.stringify(manifest, null, 2), 'utf8')
  fs.renameSync(manifestTemporary, manifestPath)
  const currentTemporary = `${currentPath}.repath-tmp`
  fs.writeFileSync(
    currentTemporary,
    JSON.stringify({
      version: AUTHORITATIVE_VECTOR_STORE_VERSION,
      generation: current.generation,
      manifestSha256: sha256FileSync(manifestPath),
      switchedAt: Date.now(),
    }),
    'utf8',
  )
  fs.renameSync(currentTemporary, currentPath)
  return { status: 'ok', repairedRows, files }
}

/**
 * One-shot reconcile after same-volume moves: repair the derived F16 caches
 * and the authoritative generation, threading the rewritten cache files into
 * the import re-anchoring step.
 */
export function repairVectorIndexPathKeys(options: {
  repairs: readonly VectorPathKeyRepair[]
  cacheDir?: string
  storeRoot?: string
}): VectorPathKeyRepairReport {
  if (options.repairs.length === 0) return { status: 'noop', repairedRows: 0, files: [] }
  if (options.storeRoot) {
    const refused = preflightAuthoritativeStorePathRepair(options.storeRoot)
    if (refused) return refused
  }
  const files: string[] = []
  let repairedRows = 0
  let sources: RepairedSourceFile[] = []
  if (options.cacheDir) {
    const cacheResult = repairF16CachePathKeys(options.cacheDir, options.repairs)
    repairedRows += cacheResult.repairedRows
    files.push(...cacheResult.files)
    sources = cacheResult.sources
  }
  if (options.storeRoot) {
    const storeResult = repairAuthoritativeStorePathKeys(
      options.storeRoot,
      options.repairs,
      sources,
    )
    if (storeResult.status === 'refused-corrupt') {
      return { ...storeResult, repairedRows, files }
    }
    repairedRows += storeResult.repairedRows
    files.push(...storeResult.files)
  }
  return repairedRows > 0
    ? { status: 'ok', repairedRows, files }
    : { status: 'noop', repairedRows, files }
}
