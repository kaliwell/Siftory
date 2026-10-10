const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const {
  packageResourceReferences,
  runExclusionMatrix,
} = require('../scripts/run-video-semantic-llama-exclusion-matrix.cjs')

const root = path.resolve(__dirname, '..')

test('VID-017 pre-release matrix excludes unapproved runtime payloads from both profiles', async () => {
  const report = await runExclusionMatrix(root)
  assert.equal(report.ok, true)
  assert.equal(report.matrixKind, 'pre-release-unapproved-resource-exclusion')
  assert.deepEqual(
    report.profiles.map((profile) => profile.profile),
    ['online', 'offline'],
  )
  assert.equal(
    report.profiles.every((profile) => profile.excluded),
    true,
  )
  assert.equal(report.packageConfiguration.forbiddenReferenceCount, 0)
  assert.equal(report.packageConfiguration.approvedDescriptorPresent, false)
  assert.equal(report.packageConfiguration.repositoryPayloadCount, 0)
  assert.equal(report.formalPackagedRuntimeMatrixExecuted, false)
  assert.doesNotMatch(JSON.stringify(report), /[A-Z]:\\/i)
})

test('package resource normalization covers string and object entries', () => {
  assert.deepEqual(
    packageResourceReferences({
      build: { extraResources: ['one', { from: 'two', to: 'three' }] },
    }),
    ['one', '{"from":"two","to":"three"}'],
  )
})
