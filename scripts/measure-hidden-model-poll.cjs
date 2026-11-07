'use strict'
const fs = require('fs'),
  { chromium } = require('playwright')
;(async () => {
  const { createServer } = await import('vite'),
    { default: react } = await import('@vitejs/plugin-react')
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
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    })
    const page = await browser.newPage({ viewport: { width: 1320, height: 850 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/workspace-ui.html?profileRenders=1`,
    )
    const maintenance = process.env.SIFTORY_POLL_SCENARIO === 'maintenance'
    await page.getByTestId('image-search-query-section').waitFor()
    if (maintenance) {
      await page.getByTestId('workspace-domain-maintenance').click()
      await page
        .getByTestId('maintenance-automatic-section')
        .locator('button.search-control-section__header')
        .click()
      await page.getByTestId('automatic-maintenance').waitFor()
    } else {
      await page.locator('.panel:visible').getByTestId('workspace-tab-video-search').click()
      await page.locator('[data-panel="media-search"]:visible').waitFor()
    }
    await page.getByTestId('workspace-domain-settings').click()
    await page.locator('[data-panel="settings"]:visible').waitFor()
    await page.waitForTimeout(1000)
    const calls = () =>
      page.evaluate(
        (method) => window.__workspaceTest.calls.filter((c) => c.method === method).length,
        maintenance ? 'sourceDerivedData.autoStatus' : 'vector.getModelStatus',
      )
    const before = await calls()
    const renderBefore = await page.evaluate(() => window.__workspaceRenderProfile.length)
    await page.waitForTimeout(31000)
    const after = await calls()
    const renderSamples = await page.evaluate(
      (n) => window.__workspaceRenderProfile.slice(n),
      renderBefore,
    )
    const report = {
      commits: renderSamples.length,
      actualRenderDurationMs: renderSamples.reduce((n, r) => n + r.actualDuration, 0),
      scope: `Synthetic bridge, real React hooks, ${maintenance ? 'automatic maintenance section' : 'both search pages'} mounted then hidden behind Settings; 31-second observation. IPC count metric, not CPU throughput.`,
      hiddenStatusCalls: after - before,
      errors,
    }
    fs.writeFileSync(
      process.env.SIFTORY_POLL_OUTPUT || 'artifacts/performance-hidden-model-poll-before.json',
      JSON.stringify(report, null, 2),
    )
    console.log(JSON.stringify(report))
    if (errors.length) process.exitCode = 1
  } finally {
    await browser?.close()
    await server.close()
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
