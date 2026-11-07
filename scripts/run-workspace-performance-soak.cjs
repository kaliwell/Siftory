'use strict'
// Low-intensity continuous-use regression on a disposable, nonce-authenticated profile.
// Never loads or modifies the user's application profile; never shuts down Windows.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  cp = require('node:child_process'),
  crypto = require('node:crypto')
const { _electron } = require('playwright')
const {
  createSmokeSessionMarker,
  createSmokeSpawnEnvironment,
  resolveUiSmokeExecutable,
} = require('../tests/smoke-test-utils.cjs')
const { startRuntimeMemorySampler } = require('./runtime-memory-process-sampler.cjs')
const {
  createSoakSamplerPlan,
  assertRecentSoakSample,
  validateSoakSampleCoverage,
} = require('./workspace-performance-soak-policy.cjs')
const repo = path.resolve(__dirname, '..'),
  parent = path.join(repo, 'artifacts/benchmark/runtime-memory')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function write(file, value) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(tmp, file)
}
function latest(file) {
  const size = fs.statSync(file).size,
    buffer = Buffer.alloc(Math.min(size, 65536)),
    fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length)
  } finally {
    fs.closeSync(fd)
  }
  for (const line of buffer.toString('utf8').trim().split('\n').reverse()) {
    try {
      return JSON.parse(line)
    } catch {
      /* Ignore incomplete diagnostic records or best-effort cleanup errors; acceptance is validated separately. */
    }
  }
  throw new Error('No complete process sample')
}
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'ESRCH' ? false : null
  }
}
function stats(samples) {
  if (!samples.length) return null
  const memory = samples.map((s) => s.aggregate.workingSetBytes / 1048576)
  return {
    samples: samples.length,
    firstWorkingSetMiB: memory[0],
    lastWorkingSetMiB: memory.at(-1),
    peakWorkingSetMiB: Math.max(...memory),
    minFreePhysicalMiB: Math.min(...samples.map((s) => s.system.freePhysicalMemoryBytes / 1048576)),
  }
}
async function main() {
  process.chdir(repo)
  fs.mkdirSync(parent, { recursive: true })
  const minutes = Number(process.env.SIFTORY_PERFORMANCE_SOAK_MINUTES || 120)
  if (!Number.isFinite(minutes) || minutes < 0.05 || minutes > 180)
    throw new Error('Soak minutes must be 0.05..180; values below 120 are smoke-only')
  const pointer = path.join(repo, 'artifacts/performance-soak-active.json')
  if (fs.existsSync(pointer)) {
    const old = JSON.parse(fs.readFileSync(pointer, 'utf8'))
    if (old.status === 'running' && alive(old.runnerPid) !== false)
      throw new Error('A recorded soak may still be running; inspect it before starting another')
  }
  const out = fs.mkdtempSync(path.join(parent, 'packaged-soak-'))
  const development = process.argv.includes('--development'),
    executable = development
      ? require('electron')
      : resolveUiSmokeExecutable({ repo, packaged: true })
  const artifact = development
    ? path.join(repo, 'dist/index.html')
    : path.join(path.dirname(executable), 'resources/app.asar')
  const originalArtifact = {
    size: fs.statSync(artifact).size,
    mtimeMs: fs.statSync(artifact).mtimeMs,
    sha256: hash(artifact),
  }
  let validatedCandidate
  if (process.env.SIFTORY_PERFORMANCE_REQUIRE_VALIDATION === '1') {
    const validation = JSON.parse(
      fs.readFileSync(path.join(repo, 'artifacts/performance-candidate-validation.json'), 'utf8'),
    )
    if (
      development ||
      validation.status !== 'passed' ||
      validation.packagedAsarSha256 !== originalArtifact.sha256
    )
      throw new Error('Full candidate validation does not match the tested package')
    for (const [file, digest] of Object.entries(validation.productionSourceHashes)) {
      if (hash(path.join(repo, file)) !== digest)
        throw new Error('Validated source changed: ' + file)
    }
    validatedCandidate = {
      label: 'combined-four-variable-candidate',
      validationFinishedAt: validation.finishedAt,
      artifactSha256: validation.packagedAsarSha256,
      productionSourceHashes: validation.productionSourceHashes,
    }
  }
  const temp = fs.realpathSync.native(os.tmpdir())
  process.env.TEMP = temp
  process.env.TMP = temp
  const profile = fs.mkdtempSync(path.join(temp, 'siftory-performance-soak-')),
    nonce = createSmokeSessionMarker(profile, 'packaged')
  const report = {
    schema: 'siftory-workspace-performance-soak/v1',
    scope:
      'Continuous low-intensity navigation and thumbnails, actual Electron and native services, generated 10000-image metadata catalog, disposable profile. Excludes downloaded model workloads, human judgments and real-user media. OS occlusion and external system load uncontrolled. No Windows shutdown.',
    requestedMinutes: minutes,
    status: 'running',
    runnerPid: process.pid,
    out,
    profileRetained: true,
    startedAt: new Date().toISOString(),
    errors: [],
    checkpoints: [],
    actions: 0,
    artifact: originalArtifact,
    validatedCandidate,
  }
  const save = () => {
    write(path.join(out, 'report.json'), report)
    write(pointer, {
      runnerPid: process.pid,
      out,
      status: report.status,
      startedAt: report.startedAt,
    })
  }
  save()
  let app, sampler, mainPid, rootIdentity
  let normalExit = false
  try {
    app = await _electron.launch({
      executablePath: executable,
      args: development ? ['.'] : [],
      cwd: development ? repo : path.dirname(executable),
      chromiumSandbox: true,
      env: createSmokeSpawnEnvironment({
        SIFTORY_PACKAGED_VALIDATION: '1',
        FLOATING_CLOCK_UI_SMOKE_USER_DATA: profile,
        FLOATING_CLOCK_SMOKE_SESSION_NONCE: nonce,
      }),
      timeout: 90000,
    })
    const identity = await app.evaluate(({ app }) => ({
      pid: process.pid,
      version: app.getVersion(),
      packaged: app.isPackaged,
      userData: app.getPath('userData'),
    }))
    if (fs.realpathSync.native(identity.userData) !== fs.realpathSync.native(profile))
      throw new Error('Soak did not use its disposable profile')
    mainPid = identity.pid
    report.application = {
      pid: mainPid,
      version: identity.version,
      packaged: identity.packaged,
      isolatedProfile: true,
    }
    let page = await app.firstWindow()
    page.setDefaultTimeout(20000)
    page.on('pageerror', (e) => report.errors.push(e.message))
    await page
      .locator('[data-testid="app-root"], [data-testid="end-user-terms-text"]')
      .first()
      .waitFor({ timeout: 90000 })
    if (await page.getByTestId('end-user-terms-text').isVisible()) {
      await page.getByTestId('end-user-terms-text').evaluate((e) => {
        e.scrollTop = e.scrollHeight
      })
      await page.getByTestId('end-user-terms-checkbox').check()
      const next = app.waitForEvent('window', { timeout: 90000 })
      await page.getByTestId('end-user-terms-accept').click()
      page = await next
      page.setDefaultTimeout(20000)
      page.on('pageerror', (e) => report.errors.push(e.message))
      report.testProfileTermsAccepted = true
    }
    await page.locator('[data-testid="app-root"][data-ready="true"]').waitFor({ timeout: 90000 })
    report.catalog = await page.evaluate(
      async (file) => {
        const task = await window.electronAPI.assetLibrary.syncFromImageIndex(file)
        if (!task.ok) throw new Error('Catalog import rejected')
        const deadline = Date.now() + 120000
        let progress
        do {
          await new Promise((r) => setTimeout(r, 100))
          progress = await window.electronAPI.assetLibrary.getTaskProgress(task.taskId)
          if (progress?.state === 'error') throw new Error(progress.error || progress.message)
        } while (progress?.state !== 'done' && Date.now() < deadline)
        const stats = await window.electronAPI.assetLibrary.getStats()
        if (progress?.state !== 'done' || stats.totalAssets !== 10000)
          throw new Error('Catalog import incomplete')
        return { count: stats.totalAssets }
      },
      path.join(repo, 'artifacts/benchmark/image-fixture-20261107/catalog-10000.idx'),
    )
    await page.locator('.panel:visible').getByTestId('workspace-tab-video-search').click()
    await page.locator('[data-panel="media-search"]:visible').waitFor()
    await page.getByTestId('workspace-domain-settings').click()
    const samplesFile = path.join(out, 'process-tree.jsonl')
    report.samplerPlan = createSoakSamplerPlan(minutes)
    sampler = await startRuntimeMemorySampler({
      rootPid: mainPid,
      outputFile: samplesFile,
      readyFile: path.join(out, 'ready'),
      stopFile: path.join(out, 'sampler-stop'),
      ...report.samplerPlan,
    })
    rootIdentity = sampler.rootIdentity
    const sampleDeadline = Date.now() + 15000
    while (true) {
      try {
        assertRecentSoakSample(latest(samplesFile))
        break
      } catch (error) {
        if (Date.now() >= sampleDeadline) throw error
        await sleep(100)
      }
    }
    const start = Date.now()
    report.activeStartedAt = start
    let next = start,
      nextLog = start
    const refreshSample = () => {
      const sample = assertRecentSoakSample(latest(samplesFile))
      report.latest = {
        at: sample.sampledAt,
        workingSetMiB: sample.aggregate.workingSetBytes / 1048576,
        privateMiB: sample.aggregate.privateBytes / 1048576,
        processes: sample.aggregate.processCount,
      }
      return sample
    }
    while (Date.now() - start < minutes * 60000) {
      if (fs.existsSync(path.join(out, 'STOP'))) {
        report.status = 'cancelled'
        break
      }
      if (report.errors.length) throw new Error('Renderer error during continuous-use test')
      const now = fs.statSync(artifact)
      if (now.size !== originalArtifact.size || now.mtimeMs !== originalArtifact.mtimeMs)
        throw new Error('Tested artifact changed during soak')
      const domain = ['library', 'sources', 'maintenance', 'settings', 'search'][report.actions % 5]
      await page.evaluate((id) => {
        const button = document.querySelector('[data-testid="workspace-domain-' + id + '"]')
        if (!button) throw new Error('Navigation control missing')
        button.click()
      }, domain)
      await page.waitForFunction(
        (id) =>
          document
            .querySelector('[data-testid="workspace-domain-' + id + '"]')
            ?.getAttribute('aria-current') === 'page',
        domain,
        { polling: 100, timeout: 15000 },
      )
      if (domain === 'maintenance') {
        const header = page
          .getByTestId('maintenance-automatic-section')
          .locator('button.search-control-section__header')
        const expand = Math.floor(report.actions / 5) % 2 === 0
        if ((await header.getAttribute('aria-expanded')) !== String(expand)) await header.click()
        if (expand) await page.getByTestId('automatic-maintenance').waitFor({ state: 'visible' })
        report.maintenanceSectionExercised = true
      }
      if (domain === 'library')
        await page.evaluate(() => {
          const grid = document.querySelector('.asset-library-gallery')
          if (grid) grid.scrollTop = grid.scrollTop > 0 ? 0 : grid.scrollHeight - grid.clientHeight
        })
      if (domain === 'library') {
        const previews = await page.evaluate(
          async (files) => {
            const values = await window.electronAPI.fmGetThumbnailsBatch(
              files.map((path) => ({ path, maxDim: 256 })),
            )
            return { requested: files.length, available: values.filter((v) => v.dataUrl).length }
          },
          Array.from({ length: 6 }, (_, i) =>
            path.join(
              repo,
              'artifacts/benchmark/image-fixture-20261107',
              String(i).padStart(5, '0') + '.jpg',
            ),
          ),
        )
        if (previews.available !== previews.requested)
          throw new Error('Native thumbnail preview unavailable during soak')
      }
      report.actions++
      report.activeElapsedMs = Date.now() - start
      const sample = refreshSample()
      if (sample.system.freePhysicalMemoryBytes < 512 * 1048576)
        throw new Error('Low system memory; soak stopped without claiming completion')
      for (const checkpoint of [30, 120])
        if (
          report.activeElapsedMs >= checkpoint * 60000 &&
          !report.checkpoints.some((c) => c.minutes === checkpoint)
        ) {
          report.checkpoints.push({
            minutes: checkpoint,
            actions: report.actions,
            latest: report.latest,
          })
          write(path.join(out, 'checkpoint-' + checkpoint + '.json'), report.checkpoints.at(-1))
        }
      if (Date.now() >= nextLog) {
        save()
        console.log(
          JSON.stringify({
            out,
            elapsedMinutes: (report.activeElapsedMs / 60000).toFixed(1),
            actions: report.actions,
            latest: report.latest,
          }),
        )
        nextLog = Date.now() + 60000
      }
      next += 15000
      await sleep(Math.max(0, next - Date.now()))
    }
    report.activeEndedAt = Date.now()
    report.activeElapsedMs = report.activeEndedAt - start
    if (report.status !== 'cancelled') refreshSample()
    for (const checkpoint of [30, 120])
      if (
        report.activeElapsedMs >= checkpoint * 60000 &&
        !report.checkpoints.some((c) => c.minutes === checkpoint)
      ) {
        report.checkpoints.push({
          minutes: checkpoint,
          actions: report.actions,
          latest: report.latest,
        })
        write(path.join(out, 'checkpoint-' + checkpoint + '.json'), report.checkpoints.at(-1))
      }
    if (report.status !== 'cancelled') {
      const expected = minutes * 4
      report.status =
        report.activeElapsedMs >= minutes * 60000 && report.actions >= expected * 0.9
          ? 'completed'
          : 'incomplete'
      report.fullTwoHourScenario = minutes >= 120 && report.status === 'completed'
      if (!report.fullTwoHourScenario)
        report.scope += ' Smoke-only duration; does not satisfy the two-hour acceptance.'
    }
    const fixtureRoot = path.join(repo, 'artifacts/benchmark/image-fixture-20261107'),
      fixtureManifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'manifest.json'), 'utf8'))
    for (const entry of fixtureManifest.files) {
      if (
        !/^[0-9]{5}\.jpg$/.test(entry.name) ||
        hash(path.join(fixtureRoot, entry.name)) !== entry.sha256
      )
        throw new Error('Generated source file changed')
    }
    report.sourceFilesUnchanged = true
    report.verifiedSourceFiles = fixtureManifest.files.length
    if (hash(artifact) !== originalArtifact.sha256) throw new Error('Artifact checksum changed')
  } catch (e) {
    report.status = 'failed'
    report.error = String(e.stack || e)
  } finally {
    if (sampler) {
      try {
        const samples = await sampler.stop()
        report.memory = stats(samples)
        if (report.status === 'completed') {
          report.sampleCoverage = validateSoakSampleCoverage(
            samples,
            report.activeStartedAt,
            report.activeEndedAt,
          )
        }
        const late = samples.filter(
          (s) => Date.parse(s.sampledAt) >= Date.parse(samples[0].sampledAt) + 30 * 60000,
        )
        if (late.length) {
          const origin = Date.parse(late[0].sampledAt),
            points = late.map((s) => [
              (Date.parse(s.sampledAt) - origin) / 60000,
              s.aggregate.workingSetBytes / 1048576,
            ])
          const mx = points.reduce((n, p) => n + p[0], 0) / points.length,
            my = points.reduce((n, p) => n + p[1], 0) / points.length
          report.lateWorkingSetSlopeMiBPerMinute =
            points.reduce((n, p) => n + (p[0] - mx) * (p[1] - my), 0) /
            points.reduce((n, p) => n + (p[0] - mx) ** 2, 0)
          if (report.lateWorkingSetSlopeMiBPerMinute > 1) report.memoryTrendReviewRequired = true
        }
      } catch (e) {
        report.status = 'failed'
        report.samplerError = e.message
      }
    }
    if (app) {
      const child = app.process()
      let timer
      try {
        await Promise.race([
          app.close().then(() => {
            normalExit = true
          }),
          new Promise(
            (resolve) =>
              (timer = setTimeout(() => {
                report.forcedQuit = true
                resolve()
              }, 20000)),
          ),
        ])
      } catch (e) {
        report.quitError = e.message
      } finally {
        clearTimeout(timer)
      }
      await sleep(1000)
      report.mainProcessExited = mainPid ? alive(mainPid) === false : null
      if (!normalExit || !report.mainProcessExited) {
        report.status = 'failed'
        if (rootIdentity && /^[0-9]+@[0-9]+$/.test(rootIdentity)) {
          const [pid, ticks] = rootIdentity.split('@')
          const command =
            "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " +
            pid +
            "'; if($p -and ([string]$p.CreationDate.ToUniversalTime().Ticks -eq '" +
            ticks +
            "')) { Stop-Process -Id " +
            pid +
            ' -Force }'
          try {
            cp.execFileSync(
              path.join(
                process.env.SystemRoot || 'C:/Windows',
                'System32/WindowsPowerShell/v1.0/powershell.exe',
              ),
              ['-NoProfile', '-NonInteractive', '-Command', command],
              { windowsHide: true, stdio: 'ignore', timeout: 10000 },
            )
          } catch {
            /* Ignore incomplete diagnostic records or best-effort cleanup errors; acceptance is validated separately. */
          }
        }
        if (child.exitCode === null) child.kill()
      }
    }
    report.fullTwoHourScenario = Boolean(
      minutes >= 120 && report.status === 'completed' && report.sampleCoverage?.valid,
    )
    report.finishedAt = new Date().toISOString()
    report.shutdownRequested = false
    save()
    console.log(
      JSON.stringify({
        out,
        status: report.status,
        fullTwoHourScenario: report.fullTwoHourScenario,
        actions: report.actions,
        normalExit,
        mainProcessExited: report.mainProcessExited,
        memory: report.memory,
      }),
    )
  }
  if (report.status !== 'completed' || report.memoryTrendReviewRequired) process.exitCode = 1
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
