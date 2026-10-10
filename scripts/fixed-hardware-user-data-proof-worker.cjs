#!/usr/bin/env node

'use strict'

const {
  compactUserDataSnapshot,
  snapshotUserDataRoots,
} = require('./fixed-hardware-user-data-proof.cjs')

const MAX_ARGUMENT_BYTES = 32 * 1024

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || Buffer.byteLength(argv[0], 'utf8') > MAX_ARGUMENT_BYTES) {
    throw new Error('Expected one bounded JSON array containing explicit user-data roots')
  }
  const roots = JSON.parse(argv[0])
  const compact = compactUserDataSnapshot(snapshotUserDataRoots(roots))
  process.stdout.write(JSON.stringify(compact) + '\n')
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  }
}

module.exports = { MAX_ARGUMENT_BYTES, main }
