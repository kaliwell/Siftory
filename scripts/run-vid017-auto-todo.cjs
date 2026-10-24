#!/usr/bin/env node

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { isApprovalMetadataComplete } = require('./check-license-compliance.cjs')

const TASKS = [
  [
    'VAL-301..303,305',
    [
      'node',
      '--test',
      'tests/video-semantic-llama-installer.test.cjs',
      'tests/llama-cpp-video-semantic-runtime.test.cjs',
      'tests/video-semantic-runtime.test.cjs',
      'tests/video-semantic-prompt.test.cjs',
    ],
  ],
  ['VAL-304', ['node', 'scripts/run-video-semantic-llama-soak.cjs', '--reuse-valid']],
  ['VAL-306', ['node', 'scripts/report-video-semantic-llama-health.cjs']],
  ['VAL-307', ['node', 'scripts/manage-video-semantic-llama-cache.cjs', '--verify']],
  [
    'VAL-308,311',
    [
      'node',
      '--test',
      'tests/video-semantic-schema.test.cjs',
      'tests/llama-cpp-video-semantic-runtime.test.cjs',
    ],
  ],
  ['VAL-309', ['node', 'scripts/run-video-semantic-llama-exclusion-matrix.cjs']],
  ['VAL-310', ['node', 'scripts/generate-vid017-approval-packet.cjs', '--check']],
  ['VAL-312', ['node', 'scripts/report-video-semantic-llama-performance.cjs', '--check']],
]

function assertBoundary(projectRoot = path.resolve(__dirname, '..')) {
  const decisions = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'legal', 'license-decisions.json'), 'utf8'),
  )
  if (TASKS.some(([id]) => /VAL-313|VAL-314/.test(id)))
    throw new Error('Automation must not execute approval or packaged-distribution tasks')
  if (decisions.project?.status === 'approved' && !isApprovalMetadataComplete(decisions.project))
    throw new Error('Project approval requires recorded owner evidence')
  return true
}

function main() {
  assertBoundary()
  if (process.argv.includes('--dry-run')) {
    process.stdout.write(
      `${JSON.stringify({ tasks: TASKS.map(([id]) => id), excluded: ['VAL-313', 'VAL-314'] }, null, 2)}\n`,
    )
    return
  }
  for (const [id, [command, ...args]] of TASKS) {
    process.stdout.write(`\n[VID-017] ${id}\n`)
    const result = spawnSync(command, args, {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      shell: false,
    })
    if (result.status !== 0) throw new Error(`${id} failed with exit ${result.status}`)
  }
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
module.exports = { TASKS, assertBoundary }
