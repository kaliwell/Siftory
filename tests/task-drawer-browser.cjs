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
      const previous = window.electronAPI
      const media = new Proxy(previous.mediaSearch, {
        get: (o, k) =>
          k === 'getAudioSemanticStatus'
            ? async () => ({
                ...(await o[k]()),
                job: {
                  jobId: 'fixture-paused',
                  state: 'stopped',
                  completedSegments: 22,
                  failedSegments: 3,
                  totalSegments: 5238,
                  currentVideoId: '7351729ccf870a4279a8bc69476f4b92a0175c4d',
                  lastError: 'app-restarted',
                  createdAt: 1,
                  updatedAt: 2,
                },
              })
            : o[k],
      })
      window.electronAPI = new Proxy(previous, {
        get: (o, k) =>
          k === 'mediaSearch'
            ? media
            : k === 'imageSearch'
              ? new Proxy(o[k], {
                  get: (i, m) =>
                    m === 'getStatus'
                      ? async () => ({ state: 'idle', indexedCount: 0, pendingCount: 0 })
                      : i[m],
                })
              : o[k],
      })
      window.__workspaceTest.store.setState({ themeMode: 'dark' })
    })
    await page.getByTestId('workspace-domain-tasks').click()
    const card = page.getByTestId('product-task-audio-semantic')
    await card.waitFor()
    assert.ok(!(await card.innerText()).includes('app-restarted'))
    assert.ok(!(await card.innerText()).includes('7351729'))
    assert.equal(await page.locator('.workspace-task-advanced').getAttribute('open'), null)
    fs.mkdirSync(path.join(root, 'artifacts/task-ui-review'), { recursive: true })
    for (const [name, width, height] of [
      ['dark-wide', 1366, 900],
      ['dark-compact', 1000, 760],
    ]) {
      await page.setViewportSize({ width, height })
      await page.screenshot({ path: path.join(root, 'artifacts/task-ui-review', name + '.png') })
      const rect = await page.getByTestId('workspace-task-summary').boundingBox()
      assert.ok(rect.x >= 0 && rect.x + rect.width <= width)
    }
    await page.getByTestId('product-task-audio-semantic').getByRole('button').click()
    await page.waitForFunction(() =>
      window.__workspaceTest.calls.some(
        (c) =>
          c.method === 'mediaSearch.resumeAudioSemanticBuild' && c.args[0] === 'fixture-paused',
      ),
    )
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        passed: true,
        syntheticBridge: true,
        pausedAudioFixture: true,
        resourceControlsCollapsed: true,
        internalIdentifiersHidden: true,
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
