const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const packageJson = require('../package.json')
const manifest = require('../resources/runtime-manifest.json')
const decisions = require('../legal/license-decisions.json')
const { inspectLicenseCompliance } = require('../scripts/check-license-compliance.cjs')

const root = path.resolve(__dirname, '..')

test('current offline distribution excludes user-supplied slots and blocks bundled decisions', () => {
  const report = inspectLicenseCompliance({ projectRoot: root, profile: 'offline' })
  assert.equal(report.ok, false)
  assert.equal(report.profile, 'offline')
  assert.equal(report.bundledComponentCount, 6)
  assert.equal(report.componentBlockers.length, 6)
  assert.deepEqual(
    report.excludedPendingComponents.map((component) => component.id),
    [
      'ultralytics-yolov8n-coco-onnx',
      'lindevs-yolov8n-face-onnx',
      'cvlface-adaface-ir101-webface12m-onnx',
      'osnet-ain-x1-msmt17-onnx',
      'pulpcut-mobilesam-onnx',
      'microsoft-onnxruntime-gpu-windows-1-24-3',
      'nvidia-cuda-12-8-embedding-runtime',
      'nvidia-cudnn-9-19-1-cuda12-runtime',
      'floating-clock-cuda-embedding-worker',
      'sensevoice-small-funasr-external-audio-semantic-model',
      'fsmn-vad-campplus-funasr-external-diarization-models',
      'ollama-0-32-9-windows-x64-external-test-runtime',
      'qwen3-vl-2b-q4-k-m-ollama-external-test-model',
      'llama-cpp-b10441-windows-x64-managed-video-runtime-candidate',
      'qwen3-vl-2b-instruct-q4-k-m-gguf-managed-runtime-candidate',
    ],
  )
  assert.deepEqual(report.projectBlockers, [])
  assert.equal(packageJson.private, true)
  assert.equal(packageJson.license, 'Apache-2.0')
  assert.equal(decisions.project.releaseMode, 'open-source')
  assert.equal(decisions.project.licenseExpression, 'Apache-2.0')
  assert.equal(decisions.project.licenseFile, 'LICENSE')
  assert.doesNotMatch(report.projectBlockers.join('\n'), /release mode is missing/)
  assert.doesNotMatch(report.projectBlockers.join('\n'), /package\.json license does not match/)
  assert.ok(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').includes('Apache License'))
  assert.equal(require('../legal/end-user-terms/manifest.json').status, 'open-source')
})

test('online distribution excludes model and tool decisions but still requires project approval', () => {
  const report = inspectLicenseCompliance({ projectRoot: root, profile: 'online' })
  assert.equal(report.ok, false)
  assert.equal(report.bundledComponentCount, 2)
  assert.deepEqual(
    report.componentBlockers.map((blocker) => blocker.id),
    ['floating-clock-fast-scanner-electron', 'adobe-source-han-sans-cn-vf-2-005'],
  )
  assert.equal(report.excludedPendingComponents.length, manifest.components.length - 2)
})

test('license CLI uses the shared profile selection while keeping unresolved approvals blocked', () => {
  const env = { ...process.env }
  delete env.FLOATING_CLOCK_PACKAGE_PROFILE
  for (const [args, overrides, profile, count] of [
    [[], {}, 'online', 2],
    [[], { FLOATING_CLOCK_PACKAGE_PROFILE: 'offline' }, 'offline', 6],
    [['--profile=online'], { FLOATING_CLOCK_PACKAGE_PROFILE: 'offline' }, 'online', 2],
    [['--profile=offline'], { FLOATING_CLOCK_PACKAGE_PROFILE: 'online' }, 'offline', 6],
  ]) {
    const result = spawnSync(process.execPath, ['scripts/check-license-compliance.cjs', ...args], {
      cwd: root,
      env: { ...env, ...overrides },
      encoding: 'utf8',
      shell: false,
    })
    assert.equal(result.status, 1, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.profile, profile)
    assert.equal(report.bundledComponentCount, count)
    assert.equal(report.ok, false)
    assert.deepEqual(report.projectBlockers, [])
  }
})

test('an approved fixture must bind project and component decisions to real license files', () => {
  const approved = structuredClone(decisions)
  const approvedAt = '2026-08-01T00:00:00.000Z'
  approved.project = {
    status: 'approved',
    releaseMode: 'open-source',
    licenseExpression: 'MIT',
    licenseFile: 'THIRD_PARTY_NOTICES.md',
    approvedBy: 'fixture-reviewer',
    approvedAt,
    evidence: ['fixture-evidence'],
  }
  for (const decision of Object.values(approved.components)) {
    Object.assign(decision, {
      status: 'approved',
      resolution: 'upstream-license',
      permittedProfiles: ['offline', 'online'],
      approvedBy: 'fixture-reviewer',
      approvedAt,
      evidence: ['fixture-evidence'],
      licenseFiles: ['THIRD_PARTY_NOTICES.md'],
    })
  }
  const report = inspectLicenseCompliance({
    projectRoot: root,
    packageJson: { ...packageJson, license: 'MIT' },
    manifest,
    decisions: approved,
  })
  assert.equal(report.ok, true)
  assert.deepEqual(report.projectBlockers, [])
  assert.deepEqual(report.componentBlockers, [])
})

test('approval metadata cannot bypass missing files, profile scope, or unknown components', () => {
  const broken = structuredClone(decisions)
  broken.components.unknown = { status: 'approved' }
  broken.components['floating-clock-fast-scanner-electron'] = {
    status: 'approved',
    resolution: 'project-license',
    permittedProfiles: ['offline'],
    approvedBy: 'fixture-reviewer',
    approvedAt: '2026-08-01T00:00:00.000Z',
    evidence: ['fixture-evidence'],
    licenseFiles: ['legal/missing.txt'],
  }
  const report = inspectLicenseCompliance({
    projectRoot: root,
    profile: 'online',
    decisions: broken,
  })
  assert.match(report.projectBlockers.join('\n'), /unknown components/)
  assert.match(report.componentBlockers[0].reasons.join('\n'), /online profile/)
  assert.match(report.componentBlockers[0].reasons.join('\n'), /license files/)
})

test('an approved component still requires at least one license file', () => {
  const broken = structuredClone(decisions)
  broken.components['floating-clock-fast-scanner-electron'] = {
    status: 'approved',
    resolution: 'project-license',
    permittedProfiles: ['online'],
    approvedBy: 'fixture-reviewer',
    approvedAt: '2026-08-01T00:00:00.000Z',
    evidence: ['fixture-evidence'],
    licenseFiles: [],
  }
  const report = inspectLicenseCompliance({
    projectRoot: root,
    profile: 'online',
    decisions: broken,
  })
  assert.match(report.componentBlockers[0].reasons.join('\n'), /license files/)
})

test('a draft or template EULA can never satisfy the project release gate', () => {
  const approved = structuredClone(decisions)
  approved.project = {
    status: 'approved',
    releaseMode: 'proprietary',
    licenseExpression: 'UNLICENSED',
    licenseFile: 'legal/PROPRIETARY-EULA.template.md',
    approvedBy: 'fixture-reviewer',
    approvedAt: '2026-08-01T00:00:00.000Z',
    evidence: ['fixture-evidence'],
  }
  const report = inspectLicenseCompliance({
    projectRoot: root,
    profile: 'online',
    decisions: approved,
  })
  assert.match(report.projectBlockers.join('\n'), /license or EULA file is missing/)
})

function withFinalTermsFixture(run) {
  const tempParent = fs.realpathSync(os.tmpdir())
  const projectRoot = fs.mkdtempSync(path.join(tempParent, 'license-final-terms-'))
  const termsDirectory = path.join(projectRoot, 'legal', 'end-user-terms')
  fs.mkdirSync(termsDirectory, { recursive: true })
  fs.writeFileSync(path.join(projectRoot, 'THIRD_PARTY_NOTICES.md'), 'Automated test notices.\n')
  const document = 'Automated test agreement. This fixture does not grant any real license.\n'
  fs.writeFileSync(path.join(termsDirectory, 'EULA.en.txt'), document)
  const termsManifest = {
    schemaVersion: 1,
    status: 'final',
    title: 'Automated test agreement',
    version: 'test-1',
    publisher: 'Automated Test Publisher',
    effectiveDate: '2026-09-25',
    documents: [
      {
        path: 'EULA.en.txt',
        sha256: crypto.createHash('sha256').update(document).digest('hex'),
      },
    ],
  }
  const save = () =>
    fs.writeFileSync(
      path.join(termsDirectory, 'manifest.json'),
      `${JSON.stringify(termsManifest, null, 2)}\n`,
    )
  save()
  const approved = structuredClone(decisions)
  const approval = {
    status: 'approved',
    approvedBy: 'fixture-reviewer',
    approvedAt: '2026-09-25T00:00:00.000Z',
    evidence: ['automated-fixture-only'],
  }
  Object.assign(approved.project, approval, {
    releaseMode: 'proprietary',
    licenseExpression: 'UNLICENSED',
    licenseFile: 'legal/end-user-terms/EULA.en.txt',
  })
  for (const decision of Object.values(approved.components)) {
    Object.assign(decision, approval, {
      resolution: 'upstream-license',
      permittedProfiles: ['online', 'offline'],
      licenseFiles: ['THIRD_PARTY_NOTICES.md'],
    })
  }
  const packageFixture = {
    ...packageJson,
    license: 'UNLICENSED',
    build: {
      extraResources: [{ from: 'legal/end-user-terms', to: 'legal/end-user-terms' }],
    },
  }
  const inspect = () =>
    inspectLicenseCompliance({
      projectRoot,
      profile: 'online',
      packageJson: packageFixture,
      manifest,
      decisions: approved,
    })
  try {
    run({ inspect, termsManifest, save, termsDirectory, packageFixture, approved })
  } finally {
    assert.equal(path.dirname(path.resolve(projectRoot)), tempParent)
    assert.match(path.basename(projectRoot), /^license-final-terms-/)
    fs.rmSync(projectRoot, { recursive: true, force: true })
  }
}

test('proprietary release requires the approved EULA in validated final displayed terms', () => {
  withFinalTermsFixture(({ inspect, approved }) => {
    const report = inspect()
    assert.equal(report.ok, true, report.projectBlockers.join('\n'))
    assert.deepEqual(report.projectBlockers, [])
    approved.project.licenseFile = 'THIRD_PARTY_NOTICES.md'
    assert.match(inspect().projectBlockers.join('\n'), /EULA must be a document/)
  })
})

test('review status and invalid final term payloads remain blocked despite approval metadata', () => {
  withFinalTermsFixture(({ inspect, termsManifest, save, termsDirectory }) => {
    termsManifest.status = 'review'
    save()
    assert.match(inspect().projectBlockers.join('\n'), /end-user terms remain in review/)
    termsManifest.status = 'final'
    save()
    fs.appendFileSync(path.join(termsDirectory, 'EULA.en.txt'), 'Altered after approval.\n')
    assert.match(
      inspect().projectBlockers.join('\n'),
      /end-user terms are missing, unsafe, or invalid/,
    )
    fs.writeFileSync(path.join(termsDirectory, 'manifest.json'), '{broken json')
    assert.match(
      inspect().projectBlockers.join('\n'),
      /end-user terms are missing, unsafe, or invalid/,
    )
  })
})

test('a valid final agreement must be copied fully into the expected packaged location', () => {
  withFinalTermsFixture(({ inspect, packageFixture }) => {
    for (const resources of [
      [],
      [{ from: 'legal/end-user-terms', to: 'legal/elsewhere' }],
      [{ from: 'legal/elsewhere', to: 'legal/end-user-terms' }],
      [{ from: 'legal/end-user-terms', to: 'legal/end-user-terms', filter: ['manifest.json'] }],
      [
        { from: 'legal/end-user-terms', to: 'legal/end-user-terms' },
        { from: 'legal/elsewhere', to: 'legal/end-user-terms' },
      ],
    ]) {
      packageFixture.build.extraResources = resources
      assert.match(inspect().projectBlockers.join('\n'), /end-user terms must be copied completely/)
    }
  })
})
