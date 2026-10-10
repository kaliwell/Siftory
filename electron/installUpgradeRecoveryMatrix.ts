/**
 * Stable release-lifecycle verification contract. Like the product fault
 * matrix, this contains observable expectations only and exposes no switch
 * that can install, uninstall, migrate, or delete production data.
 */
export type InstallUpgradeRecoveryCaseId =
  | 'clean-install'
  | 'legacy-upgrade'
  | 'index-migration-rollback'
  | 'uninstall-retention'
  | 'diagnostic-export'

export type InstallUpgradeRecoveryDetailCode =
  | 'isolated-profile-initialized'
  | 'legacy-metadata-preserved'
  | 'current-generation-preserved'
  | 'user-data-retained'
  | 'redacted-report-committed'

export interface InstallUpgradeRecoveryContract {
  id: InstallUpgradeRecoveryCaseId
  detailCode: InstallUpgradeRecoveryDetailCode
  isolated: true
  authoritativeDataPreserved: true
  recoverable: true
  privacySafe: true
}

export interface InstallUpgradeRecoveryObservation {
  id: InstallUpgradeRecoveryCaseId
  detailCode: InstallUpgradeRecoveryDetailCode
  isolated: boolean
  authoritativeDataPreserved: boolean
  recoverable: boolean
  privacySafe: boolean
}

export interface InstallUpgradeRecoveryCaseResult extends InstallUpgradeRecoveryObservation {
  ok: boolean
  errors: string[]
}

export interface InstallUpgradeRecoveryReport {
  schema: 'siftory-install-upgrade-recovery/v1'
  ok: boolean
  expectedCount: number
  observedCount: number
  cases: InstallUpgradeRecoveryCaseResult[]
  errors: string[]
}

export const INSTALL_UPGRADE_RECOVERY_MATRIX: readonly InstallUpgradeRecoveryContract[] = [
  {
    id: 'clean-install',
    detailCode: 'isolated-profile-initialized',
    isolated: true,
    authoritativeDataPreserved: true,
    recoverable: true,
    privacySafe: true,
  },
  {
    id: 'legacy-upgrade',
    detailCode: 'legacy-metadata-preserved',
    isolated: true,
    authoritativeDataPreserved: true,
    recoverable: true,
    privacySafe: true,
  },
  {
    id: 'index-migration-rollback',
    detailCode: 'current-generation-preserved',
    isolated: true,
    authoritativeDataPreserved: true,
    recoverable: true,
    privacySafe: true,
  },
  {
    id: 'uninstall-retention',
    detailCode: 'user-data-retained',
    isolated: true,
    authoritativeDataPreserved: true,
    recoverable: true,
    privacySafe: true,
  },
  {
    id: 'diagnostic-export',
    detailCode: 'redacted-report-committed',
    isolated: true,
    authoritativeDataPreserved: true,
    recoverable: true,
    privacySafe: true,
  },
] as const

const OBSERVED_FIELDS = [
  'detailCode',
  'isolated',
  'authoritativeDataPreserved',
  'recoverable',
  'privacySafe',
] as const

export function evaluateInstallUpgradeRecovery(
  observations: readonly InstallUpgradeRecoveryObservation[],
): InstallUpgradeRecoveryReport {
  const errors: string[] = []
  const knownIds = new Set(INSTALL_UPGRADE_RECOVERY_MATRIX.map((item) => item.id))
  const byId = new Map<InstallUpgradeRecoveryCaseId, InstallUpgradeRecoveryObservation>()

  for (const observation of observations) {
    if (!knownIds.has(observation.id)) {
      errors.push(`Unknown lifecycle observation: ${String(observation.id)}`)
      continue
    }
    if (byId.has(observation.id)) {
      errors.push(`Duplicate lifecycle observation: ${observation.id}`)
      continue
    }
    byId.set(observation.id, observation)
  }

  const cases = INSTALL_UPGRADE_RECOVERY_MATRIX.map(
    (contract): InstallUpgradeRecoveryCaseResult => {
      const observation = byId.get(contract.id)
      if (!observation) {
        const missing: InstallUpgradeRecoveryCaseResult = {
          id: contract.id,
          detailCode: contract.detailCode,
          isolated: false,
          authoritativeDataPreserved: false,
          recoverable: false,
          privacySafe: false,
          ok: false,
          errors: [`Missing lifecycle observation: ${contract.id}`],
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
    },
  )

  return {
    schema: 'siftory-install-upgrade-recovery/v1',
    ok: errors.length === 0 && byId.size === INSTALL_UPGRADE_RECOVERY_MATRIX.length,
    expectedCount: INSTALL_UPGRADE_RECOVERY_MATRIX.length,
    observedCount: byId.size,
    cases,
    errors,
  }
}
