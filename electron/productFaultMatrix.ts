/**
 * Stable product-level recovery contract used by automated fault injection and
 * the health/repair UI. This module describes observable outcomes only: it
 * deliberately exposes no runtime switch capable of triggering a fault in a
 * production build.
 */
export type ProductFaultId =
  | 'process-exit'
  | 'task-child-crash'
  | 'disk-full'
  | 'model-corrupt'
  | 'source-offline'
  | 'restart'

export type ProductFaultDisposition = 'recovered' | 'contained' | 'degraded'

export type ProductFaultDetailCode =
  | 'interrupted-task-requeued'
  | 'child-restarted'
  | 'atomic-write-rolled-back'
  | 'model-integrity-rejected'
  | 'catalog-retained'
  | 'state-rehydrated'

export interface ProductFaultContract {
  id: ProductFaultId
  disposition: ProductFaultDisposition
  detailCode: ProductFaultDetailCode
  recoveryAction:
    | 'resume-interrupted-task'
    | 'retry-isolated-worker'
    | 'free-disk-space'
    | 'repair-model'
    | 'reconnect-source'
    | 'resume-restored-task'
  authoritativeDataPreserved: true
  retryable: true
  processResponsive: true
}

export interface ProductFaultObservation {
  id: ProductFaultId
  disposition: ProductFaultDisposition
  detailCode: ProductFaultDetailCode
  authoritativeDataPreserved: boolean
  retryable: boolean
  processResponsive: boolean
}

export interface ProductFaultCaseResult extends ProductFaultObservation {
  ok: boolean
  errors: string[]
}

export interface ProductFaultMatrixReport {
  schema: 'siftory-product-fault-matrix/v1'
  ok: boolean
  expectedCount: number
  observedCount: number
  cases: ProductFaultCaseResult[]
  errors: string[]
}

export const PRODUCT_FAULT_MATRIX: readonly ProductFaultContract[] = [
  {
    id: 'process-exit',
    disposition: 'recovered',
    detailCode: 'interrupted-task-requeued',
    recoveryAction: 'resume-interrupted-task',
    authoritativeDataPreserved: true,
    retryable: true,
    processResponsive: true,
  },
  {
    id: 'task-child-crash',
    disposition: 'recovered',
    detailCode: 'child-restarted',
    recoveryAction: 'retry-isolated-worker',
    authoritativeDataPreserved: true,
    retryable: true,
    processResponsive: true,
  },
  {
    id: 'disk-full',
    disposition: 'contained',
    detailCode: 'atomic-write-rolled-back',
    recoveryAction: 'free-disk-space',
    authoritativeDataPreserved: true,
    retryable: true,
    processResponsive: true,
  },
  {
    id: 'model-corrupt',
    disposition: 'contained',
    detailCode: 'model-integrity-rejected',
    recoveryAction: 'repair-model',
    authoritativeDataPreserved: true,
    retryable: true,
    processResponsive: true,
  },
  {
    id: 'source-offline',
    disposition: 'degraded',
    detailCode: 'catalog-retained',
    recoveryAction: 'reconnect-source',
    authoritativeDataPreserved: true,
    retryable: true,
    processResponsive: true,
  },
  {
    id: 'restart',
    disposition: 'recovered',
    detailCode: 'state-rehydrated',
    recoveryAction: 'resume-restored-task',
    authoritativeDataPreserved: true,
    retryable: true,
    processResponsive: true,
  },
] as const

const OBSERVED_FIELDS = [
  'disposition',
  'detailCode',
  'authoritativeDataPreserved',
  'retryable',
  'processResponsive',
] as const

/** Validate a complete run in stable contract order, independent of test order. */
export function evaluateProductFaultMatrix(
  observations: readonly ProductFaultObservation[],
): ProductFaultMatrixReport {
  const errors: string[] = []
  const byId = new Map<ProductFaultId, ProductFaultObservation>()
  const knownIds = new Set(PRODUCT_FAULT_MATRIX.map((entry) => entry.id))

  for (const observation of observations) {
    if (!knownIds.has(observation.id)) {
      errors.push(`Unknown fault observation: ${String(observation.id)}`)
      continue
    }
    if (byId.has(observation.id)) {
      errors.push(`Duplicate fault observation: ${observation.id}`)
      continue
    }
    byId.set(observation.id, observation)
  }

  const cases = PRODUCT_FAULT_MATRIX.map((contract): ProductFaultCaseResult => {
    const observation = byId.get(contract.id)
    if (!observation) {
      const missing: ProductFaultCaseResult = {
        id: contract.id,
        disposition: contract.disposition,
        detailCode: contract.detailCode,
        authoritativeDataPreserved: false,
        retryable: false,
        processResponsive: false,
        ok: false,
        errors: [`Missing fault observation: ${contract.id}`],
      }
      errors.push(...missing.errors)
      return missing
    }

    const caseErrors: string[] = []
    for (const field of OBSERVED_FIELDS) {
      if (observation[field] !== contract[field]) {
        caseErrors.push(
          `${contract.id}.${field}: expected ${String(contract[field])}, observed ${String(observation[field])}`,
        )
      }
    }
    errors.push(...caseErrors)
    return { ...observation, ok: caseErrors.length === 0, errors: caseErrors }
  })

  return {
    schema: 'siftory-product-fault-matrix/v1',
    ok: errors.length === 0 && byId.size === PRODUCT_FAULT_MATRIX.length,
    expectedCount: PRODUCT_FAULT_MATRIX.length,
    observedCount: byId.size,
    cases,
    errors,
  }
}
