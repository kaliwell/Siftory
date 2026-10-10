'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('../tests/guard-utils.cjs')
const packageJson = require('../package.json')
const { createBuilderConfig } = require('./package-profile.cjs')

const ROOT = path.resolve(__dirname, '..')
const TEMP_PREFIX = 'siftory-install-upgrade-recovery-'
const DEFAULT_REPORT_PATH = path.join(ROOT, 'artifacts', 'install-upgrade-recovery', 'report.json')

const { evaluateInstallUpgradeRecovery, INSTALL_UPGRADE_RECOVERY_MATRIX } = loadTsModule(
  'electron/installUpgradeRecoveryMatrix.ts',
)
const { resolveStableUserDataPath, LEGACY_USER_DATA_DIRECTORY } = loadTsModule(
  'electron/startupSecurity.ts',
)
const { readJSON, writeJSON } = loadTsModule('electron/settingsStore.ts')
const { AssetLibraryDatabase } = loadTsModule('electron/assetLibraryDatabase.ts')
const vectorMigration = loadTsModule('electron/vectorStoreMigrationService.ts')
const vectorStore = loadTsModule('electron/authoritativeVectorStore.ts')
const annWorker = loadTsModule('electron/vectorAnnWorkerHost.ts')
const { buildProductHealthReport, findUnsafeProductHealthFields, serializeProductHealthReport } =
  loadTsModule('electron/productHealthReport.ts')
const { commitPreparedPath, createPreparedSiblingPath } = loadTsModule(
  'electron/localFileTransaction.ts',
)

function ensure(condition, message) {
  if (!condition) throw new Error(message)
}

function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function observation(id, detailCode) {
  return {
    id,
    detailCode,
    isolated: true,
    authoritativeDataPreserved: true,
    recoverable: true,
    privacySafe: true,
  }
}

function failedObservation(contract) {
  return {
    id: contract.id,
    detailCode: contract.detailCode,
    isolated: false,
    authoritativeDataPreserved: false,
    recoverable: false,
    privacySafe: false,
  }
}

function cleanupTemporaryRoot(tempRoot) {
  const resolved = path.resolve(tempRoot)
  const tempDirectory = path.resolve(os.tmpdir())
  ensure(path.dirname(resolved) === tempDirectory, 'refusing to clean a non-temporary fixture root')
  ensure(path.basename(resolved).startsWith(TEMP_PREFIX), 'unexpected fixture root name')
  fs.rmSync(resolved, { recursive: true, force: true })
}

