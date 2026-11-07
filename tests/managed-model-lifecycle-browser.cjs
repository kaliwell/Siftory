'use strict'
const assert = require('assert/strict'),
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
      ...(process.env.SIFTORY_TEST_CHROMIUM_PATH
        ? { executablePath: process.env.SIFTORY_TEST_CHROMIUM_PATH }
        : {}),
      chromiumSandbox: process.platform === 'win32',
    })
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/managed-model-lifecycle.html`,
    )
    const state = () => page.evaluate(() => window.__modelLifecycle.snapshot())
    await page.waitForFunction(() => window.__modelLifecycle.snapshot().calls === 2)
    assert.equal((await state()).listeners, 1)
    await page.locator('#visibility').click()
    await page.evaluate(() => window.__modelLifecycle.announceReady())
    await page.waitForFunction(() => document.querySelector('#readiness').textContent === 'ready')
    const hiddenCalls = (await state()).calls
    await page.locator('#explicit-refresh').click()
    await page.waitForFunction(
      (n) => window.__modelLifecycle.snapshot().calls === n,
      hiddenCalls + 2,
    )
    await page.locator('#visibility').click()
    await page.waitForFunction(
      (n) => window.__modelLifecycle.snapshot().calls === n,
      hiddenCalls + 4,
    )
    const shownCalls = (await state()).calls
    await page.waitForTimeout(16000)
    assert.equal(
      (await state()).calls,
      shownCalls + 2,
      'one visible periodic poll continues without duplicates',
    )
    await page.locator('#mount').click()
    assert.equal((await state()).listeners, 0, 'unmount releases subscription')
    const unmountedCalls = (await state()).calls
    await page.waitForTimeout(16000)
    assert.equal((await state()).calls, unmountedCalls, 'unmount releases polling timer')
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        passed: true,
        hiddenEventsRetained: true,
        explicitHiddenTaskRefresh: true,
        reopenRefresh: true,
        foregroundPolling: true,
        unmountSubscriptionCleanup: true,
        errors,
      }),
    )
  } finally {
    await browser?.close()
    await server.close()
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
