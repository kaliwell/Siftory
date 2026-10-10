// ── Vector index health probe (Phase 3) ──────────────────
// Maps the authoritative vector store state onto the unified search
// degradation vocabulary (design 9.2): a corrupted generation is reported as
// 'vector-corrupt', a missing/unbuilt index as 'index-stale', and a healthy
// pinned generation as 'ready'. Connects to the existing corruption-refusal
// semantics of authoritativeVectorStore (manifest sha + content proofs).
// Pure module: no electron imports.

import fs from 'fs'
import path from 'path'
import { readCurrentAuthoritativeManifest, sha256FileSync } from './authoritativeVectorStore'

export type VectorIndexHealthStatus = 'ready' | 'index-stale' | 'vector-corrupt'

export interface VectorIndexHealth {
  status: VectorIndexHealthStatus
  generation?: string
  detail?: string
}

/**
 * Probe the CURRENT generation of an authoritative vector store.
 * - store root or CURRENT missing → 'index-stale' (index not built yet; the
 *   fix is to run the embedding stage, not to report empty results);
 * - CURRENT pins a generation whose manifest sha or structural validation
 *   fails → 'vector-corrupt' (fail closed, per VAL-038);
 * - otherwise → 'ready'.
 */
export function probeVectorIndexHealth(
  storeRoot: string,
  requiredEntry?: { modelName: string; embeddingType: string },
): VectorIndexHealth {
  const currentPath = path.join(storeRoot, 'CURRENT')
  if (!fs.existsSync(currentPath)) {
    return { status: 'index-stale', detail: 'No committed vector generation exists yet' }
  }
  let generation: string | undefined
  let manifestSha256: string | undefined
  try {
    const current = JSON.parse(fs.readFileSync(currentPath, 'utf8')) as {
      generation?: unknown
      manifestSha256?: unknown
    }
    if (typeof current.generation === 'string') generation = current.generation
    if (typeof current.manifestSha256 === 'string') manifestSha256 = current.manifestSha256
  } catch {
    return { status: 'vector-corrupt', detail: 'CURRENT generation pointer is unreadable' }
  }
  if (!generation || !manifestSha256) {
    return { status: 'vector-corrupt', detail: 'CURRENT generation pointer is malformed' }
  }
  const manifestPath = path.join(storeRoot, 'generations', generation, 'manifest.json')
  try {
    if (!fs.existsSync(manifestPath) || sha256FileSync(manifestPath) !== manifestSha256) {
      return {
        status: 'vector-corrupt',
        generation,
        detail: 'Pinned manifest is missing or fails its sha256 proof',
      }
    }
  } catch {
    return {
      status: 'vector-corrupt',
      generation,
      detail: 'Pinned manifest could not be verified',
    }
  }
  const manifest = readCurrentAuthoritativeManifest(storeRoot, true)
  if (!manifest) {
    return {
      status: 'vector-corrupt',
      generation,
      detail: 'Pinned manifest failed structural, size or content-proof validation',
    }
  }
  if (
    requiredEntry &&
    !manifest.entries.some(
      (entry) =>
        entry.modelName === requiredEntry.modelName &&
        entry.embeddingType === requiredEntry.embeddingType &&
        entry.count > 0,
    )
  ) {
    return {
      status: 'index-stale',
      generation: manifest.generation,
      detail: `Committed generation has no ${requiredEntry.modelName}/${requiredEntry.embeddingType} vectors`,
    }
  }
  return { status: 'ready', generation: manifest.generation }
}
