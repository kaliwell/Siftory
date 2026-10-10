const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createProfileManifest } = require('./package-profile.cjs')
const { validateRuntimeManifest } = require('./validate-runtime-manifest.cjs')

const RUNTIME_ID = 'llama-cpp-b10441-windows-x64-managed-video-runtime-candidate'
const MODEL_ID = 'qwen3-vl-2b-instruct-q4-k-m-gguf-managed-runtime-candidate'

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function receiptStatus(projectRoot, component) {
  const artifact = component?.artifacts?.[0]
  if (!artifact) return { present: false, digestMatch: false, sizeMatch: false }
  const filePath = path.resolve(projectRoot, artifact.targetPath)
  const withinRoot =
    filePath === projectRoot || filePath.startsWith(`${path.resolve(projectRoot)}${path.sep}`)
  if (!withinRoot || !fs.existsSync(filePath)) {
    return { present: false, digestMatch: false, sizeMatch: false }
  }
  const stat = fs.statSync(filePath)
  return {
    present: true,
    digestMatch: sha256File(filePath) === artifact.sha256,
    sizeMatch: stat.size === artifact.sizeBytes,
  }
}

function dependencyStatus(todoText, id) {
  const row = todoText
    .split(/\r?\n/)
    .find((line) => line.includes(`| ${id} |`) || line.includes(`| ${id.padEnd(7)} |`))
  if (!row) return 'unknown'
  if (/\|\s*verified\s*\|/i.test(row)) return 'verified'
  if (/\|\s*running\s*\|/i.test(row)) return 'running'
  if (/\|\s*blocked\s*\|/i.test(row)) return 'blocked'
  return 'unknown'
}

function localEvaluationStatus(options = {}) {
  if (!options.runtimeRoot || !options.smokeReportPath) {
    return { installed: false, realInferenceExecuted: false, strictJson: false }
  }
  try {
    const receipt = JSON.parse(
      fs.readFileSync(path.join(options.runtimeRoot, 'installation-receipt.json'), 'utf8'),
    )
    const smoke = JSON.parse(fs.readFileSync(options.smokeReportPath, 'utf8'))
    const installed =
      receipt.schemaVersion === 1 &&
      receipt.scope === 'local-evaluation-only' &&
      receipt.redistributionApproved === false &&
      receipt.packagedByDefault === false &&
      receipt.runtime?.release === 'b10441' &&
      receipt.runtime?.commit === '0177dcc7300bad8914bb838baabce87899812491' &&
      receipt.runtime?.variant === 'vulkan-x64' &&
      receipt.model?.revision === '52d6c8ffea26cc873ac5ad116f8631268d7eb503' &&
      receipt.model?.sha256 ===
        '089d75c52f4b7ffc56ba998ffc50aae89fcafc755f9e7208aacca281dca6c2ae' &&
      receipt.projector?.sha256 ===
        'f9a68fabba69c3b81e153367b2c7521030b0fa8bb0de400c9599c8e6725f9c82'
    const realInferenceExecuted =
      installed &&
      smoke.taskId === 'VID-017' &&
      smoke.scope === 'local-evaluation-only' &&
      smoke.runtime?.serverSha256 === receipt.runtime.server.sha256 &&
      smoke.model?.sha256 === receipt.model.sha256 &&
      smoke.model?.projectorSha256 === receipt.projector.sha256 &&
      smoke.runtimeStatus?.state === 'ready' &&
      smoke.ok === true
    let soakExecuted = false
    let soakRounds
    let soakP95LatencyMs
    let soakMaximumGpuUsedMiB
    if (options.soakReportPath) {
      try {
        const soak = JSON.parse(fs.readFileSync(options.soakReportPath, 'utf8'))
        soakExecuted =
          installed &&
          soak.taskId === 'VID-017' &&
          soak.scope === 'local-evaluation-only' &&
          soak.runtime?.serverSha256 === receipt.runtime.server.sha256 &&
          soak.model?.sha256 === receipt.model.sha256 &&
          soak.model?.projectorSha256 === receipt.projector.sha256 &&
          soak.runtimeStatus?.state === 'ready' &&
          soak.summary?.attempted >= 6 &&
          soak.summary?.passed === soak.summary?.attempted &&
          soak.summary?.strictJson === soak.summary?.attempted &&
          soak.sidecarStopped === true &&
          soak.ok === true
        if (soakExecuted) {
          soakRounds = soak.summary.attempted
          soakP95LatencyMs = soak.summary.p95LatencyMs
          soakMaximumGpuUsedMiB = soak.summary.maximumGpuUsedMiB
        }
      } catch {
        soakExecuted = false
      }
    }
    return {
      installed,
      realInferenceExecuted,
      strictJson: realInferenceExecuted && smoke.parsed === true,
      runtimeVariant: installed ? receipt.runtime.variant : undefined,
      frameCount: realInferenceExecuted ? smoke.sample?.frameCount : undefined,
      latencyMs: realInferenceExecuted ? smoke.latencyMs : undefined,
      soakExecuted,
      soakRounds,
      soakP95LatencyMs,
      soakMaximumGpuUsedMiB,
    }
  } catch {
    return { installed: false, realInferenceExecuted: false, strictJson: false }
  }
}

