const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { expectedInstallerName, normalizePackageProfile } = require('./package-profile.cjs')

const SUCCESS_STATUS = 'passed'
const FAILURE_STATUS = 'failed'

function isoNow() {
  return new Date().toISOString()
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024)
  try {
    let bytesRead = 0
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex').toUpperCase()
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temporaryPath, filePath)
}

function runProcess(command, args, options = {}) {
  const capture = options.capture === true
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: capture ? 'utf8' : undefined,
    maxBuffer: capture ? 64 * 1024 * 1024 : undefined,
    stdio: capture ? 'pipe' : 'inherit',
    shell: false,
  })
  return {
    exitCode: result.status ?? 1,
    error: result.error?.message,
    stdout: capture ? String(result.stdout || '') : '',
    stderr: capture ? String(result.stderr || '') : '',
  }
}

function resolveNpmInvocation(env = process.env) {
  if (!env.npm_execpath) {
    throw new Error('Missing npm_execpath. Run the gate through "npm run release:gate".')
  }
  return {
    command: process.execPath,
    prefixArgs: [env.npm_execpath],
  }
}

function parseSigningCommand(env = process.env) {
  const raw = env.FLOATING_CLOCK_SIGN_COMMAND_JSON?.trim()
  if (!raw) {
    throw new Error(
      'Signing is not configured. Set FLOATING_CLOCK_SIGN_COMMAND_JSON to a JSON array containing the signer executable and arguments.',
    )
  }
  let command
  try {
    command = JSON.parse(raw)
  } catch {
    throw new Error('FLOATING_CLOCK_SIGN_COMMAND_JSON must be valid JSON.')
  }
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((part) => typeof part !== 'string' || part.length === 0)
  ) {
    throw new Error('FLOATING_CLOCK_SIGN_COMMAND_JSON must be a non-empty JSON array of strings.')
  }
  return { command: command[0], args: command.slice(1) }
}

function expectedInstallerPath(projectDir, profile) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'))
  const outputDir = packageJson.build?.directories?.output || 'release'
  return path.resolve(projectDir, outputDir, expectedInstallerName(packageJson, profile))
}

function parseReleaseArgs(argv = process.argv.slice(2), env = process.env) {
  let plan = false
  let profileValue = env.FLOATING_CLOCK_PACKAGE_PROFILE
  let sawProfile = false
  for (const argument of argv) {
    if (argument === '--plan') plan = true
    else if (argument.startsWith('--profile=')) {
      if (sawProfile) throw new Error('--profile may be specified only once')
      sawProfile = true
      profileValue = argument.slice('--profile='.length)
    } else {
      throw new Error(`Unknown release gate argument: ${argument}`)
    }
  }
  return { plan, profile: normalizePackageProfile(profileValue) }
}

function parseElectronRuntimeVersions(output) {
  const marker = '[electron-runtime]'
  const line = String(output)
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(marker))
  if (!line) throw new Error('Electron runtime version probe did not produce a result.')
  const versions = JSON.parse(line.slice(marker.length))
  for (const key of ['electron', 'chromium', 'node', 'v8']) {
    if (typeof versions[key] !== 'string' || versions[key].length === 0) {
      throw new Error(`Electron runtime version probe omitted ${key}.`)
    }
  }
  return versions
}

function collectArtifactHashes(paths, cache = new Map()) {
  const hashes = {}
  for (const [name, filePath] of Object.entries(paths)) {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue
    const stat = fs.statSync(filePath)
    const cacheKey = `${filePath}\0${stat.size}\0${stat.mtimeMs}`
    const digest = cache.get(cacheKey) || sha256(filePath)
    cache.set(cacheKey, digest)
    hashes[name] = {
      path: filePath,
      bytes: stat.size,
      sha256: digest,
    }
  }
  return hashes
}

