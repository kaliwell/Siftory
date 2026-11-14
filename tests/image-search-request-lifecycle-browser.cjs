// Actual React UI; generated results and delayed IPC only. No real application data.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

async function main() {
  const root = path.resolve(__dirname, '..')
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
  const chrome =
    process.env.SIFTORY_TEST_CHROMIUM_PATH ||
    (process.platform === 'win32' &&
    fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')
      ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
      : undefined)
  let browser
  try {
    await server.listen()
    browser = await chromium.launch({
      headless: true,
      ...(chrome ? { executablePath: chrome } : {}),
    })
    const page = await browser.newPage({ viewport: { width: 1320, height: 850 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/workspace-ui.html`,
    )
    const query = page.getByTestId('image-search-query-image')
    const text = page.locator('.image-search-semantic-controls input')
    await query.waitFor()
    await text.fill('a blue car')
    assert.equal(await page.getByTestId('image-search-semantic-query').isDisabled(), true)
    const semanticCalls = () =>
      page.evaluate(
        () =>
          window.__workspaceTest.calls.filter((c) => c.method === 'vector.searchSemantic').length,
      )
    await text.press('Enter')
    assert.equal(await semanticCalls(), 0, 'Enter must honor the unavailable model')
    await page.evaluate(() => {
      window.__workspaceTest.delayMethod('vector.searchLayered', 0)
      window.__workspaceTest.setHandler('vector.searchLayered', (request) => {
        const response = {
          results: [],
          degraded: false,
          degradationReasons: [],
          mode: request.mode,
          searchMode: request.mode,
          hashCandidateCount: 0,
          mergedCandidateCount: 0,
          totalMs: 550,
        }
        return new Promise((resolve) => {
          window.__releaseImageAudit = () => {
            window.__imageAuditFinished = true
            resolve(response)
          }
        })
      })
    })
    await query.click()
    await page.waitForFunction(() => typeof window.__releaseImageAudit === 'function')
    const resultArea = page.getByTestId('image-search-results')
    await resultArea.getByText('正在搜索图片…', { exact: true }).waitFor()
    assert.equal(await resultArea.getByText('未找到相似图片', { exact: true }).count(), 0)
    await page.evaluate(() => {
      const request = window.__workspaceTest.calls.findLast(
        (c) => c.method === 'vector.searchLayered',
      ).args[0]
      window.__workspaceTest.emit('vector.onLayeredSearchProgress', {
        requestId: request.requestId,
        mode: 'standard',
        phase: 'vector_search',
        workStage: 'cache_building',
        unit: 'bytes',
        scanned: 1048576,
        total: 2097152,
        percent: 61,
        throughputPerSecond: 1048576,
        etaMs: 1000,
      })
    })
    await page.getByText('1.00 MiB/s', { exact: true }).waitFor()
    await page.getByText('正在构建搜索缓存', { exact: true }).waitFor()
    await page.evaluate(() => {
      const request = window.__workspaceTest.calls.findLast(
        (c) => c.method === 'vector.searchLayered',
      ).args[0]
      window.__workspaceTest.emit('vector.onLayeredSearchProgress', {
        requestId: request.requestId,
        mode: 'standard',
        phase: 'vector_search',
        workStage: 'cache_compacting',
        unit: 'records',
        scanned: 50,
        total: 100,
        throughputPerSecond: 50,
        etaMs: 1000,
      })
    })
    await page.getByText('50.00 条/s', { exact: true }).waitFor()
    assert.equal(await page.getByText('1.00 MiB/s', { exact: true }).count(), 0)
    assert.equal(await text.isDisabled(), true)
    // A dispatched keyboard event also exercises the handler's own disabled-state guard.
    await text.dispatchEvent('keydown', { key: 'Enter', bubbles: true })
    await page.evaluate(() => window.__releaseImageAudit())
    await page.waitForFunction(() => window.__imageAuditFinished)
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="image-search-query-image"]').disabled,
    )
    assert.equal(await semanticCalls(), 0)

    await resultArea.getByText('未找到相似图片', { exact: true }).waitFor()

    // A model readiness probe must not allow a second Enter to start a second request.
    await page.evaluate(() => {
      const f = window.__workspaceTest
      f.setHandler('vector.getModelStatus', (name) => ({
        name,
        state: 'downloaded',
        installedPath: 'C:/fixtures/verified-model',
      }))
      f.delayMethod('vector.getModelStatus', 100)
      f.delayMethod('vector.searchSemantic', 0)
      f.setHandler(
        'vector.searchSemantic',
        () =>
          new Promise((resolve) => {
            window.__releaseSemanticAudit = () =>
              resolve({
                results: [],
                degraded: false,
                degradationReasons: [],
                totalMs: 200,
                totalCandidates: 0,
              })
          }),
      )
      window.dispatchEvent(new Event('focus'))
    })
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="image-search-semantic-query"]').disabled,
    )
    await text.press('Enter')
    await text.dispatchEvent('keydown', { key: 'Enter', bubbles: true })
    await page.waitForFunction(() => typeof window.__releaseSemanticAudit === 'function')
    await page.evaluate(() => window.__releaseSemanticAudit())
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="image-search-query-image"]').disabled,
    )
    assert.equal(await semanticCalls(), 1)

    // Stop restores local controls, and the cancelled response cannot replace the newer search.
    await page.evaluate(() => {
      const f = window.__workspaceTest
      f.setHandler('imageSearch.selectImage', () => 'C:/fixtures/old.jpg')
      f.delayMethod('vector.searchLayered', 0)
      f.setHandler('vector.searchLayered', (request) => {
        const response = {
          results: [
            { imageId: request.imagePath, path: request.imagePath, finalScore: 1, reasons: [] },
          ],
          degraded: false,
          degradationReasons: [],
          mode: request.mode,
          searchMode: request.mode,
          hashCandidateCount: 1,
          mergedCandidateCount: 1,
          totalMs: 1,
        }
        if (request.imagePath.endsWith('old.jpg')) {
          return new Promise((resolve) => {
            window.__releaseOldSearch = () => {
              window.__oldSearchFinished = true
              resolve(response)
            }
          })
        }
        return response
      })
    })
    await query.click()
    await page.waitForFunction(() => typeof window.__releaseOldSearch === 'function')
    await page.locator('button[title="停止当前搜索"]').click()
    assert.equal(await query.isEnabled(), true)
    await page.evaluate(() => {
      window.__workspaceTest.setHandler('imageSearch.selectImage', () => 'C:/fixtures/new.jpg')
      window.__workspaceTest.delayMethod('vector.searchLayered', 5)
    })
    await query.click()
    await page.getByTestId('image-search-results').filter({ hasText: 'new.jpg' }).waitFor()
    await page.evaluate(async () => {
      window.__releaseOldSearch()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    await page.waitForFunction(() => window.__oldSearchFinished)
    assert.match(await page.getByTestId('image-search-results').innerText(), /new\.jpg/)
    assert.doesNotMatch(await page.getByTestId('image-search-results').innerText(), /old\.jpg/)
    assert.equal(await query.isEnabled(), true)
    assert.deepEqual(errors, [])
    // Native file drags are accepted over navigation, settings, sources and results.
    const dropFile = async (selector, name) =>
      page.evaluate(
        ({ selector, name }) => {
          const transfer = new DataTransfer()
          transfer.items.add(new File(['fixture'], name, { type: 'image/png' }))
          document.querySelector(selector).dispatchEvent(
            new DragEvent('drop', {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer,
            }),
          )
        },
        { selector, name },
      )
    const imageCalls = () =>
      page.evaluate(
        () =>
          window.__workspaceTest.calls.filter((call) => call.method === 'vector.searchLayered')
            .length,
      )
    await page.evaluate(() => {
      window.__workspaceTest.setHandler('vector.searchLayered', (request) => ({
        results: [
          { imageId: request.imagePath, path: request.imagePath, finalScore: 1, reasons: [] },
        ],
        degraded: false,
        degradationReasons: [],
        mode: request.mode,
        searchMode: request.mode,
      }))
    })
    const beforeDrops = await imageCalls()
    await page.getByTestId('workspace-domain-settings').click()
    await page.evaluate(() => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['fixture'], 'sidebar.png', { type: 'image/png' }))
      document.querySelector('.workspace-sidebar').dispatchEvent(
        new DragEvent('dragenter', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      )
    })
    await page.locator('.workspace-image-drop-overlay').waitFor()
    await dropFile('.workspace-sidebar', 'sidebar.png')
    await page.getByTestId('image-search-results').filter({ hasText: 'sidebar.png' }).waitFor()
    assert.equal(await page.locator('.workspace-image-drop-overlay').count(), 0)
    assert.equal(await imageCalls(), beforeDrops + 1)
    await dropFile('[data-testid="image-search-results"]', 'results.png')
    await page.getByTestId('image-search-results').filter({ hasText: 'results.png' }).waitFor()
    assert.equal(await imageCalls(), beforeDrops + 2)
    await page.getByTestId('workspace-domain-sources').click()
    await dropFile('[data-testid="image-search-library-section"]', 'sources.png')
    await page.getByTestId('image-search-results').filter({ hasText: 'sources.png' }).waitFor()
    assert.equal(await imageCalls(), beforeDrops + 3)
    await page.getByTestId('workspace-domain-settings').click()
    await dropFile('[data-testid="app-root"]', 'background.png')
    await page.getByTestId('image-search-results').filter({ hasText: 'background.png' }).waitFor()
    assert.equal(await imageCalls(), beforeDrops + 4)
    await dropFile('[data-testid="app-root"]', 'unsupported.pdf')
    await page.waitForTimeout(100)
    assert.equal(await imageCalls(), beforeDrops + 4)
    assert.deepEqual(errors, [])
    const lazyPage = await browser.newPage()
    await lazyPage.addInitScript(() => {
      let fixture
      Object.defineProperty(window, '__workspaceTest', {
        configurable: true,
        get: () => fixture,
        set: (value) => {
          fixture = value
          value.setHandler('loadSettings', () => ({
            showImageSearch: false,
            showSettings: true,
            globalVisible: true,
            panelVisibilityDefaultsVersion: 999,
            panelSizeDefaultsVersion: 999,
            language: 'zh-CN',
            imageSearchScanPaths: ['C:/fixtures'],
          }))
          value.setHandler('vector.searchLayered', (request) => ({
            results: [
              { imageId: request.imagePath, path: request.imagePath, finalScore: 1, reasons: [] },
            ],
            degraded: false,
            degradationReasons: [],
            mode: request.mode,
            searchMode: request.mode,
          }))
        },
      })
    })
    await lazyPage.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/workspace-ui.html`,
    )
    await lazyPage.locator('[data-testid="app-root"][data-ready="true"]').waitFor()
    assert.equal(await lazyPage.locator('.image-search-shell').count(), 0)
    await lazyPage.evaluate(() => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['fixture'], 'lazy.png', { type: 'image/png' }))
      document.body.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      )
    })
    await lazyPage.getByTestId('image-search-results').filter({ hasText: 'lazy.png' }).waitFor()
    assert.equal(
      await lazyPage.evaluate(
        () =>
          window.__workspaceTest.calls.filter((call) => call.method === 'vector.searchLayered')
            .length,
      ),
      1,
    )
    await lazyPage.close()
    // Browser image drags often provide HTML/URLs or pixels with no native path.
    await page.evaluate(() => {
      window.__workspaceTest.setHandler('getPathForFile', () => '')
      window.__workspaceTest.setHandler('imageSearch.importBrowserImage', () => ({
        ok: true,
        path: 'C:/fixtures/browser-reference.png',
      }))
    })
    const beforeBrowserDrops = await imageCalls()
    await page.evaluate(() => {
      const transfer = new DataTransfer()
      transfer.setData(
        'text/html',
        '<a href="https://site.example/page"><img src="https://images.example/picture.webp" onerror="window.__dragScriptRan=true"></a><script>window.__dragScriptRan=true</script>',
      )
      transfer.setData('text/uri-list', 'https://site.example/page')
      document.body.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      )
    })
    await page
      .getByTestId('image-search-results')
      .filter({ hasText: 'browser-reference.png' })
      .waitFor()
    assert.equal(await imageCalls(), beforeBrowserDrops + 1)
    const urlImport = await page.evaluate(
      () =>
        window.__workspaceTest.calls.findLast(
          (call) => call.method === 'imageSearch.importBrowserImage',
        ).args[0],
    )
    assert.deepEqual(urlImport, { kind: 'url', url: 'https://images.example/picture.webp' })
    assert.equal(await page.evaluate(() => Boolean(window.__dragScriptRan)), false)
    await page.evaluate(() => {
      const transfer = new DataTransfer()
      transfer.items.add(
        new File([new Uint8Array([1, 2, 3])], 'browser.png', { type: 'image/png' }),
      )
      document.body.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      )
    })
    await page.waitForFunction(
      (count) =>
        window.__workspaceTest.calls.filter((call) => call.method === 'vector.searchLayered')
          .length === count,
      beforeBrowserDrops + 2,
    )
    assert.equal(
      await page.evaluate(
        () =>
          window.__workspaceTest.calls.findLast(
            (call) => call.method === 'imageSearch.importBrowserImage',
          ).args[0].bytes.length,
      ),
      3,
    )
    await query.waitFor({ state: 'visible' })
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="image-search-query-image"]').disabled,
    )
    await page.evaluate(() => {
      const transfer = new DataTransfer()
      transfer.setData('text/uri-list', '# browser drag\nhttps://images.example/image?id=42')
      transfer.items.add(new File([], 'remote.png', { type: 'image/png' }))
      window.__workspaceTest.setHandler('imageSearch.importBrowserImage', () => ({ ok: false }))
      document.body.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      )
    })
    await page.locator('.workspace-image-import-status[role="alert"]').waitFor()
    assert.deepEqual(
      await page.evaluate(
        () =>
          window.__workspaceTest.calls.findLast(
            (call) => call.method === 'imageSearch.importBrowserImage',
          ).args[0],
      ),
      { kind: 'url', url: 'https://images.example/image?id=42' },
    )
    assert.equal(await imageCalls(), beforeBrowserDrops + 2)
    assert.deepEqual(errors, [])
    const report = {
      passed: true,
      syntheticBridge: true,
      missingModelEnterBlocked: true,
      busyEnterBlocked: true,
      concurrentProbeDeduplicated: true,
      stopRestoresControls: true,
      staleResponseDiscarded: true,
      wholeWindowFileDrop: true,
      dropNavigatesToImageSearch: true,
      dropDoesNotDispatchTwice: true,
      unsupportedDropRejected: true,
      dropBeforeSearchPanelMount: true,
      browserImageHtmlUrl: true,
      browserImagePixels: true,
      browserImageFailureFeedback: true,
      rendererErrors: [],
    }
    const evidence = path.join(root, 'artifacts/search-request-lifecycle')
    fs.mkdirSync(evidence, { recursive: true })
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  } finally {
    await browser?.close()
    await server.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
