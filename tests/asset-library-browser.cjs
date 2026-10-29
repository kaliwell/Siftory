// Actual library UI with synthetic, stateful Electron bridge; never accesses user files.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

async function run() {
  const root = path.resolve(__dirname, '..')
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
    process.env.SIFTORY_UI_SCREENSHOT_DIR || path.join(root, 'artifacts/library-collection-ui')
  fs.mkdirSync(evidence, { recursive: true })
  let browser
  const errors = []
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
    const page = await browser.newPage({ viewport: { width: 1320, height: 850 } })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/workspace-ui.html`,
    )
    await page.getByTestId('image-search-query-section').waitFor()
    await page.evaluate(() => {
      const test = window.__workspaceTest
      const assets = Array.from({ length: 24 }, (_, i) => ({
        asset: {
          id: i + 1,
          path: `C:/fixtures/${['产品设计', '空间参考', '配色灵感', '材质纹理'][i % 4]}-${String(i + 1).padStart(2, '0')}.jpg`,
          kind: i % 7 === 6 ? 'video_frame' : 'image',
          source: 'image_search',
          width: 1600,
          height: 1200,
          fileSize: 10000 + i,
          modifiedTime: 100 + i,
          createdAt: 1,
          updatedAt: 100 + i,
          missing: false,
          favorite: i % 5 === 0,
          rating: 0,
        },
        categories: [{ categoryId: (i % 2) + 1 }],
        tags: [],
      }))
      const collections = [
        { id: 1, name: '品牌参考', createdAt: 1, updatedAt: 1 },
        { id: 2, name: '产品灵感', createdAt: 1, updatedAt: 1 },
      ]
      const collected = { 1: [], 2: [] }
      const fixture = {
        assets,
        collections,
        collected,
        failCollect: false,
        failList: false,
        slowCollection: 0,
      }
      window.__libraryFixture = fixture
      test.setHandler('assetLibrary.getStats', () => ({
        totalAssets: assets.length,
        classifiedAssets: assets.length,
        unclassifiedAssets: 0,
        suggestedCount: 0,
        lowConfidenceCount: 0,
        categoryCount: 2,
        tagCount: 0,
        clusterCount: 0,
        referenceCount: 0,
        archivedAssets: 0,
        storageState: 'ready',
        storageCorruptRows: 0,
      }))
      test.setHandler('assetLibrary.listCategories', () => [
        { id: 1, name: '产品', parentId: null, sortOrder: 1, color: '#669dcc' },
        { id: 2, name: '灵感', parentId: null, sortOrder: 2, color: '#ba9070' },
      ])
      test.setHandler('assetLibrary.listAssets', (request) => {
        let result = assets.filter(
          ({ asset, categories }) =>
            (!request.query || asset.path.includes(request.query)) &&
            (!request.categoryId || categories[0].categoryId === request.categoryId) &&
            (!request.kind || asset.kind === request.kind) &&
            (!request.favoriteOnly || asset.favorite),
        )
        if (request.source === 'manual') result = []
        return {
          items: result.slice(request.offset || 0, (request.offset || 0) + request.limit),
          total: result.length,
        }
      })
      test.setHandler('assetIdentity.listPendingRepairs', () => ({ ok: true, pending: [] }))
      test.setHandler('assetIdentity.resolve', (path) => ({
        ok: true,
        identity: { assetId: 'id:' + path },
      }))
      test.setHandler('assetIdentity.openOriginal', () => ({ ok: true }))
      test.setHandler('assetIdentity.revealOriginal', () => ({ ok: true }))
      test.setHandler('assetLibrary.listCollections', () => {
        if (fixture.failList) throw Error('Collection list failed')
        return [...collections]
      })
      test.setHandler('assetLibrary.createCollection', (name) => {
        if (collections.some((c) => c.name === name))
          throw Error('A collection with this name already exists')
        const item = { id: collections.length + 1, name, createdAt: 1, updatedAt: 1 }
        collections.push(item)
        collected[item.id] = []
        return item
      })
      test.setHandler('assetLibrary.addCollectionItems', (id, inputs) => {
        if (fixture.failCollect) throw Error('Collection write failed')
        for (const input of inputs) {
          if (!collected[id].some((item) => item.assetId === input.assetId))
            collected[id].push({
              ...input,
              id: Date.now() + collected[id].length,
              collectionId: id,
              addedAt: 1,
              referenceKey: input.assetId,
            })
        }
        return collected[id]
      })
      test.setHandler('assetLibrary.listCollectionItems', (id) => {
        const result = structuredClone(collected[id] || [])
        return fixture.slowCollection === id
          ? new Promise((resolve) => setTimeout(() => resolve(result), 600))
          : result
      })
      test.setHandler('assetLibrary.removeCollectionItem', (id) => {
        for (const key in collected)
          collected[key] = collected[key].filter((item) => item.id !== id)
        return { ok: true, affected: 1 }
      })
      const preview = (path) => {
        const i = Number(path.match(/(\d+)\.jpg/)?.[1] || 1)
        const palettes = [
          ['#dbe7df', '#75968c', '#f6f3e9'],
          ['#e4d7cb', '#bda18b', '#f5efdf'],
          ['#d8e3ed', '#7f9db3', '#f9f9ee'],
          ['#e9dcda', '#ba9090', '#fcf3eb'],
        ]
        const [bg, fg, light] = palettes[i % 4]
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${bg}"/><circle cx="470" cy="120" r="100" fill="${light}"/><path d="M0 360L640 300V480H0" fill="${fg}"/><rect x="200" y="100" width="170" height="270" rx="${i % 2 ? 80 : 12}" fill="${light}"/><rect x="224" y="130" width="122" height="130" rx="8" fill="${fg}" opacity=".65"/></svg>`
        return 'data:image/svg+xml;base64,' + btoa(svg)
      }
      test.setHandler('fmGetThumbnailsBatch', (requests) =>
        requests.map((request) => ({ path: request.path, dataUrl: preview(request.path) })),
      )
      test.setHandler('fmGetThumbnail', (path) => ({ dataUrl: preview(path) }))
    })
    await page.getByTestId('workspace-domain-library').click()
    const shell = page.locator('.asset-library-shell')
    const capture = async (name) => {
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(160)
      await page.screenshot({ path: path.join(evidence, name + '.png') })
    }
    await page.locator('.asset-library-card').first().waitFor()
    assert.equal(await page.getByTestId('asset-library-selection-bar').count(), 0)
    assert.equal(await page.getByTestId('asset-view-review').isVisible(), false)
    assert.equal(await page.getByTestId('asset-filter-source').isVisible(), false)
    assert.equal(await page.getByTestId('asset-filter-category').isVisible(), false)
    assert.equal(await page.getByTestId('asset-thumbnail-size').isVisible(), false)
    assert.equal(await page.locator('.asset-library-shell').getAttribute('data-layout'), 'simple')
    for (const mode of ['dark', 'light']) {
      await page.evaluate(
        (value) => window.__workspaceTest.store.getState().setThemeMode(value),
        mode,
      )
      for (const width of [1920, 1320, 946, 760]) {
        await page.setViewportSize({ width, height: 900 })
        await capture(`library-${mode}-${width}`)
        const controls = await page.locator('.asset-library-browser-controls').boundingBox()
        const gallery = await page.locator('.asset-library-gallery').boundingBox()
        const sidebar = await page.getByTestId('asset-library-sidebar').boundingBox()
        const content = await page.getByTestId('asset-library-content').boundingBox()
        assert.ok(sidebar.y + sidebar.height <= content.y + 1, 'compact header stays above content')
        assert.ok(controls.y + controls.height <= gallery.y + 1, 'search stays above the gallery')
        assert.ok(controls.width > content.width - 24, 'browsing uses the full content width')
        assert.ok(gallery.height > 300, 'gallery retains useful space')
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        const cards = await page.locator('.asset-library-card').all()
        for (const card of cards.slice(0, 3)) {
          const bounds = await card.boundingBox()
          const actions = await card.locator('.asset-library-card-actions').boundingBox()
          assert.ok(actions.y + actions.height <= bounds.y + bounds.height + 1)
        }
      }
    }
    await page.setViewportSize({ width: 1320, height: 900 })
    await page.evaluate(() => window.__workspaceTest.store.getState().setThemeMode('dark'))
    await page.getByTestId('asset-filter-query').fill('产品设计')
    await page.waitForFunction(() => document.querySelectorAll('.asset-library-card').length === 6)
    await page.getByTestId('asset-clear-filters').click()
    await page.getByTestId('asset-library-filters').locator(':scope > summary').click()
    await page.getByTestId('asset-filter-category').selectOption('2')
    await page.waitForFunction(() =>
      window.__workspaceTest.calls.some(
        (c) => c.method === 'assetLibrary.listAssets' && c.args[0].categoryId === 2,
      ),
    )
    await page.getByTestId('asset-filter-favorite').check()
    await page.waitForFunction(() => document.querySelectorAll('.asset-library-card').length === 2)
    await page.getByTestId('asset-clear-filters').click()
    await page.waitForFunction(() => document.querySelectorAll('.asset-library-card').length >= 4)
    await page.getByTestId('asset-library-albums').locator('summary').click()
    for (const height of [900, 1400]) {
      await page.setViewportSize({ width: 1920, height })
      await capture(`library-expanded-filters-${height}`)
      const layout = await page.locator('.asset-library-browser-controls').evaluate((controls) => {
        const albums = controls.querySelector('[data-testid="asset-smart-album-bar"]')
        return {
          overflow: controls.scrollWidth - controls.clientWidth,
          albumsInside:
            albums.getBoundingClientRect().right <= controls.getBoundingClientRect().right + 1,
        }
      })
      assert.ok(layout.overflow <= 1, 'expanded controls do not create horizontal scrolling')
      assert.ok(layout.albumsInside, 'saved filters fit the full-width filter panel')
      assert.ok((await page.locator('.asset-library-gallery').boundingBox()).height > 120)
    }
    await page.setViewportSize({ width: 1320, height: 900 })
    await page.getByTestId('asset-library-albums').locator('summary').click()
    await capture('library-more-filters')
    await page.getByTestId('asset-filter-source').selectOption('manual')
    await page.getByTestId('asset-library-empty').waitFor()
    await page.getByTestId('asset-clear-filters').click()
    await page.getByTestId('asset-library-filters').locator(':scope > summary').click()
    await page.locator('.asset-library-card').first().waitFor()
    await page.getByTestId('asset-select').nth(0).check()
    await page.getByTestId('asset-select').nth(1).check()
    await page.getByTestId('asset-library-batch-actions').locator('summary').click()
    await page.getByTestId('asset-library-create-collection').click()
    await page.getByTestId('collection-name').fill('新品参考')
    await shell.locator('form').getByRole('button', { name: '创建', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelector('[data-testid="asset-library-collection-select"]').value === '3',
    )
    await page.getByTestId('asset-library-batch-actions').locator('summary').click()
    await page.evaluate(() => {
      window.__libraryFixture.failCollect = true
    })
    await page.getByTestId('asset-library-collect-selected').click()
    await page
      .getByTestId('asset-library-collection-status')
      .getByText('操作失败。', { exact: true })
      .waitFor()
    await page.evaluate(() => {
      window.__libraryFixture.failCollect = false
    })
    await page.getByTestId('asset-library-collect-selected').click()
    await page
      .getByTestId('asset-library-collection-status')
      .getByText(/已将 2 项/)
      .waitFor()
    await capture('library-selected')
    await page.getByTestId('asset-library-collections').click()
    await page.getByTestId('collection-browse-select').selectOption('3')
    await page.locator('.asset-library-collection-card').first().waitFor()
    assert.equal(await page.locator('.asset-library-collection-card').count(), 2)
    await capture('library-collections')
    await page.getByTestId('collection-filter-query').fill('产品设计')
    assert.equal(await page.locator('.asset-library-collection-card').count(), 1)
    await page.getByTestId('collection-filter-query').fill('')
    await page
      .locator('.asset-library-collection-card')
      .first()
      .getByRole('button', { name: '打开', exact: true })
      .click()
    await page.waitForFunction(() =>
      window.__workspaceTest.calls.some((c) => c.method === 'assetIdentity.openOriginal'),
    )
    await page.evaluate(() => {
      window.__libraryFixture.slowCollection = 3
    })
    await page.getByTestId('collection-browse-select').selectOption('1')
    await page.getByTestId('collection-browse-select').selectOption('3')
    await page.getByTestId('collection-browse-select').selectOption('2')
    await page.waitForTimeout(700)
    assert.equal(
      await page.locator('.asset-library-collection-card').count(),
      0,
      'late collection response must not replace current collection',
    )
    await page.evaluate(() => {
      window.__libraryFixture.slowCollection = 0
    })
    await page.getByTestId('collection-browse-select').selectOption('3')
    await page.getByTestId('collection-item-select').first().check()
    await page.getByTestId('collection-remove-selected').click()
    await page.waitForFunction(
      () => document.querySelectorAll('.asset-library-collection-card').length === 1,
    )
    assert.equal(await page.evaluate(() => window.__libraryFixture.assets.length), 24)
    await page.getByTestId('collection-create').click()
    await page.getByTestId('collection-name').fill('新品参考')
    await shell.locator('form').getByRole('button', { name: '创建', exact: true }).click()
    await shell.locator('form [role="alert"]').waitFor()
    await shell.locator('form').getByRole('button', { name: '取消', exact: true }).click()
    await page.getByTestId('asset-mode-assets').click()
    await page.getByTestId('asset-library-tools').locator('summary').click()
    await page.getByTestId('asset-mode-categories').click()
    await page.getByTestId('asset-new-category-name').waitFor()
    await page.getByTestId('asset-view-review').click()
    await page.getByTestId('asset-mode-sampleSearch').click()
    await page.getByTestId('asset-library-sidebar').getByTestId('asset-search-category').waitFor()
    assert.equal(
      await page.getByTestId('asset-library-content').getByTestId('asset-search-category').count(),
      0,
    )
    await capture('library-sample-search-sidebar')
    await page.getByTestId('asset-mode-assets').click()
    await page.getByTestId('asset-library-tools').locator('summary').click()
    await page.evaluate(() => {
      window.__libraryFixture.collections.splice(0)
      window.dispatchEvent(new Event('asset-collections-changed'))
    })
    await page.getByTestId('asset-select').first().check()
    const firstCollection = page.getByTestId('asset-library-collect-selected')
    await firstCollection.filter({ hasText: '新建收藏夹' }).waitFor()
    assert.equal(await page.getByTestId('asset-library-collection-select').count(), 0)
    await firstCollection.click()
    await page.getByTestId('collection-name').fill('首次收藏')
    await shell.locator('form').getByRole('button', { name: '创建', exact: true }).click()
    await firstCollection.filter({ hasText: '加入收藏夹' }).waitFor()
    await firstCollection.click()
    await page
      .getByTestId('asset-library-collection-status')
      .getByText(/已将 1 项/)
      .waitFor()
    await capture('library-first-collection')
    await page.getByRole('button', { name: '清除选择', exact: true }).click()
    await page.evaluate(() => {
      window.__libraryFixture.assets.splice(0)
    })
    await page
      .getByTestId('asset-library-sync')
      .locator('..')
      .getByRole('button', { name: '刷新', exact: true })
      .click()
    await page.getByTestId('asset-library-empty').waitFor()
    await capture('library-empty')
    await page
      .getByTestId('asset-library-empty')
      .getByRole('button', { name: '管理数据源', exact: true })
      .click()
    await page.waitForFunction(
      () =>
        document.querySelector('[data-panel="image-search"] .panel-title')?.textContent ===
        '数据源',
    )
    assert.deepEqual(errors, [])
    const report = {
      passed: true,
      themes: 2,
      widths: [1920, 1320, 946, 760],
      simpleBrowsing: true,
      firstCollectionShortcut: true,
      reviewSidebarControls: true,
      collectionCreate: true,
      collectionWriteRetry: true,
      collectionBrowse: true,
      staleResponseProtection: true,
      referenceRemovalOnly: true,
      categoryTools: true,
      emptyStateNavigation: true,
      pageErrors: errors,
    }
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  } finally {
    await browser?.close()
    await server.close()
  }
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
