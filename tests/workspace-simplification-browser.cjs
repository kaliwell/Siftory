// Real React UI with a synthetic Electron bridge; never runs native deletion.
const assert = require('node:assert/strict'),
  path = require('node:path')
const root = path.resolve(__dirname, '..')
;(async () => {
  const { createServer } = await import('vite')
  const { default: react } = await import('@vitejs/plugin-react')
  const server = await createServer({
    configFile: false,
    root,
    plugins: [react()],
    optimizeDeps: { entries: ['tests/fixtures/workspace-ui.html'] },
    server: {
      host: '127.0.0.1',
      port: 0,
      watch: { ignored: ['**/native/**', '**/release/**', '**/artifacts/**'] },
    },
    logLevel: 'error',
  })
  let browser
  try {
    await server.listen()
    browser = await require('playwright').chromium.launch({
      ...(process.env.SIFTORY_TEST_CHROMIUM_PATH
        ? { executablePath: process.env.SIFTORY_TEST_CHROMIUM_PATH }
        : {}),
      headless: true,
      chromiumSandbox: true,
    })
    const page = await browser.newPage({ viewport: { width: 1320, height: 900 } }),
      errors = [],
      modules = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('request', (r) => {
      if (/AssetLibraryPanel/.test(r.url())) modules.push(r.url())
    })
    await page.addInitScript(() => {
      let harness
      Object.defineProperty(window, '__workspaceTest', {
        configurable: true,
        get: () => harness,
        set: (v) => {
          harness = v
          v.setHandler('discoveryCatalog.listSources', () => [
            {
              id: 'test-root',
              type: 'local-ntfs',
              displayName: 'Fixture',
              rootLocator: 'C:/fixtures/shared',
              availability: 'online',
              readOnly: true,
              scanCapability: 'directory',
            },
          ])
          v.setHandler('vector.previewProcessedImageData', () => ({
            ok: true,
            fileCount: 0,
            estimatedBytes: 0,
            categories: [],
          }))
        },
      })
    })
    await page.goto(
      'http://127.0.0.1:' + server.httpServer.address().port + '/tests/fixtures/workspace-ui.html',
    )
    await page.locator('[data-testid="app-root"][data-ready="true"]').waitFor()
    await page.evaluate(() => window.__workspaceTest.store.getState().setLanguage('en'))
    await page.getByTestId('workspace-domain-sources').click()
    const picker = page.getByRole('combobox', { name: 'Registered folders', exact: true })
    await picker.focus()
    await page.waitForFunction(() =>
      document.querySelector('.registered-source-picker option[value="C:/fixtures/shared"]'),
    )
    await picker.selectOption('C:/fixtures/shared')
    assert.ok(
      await page.evaluate(() =>
        window.__workspaceTest.store.getState().imageSearchScanPaths.includes('C:/fixtures/shared'),
      ),
    )
    await page.evaluate(() =>
      window.__workspaceTest.store
        .getState()
        .setImageSearchUiPreferences({ experienceMode: 'advanced' }),
    )
    const advanced = page.locator('.preparation-advanced-options')
    await advanced.waitFor()
    assert.equal(await page.getByTestId('image-search-start-scan').isVisible(), false)
    await advanced.locator('summary').click()
    assert.equal(await page.getByTestId('image-search-start-scan').isVisible(), true)
    await page.getByTestId('workspace-domain-settings').click()
    await page.getByTestId('settings-nav-appearance').click()
    assert.equal(await page.locator('#app-theme').count(), 0)
    await page.locator('.settings-theme-previews > summary').click()
    const choice = page.locator('.theme-style-option[aria-pressed="false"]').first()
    const chosenLabel = await choice.getAttribute('aria-label')
    await choice.click()
    assert.equal(
      await page
        .getByRole('button', { name: chosenLabel, exact: true })
        .getAttribute('aria-pressed'),
      'true',
    )
    await page.getByTestId('settings-nav-dataReset').click()
    const scope = page.getByTestId('cleanup-scope')
    await scope.selectOption('all')
    await page.getByTestId('clear-processed-image-data').click()
    await page.getByRole('button', { name: 'Cancel', exact: true }).last().click()
    await scope.selectOption('source')
    assert.equal(await page.getByTestId('source-derived-data-cleanup').isVisible(), true)
    await scope.selectOption('layer')
    await page.getByTestId('cleanup-open-folder-layers').click()
    await page.waitForFunction(
      () => document.querySelector('.workspace-advanced-maintenance')?.open,
    )
    assert.equal(
      await page.getByTestId('workspace-domain-maintenance').getAttribute('aria-current'),
      'page',
    )
    assert.deepEqual(errors, [])
    const destructive = await page.evaluate(
      () =>
        window.__workspaceTest.calls.filter(
          (c) =>
            c.method === 'vector.clearProcessedImageData' ||
            c.method === 'sourceDerivedData.execute' ||
            c.method === 'imageSearch.deleteData',
        ).length,
    )
    assert.equal(destructive, 0)
    console.log(
      JSON.stringify({
        passed: true,
        registeredRootReused: true,
        advancedPreparationFolded: true,
        singleThemePicker: true,
        cleanupScopes: 3,
        folderLayersNavigation: true,
        destructiveCalls: 0,
        pageErrors: errors,
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
