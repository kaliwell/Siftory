// Uses the production controller, compiled renderer and sandboxed preload with
// explicitly artificial agreements. The launcher supplies a nonce-guarded temp profile.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { createSmokeSessionMarker, createSmokeSpawnEnvironment } = require('./smoke-test-utils.cjs')
const root = path.resolve(__dirname, '..')
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function runElectron() {
  const { app, BrowserWindow, session } = require('electron')
  app.commandLine.appendSwitch('disable-direct-composition')
  const { loadTsModule } = require('./guard-utils.cjs')
  const { validateStartupSecurity, hardenMainSession } = loadTsModule('electron/startupSecurity.ts')
  const security = validateStartupSecurity({
    argv: process.argv,
    env: process.env,
    noSandboxSwitchPresent: app.commandLine.hasSwitch('no-sandbox'),
    disableSandboxSwitchPresent: app.commandLine.hasSwitch('disable-sandbox'),
  })
  assert.equal(security.smokeMode, 'ui')
  assert.ok(security.smokeUserDataPath)
  app.setPath('userData', security.smokeUserDataPath)
  app.setPath('sessionData', security.smokeUserDataPath)
  app.on('window-all-closed', () => {})
  const reportPath = path.join(security.smokeUserDataPath, 'terms-smoke.json')
  assert.equal(path.resolve(process.env.FLOATING_CLOCK_UI_SMOKE_REPORT), reportPath)
  const language = process.env.FLOATING_CLOCK_UI_SMOKE_LOCALE === 'en' ? 'en' : 'zh-CN'
  const fixtureRoot = path.join(security.smokeUserDataPath, 'artificial-resources')
  const directory = path.join(fixtureRoot, 'legal', 'end-user-terms')
  const receipt = path.join(security.smokeUserDataPath, 'end-user-terms-acceptance.json')
  fs.mkdirSync(directory, { recursive: true })
  const report = {
    ok: false,
    artificialAgreementsOnly: true,
    language,
    checks: [],
    processVersions: process.versions,
    sourceHashes: Object.fromEntries(
      [
        'electron/endUserTerms.ts',
        'electron/endUserTermsWindow.ts',
        'electron/ipcAuthorization.ts',
        'dist/terms.html',
        'dist-electron/endUserTermsPreload.js',
      ].map((file) => [file, hash(fs.readFileSync(path.join(root, file)))]),
    ),
  }
  const check = (name) => {
    report.checks.push(name)
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  }
  const writeTerms = (version) => {
    const text = `AUTOMATED TEST AGREEMENT — NOT A REAL LICENSE\n测试协议，不构成真实授权。\n${'<script>throw new Error("injection")</script>\n'.repeat(3)}${'Test clause / 测试条款\n'.repeat(100)}`
    fs.writeFileSync(path.join(directory, 'test.txt'), text)
    fs.writeFileSync(
      path.join(directory, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'final',
        title: 'Siftory — automated test agreement',
        publisher: 'Automated fixture (no real publisher)',
        version,
        effectiveDate: '2026-09-25',
        documents: [{ path: 'test.txt', sha256: hash(text) }],
      }),
    )
  }
  const poll = async (fn) => {
    const end = Date.now() + 12000
    while (Date.now() < end) {
      const value = await fn()
      if (value) return value
      await delay(40)
    }
    throw new Error('Terms UI timed out')
  }
  const active = async () =>
    poll(async () => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window || window.isDestroyed() || !window.isVisible() || window.webContents.isLoading())
        return null
      return (await window.webContents.executeJavaScript(
        'Boolean(document.querySelector("[data-testid=end-user-terms-dialog]"))',
      ))
        ? window
        : null
    })
  const click = (window, id) =>
    // A closing click destroys its execution context. Return before triggering it.
    window.webContents.executeJavaScript(
      `setTimeout(() => document.querySelector('[data-testid=${id}]').click(), 20); true`,
    )
  const accept = async (window) => {
    await click(window, 'end-user-terms-checkbox')
    await poll(() =>
      window.webContents.executeJavaScript(
        '!document.querySelector("[data-testid=end-user-terms-accept]").disabled',
      ),
    )
    await click(window, 'end-user-terms-accept')
  }
  try {
    await app.whenReady()
    hardenMainSession(session.defaultSession)
    const { EndUserTermsController } = loadTsModule('electron/endUserTermsWindow.ts')
    const controller = new EndUserTermsController({
      resourcesRoot: fixtureRoot,
      userDataPath: security.smokeUserDataPath,
      appPath: root,
      language,
    })
    controller.register()
    writeTerms('test-1')
    let decision = controller.ensureAccepted()
    let window = await active()
    const state = await window.webContents.executeJavaScript(
      `({ unchecked: !document.querySelector('[type=checkbox]').checked, disabled: document.querySelector('[data-testid=end-user-terms-accept]').disabled, text: document.querySelector('[data-testid=end-user-terms-text]').textContent, scripts: document.querySelector('[data-testid=end-user-terms-text]').querySelectorAll('script').length, focused: document.activeElement.dataset.testid, language: document.querySelector('[role=dialog]').lang, broadAPI: typeof window.electronAPI, node: typeof window.require, labels: document.querySelector('[data-testid=end-user-terms-reject]').textContent })`,
    )
    assert.equal(state.unchecked, true)
    assert.equal(state.disabled, true)
    assert.equal(state.scripts, 0)
    assert.ok(state.text.includes('<script>'))
    assert.equal(state.focused, 'end-user-terms-text')
    assert.equal(state.language, language)
    assert.equal(state.broadAPI, 'undefined')
    assert.equal(state.node, 'undefined')
    assert.equal(state.labels, language === 'en' ? 'Decline and exit' : '拒绝并退出')
    check('unchecked, plain text, localized, initial focus, isolated preload')
    await window.webContents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    )
    fs.writeFileSync(
      path.join(security.smokeUserDataPath, 'terms-desktop.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
    window.setSize(480, 420)
    await delay(100)
    const layout = await window.webContents.executeJavaScript(
      `(() => { const body = document.querySelector('[data-testid=end-user-terms-text]'); const button = document.querySelector('[data-testid=end-user-terms-accept]').getBoundingClientRect(); return { scrolls: body.scrollHeight > body.clientHeight, fits: button.bottom <= innerHeight && button.right <= innerWidth, noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth } })()`,
    )
    assert.deepEqual(layout, { scrolls: true, fits: true, noHorizontalOverflow: true })
    fs.writeFileSync(
      path.join(security.smokeUserDataPath, 'terms-small.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
    check('480 x 420 scrollable text and visible actions')
    await window.webContents.executeJavaScript(
      `document.querySelector('[data-testid=end-user-terms-text]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    )
    assert.equal(fs.existsSync(receipt), false)
    assert.equal(window.isDestroyed(), false)
    await click(window, 'end-user-terms-reject')
    assert.equal(await decision, false)
    assert.equal(fs.existsSync(receipt), false)
    check('escape does not consent; decline produces no receipt')
    decision = controller.ensureAccepted()
    window = await active()
    window.close()
    assert.equal(await decision, false)
    assert.equal(fs.existsSync(receipt), false)
    check('window close refuses without receipt')
    decision = controller.ensureAccepted()
    window = await active()
    await accept(window)
    assert.equal(await decision, true)
    const accepted = JSON.parse(fs.readFileSync(receipt, 'utf8'))
    assert.deepEqual(Object.keys(accepted).sort(), [
      'acceptedAt',
      'publisher',
      'schemaVersion',
      'sha256',
      'version',
    ])
    assert.equal(await controller.ensureAccepted(), true)
    assert.equal(BrowserWindow.getAllWindows().length, 0)
    check('explicit accept persists minimal receipt; same version skips prompt')
    const beforeView = fs.readFileSync(receipt)
    assert.equal(controller.view().ok, true)
    window = await active()
    const readOnly = await window.webContents.executeJavaScript(
      `(async () => ({ noConsent: !document.querySelector('[type=checkbox]') && !document.querySelector('[data-testid=end-user-terms-accept]'), refused: await window.termsAPI.accept({version:${JSON.stringify(accepted.version)}, sha256:${JSON.stringify(accepted.sha256)}}) }))()`,
    )
    assert.equal(readOnly.noConsent, true)
    assert.deepEqual(readOnly.refused, { ok: false, reason: 'invalid-request' })
    await click(window, 'end-user-terms-close')
    await poll(() => window.isDestroyed())
    assert.deepEqual(fs.readFileSync(receipt), beforeView)
    check('read-only viewing cannot create or change receipt')
    writeTerms('test-2')
    decision = controller.ensureAccepted()
    window = await active()
    writeTerms('test-3')
    await accept(window)
    await poll(() =>
      window.webContents.executeJavaScript('Boolean(document.querySelector("[role=alert]"))'),
    )
    assert.equal(window.isDestroyed(), false)
    assert.deepEqual(fs.readFileSync(receipt), beforeView)
    await click(window, 'end-user-terms-reject')
    assert.equal(await decision, false)
    check('changed version prompts; stale visible terms cannot be accepted')
    fs.writeFileSync(receipt, '{corrupt')
    decision = controller.ensureAccepted()
    window = await active()
    fs.unlinkSync(receipt)
    fs.mkdirSync(receipt)
    await accept(window)
    await poll(() =>
      window.webContents.executeJavaScript('Boolean(document.querySelector("[role=alert]"))'),
    )
    assert.equal(window.isDestroyed(), false)
    assert.equal(fs.statSync(receipt).isDirectory(), true)
    await click(window, 'end-user-terms-reject')
    assert.equal(await decision, false)
    fs.rmdirSync(receipt)
    check('corrupt receipt prompts; save failure keeps decision pending')
    fs.writeFileSync(
      path.join(directory, 'manifest.json'),
      JSON.stringify({ schemaVersion: 1, status: 'review' }),
    )
    assert.equal(await controller.ensureAccepted(), true)
    assert.deepEqual(controller.view(), { ok: false, reason: 'not-published' })
    assert.equal(fs.existsSync(receipt), false)
    check('review candidate has no fake acceptance or finalized agreement')
    report.ok = true
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
  } finally {
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    app.exit(report.ok ? 0 : 1)
  }
}

async function launch() {
  const output = path.resolve(
    process.argv.find((value) => value.startsWith('--output='))?.slice(9) ||
      path.join('artifacts', 'end-user-terms', new Date().toISOString().replace(/[:.]/g, '-')),
  )
  fs.mkdirSync(output, { recursive: true })
  for (const language of ['en', 'zh-CN']) {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-terms-smoke-'))
    const nonce = createSmokeSessionMarker(userDataPath, 'ui')
    const reportPath = path.join(userDataPath, 'terms-smoke.json')
    const env = createSmokeSpawnEnvironment({
      FLOATING_CLOCK_UI_SMOKE_REPORT: reportPath,
      FLOATING_CLOCK_UI_SMOKE_USER_DATA: userDataPath,
      FLOATING_CLOCK_SMOKE_SESSION_NONCE: nonce,
      FLOATING_CLOCK_UI_SMOKE_LOCALE: language,
      FLOATING_CLOCK_REQUIRE_SANDBOX: '1',
    })
    const child = spawn(require('electron'), [__filename], {
      cwd: root,
      env,
      // This is the GUI under test. SW_HIDE suppresses its first BrowserWindow on Windows.
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const log = fs.createWriteStream(path.join(output, `${language}.log`), { flags: 'wx' })
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })
    const timeout = setTimeout(() => child.kill(), 90000)
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    clearTimeout(timeout)
    log.end()
    const report = fs.existsSync(reportPath)
      ? JSON.parse(fs.readFileSync(reportPath, 'utf8'))
      : {
          ok: false,
          error: 'Process exited without report (including possible timeout)',
          checks: [],
        }
    for (const name of ['terms-smoke.json', 'terms-desktop.png', 'terms-small.png']) {
      const source = path.join(userDataPath, name)
      if (fs.existsSync(source))
        fs.copyFileSync(
          source,
          path.join(output, `${language}-${name}`),
          fs.constants.COPYFILE_EXCL,
        )
    }
    // Preserve disposable profiles for investigation; never remove a computed tree here.
    fs.writeFileSync(
      path.join(output, `${language}-session.json`),
      JSON.stringify({ userDataPath, exitCode: code, artificialFixtureOnly: true }, null, 2),
      { flag: 'wx' },
    )
    console.log(
      JSON.stringify({
        language,
        ok: report.ok,
        exitCode: code,
        checks: report.checks,
        error: report.error,
      }),
    )
    assert.equal(code, 0)
    assert.equal(report.ok, true)
  }
}

if (process.versions.electron) void runElectron()
else
  void launch().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
