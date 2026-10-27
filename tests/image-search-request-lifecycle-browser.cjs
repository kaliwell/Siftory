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
      window.__workspaceTest.delayMethod('vector.searchLayered', 550)
      window.__workspaceTest.setHandler('vector.searchLayered', (request) => {
        window.__imageAuditFinished = true
        return {
          results: [],
          degraded: false,
          degradationReasons: [],
          mode: request.mode,
          searchMode: request.mode,
          hashCandidateCount: 0,
          mergedCandidateCount: 0,
          totalMs: 550,
        }
      })
    })
    await query.click()
    await page.waitForFunction(() =>
      window.__workspaceTest.calls.some((c) => c.method === 'vector.searchLayered'),
    )
    assert.equal(await text.isDisabled(), true)
    // A dispatched keyboard event also exercises the handler's own disabled-state guard.
    await text.dispatchEvent('keydown', { key: 'Enter', bubbles: true })
    await page.waitForFunction(() => window.__imageAuditFinished)
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="image-search-query-image"]').disabled,
    )
    assert.equal(await semanticCalls(), 0)

    // A model readiness probe must not allow a second Enter to start a second request.
    await page.evaluate(() => {
      const f = window.__workspaceTest
      f.setHandler('vector.getModelStatus', (name) => ({
        name,
        state: 'downloaded',
        installedPath: 'C:/fixtures/verified-model',
      }))
      f.delayMethod('vector.getModelStatus', 100)
      f.delayMethod('vector.searchSemantic', 200)
      f.setHandler('vector.searchSemantic', () => ({
        results: [],
        degraded: false,
        degradationReasons: [],
        totalMs: 200,
        totalCandidates: 0,
      }))
      window.dispatchEvent(new Event('focus'))
    })
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="image-search-semantic-query"]').disabled,
    )
    await text.press('Enter')
    await text.dispatchEvent('keydown', { key: 'Enter', bubbles: true })
    await page.waitForFunction(() =>
      window.__workspaceTest.calls.some((c) => c.method === 'vector.searchSemantic'),
    )
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="image-search-query-image"]').disabled,
    )
    assert.equal(await semanticCalls(), 1)

    // Stop restores local controls, and the cancelled response cannot replace the newer search.
    await page.evaluate(() => {
      const f = window.__workspaceTest
      f.setHandler('imageSearch.selectImage', () => 'C:/fixtures/old.jpg')
      f.delayMethod('vector.searchLayered', 1200)
      f.setHandler('vector.searchLayered', (request) => {
        if (request.imagePath.endsWith('old.jpg')) window.__oldSearchFinished = true
        return {
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
      })
    })
    await query.click()
    await page.locator('button[title="停止当前搜索"]').click()
    assert.equal(await query.isEnabled(), true)
    await page.evaluate(() => {
      window.__workspaceTest.setHandler('imageSearch.selectImage', () => 'C:/fixtures/new.jpg')
      window.__workspaceTest.delayMethod('vector.searchLayered', 5)
    })
    await query.click()
    await page.getByTestId('image-search-results').filter({ hasText: 'new.jpg' }).waitFor()
    await page.waitForFunction(() => window.__oldSearchFinished)
    assert.match(await page.getByTestId('image-search-results').innerText(), /new\.jpg/)
    assert.doesNotMatch(await page.getByTestId('image-search-results').innerText(), /old\.jpg/)
    assert.equal(await query.isEnabled(), true)
    assert.deepEqual(errors, [])
    const report = {
      passed: true,
      syntheticBridge: true,
      missingModelEnterBlocked: true,
      busyEnterBlocked: true,
      concurrentProbeDeduplicated: true,
      stopRestoresControls: true,
      staleResponseDiscarded: true,
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
