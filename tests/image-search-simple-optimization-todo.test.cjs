const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { snapshot } = require('../scripts/next-image-search-simple-optimization-task.cjs')

test('Simple mode optimization TODO remains ranked, valid, and automatically selectable', () => {
  const plan = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'docs',
      'current',
      '2026-08-08-image-search-simple-mode-optimization-todo.md',
    ),
    'utf8',
  )
  const result = snapshot(plan)
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.equal(result.counts.total, 9)
  assert.equal(result.next, null)
})