function createReleaseSteps(context) {
  const npm = context.npm
  const npmCommand = (args, extra = {}) => ({
    command: npm.command,
    args: [...npm.prefixArgs, ...args],
    ...extra,
  })
  const installerPath = context.installerPath
  const profile = normalizePackageProfile(
    context.profile || context.env?.FLOATING_CLOCK_PACKAGE_PROFILE,
  )
  const packagedMatrixPath = path.join(
    context.projectDir,
    'artifacts',
    'packaged-validation',
    'report.json',
  )

  return [
    {
      id: 'clean-install',
      label: 'Install the lockfile snapshot with npm ci',
      command: npmCommand(['ci']),
    },
    {
      id: 'git-preflight',
      label: 'Validate hooks, commit metadata, index policy, and clean tracked state',
      commands: [
        npmCommand(['run', 'git:hooks:check']),
        npmCommand(['run', 'git:validate-commit', '--', 'HEAD']),
        {
          command: 'git',
          args: ['status', '--porcelain', '--untracked-files=all'],
          capture: true,
          validate: (result) => {
            if (result.exitCode === 0 && result.stdout.trim()) {
              return {
                ...result,
                exitCode: 1,
                error: `Release worktree is not clean:\n${result.stdout.trim()}`,
              }
            }
            return result
          },
        },
      ],
    },
    {
      id: 'verify',
      label: 'Run engineering verification and the critical coverage gate',
      commands: [npmCommand(['run', 'verify']), npmCommand(['run', 'coverage:critical'])],
    },
    {
      id: 'runtime-resources',
      label: `Verify ${profile} bundled runtime resources before packaging`,
      command: npmCommand(['run', 'resources:verify', '--', `--profile=${profile}`]),
    },
    {
      id: 'license-compliance',
      label: 'Block release until project and bundled-component licenses are approved',
      command: npmCommand(['run', 'licenses:gate', '--', `--profile=${profile}`]),
    },
    {
      id: 'production-audit',
      label: 'Block unapproved production dependency vulnerabilities',
      command: npmCommand(['audit', '--omit=dev']),
    },
    {
      id: 'neko-accuracy-gate',
      label: 'Run the NekoSearch accuracy and latency gate',
      command: npmCommand(['run', 'benchmark:neko-search:accuracy', '--', '--gate']),
    },
    {
      id: 'package',
      label: `Build the ${profile} installer while retaining win-unpacked`,
      command: npmCommand(['run', `build:${profile}`], {
        env: {
          ...context.env,
          FLOATING_CLOCK_KEEP_UNPACKED: '1',
          FLOATING_CLOCK_PACKAGE_PROFILE: profile,
        },
      }),
      artifactPaths: { installer: installerPath },
    },
    {
      id: 'packaged-matrix',
      label: `Validate ${profile} packaged resources and both locales against the release commit`,
      command: npmCommand(
        ['run', 'validate:packaged:matrix', '--', `--profile=${profile}`, '--skip-build'],
        { env: { ...context.env, FLOATING_CLOCK_PACKAGE_PROFILE: profile } },
      ),
      artifactPaths: { installer: installerPath, packagedMatrix: packagedMatrixPath },
    },
    {
      id: 'installer-archive-smoke',
      label: 'Validate the NSIS archive',
      command: npmCommand(['run', 'smoke:installer:archive', '--', `--profile=${profile}`]),
      artifactPaths: { installer: installerPath },
    },
    {
      id: 'commercial-readiness',
      label: 'Require every commercial release readiness line before signing or evidence',
      command: npmCommand(['run', 'release:readiness', '--', `--profile=${profile}`, '--json']),
      artifactPaths: { installer: installerPath, packagedMatrix: packagedMatrixPath },
    },
    {
      id: 'sign-installer',
      label: 'Sign the installer using the explicitly configured signing command',
      resolveCommand: () => {
        const signingCommand = parseSigningCommand(context.env)
        return {
          ...signingCommand,
          args: signingCommand.args.map((argument) =>
            argument.replaceAll('{installer}', installerPath),
          ),
        }
      },
      redactCommand: true,
      artifactPaths: { installer: installerPath },
    },
    {
      id: 'verify-signature',
      label: 'Require a valid Windows Authenticode signature',
      command: {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$signature = Get-AuthenticodeSignature -LiteralPath $env:FLOATING_CLOCK_INSTALLER_TO_VERIFY; ' +
            'if ($signature.Status -ne "Valid") { ' +
            'Write-Error ("Invalid Authenticode signature: " + $signature.Status); exit 1 }',
        ],
        env: { ...context.env, FLOATING_CLOCK_INSTALLER_TO_VERIFY: installerPath },
      },
      artifactPaths: { installer: installerPath },
    },
    {
      id: 'release-evidence',
      label: 'Generate CycloneDX SBOM, hashes, and the draft release record',
      execute: () => {
        const electronExecutable =
          context.electronExecutable ||
          require(require.resolve('electron', { paths: [context.projectDir] }))
        const runtimeResult = context.runCommand(
          electronExecutable,
          [path.join(__dirname, 'print-electron-runtime.cjs')],
          {
            cwd: context.projectDir,
            env: context.env,
            capture: true,
          },
        )
        if (runtimeResult.exitCode !== 0) return runtimeResult
        try {
          context.runtimeVersions = parseElectronRuntimeVersions(runtimeResult.stdout)
        } catch (error) {
          return {
            exitCode: 1,
            error: error instanceof Error ? error.message : String(error),
          }
        }
        const result = context.runCommand(
          npm.command,
          [...npm.prefixArgs, 'sbom', '--sbom-format', 'cyclonedx'],
          {
            cwd: context.projectDir,
            env: context.env,
            capture: true,
          },
        )
        if (result.exitCode !== 0) return result
        fs.writeFileSync(context.sbomPath, result.stdout, 'utf8')
        return result
      },
      artifactPaths: { installer: installerPath, sbom: context.sbomPath },
    },
    {
      id: 'cleanup',
      label: 'Remove win-unpacked only after all runtime evidence is complete',
      command: npmCommand(['run', 'release:clean', '--', `--profile=${profile}`]),
      artifactPaths: { installer: installerPath, sbom: context.sbomPath },
    },
  ]
}

