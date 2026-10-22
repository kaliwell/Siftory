// Actual compiled Electron app, real IPC and Native scanner; only generated test materials.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { _electron: electron } = require('playwright')
const sharp = require('sharp')
const repo = path.resolve(__dirname, '..')
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

async function run() {
  if (process.platform !== 'win32') throw new Error('This smoke test requires Windows')
  const parent = fs.realpathSync.native(os.tmpdir())
  const root = fs.mkdtempSync(path.join(parent, 'siftory-focused-native-'))
  const profile = path.join(root, 'floating-clock-electron')
  const publicParent =
    process.env.SIFTORY_PUBLIC_DEMO_CAPTURE === '1'
      ? fs.realpathSync.native('C:/Users/Public/Pictures')
      : null
  const materials = publicParent
    ? fs.mkdtempSync(path.join(publicParent, 'Siftory-Alpha2-Demo-'))
    : path.join(root, 'materials')
  fs.mkdirSync(profile)
  if (!publicParent) fs.mkdirSync(materials)
  const library = path.join(materials, 'library')
  fs.mkdirSync(library)
  fs.writeFileSync(
    path.join(profile, 'floating_clock_settings.json'),
    JSON.stringify({
      language: 'zh-CN',
      showClock: true,
      showRemoteTerminal: true,
      showUnifiedSearch: true,
      alwaysOnTop: false,
      themeId: 'matrix-light',
      themeMode: 'light',
      displayScope: { mode: 'all' },
    }),
  )
  const before = []
  for (let index = 0; index < 3; index++) {
    const file = path.join(library, `sample-${index}.jpg`)
    const svg = `<svg width="160" height="120"><rect width="160" height="120" fill="${['#abcdee', '#faf0ca', '#c9edda'][index]}"/><circle cx="${45 + 30 * index}" cy="60" r="30" fill="#284c80"/></svg>`
    await sharp(Buffer.from(svg)).jpeg().toFile(file)
    before.push({ file, hash: hash(file) })
  }
  // Slightly shifted reference is outside the indexed source; it must still find sample-0.
  const reference = path.join(materials, 'reference.jpg')
  await sharp(
    Buffer.from(
      '<svg width="160" height="120"><rect width="160" height="120" fill="#abcdee"/><circle cx="53" cy="60" r="30" fill="#284c80"/></svg>',
    ),
  )
    .jpeg()
    .toFile(reference)
  const referenceHash = hash(reference)
  const bootstrap = path.join(root, 'bootstrap.cjs')
  fs.writeFileSync(
    bootstrap,
    `const { app } = require('electron');\napp.setPath('appData', ${JSON.stringify(root)});\napp.setPath('userData', ${JSON.stringify(profile)});\napp.setPath('sessionData', ${JSON.stringify(path.join(root, 'session'))});\napp.setAppPath(${JSON.stringify(repo)});\nrequire(${JSON.stringify(path.join(repo, 'dist-electron/main.js'))});\n`,
  )
  fs.mkdirSync(path.join(root, 'session'))
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    FLOATING_CLOCK_MEDIA_SEARCH_DIR: path.join(root, 'media-search'),
  }
  for (const key of Object.keys(env))
    if (
      /^FLOATING_CLOCK_(UI_SMOKE|AI_CONTROL_SMOKE|SMOKE_SESSION)|^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|VITE_DEV_SERVER_URL)$/i.test(
        key,
      )
    )
      delete env[key]
  let application
  const errors = []
  const evidence = path.join(repo, 'artifacts/focused-workspace-native')
  fs.mkdirSync(evidence, { recursive: true })
  try {
    application = await electron.launch({ args: [bootstrap], cwd: repo, env, timeout: 45000 })
    const page = await application.firstWindow({ timeout: 45000 })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.getByTestId('workspace-domain-search').waitFor({ timeout: 45000 })
    const identity = await application.evaluate(({ app, BrowserWindow }) => ({
      userData: app.getPath('userData'),
      sandbox: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox,
      resizable: BrowserWindow.getAllWindows()[0].isResizable(),
      movable: BrowserWindow.getAllWindows()[0].isMovable(),
      maximizable: BrowserWindow.getAllWindows()[0].isMaximizable(),
      alwaysOnTop: BrowserWindow.getAllWindows()[0].isAlwaysOnTop(),
      background: BrowserWindow.getAllWindows()[0].getBackgroundColor(),
    }))
    assert.equal(path.resolve(identity.userData), path.resolve(profile))
    assert.equal(identity.sandbox, true)
    assert.equal(identity.resizable, true)
    assert.equal(identity.movable, true)
    assert.equal(identity.maximizable, true)
    assert.equal(identity.alwaysOnTop, false)
    assert.equal(identity.background.toLowerCase(), '#f5f7fb')
    await page.waitForFunction(
      async () => (await window.electronAPI.getDisplayTopology()).scope.mode === 'primary',
    )
    const windowGeometry = await application.evaluate(({ BrowserWindow, screen }) => ({
      bounds: BrowserWindow.getAllWindows()[0].getBounds(),
      primaryWorkArea: screen.getPrimaryDisplay().workArea,
      displayCount: screen.getAllDisplays().length,
    }))
    const { bounds, primaryWorkArea: area } = windowGeometry
    assert.ok(
      bounds.x >= area.x &&
        bounds.y >= area.y &&
        bounds.x + bounds.width <= area.x + area.width &&
        bounds.y + bounds.height <= area.y + area.height,
    )
    assert.ok(bounds.width < area.width && bounds.height < area.height)
    for (const size of [
      { width: 1000, height: 740 },
      { width: 1320, height: 860 },
    ]) {
      await application.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setSize(size.width, size.height),
        size,
      )
      await page.waitForTimeout(150)
      const fits = await page.evaluate(() => {
        const rect = document.querySelector('[data-testid="app-root"]').getBoundingClientRect()
        return (
          rect.x === 0 &&
          rect.y === 0 &&
          Math.abs(rect.width - innerWidth) < 2 &&
          Math.abs(rect.height - innerHeight) < 2 &&
          document.documentElement.scrollWidth <= innerWidth
        )
      })
      assert.equal(fits, true)
    }
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
    await page.waitForTimeout(150)
    assert.equal(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isMaximized(),
      ),
      true,
    )
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize())
    await page.waitForTimeout(150)
    await page.evaluate(() => window.electronAPI.hideWindow())
    assert.equal(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
      false,
    )
    assert.equal(await page.evaluate(() => window.electronAPI.showWindow(0)), false)
    await application.evaluate(({ app }) => app.emit('second-instance', {}, [], process.cwd()))
    assert.equal(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
      true,
    )
    await page.getByTestId('workspace-domain-search').waitFor()
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.panel[data-panel]')].filter(
          (panel) => panel.getClientRects().length,
        ).length === 1,
    )
    assert.equal(
      await page.locator('[data-panel="clock"],[data-panel="remote-terminal"]').count(),
      0,
    )
    for (const id of ['sources', 'library', 'settings', 'search']) {
      await page.getByTestId('workspace-domain-' + id).click()
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('.panel[data-panel]')].filter(
            (panel) => panel.getClientRects().length,
          ).length === 1,
        null,
        { timeout: 15000 },
      )
      assert.equal(await page.locator('.panel[data-panel]:visible').count(), 1)
    }
    const initial = await page.evaluate(() => window.electronAPI.imageSearch.getStatus())
    assert.equal(initial.nativeConnected, true)
    const added = await page.evaluate(
      (rootLocator) =>
        window.electronAPI.discoveryCatalog.addSource({
          type: 'local',
          displayName: 'Demo materials',
          rootLocator,
        }),
      library,
    )
    assert.equal(added.ok, true, added.error)
    const discovery = await page.evaluate(
      (id) => window.electronAPI.discoveryCatalog.startScan(id),
      added.source.id,
    )
    assert.equal(discovery.ok, true, discovery.error)
    await page.waitForFunction(
      async (id) => {
        const status = await window.electronAPI.discoveryCatalog.getScanStatus(id)
        return (
          !status.running &&
          status.session?.state === 'completed' &&
          status.session.committedCount >= 3
        )
      },
      added.source.id,
      { timeout: 30000 },
    )
    await page.evaluate(
      (paths) =>
        window.electronAPI.imageSearch.startScan({ paths, mode: 'fast', scanMode: 'full' }),
      [library],
    )
    await page.waitForFunction(
      async () => {
        const status = await window.electronAPI.imageSearch.getStatus()
        return (
          status.indexedCount >= 3 && status.state !== 'scanning' && status.state !== 'indexing'
        )
      },
      null,
      { timeout: 45000 },
    )
    const fingerprints = await page.evaluate(
      async (files) =>
        Promise.all(files.map((file) => window.electronAPI.imageSearch.hashImage(file))),
      [before[0].file, reference],
    )
    assert.ok(fingerprints.every((item) => item.ok && item.diffHash64))
    const hashDifference =
      BigInt('0x' + fingerprints[0].diffHash64) ^ BigInt('0x' + fingerprints[1].diffHash64)
    const referenceHammingDistance = hashDifference.toString(2).replaceAll('0', '').length
    assert.ok(
      referenceHammingDistance > 0 && referenceHammingDistance <= 9,
      `Reference distance: ${referenceHammingDistance}`,
    )
    const result = await page.evaluate(
      (imagePath) =>
        window.electronAPI.imageSearch.search({
          imagePath,
          topK: 10,
          threshold: 0,
          searchMode: 'fast',
        }),
      before[0].file,
    )
    fs.writeFileSync(path.join(evidence, 'query-debug.json'), JSON.stringify(result, null, 2))
    assert.ok(
      result.results.some((item) => path.resolve(item.path) === path.resolve(before[0].file)),
    )
    {
      await page.screenshot({ path: path.join(evidence, 'workspace-before.png') })
      // Only the file-picker result is supplied by the fixture; search and rendering use real IPC.
      await application.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
      }, reference)
      await page.getByTestId('unified-search-reference').click()
      try {
        await page.getByTestId('unified-search-result').first().waitFor({ timeout: 15000 })
        await page
          .getByTestId('unified-search-result')
          .filter({ hasText: 'sample-0.jpg' })
          .waitFor({ timeout: 15000 })
      } catch (error) {
        fs.writeFileSync(
          path.join(evidence, 'ui-debug.txt'),
          await page.locator('body').innerText(),
        )
        await page.screenshot({ path: path.join(evidence, 'ui-debug.png') })
        throw error
      }
      await page.waitForTimeout(400)
    }
    await page.screenshot({ path: path.join(evidence, 'workspace.png') })
    fs.writeFileSync(
      path.join(evidence, 'geometry.json'),
      JSON.stringify(
        await page.evaluate(() => ({
          origin: { ...document.documentElement.dataset },
          root: document.querySelector('[data-testid="app-root"]').getBoundingClientRect().toJSON(),
          nav: document.querySelector('.workspace-sidebar').getBoundingClientRect().toJSON(),
          viewport: { width: innerWidth, height: innerHeight },
          scroll: { x: scrollX, y: scrollY },
        })),
        null,
        2,
      ),
    )
    assert.deepEqual(errors, [])
    for (const item of before) assert.equal(hash(item.file), item.hash)
    assert.equal(hash(reference), referenceHash)
    const report = {
      passed: true,
      realElectron: true,
      sandbox: identity.sandbox,
      legacyAllMigratedToPrimary: true,
      primaryDisplayBoundsVerified: true,
      standardWindowVerified: true,
      resizeMaximizeAndRevealVerified: true,
      displayCount: windowGeometry.displayCount,
      isolatedProfile: true,
      generatedMaterialCount: before.length,
      originalFilesUnchanged: true,
      nativeConnected: initial.nativeConnected,
      nativeVersion: initial.nativeVersion,
      matchingResults: result.results.length,
      shiftedReferenceFoundOriginal: true,
      referenceHammingDistance,
      pageErrors: errors,
    }
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  } finally {
    await application?.close()
    assert.equal(path.dirname(fs.realpathSync.native(root)), parent)
    assert.ok(path.basename(root).startsWith('siftory-focused-native-'))
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    if (publicParent) {
      assert.equal(path.dirname(fs.realpathSync.native(materials)), publicParent)
      assert.ok(path.basename(materials).startsWith('Siftory-Alpha2-Demo-'))
      fs.rmSync(materials, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