function validCategory() {
  return {
    id: 1,
    name: 'Legacy category',
    description: 'Preserved during upgrade',
    parentId: null,
    color: '#336699',
    icon: 'archive',
    sortOrder: 1,
    referenceThreshold: 0.8,
    sourceClusterGroupId: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
}

function vectorRow(imageId, vector, modelName) {
  return JSON.stringify({
    modelName,
    embeddingType: 'global',
    imageId,
    dim: vector.length,
    vector,
  })
}

function vectorSourceOptions(userDataPath, sourcePath, modelName) {
  return {
    cacheDir: path.join(userDataPath, 'vector-db', 'embedding-cache'),
    modelName,
    embeddingType: 'global',
    dim: 3,
    sourcePaths: [sourcePath],
  }
}

async function waitForVectorMigration() {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const progress = vectorMigration.getVectorStoreMigrationProgress()
    if (progress.state !== 'running') return progress
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('vector migration fixture timed out')
}

async function verifyCleanInstall(tempRoot) {
  const appDataPath = path.join(tempRoot, 'clean-install', 'Roaming')
  const userDataPath = resolveStableUserDataPath(appDataPath)
  ensure(within(tempRoot, userDataPath), 'clean profile escaped the fixture root')
  ensure(
    path.basename(userDataPath) === LEGACY_USER_DATA_DIRECTORY,
    'stable data directory changed',
  )
  ensure(!fs.existsSync(userDataPath), 'clean fixture unexpectedly contains user data')

  fs.mkdirSync(userDataPath, { recursive: true })
  const settingsPath = path.join(userDataPath, 'floating_clock_settings.json')
  writeJSON(settingsPath, { language: 'zh-CN', theme: 0 })
  ensure(
    JSON.stringify(readJSON(settingsPath)) === JSON.stringify({ language: 'zh-CN', theme: 0 }),
    'clean settings did not round-trip',
  )
  ensure(!fs.existsSync(`${settingsPath}.tmp`), 'atomic settings staging file was left behind')

  const database = new AssetLibraryDatabase(path.join(userDataPath, 'asset-library'))
  try {
    database.open()
    const counts = database.counts()
    ensure(
      Object.values(counts).every((count) => count === 0),
      'clean metadata database is not empty',
    )
  } finally {
    database.close()
  }
  return observation('clean-install', 'isolated-profile-initialized')
}

async function verifyLegacyUpgrade(tempRoot) {
  const appDataPath = path.join(tempRoot, 'legacy-upgrade', 'Roaming')
  const userDataPath = resolveStableUserDataPath(appDataPath)
  const assetLibraryPath = path.join(userDataPath, 'asset-library')
  ensure(within(tempRoot, assetLibraryPath), 'legacy profile escaped the fixture root')
  fs.mkdirSync(assetLibraryPath, { recursive: true })

  const settingsPath = path.join(userDataPath, 'floating_clock_settings.json')
  const legacySettings = {
    language: 'zh-CN',
    theme: 3,
    imageSearchScanPaths: ['D:\\fixture-media'],
    legacyUnknownSetting: 'preserve-me',
  }
  writeJSON(settingsPath, legacySettings)
  const categoryPath = path.join(assetLibraryPath, 'categories.jsonl')
  const categorySource = `${JSON.stringify(validCategory())}\n`
  fs.writeFileSync(categoryPath, categorySource, 'utf8')

  const database = new AssetLibraryDatabase(assetLibraryPath)
  try {
    database.open()
    const migrated = database.importFromJsonl()
    ensure(migrated.skipped === false, 'legacy JSONL import was unexpectedly skipped')
    ensure(migrated.counts.categories === 1, 'legacy category was not imported')
    ensure(database.listCategories()[0]?.name === 'Legacy category', 'legacy metadata changed')
    ensure(database.verifyAgainstJsonl().ok === true, 'legacy import hash verification failed')
  } finally {
    database.close()
  }

  const existing = readJSON(settingsPath)
  ensure(existing && typeof existing === 'object', 'legacy settings could not be read')
  writeJSON(settingsPath, { ...existing, panelSizeDefaultsVersion: 2 })
  const upgraded = readJSON(settingsPath)
  ensure(upgraded.legacyUnknownSetting === 'preserve-me', 'unknown legacy setting was discarded')
  ensure(
    upgraded.imageSearchScanPaths[0] === 'D:\\fixture-media',
    'legacy source path was discarded',
  )
  ensure(
    fs.readFileSync(categoryPath, 'utf8') === categorySource,
    'legacy JSONL source was modified',
  )
  return observation('legacy-upgrade', 'legacy-metadata-preserved')
}

async function verifyIndexMigrationRollback(tempRoot) {
  vectorMigration.resetVectorStoreMigrationForTests()
  const userDataPath = path.join(tempRoot, 'index-migration-rollback', 'user-data')
  const embeddingsPath = path.join(userDataPath, 'vector-db', 'embeddings')
  fs.mkdirSync(embeddingsPath, { recursive: true })
  const dinoSource = path.join(embeddingsPath, 'dinov2_vitb14__global.jsonl')
  fs.writeFileSync(
    dinoSource,
    vectorRow('C:\\fixture-media\\first.jpg', [1, 0, 0], 'dinov2_vitb14'),
    'utf8',
  )

  let preview = vectorMigration.createVectorStoreMigrationPreview(userDataPath, [
    vectorSourceOptions(userDataPath, dinoSource, 'dinov2_vitb14'),
  ])
  ensure(
    vectorMigration.startVectorStoreMigration(userDataPath, preview.token).ok,
    'baseline migration did not start',
  )
  const baseline = await waitForVectorMigration()
  ensure(baseline.state === 'completed', 'baseline migration did not complete')

  const storeRoot = path.join(userDataPath, 'vector-db', 'vector-store')
  const currentPath = path.join(storeRoot, 'CURRENT')
  const currentBefore = fs.readFileSync(currentPath)
  const manifestBefore = vectorStore.readCurrentAuthoritativeManifest(storeRoot, true)
  ensure(manifestBefore, 'baseline CURRENT is unreadable')

  fs.appendFileSync(
    dinoSource,
    `\n${vectorRow('C:\\fixture-media\\second.jpg', [0, 1, 0], 'dinov2_vitb14')}`,
  )
  const changedAt = new Date(Date.now() + 2_000)
  fs.utimesSync(dinoSource, changedAt, changedAt)
  preview = vectorMigration.createVectorStoreMigrationPreview(userDataPath, [
    {
      ...vectorSourceOptions(userDataPath, dinoSource, 'dinov2_vitb14'),
      isCancelled: () => {
        throw new Error('deterministic migration failure fixture')
      },
    },
  ])
  ensure(
    vectorMigration.startVectorStoreMigration(userDataPath, preview.token).ok,
    'failure migration did not start',
  )
  const failed = await waitForVectorMigration()
  ensure(failed.state === 'error', 'injected migration failure did not fail closed')
  ensure(
    Buffer.compare(fs.readFileSync(currentPath), currentBefore) === 0,
    'CURRENT changed after failed migration',
  )
  ensure(
    vectorStore.readCurrentAuthoritativeManifest(storeRoot, true)?.generation ===
      manifestBefore.generation,
    'active generation changed after rollback',
  )
  const generationNames = fs.readdirSync(path.join(storeRoot, 'generations'))
  ensure(
    generationNames.every((name) => !name.startsWith('.')),
    'staging generation survived rollback',
  )
  vectorMigration.resetVectorStoreMigrationForTests()
  annWorker.disposeVectorAnnWorker()
  return observation('index-migration-rollback', 'current-generation-preserved')
}

async function verifyUninstallRetention(tempRoot) {
  const lifecycleRoot = path.join(tempRoot, 'uninstall-retention')
  const installRoot = path.join(lifecycleRoot, 'installed-application')
  const userDataPath = path.join(lifecycleRoot, 'Roaming', LEGACY_USER_DATA_DIRECTORY)
  fs.mkdirSync(installRoot, { recursive: true })
  fs.mkdirSync(userDataPath, { recursive: true })
  fs.writeFileSync(path.join(installRoot, 'Siftory.exe'), 'fixture-binary', 'utf8')
  fs.writeFileSync(path.join(userDataPath, 'retained-user-data.json'), '{"keep":true}', 'utf8')

  for (const profile of ['online', 'offline']) {
    const config = createBuilderConfig(packageJson, profile, path.join(lifecycleRoot, profile))
    ensure(config.nsis.deleteAppDataOnUninstall === false, `${profile} installer deletes user data`)
    ensure(config.nsis.perMachine === false, `${profile} installer unexpectedly changed scope`)
  }

  ensure(within(tempRoot, installRoot), 'install fixture escaped the temporary root')
  fs.rmSync(installRoot, { recursive: true, force: true })
  ensure(!fs.existsSync(installRoot), 'simulated application removal did not complete')
  ensure(
    fs.existsSync(path.join(userDataPath, 'retained-user-data.json')),
    'user data was removed with application files',
  )
  return observation('uninstall-retention', 'user-data-retained')
}

async function verifyDiagnosticExport(tempRoot) {
  const exportRoot = path.join(tempRoot, 'diagnostic-export')
  fs.mkdirSync(exportRoot, { recursive: true })
  const report = buildProductHealthReport({
    generatedAt: 1_786_000_000_000,
    appVersion: '1.0.0',
    platform: 'win32',
    architecture: 'x64',
    sources: [{ availability: 'offline' }],
    vector: { status: 'index-stale' },
    models: [{ state: 'verified' }, { state: 'not-installed' }],
    scheduler: {
      failed: 0,
      queued: 1,
      running: 0,
      backgroundPaused: false,
      pressureReasonCount: 0,
    },
    storage: { freeBytes: 8 * 1024 * 1024 * 1024, minimumFreeBytes: 1024 * 1024 * 1024 },
  })
  ensure(
    findUnsafeProductHealthFields(report).length === 0,
    'diagnostic report is not privacy-safe',
  )
  const payload = serializeProductHealthReport(report)
  const finalPath = path.join(exportRoot, 'siftory-health-report.json')
  const preparedPath = createPreparedSiblingPath(finalPath)
  fs.writeFileSync(preparedPath, payload, { encoding: 'utf8', flag: 'wx' })
  await commitPreparedPath(preparedPath, finalPath)
  const exported = fs.readFileSync(finalPath, 'utf8')
  ensure(
    JSON.parse(exported).schema === 'siftory-product-health/v1',
    'diagnostic export schema changed',
  )
  ensure(!exported.includes(tempRoot), 'diagnostic export leaked its absolute fixture path')
  ensure(
    !fs
      .readdirSync(exportRoot)
      .some((name) => name.endsWith('.part') || name.endsWith('.transaction.json')),
    'diagnostic transaction artifacts remain',
  )
  return observation('diagnostic-export', 'redacted-report-committed')
}

const CASE_RUNNERS = new Map([
  ['clean-install', verifyCleanInstall],
  ['legacy-upgrade', verifyLegacyUpgrade],
  ['index-migration-rollback', verifyIndexMigrationRollback],
  ['uninstall-retention', verifyUninstallRetention],
  ['diagnostic-export', verifyDiagnosticExport],
])

async function runInstallUpgradeRecovery(options = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX))
  const observations = []
  try {
    for (const contract of INSTALL_UPGRADE_RECOVERY_MATRIX) {
      try {
        observations.push(await CASE_RUNNERS.get(contract.id)(tempRoot))
      } catch {
        observations.push(failedObservation(contract))
      }
    }
  } finally {
    vectorMigration.resetVectorStoreMigrationForTests()
    annWorker.disposeVectorAnnWorker()
    cleanupTemporaryRoot(tempRoot)
  }

  const report = evaluateInstallUpgradeRecovery(observations)
  if (options.writeArtifact !== false) {
    const reportPath = path.resolve(options.reportPath || DEFAULT_REPORT_PATH)
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    const preparedPath = `${reportPath}.tmp-${process.pid}`
    fs.writeFileSync(preparedPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'w',
    })
    fs.renameSync(preparedPath, reportPath)
  }
  return report
}

if (require.main === module) {
  runInstallUpgradeRecovery()
    .then((report) => {
      console.log(JSON.stringify(report, null, 2))
      if (!report.ok) process.exitCode = 1
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}

module.exports = {
  DEFAULT_REPORT_PATH,
  runInstallUpgradeRecovery,
}
