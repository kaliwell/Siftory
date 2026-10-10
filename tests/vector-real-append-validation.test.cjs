const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  CONFIRMATION,
  assertExecutionAuthorized,
  parseArgs,
  validateUncommittedTailRecovery,
} = require('../scripts/validate-real-vector-append.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-real-vector-validation-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const files = {
    f16: path.join(root, 'delta.f16'),
    paths: path.join(root, 'delta.paths.jsonl'),
    commit: path.join(root, 'delta.json'),
  }
  fs.writeFileSync(files.f16, Buffer.from([1, 2, 3, 4]))
  fs.writeFileSync(files.paths, '{"row":1,"path":"fixture"}\n', 'utf8')
  fs.writeFileSync(files.commit, '{"deltaCount":1}', 'utf8')
  return files
}

test('real append command is preview-only unless the exact confirmation is present', () => {
  const preview = parseArgs(['C:\\fixture', '--model=dinov2_vitb14', '--count=9'])
  assert.equal(preview.execute, false)
  assert.equal(preview.count, 4)
  assert.doesNotThrow(() => assertExecutionAuthorized(preview))
  assert.throws(
    () => assertExecutionAuthorized({ ...preview, execute: true, confirm: 'wrong' }),
    /requires --confirm/,
  )
  assert.doesNotThrow(() =>
    assertExecutionAuthorized({ ...preview, execute: true, confirm: CONFIRMATION }),
  )
})

test('uncommitted tail recovery must restore every committed file exactly', async (t) => {
  const files = fixture(t)
  const before = Object.fromEntries(
    Object.entries(files).map(([name, filePath]) => [name, fs.readFileSync(filePath)]),
  )
  const report = await validateUncommittedTailRecovery(files, () => {
    fs.truncateSync(files.f16, before.f16.length)
    fs.truncateSync(files.paths, before.paths.length)
  })
  assert.equal(report.exactCommittedSnapshotRestored, true)
  for (const [name, filePath] of Object.entries(files)) {
    assert.deepEqual(fs.readFileSync(filePath), before[name])
  }
})

test('failed recovery restores the safety backup before surfacing the error', async (t) => {
  const files = fixture(t)
  const before = Object.fromEntries(
    Object.entries(files).map(([name, filePath]) => [name, fs.readFileSync(filePath)]),
  )
  await assert.rejects(
    validateUncommittedTailRecovery(files, () => {
      fs.rmSync(files.f16)
      throw new Error('injected recovery failure')
    }),
    /committed delta was restored/,
  )
  for (const [name, filePath] of Object.entries(files)) {
    assert.deepEqual(fs.readFileSync(filePath), before[name])
  }
})
