'use strict'
const fs = require('fs'),
  path = require('path'),
  cp = require('child_process')
const files = [
  'src/hooks/useManagedSearchModels.ts',
  'src/components/ImageSearchPanel.tsx',
  'src/components/MediaSearchPanel.tsx',
  'src/utils/boundedBatchScheduler.ts',
]
const optimized = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]))
const baseline = new Map(
  files.map((f) => [f, cp.execFileSync('git', ['show', 'cb8d4d5:' + f], { encoding: 'utf8' })]),
)
const out = path.resolve('artifacts/benchmark/runtime-memory/final-comparison-20261107')
fs.mkdirSync(out, { recursive: true })
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
function run(args, log, env = {}) {
  const fd = fs.openSync(path.join(out, log), 'w')
  try {
    const r = cp.spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      timeout: 600000,
    })
    if (r.status !== 0) throw new Error(log + ' failed ' + r.status)
  } finally {
    fs.closeSync(fd)
  }
}
let current = optimized
const restoreExperimentSource1 = () => {
  for (const f of files) {
    if (fs.readFileSync(f, 'utf8') !== current.get(f))
      throw new Error('Concurrent edit; restore refused ' + f)
    fs.writeFileSync(f, optimized.get(f))
  }
  run([npm, 'run', 'build:renderer:checked'], 'restored-build.log')
}
try {
  for (const [label, contents] of [
    ['before', baseline],
    ['after', optimized],
  ]) {
    for (const f of files) {
      if (fs.readFileSync(f, 'utf8') !== current.get(f))
        throw new Error('Concurrent source edit ' + f)
      fs.writeFileSync(f, contents.get(f))
    }
    current = contents
    console.log(JSON.stringify({ step: 'build', label }))
    run([npm, 'run', 'build:renderer:checked'], label + '-build.log')
    console.log(JSON.stringify({ step: 'measure', label }))
    run(['scripts/run-workspace-performance-baseline.cjs'], label + '-measure.log', {
      SIFTORY_PERFORMANCE_FIRST_RUN: '1',
      SIFTORY_PERFORMANCE_IDLE_MS: '60000',
      SIFTORY_PERFORMANCE_SETTLE_MS: '10000',
      SIFTORY_PERFORMANCE_OUTPUT: path.join(out, label),
    })
  }
} finally {
  restoreExperimentSource1()
}
