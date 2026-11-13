// Renderer scheduling test with synthetic IPC. This is not Windows native indexing acceptance.
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
async function main() {
  const { createServer } = await import('vite'),
    { default: react } = await import('@vitejs/plugin-react')
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  })
  let browser
  try {
    await server.listen()
    browser = await chromium.launch({
      executablePath: process.env.SIFTORY_TEST_CHROMIUM_PATH || undefined,
      headless: true,
      chromiumSandbox: process.platform === 'win32',
      args: process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
    })
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } }),
      errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/workspace-ui.html`,
    )
    await page.locator('[data-testid="app-root"][data-ready="true"]').waitFor()
    await page.getByTestId('image-search-query-section').waitFor()
    await page.evaluate(() => {
      window.indexingSmoke = { sent: 0, finished: false }
      const f = window.__workspaceTest
      const timer = setInterval(() => {
        for (let i = 0; i < 100; i++) {
          const n = ++window.indexingSmoke.sent
          f.emit('imageSearch.onStatusChanged', {
            state: 'indexing',
            indexedCount: n,
            scannedCount: n,
            totalFiles: 10000,
            percentage: n / 100,
            currentPath: 'synthetic.psd',
            message: 'Synthetic indexing',
          })
        }
        if (window.indexingSmoke.sent >= 10000) {
          clearInterval(timer)
          f.emit('imageSearch.onStatusChanged', {
            state: 'idle',
            indexedCount: 10000,
            scannedCount: 10000,
            totalFiles: 10000,
            percentage: 100,
          })
          window.indexingSmoke.finished = true
        }
      }, 10)
    })
    await page.waitForFunction(() => window.indexingSmoke.sent >= 100)
    const started = Date.now()
    await page.getByTestId('workspace-domain-settings').click({ timeout: 5000 })
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="workspace-domain-settings"]')
          ?.getAttribute('aria-current') === 'page',
    )
    const navigationMs = Date.now() - started
    await page.waitForFunction(() => window.indexingSmoke.finished)
    await page.getByTestId('workspace-domain-sources').click()
    await page.getByTestId('image-search-library-section').waitFor()
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        passed: true,
        syntheticEvents: 10001,
        navigationMs,
        scope: 'Renderer synthetic IPC burst only; excludes native indexing and OS window dragging',
      }),
    )
  } finally {
    await browser?.close()
    await server.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
