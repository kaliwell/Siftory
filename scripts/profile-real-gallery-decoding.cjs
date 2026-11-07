'use strict'
// Per-image diagnostic through the real authorized thumbnail IPC, followed by
// actual Chromium Image.decode(). App-cache cold/warm; OS cache uncontrolled.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { _electron } = require('playwright')
const {
  createSmokeSessionMarker,
  createSmokeSpawnEnvironment,
} = require('../tests/smoke-test-utils.cjs')
const { installGalleryPerformanceObserver } = require('./gallery-performance-observer.cjs')
async function main() {
  const fixture = JSON.parse(
    fs.readFileSync('artifacts/performance-real-gallery-fixture.json', 'utf8'),
  ).out
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'manifest.json'), 'utf8'))
  const groups = new Map()
  for (const file of manifest.files) {
    const pixels = file.width * file.height
    const tier =
      pixels <= 100000
        ? 'under-0.1MP'
        : pixels <= 1000000
          ? '0.1-1MP'
          : pixels <= 8000000
            ? '1-8MP'
            : 'over-8MP'
    const ext = file.ext === '.jpeg' ? '.jpg' : file.ext
    const key = ext + ':' + tier
    if (!groups.has(key)) groups.set(key, [])
    if (groups.get(key).length < 4) groups.get(key).push({ ...file, tier, group: key })
  }
  const files = [...groups.values()].flat()
  const out = fs.mkdtempSync(path.resolve('artifacts/benchmark/runtime-memory/real-decode-'))
  const temp = fs.realpathSync.native(os.tmpdir())
  process.env.TEMP = temp
  process.env.TMP = temp
  const profile = fs.mkdtempSync(path.join(temp, 'siftory-real-decode-'))
  const nonce = createSmokeSessionMarker(profile, 'packaged')
  const report = {
    scope:
      'Read-only real image sample stratified by metadata size/format. Native IPC duration includes cache validation, queueing, decode/resize/encode and cache write; not isolated libvips decode CPU time. Browser decode duration measures the resulting <=256px image. Sequential requests, app-cache cold then disk-warm, OS cache warmed by prior hashing. No search or source changes.',
    out,
    cases: [],
    errors: [],
  }
  let app
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
    await app.evaluate(installGalleryPerformanceObserver)
    for (const pass of ['app-cache-cold', 'disk-cache-warm']) {
      for (const [index, file] of files.entries()) {
        const result = await page.evaluate(async (file) => {
          const start = performance.now()
          const value = await window.electronAPI.fmGetThumbnail(file, 256)
          const ipcMs = performance.now() - start
          if (!value.dataUrl) return { ipcMs, success: false, error: value.error }
          const image = new Image()
          const decode = performance.now()
          image.src = value.dataUrl
          try {
            await image.decode()
          } catch {
            return { ipcMs, success: false, browserDecodeFailed: true }
          }
          const browserDecodeMs = performance.now() - decode
          const digest = await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(value.dataUrl),
          )
          return {
            ipcMs,
            browserDecodeMs,
            success: true,
            diskHit: !value.backend,
            width: image.naturalWidth,
            height: image.naturalHeight,
            encodedCharacters: value.dataUrl.length,
            outputHash: Array.from(new Uint8Array(digest))
              .map((v) => v.toString(16).padStart(2, '0'))
              .join(''),
          }
        }, file.path)
        report.cases.push({
          pass,
          index,
          sourceHash: file.sha256,
          ext: file.ext,
          group: file.group,
          fileBytes: file.size,
          metadataWidth: file.width,
          metadataHeight: file.height,
          ...result,
        })
      }
      report[pass] = await app.evaluate(() => globalThis.__galleryPerformance.snapshot(true))
      fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
    }
    report.cacheOutputHashesIdentical = files.every((_, index) => {
      const pair = report.cases.filter((row) => row.index === index)
      return pair[0].success === pair[1].success && pair[0].outputHash === pair[1].outputHash
    })
    report.status =
      report.errors.length || !report.cacheOutputHashesIdentical ? 'failed' : 'completed'
    console.log(
      JSON.stringify({
        out,
        status: report.status,
        inputs: files.length,
        failures: report.cases.filter((r) => !r.success).length,
        cacheOutputHashesIdentical: report.cacheOutputHashesIdentical,
      }),
    )
  } catch (e) {
    report.status = 'failed'
    report.error = e.stack
    throw e
  } finally {
    if (app) {
      const child = app.process()
      let timer
      try {
        await Promise.race([
          app.close(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              if (child.exitCode === null) child.kill()
              reject(new Error('Diagnostic close timeout'))
            }, 15000)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  }
  if (report.status !== 'completed') process.exitCode = 1
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
