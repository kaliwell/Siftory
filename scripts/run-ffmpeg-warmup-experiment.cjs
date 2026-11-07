'use strict'
// ABBA startup screening: only FFmpeg warmup yielding changes. Restore source
// and normal build even when measurement fails. No package/user profile edits.
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const repo = path.resolve(__dirname, '..')
process.chdir(repo)
const source = path.join(repo, 'electron/ffmpegService.ts')
const original = fs.readFileSync(source, 'utf8')
const needle = '    try {\n      const [ffmpeg, ffprobe] = await Promise.all(['
if (original.split(needle).length !== 2) throw new Error('Expected one warmup probe block')
const candidate = original.replace(
  needle,
  '    try {\n      // Yield before process spawning and candidate filesystem checks.\n      await new Promise<void>((resolve) => setImmediate(resolve))\n      const [ffmpeg, ffprobe] = await Promise.all([',
)
const out = fs.mkdtempSync(path.join(repo, 'artifacts/benchmark/runtime-memory/ffmpeg-warmup-'))
fs.writeFileSync(path.join(out, 'ffmpeg.original.ts'), original)
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
const rounds = []
let current = original
function run(args, label, env = {}) {
  const fd = fs.openSync(path.join(out, label + '.log'), 'w')
  try {
    const result = cp.spawnSync(process.execPath, args, {
      cwd: repo,
      env: { ...process.env, ...env },
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      timeout: 300000,
    })
    if (result.status !== 0) throw new Error(label + ' failed: ' + result.status)
  } finally {
    fs.closeSync(fd)
  }
}
function setSource(text) {
  if (fs.readFileSync(source, 'utf8') !== current)
    throw new Error('Concurrent source edit; restore refused')
  fs.writeFileSync(source, text)
  current = text
}
try {
  for (const [index, label] of ['before', 'candidate', 'candidate', 'before'].entries()) {
    setSource(label === 'before' ? original : candidate)
    const name = index + '-' + label
    console.log(JSON.stringify({ out, step: 'build', name }))
    run([npm, 'run', 'build:renderer:checked'], name + '-build')
    console.log(JSON.stringify({ out, step: 'measure', name }))
    run(['scripts/run-workspace-performance-baseline.cjs'], name + '-measure', {
      SIFTORY_PERFORMANCE_FIRST_RUN: '1',
      SIFTORY_PERFORMANCE_IDLE_MS: '0',
      SIFTORY_PERFORMANCE_SETTLE_MS: '0',
      SIFTORY_PERFORMANCE_OUTPUT: path.join(out, name),
    })
    const data = JSON.parse(fs.readFileSync(path.join(out, name, 'baseline.json'), 'utf8'))
    if (
      data.results.length !== 3 ||
      data.results.some((r) => r.status !== 'passed' || r.errors.length)
    )
      throw new Error('Invalid measurement round')
    rounds.push({
      name,
      label,
      results: data.results.map((r) => ({
        run: r.run,
        startup: r.startup,
        phases: r.startupPhases,
      })),
    })
    fs.writeFileSync(
      path.join(out, 'comparison.json'),
      JSON.stringify(
        {
          scope:
            'Development startup ABBA, three fresh profiles per block. OS cache and external load uncontrolled; includes 100-switch functional exercise after startup. Not idle-memory evidence.',
          rounds,
        },
        null,
        2,
      ),
    )
  }
} finally {
  setSource(original)
  run([npm, 'run', 'build:renderer:checked'], 'restored-build')
}
