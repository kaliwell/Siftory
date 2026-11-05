// Real React maintenance UI with controlled replies; never opens user data.
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
async function main() {
  const { createServer } = await import('vite')
  const { default: react } = await import('@vitejs/plugin-react')
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
      headless: true,
      ...(process.env.SIFTORY_TEST_CHROMIUM_PATH
        ? { executablePath: process.env.SIFTORY_TEST_CHROMIUM_PATH }
        : {}),
    })
    const page = await browser.newPage({ viewport: { width: 1320, height: 850 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/workspace-ui.html`,
    )
    await page.getByTestId('image-search-query-section').waitFor()
    await page.evaluate(() => {
      const f = window.__workspaceTest
      window.maintenanceAudit = { fail: false, removePending: null, removed: [] }
      f.setHandler('assetLibrary.listCollections', () => [
        { id: 2, name: 'B', sortOrder: 0 },
        { id: 1, name: 'A', sortOrder: 1 },
      ])
      f.setHandler('assetLibrary.listCollectionItems', (id) => {
        const items = [
          {
            id: id * 10,
            displayName: id === 1 ? 'A-ITEM' : 'B-ITEM',
            displayPath: 'fixture',
            fileEntryId: 'entry',
            source: { name: 'fixture' },
          },
        ]
        if (id !== 1) return items
        return new Promise((resolve, reject) => {
          window.maintenanceAudit.releaseA = () =>
            window.maintenanceAudit.fail ? reject(new Error('late A error')) : resolve(items)
        })
      })
      f.setHandler(
        'assetLibrary.removeCollectionItem',
        (id) =>
          new Promise((resolve) => {
            window.maintenanceAudit.removed.push(id)
            window.maintenanceAudit.removePending = (result = { ok: true }) => resolve(result)
          }),
      )
      f.store.setState({ showImageSearch: false, showAppStorage: true })
    })
    const section = page.getByTestId('maintenance-sources-section')
    const toggle = section.locator('button.search-control-section__header')
    await toggle.click()
    const tray = page.getByTestId('asset-collection-tray')
    await tray.locator('summary').click()
    const select = page.getByTestId('asset-collection-select')
    const itemB = tray.getByText('B-ITEM (fixture)', { exact: true })
    await itemB.waitFor()
    for (const fail of [false, true]) {
      await page.evaluate((value) => {
        window.maintenanceAudit.fail = value
        window.maintenanceAudit.releaseA = null
      }, fail)
      await select.selectOption('1')
      await page.waitForFunction(() => typeof window.maintenanceAudit.releaseA === 'function')
      assert.equal(await itemB.count(), 0, 'previous collection rows must disappear while loading')
      await select.selectOption('2')
      await itemB.waitFor()
      await page.evaluate(async () => {
        window.maintenanceAudit.releaseA()
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })
      assert.equal(await select.inputValue(), '2')
      assert.match(await tray.innerText(), /B-ITEM/)
      assert.doesNotMatch(await tray.innerText(), /A-ITEM/)
    }
    const remove = itemB.locator('..').locator('button').last()
    await remove.click()
    await page.evaluate(() =>
      window.maintenanceAudit.removePending({ ok: false, error: 'Expected removal failure' }),
    )
    await page.getByText('Expected removal failure', { exact: true }).waitFor()
    assert.equal(await itemB.count(), 1, 'failed backend removals must retain the row')
    await remove.click()
    await remove.click()
    assert.deepEqual(
      await page.evaluate(() => window.maintenanceAudit.removed),
      [20, 20],
      'retry must target B and double click must not duplicate it',
    )
    // Completing B's mutation while viewing pending A must not populate A with B.
    await select.selectOption('1')
    await page.evaluate(() => window.maintenanceAudit.removePending())
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    assert.equal(await itemB.count(), 0)
    await toggle.click()
    const count = () =>
      page.evaluate(
        () =>
          window.__workspaceTest.calls.filter((c) => c.method === 'discoveryCatalog.listSources')
            .length,
      )
    const paused = await count()
    await page.waitForTimeout(2300)
    assert.equal(await count(), paused, 'collapsed sections must stop polling')
    await page.evaluate(() => {
      window.maintenanceAudit.polls = 0
      window.__workspaceTest.setHandler(
        'discoveryCatalog.listSources',
        () =>
          new Promise((resolve) => {
            window.maintenanceAudit.polls++
            window.maintenanceAudit.releasePoll = () => resolve([])
          }),
      )
    })
    await toggle.click()
    await page.waitForFunction(() => typeof window.maintenanceAudit.releasePoll === 'function')
    await page.waitForTimeout(2300)
    assert.equal(
      await page.evaluate(() => window.maintenanceAudit.polls),
      1,
      'slow polls must not overlap',
    )
    await page.evaluate(() => window.__workspaceTest.store.setState({ globalVisible: false }))
    await page.evaluate(() => window.maintenanceAudit.releasePoll())
    await page.waitForTimeout(2300)
    assert.equal(
      await page.evaluate(() => window.maintenanceAudit.polls),
      1,
      'hidden windows must stop polling',
    )
    await page.evaluate(() =>
      window.__workspaceTest.store.setState({
        globalVisible: true,
        showAppStorage: true,
        showImageSearch: false,
      }),
    )
    await section.waitFor()
    if ((await section.getAttribute('data-collapsed')) === 'true') await toggle.click()
    await page.waitForFunction(() => window.maintenanceAudit.polls === 2)
    await page.evaluate(() => window.maintenanceAudit.releasePoll())
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        passed: true,
        staleSuccessRejected: true,
        staleFailureRejected: true,
        collectionBoundRemoval: true,
        duplicateRemovalBlocked: true,
        collapsePausesPolling: true,
        serialPolling: true,
        visibilityPausesPolling: true,
        pageErrors: errors,
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
