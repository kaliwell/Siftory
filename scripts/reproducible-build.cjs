const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const options = { build: 'renderer', keepWorktrees: false, commit: 'HEAD' }
  for (const arg of argv) {
    if (arg.startsWith('--workspace-root=')) options.workspaceRoot = arg.slice(17)
    else if (arg.startsWith('--cache-dir=')) options.cacheDir = arg.slice(12)
    else if (arg.startsWith('--seed-root=')) options.seedRoot = arg.slice(12)
    else if (arg.startsWith('--report-dir=')) options.reportDir = arg.slice(13)
    else if (arg.startsWith('--commit=')) options.commit = arg.slice(9)
    else if (arg.startsWith('--build=')) options.build = arg.slice(8)
    else if (arg === '--keep-worktrees') options.keepWorktrees = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  for (const key of ['workspaceRoot', 'cacheDir', 'seedRoot', 'reportDir']) {
    if (!options[key])
      throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`)
    options[key] = path.resolve(options[key])
  }
  if (!['renderer', 'package'].includes(options.build)) {
    throw new Error('--build must be renderer or package')
  }
  return options
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function validateIsolationPaths(options) {
  if (isInside(projectRoot, options.workspaceRoot)) {
    throw new Error('workspace root must be outside the source repository')
  }
  if (isInside(options.workspaceRoot, options.cacheDir)) {
    throw new Error('cache directory must survive outside disposable worktrees')
  }
  if (isInside(options.workspaceRoot, options.reportDir)) {
    throw new Error('report directory must survive outside disposable worktrees')
  }
  if (!fs.existsSync(options.seedRoot) || !fs.statSync(options.seedRoot).isDirectory()) {
    throw new Error('seed root must be an existing directory')
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.capture === false ? 'inherit' : 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    exitCode: result.status ?? 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error?.message,
  }
}

function requireSuccess(result, label) {
  if (result.exitCode === 0) return result
  throw new Error(
    `${label} failed: ${result.error || result.stderr.trim() || result.stdout.trim()}`,
  )
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024)
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function listFiles(root) {
  if (!fs.existsSync(root)) return []
  const result = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(absolutePath)
      else if (entry.isFile()) result.push(absolutePath)
    }
  }
  return result.sort((a, b) => a.localeCompare(b))
}

function digestTree(root, relativeBase = root) {
  const files = listFiles(root).map((filePath) => {
    const stat = fs.statSync(filePath)
    return {
      path: path.relative(relativeBase, filePath).split(path.sep).join('/'),
      sizeBytes: stat.size,
      sha256: sha256File(filePath),
    }
  })
  const digest = crypto.createHash('sha256')
  for (const file of files) digest.update(`${file.path}\0${file.sizeBytes}\0${file.sha256}\n`)
  return { fileCount: files.length, sha256: digest.digest('hex'), files }
}

function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)
  const npmCli = candidates.find((candidate) => fs.existsSync(candidate))
  if (!npmCli) throw new Error('Unable to locate npm-cli.js')
  return npmCli
}

function npmInvocation() {
  return { command: process.execPath, args: [resolveNpmCli()] }
}

function createReproducibleEnvironment(worktreePath, commitTimestamp) {
  const environment = {
    ...process.env,
    SOURCE_DATE_EPOCH: String(commitTimestamp),
  }
  if (process.platform === 'win32') {
    environment.CL = [
      process.env.CL,
      '/Brepro',
      '/experimental:deterministic',
      `/pathmap:"${worktreePath}"=.`,
    ]
      .filter(Boolean)
      .join(' ')
    environment.LINK = [process.env.LINK, '/Brepro'].filter(Boolean).join(' ')
  }
  return environment
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temporaryPath, filePath)
}

function resolveCommit(commit) {
  return requireSuccess(
    run('git', ['rev-parse', `${commit}^{commit}`], { cwd: projectRoot }),
    'commit',
  ).stdout.trim()
}

function cacheIsEmpty(cacheDir) {
  return !fs.existsSync(cacheDir) || listFiles(cacheDir).length === 0
}

function createPassPlan(options, passNumber, commit, commitTimestamp = 0) {
  const worktreePath = path.join(options.workspaceRoot, `pass-${passNumber}`)
  return {
    id: passNumber === 1 ? 'empty-cache-seed' : 'controlled-cache-reuse',
    passNumber,
    commit,
    commitTimestamp,
    worktreePath,
    seedFromTarget: passNumber === 1,
    buildScript: options.build === 'package' ? 'build' : 'build:renderer',
  }
}

function readBuildMetadata(worktreePath) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(worktreePath, 'package.json'), 'utf8'))
  return {
    packageJson,
    installerName: `${packageJson.build.productName} Setup ${packageJson.version}.exe`,
  }
}

function runtimeMaterialInventory(manifest) {
  return manifest.components.flatMap((component) =>
    component.artifacts.map((artifact) => ({
      componentId: component.id,
      componentType: component.componentType,
      version: component.upstream.version,
      license: component.license.spdx,
      role: artifact.role,
      fetchPolicy: artifact.fetchPolicy,
      sourceUrl: artifact.sourceUrl || null,
      targetPath: artifact.targetPath,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
    })),
  )
}

function packageByteException(pathname) {
  if (pathname.endsWith('.node')) {
    return 'MSVC native PE output may retain linker/PDB identity despite /Brepro and path mapping.'
  }
  if (pathname === 'resources/app.asar') {
    return 'ASAR transitively contains the recorded native PE outputs.'
  }
  if (pathname === 'Siftory.exe') {
    return 'Electron executable transitively embeds the recorded ASAR integrity hash.'
  }
  return null
}

function compareTreeFiles(firstTree, secondTree) {
  const firstByPath = new Map(firstTree.files.map((file) => [file.path, file]))
  const secondByPath = new Map(secondTree.files.map((file) => [file.path, file]))
  const paths = [...new Set([...firstByPath.keys(), ...secondByPath.keys()])].sort()
  const differences = []
  for (const pathname of paths) {
    const first = firstByPath.get(pathname)
    const second = secondByPath.get(pathname)
    if (first?.sizeBytes === second?.sizeBytes && first?.sha256 === second?.sha256) continue
    const isContentOnly = Boolean(first && second && first.sizeBytes === second.sizeBytes)
    const allowedReason = isContentOnly ? packageByteException(pathname) : null
    differences.push({
      path: pathname,
      kind: !first ? 'added' : !second ? 'removed' : 'changed',
      firstSizeBytes: first?.sizeBytes ?? null,
      secondSizeBytes: second?.sizeBytes ?? null,
      firstSha256: first?.sha256 ?? null,
      secondSha256: second?.sha256 ?? null,
      allowed: Boolean(allowedReason),
      reason: allowedReason,
    })
  }
  return {
    byteEqual: differences.length === 0,
    contentReproducible: differences.every((difference) => difference.allowed),
    differences,
  }
}

async function executePass(options, plan) {
  const npm = npmInvocation()
  const reproducibleEnvironment = createReproducibleEnvironment(
    plan.worktreePath,
    plan.commitTimestamp,
  )
  const startedAt = new Date().toISOString()
  const steps = []
  const recordStep = (id, command, args, cwd, stepOptions = {}) => {
    const started = Date.now()
    const result = run(command, args, {
      cwd,
      capture: stepOptions.capture,
      env: stepOptions.env,
    })
    steps.push({
      id,
      command: [command, ...args],
      exitCode: result.exitCode,
      elapsedMs: Date.now() - started,
    })
    return requireSuccess(result, id)
  }
  const recordNpmStep = (id, args, cwd, stepOptions = {}) =>
    recordStep(id, npm.command, [...npm.args, ...args], cwd, {
      env: reproducibleEnvironment,
      ...stepOptions,
    })
  let worktreeAdded = false
  try {
    recordStep(
      'worktree-add',
      'git',
      ['worktree', 'add', '--detach', plan.worktreePath, plan.commit],
      projectRoot,
    )
    worktreeAdded = true
    recordNpmStep('npm-ci', ['ci'], plan.worktreePath, { capture: false })
    const fetcher = path.join(plan.worktreePath, 'scripts', 'fetch-runtime-resources.cjs')
    if (plan.seedFromTarget) {
      recordStep(
        'seed-empty-cache',
        process.execPath,
        [
          fetcher,
          `--cache-dir=${options.cacheDir}`,
          `--target-dir=${options.seedRoot}`,
          '--offline',
        ],
        plan.worktreePath,
      )
    }
    recordStep(
      'restore-controlled-resources',
      process.execPath,
      [
        fetcher,
        `--cache-dir=${options.cacheDir}`,
        `--target-dir=${plan.worktreePath}`,
        '--offline',
      ],
      plan.worktreePath,
    )
    recordNpmStep('verify-resources', ['run', 'resources:verify'], plan.worktreePath)
    recordNpmStep('build', ['run', plan.buildScript], plan.worktreePath, {
      capture: false,
      env:
        options.build === 'package'
          ? { ...reproducibleEnvironment, FLOATING_CLOCK_KEEP_UNPACKED: '1' }
          : reproducibleEnvironment,
    })
    const sbomResult = recordNpmStep(
      'sbom',
      ['sbom', '--sbom-format', 'cyclonedx'],
      plan.worktreePath,
    )
    const passReportDir = path.join(options.reportDir, plan.id)
    await fsp.mkdir(passReportDir, { recursive: true })
    JSON.parse(sbomResult.stdout)
    await fsp.writeFile(path.join(passReportDir, 'sbom.cdx.json'), sbomResult.stdout, 'utf8')
    const { installerName } = readBuildMetadata(plan.worktreePath)
    const runtimeManifestPath = path.join(plan.worktreePath, 'resources', 'runtime-manifest.json')
    const runtimeManifest = JSON.parse(fs.readFileSync(runtimeManifestPath, 'utf8'))
    const dist = digestTree(path.join(plan.worktreePath, 'dist'), plan.worktreePath)
    const electron = digestTree(path.join(plan.worktreePath, 'dist-electron'), plan.worktreePath)
    const packageContentsPath = path.join(plan.worktreePath, 'release', 'win-unpacked')
    const packageContents = fs.existsSync(packageContentsPath)
      ? digestTree(packageContentsPath, packageContentsPath)
      : null
    const installerPath = path.join(plan.worktreePath, 'release', installerName)
    const installer = fs.existsSync(installerPath)
      ? {
          path: path.relative(plan.worktreePath, installerPath).split(path.sep).join('/'),
          sizeBytes: fs.statSync(installerPath).size,
          sha256: sha256File(installerPath),
        }
      : null
    const report = {
      schemaVersion: 1,
      kind: 'floating-clock-reproducible-build-pass',
      id: plan.id,
      commit: plan.commit,
      buildMode: options.build,
      startedAt,
      finishedAt: new Date().toISOString(),
      lockfile: { sha256: sha256File(path.join(plan.worktreePath, 'package-lock.json')) },
      runtimeManifest: {
        sha256: sha256File(runtimeManifestPath),
        componentCount: runtimeManifest.components.length,
        artifactCount: runtimeManifest.components.reduce(
          (total, component) => total + component.artifacts.length,
          0,
        ),
        materials: runtimeMaterialInventory(runtimeManifest),
      },
      toolchain: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        npm: recordNpmStep('npm-version', ['--version'], plan.worktreePath).stdout.trim(),
        electron: JSON.parse(
          fs.readFileSync(
            path.join(plan.worktreePath, 'node_modules', 'electron', 'package.json'),
            'utf8',
          ),
        ).version,
        electronBuilder: JSON.parse(
          fs.readFileSync(
            path.join(plan.worktreePath, 'node_modules', 'electron-builder', 'package.json'),
            'utf8',
          ),
        ).version,
        sourceDateEpoch: plan.commitTimestamp,
      },
      outputs: { dist, electron, packageContents, installer },
      steps,
      ok: true,
    }
    writeJsonAtomic(path.join(passReportDir, 'material-report.json'), report)
    return report
  } finally {
    if (worktreeAdded && !options.keepWorktrees) {
      requireSuccess(
        run('git', ['worktree', 'remove', '--force', plan.worktreePath], { cwd: projectRoot }),
        'worktree cleanup',
      )
    }
  }
}

function createComparison(first, second, commit, buildMode) {
  const comparison = {
    schemaVersion: 1,
    kind: 'floating-clock-reproducible-build-comparison',
    commit,
    buildMode,
    generatedAt: new Date().toISOString(),
    lockfileEqual: first.lockfile.sha256 === second.lockfile.sha256,
    manifestEqual: first.runtimeManifest.sha256 === second.runtimeManifest.sha256,
    rendererEqual: first.outputs.dist.sha256 === second.outputs.dist.sha256,
    electronEqual: first.outputs.electron.sha256 === second.outputs.electron.sha256,
    packageContentsByteEqual: null,
    packageContentsEqual: null,
    packageContentDifferences: [],
    installerEqual:
      first.outputs.installer && second.outputs.installer
        ? first.outputs.installer.sha256 === second.outputs.installer.sha256
        : null,
    bindings: {
      lockfileSha256: first.lockfile.sha256,
      runtimeManifestSha256: first.runtimeManifest.sha256,
      firstInstallerSha256: first.outputs.installer?.sha256 || null,
      secondInstallerSha256: second.outputs.installer?.sha256 || null,
      firstMaterialReport: `${first.id}/material-report.json`,
      secondMaterialReport: `${second.id}/material-report.json`,
      firstSbom: `${first.id}/sbom.cdx.json`,
      secondSbom: `${second.id}/sbom.cdx.json`,
    },
    reproducibilityPolicy: {
      required: ['lockfile', 'runtime-manifest', 'renderer', 'electron'],
      installerByteEqualityRequired: false,
      installerException:
        'NSIS metadata and signing timestamps may differ; all non-exempt expanded contents must remain identical.',
    },
  }
  if (first.outputs.packageContents && second.outputs.packageContents) {
    const packageComparison = compareTreeFiles(
      first.outputs.packageContents,
      second.outputs.packageContents,
    )
    comparison.packageContentsByteEqual = packageComparison.byteEqual
    comparison.packageContentsEqual = packageComparison.contentReproducible
    comparison.packageContentDifferences = packageComparison.differences
    comparison.reproducibilityPolicy.required = [
      'lockfile',
      'runtime-manifest',
      'renderer',
      'electron',
      'package-contents-with-recorded-native-PE-exceptions',
    ]
    comparison.reproducibilityPolicy.nativePeByteEqualityRequired = false
    comparison.reproducibilityPolicy.nativePeException =
      'Only same-path, same-size .node binaries and their ASAR/executable integrity carriers may differ; every hash is retained.'
  }
  comparison.ok =
    comparison.lockfileEqual &&
    comparison.manifestEqual &&
    comparison.rendererEqual &&
    comparison.electronEqual &&
    (buildMode !== 'package' || comparison.packageContentsEqual === true)
  return comparison
}

async function executeReproducibleBuild(options) {
  validateIsolationPaths(options)
  if (fs.existsSync(options.workspaceRoot)) {
    throw new Error('workspace root must not already exist')
  }
  if (!cacheIsEmpty(options.cacheDir)) {
    throw new Error('cache directory must start empty for the first pass')
  }
  const commit = resolveCommit(options.commit)
  const commitTimestamp = Number(
    requireSuccess(
      run('git', ['show', '-s', '--format=%ct', commit], { cwd: projectRoot }),
      'commit timestamp',
    ).stdout.trim(),
  )
  await fsp.mkdir(options.workspaceRoot, { recursive: true })
  await fsp.mkdir(options.reportDir, { recursive: true })
  const first = await executePass(options, createPassPlan(options, 1, commit, commitTimestamp))
  const second = await executePass(options, createPassPlan(options, 2, commit, commitTimestamp))
  const comparison = createComparison(first, second, commit, options.build)
  writeJsonAtomic(path.join(options.reportDir, 'comparison-report.json'), comparison)
  return comparison
}

async function main() {
  try {
    const result = await executeReproducibleBuild(parseArgs(process.argv.slice(2)))
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = {
  cacheIsEmpty,
  createReproducibleEnvironment,
  createPassPlan,
  createComparison,
  compareTreeFiles,
  digestTree,
  executeReproducibleBuild,
  isInside,
  parseArgs,
  readBuildMetadata,
  resolveNpmCli,
  runtimeMaterialInventory,
  validateIsolationPaths,
}
