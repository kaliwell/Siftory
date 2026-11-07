'use strict'
// Standard-window performance measurement, isolated with the existing smoke nonce gate.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { _electron } = require('playwright')
const {
  createSmokeSessionMarker,
  createSmokeSpawnEnvironment,
} = require('../tests/smoke-test-utils.cjs')
const output = path.resolve(
  process.env.SIFTORY_PERFORMANCE_OUTPUT ||
    'artifacts/benchmark/runtime-memory/standard-window-v4-20261107',
)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const { startRuntimeMemorySampler } = require('./runtime-memory-process-sampler.cjs')
let activeSampleFile
async function snapshot() {
  for (let retry = 0; retry < 30; retry++) {
    const lines = fs.existsSync(activeSampleFile)
      ? fs.readFileSync(activeSampleFile, 'utf8').trim().split('\n')
      : []
    for (const line of lines.reverse()) {
      try {
        const r = JSON.parse(line)
        return {
          at: Date.parse(r.sampledAt),
          processes: r.processes.map((p) => ({
            pid: p.pid,
            type: p.role,
            cpu: { cumulativeCPUUsage: (p.cpuKernelMs + p.cpuUserMs) / 1000 },
            memory: {
              workingSetSize: p.workingSetBytes / 1024,
              privateBytes: p.privateBytes / 1024,
            },
          })),
        }
      } catch {
        /* Ignore incomplete diagnostic records or best-effort cleanup errors; acceptance is validated separately. */
      }
    }
    await sleep(500)
  }
  throw new Error('OS sampler produced no complete sample')
}
function summary(sample) {
  return {
    workingSetMiB: sample.processes.reduce((n, p) => n + p.memory.workingSetSize, 0) / 1024,
    privateMiB: sample.processes.reduce((n, p) => n + p.memory.privateBytes, 0) / 1024,
    roles: sample.processes.map((p) => p.type),
  }
}
async function main() {
  fs.mkdirSync(output, { recursive: true })
  const canonicalTemp = fs.realpathSync.native(os.tmpdir())
  process.env.TEMP = canonicalTemp
  process.env.TMP = canonicalTemp
  for (let run = Number(process.env.SIFTORY_PERFORMANCE_FIRST_RUN || 1); run <= 3; run++) {
    const profile = fs.mkdtempSync(path.join(canonicalTemp, 'siftory-performance-'))
    const nonce = createSmokeSessionMarker(profile, 'packaged')
    const errors = []
    let application
    let sampler
    const result = {
      run,
      profile,
      status: 'running',
      startup: {},
      samples: [],
      switches: [],
      errors,
    }
    try {
      const launchEpochMs = Date.now()
      const start = performance.now()
      application = await _electron.launch({
        executablePath: require('electron'),
        args: ['.'],
        cwd: path.resolve(__dirname, '..'),
        chromiumSandbox: true,
        env: createSmokeSpawnEnvironment({
          SIFTORY_PACKAGED_VALIDATION: '1',
          FLOATING_CLOCK_UI_SMOKE_USER_DATA: profile,
          FLOATING_CLOCK_SMOKE_SESSION_NONCE: nonce,
        }),
        timeout: 45000,
      })
      const page = await application.firstWindow()
      page.setDefaultTimeout(15000)
      result.startup.firstWindowObservedMs = performance.now() - start
      const identity = await application.evaluate(({ app }) => ({
        pid: process.pid,
        version: app.getVersion(),
        packaged: app.isPackaged,
      }))
      result.applicationIdentity = identity
      page.on('pageerror', (e) => errors.push(e.message))
      await page.locator('[data-testid="app-root"][data-ready="true"]').waitFor({ timeout: 30000 })
      await page.getByTestId('workspace-domain-search').waitFor()
      await page.getByTestId('workspace-domain-search').click()
      result.startup.searchNavigationInteractiveMs = performance.now() - start
      result.startup.rendererPaintEntries = await page.evaluate(() =>
        performance.getEntriesByType('paint').map(({ name, startTime }) => ({ name, startTime })),
      )
      const navigationOrigin = await page.evaluate(() => performance.timeOrigin)
      const firstContentfulPaint = result.startup.rendererPaintEntries.find(
        (entry) => entry.name === 'first-contentful-paint',
      )
      result.startup.firstContentfulPaintFromLaunchMs = firstContentfulPaint
        ? navigationOrigin + firstContentfulPaint.startTime - launchEpochMs
        : null
      if (process.env.SIFTORY_PERFORMANCE_IDLE_STATE === 'hidden-search-pages') {
        await page.locator('.panel:visible').getByTestId('workspace-tab-video-search').click()
        await page.locator('[data-panel="media-search"]:visible').waitFor()
        await page.getByTestId('workspace-domain-settings').click()
        await page.locator('[data-panel="settings"]:visible').waitFor()
      }
      activeSampleFile = path.join(output, 'processes-' + run + '.jsonl')
      sampler = await startRuntimeMemorySampler({
        rootPid: identity.pid,
        outputFile: activeSampleFile,
        stopFile: path.join(output, 'stop-' + run),
        readyFile: path.join(output, 'ready-' + run),
        intervalMs: 1000,
      })
      const idleStart = Date.now()
      const duration = Number(process.env.SIFTORY_PERFORMANCE_IDLE_MS || 60000)
      let previous = await snapshot(application)
      while (Date.now() - idleStart < duration) {
        await sleep(5000)
        const current = await snapshot(application)
        const before = new Map(previous.processes.map((p) => [p.pid, p.cpu.cumulativeCPUUsage]))
        current.cpuCorePercent =
          (current.processes.reduce(
            (n, p) =>
              n +
              Math.max(
                0,
                p.cpu.cumulativeCPUUsage - (before.get(p.pid) ?? p.cpu.cumulativeCPUUsage),
              ),
            0,
          ) *
            100000) /
          (current.at - previous.at)
        current.sinceReadyMs = Date.now() - idleStart
        result.samples.push(current)
        previous = current
        if (!result.idle60 && current.sinceReadyMs >= 60000) result.idle60 = summary(current)
        fs.writeFileSync(path.join(output, 'run-' + run + '.json'), JSON.stringify(result, null, 2))
        if (result.samples.length % 12 === 0)
          console.log(
            JSON.stringify({
              run,
              idleSeconds: Math.round(current.sinceReadyMs / 1000),
              memory: summary(current),
            }),
          )
      }
      result.beforeNavigation = summary(await snapshot(application))
      for (let cycle = 0; cycle < 100; cycle++) {
        const domain = ['library', 'sources', 'maintenance', 'settings', 'search'][cycle % 5]
        const then = performance.now()
        await page.getByTestId('workspace-domain-' + domain).click()
        const panel = {
          library: 'neko-search',
          sources: 'image-search',
          maintenance: 'app-storage',
          settings: 'settings',
          search: 'image-search',
        }[domain]
        await page.locator(`[data-panel="${panel}"]:visible`).waitFor()
        await page.waitForFunction(
          (id) =>
            document
              .querySelector('[data-testid="workspace-domain-' + id + '"]')
              ?.getAttribute('aria-current') === 'page',
          domain,
          { timeout: 15000 },
        )
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        )
        result.switches.push({ domain, ms: performance.now() - then })
        fs.writeFileSync(path.join(output, 'run-' + run + '.json'), JSON.stringify(result, null, 2))
        if (cycle % 10 === 0) console.log(JSON.stringify({ run, cycle, domain }))
        if (cycle === 4) result.afterFirstFivePages = summary(await snapshot(application))
      }
      result.after100Switches = summary(await snapshot(application))
      console.log(JSON.stringify({ run, step: 'after100-sampled' }))
      if (Number(process.env.SIFTORY_PERFORMANCE_SETTLE_MS || 0) > 0) {
        await sleep(Number(process.env.SIFTORY_PERFORMANCE_SETTLE_MS))
        result.after100Settled = summary(await snapshot(application))
      }
      console.log(JSON.stringify({ run, step: 'settled-sampled' }))
      if (process.env.SIFTORY_PERFORMANCE_SCREENSHOT === '1') {
        await page.screenshot({ path: path.join(output, 'run-' + run + '.png'), timeout: 10000 })
      }
      result.startupPhases = JSON.parse(
        fs.readFileSync(path.join(profile, 'diagnostics/startup-timing.json'), 'utf8'),
      )
      result.status = errors.length ? 'failed' : 'passed'
    } catch (error) {
      result.status = 'failed'
      result.error = String(error.stack || error)
    } finally {
      console.log(JSON.stringify({ run, step: 'cleanup' }))
      if (sampler) await sampler.stop().catch((e) => errors.push(e.message))
      if (application) {
        const child = application.process()
        let closeTimer
        try {
          await Promise.race([
            application.close(),
            new Promise((resolve) => {
              closeTimer = setTimeout(() => {
                if (child.exitCode === null) child.kill()
                resolve()
              }, 15000)
            }),
          ])
        } finally {
          clearTimeout(closeTimer)
        }
      }
      results.push(result)
      fs.writeFileSync(path.join(output, 'run-' + run + '.json'), JSON.stringify(result, null, 2))
    }
    console.log(
      JSON.stringify({ run, status: result.status, startup: result.startup, error: result.error }),
    )
    if (result.status !== 'passed') break
  }
  fs.writeFileSync(
    path.join(output, 'baseline.json'),
    JSON.stringify(
      {
        sourceCommit: require('child_process')
          .execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
          .trim(),
        scope:
          'Fresh isolated standard-window development build; OS cache uncontrolled; empty library; no AI model workload. First-window observation is not first paint; UI click includes automation overhead. CPU uses cumulative process CPU time and one-core normalization. Five-second instrumentation interval.',
        results,
      },
      null,
      2,
    ),
  )
  if (
    results.length !== 4 - Number(process.env.SIFTORY_PERFORMANCE_FIRST_RUN || 1) ||
    results.some((r) => r.status !== 'passed')
  )
    process.exitCode = 1
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
