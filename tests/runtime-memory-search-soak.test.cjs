'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { parseArgs, resultDigest } = require('../scripts/run-runtime-memory-search-soak.cjs')

test('search soak accepts one continuous process range up to ten thousand queries', () => {
  assert.equal(parseArgs([]).cycles, 1000)
  assert.equal(parseArgs(['--cycles=10000', '--query-count=16']).queryCount, 16)
  assert.throws(() => parseArgs(['--cycles=0']), /between 1 and 10000/)
})

test('search soak result digest is stable and path-order sensitive', () => {
  const first = resultDigest([{ path: 'C:/a.jpg' }, { path: 'C:/b.jpg' }])
  const same = resultDigest({ results: [{ path: 'c:\\A.jpg' }, { path: 'c:\\B.jpg' }] })
  const reversed = resultDigest([{ path: 'C:/b.jpg' }, { path: 'C:/a.jpg' }])
  assert.equal(first, same)
  assert.notEqual(first, reversed)
  assert.throws(() => resultDigest({ candidateCount: 0 }), /no result list/)
})
