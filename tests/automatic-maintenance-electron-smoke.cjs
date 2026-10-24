// Real IPC regression: opt-in, first observation, restart, expiry, automatic source sync.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const sharp = require('sharp')
const { _electron: electron } = require('playwright')
const repo = path.resolve(__dirname, '..')
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

async function run() {
  if (process.platform !== 'win32') throw new Error('Windows native integration required')
  const parent = fs.realpathSync.native(os.tmpdir())
  const root = fs.mkdtempSync(path.join(parent, 'siftory-automatic-maintenance-'))
  const profile = path.join(root, 'floating-clock-electron')
  const materials = path.join(root, 'materials')
  const evidence = path.join(repo, 'artifacts/automatic-maintenance-native')
  fs.mkdirSync(profile)
  fs.mkdirSync(materials)
  fs.mkdirSync(evidence, { recursive: true })
  const files = []
  for (let index = 0; index < 4; index++) {
    const file = path.join(materials, `material-${index}.jpg`)
    await sharp({
      create: {
        width: 48,
        height: 48,
        channels: 3,
        background: ['#234567', '#aabbcc', '#556677', '#bbccdd'][index],
      },
    })
      .jpeg()
      .toFile(file)
    files.push(file)
  }
  const surviving = files.slice(0, 3).map((file) => ({ file, sha256: digest(file) }))
  const bootstrap = path.join(root, 'bootstrap.cjs')
  fs.writeFileSync(
    bootstrap,
    `const {app}=require('electron');app.setPath('appData',${JSON.stringify(root)});app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(path.join(root, 'session'))});app.setAppPath(${JSON.stringify(repo)});require(${JSON.stringify(path.join(repo, 'dist-electron/main.js'))});`,
  )
  fs.mkdirSync(path.join(root, 'session'))
  fs.writeFileSync(
    path.join(profile, 'floating_clock_settings.json'),
    JSON.stringify({ language: 'zh-CN', showUnifiedSearch: true, themeMode: 'light' }),
  )
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    SIFTORY_MEDIA_SEARCH_DIR: path.join(root, 'media-search'),
    FLOATING_CLOCK_MEDIA_SEARCH_DIR: path.join(root, 'media-search'),
  }
  for (const key of Object.keys(env))
    if (
      /^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|VITE_DEV_SERVER_URL)$/i.test(key) ||
      /^FLOATING_CLOCK_(UI_SMOKE|AI_CONTROL_SMOKE|SMOKE_SESSION)/i.test(key)
    )
      delete env[key]
  let app
  const errors = []
  const launch = async () => {
    app = await electron.launch({ args: [bootstrap], cwd: repo, env, timeout: 45000 })
    const page = await app.firstWindow({ timeout: 45000 })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.getByTestId('workspace-domain-search').waitFor({ timeout: 45000 })
    assert.equal(
      path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))),
      path.resolve(profile),
    )
    return page
  }
  const check = async (page) => {
    const deadline = Date.now() + 60000
    do {
      const result = await page.evaluate(() =>
        window.electronAPI.sourceDerivedData.startAutomaticMaintenanceCheck(),
      )
      if (result.phase !== 'waiting') return result
      await new Promise((resolve) => setTimeout(resolve, 200))
    } while (Date.now() < deadline)
    throw new Error('Automatic maintenance remained busy')
  }
  try {
    let page = await launch()
    assert.equal(
      (await page.evaluate(() => window.electronAPI.sourceDerivedData.autoStatus())).config.enabled,
      false,
    )
    const started = await page.evaluate(
      (paths) =>
        window.electronAPI.imageSearch.startScan({ paths, mode: 'fast', scanMode: 'full' }),
      [materials],
    )
    assert.equal(started.nativeConnected, true, JSON.stringify(started))
    assert.notEqual(started.state, 'error', JSON.stringify(started))
    await page.waitForFunction(
      async () => {
        const status = await window.electronAPI.imageSearch.getStatus()
        return (
          status.indexedCount >= 4 && !['queued', 'scanning', 'indexing'].includes(status.state)
        )
      },
      null,
      { timeout: 45000 },
    )
    assert.equal(path.dirname(fs.realpathSync.native(files[3])), fs.realpathSync.native(materials))
    fs.unlinkSync(files[3]) // Only the generated extra file is deleted.
    await page.evaluate(
      (scope) =>
        window.electronAPI.sourceDerivedData.setAutomaticMaintenance({
          enabled: true,
          scopes: [scope],
        }),
      materials,
    )
    const first = await check(page)
    assert.equal(first.phase, 'completed', JSON.stringify(first))
    assert.equal(first.pendingMissing, 1)
    assert.equal(first.removedImages, 0)
    await app.close()
    app = null

    // Age only the isolated profile's observation, without changing the system clock or production code.
    const stateFile = path.join(profile, 'automatic-index-maintenance.json')
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    const observed = Object.values(state.observations).flatMap((records) => Object.values(records))
    assert.equal(observed.length, 1)
    for (const item of observed) {
      item.first = Date.now() - 25 * 60 * 60 * 1000
      item.last = Date.now() - 60 * 1000
    }
    fs.writeFileSync(stateFile, JSON.stringify(state))
    page = await launch()
    const second = await check(page)
    assert.equal(second.phase, 'completed', JSON.stringify(second))
    assert.equal(second.removedImages, 1)
    assert.equal(second.pendingMissing, 0)
    const rows = await page.evaluate(() => window.electronAPI.imageSearch.queryData('', 0, 50))
    assert.equal(rows.ok, true)
    assert.equal(rows.records.length, 3)
    assert.ok(rows.records.every((row) => !row.path.endsWith('material-3.jpg')))
    for (const item of surviving) assert.equal(digest(item.file), item.sha256)
    await page.getByTestId('workspace-domain-maintenance').click()
    await page.getByTestId('automatic-maintenance').waitFor()
    assert.equal(await page.getByTestId('automatic-maintenance-enabled').isChecked(), true)
    await page.screenshot({ path: path.join(evidence, 'maintenance-after-auto-sync.png') })
    await page.evaluate(
      (scope) =>
        window.electronAPI.sourceDerivedData.setAutomaticMaintenance({
          enabled: false,
          scopes: [scope],
        }),
      materials,
    )
    assert.deepEqual(errors, [])
    const report = {
      passed: true,
      realElectron: true,
      isolatedProfile: true,
      observedBeforeRetiring: true,
      persistedAcrossRestart: true,
      removedImages: second.removedImages,
      remainingImages: rows.records.length,
      survivingSourcesUnchanged: true,
      pageErrors: errors,
    }
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  } finally {
    await app?.close()
    assert.equal(path.dirname(fs.realpathSync.native(root)), parent)
    assert.ok(path.basename(root).startsWith('siftory-automatic-maintenance-'))
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
