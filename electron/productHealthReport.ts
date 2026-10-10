import path from 'path'
import type {
  ProductHealthCheck,
  ProductHealthRepairAction,
  ProductHealthRepairActionId,
  ProductHealthReport,
  ProductHealthState,
} from '../shared/ipc/product-health'
import type { DiscoveryCatalogConsistencyReport } from './discoveryCatalogDatabase'
import { containsUnsafeDiagnosticText, redactDiagnosticText } from './diagnosticRedaction'

export interface ProductHealthReportInput {
  generatedAt: number
  appVersion: string
  platform: string
  architecture: string
  sources: Array<{ availability: 'online' | 'offline' | 'degraded' | 'unknown' }>
  catalog?: DiscoveryCatalogConsistencyReport
  vector: { status: 'ready' | 'index-stale' | 'vector-corrupt' }
  models: Array<{ state: string }>
  scheduler: {
    failed: number
    queued: number
    running: number
    backgroundPaused: boolean
    pressureReasonCount: number
  }
  dataProtection?: {
    applied: boolean
    reason?: 'disabled' | 'unsupported' | 'failed'
  }
  storage?: { freeBytes: number; minimumFreeBytes: number }
}

const ACTIONS: Record<ProductHealthRepairActionId, ProductHealthRepairAction> = {
  recheck: { id: 'recheck', tier: 'safe', requiresConfirmation: false },
  'reconnect-sources': {
    id: 'reconnect-sources',
    tier: 'safe',
    requiresConfirmation: false,
  },
  'open-source-rescan': {
    id: 'open-source-rescan',
    tier: 'rebuild',
    requiresConfirmation: false,
  },
  'open-image-rebuild': {
    id: 'open-image-rebuild',
    tier: 'rebuild',
    requiresConfirmation: false,
  },
  'open-model-repair': {
    id: 'open-model-repair',
    tier: 'rebuild',
    requiresConfirmation: false,
  },
  'cancel-background': {
    id: 'cancel-background',
    tier: 'safe',
    requiresConfirmation: true,
  },
  'review-derived-reset': {
    id: 'review-derived-reset',
    tier: 'destructive',
    requiresConfirmation: true,
  },
  'repair-data-protection': {
    id: 'repair-data-protection',
    tier: 'safe',
    requiresConfirmation: true,
  },
}

const STATE_RANK: Record<ProductHealthState, number> = {
  healthy: 0,
  'not-ready': 1,
  degraded: 2,
  error: 3,
}

function boundedCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)))
    : 0
}

function safeIdentity(value: unknown): string {
  if (typeof value !== 'string') return 'unknown'
  const normalized = value.trim().slice(0, 64)
  return /^[a-z0-9._+()-]+$/i.test(normalized) ? normalized : 'unknown'
}

function repairActions(...ids: ProductHealthRepairActionId[]): ProductHealthRepairAction[] {
  return ids.map((id) => ({ ...ACTIONS[id] }))
}

function sourceCheck(input: ProductHealthReportInput): ProductHealthCheck {
  const total = input.sources.length
  const online = input.sources.filter((source) => source.availability === 'online').length
  const offline = input.sources.filter((source) => source.availability === 'offline').length
  const unavailable = total - online
  if (total === 0) {
    return {
      id: 'source-connectivity',
      state: 'not-ready',
      summaryCode: 'sources-empty',
      counts: { total: 0, online: 0, offline: 0, unavailable: 0 },
      actions: repairActions('open-source-rescan'),
    }
  }
  if (unavailable > 0) {
    return {
      id: 'source-connectivity',
      state: 'degraded',
      summaryCode: 'sources-offline',
      counts: { total, online, offline, unavailable },
      actions: repairActions('reconnect-sources', 'open-source-rescan'),
    }
  }
  return {
    id: 'source-connectivity',
    state: 'healthy',
    summaryCode: 'sources-ready',
    counts: { total, online, offline: 0, unavailable: 0 },
    actions: [],
  }
}

