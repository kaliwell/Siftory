const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  MATRIX_LOCALES,
  MATRIX_PROFILES,
  createValidationReport,
  createValidationPlan,
  parseOptions,
  validateReportProfile,
} = require('../scripts/validate-packaged-matrix.cjs')

test('packaged validation matrix covers both profiles and both locales without report collisions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-matrix-'))
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'app', version: '1.0.0', build: { productName: 'App' } }),
  )
  try {
    const plan = createValidationPlan(root)
    assert.deepEqual(
      plan.map((entry) => entry.profile),
      MATRIX_PROFILES,
    )
    assert.deepEqual(Object.keys(plan[0].localeReportPaths), MATRIX_LOCALES)
    assert.notEqual(plan[0].installerPath, plan[1].installerPath)
    assert.notEqual(plan[0].resourceReportPath, plan[1].resourceReportPath)
    assert.notEqual(plan[0].localeReportPaths.en, plan[1].localeReportPaths.en)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('packaged validation report binds evidence to one source commit and clean-state fact', () => {
  const commit = 'A'.repeat(40)
  const report = createValidationReport(
    [{ profile: 'offline' }],
    { commit, worktreeClean: true },
    '2026-08-17T00:00:00.000Z',
  )
  assert.equal(report.schemaVersion, 2)
  assert.equal(report.sourceCommit, commit.toLowerCase())
  assert.equal(report.sourceWorktreeClean, true)
  assert.throws(
    () => createValidationReport([], { commit: 'not-a-commit', worktreeClean: true }),
    /source commit is missing or invalid/,
  )
})

test('packaged validation can resume one already-built profile without weakening defaults', () => {
  assert.deepEqual(parseOptions([]), {
    profiles: MATRIX_PROFILES,
    collectOnly: false,
    skipBuild: false,
  })
  assert.deepEqual(parseOptions(['--profile=offline', '--skip-build']), {
    profiles: ['offline'],
    collectOnly: false,
    skipBuild: true,
  })
  assert.equal(parseOptions(['--collect-only']).collectOnly, true)
  assert.throws(() => parseOptions(['--profile=portable']), /offline or online/)
})

test('packaged validation rejects failed or cross-profile evidence', () => {
  assert.doesNotThrow(() => validateReportProfile({ ok: true, profile: 'online' }, 'online', 'x'))
  assert.doesNotThrow(() =>
    validateReportProfile(
      { ok: true, runtimeCheck: { packagedProvenance: { distributionProfile: 'offline' } } },
      'offline',
      'x',
    ),
  )
  assert.throws(() => validateReportProfile({ ok: false, profile: 'online' }, 'online', 'x'))
  assert.throws(() => validateReportProfile({ ok: true, profile: 'offline' }, 'online', 'x'))
})
