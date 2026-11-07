'use strict'
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

async function main() {
  const { createServer } = await import('vite')
  const { default: react } = await import('@vitejs/plugin-react')
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 0,
      watch: { ignored: ['**/artifacts/**', '**/release/**', '**/native/**'] },
    },
    logLevel: 'error',
  })
  let browser
  try {
    await server.listen()
    browser = await chromium.launch({
      headless: true,
      ...(process.env.SIFTORY_TEST_CHROMIUM_PATH
        ? { executablePath: process.env.SIFTORY_TEST_CHROMIUM_PATH }
        : {}),
      chromiumSandbox: process.platform === 'win32',
    })
    const page = await browser.newPage({ viewport: { width: 1320, height: 950 } })
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/workspace-ui.html`,
    )
    await page.getByTestId('image-search-query-section').waitFor()
    await page.getByTestId('workspace-domain-maintenance').click()
    const section = page.getByTestId('maintenance-automatic-section')
    const toggle = section.locator('button.search-control-section__header')
    await toggle.click()
    await page.getByTestId('automatic-maintenance-enabled').waitFor()
    await page.waitForFunction(
      () => document.querySelectorAll('.automatic-maintenance-scope').length === 1,
    )
    await page.evaluate(() => window.__workspaceTest.setHandler('browseFolder', () => 'D:/draft'))
    await page.locator('.automatic-maintenance-scopes > button').click()
    await page.waitForFunction(
      () => document.querySelectorAll('.automatic-maintenance-scope').length === 2,
    )
    const calls = () =>
      page.evaluate(
        () =>
          window.__workspaceTest.calls.filter((c) => c.method === 'sourceDerivedData.autoStatus')
            .length,
      )
    await page.getByTestId('workspace-domain-settings').click()
    const hidden = await calls()
    await page.waitForTimeout(11000)
    assert.equal(await calls(), hidden, 'hidden maintenance must not poll')
    await page.getByTestId('workspace-domain-maintenance').click()
    await page.waitForFunction(
      (n) =>
        window.__workspaceTest.calls.filter((c) => c.method === 'sourceDerivedData.autoStatus')
          .length > n,
      hidden,
    )
    assert.equal(
      await page.locator('.automatic-maintenance-scope').count(),
      2,
      'unsaved scopes survive hide/restore',
    )
    const visible = await calls()
    await page.waitForTimeout(5500)
    assert.equal(await calls(), visible + 1, 'one foreground poll interval')
    await toggle.click()
    const collapsed = await calls()
    await page.waitForTimeout(5500)
    assert.equal(await calls(), collapsed, 'collapsed mounted body must not poll')
    await toggle.click()
    await page.getByTestId('automatic-maintenance-enabled').check()
    await page.getByTestId('automatic-maintenance-check').waitFor({ state: 'visible' })
    await page.evaluate(() => {
      window.__workspaceTest.delayMethod('sourceDerivedData.startAutomaticMaintenanceCheck', 500)
      window.__workspaceTest.setHandler('sourceDerivedData.startAutomaticMaintenanceCheck', () => ({
        config: { enabled: true, scopes: ['C:/fixtures', 'D:/draft'] },
        phase: 'completed',
        pendingMissing: 0,
        removedImages: 0,
        missingVideos: 0,
        recoveredBytes: 0,
        message: 'Background maintenance completed in test',
      }))
    })
    await page.getByTestId('automatic-maintenance-check').click()
    await page.getByTestId('workspace-domain-settings').click()
    await page.waitForFunction(() =>
      document
        .querySelector('[data-testid="automatic-maintenance"]')
        ?.textContent.includes('Background maintenance completed in test'),
    )
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        passed: true,
        hiddenPollingPaused: true,
        collapsedPollingPaused: true,
        immediateRestoreRefresh: true,
        unsavedScopesRetained: true,
        foregroundSingleInterval: true,
        hiddenTaskCompletionRetained: true,
        errors,
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
