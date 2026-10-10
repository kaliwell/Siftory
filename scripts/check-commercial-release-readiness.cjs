const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const {
  inspectLicenseCompliance,
  isApprovalMetadataComplete,
} = require('./check-license-compliance.cjs')
const { normalizePackageProfile } = require('./package-profile.cjs')
const { parseSigningCommand } = require('./release-gate.cjs')

const FINAL_POLICY_PATHS = {
  privacy: 'legal/PRIVACY_POLICY.md',
  support: 'legal/SECURITY_AND_SUPPORT_POLICY.md',
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function isFinalPolicy(projectRoot, relativePath) {
  const filePath = path.join(projectRoot, relativePath)
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false
  const source = fs.readFileSync(filePath, 'utf8')
  return (
    source.trim().length >= 300 &&
    /^# \S+/m.test(source) &&
    !/(?:DRAFT|NOT FOR DISTRIBUTION|\{\{[^}]+\}\})/i.test(source) &&
    !/(?:draft|template)/i.test(path.basename(filePath))
  )
}

function isApprovedPolicy(projectRoot, decision, expectedPath) {
  return (
    decision?.status === 'approved' &&
    decision?.file === expectedPath &&
    isApprovalMetadataComplete(decision) &&
    isFinalPolicy(projectRoot, expectedPath)
  )
}

function isPublisherIdentityApproved(decision) {
  const publicFields = [
    decision?.publicPublisherName,
    decision?.publicContact,
    decision?.signingIdentity,
  ]
  return (
    decision?.status === 'approved' &&
    decision?.type === 'individual' &&
    publicFields.every((value) => typeof value === 'string' && value.trim().length > 0) &&
    Array.isArray(decision?.releaseTerritories) &&
    decision.releaseTerritories.length > 0 &&
    decision.releaseTerritories.every(
      (value) => typeof value === 'string' && value.trim().length > 0,
    ) &&
    typeof decision?.identityEvidenceRef === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9:._-]{2,127}$/.test(decision.identityEvidenceRef) &&
    isApprovalMetadataComplete(decision)
  )
}

function runGit(projectRoot, args) {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  })
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || '').trim(),
    error: result.error?.message || String(result.stderr || '').trim(),
  }
}

function evaluateCommercialReleaseReadiness(input) {
  const checks = []
  const add = (id, label, owner, passed, detail) => {
    checks.push({ id, label, owner, status: passed ? 'passed' : 'blocked', detail })
  }

  add(
    'REL-LEGAL',
    'Project and bundled-component license approval',
    'authorized-reviewer',
    input.licenseReport.ok && input.publisherIdentityApproved,
    input.licenseReport.ok && input.publisherIdentityApproved
      ? `${input.licenseReport.bundledComponentCount} bundled component decisions approved`
      : `${input.licenseReport.projectBlockers.length} project, ${input.licenseReport.componentBlockers.length} component, publisher=${input.publisherIdentityApproved ? 'approved' : 'pending'}`,
  )
  add(
    'REL-SOURCE',
    'Clean and traceable release source',
    'release-operator',
    input.gitStatusOk && input.gitStatus.length === 0,
    input.gitStatusOk
      ? input.gitStatus.length === 0
        ? 'worktree is clean'
        : `${input.gitStatus.split(/\r?\n/).filter(Boolean).length} changed path(s)`
      : 'unable to inspect Git worktree',
  )
  add(
    'REL-TAG',
    'Version tag points at the release commit',
    'release-operator',
    input.tags.includes(`v${input.version}`),
    input.tags.length > 0 ? `HEAD tags: ${input.tags.join(', ')}` : `missing v${input.version}`,
  )
  add(
    'REL-SIGN',
    'Production signing command is configured',
    'release-operator',
    input.signingConfigured,
    input.signingConfigured
      ? 'signing command syntax accepted'
      : 'signing command is absent or invalid',
  )

  const currentComparable = input.nekoCurrent?.comparability
  const baselineComparable = input.nekoBaseline?.comparability
  const nekoComparable = Boolean(
    currentComparable?.annotationFingerprint &&
    currentComparable.annotationFingerprint === baselineComparable?.annotationFingerprint &&
    currentComparable.activeSetFingerprint &&
    currentComparable.activeSetFingerprint === baselineComparable?.activeSetFingerprint,
  )
  add(
    'REL-NEKO',
    'Controlled Neko accuracy baseline is comparable',
    'controlled-data-reviewer',
    nekoComparable,
    nekoComparable
      ? `active set ${currentComparable.activeSetCount}`
      : `current ${currentComparable?.activeSetCount ?? 'unknown'} vs baseline ${baselineComparable?.activeSetCount ?? 'unknown'}`,
  )

  const packagedProfile = input.packagedReport?.profiles?.find(
    (entry) => entry.profile === input.profile,
  )
  const packagedBound = Boolean(
    input.commit &&
    input.packagedReport?.ok === true &&
    input.packagedReport.sourceCommit === input.commit &&
    input.packagedReport.sourceWorktreeClean === true &&
    packagedProfile?.resources?.ok === true &&
    packagedProfile?.locales?.['zh-CN']?.ok === true &&
    packagedProfile?.locales?.en?.ok === true,
  )
  add(
    'REL-PACKAGED',
    'Packaged profile matrix is bound to the current commit',
    'release-operator',
    packagedBound,
    packagedBound
      ? `${input.profile} resources and both locales passed`
      : 'missing, stale, or not commit-bound packaged evidence',
  )
  add(
    'REL-PRIVACY',
    'Final privacy policy is approved and present',
    'authorized-reviewer',
    input.privacyPolicyApproved,
    input.privacyPolicyApproved
      ? FINAL_POLICY_PATHS.privacy
      : `missing or unapproved final ${FINAL_POLICY_PATHS.privacy}`,
  )
  add(
    'REL-SUPPORT',
    'Final security, update, and support policy is present',
    'authorized-reviewer',
    input.supportPolicyApproved,
    input.supportPolicyApproved
      ? FINAL_POLICY_PATHS.support
      : `missing or unapproved final ${FINAL_POLICY_PATHS.support}`,
  )

  return {
    schemaVersion: 1,
    kind: 'floating-clock-commercial-release-readiness',
    profile: input.profile,
    version: input.version,
    commit: input.commit || null,
    ready: checks.every((check) => check.status === 'passed'),
    summary: {
      passed: checks.filter((check) => check.status === 'passed').length,
      blocked: checks.filter((check) => check.status === 'blocked').length,
      total: checks.length,
    },
    checks,
  }
}

