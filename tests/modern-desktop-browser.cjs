// Real React UI with the explicitly synthetic bridge in workspace-ui.tsx.
const assert = require('node:assert/strict')
const fs = require('node:fs')
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
  const evidence = path.join(root, 'artifacts/modern-desktop-ui')
  fs.mkdirSync(evidence, { recursive: true })
  let browser
  let page
  try {
    await server.listen()
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: process.platform === 'win32',
      ...(process.env.SIFTORY_TEST_CHROMIUM_PATH
        ? { executablePath: process.env.SIFTORY_TEST_CHROMIUM_PATH }
        : {}),
    })
    page = await browser.newPage({ viewport: { width: 1320, height: 850 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/workspace-ui.html`,
    )
    await page.locator('[data-ready="true"]').waitFor()
    await page.getByTestId('unified-search-query').waitFor()
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(200)
    await page.screenshot({ path: path.join(evidence, 'empty-dark.png') })
    await page.evaluate(() => window.__workspaceTest.store.getState().setThemeMode('light'))
    await page.waitForFunction(() => document.documentElement.dataset.effectiveMode === 'light')
    await page.waitForTimeout(200)
    await page.screenshot({ path: path.join(evidence, 'empty-light.png') })
    fs.writeFileSync(
      path.join(evidence, 'styles.json'),
      JSON.stringify(
        await page.evaluate(() =>
          Object.fromEntries(
            [
              '.focused-workspace',
              '.workspace-sidebar',
              '.workspace-sidebar button',
              '.unified-search-control-pane',
              '.unified-search-content',
              '.unified-search-shell',
            ].map((selector) => {
              const element = document.querySelector(selector)
              const css = getComputedStyle(element)
              return [
                selector,
                {
                  color: css.color,
                  background: css.backgroundColor,
                  border: css.border,
                  padding: css.padding,
                  font: css.font,
                  root: element.closest('[data-testid="app-root"]') !== null,
                  variables: ['--bg', '--fg', '--color-text', '--ui-accent-soft'].map((name) => [
                    name,
                    css.getPropertyValue(name),
                  ]),
                },
              ]
            }),
          ),
        ),
        null,
        2,
      ),
    )
    assert.equal(await page.getByTestId('unified-search-media-filter').isVisible(), false)
    assert.equal(await page.getByTestId('unified-search-export-options').count(), 0)
    await page.getByTestId('unified-search-filter-options').locator('summary').click()
    assert.equal(await page.getByTestId('unified-search-media-filter').isVisible(), true)
    await page.getByTestId('unified-search-filter-options').locator('summary').click()
    await page.keyboard.press('Control+k')
    assert.equal(
      await page
        .getByTestId('unified-search-query')
        .evaluate((element) => document.activeElement === element),
      true,
    )
    await page.getByTestId('unified-search-query').fill('素材')
    await page.getByTestId('unified-search-result').first().waitFor()
    await page.screenshot({ path: path.join(evidence, 'results-light.png') })
    await page.locator('.unified-search-tile__preview').first().click()
    await page.locator('.unified-search-detail').waitFor()
    await page.screenshot({ path: path.join(evidence, 'details-light.png') })
    const geometry = []
    for (const width of [1320, 1000, 760]) {
      await page.setViewportSize({ width, height: 850 })
      const bounds = await page.getByTestId('app-root').boundingBox()
      assert.ok(Math.abs(bounds.width - width) < 2 && bounds.x === 0 && bounds.y === 0)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      const detail = await page.locator('.unified-search-detail').boundingBox()
      assert.ok(detail.x >= 0 && detail.x + detail.width <= width + 1)
      geometry.push({ width, bounds, detail })
      await page.screenshot({ path: path.join(evidence, `details-${width}.png`) })
    }
    await page.locator('.unified-search-detail__close').click()
    await page.setViewportSize({ width: 1320, height: 850 })
    for (const domain of ['library', 'sources', 'settings']) {
      await page.getByTestId('workspace-domain-' + domain).click()
      await page
        .locator(
          `[data-panel="${{ library: 'neko-search', sources: 'image-search', settings: 'settings' }[domain]}"]:visible`,
        )
        .waitFor()
      assert.equal(await page.locator('.panel:visible').count(), 1)
      if (domain === 'sources') {
        assert.equal(await page.getByTestId('image-search-query-section').count(), 0)
        assert.equal(
          await page.locator('[data-panel="image-search"] .panel-title').innerText(),
          '数据源',
        )
        assert.equal(await page.locator('.image-search-results-pane').count(), 0)
      }
      if (domain === 'library') {
        assert.equal(await page.getByTestId('asset-filter-source').isVisible(), false)
        await page.getByTestId('asset-library-filters').locator('summary').click()
        assert.equal(await page.getByTestId('asset-filter-source').isVisible(), true)
        await page.getByTestId('asset-library-filters').locator('summary').click()
        assert.doesNotMatch(await page.locator('.asset-library-shell').innerText(), /undefined/)
      }
      await page.screenshot({ path: path.join(evidence, domain + '.png') })
    }
    assert.equal(await page.getByTestId('window-material-glass').count(), 0)
    assert.equal(await page.getByTestId('workspace-window-hide').count(), 0)
    const overlayCalls = await page.evaluate(() =>
      window.__workspaceTest.calls.filter(({ method }) =>
        ['setOverlayShape', 'setIgnoreMouseEvents', 'setTransparency'].includes(method),
      ),
    )
    assert.deepEqual(overlayCalls, [], 'normal desktop startup never invokes overlay APIs')
    assert.deepEqual(errors, [])
    const report = {
      passed: true,
      syntheticBridge: true,
      darkAndLight: true,
      collapsedFilters: true,
      keyboardSearch: true,
      overlayApisUnused: true,
      geometry,
      errors,
    }
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
    console.log(
      JSON.stringify({ passed: true, screenshots: 10, viewports: geometry.length, pageErrors: 0 }),
    )
  } catch (error) {
    if (page) {
      fs.writeFileSync(path.join(evidence, 'failure.txt'), await page.locator('body').innerText())
      await page.screenshot({ path: path.join(evidence, 'failure.png') })
    }
    throw error
  } finally {
    await browser?.close()
    await server.close()
  }
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
