'use strict'
// Explicit child exit codes avoid PowerShell's classification of normal native
// build stderr. Packaging does not publish or install the application.
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const repo = path.resolve(__dirname, '..')
process.chdir(repo)
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
const report = { startedAt: new Date().toISOString(), status: 'running', steps: [] }
const productionFiles = [
  'electron/ffmpegService.ts',
  'src/hooks/useManagedSearchModels.ts',
  'src/components/ImageSearchPanel.tsx',
  'src/components/MediaSearchPanel.tsx',
  'src/utils/boundedBatchScheduler.ts',
  'src/components/AppStoragePanel.tsx',
  'src/components/AutomaticMaintenancePanel.tsx',
  'src/components/filemanager/ThumbnailImage.tsx',
]
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
report.productionSourceHashes = Object.fromEntries(
  productionFiles.map((file) => [file, hash(file)]),
)
const reportFile = path.join(repo, 'artifacts/performance-candidate-validation.json')
const resumeBrowserSetup = process.argv.includes('--resume-browser-setup')
if (resumeBrowserSetup) {
  const prior = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
  if (
    prior.steps.length !== 3 ||
    prior.steps[0].name !== 'typecheck' ||
    prior.steps[0].exitCode !== 0 ||
    prior.steps[1].name !== 'focused-workspace' ||
    prior.steps[1].exitCode !== 0 ||
    prior.steps[2].name !== 'focused-browser' ||
    prior.steps[2].exitCode === 0
  )
    throw new Error('Expected only the browser setup to have failed')
  fs.writeFileSync(reportFile + '.browser-setup-failure', JSON.stringify(prior, null, 2))
  report.steps.push(...prior.steps.slice(0, 2))
  report.resumedAfterBrowserSetupFailure = true
}
function save() {
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
}
function run(name, args) {
  for (const file of productionFiles) {
    if (hash(file) !== report.productionSourceHashes[file])
      throw new Error('Source changed during validation: ' + file)
  }
  const log = path.join(repo, 'artifacts/performance-candidate-' + name + '.log')
  const fd = fs.openSync(log, 'w')
  const startedAt = Date.now()
  let result
  try {
    result = cp.spawnSync(process.execPath, args, {
      cwd: repo,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      timeout: 900000,
    })
  } finally {
    fs.closeSync(fd)
  }
  const step = {
    name,
    exitCode: result.status,
    error: result.error?.message,
    ms: Date.now() - startedAt,
    log: path.relative(repo, log),
  }
  report.steps.push(step)
  save()
  console.log(JSON.stringify(step))
  if (result.status !== 0) throw new Error(name + ' failed')
}
try {
  save()
  if (!resumeBrowserSetup) {
    run('typecheck', [npm, 'run', 'typecheck'])
    run('focused-workspace', [npm, 'run', 'test:focused-workspace'])
  }
  run('focused-browser', [npm, 'run', 'test:focused-workspace:browser'])
  run('maintenance-browser', ['tests/automatic-maintenance-lifecycle-browser.cjs'])
  run('thumbnail-cache-browser', ['tests/thumbnail-cache-lifecycle-browser.cjs'])
  run('targeted-regression', [
    '--test',
    'tests/ffmpeg-warmup-lifecycle.test.cjs',
    'tests/thumbnail-request-scheduler.test.cjs',
    'tests/workspace-performance-soak-policy.test.cjs',
    'tests/runtime-memory-process-sampler.test.cjs',
    'tests/media-search-guards.test.cjs',
    'tests/media-player-export.test.cjs',
  ])
  run('lint', ['node_modules/eslint/bin/eslint.js', ...productionFiles])
  run('online-build', [npm, 'run', 'build:online'])
  run('packaged-launch', ['tests/packaged-launch-smoke.cjs'])
  report.packagedAsarSha256 = hash('release/win-unpacked/resources/app.asar')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error.stack
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  save()
}