function inspectCommercialReleaseReadiness(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  const env = options.env || process.env
  const profile = normalizePackageProfile(options.profile || env.FLOATING_CLOCK_PACKAGE_PROFILE)
  const packageJson = readJsonIfPresent(path.join(projectRoot, 'package.json'))
  if (!packageJson) throw new Error('package.json is missing or invalid')
  const policyDecisions = readJsonIfPresent(
    path.join(projectRoot, 'legal', 'commercial-release-decisions.json'),
  )

  const statusResult =
    options.gitStatusResult ||
    runGit(projectRoot, ['status', '--porcelain', '--untracked-files=all'])
  const commitResult = options.commitResult || runGit(projectRoot, ['rev-parse', 'HEAD'])
  const tagResult = options.tagResult || runGit(projectRoot, ['tag', '--points-at', 'HEAD'])
  const signingConfigured = (() => {
    try {
      parseSigningCommand(env)
      return true
    } catch {
      return false
    }
  })()

  return evaluateCommercialReleaseReadiness({
    profile,
    version: packageJson.version,
    commit: commitResult.ok ? commitResult.stdout : '',
    gitStatusOk: statusResult.ok,
    gitStatus: statusResult.stdout,
    tags: tagResult.ok ? tagResult.stdout.split(/\r?\n/).filter(Boolean) : [],
    signingConfigured,
    publisherIdentityApproved: isPublisherIdentityApproved(policyDecisions?.publisher),
    licenseReport: inspectLicenseCompliance({ projectRoot, profile }),
    nekoCurrent: readJsonIfPresent(
      path.join(projectRoot, 'artifacts', 'neko-search-accuracy', 'latest.json'),
    ),
    nekoBaseline: readJsonIfPresent(
      path.join(projectRoot, 'docs', 'benchmark', 'neko-search-accuracy-baseline.json'),
    ),
    packagedReport: readJsonIfPresent(
      path.join(projectRoot, 'artifacts', 'packaged-validation', 'report.json'),
    ),
    privacyPolicyApproved: isApprovedPolicy(
      projectRoot,
      policyDecisions?.policies?.privacy,
      FINAL_POLICY_PATHS.privacy,
    ),
    supportPolicyApproved: isApprovedPolicy(
      projectRoot,
      policyDecisions?.policies?.securityAndSupport,
      FINAL_POLICY_PATHS.support,
    ),
  })
}

function parseArgs(argv, env = process.env) {
  let profile = env.FLOATING_CLOCK_PACKAGE_PROFILE
  let json = false
  for (const argument of argv) {
    if (argument === '--json') json = true
    else if (argument.startsWith('--profile=')) profile = argument.slice('--profile='.length)
    else throw new Error(`Unknown commercial readiness argument: ${argument}`)
  }
  return { profile: normalizePackageProfile(profile), json }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    const report = inspectCommercialReleaseReadiness({ profile: options.profile })
    if (options.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(
        `[commercial-release] ${report.profile} ${report.summary.passed}/${report.summary.total} passed`,
      )
      for (const check of report.checks) {
        const marker = check.status === 'passed' ? 'PASS' : 'BLOCKED'
        console.log(`- [${marker}] ${check.id} ${check.label}: ${check.detail}`)
      }
    }
    if (!report.ready) process.exitCode = 1
  } catch (error) {
    console.error(`[commercial-release] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = {
  evaluateCommercialReleaseReadiness,
  inspectCommercialReleaseReadiness,
  isApprovedPolicy,
  isFinalPolicy,
  isPublisherIdentityApproved,
  parseArgs,
}
