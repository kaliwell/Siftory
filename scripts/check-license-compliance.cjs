const fs = require('node:fs')
const path = require('node:path')
const { loadTsModule } = require('../tests/guard-utils.cjs')
const {
  createProfileManifest,
  normalizePackageProfile,
  packageProfileFromArgs,
} = require('./package-profile.cjs')

const APPROVED_RESOLUTIONS = new Set([
  'upstream-license',
  'enterprise-license',
  'open-source-compliance',
  'source-offer-complete',
  'approved-use',
  'project-license',
])
const APPROVED_RELEASE_MODES = new Set(['open-source', 'proprietary', 'internal'])

function isApprovalMetadataComplete(decision) {
  return (
    typeof decision?.approvedBy === 'string' &&
    decision.approvedBy.trim().length > 0 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(decision?.approvedAt || '') &&
    Array.isArray(decision?.evidence) &&
    decision.evidence.length > 0 &&
    decision.evidence.every((entry) => typeof entry === 'string' && entry.trim().length > 0)
  )
}

function existingLicenseFiles(projectRoot, decision) {
  if (!Array.isArray(decision?.licenseFiles) || decision.licenseFiles.length === 0) return []
  return decision.licenseFiles.filter((relativePath) => {
    if (
      typeof relativePath !== 'string' ||
      relativePath.length === 0 ||
      path.isAbsolute(relativePath)
    ) {
      return false
    }
    const absolutePath = path.resolve(projectRoot, relativePath)
    const relative = path.relative(projectRoot, absolutePath)
    return (
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      fs.existsSync(absolutePath) &&
      fs.statSync(absolutePath).isFile()
    )
  })
}

function isFinalProjectLicenseFile(projectRoot, relativePath) {
  if (typeof relativePath !== 'string' || /(?:draft|template)/i.test(relativePath)) return false
  return existingLicenseFiles(projectRoot, { licenseFiles: [relativePath] }).length === 1
}

function endUserTermsReleaseBlockers(projectRoot, packageJson, projectDecision) {
  if (projectDecision?.releaseMode !== 'proprietary') return []
  const blockers = []
  const resources = packageJson.build?.extraResources
  const termsResources = Array.isArray(resources)
    ? resources.filter((entry) => entry?.to === 'legal/end-user-terms')
    : []
  if (
    termsResources.length !== 1 ||
    termsResources[0].from !== 'legal/end-user-terms' ||
    termsResources[0].filter !== undefined
  ) {
    blockers.push('final end-user terms must be copied completely to legal/end-user-terms')
  }
  try {
    // Share startup validation: the release gate must approve the exact text the app displays.
    const { loadEndUserTerms } = loadTsModule('electron/endUserTerms.ts')
    const loaded = loadEndUserTerms(projectRoot)
    if (loaded.status !== 'final') {
      blockers.push('end-user terms remain in review and cannot satisfy a proprietary release')
    } else {
      const termsManifest = JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'legal', 'end-user-terms', 'manifest.json'), 'utf8'),
      )
      const approvedPath = projectDecision.licenseFile
      if (
        !termsManifest.documents.some(
          (document) => approvedPath === `legal/end-user-terms/${document.path}`,
        )
      ) {
        blockers.push('approved project EULA must be a document in the final end-user terms')
      }
    }
  } catch {
    blockers.push('final end-user terms are missing, unsafe, or invalid')
  }
  return blockers
}

function inspectLicenseCompliance(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  const profile = normalizePackageProfile(options.profile)
  const packageJson =
    options.packageJson ||
    JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const sourceManifest =
    options.manifest ||
    JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'resources', 'runtime-manifest.json'), 'utf8'),
    )
  const decisions =
    options.decisions ||
    JSON.parse(fs.readFileSync(path.join(projectRoot, 'legal', 'license-decisions.json'), 'utf8'))
  const manifest = createProfileManifest(sourceManifest, profile)
  const projectBlockers = []
  const componentBlockers = []
  const excludedPendingComponents = []

  if (decisions.schemaVersion !== 1 || decisions.kind !== 'floating-clock-license-decisions') {
    projectBlockers.push('license decision record schema is invalid')
  }
  const projectDecision = decisions.project
  if (projectDecision?.status !== 'approved') {
    projectBlockers.push('project license decision is not approved')
  }
  if (!APPROVED_RELEASE_MODES.has(projectDecision?.releaseMode)) {
    projectBlockers.push('approved project release mode is missing or unsupported')
  }
  if (
    typeof projectDecision?.licenseExpression !== 'string' ||
    projectDecision.licenseExpression.length === 0 ||
    packageJson.license !== projectDecision.licenseExpression
  ) {
    projectBlockers.push('package.json license does not match an approved project decision')
  }
  if (
    typeof projectDecision?.licenseFile !== 'string' ||
    !isFinalProjectLicenseFile(projectRoot, projectDecision?.licenseFile)
  ) {
    projectBlockers.push('approved project license or EULA file is missing')
  }
  if (!isApprovalMetadataComplete(projectDecision)) {
    projectBlockers.push('project approval metadata and evidence are incomplete')
  }
  projectBlockers.push(...endUserTermsReleaseBlockers(projectRoot, packageJson, projectDecision))

  const manifestIds = new Set(manifest.components.map((component) => component.id))
  const unknownDecisionIds = Object.keys(decisions.components || {}).filter(
    (id) => !manifestIds.has(id),
  )
  if (unknownDecisionIds.length > 0) {
    projectBlockers.push(
      `decision record contains unknown components: ${unknownDecisionIds.join(', ')}`,
    )
  }

  for (const component of manifest.components) {
    const bundled = component.distribution.defaultBundled === true
    const decision = decisions.components?.[component.id]
    if (!bundled) {
      if (decision?.status !== 'approved') {
        excludedPendingComponents.push({
          id: component.id,
          reviewStatus: component.license.reviewStatus,
        })
      }
      continue
    }
    const reasons = []
    if (decision?.status !== 'approved') reasons.push('decision is not approved')
    if (!APPROVED_RESOLUTIONS.has(decision?.resolution)) {
      reasons.push('approved resolution is missing or unsupported')
    }
    if (
      !Array.isArray(decision?.permittedProfiles) ||
      !decision.permittedProfiles.includes(profile)
    ) {
      reasons.push(`decision does not permit the ${profile} profile`)
    }
    if (!isApprovalMetadataComplete(decision)) {
      reasons.push('approval metadata and evidence are incomplete')
    }
    const licenseFiles = existingLicenseFiles(projectRoot, decision)
    if (
      !Array.isArray(decision?.licenseFiles) ||
      decision.licenseFiles.length === 0 ||
      licenseFiles.length !== decision.licenseFiles.length
    ) {
      reasons.push('one or more required license files are missing or unsafe')
    }
    if (reasons.length > 0) {
      componentBlockers.push({
        id: component.id,
        name: component.upstream.name,
        spdx: component.license.spdx,
        reviewStatus: component.license.reviewStatus,
        reasons,
      })
    }
  }

  return {
    ok: projectBlockers.length === 0 && componentBlockers.length === 0,
    profile,
    projectBlockers,
    componentBlockers,
    excludedPendingComponents,
    bundledComponentCount: manifest.components.filter(
      (component) => component.distribution.defaultBundled,
    ).length,
  }
}

function main() {
  const report = inspectLicenseCompliance({
    profile: packageProfileFromArgs(),
  })
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
}

if (require.main === module) main()

module.exports = { inspectLicenseCompliance, isApprovalMetadataComplete }
