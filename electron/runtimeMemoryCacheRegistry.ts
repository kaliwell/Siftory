const MAX_CACHE_PROVIDERS = 64
const MAX_PROVIDER_NAME_LENGTH = 64

export interface RuntimeCacheBudgetSnapshot {
  entries: number
  ownedBytesApprox: number
  budgetBytes: number | null
  activeEntries?: number
}

type CacheBudgetProvider = () => RuntimeCacheBudgetSnapshot
type CacheReleaseHandler = () => unknown

interface CacheBudgetRegistration {
  provider: CacheBudgetProvider
  release?: CacheReleaseHandler
}

const cacheBudgetProviders = new Map<string, CacheBudgetRegistration>()

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function sanitizeProviderName(name: string): string {
  const normalized = name.trim().toLowerCase()
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(normalized)) {
    throw new Error('Runtime memory provider name is invalid')
  }
  return normalized
}

function validateCacheBudgetSnapshot(
  snapshot: RuntimeCacheBudgetSnapshot,
): RuntimeCacheBudgetSnapshot {
  const entries = nonNegativeInteger(snapshot?.entries)
  const ownedBytesApprox = nonNegativeInteger(snapshot?.ownedBytesApprox)
  const budgetBytes =
    snapshot?.budgetBytes === null ? null : nonNegativeInteger(snapshot?.budgetBytes)
  const activeEntries =
    snapshot?.activeEntries === undefined ? undefined : nonNegativeInteger(snapshot.activeEntries)
  if (
    entries === undefined ||
    ownedBytesApprox === undefined ||
    budgetBytes === undefined ||
    (activeEntries === undefined && snapshot?.activeEntries !== undefined)
  ) {
    throw new Error('Runtime memory cache budget snapshot is invalid')
  }
  return {
    entries,
    ownedBytesApprox,
    budgetBytes,
    ...(activeEntries === undefined ? {} : { activeEntries }),
  }
}

export function registerRuntimeCacheBudgetProvider(
  name: string,
  provider: CacheBudgetProvider,
  release?: CacheReleaseHandler,
): () => void {
  const key = sanitizeProviderName(name)
  if (cacheBudgetProviders.has(key)) throw new Error('Runtime memory provider already exists')
  if (cacheBudgetProviders.size >= MAX_CACHE_PROVIDERS) {
    throw new Error('Runtime memory provider limit reached')
  }
  const registration = { provider, ...(release ? { release } : {}) }
  cacheBudgetProviders.set(key, registration)
  return () => {
    if (cacheBudgetProviders.get(key) === registration) cacheBudgetProviders.delete(key)
  }
}

export function captureRegisteredRuntimeCacheBudgets(): Record<string, RuntimeCacheBudgetSnapshot> {
  const snapshots: Record<string, RuntimeCacheBudgetSnapshot> = {}
  for (const [name, registration] of [...cacheBudgetProviders].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    snapshots[name] = validateCacheBudgetSnapshot(registration.provider())
  }
  return snapshots
}

export function requestRegisteredRuntimeCacheRelease(name: string): boolean {
  const registration = cacheBudgetProviders.get(sanitizeProviderName(name))
  if (!registration?.release) return false
  registration.release()
  return true
}

export const RUNTIME_MEMORY_PROVIDER_NAME_MAX_LENGTH = MAX_PROVIDER_NAME_LENGTH
