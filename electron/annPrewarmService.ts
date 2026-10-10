// ── Authoritative-generation ANN prewarm (VAL-031) ──
// The first similarity search against a fresh authoritative generation used
// to pay the full ANN build (read every F16 vector + derive simhash
// signatures) on the query path. This service warms the ANN worker as soon
// as a generation is ready — after a vector-store migration switches CURRENT
// and once at app startup for an existing generation — so the first real
// query takes the already-loaded fast path. Scope snapshots are applied per
// request inside the worker (VAL-035), so warming the scope-free index is
// sufficient. All warm work is preemptible: real searches supersede an
// in-flight prewarm, and the VAL-038 integrity gate runs inside the worker
// exactly as it does for on-demand builds.

import {
  authoritativeVectorStoreRootFromCacheDir,
  readCurrentAuthoritativeManifest,
} from './authoritativeVectorStore'
import {
  embeddingF16CacheSourceFingerprint,
  openAuthoritativeEmbeddingF16Cache,
  type EmbeddingF16CacheHandle,
} from './embeddingF16Cache'
import { prewarmVectorAnn } from './vectorAnnWorkerHost'

export type AnnPrewarmSchedule = 'scheduled' | 'duplicate'

export interface AnnPrewarmRuntimePolicy {
  preferredModelName: string
  canStart: () => boolean
}

let runtimePolicy: AnnPrewarmRuntimePolicy = {
  preferredModelName: 'dinov2_vitb14',
  canStart: () => true,
}

export function configureAnnPrewarmRuntimePolicy(policy: AnnPrewarmRuntimePolicy): () => void {
  if (!policy.preferredModelName.trim()) throw new Error('ANN prewarm model name is required')
  const previous = runtimePolicy
  runtimePolicy = {
    preferredModelName: policy.preferredModelName.trim(),
    canStart: policy.canStart,
  }
  return () => {
    runtimePolicy = previous
  }
}

export interface AnnPrewarmScheduler {
  /**
   * Schedules a background prewarm for the exact source snapshot the handle
   * points at. Returns 'duplicate' when that snapshot is already warmed or
   * being warmed — the same generation is never built twice.
   */
  schedule(cache: EmbeddingF16CacheHandle): AnnPrewarmSchedule
  /** Forget completed generations (derived-data reset, tests). */
  clearHistory(): void
}

export function createAnnPrewarmScheduler(
  prewarm: (cache: EmbeddingF16CacheHandle) => Promise<unknown>,
  onError: (message: string) => void = (message) => console.warn(message),
): AnnPrewarmScheduler {
  const completedKeys = new Set<string>()
  const inflight = new Set<string>()
  return {
    schedule(cache) {
      const key = `${cache.vectorPath}:${embeddingF16CacheSourceFingerprint(cache)}`
      if (completedKeys.has(key) || inflight.has(key)) return 'duplicate'
      inflight.add(key)
      void Promise.resolve()
        .then(() => prewarm(cache))
        .then(() => {
          completedKeys.add(key)
        })
        .catch((error: unknown) => {
          // Superseded by a real search, cancelled by a reset, or the worker
          // failed: background work never fails its trigger — a later trigger
          // (or the first real query) simply retries the build.
          onError(`[ann-prewarm] ${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => {
          inflight.delete(key)
        })
      return 'scheduled'
    },
    clearHistory() {
      completedKeys.clear()
    },
  }
}

const defaultScheduler = createAnnPrewarmScheduler((cache) => {
  if (!runtimePolicy.canStart()) return Promise.reject(new Error('runtime policy deferred prewarm'))
  return prewarmVectorAnn(cache)
})

export function scheduleAnnPrewarm(cache: EmbeddingF16CacheHandle): AnnPrewarmSchedule {
  return defaultScheduler.schedule(cache)
}

export function clearAnnPrewarmHistory(): void {
  defaultScheduler.clearHistory()
}

export interface AuthoritativeAnnPrewarmResult {
  generation: string | null
  scheduled: number
  skipped: number
}

export interface AuthoritativeAnnPrewarmOptions {
  modelName?: string
  canStart?: () => boolean
}

/**
 * Prewarms the ANN index for every model entry of the CURRENT authoritative
 * generation. No-op when no generation is live; opening the handles only
 * stats files and reads the manifest (no content hashing on this thread —
 * the worker re-verifies the pinned proofs before indexing). Fire-and-forget
 * for callers: failures are logged by the scheduler, never thrown.
 */
export function scheduleAuthoritativeAnnPrewarm(
  cacheDir: string,
  scheduler: AnnPrewarmScheduler = defaultScheduler,
  options: AuthoritativeAnnPrewarmOptions = {},
): AuthoritativeAnnPrewarmResult {
  const storeRoot = authoritativeVectorStoreRootFromCacheDir(cacheDir)
  const manifest = readCurrentAuthoritativeManifest(storeRoot)
  if (!manifest) return { generation: null, scheduled: 0, skipped: 0 }
  const modelName = options.modelName?.trim() || runtimePolicy.preferredModelName
  const canStart = options.canStart || runtimePolicy.canStart
  if (!canStart()) {
    return { generation: manifest.generation, scheduled: 0, skipped: manifest.entries.length }
  }
  let scheduled = 0
  let skipped = 0
  for (const entry of manifest.entries) {
    if (entry.modelName !== modelName) {
      skipped += 1
      continue
    }
    const cache = openAuthoritativeEmbeddingF16Cache({
      cacheDir,
      modelName: entry.modelName,
      embeddingType: entry.embeddingType,
      dim: entry.dim,
      sourcePaths: [],
    })
    if (!cache || cache.meta.count <= 0) {
      skipped += 1
      continue
    }
    if (scheduler.schedule(cache) === 'scheduled') scheduled += 1
    else skipped += 1
  }
  return { generation: manifest.generation, scheduled, skipped }
}