function displayCommand(command) {
  if (!command) return undefined
  return [command.command, ...(command.args || [])].join(' ')
}

function executeReleaseGate(options = {}) {
  const projectDir = path.resolve(options.projectDir || process.cwd())
  const env = options.env || process.env
  const runCommand = options.runCommand || runProcess
  const now = options.now || isoNow
  const npm = options.npm || resolveNpmInvocation(env)
  const profile = normalizePackageProfile(options.profile || env.FLOATING_CLOCK_PACKAGE_PROFILE)
  const commitResult =
    options.commit !== undefined
      ? { exitCode: 0, stdout: options.commit }
      : runCommand('git', ['rev-parse', 'HEAD'], {
          cwd: projectDir,
          env,
          capture: true,
        })
  if (commitResult.exitCode !== 0 || !String(commitResult.stdout || '').trim()) {
    throw new Error('Unable to resolve the release commit.')
  }
  const commit = String(commitResult.stdout).trim()
  const runId =
    options.runId ||
    `${now().replace(/[:.]/g, '-')}-${profile}-${commit.slice(0, 12).toLowerCase()}`
  const artifactDir = path.resolve(
    options.artifactDir || path.join(projectDir, 'artifacts', 'release-gate', runId),
  )
  fs.mkdirSync(artifactDir, { recursive: true })
  const reportPath = path.join(artifactDir, 'gate-report.json')
  const releaseRecordPath = path.join(artifactDir, 'release-record.json')
  const sbomPath = path.join(artifactDir, 'sbom.cdx.json')
  const context = {
    projectDir,
    env,
    npm,
    profile,
    runCommand,
    installerPath: expectedInstallerPath(projectDir, profile),
    sbomPath,
    electronExecutable: options.electronExecutable,
  }
  const steps = createReleaseSteps(context)
  const report = {
    schemaVersion: 1,
    kind: 'floating-clock-release-gate',
    runId,
    commit,
    profile,
    status: 'running',
    startedAt: now(),
    finishedAt: null,
    failedStep: null,
    steps: [],
  }
  const artifactHashCache = new Map()
  writeJsonAtomic(reportPath, report)

  for (const step of steps) {
    const record = {
      id: step.id,
      label: step.label,
      commit,
      status: 'running',
      startedAt: now(),
      finishedAt: null,
      exitCode: null,
      commands: [],
      artifactHashes: {},
    }
    report.steps.push(record)
    writeJsonAtomic(reportPath, report)
    let result
    try {
      const commands = step.commands || [step.resolveCommand ? step.resolveCommand() : step.command]
      if (step.execute) {
        record.commands.push('<internal>')
        result = step.execute()
      } else {
        for (const command of commands) {
          record.commands.push(
            step.redactCommand ? '<configured-signing-command>' : displayCommand(command),
          )
          result = runCommand(command.command, command.args || [], {
            cwd: projectDir,
            env: command.env || env,
            capture: command.capture === true,
          })
          if (command.validate) result = command.validate(result)
          if (result.exitCode !== 0) break
        }
      }
    } catch (error) {
      result = { exitCode: 1, error: error instanceof Error ? error.message : String(error) }
    }
    record.exitCode = result.exitCode
    record.finishedAt = now()
    record.status = result.exitCode === 0 ? SUCCESS_STATUS : FAILURE_STATUS
    record.error = result.error || result.stderr?.trim() || undefined
    record.artifactHashes = collectArtifactHashes(step.artifactPaths || {}, artifactHashCache)
    writeJsonAtomic(reportPath, report)

    if (result.exitCode !== 0) {
      report.status = FAILURE_STATUS
      report.failedStep = step.id
      report.finishedAt = now()
      writeJsonAtomic(reportPath, report)
      if (fs.existsSync(releaseRecordPath)) {
        writeJsonAtomic(releaseRecordPath, {
          ...JSON.parse(fs.readFileSync(releaseRecordPath, 'utf8')),
          status: FAILURE_STATUS,
          failedStep: step.id,
          finishedAt: report.finishedAt,
        })
      }
      return { ok: false, reportPath, releaseRecordPath: null, report }
    }

    if (step.id === 'release-evidence') {
      writeJsonAtomic(releaseRecordPath, {
        schemaVersion: 1,
        kind: 'floating-clock-release-record',
        runId,
        commit,
        profile,
        status: 'pending-cleanup',
        startedAt: report.startedAt,
        finishedAt: null,
        artifactHashes: record.artifactHashes,
        gateReport: reportPath,
        runtimeVersions: context.runtimeVersions,
      })
    }
  }

  report.status = SUCCESS_STATUS
  report.finishedAt = now()
  writeJsonAtomic(reportPath, report)
  const finalArtifacts = collectArtifactHashes(
    {
      installer: context.installerPath,
      sbom: context.sbomPath,
    },
    artifactHashCache,
  )
  writeJsonAtomic(releaseRecordPath, {
    ...JSON.parse(fs.readFileSync(releaseRecordPath, 'utf8')),
    status: SUCCESS_STATUS,
    finishedAt: report.finishedAt,
    artifactHashes: finalArtifacts,
  })
  return { ok: true, reportPath, releaseRecordPath, report }
}

