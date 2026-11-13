const fs = require('fs'),
  path = require('path'),
  cp = require('child_process'),
  file = 'src/utils/boundedBatchScheduler.ts',
  optimized = fs.readFileSync(file, 'utf8'),
  baseline = cp.execFileSync('git', ['show', 'cb8d4d5:' + file], { encoding: 'utf8' }),
  npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
function run(args, log, env = {}) {
  const fd = fs.openSync(log, 'w')
  try {
    const r = cp.spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      timeout: 300000,
    })
    if (r.status !== 0) throw new Error(log + ' failed ' + r.status)
  } finally {
    fs.closeSync(fd)
  }
}
fs.writeFileSync(file, baseline)
const restoreExperimentSource1 = () => {
  if (fs.readFileSync(file, 'utf8') !== baseline)
    throw new Error('Concurrent scheduler edit; restore skipped')
  fs.writeFileSync(file, optimized)
  run(
    [npm, 'run', 'build:renderer:checked'],
    'artifacts/performance-native-gallery-restored-build.log',
  )
}
try {
  run(
    [npm, 'run', 'build:renderer:checked'],
    'artifacts/performance-native-gallery-before-build.log',
  )
  run(
    ['scripts/run-native-gallery-performance.cjs'],
    'artifacts/performance-native-gallery-before.log',
    {
      SIFTORY_NATIVE_GALLERY_OUTPUT:
        'artifacts/benchmark/runtime-memory/native-gallery-before-20261107',
    },
  )
} finally {
  restoreExperimentSource1()
}
