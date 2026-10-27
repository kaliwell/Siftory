const assert = require('node:assert/strict'),
  fs = require('fs'),
  path = require('path')
const { chromium } = require('playwright')
const root = path.resolve(__dirname, '..')
async function main() {
  const { createServer } = await import('vite'),
    { default: react } = await import('@vitejs/plugin-react')
  const server = await createServer({
    configFile: false,
    root,
    plugins: [react()],
    optimizeDeps: { entries: ['tests/fixtures/workspace-ui.html'] },
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({
      ...(process.env.SIFTORY_TEST_CHROMIUM_PATH
        ? { executablePath: process.env.SIFTORY_TEST_CHROMIUM_PATH }
        : {}),
      headless: true,
      chromiumSandbox: true,
    })
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } }),
      errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('dialog', (d) => d.accept())
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/workspace-ui.html`,
    )
    await page.locator('[data-ready="true"]').waitFor()
    await page.evaluate(() => {
      const original = window.electronAPI,
        states = new Map(),
        listeners = new Set(),
        downloads = []
      window.__modelUi = {
        downloads,
        emit: (s) => {
          states.set(s.name, s)
          for (const cb of listeners) cb(s)
        },
      }
      const vector = new Proxy(original.vector, {
        get: (o, k) => {
          if (k === 'getModelStatus')
            return async (name) => states.get(name) || { name, state: 'not-installed' }
          if (k === 'onModelStatusChanged')
            return (cb) => {
              listeners.add(cb)
              return () => listeners.delete(cb)
            }
          if (k === 'downloadModel')
            return async (name) => {
              downloads.push(name)
              window.__modelUi.emit({ name, state: 'downloading', progress: 40 })
              await new Promise((r) => setTimeout(r, 200))
              window.__modelUi.emit({
                name,
                state: 'downloaded',
                installedPath: 'verified-fixture',
              })
              return { ok: true }
            }
          return o[k]
        },
      })
      const image = new Proxy(original.imageSearch, {
        get: (o, k) =>
          k === 'getStatus'
            ? async () => ({ state: 'scanning', indexedCount: 1610, pendingCount: 0 })
            : o[k],
      })
      window.electronAPI = new Proxy(original, {
        get: (o, k) => (k === 'vector' ? vector : k === 'imageSearch' ? image : o[k]),
      })
    })
    await page.getByTestId('workspace-tab-image-search').click()
    await page.getByTestId('image-search-install-models').click()
    const task = page.getByTestId('product-task-image-index')
    await task.waitFor()
    assert.equal(await task.locator('progress').getAttribute('value'), null)
    assert.ok(!(await task.innerText()).includes('100%'))
    await page.getByTestId('install-search-models').waitFor()
    await page.getByTestId('install-search-models').click()
    await page
      .getByTestId('product-model-clip_vit_base_patch32')
      .getByRole('button', { name: /Verify|校验|验证/ })
      .waitFor()
    await page.getByTestId('image-search-install-models').waitFor({ state: 'hidden' })
    assert.deepEqual(await page.evaluate(() => window.__modelUi.downloads), [
      'dinov2_vitb14',
      'clip_vit_base_patch32',
    ])
    await page.evaluate(() =>
      window.__modelUi.emit({
        name: 'clip_vit_base_patch32',
        state: 'error',
        error: 'fixture-network-failure',
      }),
    )
    await page.getByText('fixture-network-failure', { exact: true }).waitFor()
    await page.evaluate(() =>
      window.__modelUi.emit({
        name: 'clip_vit_base_patch32',
        state: 'downloaded',
        installedPath: 'verified-fixture',
      }),
    )
    await page
      .getByTestId('product-model-clip_vit_base_patch32')
      .getByRole('button', { name: /Verify|校验|验证/ })
      .waitFor()
    assert.equal(await page.locator('.workspace-alpha-notice').count(), 0)
    await page.locator('.workspace-alpha-disclosure > summary').click()
    await page.locator('.workspace-alpha-disclosure__content').waitFor()
    fs.mkdirSync(path.join(root, 'artifacts/alpha-model-ui'), { recursive: true })
    await page.screenshot({
      path: path.join(root, 'artifacts/alpha-model-ui/models-installed.png'),
    })
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        passed: true,
        syntheticBridge: true,
        indeterminateScan: true,
        automaticSequentialInstall: true,
        modelEventsRefreshImmediately: true,
        alphaNoticeVisible: true,
        pageErrors: 0,
      }),
    )
  } finally {
    await browser?.close()
    await server.close()
  }
}
main().catch((e) => {
  console.error(e.stack)
  process.exitCode = 1
})
