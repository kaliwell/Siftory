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
    server: {
      host: '127.0.0.1',
      port: 0,
      watch: { ignored: ['**/release/**', '**/native/build*/**', '**/artifacts/**'] },
    },
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
    await page.locator('[data-testid="app-root"][data-ready="true"]').waitFor()
    await page.getByTestId('image-search-query-section').waitFor()
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(200)
    await page.screenshot({ path: path.join(evidence, 'empty-dark.png') })
    await page.evaluate(() => window.__workspaceTest.store.getState().setThemeMode('light'))
    await page.waitForFunction(() => document.documentElement.dataset.effectiveMode === 'light')
    await page.waitForTimeout(200)
    await page.screenshot({ path: path.join(evidence, 'empty-light.png') })
    for (const width of [2560, 1920, 1440, 1000, 760]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForTimeout(150)
      const controls = await page.locator('.image-search-control-pane').boundingBox()
      const content = await page.locator('.image-search-results-pane').boundingBox()
      if (width >= 1440) {
        assert.ok(controls.x + controls.width <= content.x)
        assert.ok(Math.abs(controls.y - content.y) < 2)
      } else assert.ok(controls.y + controls.height <= content.y + 1)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await page.screenshot({ path: path.join(evidence, `image-split-${width}.png`) })
    }
    await page.setViewportSize({ width: 1320, height: 850 })
    fs.writeFileSync(
      path.join(evidence, 'styles.json'),
      JSON.stringify(
        await page.evaluate(() =>
          Object.fromEntries(
            [
              '.focused-workspace',
              '.workspace-sidebar',
              '.workspace-sidebar button',
              '.image-search-control-pane',
              '.image-search-results-pane',
              '.image-search-shell',
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
    assert.equal(await page.getByTestId('workspace-tab-all-search').count(), 0)
    assert.equal(await page.getByTestId('workspace-domain-duplicate-finder').count(), 0)
    const geometry = []
    for (const width of [1320, 1000, 760]) {
      await page.setViewportSize({ width, height: 850 })
      const bounds = await page.getByTestId('app-root').boundingBox()
      assert.ok(Math.abs(bounds.width - width) < 2 && bounds.x === 0 && bounds.y === 0)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      geometry.push({ width, bounds })
      await page.screenshot({ path: path.join(evidence, `search-${width}.png`) })
    }
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
          '扫描目录',
        )
        assert.equal(await page.locator('.image-search-results-pane').count(), 0)
      }
      if (domain === 'library') {
        assert.equal(await page.getByTestId('asset-filter-source').isVisible(), false)
        await page.getByTestId('asset-library-filter-toggle').click()
        assert.equal(await page.getByTestId('asset-filter-source').isVisible(), true)
        await page.keyboard.press('Escape')
        assert.doesNotMatch(await page.locator('.asset-library-shell').innerText(), /undefined/)
        for (const width of [2560, 1920, 1440, 1000, 760]) {
          await page.setViewportSize({ width, height: 900 })
          const card = page.locator('.asset-library-card').first()
          await card.waitFor()
          await page.waitForFunction(() => {
            const width = document
              .querySelector('.asset-library-card')
              ?.getBoundingClientRect().width
            return width >= 239 && width < 500
          })
          const bounds = await card.boundingBox()
          assert.ok(
            bounds.width >= 239 && bounds.width < 500,
            `gallery card width at ${width}: ${bounds.width}`,
          )
          const preview = await card.locator('.asset-library-card-preview').boundingBox()
          assert.ok(preview.height >= 179)
          if (width >= 1200) {
            const controls = await page.locator('.asset-library-browser-controls').boundingBox()
            const gallery = await page.locator('.asset-library-gallery').boundingBox()
            assert.ok(controls.y + controls.height <= gallery.y + 1)
            assert.ok(gallery.height > 300)
          }
          const actions = await card.locator('.asset-library-card-actions').boundingBox()
          assert.ok(actions.y + actions.height <= bounds.y + bounds.height)
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          await page.screenshot({ path: path.join(evidence, `library-${width}.png`) })
        }
        const size = page.getByTestId('asset-thumbnail-size')
        await size.fill('320')
        await page.waitForTimeout(200)
        assert.ok((await page.locator('.asset-library-card').first().boundingBox()).width >= 319)
        await page.getByTestId('asset-select').first().check()
        await page.getByTestId('asset-library-batch-actions').locator('summary').click()
        assert.ok((await page.locator('.asset-library-gallery').boundingBox()).height > 120)
        await page.getByTestId('asset-library-batch-actions').locator('summary').click()
        await size.fill('240')
        await page.setViewportSize({ width: 1920, height: 900 })
        await page.evaluate(() => window.__workspaceTest.store.getState().setThemeMode('dark'))
        await page.waitForFunction(() => document.documentElement.dataset.effectiveMode === 'dark')
        await page.waitForTimeout(300)
        await page.screenshot({ path: path.join(evidence, 'library-dark-1920.png') })
        await page.evaluate(() => window.__workspaceTest.store.getState().setThemeMode('light'))
        await page.setViewportSize({ width: 1320, height: 850 })
      }
      await page.screenshot({ path: path.join(evidence, domain + '.png') })
    }
    await go('maintenance')
    await page.evaluate(() => window.__workspaceTest.setCatalogAnalyzed(false))
    const indexSection = page.getByTestId('maintenance-index-section')
    if ((await indexSection.getAttribute('data-collapsed')) === 'true')
      await indexSection.locator('button.search-control-section__header').click()
    const inventory = page.getByTestId('image-search-data-overview')
    await inventory.getByRole('button', { name: '刷新文件清单', exact: true }).click()
    await inventory
      .getByText('尚未分析索引统计，已有的搜索数据仍然保留。', { exact: false })
      .waitFor()
    assert.equal(
      (await inventory.locator('.index-overview-metrics strong').allTextContents()).filter(
        (value) => value === '—',
      ).length,
      3,
    )
    await page.screenshot({ path: path.join(evidence, 'maintenance-not-analyzed.png') })
    await page.evaluate(() => window.__workspaceTest.setCatalogAnalyzed(true))
    await inventory.getByRole('button', { name: '刷新文件清单', exact: true }).click()
    const automaticSection = page.getByTestId('maintenance-automatic-section')
    if ((await automaticSection.getAttribute('data-collapsed')) === 'true')
      await automaticSection.locator('button.search-control-section__header').click()
    await page.getByTestId('automatic-maintenance').waitFor()
    await page.getByTestId('automatic-maintenance-enabled').check()
    await page.getByTestId('automatic-maintenance-check').click()
    await page
      .getByTestId('automatic-maintenance')
      .getByText('上次检查已完成', { exact: true })
      .waitFor()
    for (const width of [1920, 1000, 760]) {
      await page.setViewportSize({ width, height: 900 })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await page.screenshot({ path: path.join(evidence, `automatic-maintenance-${width}.png`) })
    }
    await page.getByTestId('automatic-maintenance-enabled').uncheck()
    await page.setViewportSize({ width: 1320, height: 850 })
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
    const diagnostics = originalSearch.locator('.search-diagnostics-controls')
    await diagnostics.locator('summary').click()
    await diagnostics.getByRole('button', { name: '结果不对，标记本次查询', exact: true }).click()
    await diagnostics.getByRole('button', { name: '导出搜索诊断', exact: true }).click()
    await diagnostics.getByRole('button', { name: '清空搜索诊断', exact: true }).click()
    await page.waitForFunction(() =>
      window.__workspaceTest.calls.some(
        (c) => c.method === 'imageSearch.reportSearchDiagnostic' && c.args[1] === 'incorrect',
      ),
    )
    assert.ok(
      await page.evaluate(() =>
        window.__workspaceTest.calls.some(
          (c) => c.method === 'imageSearch.exportSearchDiagnostics',
        ),
      ),
    )
    await page.screenshot({ path: path.join(evidence, 'search-diagnostics.png') })
    await diagnostics.locator('summary').click()
    const headerBounds = await originalSearch.locator(':scope > .panel-header').boundingBox()
    assert.ok(headerBounds.height <= 56, 'compact page heading')
    const ready = originalSearch.locator('.workspace-preparation-link[data-ready="true"]')
    assert.ok((await ready.boundingBox()).height <= 42, 'ready status is no longer a tall card')
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
    await page.locator('[data-testid="app-root"][data-ready="true"]').waitFor()
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
    for (const domain of ['video-search', 'video-indexing', 'maintenance', 'settings']) {
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
      if (category === 'dataReset') {
        const location = page
          .locator('[data-settings-category="dataReset"]:visible')
          .getByTestId('storage-location-settings')
        await location.getByText('C:/fixtures/Siftory-data', { exact: true }).waitFor()
        await location.getByTestId('storage-location-choose').click()
        await location
          .getByTestId('storage-location-destination')
          .filter({ hasText: 'E:/Siftory-data-fixture' })
          .waitFor()
        await location.getByTestId('storage-location-migrate').click()
        await location.getByTestId('storage-location-destination').waitFor({ state: 'detached' })
        await location.getByTestId('storage-location-choose').click()
        await location.getByRole('button', { name: '取消', exact: true }).click()
        assert.equal(await location.getByTestId('storage-location-destination').count(), 0)
      }
      if (category === 'system') {
        await page.evaluate(() => {
          window.__workspaceTest.setHandler('registerHotkey', (accelerator) => ({
            active: true,
            entries: [
              {
                id: 'toggle-primary',
                accelerator: accelerator.endsWith('F8')
                  ? 'CommandOrControl+Shift+Alt+Q'
                  : accelerator,
                status: 'registered',
              },
            ],
            ...(accelerator.endsWith('F8') ? { error: 'Shortcut conflicts' } : {}),
          }))
        })
        const editor = page.locator('.settings-hotkey-editor')
        const focusRecorder = async () => {
          await editor.getByTestId('visibility-hotkey').focus()
          await editor
            .locator('[data-testid="visibility-hotkey"][data-recording-ready="true"]')
            .waitFor()
        }
        await focusRecorder()
        await editor.getByTestId('visibility-hotkey').press('Control+Alt+F8')
        await editor.getByTestId('save-visibility-hotkey').click()
        await editor.getByRole('status').filter({ hasText: '快捷键冲突' }).waitFor()
        await focusRecorder()
        await editor.getByTestId('visibility-hotkey').press('Control+Alt+F9')
        await editor.getByTestId('save-visibility-hotkey').click()
        await editor.getByRole('status').filter({ hasText: '快捷键已保存' }).waitFor()
        assert.equal(await editor.getByTestId('visibility-hotkey').inputValue(), 'Ctrl+Alt+F9')
        await focusRecorder()
        await editor.getByTestId('visibility-hotkey').dispatchEvent('keydown', {
          key: 'Tab',
          code: 'Tab',
          ctrlKey: true,
          bubbles: true,
        })
        assert.equal(await editor.getByTestId('visibility-hotkey').inputValue(), 'Ctrl+Tab')
        await editor.getByTestId('visibility-hotkey').press('Tab')
        await page.waitForFunction(() => {
          const calls = window.__workspaceTest.calls.filter(
            (call) => call.method === 'setHotkeyRecording',
          )
          return calls.at(-1)?.args[0] === false
        })
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
    await go('image-search')
    await page.getByTestId('image-search-query-image').click()
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="image-search-query-image"]').disabled,
    )
    await page.route('**/src/components/WorkspaceTasksPage.tsx*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 650))
      await route.continue()
    })
    await page.getByTestId('image-search-install-models').click()
    await page.waitForFunction(
      () => document.querySelector('[data-testid="product-model-manager"]')?.open === true,
    )
    await page.getByTestId('product-model-manager').locator('summary').click()
    await go('image-search')
    await page.getByTestId('workspace-domain-tasks').click()
    await page.waitForTimeout(150)
    const taskHeading = await page.locator('.workspace-task-page > header h1').boundingBox()
    assert.ok(taskHeading.height < 36, 'task page title must stay on one line')
    assert.doesNotMatch(await page.locator('.workspace-task-page').innerText(), /NaN|undefined/)
    const clipboardBefore = await page.evaluate(
      () =>
        window.__workspaceTest.calls.filter((c) => c.method === 'imageSearch.pasteClipboardImage')
          .length,
    )
    await page.keyboard.press('Control+v')
    await page.waitForTimeout(100)
    assert.equal(
      await page.evaluate(
        () =>
          window.__workspaceTest.calls.filter((c) => c.method === 'imageSearch.pasteClipboardImage')
            .length,
      ),
      clipboardBefore,
      'hidden image page must not handle clipboard shortcuts',
    )
    assert.equal(
      await page.evaluate(() => window.__workspaceTest.getSettings().workspaceTaskPageOpen),
      undefined,
      'task route is not persisted as a legacy panel flag',
    )

    await page.screenshot({ path: path.join(evidence, 'tasks-dark.png') })
    await page.evaluate(() =>
      window.__workspaceTest.setEmbeddingTask({
        state: 'running',
        completed: 19400,
        skipped: 0,
        failed: 4,
        total: 19412,
        modelName: 'dinov2_vitb14',
        pending: 8,
        running: 0,
      }),
    )
    const progressTask = page.getByTestId('product-task-image-embedding')
    await progressTask.waitFor()
    await progressTask.getByText('99.9%', { exact: true }).waitFor()
    assert.match(await progressTask.innerText(), /剩余 8/)
    assert.ok(
      await progressTask
        .locator('.product-readiness__task-meta small')
        .first()
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize) >= 12),
    )
    await page.evaluate(() => window.__workspaceTest.store.getState().toggleGlobalVisibility())
    assert.equal(await page.locator('.workspace-task-page:visible').count(), 0)
    await page.evaluate(() => window.__workspaceTest.store.getState().toggleGlobalVisibility())
    await page.locator('.workspace-task-page:visible').waitFor()

    await page.screenshot({ path: path.join(evidence, 'tasks-progress-99.9.png') })
    const taskPage = page.locator('.workspace-task-page')
    assert.equal(
      await page.locator('.panel:visible').count(),
      0,
      'task page replaces the current workspace view',
    )
    assert.equal(
      await page.locator('.workspace-task-drawer:not(.workspace-guide-drawer)').count(),
      0,
      'no task drawer remains',
    )
    assert.equal(
      await taskPage.evaluate((el) => el.closest('nav') === null),
      true,
      'task page is outside navigation',
    )
    assert.equal(
      await page.getByTestId('workspace-domain-tasks').getAttribute('aria-current'),
      'page',
    )
    assert.equal(await page.locator('.workspace-sidebar [aria-current="page"]').count(), 1)
    const taskGeometry = []
    for (const width of [1920, 1320, 946, 760]) {
      await page.setViewportSize({ width, height: 900 })
      const bounds = await taskPage.boundingBox()
      const nav = await page.locator('.workspace-sidebar').boundingBox()
      assert.ok(bounds.x >= nav.x + nav.width - 1)
      assert.ok(
        Math.abs(bounds.width - (width - bounds.x)) < 2,
        'task page fills the workspace width',
      )
      assert.equal(await taskPage.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true)
      taskGeometry.push({ width, page: bounds })
      await page.screenshot({ path: path.join(evidence, `task-page-dark-${width}.png`) })
    }
    fs.writeFileSync(
      path.join(evidence, 'task-page-geometry.json'),
      JSON.stringify(taskGeometry, null, 2),
    )
    await page.evaluate(() => window.__workspaceTest.store.getState().setThemeMode('light'))
    await page.setViewportSize({ width: 1320, height: 900 })
    await page.screenshot({ path: path.join(evidence, 'task-page-light.png') })
    await page.evaluate(() => window.__workspaceTest.store.getState().setThemeMode('dark'))

    await page.evaluate(() => window.__workspaceTest.setEmbeddingTask(null))
    await progressTask.waitFor({ state: 'hidden' })

    assert.equal(await page.getByTestId('product-task-image-index').count(), 0)
    await page.getByTestId('task-view-completed').click()
    assert.equal(await page.getByTestId('product-task-image-index').isVisible(), true)
    await page.getByTestId('task-view-current').click()
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
    await page.getByTestId('task-view-all').click()
    assert.equal(
      await page.locator('.product-readiness__task').first().getAttribute('data-testid'),
      'product-task-video-index',
    )
    await page.locator('.workspace-preparation-details > summary').click()
    await page.getByTestId('task-view-issues').click()
    assert.equal(await page.locator('.product-readiness__task').count(), 1)
    await page.screenshot({ path: path.join(evidence, 'tasks-attention.png') })
    await page.evaluate(() => window.__workspaceTest.setMediaTask(null))

    await go('image-search')
    assert.equal(
      await page.locator('.panel:visible input[readonly]').first().inputValue(),
      'C:/fixtures/reference.jpg',
      'returning from Tasks retains image query',
    )
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
    await page.locator('[data-testid="app-root"][data-ready="true"]').waitFor()
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
    if ((await indexSection.getAttribute('data-collapsed')) === 'true')
      await indexSection.locator('button.search-control-section__header').click()
    await page.locator('.workspace-advanced-maintenance').waitFor()
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
    // Data location has one editable owner: the maintenance surface is a
    // read-only summary and must jump to Settings -> Data & Reset instead of
    // offering a second migration control.
    const locationSection = page.getByTestId('maintenance-location-section')
    if ((await locationSection.getAttribute('data-collapsed')) === 'true')
      await locationSection.locator('button.search-control-section__header').click()
    const readOnlyLocation = locationSection.getByTestId('storage-location-settings')
    await readOnlyLocation.getByTestId('storage-location-current').waitFor()
    assert.equal(await readOnlyLocation.getByTestId('storage-location-choose').count(), 0)
    await readOnlyLocation.getByTestId('storage-location-open-settings').click()
    const editableLocation = page.locator(
      '[data-settings-category="dataReset"] [data-testid="storage-location-settings"]',
    )
    await editableLocation.getByTestId('storage-location-choose').waitFor()
    assert.equal(
      await page.locator('[data-settings-category="dataReset"]:visible').count(),
      1,
      'jump opens the editable data location in Settings',
    )
    await page.getByTestId('workspace-domain-maintenance').click()
    // Use a genuinely long image source list: moving source management out of
    // this view means the empty preparation form no longer needs to overflow.
    await page.evaluate(() =>
      window.__workspaceTest.store
        .getState()
        .setImageSearchScanPaths(
          Array.from(
            { length: 64 },
            (_, index) => `C:/fixtures/scroll-source-${index}-long-folder-name`,
          ),
        ),
    )
    // Source controls stay reachable while both source libraries scroll.
    for (const width of [1920, 1320, 946, 760]) {
      // Use a shorter window so the expanded source lists still overflow after the
      // compact chrome removed the page-heading row (54px). Both libraries must
      // scroll here for the pinned-toolbar assertion to mean anything.
      await page.setViewportSize({ width, height: 720 })
      for (const domain of ['sources', 'video-indexing']) {
        await go(domain)
        const prefix = domain === 'sources' ? 'image-search' : 'media-search'
        const headerBorders = await page
          .locator(`[data-sources-only='true'] button.search-control-section__header:visible`)
          .evaluateAll((headers) =>
            headers.map((header) => {
              const style = getComputedStyle(header)
              return [style.borderLeftWidth, style.borderRightWidth, style.borderTopWidth]
            }),
          )
        assert.ok(headerBorders.length > 0)
        assert.ok(
          headerBorders.every((borders) => borders.every((width) => width === '0px')),
          domain + ': card headers do not draw a second rectangular border',
        )
        await page.getByTestId(prefix + '-sections-expand-all').click()
        const shell = domain === 'sources' ? '.image-search-workspace' : '.media-search-workspace'
        const centered = await page.locator(shell + ':visible').evaluate((el) => {
          const bounds = el.getBoundingClientRect()
          const parent = el.parentElement.getBoundingClientRect()
          return {
            width: bounds.width,
            centerDelta: (bounds.left + bounds.right - parent.left - parent.right) / 2,
          }
        })
        assert.ok(centered.width <= 1121, domain + ': matches the settings content width')
        assert.ok(Math.abs(centered.centerDelta) < 2, domain + ': centered within the workspace')
        await page.waitForFunction(
          (selector) =>
            [...document.querySelectorAll(selector)].some(
              (el) => el.getClientRects().length && el.scrollHeight > el.clientHeight,
            ),
          shell,
        )
        await page.locator(shell + ':visible').evaluate((el) => {
          el.scrollTop = 220
        })
        await page.waitForTimeout(100)
        const pinned = await page.getByTestId(prefix + '-sections-toolbar').evaluate((el) => {
          const scroller = el
            .closest('[data-sources-only]')
            .querySelector('.image-search-workspace, .media-search-workspace')
          return {
            top: el.getBoundingClientRect().top,
            viewportTop: scroller.getBoundingClientRect().top,
            scroll: scroller.scrollTop,
          }
        })
        assert.ok(pinned.scroll > 0, domain + ': source list must actually scroll')
        assert.ok(Math.abs(pinned.top - pinned.viewportTop) < 12, domain + ': toolbar stays pinned')
        await page.getByTestId(prefix + '-sections-collapse-all').click()
        assert.equal(await page.getByTestId(prefix + '-sections-toolbar').isVisible(), true)
        await page.getByTestId(prefix + '-sections-expand-all').click()
        await page.screenshot({ path: path.join(evidence, `pinned-${domain}-${width}.png`) })
      }
      // The notice uses the footer even with the navigation collapsed.
      if (
        width === 760 &&
        (await page.locator('.workspace-sidebar').getAttribute('data-collapsed')) !== 'true'
      )
        await page.getByTestId('workspace-sidebar-toggle').click()
      const summary = page.locator('.workspace-alpha-disclosure > summary')
      assert.equal(await page.locator('.panel .workspace-alpha-notice').count(), 0)
      await summary.click()
      const popup = page.locator('.workspace-alpha-disclosure__content')
      await popup.waitFor()
      const bounds = await popup.boundingBox()
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width)
      assert.ok(
        await popup.evaluate((el) =>
          el.contains(
            document.elementFromPoint(
              el.getBoundingClientRect().x + 20,
              el.getBoundingClientRect().y + 20,
            ),
          ),
        ),
      )
      await page.screenshot({ path: path.join(evidence, `alpha-footer-${width}.png`) })
      await summary.press('Escape')
      await popup.waitFor({ state: 'hidden' })
    }
    for (const viewport of [
      { width: 946, height: 905 },
      { width: 946, height: 1326 },
      { width: 760, height: 1180 },
      { width: 540, height: 960 },
    ]) {
      await page.setViewportSize(viewport)
      for (const domain of [
        'image-search',
        'video-search',
        'library',
        'sources',
        'video-indexing',
        'settings',
      ]) {
        await go(domain)
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          domain + ': no portrait overflow',
        )
        if (domain.endsWith('-search')) {
          if (domain === 'image-search') {
            const pane = page.locator('.image-search-control-pane:visible')
            const diagnostics = pane.locator('.search-diagnostics-controls')
            await diagnostics.evaluate((el) => {
              el.open = true
            })
            const action = diagnostics.locator('button').nth(2)
            await action.scrollIntoViewIfNeeded()
            const reachable = await action.evaluate((el) => {
              const rect = el.getBoundingClientRect()
              const hit = document.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              )
              return hit === el || el.contains(hit)
            })
            assert.ok(reachable, 'diagnostic actions remain reachable after scrolling')
            assert.ok(
              await pane.evaluate((el) => el.scrollTop > 0),
              'query controls actually scroll',
            )
            await diagnostics.evaluate((el) => {
              el.open = false
            })
            await pane.evaluate((el) => {
              el.scrollTop = 0
            })
          }
          if (domain === 'video-search') {
            await page.locator('.panel:visible').getByTestId('search-mode-simple').click()
            if (viewport.width > 620) {
              const form = page.locator('.media-search-query-controls:visible')
              const semantic = await form.locator('.search-text-controls').boundingBox()
              const options = await form.locator('.search-options-grid').boundingBox()
              assert.ok(
                Math.abs(semantic.x - options.x) < 2,
                'video result count aligns with semantic input',
              )
              assert.ok(
                options.y >= semantic.y + semantic.height,
                'video result count sits below semantic input',
              )
            }
          }
          const prefix = domain === 'image-search' ? 'image-search' : 'media-search'
          const control = await page.locator(`.${prefix}-control-pane:visible`).boundingBox()
          const result = await page.locator(`.${prefix}-results-pane:visible`).boundingBox()
          assert.ok(control.height < viewport.height * 0.34, domain + ': compact portrait controls')
          assert.ok(
            result.height > viewport.height * 0.45,
            domain + ': results retain most of the height',
          )
        }
        await page.screenshot({
          path: path.join(evidence, `portrait-${domain}-${viewport.width}.png`),
        })
      }
    }
    for (const width of [1099, 1100, 1101, 1137, 1199, 1200, 1201]) {
      await page.setViewportSize({ width, height: 900 })
      for (const domain of ['image-search', 'video-search']) {
        await go(domain)
        const prefix = domain === 'image-search' ? 'image-search' : 'media-search'
        const controls = await page.locator(`.${prefix}-control-pane:visible`).boundingBox()
        const results = await page.locator(`.${prefix}-results-pane:visible`).boundingBox()
        if (width < 1200) {
          assert.ok(
            Math.abs(controls.width - results.width) < 3,
            `${domain} ${width}: stacked controls fill the width`,
          )
          assert.ok(controls.y + controls.height <= results.y + 1)
        } else {
          assert.ok(controls.x + controls.width <= results.x, `${domain} ${width}: side by side`)
        }
      }
      if (width === 1137)
        await page.screenshot({ path: path.join(evidence, 'search-breakpoint-1137.png') })
    }
    assert.deepEqual(errors, [])
    const report = {
      passed: true,
      syntheticBridge: true,
      darkAndLight: true,
      originalImageSearchRestored: true,
      originalSearchModesWired: true,
      imageWorkspaceSelectionPersisted: true,
      overlayApisUnused: true,
      imageAndVideoNavigation: true,
      videoRoutePersisted: true,
      queryRetainedBetweenViews: true,
      sidebarCollapsible: true,
      sourceToolbarPinned: true,
      alphaNoticeInFooter: true,
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
