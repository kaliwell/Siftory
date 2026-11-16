// Tests the real React controls and Renderer sampler with a mocked IPC backend.
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

async function main() {
  const { createServer } = await import('vite')
  const { default: react } = await import('@vitejs/plugin-react')
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  })
  let browser
  try {
    await server.listen()
    browser = await chromium.launch({
      executablePath: process.env.SIFTORY_TEST_CHROMIUM_PATH || undefined,
      headless: true,
      args: process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
    })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/workspace-ui.html`,
    )
    await page.locator('[data-testid="app-root"][data-ready="true"]').waitFor()
    await page.evaluate(() => {
      const state = (window.performanceTest = {
        enabled: false,
        cancelExport: true,
        actions: [],
        samples: [],
      })
      window.__workspaceTest.setHandler('imageSearch.performanceDiagnostics', (action) => {
        state.actions.push(action)
        if (action === 'start') state.enabled = true
        if (action === 'stop') state.enabled = false
        return {
          ok: true,
          enabled: state.enabled,
          dropped: 0,
          cancelled: action === 'export' && state.cancelExport,
        }
      })
      window.__workspaceTest.setHandler('imageSearch.reportScanResponsiveness', (sample) => {
        state.samples.push(sample)
        return { ok: true }
      })
    })
    await page.getByTestId('workspace-domain-sources').click()
    const panel = page.getByTestId('performance-diagnostics')
    await panel.locator('summary').click()
    await panel.getByRole('button', { name: /Start recording|开始记录/, exact: true }).click()
    await page.waitForFunction(() => window.performanceTest.enabled)
    await panel.getByRole('button', { name: /Mark stutter|标记卡顿/, exact: true }).click()
    await page.getByTestId('workspace-domain-settings').click()
    await page.evaluate(() => {
      setTimeout(() => {
        const until = performance.now() + 220
        while (performance.now() < until) {
          /* Simulate a Renderer task blocking input. */
        }
      }, 50)
    })
    await page.waitForFunction(
      () => window.performanceTest.samples.some((s) => s.longTaskMaxMs >= 200),
      undefined,
      { timeout: 10000 },
    )
    await page.getByTestId('workspace-domain-sources').click()
    if ((await panel.getAttribute('open')) === null) await panel.locator('summary').click()
    await panel.getByRole('button', { name: /Stop and export|停止并导出/, exact: true }).click()
    await panel
      .getByText(/Recording stopped; logs remain saved locally|已停止记录，日志仍保存在本机/, {
        exact: true,
      })
      .waitFor()
    await page.waitForFunction(() => !window.performanceTest.enabled)
    await page.evaluate(() => {
      window.performanceTest.cancelExport = false
    })
    await panel
      .getByRole('button', { name: /Export recorded logs|导出已有日志/, exact: true })
      .click()
    await panel.getByText(/Diagnostic operation complete|诊断操作已完成/, { exact: true }).waitFor()
    const result = await page.evaluate(() => window.performanceTest)
    assert.ok(result.actions.includes('mark'))
    assert.ok(result.actions.indexOf('stop') < result.actions.indexOf('export'))
    await page.evaluate(() => {
      window.errorLogRequests = []
      window.__workspaceTest.setHandler(
        'imageSearch.scanErrorDiagnostics',
        (action, includePaths) => {
          window.errorLogRequests.push({ action, includePaths })
          return { ok: true, capturedThisSession: 7 }
        },
      )
    })
    const errorPanel = page.getByTestId('scan-error-diagnostics')
    await errorPanel.locator('summary').click()
    await errorPanel
      .getByRole('button', { name: /Export error logs|导出错误日志/, exact: true })
      .click()
    await errorPanel.getByRole('checkbox').check()
    await errorPanel
      .getByRole('button', { name: /Export error logs|导出错误日志/, exact: true })
      .click()
    const errorRequests = await page.evaluate(() =>
      window.errorLogRequests.filter((r) => r.action === 'export'),
    )
    assert.deepEqual(
      errorRequests.map((r) => r.includePaths),
      [false, true],
    )
    await page.getByTestId('search-mode-advanced').click()
    // Default search type is Fast: preparation telemetry must not depend on
    // the manual embedding build controls, which Fast intentionally hides.
    const maintenance = page.getByTestId('image-search-maintenance-section')
    const toggle = maintenance.locator('button').first()
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
    await page.evaluate(() => {
      window.__workspaceTest.emit('imageSearch.onPreparationProgress', {
        taskId: 'running-test',
        state: 'running',
        phase: 'embedding-dino',
        percentage: 42,
        scanComplete: true,
        message: 'Preparing model inputs',
      })
      window.__workspaceTest.emit('vector.onEmbeddingProgress', {
        modelName: 'dinov2_vitb14',
        state: 'running',
        total: 100,
        completed: 40,
        skipped: 2,
        failed: 1,
        running: 3,
        pending: 54,
        elapsedMs: 12000,
        itemsPerSecond: 3.5,
        currentPath: 'C:\\Samples\\current-image.png',
      })
    })
    const preparation = maintenance.getByTestId('search-setup-progress')
    await preparation.getByText('Preparing model inputs', { exact: true }).waitFor()
    await preparation
      .getByTestId('preparation-model-progress')
      .getByText('DINO: 43/100 (43%)', { exact: true })
      .waitFor()
    await preparation.getByTestId('preparation-current-path').waitFor()
    assert.equal(await preparation.getAttribute('data-detailed'), 'true')
    assert.equal(await page.getByTestId('search-mode-simple').isDisabled(), true)
    // Mode changes are intentionally disabled during preparation. Complete this
    // run, switch mode normally, then verify the next run is still visible.
    await page.evaluate(() => {
      window.__workspaceTest.emit('imageSearch.onPreparationProgress', {
        taskId: 'running-test',
        state: 'done',
        phase: 'done',
        percentage: 100,
        scanComplete: true,
        vectorIndexComplete: true,
      })
      window.__workspaceTest.emit('vector.onEmbeddingProgress', {
        modelName: 'dinov2_vitb14',
        state: 'done',
        total: 100,
        completed: 97,
        skipped: 2,
        failed: 1,
        running: 0,
        pending: 0,
      })
    })
    await page.getByTestId('search-mode-simple').click()
    await page.evaluate(() =>
      window.__workspaceTest.emit('imageSearch.onPreparationProgress', {
        taskId: 'simple-running-test',
        state: 'running',
        phase: 'embedding-dino',
        percentage: 42,
        scanComplete: true,
        message: 'Preparing model inputs',
      }),
    )
    await preparation.getByText('Preparing model inputs', { exact: true }).waitFor()
    assert.equal(await preparation.getAttribute('data-detailed'), 'false')
    await page.evaluate(() =>
      window.__workspaceTest.emit('imageSearch.onPreparationProgress', {
        taskId: 'simple-running-test',
        state: 'done',
        phase: 'done',
        percentage: 100,
        scanComplete: true,
        vectorIndexComplete: true,
      }),
    )
    await page.getByTestId('search-mode-advanced').click()
    // The last DINO counters must disappear immediately when CLIP starts.
    await page.evaluate(() =>
      window.__workspaceTest.emit('imageSearch.onPreparationProgress', {
        taskId: 'running-test',
        state: 'running',
        phase: 'embedding-clip',
        percentage: 60,
        scanComplete: true,
        message: 'Preparing semantic inputs',
      }),
    )
    await preparation.getByText('Preparing semantic inputs', { exact: true }).waitFor()
    assert.equal(await preparation.getByTestId('preparation-model-progress').count(), 0)
    await page.evaluate(() =>
      window.__workspaceTest.emit('vector.onEmbeddingProgress', {
        modelName: 'clip_vit_base_patch32',
        state: 'running',
        total: 100,
        completed: 20,
        skipped: 0,
        failed: 0,
        running: 2,
        pending: 78,
        elapsedMs: 6000,
        currentPath: 'C:\\Samples\\semantic-image.png',
      }),
    )
    await preparation
      .getByTestId('preparation-model-progress')
      .getByText('CLIP: 20/100 (20%)', { exact: true })
      .waitFor()

    await page.evaluate(() =>
      window.__workspaceTest.emit('imageSearch.onPreparationProgress', {
        taskId: 'failed-test',
        state: 'error',
        phase: 'embedding-dino',
        percentage: 30,
        error: 'MODEL_RUNTIME_FAILURE_TEST',
        scanComplete: true,
      }),
    )
    await page.getByText('MODEL_RUNTIME_FAILURE_TEST', { exact: true }).first().waitFor()
    await page.evaluate(() =>
      window.__workspaceTest.emit('imageSearch.onPreparationProgress', {
        taskId: 'skipped-test',
        state: 'done',
        phase: 'done',
        percentage: 100,
        hasInputSkips: true,
        scanComplete: true,
        dinoEmbeddingComplete: true,
        clipEmbeddingComplete: true,
        vectorIndexComplete: true,
        message: 'Image library ready. Some input files were skipped; see the scan error log.',
      }),
    )
    await page
      .getByText(
        /素材库准备完成，部分文件已跳过|Image library ready\. Some input files were skipped/,
      )
      .first()
      .waitFor()
    assert.equal(await page.getByText('MODEL_RUNTIME_FAILURE_TEST', { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        passed: true,
        recordedLongTask: true,
        survivesNavigation: true,
        cancelledExportPreservesStoppedState: true,
        verifiedInputSkipsDisplayed: true,
        advancedPreparationProgressVisible: true,
        bothModesShowPreparationProgress: true,
        staleModelCountersHidden: true,
        scope: 'React controls and Renderer sampling only; no Windows/native scan acceptance',
      }),
    )
  } finally {
    await browser?.close()
    await server.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
