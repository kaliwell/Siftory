const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { safeEval } = loadTsModule('src/services/safeEval.ts')

test('safeEval handles arithmetic precedence and parentheses', () => {
  assert.equal(safeEval('1 + 2 * 3'), 7)
  assert.equal(safeEval('(1 + 2) * 3'), 9)
  assert.equal(safeEval('10 / 2 + 3'), 8)
  assert.equal(safeEval('-2 * (3 + 4)'), -14)
})

test('safeEval accepts calculator operator glyphs', () => {
  assert.equal(safeEval('6脳7'), 42)
  assert.equal(safeEval('8梅2'), 4)
  assert.equal(safeEval('8−2'), 6)
})

test('safeEval rejects invalid or unsafe expressions', () => {
  assert.equal(Number.isNaN(safeEval('')), true)
  assert.equal(Number.isNaN(safeEval('1 / 0')), true)
  assert.equal(Number.isNaN(safeEval('Math.max(1,2)')), true)
  assert.equal(Number.isNaN(safeEval('process.exit()')), true)
  assert.equal(Number.isNaN(safeEval('1 + ')), true)
  assert.equal(Number.isNaN(safeEval('(1 + 2')), true)
})
