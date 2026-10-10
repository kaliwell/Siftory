const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { expectedInstallerName, normalizePackageProfile } = require('./package-profile.cjs')

const MATRIX_PROFILES = ['offline', 'online']
const MATRIX_LOCALES = ['zh-CN', 'en']

function createValidationPlan(projectRoot = process.cwd(), profiles = MATRIX_PROFILES) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  return profiles.map((value) => {
    const profile = normalizePackageProfile(value)
    return {
      profile,
      buildScript: `build:${profile}`,
      resourcesPath: path.join(
        projectRoot,
        packageJson.build?.directories?.output || 'release',
        'win-unpacked',
        'resources',
      ),
      installerPath: path.join(
        projectRoot,
        packageJson.build?.directories?.output || 'release',
        expectedInstallerName(packageJson, profile),
      ),
      resourceReportPath: path.join(
        projectRoot,
        'artifacts',
        'packaged-validation',
        profile,
        'resources-report.json',
      ),
      localeReportPaths: Object.fromEntries(
        MATRIX_LOCALES.map((locale) => [
          locale,
          path.join(
            projectRoot,
            'artifacts',
            'ui-smoke-packaged',
            `${profile}-${locale}`,
            'report.json',
          ),
        ]),
      ),
    }
  })
}

function parseOptions(args = process.argv.slice(2)) {
  const requestedProfile = args.find((value) => value.startsWith('--profile='))?.slice(10)
  return {
    profiles: requestedProfile ? [normalizePackageProfile(requestedProfile)] : MATRIX_PROFILES,
    collectOnly: args.includes('--collect-only'),
    skipBuild: args.includes('--skip-build'),
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024)
  try {
    let bytesRead = 0
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function runNpm(npmCli, args, env) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed (${result.status})`)
}

function inspectSourceState(projectRoot) {
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false,
  })
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  })
  if (commit.status !== 0 || !/^[0-9a-f]{40}$/i.test(String(commit.stdout || '').trim())) {
    throw new Error('Unable to bind packaged validation to a Git commit')
  }
  if (status.status !== 0) throw new Error('Unable to inspect packaged validation worktree state')
  return {
    commit: String(commit.stdout).trim().toLowerCase(),
    worktreeClean: String(status.stdout || '').trim().length === 0,
  }
}

function createValidationReport(results, source, generatedAt = new Date().toISOString()) {
  if (!/^[0-9a-f]{40}$/i.test(source?.commit || '')) {
    throw new Error('Packaged validation source commit is missing or invalid')
  }
  return {
    schemaVersion: 2,
    kind: 'floating-clock-packaged-validation-matrix',
    ok: true,
    generatedAt,
    sourceCommit: source.commit.toLowerCase(),
    sourceWorktreeClean: source.worktreeClean === true,
    profiles: results,
  }
}

function copyJson(sourcePath, destinationPath) {
  const value = JSON.parse(fs.readFileSync(sourcePath, 'utf8'))
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
  fs.writeFileSync(destinationPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return value
}

function validateReportProfile(report, profile, label) {
  if (!report?.ok) throw new Error(`${label} did not pass`)
  const actual = report.profile || report.runtimeCheck?.packagedProvenance?.distributionProfile
  if (actual !== profile) throw new Error(`${label} profile mismatch: ${actual || 'missing'}`)
}

function collectProfileEvidence(entry, projectRoot) {
  const resourceReport = JSON.parse(fs.readFileSync(entry.resourceReportPath, 'utf8'))
  validateReportProfile(resourceReport, entry.profile, `${entry.profile} resources`)
  const locales = {}
  for (const locale of MATRIX_LOCALES) {
    const report = JSON.parse(fs.readFileSync(entry.localeReportPaths[locale], 'utf8'))
    validateReportProfile(report, entry.profile, `${entry.profile}/${locale} UI smoke`)
    locales[locale] = {
      ok: true,
      panelCount: report.snapshot?.panelCount,
      consoleErrorCount: report.consoleErrors?.length ?? 0,
      reportPath: path.relative(projectRoot, entry.localeReportPaths[locale]),
    }
  }
  const stat = fs.statSync(entry.installerPath)
  return {
    profile: entry.profile,
    installer: {
      path: path.relative(projectRoot, entry.installerPath),
      bytes: stat.size,
      sha256: sha256File(entry.installerPath),
    },
    resources: {
      ok: true,
      requiredCount: resourceReport.requiredCount,
      reportPath: path.relative(projectRoot, entry.resourceReportPath),
    },
    locales,
  }
}

function main() {
  const npmCli = process.env.npm_execpath
  if (!npmCli) throw new Error('Run packaged matrix validation through npm')
  const projectRoot = path.resolve(__dirname, '..')
  const source = inspectSourceState(projectRoot)
  const options = parseOptions()
  const plan = createValidationPlan(projectRoot, options.profiles)
  const results = []
  for (const entry of plan) {
    const env = {
      ...process.env,
      FLOATING_CLOCK_KEEP_UNPACKED: '1',
      FLOATING_CLOCK_PACKAGE_PROFILE: entry.profile,
    }
    if (!options.collectOnly) {
      if (!options.skipBuild) runNpm(npmCli, ['run', entry.buildScript], env)
      runNpm(
        npmCli,
        ['run', 'check:runtime-package', '--', '--resources', entry.resourcesPath],
        env,
      )
      runNpm(
        npmCli,
        ['run', 'licenses:source-check', '--', '--resources', entry.resourcesPath],
        env,
      )
      runNpm(npmCli, ['run', 'smoke:packaged:resources', '--', `--profile=${entry.profile}`], env)
      copyJson(
        path.join(projectRoot, 'artifacts', 'packaged-runtime', 'resources-report.json'),
        entry.resourceReportPath,
      )
      for (const locale of MATRIX_LOCALES) {
        runNpm(
          npmCli,
          ['run', 'smoke:ui:packaged', '--', `--profile=${entry.profile}`, `--locale=${locale}`],
          env,
        )
      }
    }
    results.push(collectProfileEvidence(entry, projectRoot))
  }
  const report = createValidationReport(results, source)
  const reportPath = path.join(projectRoot, 'artifacts', 'packaged-validation', 'report.json')
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(report, null, 2))
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

module.exports = {
  MATRIX_LOCALES,
  MATRIX_PROFILES,
  collectProfileEvidence,
  createValidationReport,
  createValidationPlan,
  inspectSourceState,
  parseOptions,
  validateReportProfile,
}
