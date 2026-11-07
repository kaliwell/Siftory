'use strict'
const fs = require('fs'),
  path = require('path'),
  os = require('os')
const { _electron } = require('playwright')
const {
  createSmokeSessionMarker,
  createSmokeSpawnEnvironment,
} = require('../tests/smoke-test-utils.cjs')
const { startRuntimeMemorySampler } = require('./runtime-memory-process-sampler.cjs')
const root = path.resolve('artifacts/benchmark/image-fixture-20261107'),
  out = path.resolve('artifacts/benchmark/runtime-memory/thumbnail-standard-v2-20261107')
;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')))
  const reports = []
  const temp = fs.realpathSync.native(os.tmpdir())
  process.env.TEMP = temp
  process.env.TMP = temp
  for (const count of [5000, 10000]) {
    const profile = fs.mkdtempSync(path.join(temp, 'siftory-thumb-performance-'))
    const nonce = createSmokeSessionMarker(profile, 'packaged')
    let app, sampler
    const report = {
      count,
      scope:
        'Generated JPEG fixture; real preload/IPC and thumbnail service; two batch callers, six requests per batch, 256px; no gallery scrolling or model workload.',
      passes: [],
      errors: [],
    }
    try {
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
      page.on('pageerror', (e) => report.errors.push(e.message))
      await page.locator('[data-testid="app-root"][data-ready="true"]').waitFor({ timeout: 30000 })
      sampler = await startRuntimeMemorySampler({
        rootPid: app.process().pid,
        outputFile: path.join(out, 'samples-' + count + '.jsonl'),
        readyFile: path.join(out, 'ready-' + count),
        stopFile: path.join(out, 'stop-' + count),
        intervalMs: 1000,
      })
      await page.exposeFunction('benchmarkProgress', (n) =>
        console.log(JSON.stringify({ count, completed: n })),
      )
      for (const pass of ['first-profile-pass', 'repeat-profile-pass']) {
        const value = await Promise.race([
          page.evaluate(
            async (files) => {
              const start = performance.now()
              let cursor = 0,
                ok = 0,
                failed = 0,
                totalBytes = 0
              async function worker() {
                while (cursor < files.length) {
                  const batch = files
                    .slice(cursor, (cursor += 6))
                    .map((filePath) => ({ path: filePath, maxDim: 256 }))
                  const rows = await window.electronAPI.fmGetThumbnailsBatch(batch)
                  for (const row of rows) {
                    if (row.dataUrl) {
                      ok++
                      totalBytes += row.dataUrl.length
                    } else failed++
                  }
                  if ((ok + failed) % 600 === 0) await window.benchmarkProgress(ok + failed)
                }
              }
              await Promise.all([worker(), worker()])
              return {
                ms: performance.now() - start,
                ok,
                failed,
                totalDataUrlCharacters: totalBytes,
              }
            },
            manifest.files.slice(0, count).map((f) => path.join(root, f.name)),
          ),
          new Promise((_, reject) => {
            const t = setTimeout(() => reject(new Error('Thumbnail benchmark timed out')), 600000)
            t.unref()
          }),
        ])
        report.passes.push({ pass, ...value })
        console.log(JSON.stringify({ count, pass, ...value }))
        if (value.ok !== count || value.failed) throw new Error('Thumbnail results incomplete')
      }
      report.status = report.errors.length ? 'failed' : 'passed'
    } catch (e) {
      report.status = 'failed'
      report.error = String(e.stack || e)
    } finally {
      if (sampler) {
        const samples = await sampler.stop()
        report.processSampleCount = samples.length
        report.peakWorkingSetMiB =
          Math.max(...samples.map((r) => r.aggregate.workingSetBytes)) / 1048576
      }
      if (app) {
        const child = app.process()
        let closeTimer
        try {
          await Promise.race([
            app.close(),
            new Promise((r) => {
              closeTimer = setTimeout(() => {
                if (child.exitCode === null) child.kill()
                r()
              }, 15000)
            }),
          ])
        } finally {
          clearTimeout(closeTimer)
        }
      }
      reports.push(report)
      fs.writeFileSync(
        path.join(out, 'report.json'),
        JSON.stringify({ manifestScope: manifest.scope, reports }, null, 2),
      )
    }
    if (report.status !== 'passed') {
      process.exitCode = 1
      break
    }
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
