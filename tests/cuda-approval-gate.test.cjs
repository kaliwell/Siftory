const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const currentDecisions = require('../legal/license-decisions.json')
const packageJson = require('../package.json')
const {
  CUDA_APPROVAL_CONFIG,
  inspectCudaApprovals,
  isValidApprovalTime,
} = require('../scripts/check-cuda-approval.cjs')

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuda-approval-gate-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'legal'), { recursive: true })
  return root
}

function approvedFixture(t) {
  const root = fixtureRoot(t)
  const decisions = structuredClone(currentDecisions)
  fs.writeFileSync(path.join(root, 'legal', 'FINAL-EULA.txt'), 'fixture final project license')
  fs.writeFileSync(path.join(root, 'legal', 'UPSTREAM-NOTICES.txt'), 'fixture upstream notices')
  Object.assign(decisions.project, {
    status: 'approved',
    licenseExpression: packageJson.license,
    licenseFile: 'legal/FINAL-EULA.txt',
    approvedBy: 'fixture-authorized-reviewer',
    approvedAt: '2026-08-09T00:00:00.000Z',
    evidence: ['fixture-project-approval-record'],
  })
  for (const config of CUDA_APPROVAL_CONFIG) {
    Object.assign(decisions.components[config.id], {
      status: 'approved',
      resolution: config.resolution,
      permittedProfiles: ['online', 'offline'],
      approvedBy: 'fixture-authorized-reviewer',
      approvedAt: '2026-08-09T00:00:00.000Z',
      evidence: ['fixture-component-approval-record'],
      licenseFiles: ['legal/UPSTREAM-NOTICES.txt'],
      approvalScope: {
        distributionChannels: ['fixture-private-channel'],
        territories: ['fixture-territory'],
        exportEndUseConfirmed: true,
        noticesIncludedConfirmed: true,
        agreementAcceptedConfirmed: true,
        applicationOnlyAccessConfirmed: true,
        materialAdditionalFunctionalityConfirmed: true,
        agreementAcceptanceReference: 'fixture-agreement-reference',
        authorityToLicenseConfirmed: true,
      },
    })
  }
  decisions.components['floating-clock-cuda-embedding-worker'].licenseFiles = [
    'legal/FINAL-EULA.txt',
  ]
  return { root, decisions }
}

test('current pending records remain incomplete with explicit reasons', () => {
  const report = inspectCudaApprovals({
    projectRoot: path.resolve(__dirname, '..'),
    decisions: currentDecisions,
    packageJson,
    nowMs: Date.parse('2026-08-09T12:00:00.000Z'),
  })
  assert.equal(report.ok, false)
  assert.equal(report.project.complete, false)
  assert.equal(report.components.length, 4)
  assert.ok(report.components.every((item) => item.complete === false))
})

test('flipping only status fields cannot bypass approval identity, scope, profile, and files', (t) => {
  const root = fixtureRoot(t)
  const decisions = structuredClone(currentDecisions)
  decisions.project.status = 'approved'
  for (const config of CUDA_APPROVAL_CONFIG) decisions.components[config.id].status = 'approved'
  const report = inspectCudaApprovals({
    projectRoot: root,
    decisions,
    packageJson,
    nowMs: Date.parse('2026-08-09T12:00:00.000Z'),
  })
  assert.equal(report.ok, false)
  assert.match(report.project.reasons.join('\n'), /final project license|reviewer identity/)
  assert.match(report.components[0].reasons.join('\n'), /resolution|profile|license/)
})

test('a complete bounded approval fixture passes every CUDA decision gate', (t) => {
  const { root, decisions } = approvedFixture(t)
  const report = inspectCudaApprovals({
    projectRoot: root,
    decisions,
    packageJson,
    nowMs: Date.parse('2026-08-09T12:00:00.000Z'),
  })
  assert.equal(report.ok, true)
  assert.equal(report.project.complete, true)
  assert.ok(report.components.every((item) => item.complete))
})

test('future timestamps, missing NVIDIA references, and template project licenses fail closed', (t) => {
  const { root, decisions } = approvedFixture(t)
  fs.writeFileSync(path.join(root, 'legal', 'PROJECT.template.txt'), 'not final')
  decisions.project.licenseFile = 'legal/PROJECT.template.txt'
  decisions.components['nvidia-cuda-12-8-embedding-runtime'].approvedAt = '2026-08-10T00:00:00.000Z'
  delete decisions.components['nvidia-cudnn-9-19-1-cuda12-runtime'].approvalScope
    .agreementAcceptanceReference
  const report = inspectCudaApprovals({
    projectRoot: root,
    decisions,
    packageJson,
    nowMs: Date.parse('2026-08-09T12:00:00.000Z'),
  })
  assert.equal(report.ok, false)
  assert.match(report.project.reasons.join('\n'), /final project license/)
  assert.match(
    report.components.find((item) => item.id.includes('cuda-12-8')).reasons.join('\n'),
    /future/,
  )
  assert.match(
    report.components.find((item) => item.id.includes('cudnn')).reasons.join('\n'),
    /acceptance.*reference/,
  )
  assert.equal(isValidApprovalTime('2026-08-09T12:00:00', Date.now()), false)
})
