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
    await page.locator('[data-testid="app-root"][data-ready="true"]').waitFor()
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
    const search = page.locator('.image-search-semantic-controls input')
    await search.fill('A')
    assert.equal(await page.locator('.panel:visible').count(), 1)
    assert.equal(await page.locator('[data-panel="unified-search"]').count(), 0)
    assert.equal(await page.getByTestId('workspace-tab-all-search').count(), 0)
    assert.equal(await page.getByTestId('workspace-domain-duplicate-finder').count(), 0)
    await page.getByTestId('workspace-domain-sources').click()
    await page.waitForFunction(() =>
      window.__workspaceTest.events.includes('workspace-sources-focus'),
    )
    await page.getByTestId('workspace-domain-search').click()
    assert.equal(await search.inputValue(), 'A')
    assert.equal(await page.getByTestId('workspace-domain-tasks').count(), 0)
    await page.getByTestId('workspace-domain-settings').click()
    const beforePaste = await page.evaluate(
      () =>
        window.__workspaceTest.calls.filter((c) => c.method === 'imageSearch.pasteClipboardImage')
          .length,
    )
    await page.getByTestId('workspace-domain-settings').focus()
    await page.keyboard.press('Control+v')
    assert.equal(
      await page.evaluate(
        () =>
          window.__workspaceTest.calls.filter((c) => c.method === 'imageSearch.pasteClipboardImage')
            .length,
      ),
      beforePaste,
    )
    await page.getByTestId('workspace-domain-search').click()
    await page.evaluate(() => window.__workspaceTest.store.setState({ showUnifiedSearch: true }))
    await page.waitForFunction(() => !window.__workspaceTest.store.getState().showUnifiedSearch)
    await page.evaluate(() => window.__workspaceTest.store.setState({ showDuplicateFinder: true }))
    await page.waitForFunction(() => !window.__workspaceTest.store.getState().showDuplicateFinder)
    assert.equal(await page.locator('[data-panel="image-search"]:visible').count(), 1)
    assert.equal(await search.inputValue(), 'A')

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

    await page.evaluate(() => window.dispatchEvent(new Event('workspace-open-search-models')))
    await page.locator('[data-settings-category="searchModels"]').waitFor({ state: 'visible' })
    assert.equal(await page.getByTestId('workspace-task-summary').count(), 0)
    await page.getByTestId('workspace-domain-search').click()
    await page.evaluate(() => window.__workspaceTest.store.getState().toggleGlobalVisibility())
    assert.equal(await page.locator('.panel:visible').count(), 0)
    await page.evaluate(() => window.__workspaceTest.store.getState().toggleGlobalVisibility())
    await page.locator('[data-panel="image-search"]:visible').waitFor()
    const lockResult = await page.evaluate(() => {
      const store = window.__workspaceTest.store
      store.setState({ lockedVisibility: { imageSearch: true } })
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
          'retired entries absent',
          'legacy route migration',
          'cold lazy navigation',
          'retained query',
          'hidden clipboard',
          'settings failure and retry',
          'model management routes to settings',
          'task page removed',
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
