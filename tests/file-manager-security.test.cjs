// ── Security-oriented negative tests ─────────────────────────
// Verifies that path guards reject invalid / dangerous input.
// Complements guards.test.cjs which focuses on positive cases.

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')

const guards = loadTsModule('electron/pathGuards.ts')

test('safeShellPath rejects invalid input', () => {
  // Null / undefined / empty
  assert.strictEqual(guards.safeShellPath(null), null)
  assert.strictEqual(guards.safeShellPath(undefined), null)
  assert.strictEqual(guards.safeShellPath(''), null)
  assert.strictEqual(guards.safeShellPath('   '), null)

  // Non-string
  assert.strictEqual(guards.safeShellPath(123), null)
  assert.strictEqual(guards.safeShellPath({ path: 'C:\\test' }), null)
  assert.strictEqual(guards.safeShellPath(['C:\\test']), null)
  assert.strictEqual(guards.safeShellPath(true), null)
  assert.strictEqual(guards.safeShellPath('bad\0path'), null)
  assert.strictEqual(guards.safeShellPath('https://example.com/file.txt'), null)
  assert.strictEqual(guards.safeShellPath('file:///C:/Windows/notepad.exe'), null)
})

test('safeShellPath normalizes valid paths', () => {
  const result = guards.safeShellPath('C:\\Windows\\..\\Users')
  assert.ok(result !== null)
  assert.ok(result.includes('Users'))
  assert.ok(!result.includes('..'))
})

test('openSafeShellPath and revealSafeShellPath gate shell access', async () => {
  const opened = []
  const revealed = []
  const shell = {
    async openPath(targetPath) {
      opened.push(targetPath)
      return ''
    },
    showItemInFolder(targetPath) {
      revealed.push(targetPath)
    },
  }

  assert.deepStrictEqual(await guards.openSafeShellPath(shell, 'https://example.com/a'), {
    ok: false,
    error: 'Invalid path',
  })
  assert.deepStrictEqual(guards.revealSafeShellPath(shell, 'file:///C:/Windows/notepad.exe'), {
    ok: false,
    error: 'Invalid path',
  })
  assert.equal(opened.length, 0)
  assert.equal(revealed.length, 0)

  const openResult = await guards.openSafeShellPath(shell, 'C:\\Windows\\..\\Users')
  const revealResult = guards.revealSafeShellPath(shell, 'C:\\Windows\\..\\Users')
  assert.equal(openResult.ok, true)
  assert.equal(revealResult.ok, true)
  assert.equal(opened.length, 1)
  assert.equal(revealed.length, 1)
})

test('normalizeUserPath rejects dangerous input', () => {
  assert.strictEqual(guards.normalizeUserPath(''), null)
  assert.strictEqual(guards.normalizeUserPath('  '), null)
  assert.strictEqual(guards.normalizeUserPath(null), null)
  assert.strictEqual(guards.normalizeUserPath(undefined), null)
  assert.strictEqual(guards.normalizeUserPath(0), null)
  assert.strictEqual(guards.normalizeUserPath(false), null)
})

test('normalizePathList rejects non-array input', () => {
  assert.deepStrictEqual(guards.normalizePathList(null), [])
  assert.deepStrictEqual(guards.normalizePathList(undefined), [])
  assert.deepStrictEqual(guards.normalizePathList('C:\\test'), [])
  assert.deepStrictEqual(guards.normalizePathList(123), [])
  assert.deepStrictEqual(guards.normalizePathList({}), [])
})

test('normalizePathList deduplicates paths', () => {
  const result = guards.normalizePathList(['C:\\tmp\\a', 'C:\\tmp\\a', 'C:\\tmp\\b'])
  assert.strictEqual(result.length, 2)
})

test('normalizePathList filters invalid entries', () => {
  const result = guards.normalizePathList(['C:\\tmp\\a', '', null, '  ', 123, 'C:\\tmp\\b'])
  assert.strictEqual(result.length, 2)
})

test('normalizePathList enforces maxCount', () => {
  const paths = Array.from({ length: 50 }, (_, i) => `C:\\file_${i}.txt`)
  const result = guards.normalizePathList(paths, 10)
  assert.strictEqual(result.length, 10)
})

test('isSameOrNestedPath detects self-copy / self-move', () => {
  // Same path
  assert.strictEqual(guards.isSameOrNestedPath('C:\\tmp\\a', 'C:\\tmp\\a'), true)
  // Nested
  assert.strictEqual(guards.isSameOrNestedPath('C:\\tmp', 'C:\\tmp\\sub'), true)
  assert.strictEqual(guards.isSameOrNestedPath('C:\\tmp', 'C:\\tmp\\sub\\deep'), true)
})

test('isSameOrNestedPath allows unrelated paths', () => {
  assert.strictEqual(guards.isSameOrNestedPath('C:\\tmp', 'C:\\other'), false)
  assert.strictEqual(guards.isSameOrNestedPath('C:\\tmp\\a', 'C:\\tmp\\b'), false)
})

test('normalizeConflictOption defaults to overwrite for invalid input', () => {
  assert.strictEqual(guards.normalizeConflictOption(null), 'overwrite')
  assert.strictEqual(guards.normalizeConflictOption(undefined), 'overwrite')
  assert.strictEqual(guards.normalizeConflictOption('rename'), 'overwrite')
  assert.strictEqual(guards.normalizeConflictOption(123), 'overwrite')
  assert.strictEqual(guards.normalizeConflictOption({}), 'overwrite')
})

test('normalizeConflictOption accepts valid rename', () => {
  assert.strictEqual(guards.normalizeConflictOption({ conflict: 'rename' }), 'rename')
})
