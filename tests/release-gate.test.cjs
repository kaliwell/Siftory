const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  createReleaseSteps,
  expectedInstallerPath,
  executeReleaseGate,
  parseElectronRuntimeVersions,
  parseReleaseArgs,
  parseSigningCommand,
} = require('../scripts/release-gate.cjs')

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-release-gate-'))
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.2.3',
      build: { productName: 'Siftory', directories: { output: 'release' } },
    }),
  )
  return dir
}

function createClock() {
  let tick = 0
  return () => `2026-07-30T00:00:${String(tick++).padStart(2, '0')}.000Z`
}

function createSuccessfulRunner(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options })
    if (args.some((argument) => argument.endsWith('print-electron-runtime.cjs'))) {
      return {
        exitCode: 0,
        stdout:
          '[electron-runtime]{"electron":"42.8.0","chromium":"148.0.7778.280","node":"24.18.0","v8":"14.8.178.38"}',
      }
    }
    if (args.includes('sbom')) {
      return { exitCode: 0, stdout: '{"bomFormat":"CycloneDX"}' }
    }
    return { exitCode: 0, stdout: '' }
  }
}

test('release CLI requires one valid profile and rejects unknown arguments', () => {
  assert.deepEqual(parseReleaseArgs([], {}), { plan: false, profile: 'online' })
  assert.deepEqual(parseReleaseArgs(['--plan', '--profile=online'], {}), {
    plan: true,
    profile: 'online',
  })
  assert.throws(() => parseReleaseArgs(['--profile=invalid'], {}), /expected offline or online/)
  assert.throws(() => parseReleaseArgs(['--unknown'], {}), /Unknown release gate argument/)
  assert.throws(() => parseReleaseArgs(['--profile=online', '--profile=offline'], {}), /only once/)
})

test('release profile selection keeps CLI precedence and supports explicit offline builds', () => {
  assert.deepEqual(parseReleaseArgs([], { FLOATING_CLOCK_PACKAGE_PROFILE: 'offline' }), {
    plan: false,
    profile: 'offline',
  })
  for (const [argument, environment, expected] of [
    ['online', 'offline', 'online'],
    ['offline', 'online', 'offline'],
  ]) {
    assert.equal(
      parseReleaseArgs([`--profile=${argument}`], { FLOATING_CLOCK_PACKAGE_PROFILE: environment })
        .profile,
      expected,
    )
  }
})

