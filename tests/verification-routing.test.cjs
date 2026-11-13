const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { testsFor, summarizeTimings, unitTestFiles } = require('../scripts/verify.cjs')
for (const [file, expected] of [
  ['electron/projectPreviewManifest.ts', 'tests/project-preview.test.cjs'],
  ['src/components/filemanager/ThumbnailImage.tsx', 'tests/thumbnail-policy.test.cjs'],
  ['src/components/SettingsPanel.tsx', 'tests/settings-store.test.cjs'],
  ['src/components/WorkspaceNavigator.tsx', 'tests/workspace-navigation.test.cjs'],
  ['electron/assetLibraryService.ts', 'tests/asset-library.test.cjs'],
  ['src/components/MediaSearchPanel.tsx', 'tests/media-search-guards.test.cjs'],
  ['scripts/validate-staged-snapshot.cjs', 'tests/git-policy.test.cjs'],
])
  test(`changed verification routes ${file} without full regression`, () => {
    const plan = testsFor([file])
    assert.equal(plan.broad, false)
    assert.ok(plan.tests.includes(expected))
    assert.ok(
      plan.tests.every((file) => fs.existsSync(path.join(__dirname, '..', file))),
      'all selected tests must exist',
    )
  })
test('overlapping routes deduplicate tests and do not pull unrelated modules', () => {
  const plan = testsFor(['src/components/SettingsPanel.tsx', 'src/hooks/settingsWriter.ts'])
  assert.equal(plan.tests.length, 2)
  assert.ok(plan.tests.every((x) => /settings/.test(x)))
})
test('unknown/shared changes explain the CI fallback; docs receive docs checks', () => {
  const shared = testsFor(['shared/ipc-contract.ts'])
  assert.equal(shared.broad, true)
  assert.deepEqual(shared.reasons, ['shared/ipc-contract.ts'])
  const docs = testsFor(['README.md'])
  assert.equal(docs.broad, false)
  assert.equal(docs.docs, true)
  assert.deepEqual(docs.tests, [])
})

test('timing summary distinguishes repeated checks within a run from separate invocations', () => {
  const records = [
    { runId: 'one', command: ['node', 'check'], durationMs: 10, passed: true },
    { runId: 'one', command: ['node', 'check'], durationMs: 30, passed: false },
    { runId: 'two', command: ['node', 'check'], durationMs: 20, passed: true },
    { runId: 'two', command: ['node', 'slow'], durationMs: 80, passed: true },
  ]
  const result = summarizeTimings(records)
  assert.equal(result[0].command, 'node slow')
  assert.deepEqual(result[1], {
    command: 'node check',
    count: 3,
    totalMs: 60,
    maxMs: 30,
    failures: 1,
    repeatedInRun: 1,
    runs: 2,
    meanMs: 20,
  })
})

test('CI deduplication preserves the union of core and workspace tests', () => {
  const scripts = require('../package.json').scripts
  const names = ['test:focused-workspace', 'test:core-behavior']
  const selected = unitTestFiles(scripts, names)
  const original = names.flatMap((name) => scripts[name].slice('node --test '.length).split(/\s+/))
  assert.deepEqual(new Set(selected), new Set(original))
  assert.equal(selected.length, new Set(original).size)
  assert.ok(selected.length < original.length)
  assert.throws(
    () => unitTestFiles({ x: 'node --test tests/a.test.cjs && echo unsafe' }, ['x']),
    /Cannot safely deduplicate/,
  )
})

test('archived experiments receive no automatic execution plan', () => {
  const plan = testsFor(['scripts/experiments/2026-11-07/projectPreview-experiment.cjs'])
  assert.equal(plan.broad, false)
  assert.deepEqual(plan.tests, [])
})
