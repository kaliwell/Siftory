const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { inspectVid017Preflight } = require('../scripts/run-video-semantic-llama-preflight.cjs')

const root = path.resolve(__dirname, '..')

test('VID-017 preflight separates completed engineering work from approval gates', () => {
  const report = inspectVid017Preflight(root)
  assert.equal(report.taskId, 'VID-017')
  assert.equal(report.foundation.ready, true)
  assert.equal(report.foundation.adapterImplemented, true)
  assert.equal(report.foundation.packagedActivationFactoryImplemented, true)
  assert.equal(report.foundation.adapterTestsRegistered, true)
  assert.equal(report.foundation.runtimeManifestValid, true)
  assert.equal(report.foundation.pendingCandidatesExcludedFromOnlineAndOffline, true)
  assert.equal(report.approvals.projectLicenseReady, false)
  assert.equal(report.approvals.runtimeRedistributionReady, false)
  assert.equal(report.approvals.modelRedistributionReady, false)
  assert.equal(report.payloads.runtimeArchiveDownloaded, false)
  assert.equal(report.payloads.modelAndProjectorDownloaded, false)
  assert.equal(report.activationReady, false)
  assert.equal(report.releaseReady, false)
  assert.equal(report.nextAction, 'obtain-explicit-runtime-model-license-and-distribution-approval')
})

test('VID-017 preflight output contains no absolute local path or credential material', () => {
  const output = JSON.stringify(inspectVid017Preflight(root))
  assert.doesNotMatch(output, /[A-Z]:\\/i)
  assert.doesNotMatch(output, /apiKey|authorization|Bearer/i)
})

test('VID-017 preflight reports valid local-only installation and smoke without exposing paths', (t) => {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vid017-preflight-'))
  t.after(() => fs.rmSync(localRoot, { recursive: true, force: true }))
  const runtimeRoot = path.join(localRoot, 'runtime')
  const smokeReportPath = path.join(localRoot, 'smoke.json')
  const soakReportPath = path.join(localRoot, 'soak.json')
  const exclusionMatrixReportPath = path.join(localRoot, 'matrix.json')
  fs.mkdirSync(runtimeRoot)
  const serverSha256 = '4'.repeat(64)
  const modelSha256 = '089d75c52f4b7ffc56ba998ffc50aae89fcafc755f9e7208aacca281dca6c2ae'
  const projectorSha256 = 'f9a68fabba69c3b81e153367b2c7521030b0fa8bb0de400c9599c8e6725f9c82'
  fs.writeFileSync(
    path.join(runtimeRoot, 'installation-receipt.json'),
    JSON.stringify({
      schemaVersion: 1,
      scope: 'local-evaluation-only',
      redistributionApproved: false,
      packagedByDefault: false,
      runtime: {
        release: 'b10441',
        commit: '0177dcc7300bad8914bb838baabce87899812491',
        variant: 'vulkan-x64',
        server: { sha256: serverSha256 },
      },
      model: {
        revision: '52d6c8ffea26cc873ac5ad116f8631268d7eb503',
        sha256: modelSha256,
      },
      projector: { sha256: projectorSha256 },
    }),
  )
  fs.writeFileSync(
    smokeReportPath,
    JSON.stringify({
      taskId: 'VID-017',
      scope: 'local-evaluation-only',
      runtime: { serverSha256 },
      model: { sha256: modelSha256, projectorSha256 },
      runtimeStatus: { state: 'ready' },
      sample: { frameCount: 4 },
      latencyMs: 21_185,
      parsed: true,
      ok: true,
    }),
  )
  fs.writeFileSync(
    soakReportPath,
    JSON.stringify({
      taskId: 'VID-017',
      scope: 'local-evaluation-only',
      runtime: { serverSha256 },
      model: { sha256: modelSha256, projectorSha256 },
      runtimeStatus: { state: 'ready' },
      summary: {
        attempted: 6,
        passed: 6,
        strictJson: 6,
        p95LatencyMs: 11_831,
        maximumGpuUsedMiB: 2_774,
      },
      sidecarStopped: true,
      ok: true,
    }),
  )
  fs.writeFileSync(
    exclusionMatrixReportPath,
    JSON.stringify({
      taskId: 'VID-017',
      matrixKind: 'pre-release-unapproved-resource-exclusion',
      profiles: [
        { profile: 'online', excluded: true },
        { profile: 'offline', excluded: true },
      ],
      packageConfiguration: {
        forbiddenReferenceCount: 0,
        approvedDescriptorPresent: false,
        repositoryPayloadCount: 0,
      },
      formalPackagedRuntimeMatrixExecuted: false,
      ok: true,
    }),
  )

  const report = inspectVid017Preflight(root, {
    runtimeRoot,
    smokeReportPath,
    soakReportPath,
    exclusionMatrixReportPath,
  })
  assert.equal(report.payloads.runtimeArchiveDownloaded, true)
  assert.equal(report.payloads.modelAndProjectorDownloaded, true)
  assert.equal(report.payloads.scope, 'local-evaluation-only')
  assert.equal(report.validation.realInferenceExecuted, true)
  assert.equal(report.validation.strictJson, true)
  assert.equal(report.validation.soakExecuted, true)
  assert.equal(report.validation.soakRounds, 6)
  assert.equal(report.validation.soakP95LatencyMs, 11_831)
  assert.equal(report.validation.soakMaximumGpuUsedMiB, 2_774)
  assert.equal(report.validation.unapprovedExclusionMatrixExecuted, true)
  assert.equal(report.validation.packagedMatrixExecuted, false)
  assert.equal(report.activationReady, false)
  assert.equal(report.releaseReady, false)
  const output = JSON.stringify(report)
  assert.doesNotMatch(output, /vid017-preflight-|installation-receipt|smoke\.json/i)
})
