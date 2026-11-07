'use strict'
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  crypto = require('crypto'),
  { _electron } = require('playwright')
const {
  createSmokeSessionMarker,
  createSmokeSpawnEnvironment,
  resolveUiSmokeExecutable,
} = require('../tests/smoke-test-utils.cjs')
const { startRuntimeMemorySampler } = require('./runtime-memory-process-sampler.cjs')
const { installGalleryPerformanceObserver } = require('./gallery-performance-observer.cjs')
;(async () => {
  const fixture = path.resolve(
    process.env.SIFTORY_GALLERY_FIXTURE || 'artifacts/benchmark/image-fixture-20261107',
  )
  const diagnostics = process.env.SIFTORY_GALLERY_DIAGNOSTICS === '1'
  const packaged = process.env.SIFTORY_GALLERY_PACKAGED === '1'
  const executable = packaged
    ? resolveUiSmokeExecutable({ repo: process.cwd(), packaged: true })
    : require('electron')
  const out = path.resolve(
    process.env.SIFTORY_NATIVE_GALLERY_OUTPUT ||
      'artifacts/benchmark/runtime-memory/native-gallery-after-20261107',
  )
  fs.mkdirSync(out, { recursive: true })
  const temp = fs.realpathSync.native(os.tmpdir())
  process.env.TEMP = temp
  process.env.TMP = temp
  const reports = []
  const counts = (process.env.SIFTORY_GALLERY_COUNTS || '1000,5000,10000').split(',').map(Number)
  if (counts.some((n) => ![1000, 5000, 10000].includes(n)))
    throw new Error('Unsupported catalog size')
  for (const count of counts) {
    let app, sampler
    const r = { count, errors: [] }
    try {
      const profile = fs.mkdtempSync(path.join(temp, 'siftory-gallery-performance-')),
        nonce = createSmokeSessionMarker(profile, 'packaged')
      app = await _electron.launch({
        executablePath: executable,
        args: packaged ? [] : ['.'],
        cwd: packaged ? path.dirname(executable) : process.cwd(),
        chromiumSandbox: true,
        env: createSmokeSpawnEnvironment({
          SIFTORY_PACKAGED_VALIDATION: '1',
          FLOATING_CLOCK_UI_SMOKE_USER_DATA: profile,
          FLOATING_CLOCK_SMOKE_SESSION_NONCE: nonce,
        }),
        timeout: 45000,
      })
      let page = await app.firstWindow()
      await page
        .locator('[data-testid="app-root"], [data-testid="end-user-terms-text"]')
        .first()
        .waitFor({ timeout: 90000 })
      if (await page.getByTestId('end-user-terms-text').isVisible()) {
        await page.getByTestId('end-user-terms-text').evaluate((element) => {
          element.scrollTop = element.scrollHeight
        })
        await page.getByTestId('end-user-terms-checkbox').check()
        const next = app.waitForEvent('window', { timeout: 90000 })
        await page.getByTestId('end-user-terms-accept').click()
        page = await next
        r.testProfileAgreementAccepted = true
      }
      page.setDefaultTimeout(20000)
      page.on('pageerror', (e) => r.errors.push(e.message))
      await page.locator('[data-testid="app-root"][data-ready="true"]').waitFor()
      const identity = await app.evaluate(({ app }) => ({
        pid: process.pid,
        packaged: app.isPackaged,
        userData: app.getPath('userData'),
        version: app.getVersion(),
      }))
      if (
        fs.realpathSync.native(identity.userData) !== fs.realpathSync.native(profile) ||
        identity.packaged !== packaged
      )
        throw new Error('Unexpected profile or packaging mode')
      r.application = {
        version: identity.version,
        packaged: identity.packaged,
        isolatedProfile: true,
      }
      const mainPid = identity.pid
      if (diagnostics) {
        await app.evaluate(installGalleryPerformanceObserver)
        await page.addInitScript(() => {
          window.__galleryLongTasks = []
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              window.__galleryLongTasks.push({
                startTime: entry.startTime,
                duration: entry.duration,
              })
          }).observe({ type: 'longtask', buffered: true })
        })
        await page.evaluate(() => {
          window.__galleryLongTasks = []
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              window.__galleryLongTasks.push({
                startTime: entry.startTime,
                duration: entry.duration,
              })
          }).observe({ type: 'longtask', buffered: true })
        })
      }
      r.catalog = await page.evaluate(
        async ({ file, count }) => {
          const start = performance.now(),
            task = await window.electronAPI.assetLibrary.syncFromImageIndex(file)
          if (!task.ok) throw new Error(task.error || 'Sync rejected')
          let progress
          const deadline = Date.now() + 120000
          do {
            await new Promise((r) => setTimeout(r, 100))
            progress = await window.electronAPI.assetLibrary.getTaskProgress(task.taskId)
            if (progress?.state === 'error') throw new Error(progress.error || progress.message)
          } while (progress?.state !== 'done' && Date.now() < deadline)
          const stats = await window.electronAPI.assetLibrary.getStats()
          if (progress?.state !== 'done' || stats.totalAssets !== count)
            throw new Error('Catalog fixture not ready')
          return { ms: performance.now() - start, totalAssets: stats.totalAssets }
        },
        {
          file: path.join(fixture, 'catalog-' + count + '.idx'),
          count,
        },
      )
      sampler = await startRuntimeMemorySampler({
        rootPid: mainPid,
        outputFile: path.join(out, 'samples-' + count + '.jsonl'),
        readyFile: path.join(out, 'ready-' + count),
        stopFile: path.join(out, 'stop-' + count),
        intervalMs: 1000,
      })
      const start = performance.now()
      if (process.env.SIFTORY_GALLERY_NAV_DISPATCH === '1') {
        await page.evaluate(() =>
          document.querySelector('[data-testid="workspace-domain-library"]').click(),
        )
      } else await page.getByTestId('workspace-domain-library').click()
      r.openTiming = { navigationMs: performance.now() - start }
      await page.locator('.asset-library-card').first().waitFor()
      r.openTiming.cardsPresentMs = performance.now() - start
      await page.waitForFunction(
        () => {
          const grid = document.querySelector('.asset-library-gallery')
          if (!grid) return false
          const bounds = grid.getBoundingClientRect()
          const visible = [...grid.querySelectorAll('.asset-library-card')].filter((e) => {
            const r = e.querySelector('.asset-library-card-preview').getBoundingClientRect()
            return r.top < bounds.bottom && r.bottom > bounds.top
          })
          return (
            visible.length > 0 &&
            visible.every((e) => {
              const img = e.querySelector('.asset-library-card-preview img')
              return img?.complete && img.naturalWidth > 0
            })
          )
        },
        null,
        { timeout: 30000 },
      )
      r.firstViewportReadyMs = performance.now() - start
      if (diagnostics) {
        r.firstViewportIpc = await app.evaluate(() =>
          globalThis.__galleryPerformance.snapshot(true),
        )
      }
      if (process.env.SIFTORY_GALLERY_OPEN_ONLY === '1') {
        r.status = r.errors.length ? 'failed' : 'passed'
        console.log(JSON.stringify(r))
        continue
      }
      r.scroll = await page.evaluate(async () => {
        const grid = document.querySelector('.asset-library-gallery'),
          dt = []
        let before = performance.now(),
          maxCards = 0
        for (let i = 0; i < 180; i++) {
          grid.scrollTop = ((grid.scrollHeight - grid.clientHeight) * (i < 90 ? i : 179 - i)) / 89
          await new Promise((resolve) => requestAnimationFrame(resolve))
          const now = performance.now()
          dt.push(now - before)
          before = now
          maxCards = Math.max(maxCards, grid.querySelectorAll('.asset-library-card').length)
        }
        dt.sort((a, b) => a - b)
        return {
          frames: dt.length,
          p95FrameMs: dt[Math.floor(dt.length * 0.95)],
          maxFrameMs: Math.max(...dt),
          maxCards,
        }
      })
      if (diagnostics) {
        const ready = async () => {
          await page.waitForFunction(
            () => {
              const grid = document.querySelector('.asset-library-gallery')
              if (!grid) return false
              const bounds = grid.getBoundingClientRect()
              const cards = [...grid.querySelectorAll('.asset-library-card')].filter((card) => {
                const box = card
                  .querySelector('.asset-library-card-preview')
                  .getBoundingClientRect()
                return box.top < bounds.bottom && box.bottom > bounds.top
              })
              return (
                cards.length > 0 &&
                cards.every((card) => {
                  const img = card.querySelector('.asset-library-card-preview img')
                  return img?.complete && img.naturalWidth > 0
                })
              )
            },
            null,
            { timeout: 30000 },
          )
        }
        const stop = performance.now()
        await ready()
        r.afterFastScrollVisibleReadyMs = performance.now() - stop
        r.fastScrollIpc = await app.evaluate(() => globalThis.__galleryPerformance.snapshot(true))
        r.stops = []
        for (const fraction of [0.33, 0.66, 1, 0.66, 0.33, 0]) {
          r.pendingStop = fraction
          const start = performance.now()
          await page.evaluate((fraction) => {
            const grid = document.querySelector('.asset-library-gallery')
            grid.scrollTop = fraction * (grid.scrollHeight - grid.clientHeight)
          }, fraction)
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          )
          await ready()
          r.stops.push({
            fraction,
            readyMs: performance.now() - start,
            ipc: await app.evaluate(() => globalThis.__galleryPerformance.snapshot(true)),
          })
        }
        r.warmPageTraversalMs = performance.now()
        for (let i = 0; i <= 24; i++) {
          await page.evaluate((fraction) => {
            const grid = document.querySelector('.asset-library-gallery')
            grid.scrollTop = fraction * (grid.scrollHeight - grid.clientHeight)
          }, i / 24)
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          )
          await ready()
        }
        r.warmPageTraversalMs = performance.now() - r.warmPageTraversalMs
        r.warmTraversalIpc = await app.evaluate(() =>
          globalThis.__galleryPerformance.snapshot(true),
        )
        await page.evaluate(() => {
          document.querySelector('.asset-library-gallery').scrollTop = 0
        })
        await page.waitForTimeout(200)
        await ready()
        r.warmScroll = await page.evaluate(async () => {
          const grid = document.querySelector('.asset-library-gallery'),
            dt = []
          let before = performance.now(),
            visiblePreviewSamples = 0,
            readyPreviewSamples = 0,
            maxCards = 0
          for (let i = 0; i < 180; i++) {
            grid.scrollTop = ((grid.scrollHeight - grid.clientHeight) * (i < 90 ? i : 179 - i)) / 89
            await new Promise((resolve) => requestAnimationFrame(resolve))
            const now = performance.now()
            dt.push(now - before)
            before = now
            const bounds = grid.getBoundingClientRect()
            maxCards = Math.max(maxCards, grid.querySelectorAll('.asset-library-card').length)
            for (const preview of grid.querySelectorAll('.asset-library-card-preview')) {
              const box = preview.getBoundingClientRect()
              if (box.top >= bounds.bottom || box.bottom <= bounds.top) continue
              visiblePreviewSamples++
              const img = preview.querySelector('img')
              if (img?.complete && img.naturalWidth > 0) readyPreviewSamples++
            }
          }
          dt.sort((a, b) => a - b)
          return {
            frames: dt.length,
            p95FrameMs: dt[Math.floor(dt.length * 0.95)],
            maxFrameMs: Math.max(...dt),
            visiblePreviewSamples,
            readyPreviewSamples,
            readyPreviewFraction: readyPreviewSamples / visiblePreviewSamples,
            maxCards,
          }
        })
        r.warmScrollIpc = await app.evaluate(() => globalThis.__galleryPerformance.snapshot(true))
        r.rendererLongTasksBeforeReload = await page.evaluate(() => window.__galleryLongTasks)
        await page.reload()
        await page.locator('[data-testid="app-root"][data-ready="true"]').waitFor()
        await app.evaluate(() => globalThis.__galleryPerformance.snapshot(true))
        const reloaded = performance.now()
        await page.getByTestId('workspace-domain-library').click()
        await ready()
        r.diskWarmReload = {
          readyMs: performance.now() - reloaded,
          ipc: await app.evaluate(() => globalThis.__galleryPerformance.snapshot(true)),
        }
        r.rendererLongTasks = await page.evaluate(() => window.__galleryLongTasks)
      }
      await page.getByTestId('workspace-domain-settings').click()
      await page.locator('[data-panel="settings"]:visible').waitFor()
      await page.getByTestId('workspace-domain-library').click()
      await page.locator('.asset-library-card').first().waitFor()
      r.status = r.errors.length ? 'failed' : 'passed'
      if (diagnostics) {
        const cacheDir = path.join(profile, 'thumbcache')
        r.cacheOutputs = fs
          .readdirSync(cacheDir)
          .filter((name) => /^[a-f0-9]{24}\.(thumb|jpg|png|webp)$/i.test(name))
          .sort()
          .map((name) => ({
            name,
            sha256: crypto
              .createHash('sha256')
              .update(fs.readFileSync(path.join(cacheDir, name)))
              .digest('hex'),
          }))
      }
      console.log(JSON.stringify(r))
    } catch (e) {
      r.status = 'failed'
      r.error = String(e.stack || e)
      if (diagnostics && app) {
        try {
          r.failureIpc = await app.evaluate(() => globalThis.__galleryPerformance.snapshot())
          const page = await app.firstWindow()
          r.failureDom = await page.evaluate(() => {
            const grid = document.querySelector('.asset-library-gallery')
            const bounds = grid?.getBoundingClientRect()
            return {
              scrollTop: grid?.scrollTop,
              scrollHeight: grid?.scrollHeight,
              height: grid?.clientHeight,
              cards: [...(grid?.querySelectorAll('.asset-library-card') || [])].map((card) => {
                const img = card.querySelector('.asset-library-card-preview img')
                const box = card.getBoundingClientRect()
                const fallback = card.querySelector('.asset-library-card-preview span')
                return {
                  visible: box.top < bounds.bottom && box.bottom > bounds.top,
                  top: box.top,
                  img: !!img,
                  complete: img?.complete,
                  width: img?.naturalWidth,
                  urlLength: img?.src.length,
                  fallbackOpacity: fallback?.style.opacity,
                }
              }),
              longTasks: window.__galleryLongTasks,
            }
          })
        } catch (diagnosticError) {
          r.diagnosticError = diagnosticError.message
        }
      }
      console.log(JSON.stringify(r))
    } finally {
      if (sampler) {
        try {
          const samples = await sampler.stop()
          r.peakWorkingSetMiB =
            Math.max(...samples.map((s) => s.aggregate.workingSetBytes)) / 1048576
        } catch (e) {
          r.status = 'failed'
          r.samplerError = e.message
        }
      }
      if (app) {
        const child = app.process()
        let timer
        try {
          await Promise.race([
            app.close(),
            new Promise(
              (resolve) =>
                (timer = setTimeout(() => {
                  if (child.exitCode === null) child.kill()
                  resolve()
                }, 15000)),
            ),
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      reports.push(r)
      fs.writeFileSync(
        path.join(out, 'report.json'),
        JSON.stringify(
          {
            scope: `Actual standard-window Electron, production library UI and native thumbnails; fresh isolated catalog imported from ${fixture}; normal 100-item library page, 180-frame scroll traversal. Raster input selected by fixture manifest; not 10000 simultaneously mounted thumbnails and not search accuracy. Diagnostics observe existing authorized IPC handlers and synchronous cache I/O.`,
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
