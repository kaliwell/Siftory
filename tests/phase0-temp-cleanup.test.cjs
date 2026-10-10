const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  listManagedPhase0Targets,
  removeManagedPhase0Target,
  resolveManagedPhase0Target,
} = require('../scripts/cleanup-phase0-temp.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-phase0-cleanup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('Phase 0 cleanup policy accepts only direct managed temp directories', (t) => {
  const root = fixture(t)
  assert.equal(
    resolveManagedPhase0Target(root, path.join(root, 'phase0-corpus-1000k')),
    path.join(root, 'phase0-corpus-1000k'),
  )
  assert.equal(
    resolveManagedPhase0Target(root, path.join(root, 'phase0-index-Ab12_-x')),
    path.join(root, 'phase0-index-Ab12_-x'),
  )
  assert.equal(resolveManagedPhase0Target(root, path.join(root, 'unrelated')), undefined)
  assert.equal(
    resolveManagedPhase0Target(root, path.join(root, 'nested', 'phase0-corpus-1000k')),
    undefined,
  )
  assert.equal(resolveManagedPhase0Target(root, root), undefined)
})

test('Phase 0 cleanup removes managed directories and preserves unrelated entries', (t) => {
  const root = fixture(t)
  const corpus = path.join(root, 'phase0-corpus-5k')
  const index = path.join(root, 'phase0-index-fixture')
  const unrelated = path.join(root, 'keep-me')
  for (const target of [corpus, index, unrelated]) {
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'data.bin'), 'fixture')
  }

  assert.deepEqual(
    listManagedPhase0Targets(root)
      .filter((entry) => entry.managed)
      .map((entry) => path.basename(entry.target))
      .sort(),
    ['phase0-corpus-5k', 'phase0-index-fixture'],
  )
  assert.equal(removeManagedPhase0Target(root, corpus).deleted, true)
  assert.equal(removeManagedPhase0Target(root, index).deleted, true)
  assert.equal(fs.existsSync(unrelated), true)
  assert.equal(removeManagedPhase0Target(root, unrelated).deleted, false)
})

test('Phase 0 cleanup refuses a managed-name symbolic link', (t) => {
  const root = fixture(t)
  const outside = fixture(t)
  const link = path.join(root, 'phase0-corpus-100k')
  try {
    fs.symlinkSync(outside, link, 'junction')
  } catch {
    t.skip('junction creation is unavailable')
    return
  }
  const result = removeManagedPhase0Target(root, link)
  assert.equal(result.deleted, false)
  assert.equal(result.reason, 'symbolic-link')
  assert.equal(fs.existsSync(outside), true)
})
