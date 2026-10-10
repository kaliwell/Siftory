'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { parseArgs } = require('../scripts/run-runtime-memory-scale-benchmark.cjs')

const projectRoot = path.resolve(__dirname, '..')

test('scale benchmark defaults cover one million manifest and 100k/500k vectors', () => {
  const options = parseArgs([], projectRoot)
  assert.equal(options.manifestRows, 1_000_000)
  assert.equal(options.vectorSmallRows, 100_000)
  assert.equal(options.vectorLargeRows, 500_000)
})

test('scale benchmark is synthetic-only and confines output', () => {
  assert.throws(() => parseArgs(['--output-dir=C:\\outside'], projectRoot), /must stay under/)
  assert.throws(
    () => parseArgs(['--vector-small-rows=5000', '--vector-large-rows=1000'], projectRoot),
    /must not exceed/,
  )
  const options = parseArgs(
    ['--manifest-rows=1000', '--vector-small-rows=1000', '--vector-large-rows=5000'],
    projectRoot,
  )
  assert.equal(options.manifestRows, 1000)
  assert.equal(options.vectorLargeRows, 5000)
})
