const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const {
  evaluateCommercialReleaseReadiness,
  inspectCommercialReleaseReadiness,
  isApprovedPolicy,
  isFinalPolicy,
  isPublisherIdentityApproved,
  parseArgs,
} = require('../scripts/check-commercial-release-readiness.cjs')

function readyInput(overrides = {}) {
  const fingerprint = 'a'.repeat(64)
  return {
    profile: 'offline',
    version: '1.0.0',
    commit: 'b'.repeat(40),
    gitStatusOk: true,
    gitStatus: '',
    tags: ['v1.0.0'],
    signingConfigured: true,
    publisherIdentityApproved: true,
    licenseReport: {
      ok: true,
      projectBlockers: [],
      componentBlockers: [],
      bundledComponentCount: 5,
    },
    nekoCurrent: {
      comparability: {
        annotationFingerprint: fingerprint,
        activeSetFingerprint: fingerprint,
        activeSetCount: 100,
      },
    },
    nekoBaseline: {
      comparability: {
        annotationFingerprint: fingerprint,
        activeSetFingerprint: fingerprint,
        activeSetCount: 100,
      },
    },
    packagedReport: {
      ok: true,
      sourceCommit: 'b'.repeat(40),
      sourceWorktreeClean: true,
      profiles: [
        {
          profile: 'offline',
          resources: { ok: true },
          locales: { 'zh-CN': { ok: true }, en: { ok: true } },
        },
      ],
    },
    privacyPolicyApproved: true,
    supportPolicyApproved: true,
    ...overrides,
  }
}

test('commercial readiness passes only when every release line is complete', () => {
  const report = evaluateCommercialReleaseReadiness(readyInput())
  assert.equal(report.ready, true)
  assert.deepEqual(report.summary, { passed: 8, blocked: 0, total: 8 })
})

test('commercial readiness keeps legal, signing, data, and stale evidence blockers explicit', () => {
  const input = readyInput({
    gitStatus: '?? local.txt',
    tags: [],
    signingConfigured: false,
    publisherIdentityApproved: false,
    licenseReport: {
      ok: false,
      projectBlockers: ['pending'],
      componentBlockers: [{ id: 'runtime' }],
      bundledComponentCount: 1,
    },
    nekoCurrent: {
      comparability: {
        annotationFingerprint: 'a'.repeat(64),
        activeSetFingerprint: 'c'.repeat(64),
        activeSetCount: 101,
      },
    },
    packagedReport: { ok: true, profiles: [] },
    privacyPolicyApproved: false,
    supportPolicyApproved: false,
  })
  const report = evaluateCommercialReleaseReadiness(input)
  assert.equal(report.ready, false)
  assert.equal(report.summary.blocked, 8)
  assert.ok(report.checks.every((check) => check.status === 'blocked'))
})

