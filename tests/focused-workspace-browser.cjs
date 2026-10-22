// Real React views with a synthetic Electron bridge; no model downloads or native-client claims.
const assert = require('node:assert/strict')
const path = require('node:path')
const { chromium } = require('playwright')
const root = path.resolve(__dirname, '..')

async function run() {
  const { createServer } = await import('vite')
  const { default: react } = await import('@vitejs/plugin-react')
  const server = await createServer({
    configFile: false,
    root,
    plugins: [react()],
    optimizeDeps: { entries: ['tests/fixtures/workspace-ui.html'] },
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  })
  let browser
  try {
    await server.listen()
    const address = server.httpServer.address()
    browser = await chromium.launch({
      ...(process.env.SIFTORY_TEST_CHROMIUM_PATH
        ? { executablePath: process.env.SIFTORY_TEST_CHROMIUM_PATH }
        : {}),
      headless: true,
      chromiumSandbox: process.platform === 'win32',
      args:
        process.platform === 'linux'
          ? [
              '--no-sandbox',
              '--disable-dev-shm-usage',
              '--disable-gpu',
              '--no-zygote',
              '--single-process',
              '--use-gl=angle',
              '--use-angle=swiftshader',
            ]
          : [],
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    page.on('pageerror', (error) => {
      errors.push(error.message)
      console.error('pageerror', error.message)
    })
    page.on('console', (message) => {
      if (message.type() === 'error') console.error(message.text())
    })
    // Cold lazy loading must not consume a navigation event before the actual page exists.
    await page.route('**/src/components/ImageSearchPanel.tsx*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 650))
      await route.continue()
    })
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/workspace-ui.html`)
    await page.locator('[data-ready="true"]').waitFor()
    await page.waitForFunction(() => {
      const saved = window.__workspaceTest.getSettings()
      return (
        saved.showClock === false &&
        saved.displayScope?.mode === 'primary' &&
        saved.focusedDisplayScopeVersion === 2 &&
        saved.showRemoteTerminal === false &&
        saved.showSettings === false
      )
    })
    assert.deepEqual(await page.evaluate(() => window.__workspaceTest.getSettings().fmFavorites), [
      { path: 'C:/kept', name: 'Kept' },
    ])
    await page.getByTestId('workspace-domain-settings').click()
    assert.equal(await page.getByTestId('display-scope').locator('option[value="all"]').count(), 0)
    assert.equal(
      await page.evaluate(() => window.__workspaceTest.getSettings().focusedDisplayScopeVersion),
      2,
    )
    await page.getByTestId('display-scope').selectOption('primary')
    await page.waitForFunction(
      () => window.__workspaceTest.getSettings().displayScope?.mode === 'primary',
    )
    await page.getByTestId('workspace-domain-search').click()
    const search = page.getByTestId('unified-search-query')
    await search.fill('A')
    await page.getByTestId('unified-search-result').first().waitFor()
    assert.equal(await page.locator('.panel:visible').count(), 1)
    assert.equal(
      await page.locator('[data-panel="clock"],[data-panel="remote-terminal"]').count(),
      0,
    )
    await page.locator('.unified-search-tile__preview').first().click()
    await page.locator('.unified-search-detail').waitFor()
    await page.setViewportSize({ width: 760, height: 900 })
    await page.evaluate(() =>
      window.__workspaceTest.store.setState({
        workArea: { x: 0, y: 0, width: 760, height: 900, displays: [] },
      }),
    )
    const detail = await page.locator('.unified-search-detail').boundingBox()
    assert.ok(
      detail.y < 400 && detail.x + detail.width <= 760,
      'narrow detail must be reachable without scrolling past the whole grid',
    )
    await page.locator('.unified-search-detail__close').click()
    await page.getByTestId('workspace-domain-sources').click()
    await page.locator('[data-panel="image-search"]:visible').waitFor()
    await page.waitForFunction(() =>
      window.__workspaceTest.events.includes('workspace-sources-focus'),
    )
    await page.getByTestId('workspace-domain-search').click()
    assert.equal(await search.inputValue(), 'A')
    const beforePaste = await page.evaluate(
      () =>
        window.__workspaceTest.calls.filter(
          (call) => call.method === 'imageSearch.pasteClipboardImage',
        ).length,
    )
    await page.keyboard.press('Control+v')
    assert.equal(
      await page.evaluate(
        () =>
          window.__workspaceTest.calls.filter(
            (call) => call.method === 'imageSearch.pasteClipboardImage',
          ).length,
      ),
      beforePaste,
      'hidden source page must not consume the active page keyboard input',
    )
    await page.evaluate(() => window.__workspaceTest.addSource())
    await page.getByTestId('workspace-domain-sources').click()
    await page.getByTestId('workspace-domain-search').click()
    await page.waitForFunction(() =>
      document
        .querySelector('[data-testid="unified-search-source-filter"]')
        .textContent.includes('素材目录 2'),
    )
    // A slow feedback-triggered refresh from an older query cannot overwrite newer search results.
    await page.locator('.unified-search-tile__preview').first().click()
    await page.evaluate(() => window.__workspaceTest.delayQuery('A', 700))
    await page.getByTestId('unified-search-feedback-relevant').click()
    await search.fill('B')
    await page.waitForFunction(() =>
      document.querySelector('.unified-search-tile strong')?.textContent.startsWith('B'),
    )
    await page.waitForTimeout(850)
    assert.ok(
      (await page.locator('.unified-search-tile strong').first().textContent()).startsWith('B'),
    )
    // Browse bounded candidates without placing hundreds of extra thumbnails in the DOM.
    await page.evaluate(() => window.__workspaceTest.setResultCount(725))
    await search.fill('large')
    await page.waitForFunction(
      () => document.querySelector('.unified-search-tile strong')?.textContent === 'large 0.jpg',
    )
    assert.equal(await page.getByTestId('unified-search-result').count(), 100)
    const beforePages = await page.evaluate(
      () =>
        window.__workspaceTest.calls.filter((call) => call.method === 'unifiedSearch.query').length,
    )
    for (let offset = 100; offset <= 400; offset += 100) {
      await page.getByTestId('unified-search-next-page').click()
      await page.waitForFunction(
        (index) =>
          document.querySelector('.unified-search-tile strong')?.textContent ===
          `large ${index}.jpg`,
        offset,
      )
      assert.equal(await page.getByTestId('unified-search-result').count(), 100)
    }
    assert.equal(await page.getByTestId('unified-search-next-page').isDisabled(), true)
    assert.match(await page.getByTestId('unified-search-page-range').textContent(), /401.*500.*725/)
    await page.getByTestId('unified-search-previous-page').click()
    await page.waitForFunction(
      () => document.querySelector('.unified-search-tile strong')?.textContent === 'large 300.jpg',
    )
    assert.equal(
      await page.evaluate(
        () =>
          window.__workspaceTest.calls.filter((call) => call.method === 'unifiedSearch.query')
            .length,
      ),
      beforePages,
      'paging must reuse the ranked result snapshot without rerunning inference',
    )
    await page.evaluate(() => window.__workspaceTest.setResultCount(8))
    await search.fill('C')
    await page.waitForFunction(
      () => document.querySelector('.unified-search-tile strong')?.textContent === 'C 0.jpg',
    )
    assert.equal(await page.getByTestId('unified-search-previous-page').isDisabled(), true)
    assert.equal(await page.getByTestId('unified-search-next-page').isDisabled(), true)

    // Native write failures must reach the user, preserve edits and recover through Retry.
    await page.evaluate(async () => {
      window.__workspaceTest.failSettings(true)
      window.__workspaceTest.store.setState({ linkedMove: true })
      const writer = await import('/src/hooks/settingsWriter.ts')
      await writer.flushSettingsWrites().catch(() => {})
    })
    await page.getByTestId('workspace-save-error').waitFor()
    await page.evaluate(() => window.__workspaceTest.failSettings(false))
    await page.getByTestId('workspace-save-error').getByRole('button').click()
    await page.getByTestId('workspace-save-error').waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => window.__workspaceTest.getSettings().linkedMove), true)

    await page.getByTestId('workspace-domain-tasks').click()
    await page.evaluate(() => window.__workspaceTest.failResourceProfile(true))
    await page.getByTestId('resource-governor-profile').selectOption('quality')
    await page.getByTestId('workspace-task-summary').getByRole('alert').waitFor()
    assert.equal(await page.getByTestId('resource-governor-profile').inputValue(), 'balanced')
    await page.evaluate(() => window.__workspaceTest.failResourceProfile(false))
    await page.getByTestId('resource-governor-profile').selectOption('power-saver')
    await page.waitForFunction(() =>
      window.__workspaceTest.calls.some(
        (call) =>
          call.method === 'unifiedSearch.setResourceProfile' && call.args[0] === 'power-saver',
      ),
    )
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="resource-governor-profile"]')?.value ===
        'power-saver',
    )
    await page.getByTestId('workspace-first-run-guide').click()
    await page
      .getByTestId('product-first-run-guide')
      .waitFor({ timeout: 10000 })
      .catch(async (error) => {
        console.error(
          await page.evaluate(async () => {
            try {
              const m = await import('/src/services/productReadiness.ts')
              await m.loadProductReadiness(window.electronAPI)
              return {
                readiness: 'ok',
                text: document.querySelector('.workspace-guide-drawer')?.textContent,
                errors: [],
              }
            } catch (cause) {
              return { error: String(cause), stack: cause.stack }
            }
          }),
        )
        console.error('Browser errors:', errors)
        throw error
      })
    // A slow readiness probe must not multiply every 2.5 seconds.
    const scanCalls = await page.evaluate(() => {
      const harness = window.__workspaceTest
      harness.maximumInFlight['discoveryCatalog.getScanStatus'] = 0
      harness.delayMethod('discoveryCatalog.getScanStatus', 3000)
      return harness.calls.filter((call) => call.method === 'discoveryCatalog.getScanStatus').length
    })
    await page.waitForFunction(
      (before) =>
        window.__workspaceTest.calls.filter(
          (call) => call.method === 'discoveryCatalog.getScanStatus',
        ).length > before,
      scanCalls,
    )
    await page.waitForTimeout(2700)
    assert.equal(
      await page.evaluate(
        () => window.__workspaceTest.maximumInFlight['discoveryCatalog.getScanStatus'],
      ),
      1,
    )
    await page.evaluate(() =>
      window.__workspaceTest.delayMethod('discoveryCatalog.getScanStatus', 0),
    )
    await page.getByTestId('first-run-current-action').click()
    await page.locator('[data-panel="settings"]:visible').waitFor()
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="settings-category-searchModels"]')
          .getAttribute('aria-expanded') === 'true',
    )
    const hiddenGuideCalls = await page.evaluate(
      () =>
        window.__workspaceTest.calls.filter(
          (call) => call.method === 'discoveryCatalog.getScanStatus',
        ).length,
    )
    await page.waitForTimeout(5200)
    assert.equal(
      await page.evaluate(
        () =>
          window.__workspaceTest.calls.filter(
            (call) => call.method === 'discoveryCatalog.getScanStatus',
          ).length,
      ),
      hiddenGuideCalls,
    )
    await page.evaluate(() => window.__workspaceTest.dispatch('product-first-search-completed'))
    await page.waitForFunction(
      () => window.__workspaceTest.getSettings().firstRunGuide.firstSearchCompleted === true,
    )

    const schedulerCalls = await page.evaluate(() => {
      const harness = window.__workspaceTest
      harness.maximumInFlight['unifiedSearch.getSchedulerStats'] = 0
      harness.delayMethod('unifiedSearch.getSchedulerStats', 6200)
      return harness.calls.filter((call) => call.method === 'unifiedSearch.getSchedulerStats')
        .length
    })
    await page.waitForFunction(
      (before) =>
        window.__workspaceTest.calls.filter(
          (call) => call.method === 'unifiedSearch.getSchedulerStats',
        ).length > before,
      schedulerCalls,
    )
    await page.waitForTimeout(5300)
    assert.equal(
      await page.evaluate(
        () => window.__workspaceTest.maximumInFlight['unifiedSearch.getSchedulerStats'],
      ),
      1,
    )
    await page.evaluate(() =>
      window.__workspaceTest.delayMethod('unifiedSearch.getSchedulerStats', 0),
    )
    await page.getByTestId('workspace-domain-search').click()
    await page.evaluate(() => window.__workspaceTest.store.getState().toggleGlobalVisibility())
    assert.equal(await page.locator('.panel:visible').count(), 0)
    await page.evaluate(() => window.__workspaceTest.store.getState().toggleGlobalVisibility())
    await page.locator('[data-panel="unified-search"]:visible').waitFor()
    const lockResult = await page.evaluate(() => {
      const store = window.__workspaceTest.store
      store.setState({ lockedVisibility: { unifiedSearch: true } })
      return store.getState().toggleGlobalVisibility()
    })
    assert.equal(lockResult, true)
    assert.equal(
      await page.locator('.panel:visible').count(),
      1,
      'native controller and visibility-locked content must agree',
    )
    assert.ok(
      await page.evaluate(() => window.__workspaceTest.eventMounts.every((event) => event.mounted)),
      'navigation events must arrive after their visible content mounts',
    )
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        ok: true,
        checks: [
          'legacy migration',
          'canonical startup persistence',
          'legacy display scope migration',
          'single-display settings',
          'single foreground',
          'narrow details',
          'cold lazy navigation',
          'retained query',
          'hidden clipboard',
          'source refresh',
          'stale response',
          'bounded result pages',
          'pagination reuses ranked snapshot',
          'query resets pagination',
          'settings failure and retry',
          'resource failure feedback',
          'resource profile',
          'first-run model route',
          'readiness request deduplication',
          'hidden guide pauses polling',
          'hidden guide retains search progress',
          'scheduler request deduplication',
          'hide/restore',
          'visibility lock',
        ],
        pageErrors: errors,
      }),
    )
  } finally {
    await browser?.close()
    await server.close()
  }
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
