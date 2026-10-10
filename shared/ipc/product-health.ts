export type ProductHealthState = 'healthy' | 'degraded' | 'error' | 'not-ready'

export type ProductHealthCheckId =
  | 'source-connectivity'
  | 'catalog-integrity'
  | 'vector-integrity'
  | 'model-integrity'
  | 'task-runtime'
  | 'data-protection'
  | 'storage'

export type ProductHealthSummaryCode =
  | 'sources-ready'
  | 'sources-offline'
  | 'sources-empty'
  | 'catalog-consistent'
  | 'catalog-inconsistent'
  | 'catalog-unavailable'
  | 'vector-ready'
  | 'vector-stale'
  | 'vector-corrupt'
  | 'models-ready'
  | 'models-missing'
  | 'models-corrupt'
  | 'tasks-ready'
  | 'tasks-pressure'
  | 'tasks-failed'
  | 'data-protection-ready'
  | 'data-protection-failed'
  | 'data-protection-not-applied'
  | 'storage-ready'
  | 'storage-low'
  | 'storage-unavailable'

export type ProductHealthRepairActionId =
  | 'recheck'
  | 'reconnect-sources'
  | 'open-source-rescan'
  | 'open-image-rebuild'
  | 'open-model-repair'
  | 'cancel-background'
  | 'review-derived-reset'
  | 'repair-data-protection'

export type ProductHealthRepairTier = 'safe' | 'rebuild' | 'destructive'

export type ProductHealthRoute = 'sources' | 'image-search' | 'task-center' | 'settings-data-reset'

export interface ProductHealthRepairAction {
  id: ProductHealthRepairActionId
  tier: ProductHealthRepairTier
  requiresConfirmation: boolean
}

export interface ProductHealthCheck {
  id: ProductHealthCheckId
  state: ProductHealthState
  summaryCode: ProductHealthSummaryCode
  counts: Record<string, number>
  actions: ProductHealthRepairAction[]
}

export interface ProductHealthReport {
  schema: 'siftory-product-health/v1'
  generatedAt: number
  app: {
    version: string
    platform: string
    architecture: string
  }
  overall: ProductHealthState
  checks: ProductHealthCheck[]
  privacy: {
    redacted: true
    containsAbsolutePaths: false
    containsCredentials: false
  }
}

export interface ProductHealthRepairRequest {
  actionId: ProductHealthRepairActionId
  confirmed?: true
}

export interface ProductHealthRepairResult {
  ok: boolean
  report?: ProductHealthReport
  route?: ProductHealthRoute
  affected?: number
  errorCode?: 'invalid-action' | 'confirmation-required' | 'action-unavailable' | 'repair-failed'
}

export interface ProductHealthExportResult {
  ok: boolean
  saved?: true
  errorCode?: 'cancelled' | 'unsafe-report' | 'write-failed'
}

export const PRODUCT_HEALTH_IPC = {
  REPORT_GET: 'catalog:health/getReport',
  REPAIR_RUN: 'catalog:health/repair',
  REPORT_SAVE_DIALOG: 'catalog:health/saveReportDialog',
} as const
