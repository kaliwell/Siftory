const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { resolveSelectionRange } = loadTsModule('src/utils/selectionRange.ts')

test('resolves inclusive selection ranges in both directions', () => {
  const ids = [11, 22, 33, 44, 55]

  assert.deepEqual(resolveSelectionRange(ids, 22, 55), [22, 33, 44, 55])
  assert.deepEqual(resolveSelectionRange(ids, 55, 22), [22, 33, 44, 55])
})

test('does not create a range without a valid visible anchor', () => {
  const ids = [11, 22, 33]

  assert.equal(resolveSelectionRange(ids, null, 33), null)
  assert.equal(resolveSelectionRange(ids, 99, 33), null)
  assert.equal(resolveSelectionRange(ids, 11, 99), null)
})
