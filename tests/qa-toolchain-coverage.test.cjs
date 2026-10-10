const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  normalizeVersion,
  readActualNpmVersion,
  readToolchainContract,
  validateToolchainContract,
} = require('../scripts/check-toolchain.cjs')
const {
  evaluateCoverage,
  parseCoverageTable,
  sourceFiles,
  testFiles,
} = require('../scripts/run-critical-coverage.cjs')

const projectRoot = path.resolve(__dirname, '..')

const FOUNDATION_SPECIALTY_TESTS = [
  'tests/product-foundation-auto-todo.test.cjs',
  'tests/fixed-hardware-performance-baseline.test.cjs',
  'tests/fixed-hardware-baseline-ledger.test.cjs',
  'tests/fixed-hardware-baseline-evidence.test.cjs',
  'tests/fixed-hardware-user-data-proof.test.cjs',
  'tests/image-search-simple-e2e-provenance.test.cjs',
  'tests/model-service-required-files.test.cjs',
  'tests/asset-library-database-records.test.cjs',
]

function collectReachablePackageScripts(scripts, roots) {
  const reachable = new Set()
  const pending = [...roots]
  const invocation = /\bnpm(?:\.cmd)?\s+(?:run\s+)?([A-Za-z0-9:_-]+)/g
  while (pending.length > 0) {
    const name = pending.pop()
    if (reachable.has(name) || typeof scripts[name] !== 'string') continue
    reachable.add(name)
    for (const match of scripts[name].matchAll(invocation)) {
      if (typeof scripts[match[1]] === 'string') pending.push(match[1])
    }
  }
  return reachable
}

test('toolchain metadata pins one exact Node and npm pair', () => {
  const contract = readToolchainContract(projectRoot)
  assert.match(contract.node, /^\d+\.\d+\.\d+$/)
  assert.match(contract.npm, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(validateToolchainContract(contract), [])
  assert.equal(normalizeVersion(`v${contract.node}`), contract.node)
  assert.equal(
    fs.readFileSync(path.join(projectRoot, '.npmrc'), 'utf8').trim(),
    'engine-strict=true',
  )
})

test('toolchain validator rejects runtime drift', () => {
  const contract = {
    node: '24.16.0',
    npm: '11.13.0',
    enginesNode: '24.16.0',
    enginesNpm: '11.13.0',
  }
  assert.deepEqual(validateToolchainContract(contract, { node: '24.15.0', npm: '11.13.0' }), [
    'Node 24.16.0 required, received 24.15.0',
  ])
})

test('toolchain checks the invoking npm CLI rather than a different Node-adjacent install', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-npm-identity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const cli = path.join(root, 'npm-cli.cjs')
  fs.writeFileSync(cli, "process.stdout.write('12.0.2\\n')\n")
  const actual = readActualNpmVersion({ npm_execpath: cli })
  assert.equal(actual, '12.0.2')
  const contract = readToolchainContract(projectRoot)
  assert.deepEqual(validateToolchainContract(contract, { node: contract.node, npm: actual }), [
    `npm ${contract.npm} required, received 12.0.2`,
  ])
  assert.throws(
    () => readActualNpmVersion({ npm_execpath: path.join(root, 'missing.cjs') }),
    /Cannot find module|Unable to read npm version/,
  )
})

test('coverage parser and evaluator reject a critical-file regression', () => {
  const entries = parseCoverageTable(
    'ℹ  ipcValidation.ts | 98.59 | 79.07 | 100.00 | 48\nℹ all files | 82.30 | 70.86 | 82.67 |',
  )
  const passing = evaluateCoverage(entries, {
    aggregate: { lines: 81, branches: 69, functions: 81 },
    files: { 'ipcValidation.ts': { lines: 97, branches: 78, functions: 99 } },
  })
  assert.deepEqual(passing.failures, [])
  entries.get('ipcValidation.ts').branches = 70
  assert.deepEqual(
    evaluateCoverage(entries, {
      aggregate: { lines: 81, branches: 69, functions: 81 },
      files: { 'ipcValidation.ts': { lines: 97, branches: 78, functions: 99 } },
    }).failures,
    ['ipcValidation.ts branches: 70 < 78'],
  )
})

