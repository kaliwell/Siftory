'use strict'
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
async function main() {
  const { createServer } = await import('vite')
  const { default: react } = await import('@vitejs/plugin-react')
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 0,
      watch: { ignored: ['**/artifacts/**', '**/release/**', '**/native/**'] },
    },
    logLevel: 'error',
  })
  let browser
  try {
    await server.listen()
    browser = await chromium.launch({
      headless: true,
      ...(process.env.SIFTORY_TEST_CHROMIUM_PATH
        ? { executablePath: process.env.SIFTORY_TEST_CHROMIUM_PATH }
        : {}),
      chromiumSandbox: process.platform === 'win32',
    })
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/thumbnail-cache-lifecycle.html`,
    )
    const state = () =>
      page.evaluate(() => ({
        calls: window.__thumbnailCacheLifecycle.calls,
        src: document.querySelector('#preview img')?.getAttribute('src'),
      }))
    await page.waitForFunction(() => document.querySelector('#preview img')?.complete)
    const first = await state()
    assert.equal(first.calls.length, 1)
    await page.locator('#defer').click()
    await page.locator('#mount').click()
    await page.locator('#mount').click()
    await page.waitForFunction(() => document.querySelector('#preview img')?.complete)
    assert.equal((await state()).src, first.src, 'cached output bytes stay identical')
    assert.equal((await state()).calls.length, 1, 'deferred remount must use renderer cache')
    await page.locator('#path').click()
    await page.waitForFunction(() => !document.querySelector('#preview img'))
    assert.equal((await state()).calls.length, 1, 'uncached path must remain deferred')
    await page.locator('#defer').click()
    await page.waitForFunction(
      () =>
        window.__thumbnailCacheLifecycle.calls.length === 2 &&
        document.querySelector('#preview img')?.complete,
    )
    assert.notEqual((await state()).src, first.src, 'reused card must not show old file')
    await page.locator('#defer').click()
    await page.locator('#path').click()
    await page.waitForFunction(
      (src) => document.querySelector('#preview img')?.getAttribute('src') === src,
      first.src,
    )
    assert.equal((await state()).calls.length, 2)
    await page.locator('#size').click()
    await page.waitForFunction(() => !document.querySelector('#preview img'))
    assert.equal((await state()).calls.length, 2, 'uncached size must remain deferred')
    await page.locator('#defer').click()
    await page.waitForFunction(
      () =>
        window.__thumbnailCacheLifecycle.calls.length === 3 &&
        document.querySelector('#preview img')?.complete,
    )
    assert.equal((await state()).calls.at(-1).maxDim, 128)
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        passed: true,
        cachedPreviewDuringScroll: true,
        noExtraIpc: true,
        noStalePathPreview: true,
        uncachedWorkStillDeferred: true,
        dimensionIsolation: true,
        identicalCachedOutput: true,
        errors,
      }),
    )
  } finally {
    await browser?.close()
    await server.close()
  }
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
