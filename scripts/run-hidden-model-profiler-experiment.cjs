const fs = require('fs'),
  cp = require('child_process')
const file = 'src/hooks/useManagedSearchModels.ts',
  optimized = fs.readFileSync(file, 'utf8'),
  baseline = cp.execFileSync('git', ['show', 'cb8d4d5:' + file], { encoding: 'utf8' })
let current = optimized
const restoreExperimentSource1 = () => {
  if (fs.readFileSync(file, 'utf8') === current) fs.writeFileSync(file, optimized)
  else throw new Error('Concurrent hook change; restore skipped')
}
try {
  for (const [name, source] of [
    ['before', baseline],
    ['after', optimized],
  ]) {
    if (fs.readFileSync(file, 'utf8') !== current) throw new Error('Concurrent hook edit')
    current = source
    fs.writeFileSync(file, source)
    console.log(name)
    const log = fs.openSync('artifacts/performance-profiler-' + name + '.log', 'w')
    try {
      const r = cp.spawnSync(process.execPath, ['scripts/measure-hidden-model-poll.cjs'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SIFTORY_POLL_OUTPUT: 'artifacts/performance-profiler-' + name + '.json',
        },
        stdio: ['ignore', log, log],
        windowsHide: true,
        timeout: 120000,
      })
      if (r.status !== 0) throw new Error('Profiler ' + name + ' failed ' + r.status)
    } finally {
      fs.closeSync(log)
    }
  }
} finally {
  restoreExperimentSource1()
}
