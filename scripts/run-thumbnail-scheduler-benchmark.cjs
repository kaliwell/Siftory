'use strict'
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  { transformSync } = require('esbuild'),
  { _electron } = require('playwright')
const {
  createSmokeSessionMarker,
  createSmokeSpawnEnvironment,
} = require('../tests/smoke-test-utils.cjs')
const { startRuntimeMemorySampler } = require('./runtime-memory-process-sampler.cjs')
const out = path.resolve(
  process.env.SIFTORY_SCHEDULER_OUTPUT ||
    'artifacts/benchmark/runtime-memory/scheduler-before-20261107',
)
const fixture = path.resolve('artifacts/benchmark/image-fixture-20261107')
;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const code = transformSync(fs.readFileSync('src/utils/boundedBatchScheduler.ts', 'utf8'), {
    loader: 'ts',
    format: 'iife',
    globalName: '__SchedulerExports',
  }).code
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'manifest.json')))
  const files = manifest.files.slice(0, 1000).map((f) => path.join(fixture, f.name))
  const reports = []
  const temp = fs.realpathSync.native(os.tmpdir())
  process.env.TEMP = temp
  process.env.TMP = temp
  for (let run = 1; run <= 3; run++) {
    let app, sampler
    const r = { run, passes: [], errors: [] }
    try {
      const profile = fs.mkdtempSync(path.join(temp, 'siftory-scheduler-performance-'))
      const nonce = createSmokeSessionMarker(profile, 'packaged')
      app = await _electron.launch({
        executablePath: require('electron'),
        args: ['.'],
        cwd: process.cwd(),
        chromiumSandbox: true,
        env: createSmokeSpawnEnvironment({
          SIFTORY_PACKAGED_VALIDATION: '1',
          FLOATING_CLOCK_UI_SMOKE_USER_DATA: profile,
          FLOATING_CLOCK_SMOKE_SESSION_NONCE: nonce,
        }),
        timeout: 45000,
      })
      const page = await app.firstWindow()
      page.on('pageerror', (e) => r.errors.push(e.message))
      await page.locator('[data-testid="app-root"][data-ready="true"]').waitFor({ timeout: 30000 })
      sampler = await startRuntimeMemorySampler({
        rootPid: app.process().pid,
        outputFile: path.join(out, 'samples-' + run + '.jsonl'),
        readyFile: path.join(out, 'ready-' + run),
        stopFile: path.join(out, 'stop-' + run),
        intervalMs: 1000,
      })
      await page.evaluate(
        code + ';window.__PerformanceScheduler=__SchedulerExports.BoundedBatchScheduler;',
      )
      for (const pass of ['first-profile-pass', 'repeat-profile-pass']) {
        let deadline
        try {
          const v = await Promise.race([
            page.evaluate(async (files) => {
              const start = performance.now()
              let ok = 0,
                failed = 0,
                characters = 0
              const scheduler = new window.__PerformanceScheduler({
                batchSize: 6,
                delayMs: 24,
                maxQueued: 512,
                keyOf: (r) => r.path,
                loadBatch: async (requests) => {
                  const results = await window.electronAPI.fmGetThumbnailsBatch(requests)
                  return new Map(
                    requests.flatMap((r, i) =>
                      results[i]?.dataUrl ? [[r.path, results[i].dataUrl]] : [],
                    ),
                  )
                },
              })
              for (let i = 0; i < files.length; i += 100) {
                const outputs = await Promise.all(
                  files
                    .slice(i, i + 100)
                    .map((path) => scheduler.request({ path, maxDim: 256 }, { priority: 10 })),
                )
                for (const v of outputs) {
                  if (v) {
                    ok++
                    characters += v.length
                  } else failed++
                }
              }
              return { ms: performance.now() - start, ok, failed, characters }
            }, files),
            new Promise(
              (_, reject) =>
                (deadline = setTimeout(() => reject(new Error('Scheduler pass timeout')), 180000)),
            ),
          ])
          r.passes.push({ pass, ...v })
          console.log(JSON.stringify({ run, pass, ...v }))
          if (v.ok !== 1000 || v.failed) throw new Error('Missing thumbnail output')
        } finally {
          clearTimeout(deadline)
        }
      }
      r.status = r.errors.length ? 'failed' : 'passed'
    } catch (e) {
      r.status = 'failed'
      r.error = String(e.stack || e)
    } finally {
      if (sampler) {
        try {
          const samples = await sampler.stop()
          r.peakWorkingSetMiB =
            Math.max(...samples.map((s) => s.aggregate.workingSetBytes)) / 1048576
        } catch (e) {
          r.status = 'failed'
          r.error = e.message
        }
      }
      if (app) {
        const child = app.process()
        let t
        try {
          await Promise.race([
            app.close(),
            new Promise(
              (resolve) =>
                (t = setTimeout(() => {
                  if (child.exitCode === null) child.kill()
                  resolve()
                }, 15000)),
            ),
          ])
        } finally {
          clearTimeout(t)
        }
      }
      reports.push(r)
      fs.writeFileSync(
        path.join(out, 'report.json'),
        JSON.stringify(
          {
            scope:
              'Actual BoundedBatchScheduler source transpiled for test, six-item batches, 24ms initial delay, 100-item request bursts, same real native IPC and 256px images; fresh isolated profile per run; OS cache uncontrolled.',
            reports,
          },
          null,
          2,
        ),
      )
    }
    if (r.status !== 'passed') {
      process.exitCode = 1
      break
    }
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