function catalogCheck(input: ProductHealthReportInput): ProductHealthCheck {
  const catalog = input.catalog
  if (!catalog) {
    return {
      id: 'catalog-integrity',
      state: 'error',
      summaryCode: 'catalog-unavailable',
      counts: {},
      actions: repairActions('open-source-rescan'),
    }
  }
  const counts = {
    sources: boundedCount(catalog.sourceCount),
    files: boundedCount(catalog.fileCount),
    indexStates: boundedCount(catalog.indexStateCount),
    missingFiles: boundedCount(catalog.missingFileCount),
    staleIndexes: boundedCount(catalog.staleIndexCount),
    failedIndexes: boundedCount(catalog.failedIndexCount),
    structuralIssues: boundedCount(
      catalog.foreignKeyViolationCount +
        catalog.orphanFileCount +
        catalog.orphanIndexCount +
        catalog.missingDiscoveryStateCount +
        catalog.invalidIndexStateCount +
        (catalog.quickCheckOk ? 0 : 1),
    ),
  }
  if (!catalog.ok) {
    return {
      id: 'catalog-integrity',
      state: 'error',
      summaryCode: 'catalog-inconsistent',
      counts,
      actions: repairActions('open-source-rescan'),
    }
  }
  const derivedIssues = counts.staleIndexes + counts.failedIndexes
  return {
    id: 'catalog-integrity',
    state: derivedIssues > 0 ? 'degraded' : 'healthy',
    summaryCode: 'catalog-consistent',
    counts,
    actions: derivedIssues > 0 ? repairActions('open-image-rebuild') : [],
  }
}

function vectorCheck(input: ProductHealthReportInput): ProductHealthCheck {
  if (input.vector.status === 'ready') {
    return {
      id: 'vector-integrity',
      state: 'healthy',
      summaryCode: 'vector-ready',
      counts: {},
      actions: [],
    }
  }
  if (input.vector.status === 'vector-corrupt') {
    return {
      id: 'vector-integrity',
      state: 'error',
      summaryCode: 'vector-corrupt',
      counts: { corrupt: 1 },
      actions: repairActions('open-image-rebuild', 'review-derived-reset'),
    }
  }
  return {
    id: 'vector-integrity',
    state: 'not-ready',
    summaryCode: 'vector-stale',
    counts: { stale: 1 },
    actions: repairActions('open-image-rebuild'),
  }
}

function modelCheck(input: ProductHealthReportInput): ProductHealthCheck {
  const corrupt = input.models.filter((model) => model.state === 'error').length
  const missing = input.models.filter((model) =>
    ['not-installed', 'unavailable'].includes(model.state),
  ).length
  const ready = input.models.filter((model) =>
    ['downloaded', 'verified', 'loaded', 'ready'].includes(model.state),
  ).length
  const counts = { total: input.models.length, ready, missing, corrupt }
  if (corrupt > 0) {
    return {
      id: 'model-integrity',
      state: 'error',
      summaryCode: 'models-corrupt',
      counts,
      actions: repairActions('open-model-repair'),
    }
  }
  if (missing > 0 || ready < input.models.length) {
    return {
      id: 'model-integrity',
      state: 'not-ready',
      summaryCode: 'models-missing',
      counts,
      actions: repairActions('open-model-repair'),
    }
  }
  return {
    id: 'model-integrity',
    state: 'healthy',
    summaryCode: 'models-ready',
    counts,
    actions: [],
  }
}

function taskCheck(input: ProductHealthReportInput): ProductHealthCheck {
  const counts = {
    running: boundedCount(input.scheduler.running),
    queued: boundedCount(input.scheduler.queued),
    failed: boundedCount(input.scheduler.failed),
    pressureReasons: boundedCount(input.scheduler.pressureReasonCount),
  }
  if (counts.failed > 0) {
    return {
      id: 'task-runtime',
      state: 'degraded',
      summaryCode: 'tasks-failed',
      counts,
      actions: input.scheduler.backgroundPaused ? repairActions('cancel-background') : [],
    }
  }
  if (input.scheduler.backgroundPaused) {
    return {
      id: 'task-runtime',
      state: 'degraded',
      summaryCode: 'tasks-pressure',
      counts,
      actions: repairActions('cancel-background'),
    }
  }
  return {
    id: 'task-runtime',
    state: 'healthy',
    summaryCode: 'tasks-ready',
    counts,
    actions: [],
  }
}

