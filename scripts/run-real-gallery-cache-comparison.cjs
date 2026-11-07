'use strict'
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const repo = path.resolve(__dirname, '..')
process.chdir(repo)
const source = 'src/components/filemanager/ThumbnailImage.tsx'
const candidate = fs.readFileSync(source, 'utf8')
const baseline = cp.execFileSync('git', ['show', 'cb8d4d5:' + source], { encoding: 'utf8' })
const fixture = JSON.parse(
  fs.readFileSync('artifacts/performance-real-gallery-fixture.json', 'utf8'),
).out
const out = fs.mkdtempSync(
  path.join(repo, 'artifacts/benchmark/runtime-memory/real-gallery-cache-comparison-'),
)
fs.writeFileSync(path.join(out, 'ThumbnailImage.candidate.tsx'), candidate)
fs.writeFileSync(path.join(out, 'ThumbnailImage.before.tsx'), baseline)
const report = {
  scope:
    'Only renderer cached-preview initialization changes; six alternating blocks, real fixed image fixture, three isolated runs per variant/catalog size. Other seven production edits remain constant. Source hashing warms OS caches. Normal 100-item library pages, not 10000 simultaneous thumbnails.',
  fixture,
  rounds: [],
}
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
let current = candidate
function restore(text) {
  if (fs.readFileSync(source, 'utf8') !== current)
    throw new Error('Concurrent source edit; restore refused')
  fs.writeFileSync(source, text)
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
    if (r.status !== 0) throw new Error(log + ' failed: ' + r.status)
  } finally {
    fs.closeSync(fd)
  }
}
try {
  for (const [index, variant] of [
    'before',
    'candidate',
    'candidate',
    'before',
    'before',
    'candidate',
  ].entries()) {
    restore(variant === 'before' ? baseline : candidate)
    const name = index + '-' + variant
    console.log(JSON.stringify({ out, name, stage: 'build' }))
    run([npm, 'run', 'build:renderer:checked'], name + '-build.log')
    console.log(JSON.stringify({ out, name, stage: 'measure' }))
    run(['scripts/run-native-gallery-performance.cjs'], name + '-measure.log', {
      SIFTORY_GALLERY_FIXTURE: fixture,
      SIFTORY_GALLERY_DIAGNOSTICS: '1',
      SIFTORY_GALLERY_COUNTS: '1000,5000,10000',
      SIFTORY_NATIVE_GALLERY_OUTPUT: path.join(out, name),
    })
    const result = JSON.parse(fs.readFileSync(path.join(out, name, 'report.json'), 'utf8'))
    if (result.reports.length !== 3 || result.reports.some((r) => r.status !== 'passed'))
      throw new Error('Invalid native gallery round')
    report.rounds.push({ name, variant, reports: result.reports })
    fs.writeFileSync(path.join(out, 'comparison.json'), JSON.stringify(report, null, 2))
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'manifest.json'), 'utf8'))
  for (const file of manifest.files) {
    if (
      crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex') !== file.sha256
    )
      throw new Error('Real source image changed during comparison')
  }
  report.all10000SourceHashesUnchanged = true
  for (const count of [1000, 5000, 10000]) {
    const rows = report.rounds.flatMap((round) => round.reports.filter((r) => r.count === count))
    if (rows.some((r) => JSON.stringify(r.cacheOutputs) !== JSON.stringify(rows[0].cacheOutputs)))
      throw new Error('Encoded cache outputs differ for count ' + count)
  }
  report.cachedOutputHashesIdentical = true
  report.status = 'passed'
  fs.writeFileSync(path.join(out, 'comparison.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({ out, status: report.status, unchangedSources: true, identicalOutputs: true }),
  )
} finally {
  restore(candidate)
  run([npm, 'run', 'build:renderer:checked'], 'restored-candidate-build.log')
}
