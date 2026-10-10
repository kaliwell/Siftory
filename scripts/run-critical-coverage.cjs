const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')
const baselinePath = path.join(projectRoot, 'coverage', 'critical-baseline.json')
const reportPath = path.join(projectRoot, 'artifacts', 'coverage', 'critical-summary.json')

const sourceFiles = [
  'electron/pathGuards.ts',
  'electron/ipcValidation.ts',
  'electron/jsonLinesTransaction.ts',
  'electron/assetMetadataTransaction.ts',
  'electron/assetLibraryBackup.ts',
  'electron/vectorGcService.ts',
  'src/i18n/core.ts',
  'scripts/check-commercial-release-readiness.cjs',
  'scripts/check-license-compliance.cjs',
  'scripts/check-post-audit-build-optimization.cjs',
  'scripts/generate-node-third-party-components.cjs',
  'scripts/release-gate.cjs',
  'scripts/fetch-runtime-resources.cjs',
  'scripts/reproducible-build.cjs',
]

const testFiles = [
  'tests/guards.test.cjs',
  'tests/ipc-validation.test.cjs',
  'tests/transaction-fault-injection.test.cjs',
  'tests/asset-library-backup-portable.test.cjs',
  'tests/vector-gc.test.cjs',
  'tests/i18n.test.cjs',
  'tests/commercial-release-readiness.test.cjs',
  'tests/license-compliance.test.cjs',
  'tests/license-materials.test.cjs',
  'tests/post-audit-optimization-todo.test.cjs',
  'tests/release-gate.test.cjs',
  'tests/runtime-resource-fetch.test.cjs',
  'tests/reproducible-build.test.cjs',
]

function parseCoverageTable(output) {
  const entries = new Map()
  const rowPattern = /^\s*(.+?)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/
  for (const line of output.split(/\r?\n/)) {
    const match = line.replace(/^\s*ℹ\s*/, '').match(rowPattern)
    if (!match) continue
    entries.set(match[1].trim(), {
      lines: Number(match[2]),
      branches: Number(match[3]),
      functions: Number(match[4]),
    })
  }
  return entries
}

function evaluateCoverage(entries, baseline) {
  const failures = []
  const actual = {}
  for (const [name, minimums] of Object.entries({
    'all files': baseline.aggregate,
    ...baseline.files,
  })) {
    const measured = entries.get(name)
    if (!measured) {
      failures.push(`${name}: missing from coverage report`)
      continue
    }
    actual[name] = measured
    for (const metric of ['lines', 'branches', 'functions']) {
      if (measured[metric] < minimums[metric]) {
        failures.push(`${name} ${metric}: ${measured[metric]} < ${minimums[metric]}`)
      }
    }
  }
  return { actual, failures }
}

function main() {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  const args = [
    '--test',
    '--experimental-test-coverage',
    ...sourceFiles.map((source) => `--test-coverage-include=${source}`),
    ...testFiles,
  ]
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  const evaluation = evaluateCoverage(parseCoverageTable(result.stdout || ''), baseline)
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        node: process.version,
        baseline,
        actual: evaluation.actual,
        failures: evaluation.failures,
        testsPassed: result.status === 0,
        ok: result.status === 0 && evaluation.failures.length === 0,
      },
      null,
      2,
    )}\n`,
  )
  if (result.status !== 0 || evaluation.failures.length > 0) {
    for (const failure of evaluation.failures) console.error(`[coverage] ${failure}`)
    process.exitCode = result.status || 1
  }
}

if (require.main === module) main()

module.exports = { evaluateCoverage, parseCoverageTable, sourceFiles, testFiles }