test('installer lookup and release commands share the online default without excluding offline', () => {
  const dir = createFixture()
  try {
    assert.equal(path.basename(expectedInstallerPath(dir)), 'Siftory Online Setup 1.2.3.exe')
    assert.equal(path.basename(expectedInstallerPath(dir, 'offline')), 'Siftory Setup 1.2.3.exe')
    for (const [overrides, profile] of [
      [{ env: {} }, 'online'],
      [{ env: { FLOATING_CLOCK_PACKAGE_PROFILE: 'offline' } }, 'offline'],
      [{ profile: 'online', env: { FLOATING_CLOCK_PACKAGE_PROFILE: 'offline' } }, 'online'],
      [{ profile: 'offline', env: { FLOATING_CLOCK_PACKAGE_PROFILE: 'online' } }, 'offline'],
    ]) {
      const steps = createReleaseSteps({
        projectDir: dir,
        npm: { command: 'node', prefixArgs: ['npm-cli.js'] },
        installerPath: expectedInstallerPath(dir, profile),
        sbomPath: path.join(dir, 'sbom.json'),
        ...overrides,
      })
      assert.ok(
        steps.find((step) => step.id === 'package').command.args.includes(`build:${profile}`),
      )
      for (const id of [
        'runtime-resources',
        'license-compliance',
        'commercial-readiness',
        'cleanup',
      ]) {
        assert.ok(
          steps.find((step) => step.id === id).command.args.includes(`--profile=${profile}`),
        )
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('online profile reaches every release command and selects the online installer', () => {
  const dir = createFixture()
  try {
    const installerPath = expectedInstallerPath(dir, 'online')
    assert.equal(path.basename(installerPath), 'Siftory Online Setup 1.2.3.exe')
    const steps = createReleaseSteps({
      projectDir: dir,
      profile: 'online',
      env: {},
      npm: { command: 'node', prefixArgs: ['npm-cli.js'] },
      runCommand: () => ({ exitCode: 0 }),
      installerPath,
      sbomPath: path.join(dir, 'sbom.json'),
    })
    const commandFor = (id) => steps.find((step) => step.id === id).command
    assert.ok(commandFor('runtime-resources').args.includes('--profile=online'))
    assert.ok(commandFor('license-compliance').args.includes('--profile=online'))
    assert.ok(commandFor('package').args.includes('build:online'))
    assert.ok(commandFor('packaged-matrix').args.includes('--profile=online'))
    assert.ok(commandFor('packaged-matrix').args.includes('--skip-build'))
    assert.ok(commandFor('installer-archive-smoke').args.includes('--profile=online'))
    assert.ok(commandFor('commercial-readiness').args.includes('--profile=online'))
    assert.ok(commandFor('commercial-readiness').args.includes('--json'))
    assert.ok(commandFor('cleanup').args.includes('--profile=online'))
    assert.equal(commandFor('package').env.FLOATING_CLOCK_PACKAGE_PROFILE, 'online')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('release gate uses the fixed documented order and retains win-unpacked during build', () => {
  const steps = createReleaseSteps({
    projectDir: 'C:\\fixture',
    env: {},
    npm: { command: 'node', prefixArgs: ['npm-cli.js'] },
    runCommand: () => ({ exitCode: 0 }),
    installerPath: 'C:\\fixture\\release\\installer.exe',
    sbomPath: 'C:\\fixture\\artifacts\\sbom.json',
  })
  assert.deepEqual(
    steps.map((step) => step.id),
    [
      'clean-install',
      'git-preflight',
      'verify',
      'runtime-resources',
      'license-compliance',
      'production-audit',
      'neko-accuracy-gate',
      'package',
      'packaged-matrix',
      'installer-archive-smoke',
      'commercial-readiness',
      'sign-installer',
      'verify-signature',
      'release-evidence',
      'cleanup',
    ],
  )
  const build = steps.find((step) => step.id === 'package')
  assert.equal(build.command.env.FLOATING_CLOCK_KEEP_UNPACKED, '1')
  assert.ok(
    steps
      .find((step) => step.id === 'verify')
      .commands.some((command) => command.args.includes('coverage:critical')),
  )
  assert.equal(steps.at(-1).id, 'cleanup')
})

test('release gate stops at the first failure and never creates a success record', () => {
  const dir = createFixture()
  try {
    const calls = []
    const runner = (command, args, options) => {
      calls.push({ command, args, options })
      if (args.includes('audit')) return { exitCode: 1, stderr: 'vulnerabilities found' }
      return { exitCode: 0, stdout: '' }
    }
    const result = executeReleaseGate({
      projectDir: dir,
      artifactDir: path.join(dir, 'evidence'),
      runId: 'failed-run',
      commit: 'a'.repeat(40),
      env: { FLOATING_CLOCK_SIGN_COMMAND_JSON: '["signtool.exe","sign"]' },
      npm: { command: 'node', prefixArgs: ['npm-cli.js'] },
      runCommand: runner,
      now: createClock(),
    })
    assert.equal(result.ok, false)
    assert.equal(result.report.failedStep, 'production-audit')
    assert.deepEqual(
      result.report.steps.map((step) => step.id),
      [
        'clean-install',
        'git-preflight',
        'verify',
        'runtime-resources',
        'license-compliance',
        'production-audit',
      ],
    )
    assert.equal(fs.existsSync(path.join(dir, 'evidence', 'release-record.json')), false)
    assert.equal(
      calls.some((call) => call.args.includes('benchmark:neko-search:accuracy')),
      false,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('commercial readiness failure stops before signing and cannot create a release record', () => {
  const dir = createFixture()
  try {
    const calls = []
    const runner = (command, args) => {
      calls.push({ command, args })
      if (args.includes('release:readiness')) {
        return { exitCode: 1, stderr: 'commercial readiness is blocked' }
      }
      return { exitCode: 0, stdout: '' }
    }
    const result = executeReleaseGate({
      projectDir: dir,
      artifactDir: path.join(dir, 'evidence'),
      runId: 'readiness-blocked',
      commit: 'f'.repeat(40),
      env: { FLOATING_CLOCK_SIGN_COMMAND_JSON: '["signtool.exe","sign"]' },
      npm: { command: 'node', prefixArgs: ['npm-cli.js'] },
      runCommand: runner,
      now: createClock(),
    })
    assert.equal(result.ok, false)
    assert.equal(result.report.failedStep, 'commercial-readiness')
    assert.equal(
      calls.some((call) => call.command === 'signtool.exe'),
      false,
    )
    assert.equal(
      result.report.steps.some((step) => step.id === 'release-evidence'),
      false,
    )
    assert.equal(fs.existsSync(path.join(dir, 'evidence', 'release-record.json')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('release gate stops at unresolved license decisions before packaging', () => {
  const dir = createFixture()
  try {
    const runner = (command, args) => {
      if (args.includes('licenses:gate')) {
        return { exitCode: 1, stderr: 'project license decision is not approved' }
      }
      return { exitCode: 0, stdout: '' }
    }
    const result = executeReleaseGate({
      projectDir: dir,
      artifactDir: path.join(dir, 'evidence'),
      runId: 'license-blocked',
      commit: 'e'.repeat(40),
      env: { FLOATING_CLOCK_SIGN_COMMAND_JSON: '["signtool.exe","sign"]' },
      npm: { command: 'node', prefixArgs: ['npm-cli.js'] },
      runCommand: runner,
      now: createClock(),
    })
    assert.equal(result.ok, false)
    assert.equal(result.report.failedStep, 'license-compliance')
    assert.equal(
      result.report.steps.some((step) => step.id === 'package'),
      false,
    )
    assert.equal(fs.existsSync(path.join(dir, 'evidence', 'release-record.json')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('release gate blocks a dirty worktree before engineering verification', () => {
  const dir = createFixture()
  try {
    const runner = (command, args) => {
      if (args.includes('--porcelain')) {
        return { exitCode: 0, stdout: '?? local-only.txt\n' }
      }
      return { exitCode: 0, stdout: '' }
    }
    const result = executeReleaseGate({
      projectDir: dir,
      artifactDir: path.join(dir, 'evidence'),
      runId: 'dirty-run',
      commit: 'd'.repeat(40),
      env: { FLOATING_CLOCK_SIGN_COMMAND_JSON: '["signtool.exe","sign"]' },
      npm: { command: 'node', prefixArgs: ['npm-cli.js'] },
      runCommand: runner,
      now: createClock(),
    })
    assert.equal(result.ok, false)
    assert.equal(result.report.failedStep, 'git-preflight')
    assert.match(result.report.steps.at(-1).error, /local-only\.txt/)
    assert.equal(
      result.report.steps.some((step) => step.id === 'verify'),
      false,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('release record becomes successful only after cleanup passes', () => {
  const dir = createFixture()
  try {
    const releaseDir = path.join(dir, 'release')
    fs.mkdirSync(releaseDir)
    fs.writeFileSync(path.join(releaseDir, 'Siftory Online Setup 1.2.3.exe'), 'installer')
    const calls = []
    const result = executeReleaseGate({
      projectDir: dir,
      artifactDir: path.join(dir, 'evidence'),
      runId: 'successful-run',
      commit: 'b'.repeat(40),
      env: { FLOATING_CLOCK_SIGN_COMMAND_JSON: '["signtool.exe","sign"]' },
      npm: { command: 'node', prefixArgs: ['npm-cli.js'] },
      electronExecutable: 'electron.exe',
      runCommand: createSuccessfulRunner(calls),
      now: createClock(),
    })
    assert.equal(result.ok, true)
    const record = JSON.parse(fs.readFileSync(result.releaseRecordPath, 'utf8'))
    assert.equal(record.status, 'passed')
    assert.equal(record.profile, 'online')
    assert.deepEqual(record.runtimeVersions, {
      electron: '42.8.0',
      chromium: '148.0.7778.280',
      node: '24.18.0',
      v8: '14.8.178.38',
    })
    assert.match(record.artifactHashes.installer.sha256, /^[A-F0-9]{64}$/)
    assert.match(record.artifactHashes.sbom.sha256, /^[A-F0-9]{64}$/)
    const cleanupIndex = calls.findIndex((call) => call.args.includes('release:clean'))
    const sbomIndex = calls.findIndex((call) => call.args.includes('sbom'))
    assert.ok(cleanupIndex > sbomIndex)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a cleanup failure marks the draft release record failed', () => {
  const dir = createFixture()
  try {
    const releaseDir = path.join(dir, 'release')
    fs.mkdirSync(releaseDir)
    fs.writeFileSync(path.join(releaseDir, 'Siftory Online Setup 1.2.3.exe'), 'installer')
    const runner = (command, args) => {
      if (args.some((argument) => argument.endsWith('print-electron-runtime.cjs'))) {
        return {
          exitCode: 0,
          stdout:
            '[electron-runtime]{"electron":"42.8.0","chromium":"148.0.7778.280","node":"24.18.0","v8":"14.8.178.38"}',
        }
      }
      if (args.includes('sbom')) {
        return { exitCode: 0, stdout: '{"bomFormat":"CycloneDX"}' }
      }
      if (args.includes('release:clean')) return { exitCode: 7, stderr: 'cleanup failed' }
      return { exitCode: 0, stdout: '' }
    }
    const result = executeReleaseGate({
      projectDir: dir,
      artifactDir: path.join(dir, 'evidence'),
      runId: 'cleanup-failed',
      commit: 'c'.repeat(40),
      env: { FLOATING_CLOCK_SIGN_COMMAND_JSON: '["signtool.exe","sign"]' },
      npm: { command: 'node', prefixArgs: ['npm-cli.js'] },
      electronExecutable: 'electron.exe',
      runCommand: runner,
      now: createClock(),
    })
    assert.equal(result.ok, false)
    assert.equal(result.report.failedStep, 'cleanup')
    const record = JSON.parse(
      fs.readFileSync(path.join(dir, 'evidence', 'release-record.json'), 'utf8'),
    )
    assert.equal(record.status, 'failed')
    assert.equal(record.failedStep, 'cleanup')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('signing command requires an explicit JSON array', () => {
  assert.throws(() => parseSigningCommand({}), /Signing is not configured/)
  assert.throws(
    () => parseSigningCommand({ FLOATING_CLOCK_SIGN_COMMAND_JSON: '{"command":"signtool"}' }),
    /non-empty JSON array/,
  )
  assert.deepEqual(
    parseSigningCommand({
      FLOATING_CLOCK_SIGN_COMMAND_JSON: '["signtool.exe","sign","installer.exe"]',
    }),
    { command: 'signtool.exe', args: ['sign', 'installer.exe'] },
  )
})

test('signing step expands the installer token without recording sensitive arguments', () => {
  const steps = createReleaseSteps({
    projectDir: 'C:\\fixture',
    env: {
      FLOATING_CLOCK_SIGN_COMMAND_JSON:
        '["signtool.exe","sign","/sha1","certificate-thumbprint","{installer}"]',
    },
    npm: { command: 'node', prefixArgs: ['npm-cli.js'] },
    runCommand: () => ({ exitCode: 0 }),
    installerPath: 'C:\\fixture\\release\\Siftory Setup 1.2.3.exe',
    sbomPath: 'C:\\fixture\\artifacts\\sbom.json',
  })
  const signing = steps.find((step) => step.id === 'sign-installer')
  assert.equal(signing.redactCommand, true)
  assert.deepEqual(signing.resolveCommand().args.at(-1), signing.artifactPaths.installer)
})

test('Electron runtime probe requires all release-record versions', () => {
  assert.deepEqual(
    parseElectronRuntimeVersions(
      'noise\n[electron-runtime]{"electron":"42.8.0","chromium":"148","node":"24.18.0","v8":"14.8"}\n',
    ),
    { electron: '42.8.0', chromium: '148', node: '24.18.0', v8: '14.8' },
  )
  assert.throws(
    () => parseElectronRuntimeVersions('[electron-runtime]{"electron":"42.8.0"}'),
    /omitted chromium/,
  )
})
