const fs = require('fs'),
  cp = require('child_process')
const file = 'src/utils/boundedBatchScheduler.ts',
  optimized = fs.readFileSync(file, 'utf8'),
  baseline = cp.execFileSync('git', ['show', 'cb8d4d5:' + file], { encoding: 'utf8' })
fs.writeFileSync(file, baseline)
const restoreExperimentSource1 = () => {
  if (fs.readFileSync(file, 'utf8') === baseline) fs.writeFileSync(file, optimized)
  else throw new Error('Concurrent scheduler changes; restore skipped')
}
try {
  const log = fs.openSync('artifacts/performance-scheduler-reverse.log', 'w')
  try {
    const r = cp.spawnSync(process.execPath, ['scripts/run-thumbnail-scheduler-benchmark.cjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SIFTORY_SCHEDULER_OUTPUT:
          'artifacts/benchmark/runtime-memory/scheduler-reverse-before-20261107',
      },
      stdio: ['ignore', log, log],
      windowsHide: true,
      timeout: 300000,
    })
    if (r.status !== 0) throw new Error('Reverse benchmark failed ' + r.status)
  } finally {
    fs.closeSync(log)
  }
} finally {
  restoreExperimentSource1()
}
