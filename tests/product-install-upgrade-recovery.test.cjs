const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')
const { runInstallUpgradeRecovery } = require('../scripts/run-install-upgrade-recovery.cjs')

const ROOT = path.resolve(__dirname, '..')
const { INSTALL_UPGRADE_RECOVERY_MATRIX, evaluateInstallUpgradeRecovery } = loadTsModule(
  'electron/installUpgradeRecoveryMatrix.ts',
)

function observation(contract, overrides = {}) {
  return {
    id: contract.id,
    detailCode: contract.detailCode,
    isolated: true,
    authoritativeDataPreserved: true,
    recoverable: true,
    privacySafe: true,
    ...overrides,
  }
}

test('VAL-420 clean install, legacy upgrade, rollback, retention, and export fixtures pass', async () => {
  const report = await runInstallUpgradeRecovery({ writeArtifact: false })
  assert.equal(report.schema, 'siftory-install-upgrade-recovery/v1')
  assert.equal(report.ok, true, report.errors.join('\n'))
  assert.equal(report.expectedCount, 5)
  assert.equal(report.observedCount, 5)
  assert.deepEqual(
    report.cases.map((item) => item.id),
    [
      'clean-install',
      'legacy-upgrade',
      'index-migration-rollback',
      'uninstall-retention',
      'diagnostic-export',
    ],
  )
  assert.ok(report.cases.every((item) => item.ok))
  assert.doesNotMatch(JSON.stringify(report), /[A-Z]:\\|\\\\|\/Users\/|fixture-media/i)
})

test('lifecycle matrix rejects missing, duplicate, and weakened observations', () => {
  const clean = observation(INSTALL_UPGRADE_RECOVERY_MATRIX[0])
  const report = evaluateInstallUpgradeRecovery([
    clean,
    clean,
    observation(INSTALL_UPGRADE_RECOVERY_MATRIX[1], { authoritativeDataPreserved: false }),
  ])
  assert.equal(report.ok, false)
  assert.match(report.errors.join('\n'), /Duplicate lifecycle observation: clean-install/)
  assert.match(report.errors.join('\n'), /legacy-upgrade\.authoritativeDataPreserved/)
  assert.match(report.errors.join('\n'), /Missing lifecycle observation: diagnostic-export/)
})

test('verification is isolated from real profiles and locks release lifecycle wiring', () => {
  const runner = fs.readFileSync(
    path.join(ROOT, 'scripts', 'run-install-upgrade-recovery.cjs'),
    'utf8',
  )
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const lifecycle = fs.readFileSync(
    path.join(ROOT, 'docs', 'reference', '2026-08-12-upgrade-rollback-data-lifecycle.md'),
    'utf8',
  )

  assert.match(runner, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), TEMP_PREFIX\)\)/)
  assert.match(runner, /cleanupTemporaryRoot\(tempRoot\)/)
  assert.match(runner, /resolveStableUserDataPath/)
  assert.match(runner, /AssetLibraryDatabase/)
  assert.match(runner, /readCurrentAuthoritativeManifest/)
  assert.match(runner, /deleteAppDataOnUninstall === false/)
  assert.match(runner, /serializeProductHealthReport/)
  assert.match(runner, /commitPreparedPath/)
  assert.doesNotMatch(runner, /process\.env\.APPDATA|process\.env\.LOCALAPPDATA/)
  assert.match(
    packageJson.scripts['verify:install-upgrade-recovery'],
    /run-install-upgrade-recovery/,
  )
  assert.match(packageJson.scripts['test:productization'], /product-install-upgrade-recovery/)
  assert.match(lifecycle, /deleteAppDataOnUninstall=false/)
  assert.match(lifecycle, /失败不会改动现有 `CURRENT`/)
})
