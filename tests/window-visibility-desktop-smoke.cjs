// Windows-only fixture. Opens two small disposable windows and routes guarded OS
// clicks through the production visibility controller. No application profile is loaded.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { spawn } = require('node:child_process')
const { createSmokeSpawnEnvironment, redactSmokeText } = require('./smoke-test-utils.cjs')

async function runElectron() {
  const { app, BrowserWindow, screen } = require('electron')
  app.on('window-all-closed', () => {})
  const session = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-window-desktop-'))
  app.setPath('userData', session)
  app.setPath('sessionData', session)
  const report = {
    schemaVersion: 2,
    status: 'running',
    clicks: [],
    frames: [],
    compositorFrames: 'not-captured',
  }
  const environmentReasons = new Set([
    'foreign-window-at-click-point',
    'cursor-moved-before-click',
    'fixture-not-foreground',
    'fixture-activation-refused',
    'mouse-button-already-held',
    'cursor-moved-after-click',
    'cursor-moved-before-restoration',
  ])
  function assertNative(result, stage) {
    if (result.ok) return
    report.interruption = {
      stage,
      reason: result.error,
      environment: environmentReasons.has(result.error),
    }
    assert.fail(result.error)
  }
  function assertPointer(condition, reason) {
    if (condition) return
    assertNative({ ok: false, error: reason }, 'pointer')
  }
  let helper
  let overlay
  let sentinel
  let core
  const reportPath = path.resolve(__dirname, '../artifacts/window-visibility/desktop-smoke.json')
  try {
    await app.whenReady()
    const { loadTsModule } = require('./guard-utils.cjs')
    core = loadTsModule('electron/appCoreIpc.ts')
    const { authorizeIpcWebContents } = loadTsModule('electron/ipcAuthorization.ts')
    const display = screen.getPrimaryDisplay()
    const area = { x: display.workArea.x + 40, y: display.workArea.y + 40, width: 340, height: 240 }
    report.scaleFactor = display.scaleFactor
    const html = path.join(session, 'fixture.html')
    const preload = path.join(session, 'preload.cjs')
    fs.writeFileSync(
      html,
      '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>html,body{margin:0;width:100%;height:100%;background:transparent}#panel{position:absolute;left:20px;top:20px;width:140px;height:120px;background:#22c55e}</style><div id="panel"></div>',
    )
    fs.writeFileSync(
      preload,
      `const { ipcRenderer } = require('electron')
      addEventListener('DOMContentLoaded', () => {
        document.body.dataset.clicks = '0'
        document.body.dataset.downs = '0'
        document.body.dataset.ups = '0'
        document.addEventListener('click', () => { document.body.dataset.clicks = String(Number(document.body.dataset.clicks) + 1) })
        document.addEventListener('mousedown', () => { document.body.dataset.downs = String(Number(document.body.dataset.downs) + 1) })
        document.addEventListener('mouseup', () => { document.body.dataset.ups = String(Number(document.body.dataset.ups) + 1) })
      })
      ipcRenderer.on('show-global-visibility', async (_, { generation }) => {
        await ipcRenderer.invoke('set-overlay-shape', [{ x:20,y:20,width:140,height:120 }], generation)
        await ipcRenderer.invoke('show-window', generation)
      })
      ipcRenderer.on('global-window-shown-for-paint', (_, { generation }) => {
        requestAnimationFrame(() => requestAnimationFrame(() => ipcRenderer.invoke('reveal-window', generation)))
      })
      ipcRenderer.on('fixture-enable-mouse', (_, generation) => ipcRenderer.invoke('set-ignore-mouse', false, generation))
    `,
    )
    const common = {
      ...area,
      frame: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    }
    sentinel = new BrowserWindow({ ...common, backgroundColor: '#1e40af' })
    overlay = new BrowserWindow({ ...common, transparent: true, backgroundColor: '#00000000' })
    const nativeCounts = [{}, {}]
    report.nativeTracing = process.argv.includes('--trace-native')
    for (const [index, window] of (report.nativeTracing ? [sentinel, overlay] : []).entries()) {
      for (const [name, message] of Object.entries({
        move: 0x200,
        down: 0x201,
        up: 0x202,
        double: 0x203,
        mouseActivate: 0x21,
        activate: 0x6,
      })) {
        window.hookWindowMessage(message, () => {
          nativeCounts[index][name] = (nativeCounts[index][name] || 0) + 1
        })
      }
    }
    authorizeIpcWebContents(
      overlay.webContents,
      (url) => url === require('node:url').pathToFileURL(html).href,
    )
    const options = {
      userDataPath: session,
      getMainWindow: () => overlay,
      getWorkArea: () => area,
      ensureWindowOnTop: () => overlay.moveTop(),
      videoDiagnosticMode: 'baseline',
    }
    core.registerAppCoreIpc(options)
    await Promise.all([sentinel.loadFile(html), overlay.loadFile(html)])
    sentinel.show()
    overlay.showInactive()
    overlay.moveTop()
    const hwnd = (window) => {
      const buffer = window.getNativeWindowHandle()
      return (
        buffer.length === 8 ? buffer.readBigUInt64LE() : BigInt(buffer.readUInt32LE())
      ).toString()
    }
    const nativeScript = fs.readFileSync(
      path.join(__dirname, 'window-visibility-native-input.ps1'),
      'utf8',
    )
    // Structured spawn arguments execute the checked-in script without changing
    // the machine's PowerShell execution policy or opening a console window.
    helper = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `& {${nativeScript}\n} -FixtureProcessId ${process.pid} -SentinelHandle ${hwnd(sentinel)} -OverlayHandle ${hwnd(overlay)}`,
      ],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    )
    const responses = readline.createInterface({ input: helper.stdout })
    const messages = responses[Symbol.asyncIterator]()
    report.nativeLayout = JSON.parse((await messages.next()).value)
    assert.equal(report.nativeLayout.ready, true)
    assert.ok([4, 8].includes(report.nativeLayout.pointerSize))
    assert.equal(report.nativeLayout.inputSize, report.nativeLayout.pointerSize === 8 ? 40 : 28)
    assert.equal(report.nativeLayout.unionOffset, report.nativeLayout.pointerSize === 8 ? 8 : 4)
    assert.equal(report.nativeLayout.perMonitorDpi, true)
    report.geometry = {
      area,
      sentinelBounds: sentinel.getBounds(),
      sentinelContent: sentinel.getContentBounds(),
      overlayBounds: overlay.getBounds(),
    }
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const count = (window) =>
      window.webContents.executeJavaScript('Number(document.body.dataset.clicks)')
    async function clickAt(x, y, recipient, label) {
      ;(recipient === 0 ? sentinel : overlay).focus()
      sentinel.moveTop()
      overlay.moveTop()
      await delay(50)
      const before = [await count(sentinel), await count(overlay)]
      const point = screen.dipToScreenPoint({ x: area.x + x, y: area.y + y })
      helper.stdin.write(`${JSON.stringify({ command: 'prepare', ...point })}\n`)
      const prepared = JSON.parse((await messages.next()).value)
      report.lastPrepared = prepared
      assertNative(prepared, 'prepare')
      assert.equal(prepared.cursorAtTarget, true)
      // Let the target renderer consume the move before checking native ownership
      // again and sending the button pair. There is no unverified absolute move
      // bundled with the click, and no failed click is automatically reinjected.
      await (recipient === 0 ? sentinel : overlay).webContents.executeJavaScript(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      )
      helper.stdin.write('{"command":"click"}\n')
      const input = JSON.parse((await messages.next()).value)
      report.lastInput = input
      assertNative(input, 'click')
      assertPointer(input.cursorAtTarget, 'cursor-moved-after-click')
      let after = before
      for (let attempt = 0; attempt < 20; attempt++) {
        await delay(25)
        after = [await count(sentinel), await count(overlay)]
        if (after[recipient] > before[recipient]) break
      }
      helper.stdin.write('{"command":"restore"}\n')
      const restoration = JSON.parse((await messages.next()).value)
      report.lastRestoration = restoration
      assertNative(restoration, 'restore')
      assert.equal(restoration.restored, true, restoration.status)
      if (after[recipient] - before[recipient] !== 1) {
        report.rejectedClick = {
          state: label,
          nativeRecipient: input.recipient,
          input,
          nativeCounts,
          before,
          after,
          pointerEvents: await sentinel.webContents.executeJavaScript(
            '({downs:Number(document.body.dataset.downs), ups:Number(document.body.dataset.ups), focused:document.hasFocus()})',
          ),
        }
      }
      assert.equal(after[recipient] - before[recipient], 1)
      assert.equal(after[1 - recipient] - before[1 - recipient], 0)
      report.clicks.push({
        state: label,
        recipient: recipient === 0 ? 'sentinel' : 'overlay',
        native: input,
        passed: true,
      })
    }
    for (let cycle = 0; cycle < 4; cycle++) {
      core.setGlobalWindowVisibility(options, false, 'recovery')
      await clickAt(50, 60, 0, 'hidden')
      core.setGlobalWindowVisibility(options, true, 'recovery')
      for (let attempt = 0; overlay.getOpacity() < 0.99 && attempt < 100; attempt++) await delay(10)
      assert.ok(overlay.getOpacity() >= 0.99)
      // Source-frame samples are useful for blank renderer regressions, but do not
      // capture every DWM/compositor frame or prove absence of display flicker.
      for (let frame = 0; frame < 3; frame++) {
        await overlay.webContents.executeJavaScript(
          'new Promise(resolve => requestAnimationFrame(resolve))',
        )
        const bitmap = (
          await overlay.webContents.capturePage({ x: 50, y: 60, width: 1, height: 1 })
        ).toBitmap()
        assert.deepEqual([...bitmap.subarray(0, 4)], [94, 197, 34, 255])
        report.frames.push({ cycle, frame, sourcePixelMatches: true })
      }
      await clickAt(250, 180, 0, 'visible-outside-shape')
      // Production mouse policy enables interaction only after reveal; set via
      // its authorized IPC, then verify the same point reaches the overlay.
      // A preload-only test command invokes the existing guarded product IPC.
      overlay.webContents.send('fixture-enable-mouse', cycle * 2 + 2)
      await delay(40)
      await clickAt(50, 60, 1, 'visible-panel')
    }
    report.status = 'passed'
  } catch (error) {
    console.log(redactSmokeText(error.message))
    report.status = report.interruption?.environment ? 'environment-interference' : 'failed'
    report.failure = report.interruption?.environment
      ? 'fixture-environment-interference'
      : 'desktop-fixture-input-or-render-assertion-failed'
  } finally {
    if (helper && helper.exitCode === null) {
      helper.stdin.end()
      await new Promise((resolve) => {
        helper.once('exit', resolve)
        setTimeout(() => {
          if (helper.exitCode === null) helper.kill()
          resolve()
        }, 2_000).unref()
      })
    }
    if (helper && helper.exitCode !== 0) {
      report.nativeCleanup = { exitCode: helper.exitCode, signal: helper.signalCode }
      report.status = 'failed'
      report.failure = 'native-helper-cleanup-failed'
    }
    overlay?.destroy()
    sentinel?.destroy()
    await core?.flushWindowVisibilityDiagnostics()
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    // Chromium may still hold its temporary session files until process exit.
    // The Node parent removes this exact mkdtemp directory after exit.
    process.send({ cleanup: session, completed: report.status === 'passed' }, () =>
      app.exit(
        report.status === 'passed' ? 0 : report.status === 'environment-interference' ? 2 : 1,
      ),
    )
  }
}

if (process.versions.electron) {
  runElectron().catch(() => require('electron').app.exit(1))
} else if (process.platform !== 'win32') {
  console.error('This isolated desktop fixture requires Windows')
  process.exitCode = 1
} else {
  const env = createSmokeSpawnEnvironment({})
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(
    require('electron'),
    [__filename, ...(process.argv.includes('--trace-native') ? ['--trace-native'] : [])],
    {
      windowsHide: true,
      env,
      stdio: ['ignore', 'inherit', 'ignore', 'ipc'],
    },
  )
  let cleanup
  let completed = false
  const timeout = setTimeout(() => child.kill(), 45_000)
  child.on('message', (message) => {
    cleanup = message.cleanup
    completed = message.completed === true
  })
  child.once('exit', (code) => {
    clearTimeout(timeout)
    if (cleanup) {
      const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(cleanup))
      if (
        relative &&
        !relative.startsWith('..') &&
        !path.isAbsolute(relative) &&
        path.basename(cleanup).startsWith('siftory-window-desktop-')
      ) {
        fs.rmSync(cleanup, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
    process.exitCode = code === 0 && completed ? 0 : code === 2 ? 2 : 1
  })
}
