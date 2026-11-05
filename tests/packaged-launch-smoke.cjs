// Basic real packaged startup acceptance, isolated by the existing nonce gate.
// This does not replace the separate full UI or installer-upgrade acceptance.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright')
const {
  createSmokeSessionMarker,
  createSmokeSpawnEnvironment,
  resolveUiSmokeExecutable,
  assertTemporaryDirectory,
  redactSmokeText,
} = require('./smoke-test-utils.cjs')

async function main() {
  if (process.platform !== 'win32') throw new Error('Run packaged startup on Windows')
  const repo = path.resolve(__dirname, '..')
  const executablePath = resolveUiSmokeExecutable({ repo, packaged: true })
  const userData = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'siftory-package-boot-'))
  const output = path.join(repo, 'artifacts/online-installer')
  const nonce = createSmokeSessionMarker(userData, 'packaged')
  let application
  let stdout = ''
  let stderr = ''
  try {
    application = await electron.launch({
      chromiumSandbox: true,
      cwd: path.dirname(executablePath),
      executablePath,
      timeout: 90000,
      env: createSmokeSpawnEnvironment({
        SIFTORY_PACKAGED_VALIDATION: '1',
        FLOATING_CLOCK_UI_SMOKE_USER_DATA: userData,
        FLOATING_CLOCK_SMOKE_SESSION_NONCE: nonce,
      }),
    })
    application.process().stdout?.on('data', (bytes) => {
      stdout += bytes.toString()
    })
    application.process().stderr?.on('data', (bytes) => {
      stderr += bytes.toString()
    })
    const terms = await application.firstWindow({ timeout: 90000 })
    await terms.getByTestId('end-user-terms-text').waitFor({ timeout: 90000 })
    await terms.getByTestId('end-user-terms-text').evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await terms.getByTestId('end-user-terms-checkbox').check()
    const mainWindow = application.waitForEvent('window', { timeout: 90000 })
    await terms.getByTestId('end-user-terms-accept').click()
    const page = await mainWindow
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.locator('[data-testid="app-root"][data-ready="true"]').waitFor({ timeout: 90000 })
    await page.getByTestId('workspace-domain-search').waitFor({ timeout: 30000 })
    const provenance = await application.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      version: app.getVersion(),
      userData: app.getPath('userData'),
    }))
    assert.equal(provenance.packaged, true)
    assert.equal(provenance.version, require('../package.json').version)
    assert.equal(fs.realpathSync.native(provenance.userData), fs.realpathSync.native(userData))
    const nativeDeadline = Date.now() + 30000
    while (!stdout.includes('Native addon loaded: fast_scanner') && Date.now() < nativeDeadline)
      await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(
      stdout.includes('Native addon loaded: fast_scanner'),
      'packaged native addon must load',
    )
    assert.deepEqual(pageErrors, [])
    fs.mkdirSync(output, { recursive: true })
    await page.screenshot({ path: path.join(output, 'startup.png') })
    fs.writeFileSync(
      path.join(output, 'startup-check.json'),
      JSON.stringify(
        {
          passed: true,
          version: provenance.version,
          packaged: true,
          isolatedProfile: true,
          agreementShownAndAcceptedInTestProfile: true,
          rendererReady: true,
          nativeAddonLoaded: true,
          pageErrors,
          scope:
            'Fresh isolated unpacked startup; excludes full legacy UI matrix, models/GPU and installer upgrades.',
        },
        null,
        2,
      ) + '\n',
    )
    console.log(
      JSON.stringify({ passed: true, version: provenance.version, nativeAddonLoaded: true }),
    )
  } catch (error) {
    console.error(redactSmokeText(stdout.slice(-16000)))
    console.error(redactSmokeText(stderr.slice(-16000)))
    throw error
  } finally {
    await application?.close()
    assertTemporaryDirectory(userData)
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
