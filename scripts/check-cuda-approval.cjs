#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const CUDA_APPROVAL_CONFIG = [
  {
    id: 'microsoft-onnxruntime-gpu-windows-1-24-3',
    resolution: 'upstream-license',
    scopeFlags: ['noticesIncludedConfirmed'],
  },
  {
    id: 'nvidia-cuda-12-8-embedding-runtime',
    resolution: 'upstream-license',
    scopeFlags: [
      'agreementAcceptedConfirmed',
      'applicationOnlyAccessConfirmed',
      'materialAdditionalFunctionalityConfirmed',
    ],
    agreementReference: true,
  },
  {
    id: 'nvidia-cudnn-9-19-1-cuda12-runtime',
    resolution: 'upstream-license',
    scopeFlags: [
      'agreementAcceptedConfirmed',
      'applicationOnlyAccessConfirmed',
      'materialAdditionalFunctionalityConfirmed',
    ],
    agreementReference: true,
  },
  {
    id: 'floating-clock-cuda-embedding-worker',
    resolution: 'project-license',
    scopeFlags: ['authorityToLicenseConfirmed'],
    finalProjectLicense: true,
  },
]

const REQUIRED_PROFILES = ['online', 'offline']

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isValidApprovalTime(value, nowMs = Date.now()) {
  if (!isNonEmptyString(value)) return false
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed <= nowMs + 5 * 60 * 1000
}

function resolveSafeFile(projectRoot, relativePath) {
  if (!isNonEmptyString(relativePath) || path.isAbsolute(relativePath)) return null
  const absolutePath = path.resolve(projectRoot, relativePath)
  const relative = path.relative(projectRoot, absolutePath)
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) return null
  try {
    return fs.statSync(absolutePath).isFile() ? absolutePath : null
  } catch {
    return null
  }
}

function inspectApprovalMetadata(decision, nowMs) {
  const reasons = []
  if (!isNonEmptyString(decision?.approvedBy))
    reasons.push('authorized reviewer identity is missing')
  if (!isValidApprovalTime(decision?.approvedAt, nowMs)) {
    reasons.push('approval time is missing, invalid, or in the future')
  }
  if (
    !Array.isArray(decision?.evidence) ||
    decision.evidence.length === 0 ||
    !decision.evidence.every(isNonEmptyString)
  ) {
    reasons.push('approval evidence is missing or malformed')
  }
  return reasons
}

function inspectApprovalScope(scope, config) {
  const reasons = []
  if (
    !Array.isArray(scope?.distributionChannels) ||
    scope.distributionChannels.length === 0 ||
    !scope.distributionChannels.every(isNonEmptyString)
  ) {
    reasons.push('distribution channels are not explicitly approved')
  }
  if (
    !Array.isArray(scope?.territories) ||
    scope.territories.length === 0 ||
    !scope.territories.every(isNonEmptyString)
  ) {
    reasons.push('distribution territories are not explicitly approved')
  }
  if (scope?.exportEndUseConfirmed !== true) {
    reasons.push('export and end-use review is not confirmed')
  }
  for (const flag of config.scopeFlags) {
    if (scope?.[flag] !== true) reasons.push(`${flag} is not confirmed`)
  }
  if (config.agreementReference && !isNonEmptyString(scope?.agreementAcceptanceReference)) {
    reasons.push('agreement acceptance or counsel-review reference is missing')
  }
  return reasons
}

function inspectLicenseFiles(projectRoot, decision, config) {
  const reasons = []
  if (!Array.isArray(decision?.licenseFiles) || decision.licenseFiles.length === 0) {
    return ['license and notice file list is empty']
  }
  for (const relativePath of decision.licenseFiles) {
    if (!resolveSafeFile(projectRoot, relativePath)) {
      reasons.push(`license file is missing or unsafe: ${String(relativePath)}`)
    } else if (config.finalProjectLicense && /(?:draft|template)/i.test(relativePath)) {
      reasons.push(`project license must be final, not a draft/template: ${relativePath}`)
    }
  }
  return reasons
}

function inspectProjectDecision(projectRoot, packageJson, projectDecision, nowMs) {
  const reasons = []
  if (projectDecision?.status !== 'approved')
    reasons.push('project license decision is not approved')
  if (!['open-source', 'proprietary', 'internal'].includes(projectDecision?.releaseMode)) {
    reasons.push('project release mode is missing or unsupported')
  }
  if (
    !isNonEmptyString(projectDecision?.licenseExpression) ||
    projectDecision.licenseExpression !== packageJson.license
  ) {
    reasons.push('package license does not match the project decision')
  }
  if (
    !isNonEmptyString(projectDecision?.licenseFile) ||
    /(?:draft|template)/i.test(projectDecision.licenseFile) ||
    !resolveSafeFile(projectRoot, projectDecision.licenseFile)
  ) {
    reasons.push('final project license/EULA file is missing')
  }
  reasons.push(...inspectApprovalMetadata(projectDecision, nowMs))
  return { complete: reasons.length === 0, reasons }
}

function inspectCudaApprovals(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  const nowMs = options.nowMs ?? Date.now()
  const decisions =
    options.decisions ||
    JSON.parse(fs.readFileSync(path.join(projectRoot, 'legal', 'license-decisions.json'), 'utf8'))
  const packageJson =
    options.packageJson ||
    JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const project = inspectProjectDecision(projectRoot, packageJson, decisions.project, nowMs)
  const components = CUDA_APPROVAL_CONFIG.map((config) => {
    const decision = decisions.components?.[config.id]
    const reasons = []
    if (decision?.status !== 'approved') reasons.push('decision is not approved')
    if (decision?.resolution !== config.resolution) {
      reasons.push(`resolution must be ${config.resolution}`)
    }
    for (const profile of REQUIRED_PROFILES) {
      if (
        !Array.isArray(decision?.permittedProfiles) ||
        !decision.permittedProfiles.includes(profile)
      ) {
        reasons.push(`${profile} profile is not approved`)
      }
    }
    reasons.push(...inspectApprovalMetadata(decision, nowMs))
    reasons.push(...inspectApprovalScope(decision?.approvalScope, config))
    reasons.push(...inspectLicenseFiles(projectRoot, decision, config))
    return {
      id: config.id,
      status: decision?.status || 'missing',
      complete: reasons.length === 0,
      reasons,
    }
  })
  return {
    ok: project.complete && components.every((item) => item.complete),
    project,
    components,
  }
}

function main() {
  const report = inspectCudaApprovals()
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.ok) process.exitCode = 1
}

if (require.main === module) main()

module.exports = {
  CUDA_APPROVAL_CONFIG,
  REQUIRED_PROFILES,
  inspectCudaApprovals,
  isValidApprovalTime,
  resolveSafeFile,
}