test('coverage scope contains every planned critical domain', () => {
  for (const expected of [
    'pathGuards.ts',
    'ipcValidation.ts',
    'jsonLinesTransaction.ts',
    'assetLibraryBackup.ts',
    'vectorGcService.ts',
    'i18n/core.ts',
    'check-commercial-release-readiness.cjs',
    'check-license-compliance.cjs',
    'check-post-audit-build-optimization.cjs',
    'generate-node-third-party-components.cjs',
    'release-gate.cjs',
  ]) {
    assert.ok(
      sourceFiles.some((source) => source.endsWith(expected)),
      expected,
    )
  }
  assert.ok(testFiles.includes('tests/transaction-fault-injection.test.cjs'))
})

test('every Node test file is reachable from the package test commands', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const scripts = packageJson.scripts || {}
  const reachable = collectReachablePackageScripts(scripts, ['test'])
  const commands = [...reachable].map((name) => scripts[name]).join('\n')
  const unreferenced = fs
    .readdirSync(path.join(projectRoot, 'tests'))
    .filter((name) => name.endsWith('.test.cjs'))
    .filter((name) => !commands.includes(`tests/${name}`))

  assert.deepEqual(unreferenced, [])
  assert.ok(collectReachablePackageScripts(scripts, ['verify']).has('test'))
  assert.ok(collectReachablePackageScripts(scripts, ['ci:verify']).has('verify'))
})

test('foundation automation reaches every new specialty test before the real baseline', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const scripts = packageJson.scripts || {}
  const foundationTests = scripts['test:foundation-automation']
  assert.equal(typeof foundationTests, 'string')
  for (const testFile of FOUNDATION_SPECIALTY_TESTS) {
    assert.equal(fs.existsSync(path.join(projectRoot, testFile)), true, `${testFile} must exist`)
    assert.ok(
      foundationTests.includes(testFile),
      `${testFile} must be in test:foundation-automation`,
    )
  }

  const foundationAuto = scripts['todo:foundation-auto']
  assert.equal(typeof foundationAuto, 'string')
  assert.match(
    foundationAuto,
    /npm run build:renderer\s*&&\s*npm run automation:performance-baseline/,
    'todo:foundation-auto must build the renderer immediately before the real baseline',
  )

  const fromTest = collectReachablePackageScripts(scripts, ['test'])
  assert.ok(fromTest.has('test:foundation-automation'))
})

test('audio child smoke creates a disposable default input when no video is supplied', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'scripts', 'run-audio-semantic-child-smoke.cjs'),
    'utf8',
  )
  assert.match(source, /process\.argv\[2\][^\n]*createSyntheticInput\(\)/)
  assert.match(source, /floating-clock-audio-input-/)
  assert.match(source, /cleanupOwnedInput\(\)/)
})

test('CI workflows separate fixture PR checks from controlled release resources', () => {
  const ci = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
  const controlled = fs.readFileSync(
    path.join(projectRoot, '.github', 'workflows', 'controlled-release.yml'),
    'utf8',
  )
  assert.match(ci, /windows-latest/)
  assert.match(ci, /npm run ci:verify/)
  assert.doesNotMatch(ci, /resources:fetch/)
  assert.match(controlled, /workflow_dispatch/)
  assert.match(controlled, /self-hosted/)
  assert.match(controlled, /FLOATING_CLOCK_PACKAGE_PROFILE/)
  assert.match(controlled, /resources:fetch[^\n]*--profile=/)
  assert.match(controlled, /resources:verify[^\n]*--profile=/)
  assert.match(controlled, /licenses:gate[^\n]*--profile=/)
  assert.match(controlled, /npm run ci:verify/)
  assert.match(controlled, /smoke:ui:packaged:locales/)
})