function printPlan(options = {}) {
  const projectDir = path.resolve(options.projectDir || process.cwd())
  const env = options.env || process.env
  const profile = normalizePackageProfile(options.profile || env.FLOATING_CLOCK_PACKAGE_PROFILE)
  const npm = resolveNpmInvocation(env)
  const context = {
    projectDir,
    env,
    npm,
    profile,
    runCommand: runProcess,
    installerPath: expectedInstallerPath(projectDir, profile),
    sbomPath: '<generated-sbom>',
  }
  const steps = createReleaseSteps(context)
  console.log(`Siftory ${profile} release gate plan:`)
  for (const [index, step] of steps.entries()) {
    console.log(`${String(index + 1).padStart(2, '0')}. ${step.id}: ${step.label}`)
  }
}

if (require.main === module) {
  try {
    const cli = parseReleaseArgs()
    if (cli.plan) {
      printPlan(cli)
    } else {
      const result = executeReleaseGate({ profile: cli.profile })
      console.log(`[release-gate] report: ${result.reportPath}`)
      if (result.releaseRecordPath) {
        console.log(`[release-gate] release record: ${result.releaseRecordPath}`)
      }
      if (!result.ok) process.exitCode = 1
    }
  } catch (error) {
    console.error(`[release-gate] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

module.exports = {
  collectArtifactHashes,
  createReleaseSteps,
  expectedInstallerPath,
  executeReleaseGate,
  parseReleaseArgs,
  parseSigningCommand,
  parseElectronRuntimeVersions,
  sha256,
  writeJsonAtomic,
}
