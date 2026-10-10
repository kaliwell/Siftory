const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { renderApprovalPacket } = require('../scripts/generate-vid017-approval-packet.cjs')
const { TASKS, assertBoundary } = require('../scripts/run-vid017-auto-todo.cjs')

test('approval packet reports pending state and never manufactures approval evidence', () => {
  const report = renderApprovalPacket(path.resolve(__dirname, '..'))
  assert.match(report, /pending/)
  assert.match(report, /不构成批准/)
  assert.doesNotMatch(report, /approvedBy|已批准/)
})

test('automation excludes the legal approval and packaged-distribution gates', () => {
  assert.equal(assertBoundary(path.resolve(__dirname, '..')), true)
  const ids = TASKS.map(([id]) => id).join(',')
  assert.doesNotMatch(ids, /VAL-313|VAL-314/)
})
