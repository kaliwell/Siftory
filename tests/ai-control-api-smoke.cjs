const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  captureDirectoryState,
  createIsolatedRealSemanticSnapshot,
  createSmokeSessionMarker,
  createSmokeSpawnEnvironment,
} = require('./smoke-test-utils.cjs')

const root = path.resolve(__dirname, '..')
const packaged = process.argv.includes('--packaged')
const realSemantic = process.argv.includes('--real-semantic')
const electronPath = packaged
  ? path.join(root, 'release', 'win-unpacked', 'Siftory.exe')
  : require('electron')
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ai-control-smoke-'))
const userDataPath = path.join(temporaryRoot, 'user-data')
const reportPath = path.join(temporaryRoot, 'report.json')
let sourceVectorDb = ''
let sourceModelDirectory = ''
let productionVectorState
let productionModelState

try {
  const smokeSessionNonce = createSmokeSessionMarker(userDataPath, 'ai-control')
  if (realSemantic) {
    sourceVectorDb = path.join(process.env.APPDATA || '', 'floating-clock-electron', 'vector-db')
    assert.equal(
      fs.existsSync(sourceVectorDb),
      true,
      `Vector database not found: ${sourceVectorDb}`,
    )
    productionVectorState = captureDirectoryState(sourceVectorDb)
    const dependencyRoot = path.dirname(fs.realpathSync(path.join(root, 'node_modules')))
    sourceModelDirectory =
      process.env.FLOATING_CLOCK_AI_CONTROL_SMOKE_MODEL_SOURCE?.trim() ||
      path.join(dependencyRoot, 'ai-models', 'clip_vit_base_patch32')
    productionModelState = captureDirectoryState(sourceModelDirectory)
    const isolated = createIsolatedRealSemanticSnapshot(
      sourceVectorDb,
      path.join(userDataPath, 'vector-db'),
      sourceModelDirectory,
    )
    assert.ok(isolated.count >= 78_000, `Isolated CLIP cache is too small: ${isolated.count}`)
  }
  assert.equal(fs.existsSync(electronPath), true, `Smoke executable not found: ${electronPath}`)
  const electronArgs = packaged ? [] : ['.']
  const result = spawnSync(electronPath, electronArgs, {
    cwd: root,
    env: createSmokeSpawnEnvironment({
      FLOATING_CLOCK_AI_CONTROL_SMOKE_REPORT: reportPath,
      FLOATING_CLOCK_UI_SMOKE_USER_DATA: userDataPath,
      FLOATING_CLOCK_SMOKE_SESSION_NONCE: smokeSessionNonce,
      FLOATING_CLOCK_REQUIRE_SANDBOX: '1',
      VITE_DEV_SERVER_URL: '',
      ...(realSemantic && {
        FLOATING_CLOCK_AI_CONTROL_SMOKE_SEMANTIC_QUERY: 'night city',
      }),
    }),
    encoding: 'utf8',
    timeout: realSemantic ? 120_000 : 45_000,
    windowsHide: true,
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(fs.existsSync(reportPath), true, 'AI control smoke report was not written')
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  assert.equal(
    report.ok,
    true,
    `${JSON.stringify(report, null, 2)}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
  )
  assert.equal(report.before.enabled, false)
  assert.equal(report.before.running, false)
  assert.equal(report.enabled.running, true)
  assert.equal(report.unauthorizedStatus, 401)
  assert.ok(report.capabilityCount >= 10)
  assert.equal(report.openApiStatus, 200)
  assert.equal(report.openApiVersion, '3.1.0')
  assert.equal(report.semanticImageSearchDocumented, true)
  assert.equal(report.folderStatsDocumented, true)
  assert.equal(report.directLargeFilesDocumented, true)
  assert.equal(report.largeFilesDocumented, true)
  assert.equal(report.confirmationStatus, 428)
  assert.equal(report.predictableConfirmationStatus, 403)
  assert.equal(report.confirmationApproved, true)
  assert.equal(report.confirmedWriteStatus, 202)
  assert.equal(report.idempotentReplayStatus, 202)
  assert.equal(report.idempotentReplayMatched, true)
  assert.equal(report.idempotencyConflictStatus, 409)
  assert.equal(report.confirmedWriteJobState, 'succeeded')
  assert.equal(report.actionStatus, 202)
  assert.equal(report.jobState, 'succeeded')
  assert.deepEqual(report.rotatedTokenScopes, ['read', 'search'])
  assert.equal(report.oldTokenAfterRotationStatus, 401)
  assert.equal(report.oldJobAfterRotationStatus, 404)
  assert.equal(report.scopedWindowCapabilityVisible, false)
  assert.equal(report.scopeDeniedStatus, 403)
  if (realSemantic) {
    assert.equal(report.semanticImageActionStatus, 202)
    assert.equal(report.semanticImageJobState, 'succeeded')
    assert.ok(report.semanticImageTotalCandidates >= 78_000)
    assert.ok(report.semanticImageReturnedCount > 0)
    assert.equal(report.semanticImageResultContainsLocalPath, false)
  }

  const stored = JSON.parse(fs.readFileSync(path.join(userDataPath, 'ai-control.json'), 'utf8'))
  assert.equal(typeof stored.encryptedToken, 'string')
  assert.ok(stored.encryptedToken.length > 40)
  assert.deepEqual(stored.tokenScopes, ['read', 'search'])
  assert.equal('token' in stored, false)
  const audit = fs.readFileSync(path.join(userDataPath, 'ai-control-audit.jsonl'), 'utf8')
  assert.match(audit, /"outcome":"confirmation_approved"/)
  assert.doesNotMatch(audit, /Bearer |encryptedToken|"token":/)
  console.log(JSON.stringify(report, null, 2))
} finally {
  try {
    if (sourceVectorDb && productionVectorState) {
      assert.deepEqual(
        captureDirectoryState(sourceVectorDb),
        productionVectorState,
        'Production vector-db changed during isolated semantic smoke',
      )
    }
    if (sourceModelDirectory && productionModelState) {
      assert.deepEqual(
        captureDirectoryState(sourceModelDirectory),
        productionModelState,
        'Production semantic model files changed during isolated semantic smoke',
      )
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
}