test('draft policy templates can never satisfy the final-policy check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commercial-policy-'))
  try {
    fs.mkdirSync(path.join(dir, 'legal'))
    fs.writeFileSync(
      path.join(dir, 'legal', 'PRIVACY_POLICY.md'),
      '# Policy\n\nDRAFT — NOT FOR DISTRIBUTION\n{{PUBLISHER}}\n',
    )
    assert.equal(isFinalPolicy(dir, 'legal/PRIVACY_POLICY.md'), false)
    fs.writeFileSync(path.join(dir, 'legal', 'PRIVACY_POLICY.md'), '# Approved policy\n')
    assert.equal(isFinalPolicy(dir, 'legal/PRIVACY_POLICY.md'), false)
    fs.writeFileSync(
      path.join(dir, 'legal', 'PRIVACY_POLICY.md'),
      `# Approved privacy policy\n\n${'Substantive reviewed policy content. '.repeat(20)}\n`,
    )
    assert.equal(isFinalPolicy(dir, 'legal/PRIVACY_POLICY.md'), true)
    const decision = {
      status: 'approved',
      file: 'legal/PRIVACY_POLICY.md',
      approvedBy: 'authorized-reviewer',
      approvedAt: '2026-08-17T00:00:00.000Z',
      evidence: ['review-record-1'],
    }
    assert.equal(isApprovedPolicy(dir, decision, 'legal/PRIVACY_POLICY.md'), true)
    assert.equal(isApprovedPolicy(dir, { ...decision, status: 'pending' }, decision.file), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('commercial readiness CLI accepts only known profiles and flags', () => {
  assert.deepEqual(parseArgs(['--profile=online', '--json']), {
    profile: 'online',
    json: true,
  })
  assert.throws(() => parseArgs(['--profile=invalid']), /expected offline or online/)
  assert.throws(() => parseArgs(['--write']), /Unknown commercial readiness argument/)
})

test('commercial readiness uses the shared default and lets CLI profiles override the environment', () => {
  assert.deepEqual(parseArgs([], {}), { profile: 'online', json: false })
  assert.deepEqual(parseArgs([], { FLOATING_CLOCK_PACKAGE_PROFILE: 'offline' }), {
    profile: 'offline',
    json: false,
  })
  assert.deepEqual(
    parseArgs(['--profile=online', '--json'], { FLOATING_CLOCK_PACKAGE_PROFILE: 'offline' }),
    { profile: 'online', json: true },
  )
  assert.deepEqual(parseArgs(['--profile=offline'], { FLOATING_CLOCK_PACKAGE_PROFILE: 'online' }), {
    profile: 'offline',
    json: false,
  })
})

test('readiness inspection applies the chosen profile to real pending component decisions', () => {
  const base = {
    projectRoot: path.resolve(__dirname, '..'),
    gitStatusResult: { ok: true, stdout: '' },
    commitResult: { ok: true, stdout: 'a'.repeat(40) },
    tagResult: { ok: true, stdout: '' },
  }
  for (const [options, profile, componentCount] of [
    [{ env: {} }, 'online', 0],
    [{ env: { FLOATING_CLOCK_PACKAGE_PROFILE: 'offline' } }, 'offline', 6],
    [{ profile: 'offline', env: { FLOATING_CLOCK_PACKAGE_PROFILE: 'online' } }, 'offline', 6],
    [{ profile: 'online', env: { FLOATING_CLOCK_PACKAGE_PROFILE: 'offline' } }, 'online', 0],
  ]) {
    const report = inspectCommercialReleaseReadiness({ ...base, ...options })
    assert.equal(report.profile, profile)
    assert.equal(report.ready, false)
    const legal = report.checks.find((check) => check.id === 'REL-LEGAL')
    assert.equal(legal.status, 'blocked')
    assert.match(legal.detail, new RegExp(`${componentCount} component, publisher=pending`))
  }
})

test('individual publisher selection cannot be mistaken for approved identity evidence', () => {
  const decisions = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '..', 'legal', 'commercial-release-decisions.json'),
      'utf8',
    ),
  )
  assert.equal(decisions.publisher.type, 'individual')
  assert.equal(decisions.publisher.status, 'selected')
  assert.equal(decisions.publisher.publicPublisherName, null)
  assert.equal(isPublisherIdentityApproved(decisions.publisher), false)
  assert.equal(
    isPublisherIdentityApproved({
      ...decisions.publisher,
      status: 'approved',
      publicPublisherName: 'Publisher Name',
      publicContact: 'public-contact@example.invalid',
      releaseTerritories: ['CN'],
      signingIdentity: 'Publisher Name',
      identityEvidenceRef: 'vault:publisher-record-1',
      approvedBy: 'authorized-reviewer',
      approvedAt: '2026-08-17T00:00:00.000Z',
      evidence: ['review-record-1'],
    }),
    true,
  )
})

const approval = {
  approvedBy: 'fixture-reviewer',
  approvedAt: '2026-09-30T00:00:00.000Z',
  evidence: ['fixture-review-record'],
}
const approvedPublisher = {
  ...approval,
  status: 'approved',
  type: 'individual',
  publicPublisherName: 'Fixture Publisher',
  publicContact: 'fixture@example.invalid',
  signingIdentity: 'Fixture Publisher',
  releaseTerritories: ['CN'],
  identityEvidenceRef: 'vault:fixture-identity',
}

function writeFixture(root, relativePath, value) {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value))
}

function readinessFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commercial-readiness-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const input = readyInput()
  writeFixture(root, 'package.json', { version: input.version, license: 'MIT' })
  writeFixture(root, 'resources/runtime-manifest.json', { components: [] })
  writeFixture(root, 'LICENSE', 'Fixture license')
  writeFixture(root, 'legal/license-decisions.json', {
    schemaVersion: 1,
    kind: 'floating-clock-license-decisions',
    project: {
      ...approval,
      status: 'approved',
      releaseMode: 'internal',
      licenseExpression: 'MIT',
      licenseFile: 'LICENSE',
    },
    components: {},
  })
  const policies = {
    privacy: 'legal/PRIVACY_POLICY.md',
    securityAndSupport: 'legal/SECURITY_AND_SUPPORT_POLICY.md',
  }
  for (const policyPath of Object.values(policies)) {
    writeFixture(root, policyPath, `# Reviewed fixture policy\n${'Reviewed terms. '.repeat(30)}`)
  }
  writeFixture(root, 'legal/commercial-release-decisions.json', {
    publisher: approvedPublisher,
    policies: Object.fromEntries(
      Object.entries(policies).map(([key, file]) => [
        key,
        { ...approval, status: 'approved', file },
      ]),
    ),
  })
  writeFixture(root, 'artifacts/neko-search-accuracy/latest.json', input.nekoCurrent)
  writeFixture(root, 'docs/benchmark/neko-search-accuracy-baseline.json', input.nekoBaseline)
  writeFixture(root, 'artifacts/packaged-validation/report.json', input.packagedReport)
  return {
    projectRoot: root,
    profile: 'offline',
    env: { FLOATING_CLOCK_SIGN_COMMAND_JSON: '["fixture-signer","{file}"]' },
    gitStatusResult: { ok: true, stdout: '' },
    commitResult: { ok: true, stdout: input.commit },
    tagResult: { ok: true, stdout: 'v1.0.0\nfixture-review' },
  }
}

test('final policies require reviewed content, a matching file, and complete approval evidence', (t) => {
  const { projectRoot } = readinessFixture(t)
  const policyPath = 'legal/PRIVACY_POLICY.md'
  const decision = { ...approval, status: 'approved', file: policyPath }
  for (const invalid of [
    undefined,
    { ...decision, file: 'legal/OTHER_POLICY.md' },
    { ...decision, approvedBy: '' },
    { ...decision, approvedAt: '' },
    { ...decision, evidence: [] },
    { ...decision, evidence: [''] },
  ]) {
    assert.equal(isApprovedPolicy(projectRoot, invalid, policyPath), false)
  }
  assert.equal(isFinalPolicy(projectRoot, 'legal/MISSING.md'), false)
  assert.equal(isFinalPolicy(projectRoot, 'legal'), false)
  const substantive = 'Reviewed terms. '.repeat(30)
  for (const content of [
    substantive,
    `# Policy\n${substantive}\nDRAFT`,
    `# Policy\n${substantive}\nNOT FOR DISTRIBUTION`,
    `# Policy\n${substantive}\n{{CONTACT}}`,
  ]) {
    writeFixture(projectRoot, policyPath, content)
    assert.equal(isApprovedPolicy(projectRoot, decision, policyPath), false)
  }
  for (const filename of ['PRIVACY_POLICY_DRAFT.md', 'PRIVACY_POLICY_TEMPLATE.md']) {
    writeFixture(projectRoot, `legal/${filename}`, `# Policy\n${substantive}`)
    assert.equal(isFinalPolicy(projectRoot, `legal/${filename}`), false)
  }
})

test('publisher approval rejects every missing public identity and evidence requirement', () => {
  assert.equal(isPublisherIdentityApproved(undefined), false)
  for (const change of [
    { type: 'company' },
    { publicPublisherName: null },
    { publicContact: ' ' },
    { signingIdentity: '' },
    { releaseTerritories: undefined },
    { releaseTerritories: [] },
    { releaseTerritories: [null] },
    { releaseTerritories: [' '] },
    { identityEvidenceRef: undefined },
    { identityEvidenceRef: '/private/path' },
    { approvedBy: '' },
    { approvedAt: '' },
    { evidence: [] },
  ]) {
    assert.equal(isPublisherIdentityApproved({ ...approvedPublisher, ...change }), false)
  }
})

test('missing accuracy and packaged evidence never inherit readiness from other release lines', () => {
  for (const change of [
    { nekoCurrent: null },
    { nekoBaseline: null },
    { nekoCurrent: {} },
    { nekoBaseline: {} },
    { nekoCurrent: { comparability: {} } },
    { nekoBaseline: { comparability: {} } },
    { nekoCurrent: { comparability: { annotationFingerprint: 'different' } } },
    { nekoCurrent: { comparability: { annotationFingerprint: 'a'.repeat(64) } } },
  ]) {
    const report = evaluateCommercialReleaseReadiness(readyInput(change))
    assert.equal(report.ready, false)
    assert.deepEqual(
      report.checks.filter((check) => check.status === 'blocked').map((check) => check.id),
      ['REL-NEKO'],
    )
  }
  const packaged = readyInput().packagedReport
  for (const changedReport of [
    null,
    {},
    { ...packaged, ok: false },
    { ...packaged, sourceCommit: 'stale' },
    { ...packaged, sourceWorktreeClean: false },
    { ...packaged, profiles: [] },
    { ...packaged, profiles: [{ profile: 'online' }] },
    ...[
      {},
      { resources: { ok: false } },
      { resources: { ok: true } },
      { resources: { ok: true }, locales: {} },
      { resources: { ok: true }, locales: { 'zh-CN': { ok: false }, en: { ok: true } } },
      { resources: { ok: true }, locales: { 'zh-CN': { ok: true } } },
      { resources: { ok: true }, locales: { 'zh-CN': { ok: true }, en: { ok: false } } },
    ].map((entry) => ({ ...packaged, profiles: [{ profile: 'offline', ...entry }] })),
  ]) {
    const report = evaluateCommercialReleaseReadiness(readyInput({ packagedReport: changedReport }))
    assert.equal(report.ready, false)
    assert.deepEqual(
      report.checks.filter((check) => check.status === 'blocked').map((check) => check.id),
      ['REL-PACKAGED'],
    )
  }
})

