const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { _electron: electron } = require('playwright')
const sharp = require('sharp')
const { createSmokeSessionMarker, createSmokeSpawnEnvironment } = require('./smoke-test-utils.cjs')
const repo = path.resolve(__dirname, '..')
const evidence = path.join(repo, 'artifacts', 'alpha3-install-test')
fs.mkdirSync(evidence, { recursive: true })
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const powershell = (script) =>
  cp
    .execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    })
    .trim()
function registry() {
  return JSON.parse(
    powershell(
      "$items=@(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object { $_.DisplayName -like '*Siftory*' } | Select-Object PSChildName,DisplayName,DisplayVersion,InstallLocation,UninstallString); ConvertTo-Json -InputObject $items -Compress",
    ),
  )
}
function execute(file, args) {
  return new Promise((resolve, reject) => {
    const p = cp.spawn(file, args, { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => {
      p.kill()
      reject(new Error('Installer process timeout'))
    }, 180000)
    p.on('error', reject)
    p.on('exit', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error(`Installer exit ${code}`))
    })
  })
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(check) {
  const end = Date.now() + 45000
  while (Date.now() < end) {
    if (await check()) return
    await delay(500)
  }
  throw new Error('Timed out waiting for filesystem/registry')
}
async function main() {
  const before = registry()
  assert.ok(
    !before.some((x) => x.DisplayName.includes('Alpha')),
    'An existing Alpha install must not be overwritten',
  )
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), 'SiftoryAlphaInstall-'),
  )
  assert.ok(!root.includes(' '), 'NSIS silent test path must have no spaces')
  const install = path.join(root, 'app'),
    profile = path.join(root, 'floating-clock-electron'),
    materials = path.join(root, 'materials')
  fs.mkdirSync(profile)
  fs.mkdirSync(materials)
  fs.writeFileSync(
    path.join(evidence, 'local-paths.json'),
    JSON.stringify({ root, install, profile }),
  )
  const nonce = createSmokeSessionMarker(profile, 'packaged')
  const sentinel = path.join(profile, 'backup-test-sentinel.txt')
  fs.writeFileSync(sentinel, crypto.randomBytes(128))
  const sentinelSha = sha(sentinel)
  fs.writeFileSync(
    path.join(profile, 'floating_clock_settings.json'),
    JSON.stringify({ language: 'zh-CN', showUnifiedSearch: true, themeMode: 'dark' }),
  )
  const files = []
  for (let i = 0; i < 3; i++) {
    const f = path.join(materials, `fixture-${i}.jpg`)
    await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: ['#123456', '#abcdef', '#ddaa22'][i],
      },
    })
      .jpeg()
      .toFile(f)
    files.push({ file: f, sha256: sha(f) })
  }
  const installer = path.join(repo, 'release', 'Siftory Alpha Online Setup 1.0.1-alpha.3.exe')
  const installerSha = sha(installer)
  const env = createSmokeSpawnEnvironment({
    APPDATA: root,
    SIFTORY_PACKAGED_VALIDATION: '1',
    FLOATING_CLOCK_UI_SMOKE_USER_DATA: profile,
    FLOATING_CLOCK_SMOKE_SESSION_NONCE: nonce,
    FLOATING_CLOCK_REQUIRE_SANDBOX: '1',
    SIFTORY_MEDIA_SEARCH_DIR: path.join(profile, 'media-search'),
    FLOATING_CLOCK_MEDIA_SEARCH_DIR: path.join(profile, 'media-search'),
    NODE_ENV: 'production',
  })
  for (const key of Object.keys(env))
    if (/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|VITE_DEV_SERVER_URL)$/i.test(key))
      delete env[key]
  let app
  const errors = []
  async function launch(label) {
    app = await electron.launch({
      executablePath: path.join(install, 'Siftory.exe'),
      args: [],
      cwd: install,
      env,
      timeout: 60000,
    })
    const state = await app.evaluate(({ app, BrowserWindow }) => ({
      packaged: app.isPackaged,
      version: app.getVersion(),
      profile: app.getPath('userData'),
      windows: BrowserWindow.getAllWindows().map((w) => {
        const p = w.webContents.getLastWebPreferences()
        return {
          sandbox: p.sandbox,
          contextIsolation: p.contextIsolation,
          nodeIntegration: p.nodeIntegration,
        }
      }),
    }))
    assert.equal(fs.realpathSync.native(state.profile), fs.realpathSync.native(profile))
    assert.equal(state.packaged, true)
    assert.equal(state.version, '1.0.1-alpha.3')
    const page = await app.firstWindow({ timeout: 45000 })
    page.on('pageerror', (e) => errors.push(e.message))
    await page.getByTestId('workspace-domain-search').waitFor({ timeout: 45000 })
    const security = await app.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
      return {
        sandbox: p.sandbox,
        contextIsolation: p.contextIsolation,
        nodeIntegration: p.nodeIntegration,
      }
    })
    assert.deepEqual(security, { sandbox: true, contextIsolation: true, nodeIntegration: false })
    await page.screenshot({ path: path.join(evidence, `${label}.png`) })
    return page
  }
  try {
    await execute(installer, ['/S', `/D=${install}`])
    assert.ok(fs.existsSync(path.join(install, 'resources', 'app.asar')))
    const installed = registry()
    assert.ok(installed.some((x) => x.DisplayName.includes('Alpha')))
    assert.deepEqual(
      installed.filter((x) => !x.DisplayName.includes('Alpha')),
      before,
    )
    let page = await launch('installed')
    const start = await page.evaluate(
      (paths) =>
        window.electronAPI.imageSearch.startScan({ paths, mode: 'fast', scanMode: 'full' }),
      [materials],
    )
    assert.equal(start.nativeConnected, true, JSON.stringify(start))
    assert.notEqual(start.state, 'error')
    await waitFor(async () => {
      const status = await page.evaluate(() => window.electronAPI.imageSearch.getStatus())
      return (
        status.indexedCount === 3 && status.autosaveState === 'saved' && status.state === 'idle'
      )
    })
    const manifest = path.join(profile, 'image-search-index', 'manifest.json')
    assert.ok(fs.existsSync(manifest), 'Saved manifest must exist in the temporary profile')
    const manifestSha = sha(manifest)
    const rows = await page.evaluate(() => window.electronAPI.imageSearch.queryData('', 0, 50))
    assert.equal(rows.ok, true)
    assert.equal(rows.records.length, 3)
    await app.close()
    app = null
    assert.equal(sha(sentinel), sentinelSha)
    await execute(installer, ['/S', `/D=${install}`])
    page = await launch('reinstalled')
    assert.equal(sha(manifest), manifestSha)
    await waitFor(async () => {
      const result = await page.evaluate(() => window.electronAPI.imageSearch.queryData('', 0, 50))
      return result.ok && result.records.length === 3
    })
    const afterRows = await page.evaluate(() => window.electronAPI.imageSearch.queryData('', 0, 50))
    assert.equal(afterRows.ok, true)
    assert.equal(afterRows.records.length, 3)
    await app.close()
    app = null
    const uninstaller = fs.readdirSync(install).find((f) => /^Uninstall.*\.exe$/i.test(f))
    assert.ok(uninstaller)
    await execute(path.join(install, uninstaller), ['/S', `_?=${install}`])
    await waitFor(() => !fs.existsSync(path.join(install, 'Siftory.exe')))
    await waitFor(() => !registry().some((x) => x.DisplayName.includes('Alpha')))
    assert.deepEqual(registry(), before)
    assert.equal(sha(sentinel), sentinelSha)
    for (const f of files) assert.equal(sha(f.file), f.sha256)
    assert.deepEqual(errors, [])
    const report = {
      passed: true,
      version: '1.0.1-alpha.3',
      platform: 'Windows x64',
      installerSha256: installerSha,
      checks: {
        silentInstall: true,
        normalPackagedLaunch: true,
        sandboxEnabled: true,
        isolatedTemporaryProfile: true,
        nativeIndexThreeGeneratedImages: true,
        sameVersionReinstall: true,
        indexPreservedAfterReinstall: true,
        silentUninstall: true,
        testProfileAndOriginalsPreserved: true,
        preexistingStableRegistrationUnchanged: true,
      },
      limitations: [
        'Same-version reinstall only; cross-version upgrade and every Windows configuration are not certified.',
        'AI weights are excluded from Online package; this test verifies native indexing, not AI inference.',
      ],
      rendererErrors: 0,
    }
    fs.writeFileSync(
      path.join(evidence, 'public-report.json'),
      JSON.stringify(report, null, 2) + '\n',
    )
    fs.writeFileSync(
      path.join(evidence, 'local-paths.json'),
      JSON.stringify({ root, install, profile }, null, 2),
    )
    console.log(JSON.stringify(report, null, 2))
  } finally {
    if (app) await app.close().catch(() => {})
  }
}
main().catch((e) => {
  fs.writeFileSync(path.join(evidence, 'failure.txt'), e.stack)
  console.error(e.stack)
  process.exitCode = 1
})
