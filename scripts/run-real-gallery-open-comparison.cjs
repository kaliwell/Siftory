'use strict'
// Isolate route dispatch -> cards -> image readiness from OS cursor/actionability
// waits while investigating the noisy cold-open result of the full scroll matrix.
const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process')
const repo = path.resolve(__dirname, '..')
process.chdir(repo)
const file = 'src/components/filemanager/ThumbnailImage.tsx'
const candidate = fs.readFileSync(file, 'utf8')
const baseline = cp.execFileSync('git', ['show', 'cb8d4d5:' + file], { encoding: 'utf8' })
const fixture = JSON.parse(
  fs.readFileSync('artifacts/performance-real-gallery-fixture.json', 'utf8'),
).out
const out = fs.mkdtempSync(path.resolve('artifacts/benchmark/runtime-memory/real-gallery-open-'))
fs.writeFileSync(path.join(out, 'ThumbnailImage.candidate.tsx'), candidate)
let current = candidate
const report = {
  scope:
    'ABBA blocks, two fresh profiles each, 5000 real entries; DOM route dispatch bypasses automation cursor stability checks; app first-open cost still included. Only cached-preview initialization changes.',
  rounds: [],
}
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
function set(text) {
  if (fs.readFileSync(file, 'utf8') !== current) throw new Error('Concurrent edit')
  fs.writeFileSync(file, text)
  current = text
}
function run(args, log, env = {}) {
  const fd = fs.openSync(path.join(out, log), 'w')
  try {
    const r = cp.spawnSync(process.execPath, args, {
      cwd: repo,
      env: { ...process.env, ...env },
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      timeout: 300000,
    })
    if (r.status !== 0) throw new Error(log + ' failed')
  } finally {
    fs.closeSync(fd)
  }
}
try {
  for (const [i, variant] of ['before', 'candidate', 'candidate', 'before'].entries()) {
    set(variant === 'before' ? baseline : candidate)
    run([npm, 'run', 'build:renderer:checked'], i + '-build.log')
    for (let n = 0; n < 2; n++) {
      const name = i + '-' + variant + '-' + n
      run(['scripts/run-native-gallery-performance.cjs'], name + '.log', {
        SIFTORY_GALLERY_FIXTURE: fixture,
        SIFTORY_GALLERY_DIAGNOSTICS: '1',
        SIFTORY_GALLERY_COUNTS: '5000',
        SIFTORY_GALLERY_OPEN_ONLY: '1',
        SIFTORY_GALLERY_NAV_DISPATCH: '1',
        SIFTORY_NATIVE_GALLERY_OUTPUT: path.join(out, name),
      })
      const data = JSON.parse(fs.readFileSync(path.join(out, name, 'report.json'), 'utf8'))
        .reports[0]
      if (data.status !== 'passed' || !data.openTiming) throw new Error('Invalid cold-open record')
      report.rounds.push({ variant, name, ...data })
      console.log(
        JSON.stringify({ out, name, readyMs: data.firstViewportReadyMs, stages: data.openTiming }),
      )
      fs.writeFileSync(path.join(out, 'comparison.json'), JSON.stringify(report, null, 2))
    }
  }
} finally {
  set(candidate)
  run([npm, 'run', 'build:renderer:checked'], 'restored-build.log')
}
