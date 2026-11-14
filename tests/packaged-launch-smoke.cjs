// Basic real packaged startup acceptance, isolated by the existing nonce gate.
// This does not replace the separate full UI or installer-upgrade acceptance.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright')
const {
  createSmokeSessionMarker,
  createSmokeSpawnEnvironment,
  resolveUiSmokeExecutable,
  assertTemporaryDirectory,
  redactSmokeText,
} = require('./smoke-test-utils.cjs')

async function main() {
  if (process.platform !== 'win32') throw new Error('Run packaged startup on Windows')
  const repo = path.resolve(__dirname, '..')
  const executablePath = resolveUiSmokeExecutable({ repo, packaged: true })
  const canonicalTemp = fs.realpathSync.native(os.tmpdir())
  // Keep parent and Electron on the same long path; recovery rejects aliases.
  process.env.TEMP = canonicalTemp
  process.env.TMP = canonicalTemp
  const userData = fs.mkdtempSync(path.join(canonicalTemp, 'siftory-package-boot-'))
  const output = path.join(repo, 'artifacts/online-installer')
  const nonce = createSmokeSessionMarker(userData, 'packaged')
  let application
  let stdout = ''
  let stderr = ''
  try {
    application = await electron.launch({
      chromiumSandbox: true,
      cwd: path.dirname(executablePath),
      executablePath,
      timeout: 90000,
      env: createSmokeSpawnEnvironment({
        SIFTORY_PACKAGED_VALIDATION: '1',
        FLOATING_CLOCK_UI_SMOKE_USER_DATA: userData,
        FLOATING_CLOCK_SMOKE_SESSION_NONCE: nonce,
      }),
    })
    application.process().stdout?.on('data', (bytes) => {
      stdout += bytes.toString()
    })
    application.process().stderr?.on('data', (bytes) => {
      stderr += bytes.toString()
    })
    let page = await application.firstWindow({ timeout: 90000 })
    await page
      .locator('[data-testid="end-user-terms-text"], [data-testid="app-root"]')
      .first()
      .waitFor({ timeout: 90000 })
    const agreementShown = await page.getByTestId('end-user-terms-text').isVisible()
    if (agreementShown) {
      await page.getByTestId('end-user-terms-text').evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      await page.getByTestId('end-user-terms-checkbox').check()
      const mainWindow = application.waitForEvent('window', { timeout: 90000 })
      await page.getByTestId('end-user-terms-accept').click()
      page = await mainWindow
    }
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.locator('[data-testid="app-root"][data-ready="true"]').waitFor({ timeout: 90000 })
    await page.getByTestId('workspace-domain-search').waitFor({ timeout: 30000 })
    const provenance = await application.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      version: app.getVersion(),
      userData: app.getPath('userData'),
    }))
    assert.equal(provenance.packaged, true)
    assert.equal(provenance.version, require('../package.json').version)
    assert.equal(fs.realpathSync.native(provenance.userData), fs.realpathSync.native(userData))
    const nativeDeadline = Date.now() + 30000
    while (!stdout.includes('Native addon loaded: fast_scanner') && Date.now() < nativeDeadline)
      await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(
      stdout.includes('Native addon loaded: fast_scanner'),
      'packaged native addon must load',
    )
    const previewSource = path.join(userData, 'packaged-preview-test.ai')
    assert.ok(
      fs.statSync(path.join(path.dirname(executablePath), 'resources', 'projectPreviewPdfChild.js'))
        .size > 0,
      'Packaged PDF child resource must exist',
    )
    fs.writeFileSync(previewSource, require('./fixtures/project-preview-assets.cjs').makePdf())
    const preview = await page.evaluate(
      (filePath) => window.electronAPI.fmGetThumbnail(filePath, 256),
      previewSource,
    )
    assert.ok(preview?.dataUrl, 'Packaged PDF/AI preview worker must produce a thumbnail')
    const previewManifest = JSON.parse(
      fs.readFileSync(path.join(userData, 'project-previews/v1/manifest.json'), 'utf8'),
    )
    assert.ok(
      previewManifest.entries.some(
        (entry) =>
          entry.sourcePath === previewSource &&
          entry.provider === 'pdfjs-first-page' &&
          entry.status === 'ready',
      ),
    )
    // Exercise the actual packaged controls, IPC, disk store and export endpoint.
    await page.getByTestId('workspace-domain-sources').click()
    const diagnostics = page.getByTestId('performance-diagnostics')
    await diagnostics.locator('summary').click()
    await diagnostics.getByRole('button', { name: /Start recording|开始记录/, exact: true }).click()
    await diagnostics.getByRole('button', { name: /Mark stutter|标记卡顿/, exact: true }).click()
    const shellSource = path.join(userData, 'packaged-shell-fallback.psd')
    // A JPEG named .psd has no PSD embedded resource: it must take Shell fallback.
    const readyPreview = previewManifest.entries.find((entry) => entry.sourcePath === previewSource)
    fs.copyFileSync(readyPreview.previewPath, shellSource)
    await page.evaluate((source) => window.electronAPI.fmGetThumbnail(source, 256), shellSource)

    await page.evaluate(() => {
      setTimeout(() => {
        const until = performance.now() + 220
        while (performance.now() < until) {
          /* Deliberate test-only Renderer long task. */
        }
      }, 50)
    })
    const logFile = path.join(userData, 'diagnostics', 'performance', 'search-0.jsonl')
    const readLog = () => {
      if (!fs.existsSync(logFile)) return []
      return fs
        .readFileSync(logFile, 'utf8')
        .split('\n')
        .flatMap((line) => {
          try {
            return [JSON.parse(line)]
          } catch {
            return []
          }
        })
    }
    const diagnosticDeadline = Date.now() + 20000
    while (
      !readLog().some(
        (r) => r.event === 'preview-renderer-window' && r.detail.longTaskMaxMs >= 200,
      ) &&
      Date.now() < diagnosticDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 250))
    assert.ok(
      readLog().some((r) => r.event === 'preview-renderer-window' && r.detail.longTaskMaxMs >= 200),
      'Packaged recording must capture a real Renderer long task',
    )
    const performanceExport = path.join(userData, 'performance-export.json')
    // Replace only the OS save picker in this isolated smoke process.
    await application.evaluate(({ dialog }, target) => {
      global.__siftorySavePicker = dialog.showSaveDialog
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
    }, performanceExport)
    await diagnostics
      .getByRole('button', { name: /Stop and export|停止并导出/, exact: true })
      .click()
    const exportDeadline = Date.now() + 15000
    while (!fs.existsSync(performanceExport) && Date.now() < exportDeadline)
      await new Promise((resolve) => setTimeout(resolve, 100))
    await diagnostics
      .getByText(/Diagnostic operation complete|诊断操作已完成/, { exact: true })
      .waitFor()
    const performanceReport = JSON.parse(fs.readFileSync(performanceExport, 'utf8'))
    assert.equal(performanceReport.containsImageBytes, false)
    assert.equal(performanceReport.recording, false)
    assert.equal(performanceReport.version, provenance.version)
    assert.ok(performanceReport.summary.longTaskMaxMs >= 200)
    assert.ok(performanceReport.summary.markers >= 1)
    assert.ok(performanceReport.records.some((r) => r.event === 'process-resources'))
    const shellResult = performanceReport.records.find((r) => r.event === 'shell-preview')?.detail
      ?.detail
    assert.ok(
      shellResult?.childPid && shellResult.childPid !== application.process().pid,
      'Packaged Shell fallback must run in a separate process',
    )
    assert.equal(shellResult.errorCode, undefined, 'Packaged helper must complete its IPC protocol')
    assert.ok(Number.isFinite(shellResult.durations.stat))
    assert.ok(Number.isFinite(shellResult.durations.thumbnail))

    await application.evaluate(({ dialog }) => {
      dialog.showSaveDialog = global.__siftorySavePicker
      delete global.__siftorySavePicker
    })
    assert.deepEqual(pageErrors, [])
    fs.mkdirSync(output, { recursive: true })
    await page.screenshot({ path: path.join(output, 'startup.png') })
    fs.writeFileSync(
      path.join(output, 'startup-check.json'),
      JSON.stringify(
        {
          passed: true,
          version: provenance.version,
          packaged: true,
          isolatedProfile: true,
          agreementShownAndAcceptedInTestProfile: agreementShown,
          rendererReady: true,
          nativeAddonLoaded: true,
          projectPreviewWorkerPassed: true,
          projectPreviewPdfChildPassed: true,
          performanceDiagnosticsPassed: true,
          performanceExportPassed: true,
          shellPreviewIsolationPassed: true,
          pageErrors,
          scope:
            'Fresh isolated unpacked startup (agreement accepted when required); excludes full legacy UI matrix, models/GPU and installer upgrades.',
        },
        null,
        2,
      ) + '\n',
    )
    console.log(
      JSON.stringify({ passed: true, version: provenance.version, nativeAddonLoaded: true }),
    )
  } catch (error) {
    console.error(redactSmokeText(stdout.slice(-16000)))
    console.error(redactSmokeText(stderr.slice(-16000)))
    throw error
  } finally {
    await application?.close()
    assertTemporaryDirectory(userData)
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
