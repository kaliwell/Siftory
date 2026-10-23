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
  const evidence =
    process.env.SIFTORY_UI_SCREENSHOT_DIR || path.join(root, 'artifacts/modern-desktop-ui')
  fs.mkdirSync(evidence, { recursive: true })
  let browser
  let page
  const failedResponses = []
  try {
    await server.listen()
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: process.platform === 'win32',
      args:
        process.platform === 'linux'
          ? [
              '--no-sandbox',
              '--no-zygote',
              '--single-process',
              '--disable-dev-shm-usage',
              '--use-gl=angle',
              '--use-angle=swiftshader',
            ]
          : [],
      ...(process.env.SIFTORY_TEST_CHROMIUM_PATH
        ? { executablePath: process.env.SIFTORY_TEST_CHROMIUM_PATH }
        : {}),
    })
    page = await browser.newPage({ viewport: { width: 1320, height: 850 } })
    const go = async (domain) => {
      if (domain === 'image-search' || domain === 'video-search') {
        await page.getByTestId('workspace-domain-search').click()
        await page
          .locator('.panel:visible')
          .getByTestId('workspace-tab-' + domain)
          .click()
      } else if (domain === 'video-indexing' || domain === 'sources') {
        await page.getByTestId('workspace-domain-sources').click()
        await page
          .locator('.panel:visible')
          .getByTestId(
            domain === 'sources' ? 'workspace-tab-image-sources' : 'workspace-tab-video-sources',
          )
          .click()
      } else await page.getByTestId('workspace-domain-' + domain).click()
      await page.locator('.panel:visible').waitFor()
    }
    const errors = []
    page.on('response', (response) => {
      if (response.status() >= 400)
        failedResponses.push({ status: response.status(), url: response.url() })
    })
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
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
      await go(domain)
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
    await go('image-search')
    const originalSearch = page.locator('[data-panel="image-search"]')
    await page.getByTestId('image-search-query-section').waitFor()
    assert.equal(await page.locator('.workspace-sidebar [aria-current="page"]').count(), 1)
    assert.equal(
      await page.getByTestId('workspace-domain-search').getAttribute('aria-current'),
      'page',
    )
    await originalSearch.getByTestId('search-mode-simple').click()
    await page.screenshot({ path: path.join(evidence, 'image-search-simple.png') })
    await originalSearch.getByTestId('search-mode-advanced').click()
    const engine = originalSearch.locator('select:has(option[value="fast"])')
    assert.deepEqual(
      await engine
        .locator('option')
        .evaluateAll((options) => options.map((option) => option.value)),
      ['fast', 'standard', 'precise'],
    )
    for (const mode of ['fast', 'standard', 'precise']) {
      await engine.selectOption(mode)
      await originalSearch.getByTestId('image-search-query-image').click()
      await page.waitForFunction(
        (expected) =>
          window.__workspaceTest.calls.some((call) =>
            expected === 'fast'
              ? call.method === 'imageSearch.search' && call.args[0].searchMode === expected
              : call.method === 'vector.searchLayered' && call.args[0].mode === expected,
          ),
        mode,
      )
      await originalSearch.getByTestId('image-search-query-image').waitFor({ state: 'visible' })
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="image-search-query-image"]').disabled,
      )
    }
    await page.screenshot({ path: path.join(evidence, 'image-search-advanced.png') })
    await page.setViewportSize({ width: 760, height: 850 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: path.join(evidence, 'image-search-760.png') })
    await page.setViewportSize({ width: 1320, height: 850 })
    await page.getByTestId('workspace-domain-sources').click()
    assert.equal(await page.getByTestId('image-search-query-section').count(), 0)
    assert.equal(
      await page.getByTestId('workspace-domain-sources').getAttribute('aria-current'),
      'page',
    )
    await go('image-search')
    assert.equal(
      await engine.inputValue(),
      'precise',
      'returning to the original search retains its controls',
    )
    await page.waitForFunction(
      () =>
        window.__workspaceTest.getSettings().imageSearchUiPreferences?.workspaceView === 'search',
    )
    await page.reload()
    await page.locator('[data-ready="true"]').waitFor()
    assert.equal(
      await page.evaluate(
        () => window.__workspaceTest.store.getState().imageSearchUiPreferences.workspaceView,
      ),
      'search',
    )
    await go('image-search')
    await originalSearch.getByTestId('search-mode-advanced').waitFor()
    assert.equal(
      await originalSearch.getByTestId('search-mode-advanced').getAttribute('aria-checked'),
      'true',
    )
    const overlayCalls = await page.evaluate(() =>
      window.__workspaceTest.calls.filter(({ method }) =>
        ['setOverlayShape', 'setIgnoreMouseEvents', 'setTransparency'].includes(method),
      ),
    )
    assert.deepEqual(overlayCalls, [], 'normal desktop startup never invokes overlay APIs')
    const settingsGeometry = []
    assert.equal(await page.getByTestId('workspace-domain-image-search').count(), 0)
    assert.equal(await page.getByTestId('workspace-domain-video-indexing').count(), 0)
    assert.equal(await originalSearch.getByTestId('image-search-library-section').count(), 0)
    assert.equal(await originalSearch.getByTestId('image-search-sources-section').count(), 0)
    for (const domain of [
      'video-search',
      'video-indexing',
      'duplicate-finder',
      'maintenance',
      'settings',
    ]) {
      await go(domain)
      await page.locator('.panel:visible').waitFor()
      await page.waitForTimeout(250)
      assert.equal(await page.locator('.panel:visible').count(), 1)
      assert.doesNotMatch(
        await page.locator('.panel:visible').innerText(),
        /Something went wrong|组件出现错误/,
      )
      await page.screenshot({ path: path.join(evidence, domain + '.png') })
    }
    assert.equal(await page.getByTestId('settings-nav-panels').count(), 0)
    for (const category of ['searchModels', 'dataReset', 'aiControl', 'system', 'appearance']) {
      await page.getByTestId('settings-nav-' + category).click()
      assert.equal(await page.locator('.settings-category:visible').count(), 1)
      assert.equal(await page.locator(`[data-settings-category="${category}"]`).isVisible(), true)
      if (category === 'searchModels') {
        await page
          .getByTestId('video-semantic-runtime-state')
          .filter({ hasText: '未安装' })
          .waitFor()
      }
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(evidence, 'settings-' + category + '.png') })
    }
    for (const width of [1920, 1440, 1000, 760]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.getByTestId('workspace-domain-settings').click()
      const control = await page.locator('#app-language').boundingBox()
      assert.ok(control.width <= 340, 'preferences controls must stay bounded')
      assert.ok(
        control.x >= 0 && control.x + control.width <= width,
        'preferences control stays on screen',
      )
      settingsGeometry.push({ width, control })
      for (const domain of [
        'settings',
        'image-search',
        'video-search',
        'video-indexing',
        'duplicate-finder',
        'maintenance',
      ]) {
        await go(domain)
        await page.waitForTimeout(120)
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${domain}: no horizontal page overflow at ${width}`,
        )
        const body = await page
          .locator('.panel:visible .panel-body')
          .evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }))
        assert.ok(
          body.scroll <= body.client + 1,
          `${domain}: panel overflow at ${width}: ${JSON.stringify(body)}`,
        )
        if (width === 760) await page.screenshot({ path: path.join(evidence, domain + '-760.png') })
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.evaluate(() => window.__workspaceTest.store.getState().setThemeMode('dark'))
    for (const domain of ['settings', 'image-search', 'maintenance']) {
      await go(domain)
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(evidence, domain + '-dark.png') })
    }
    await page.getByTestId('workspace-domain-tasks').click()
    await page.waitForTimeout(150)
    const taskHeading = await page.locator('.workspace-task-drawer > header strong').boundingBox()
    assert.ok(taskHeading.height < 36, 'task drawer title must stay on one line')
    assert.doesNotMatch(await page.locator('.workspace-task-drawer').innerText(), /NaN|undefined/)
    await page.screenshot({ path: path.join(evidence, 'tasks-dark.png') })
    assert.equal(await page.getByTestId('product-task-image-index').count(), 0)
    await page.getByTestId('task-history-toggle').click()
    assert.equal(await page.getByTestId('product-task-image-index').isVisible(), true)
    await page.getByTestId('task-history-toggle').click()
    await page.evaluate(() =>
      window.__workspaceTest.setMediaTask({
        taskId: 'fixture-video-task',
        type: 'scan',
        state: 'error',
        completed: 2,
        total: 5,
        failed: 1,
        percentage: 40,
        startedAt: 1,
        updatedAt: 2,
        error: 'Fixture: source unavailable',
      }),
    )
    await page.locator('.workspace-preparation-details > summary').click()
    await page.getByTestId('product-readiness-refresh').click()
    await page.getByTestId('product-task-video-index').waitFor()
    assert.equal(await page.getByTestId('product-task-image-index').count(), 0)
    await page.getByTestId('task-history-toggle').click()
    assert.equal(
      await page.locator('.product-readiness__task').first().getAttribute('data-testid'),
      'product-task-video-index',
    )
    await page.locator('.workspace-preparation-details > summary').click()
    await page.screenshot({ path: path.join(evidence, 'tasks-attention.png') })
    await page.evaluate(() => window.__workspaceTest.setMediaTask(null))

    await page
      .getByTestId('workspace-task-summary')
      .getByRole('button', { name: '关闭', exact: true })
      .click()
    await go('video-search')
    assert.equal(await page.getByTestId('media-search-sources-section').count(), 0)
    const videoQuery = page.getByTestId('media-search-query-section').locator('input').last()
    await videoQuery.fill('海边日落')
    await go('video-indexing')
    assert.equal(await page.getByTestId('media-search-query-section').count(), 0)
    assert.equal(await page.getByTestId('media-search-sources-section').isVisible(), true)
    await go('video-search')
    assert.equal(await videoQuery.inputValue(), '海边日落')
    await page.waitForFunction(
      () =>
        window.__workspaceTest.getSettings().mediaSearchUiPreferences?.workspaceView === 'search',
    )
    await page.reload()
    await page.locator('[data-ready="true"]').waitFor()
    assert.equal(
      await page.evaluate(
        () => window.__workspaceTest.store.getState().mediaSearchUiPreferences.workspaceView,
      ),
      'search',
    )
    await go('video-search')
    assert.equal(
      await page
        .locator('.panel:visible')
        .getByTestId('workspace-tab-video-search')
        .getAttribute('aria-current'),
      'page',
    )
    await page.setViewportSize({ width: 760, height: 900 })
    await page.getByTestId('workspace-sidebar-toggle').click()
    assert.equal(await page.locator('.workspace-sidebar').getAttribute('data-collapsed'), 'true')
    await page.screenshot({ path: path.join(evidence, 'collapsed-navigation.png') })
    await page.getByTestId('workspace-sidebar-toggle').click()
    assert.equal(await page.locator('.workspace-sidebar').getAttribute('data-collapsed'), 'false')
    await go('maintenance')
    assert.equal(await page.locator('.workspace-advanced-maintenance').getAttribute('open'), null)
    assert.equal(
      await page.evaluate(
        () =>
          window.__workspaceTest.calls.filter((call) => call.method === 'imageSearch.queryData')
            .length,
      ),
      0,
      'advanced records stay unloaded until requested',
    )
    await page.locator('.workspace-advanced-maintenance > summary').click()
    await page.waitForFunction(() =>
      window.__workspaceTest.calls.some((call) => call.method === 'imageSearch.queryData'),
    )
    await page.screenshot({ path: path.join(evidence, 'maintenance-advanced.png') })
    assert.deepEqual(errors, [])
    const report = {
      passed: true,
      syntheticBridge: true,
      darkAndLight: true,
      collapsedFilters: true,
      keyboardSearch: true,
      originalImageSearchRestored: true,
      originalSearchModesWired: true,
      imageWorkspaceSelectionPersisted: true,
      overlayApisUnused: true,
      unifiedNavigation: true,
      videoRoutePersisted: true,
      queryRetainedBetweenViews: true,
      sidebarCollapsible: true,
      geometry,
      settingsGeometry,
      errors,
    }
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
    console.log(
      JSON.stringify({
        passed: true,
        screenshots: fs.readdirSync(evidence).filter((name) => name.endsWith('.png')).length,
        viewports: geometry.length,
        originalSearchModesWired: true,
        pageErrors: 0,
      }),
    )
  } catch (error) {
    fs.writeFileSync(
      path.join(evidence, 'failed-responses.json'),
      JSON.stringify(failedResponses, null, 2),
    )
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