function storageCheck(input: ProductHealthReportInput): ProductHealthCheck {
  if (!input.storage) {
    return {
      id: 'storage',
      state: 'degraded',
      summaryCode: 'storage-unavailable',
      counts: {},
      actions: [],
    }
  }
  const freeBytes = boundedCount(input.storage.freeBytes)
  const minimumFreeBytes = boundedCount(input.storage.minimumFreeBytes)
  if (freeBytes < minimumFreeBytes) {
    return {
      id: 'storage',
      state: 'degraded',
      summaryCode: 'storage-low',
      counts: { freeBytes, minimumFreeBytes },
      actions: repairActions('review-derived-reset'),
    }
  }
  return {
    id: 'storage',
    state: 'healthy',
    summaryCode: 'storage-ready',
    counts: { freeBytes, minimumFreeBytes },
    actions: [],
  }
}

function dataProtectionCheck(input: ProductHealthReportInput): ProductHealthCheck | null {
  if (!input.dataProtection) return null
  if (input.dataProtection.applied) {
    return {
      id: 'data-protection',
      state: 'healthy',
      summaryCode: 'data-protection-ready',
      counts: { protected: 1 },
      actions: [],
    }
  }
  const failed = input.dataProtection.reason === 'failed'
  return {
    id: 'data-protection',
    state: failed ? 'error' : 'degraded',
    summaryCode: failed ? 'data-protection-failed' : 'data-protection-not-applied',
    counts: { protected: 0, failed: failed ? 1 : 0 },
    // Only a failed hardening/probe can be repaired in place; disabled (dev,
    // smoke tests) and unsupported platforms have nothing to repair.
    actions: failed ? repairActions('recheck', 'repair-data-protection') : repairActions('recheck'),
  }
}

export function buildProductHealthReport(input: ProductHealthReportInput): ProductHealthReport {
  const checks = [
    sourceCheck(input),
    catalogCheck(input),
    vectorCheck(input),
    modelCheck(input),
    taskCheck(input),
    dataProtectionCheck(input),
    storageCheck(input),
  ].filter((check): check is ProductHealthCheck => check !== null)
  const overall = checks.reduce<ProductHealthState>(
    (state, check) => (STATE_RANK[check.state] > STATE_RANK[state] ? check.state : state),
    'healthy',
  )
  return {
    schema: 'siftory-product-health/v1',
    generatedAt: boundedCount(input.generatedAt),
    app: {
      version: safeIdentity(input.appVersion),
      platform: safeIdentity(input.platform),
      architecture: safeIdentity(input.architecture),
    },
    overall,
    checks,
    privacy: {
      redacted: true,
      containsAbsolutePaths: false,
      containsCredentials: false,
    },
  }
}

/** Redact bounded free-form diagnostics before they can enter a report. */
export function redactProductDiagnosticText(value: unknown): string {
  return redactDiagnosticText(value)
}

export function findUnsafeProductHealthFields(report: ProductHealthReport): string[] {
  const unsafe: string[] = []
  const walk = (value: unknown, location: string): void => {
    if (typeof value === 'string') {
      if (
        path.win32.isAbsolute(value) ||
        path.posix.isAbsolute(value) ||
        containsUnsafeDiagnosticText(value)
      ) {
        unsafe.push(location)
      }
      return
    }
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      const childLocation = location ? `${location}.${key}` : key
      if (/^(?:password|passphrase|token|secret|privateKey|credential|authorization)$/i.test(key)) {
        unsafe.push(childLocation)
        continue
      }
      walk(child, childLocation)
    }
  }
  walk(report, '')
  return [...new Set(unsafe)].sort()
}

export function serializeProductHealthReport(report: ProductHealthReport): string {
  const unsafe = findUnsafeProductHealthFields(report)
  if (unsafe.length > 0) throw new Error('Product health report contains private fields')
  return `${JSON.stringify(report, null, 2)}\n`
}

export function productHealthRepairAction(
  actionId: ProductHealthRepairActionId,
): ProductHealthRepairAction {
  return { ...ACTIONS[actionId] }
}
