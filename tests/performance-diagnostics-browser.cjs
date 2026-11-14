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
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        passed: true,
        recordedLongTask: true,
        survivesNavigation: true,
        cancelledExportPreservesStoppedState: true,
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