test('inspection binds final policy approvals and valid evidence to the selected release', (t) => {
  const options = readinessFixture(t)
  assert.equal(inspectCommercialReleaseReadiness(options).ready, true)
  const report = inspectCommercialReleaseReadiness({
    ...options,
    gitStatusResult: { ok: false, stdout: '' },
    commitResult: { ok: false, stdout: '' },
    tagResult: { ok: false, stdout: '' },
  })
  assert.equal(report.commit, null)
  assert.deepEqual(
    report.checks.filter((check) => check.status === 'blocked').map((check) => check.id),
    ['REL-SOURCE', 'REL-TAG', 'REL-PACKAGED'],
  )
  assert.equal(
    report.checks.find((check) => check.id === 'REL-SOURCE').detail,
    'unable to inspect Git worktree',
  )
})

test('inspection blocks absent, directory-valued, and malformed JSON evidence', (t) => {
  const options = readinessFixture(t)
  for (const [relativePath, blockedIds] of [
    ['legal/commercial-release-decisions.json', ['REL-LEGAL', 'REL-PRIVACY', 'REL-SUPPORT']],
    ['artifacts/neko-search-accuracy/latest.json', ['REL-NEKO']],
    ['docs/benchmark/neko-search-accuracy-baseline.json', ['REL-NEKO']],
    ['artifacts/packaged-validation/report.json', ['REL-PACKAGED']],
  ]) {
    const file = path.join(options.projectRoot, relativePath)
    const original = fs.readFileSync(file)
    fs.unlinkSync(file)
    for (const state of ['missing', 'directory', 'malformed']) {
      if (state === 'directory') fs.mkdirSync(file)
      if (state === 'malformed') fs.writeFileSync(file, '{')
      const report = inspectCommercialReleaseReadiness(options)
      assert.equal(report.ready, false, `${relativePath}: ${state}`)
      assert.deepEqual(
        report.checks.filter((check) => check.status === 'blocked').map((check) => check.id),
        blockedIds,
      )
      if (state === 'directory') fs.rmdirSync(file)
    }
    fs.writeFileSync(file, original)
  }
})

test('inspection refuses missing or malformed package identity', (t) => {
  const options = readinessFixture(t)
  const file = path.join(options.projectRoot, 'package.json')
  fs.unlinkSync(file)
  assert.throws(
    () => inspectCommercialReleaseReadiness(options),
    /package.json is missing or invalid/,
  )
  fs.writeFileSync(file, '{')
  assert.throws(
    () => inspectCommercialReleaseReadiness(options),
    /package.json is missing or invalid/,
  )
})

test('CLI reports blocked evidence in JSON and text and rejects invalid arguments', (t) => {
  const options = readinessFixture(t)
  const script = path.resolve(__dirname, '../scripts/check-commercial-release-readiness.cjs')
  const env = { ...process.env, ...options.env, FLOATING_CLOCK_PACKAGE_PROFILE: 'offline' }
  for (const args of [['--json'], []]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: options.projectRoot,
      env,
      encoding: 'utf8',
      shell: false,
    })
    assert.equal(result.status, 1, result.stderr)
    if (args.length) {
      const report = JSON.parse(result.stdout)
      assert.equal(report.ready, false)
      assert.equal(report.commit, null)
      assert.equal(report.checks.find((check) => check.id === 'REL-SOURCE').status, 'blocked')
    } else {
      assert.match(result.stdout, /\[PASS\] REL-PRIVACY/)
      assert.match(result.stdout, /\[BLOCKED\] REL-SOURCE/)
    }
  }
  const invalid = spawnSync(process.execPath, [script, '--write'], {
    cwd: options.projectRoot,
    env,
    encoding: 'utf8',
    shell: false,
  })
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /Unknown commercial readiness argument: --write/)
})