function exclusionMatrixStatus(reportPath) {
  if (!reportPath) return false
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    return (
      report.taskId === 'VID-017' &&
      report.matrixKind === 'pre-release-unapproved-resource-exclusion' &&
      report.ok === true &&
      report.formalPackagedRuntimeMatrixExecuted === false &&
      Array.isArray(report.profiles) &&
      report.profiles.length === 2 &&
      ['online', 'offline'].every((profile) =>
        report.profiles.some((entry) => entry.profile === profile && entry.excluded === true),
      ) &&
      report.packageConfiguration?.forbiddenReferenceCount === 0 &&
      report.packageConfiguration?.approvedDescriptorPresent === false &&
      report.packageConfiguration?.repositoryPayloadCount === 0
    )
  } catch {
    return false
  }
}

function inspectVid017Preflight(projectRoot = path.resolve(__dirname, '..'), localOptions = {}) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'resources', 'runtime-manifest.json'), 'utf8'),
  )
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const decisions = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'legal', 'license-decisions.json'), 'utf8'),
  )
  const todoText = fs.readFileSync(
    path.join(projectRoot, 'docs', 'current', '2026-08-14-video-semantic-index-todo.md'),
    'utf8',
  )
  const byId = new Map(manifest.components.map((component) => [component.id, component]))
  const runtime = byId.get(RUNTIME_ID)
  const model = byId.get(MODEL_ID)
  const online = createProfileManifest(manifest, 'online')
  const offline = createProfileManifest(manifest, 'offline')
  const profileState = (profile, id) =>
    profile.components.find((component) => component.id === id)?.distribution?.defaultBundled
  const decisionFor = (id) => decisions.components?.[id]
  const approvalReady = (id) => {
    const decision = decisionFor(id)
    return (
      decision?.status === 'approved' &&
      typeof decision?.approvedBy === 'string' &&
      decision.approvedBy.trim().length > 0 &&
      typeof decision?.approvedAt === 'string' &&
      Array.isArray(decision?.licenseFiles) &&
      decision.licenseFiles.length > 0
    )
  }

  const adapterFile = path.join(projectRoot, 'electron', 'llamaCppVideoSemanticRuntime.ts')
  const adapterTest = path.join(projectRoot, 'tests', 'llama-cpp-video-semantic-runtime.test.cjs')
  const factoryFile = path.join(projectRoot, 'electron', 'videoSemanticRuntimeFactory.ts')
  const factoryTest = path.join(projectRoot, 'tests', 'video-semantic-runtime-factory.test.cjs')
  const mediaSearchTests = String(packageJson.scripts?.['test:media-search'] || '')
  const testRegistered =
    mediaSearchTests.includes('llama-cpp-video-semantic-runtime.test.cjs') &&
    mediaSearchTests.includes('video-semantic-runtime-factory.test.cjs')
  const manifestValidation = validateRuntimeManifest(manifest)
  const runtimeReceipt = receiptStatus(projectRoot, runtime)
  const modelReceipt = receiptStatus(projectRoot, model)
  const pendingExcluded = [online, offline].every(
    (profile) =>
      profileState(profile, RUNTIME_ID) === false && profileState(profile, MODEL_ID) === false,
  )
  const foundationReady =
    fs.existsSync(adapterFile) &&
    fs.existsSync(adapterTest) &&
    fs.existsSync(factoryFile) &&
    fs.existsSync(factoryTest) &&
    testRegistered &&
    manifestValidation.ok &&
    runtimeReceipt.present &&
    runtimeReceipt.digestMatch &&
    runtimeReceipt.sizeMatch &&
    modelReceipt.present &&
    modelReceipt.digestMatch &&
    modelReceipt.sizeMatch &&
    pendingExcluded
  const runtimeApprovalReady = approvalReady(RUNTIME_ID)
  const modelApprovalReady = approvalReady(MODEL_ID)
  const projectLicenseReady =
    decisions.project?.status === 'approved' && packageJson.license !== 'UNLICENSED'
  const runtimePayloadReady = false
  const modelPayloadReady = false
  const localEvaluation = localEvaluationStatus(localOptions)
  const unapprovedExclusionMatrixExecuted = exclusionMatrixStatus(
    localOptions.exclusionMatrixReportPath,
  )
  const activationReady =
    foundationReady &&
    runtimeApprovalReady &&
    modelApprovalReady &&
    runtimePayloadReady &&
    modelPayloadReady

  return {
    schemaVersion: 1,
    taskId: 'VID-017',
    generatedAt: new Date().toISOString(),
    foundation: {
      adapterImplemented: fs.existsSync(adapterFile),
      packagedActivationFactoryImplemented: fs.existsSync(factoryFile),
      adapterTestsRegistered:
        fs.existsSync(adapterTest) && fs.existsSync(factoryTest) && testRegistered,
      runtimeManifestValid: manifestValidation.ok,
      runtimeReceipt,
      modelReceipt,
      pendingCandidatesExcludedFromOnlineAndOffline: pendingExcluded,
      ready: foundationReady,
    },
    dependencies: {
      VID_012: dependencyStatus(todoText, 'VID-012'),
      VID_016: dependencyStatus(todoText, 'VID-016'),
    },
    approvals: {
      projectLicenseReady,
      runtimeRedistributionReady: runtimeApprovalReady,
      modelRedistributionReady: modelApprovalReady,
    },
    payloads: {
      runtimeArchiveDownloaded: runtimePayloadReady || localEvaluation.installed,
      extractedExecutableDigestRecorded: localEvaluation.installed,
      modelAndProjectorDownloaded: modelPayloadReady || localEvaluation.installed,
      scope: localEvaluation.installed ? 'local-evaluation-only' : 'none',
    },
    validation: {
      realInferenceExecuted: localEvaluation.realInferenceExecuted,
      strictJson: localEvaluation.strictJson,
      frameCount: localEvaluation.frameCount,
      latencyMs: localEvaluation.latencyMs,
      soakRounds: localEvaluation.soakRounds,
      soakP95LatencyMs: localEvaluation.soakP95LatencyMs,
      soakMaximumGpuUsedMiB: localEvaluation.soakMaximumGpuUsedMiB,
      packagedMatrixExecuted: false,
      unapprovedExclusionMatrixExecuted,
      soakExecuted: localEvaluation.soakExecuted,
    },
    activationReady,
    releaseReady: false,
    nextAction: activationReady
      ? 'run-real-inference-and-packaged-matrix'
      : 'obtain-explicit-runtime-model-license-and-distribution-approval',
  }
}

function main() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const report = inspectVid017Preflight(path.resolve(__dirname, '..'), {
    runtimeRoot: path.join(
      appData,
      'floating-clock-electron',
      'runtimes',
      'video-semantic-llama-cpp',
    ),
    smokeReportPath: path.join(
      appData,
      'floating-clock-electron',
      'media-search',
      'semantic',
      'benchmarks',
      'llama-cpp-local-smoke',
      'report.json',
    ),
    soakReportPath: path.join(
      appData,
      'floating-clock-electron',
      'media-search',
      'semantic',
      'benchmarks',
      'llama-cpp-local-soak',
      'report.json',
    ),
    exclusionMatrixReportPath: path.join(
      path.resolve(__dirname, '..'),
      'artifacts',
      'vid017',
      'llama-cpp-exclusion-matrix.json',
    ),
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (process.argv.includes('--strict') && !report.activationReady) process.exitCode = 1
}

if (require.main === module) main()

module.exports = { exclusionMatrixStatus, inspectVid017Preflight, localEvaluationStatus }
