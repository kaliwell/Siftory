// Isolated progress window and fixture migration; never imports the application bootstrap.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const { _electron } = require('playwright')

async function main() {
  const repo = path.resolve(__dirname, '..')
  const evidence = path.join(repo, 'artifacts', 'migration-progress-20261029')
  fs.mkdirSync(evidence, { recursive: true })
  const fixture = fs.mkdtempSync(path.join(evidence, 'isolated-window-'))
  for (const name of [
    'storageMigrationProgress',
    'storageMigrationWindow',
    'storageDirectoryMigration',
    'storageLocationService',
  ]) {
    fs.writeFileSync(
      path.join(fixture, name + '.js'),
      ts.transpileModule(fs.readFileSync(path.join(repo, 'electron', name + '.ts'), 'utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText,
    )
  }
  const original = path.join(fixture, 'profile')
  fs.mkdirSync(original)
  fs.mkdirSync(path.join(fixture, 'session'))
  fs.mkdirSync(path.join(fixture, 'app-data'))
  fs.writeFileSync(path.join(original, 'Local State'), '{}')
  fs.writeFileSync(path.join(original, 'Preferences'), '{}')
  fs.writeFileSync(path.join(original, 'test-model.bin'), Buffer.alloc(2 * 1024 * 1024, 42))
  const profileSnapshot = () =>
    fs
      .readdirSync(original)
      .filter((n) => n !== '.siftory-library.json')
      .sort()
      .map((n) => ({
        name: n,
        hash: require('node:crypto')
          .createHash('sha256')
          .update(fs.readFileSync(path.join(original, n)))
          .digest('hex'),
      }))
  const beforeProfile = profileSnapshot()
  const entry = path.join(fixture, 'main.cjs')
  fs.writeFileSync(
    entry,
    `
    const {app} = require('electron');
    const path = require('node:path');
    app.disableHardwareAcceleration();
    app.setPath('userData', path.join(__dirname, 'profile'));
    app.setPath('sessionData', path.join(__dirname, 'session'));
    const service = new (require('./storageLocationService').StorageLocationService)(path.join(__dirname,'app-data'),app.getPath('userData'));
    service.initialize();
    app.on('window-all-closed', () => {});
    global.cancelCount = 0;
    global.rendererErrors = [];
    global.writeTestImage = (filename, bytes) => require('node:fs').writeFileSync(filename, bytes);
    global.runMigrationFixture = async () => {
      const destination = path.join(__dirname,'copied-library');
      service.schedule(destination);
      const window = await global.createProgressWindow(() => {});
      const phases = new Set();
      const result = await require('./storageDirectoryMigration').migrateStorageDirectory(service,{
        onProgress: value => {phases.add(value.phase);window.update(value)},
      });
      window.close();
      return {result,phases:[...phases],activeRoot:service.resolveRoot(),destination};
    };
    app.on('web-contents-created', (_event, contents) => {
      contents.on('console-message', (_event, level, message) => {
        if (level >= 3) global.rendererErrors.push(message);
      });
    });
    app.whenReady().then(async () => {
      global.createProgressWindow = require('./storageMigrationWindow').createStorageMigrationWindow;
      global.progressWindow = await global.createProgressWindow(() => global.cancelCount++);
    });
  `,
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const application = await _electron.launch({
    executablePath: require('electron'),
    args: [entry],
    env,
  })
  try {
    await application.evaluate(async () => {
      for (let i = 0; i < 200; i++) {
        if (global.progressWindow) return
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error('Migration window did not become ready')
    })
    const state = await application.evaluate(async ({ BrowserWindow, app, session }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const preferences = window.webContents.getLastWebPreferences()
      return {
        initial: await window.webContents.executeJavaScript(`({
          phase:document.getElementById('phase').textContent,
          indeterminate:!document.getElementById('progress').hasAttribute('value'),
          nodeAccess:typeof require, overflow:document.documentElement.scrollHeight > innerHeight
        })`),
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
        isolatedSession:
          window.webContents.session === session.fromPartition('siftory-storage-migration'),
        persistentSession: window.webContents.session.isPersistent(),
        userData: app.getPath('userData'),
      }
    })
    assert.equal(state.initial.indeterminate, true)
    assert.equal(state.initial.nodeAccess, 'undefined')
    assert.equal(state.initial.overflow, false)
    assert.equal(state.sandbox, true)
    assert.equal(state.contextIsolation, true)
    assert.equal(state.nodeIntegration, false)
    assert.equal(state.isolatedSession, true)
    assert.equal(state.persistentSession, false)
    assert.ok(state.userData.startsWith(fixture))
    const value = {
      phase: 'verifying',
      currentFile: 'models/<img src=x onerror="window.injection=true">/model.onnx',
      scannedFiles: 200000,
      copiedBytes: 10 * 1024 ** 3,
      totalBytes: 10 * 1024 ** 3,
      copiedFiles: 200000,
      totalFiles: 200000,
      verifiedBytes: 10 * 1024 ** 3,
      verifiedFiles: 100000,
    }
    const verification = await application.evaluate(async ({ BrowserWindow }, value) => {
      global.progressWindow.update(value)
      const window = BrowserWindow.getAllWindows()[0]
      return window.webContents.executeJavaScript(`({
        progress:document.getElementById('progress').value,
        file:document.getElementById('current').textContent,
        injected:!!window.injection,
        files:document.getElementById('files').textContent,
        bytes:document.getElementById('bytes').textContent,
        clipped:Array.from(document.querySelectorAll('.card,.footer,.note')).some(e=>e.getBoundingClientRect().bottom>innerHeight),
        nodeAccess:typeof require
      })`)
    }, value)
    assert.equal(verification.progress, 0.745)
    assert.equal(verification.injected, false)
    assert.equal(verification.file, value.currentFile)
    assert.equal(verification.clipped, false)
    assert.match(verification.files, /100,000.*200,000/)
    assert.match(verification.bytes, /10 GiB.*20 GiB/)
    await application.evaluate(
      async ({ BrowserWindow }, filename) => {
        await new Promise((resolve) => setTimeout(resolve, 250))
        const png = await BrowserWindow.getAllWindows()[0].capturePage()
        global.writeTestImage(filename, png.toPNG())
      },
      path.join(evidence, 'progress-window.png'),
    )
    await application.evaluate(async ({ BrowserWindow }) => {
      await new Promise((resolve) => setTimeout(resolve, 1100))
      const elapsed = await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        "document.getElementById('elapsed').textContent",
      )
      if (elapsed.endsWith('00:00:00')) throw new Error('Elapsed timer did not advance')
    })
    const navigation = await application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const original = window.webContents.getURL()
      await window.webContents.executeJavaScript("location.href='https://example.invalid'")
      await new Promise((resolve) => setTimeout(resolve, 150))
      return window.webContents.getURL() === original
    })
    assert.equal(navigation, true)
    await application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      await window.webContents.executeJavaScript("document.getElementById('cancel').click()")
    })
    const cancellation = await application.evaluate(async ({ BrowserWindow }) => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return { calls: global.cancelCount, windows: BrowserWindow.getAllWindows().length }
    })
    assert.deepEqual(cancellation, { calls: 1, windows: 0 })
    const completion = await application.evaluate(async ({ BrowserWindow }) => {
      global.cancelCount = 0
      global.progressWindow = await global.createProgressWindow(() => global.cancelCount++)
      global.progressWindow.update({
        phase: 'completed',
        currentFile: '',
        scannedFiles: 1,
        copiedBytes: 1,
        totalBytes: 1,
        copiedFiles: 1,
        totalFiles: 1,
        verifiedBytes: 2,
        verifiedFiles: 1,
      })
      const state = await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        "({progress:document.getElementById('progress').value,disabled:document.getElementById('cancel').disabled})",
      )
      global.progressWindow.close()
      return {
        ...state,
        calls: global.cancelCount,
        windows: BrowserWindow.getAllWindows().length,
        errors: global.rendererErrors,
      }
    })
    assert.equal(completion.progress, 1)
    assert.equal(completion.disabled, true)
    assert.equal(completion.calls, 0)
    assert.equal(completion.windows, 0)
    assert.deepEqual(completion.errors, [])
    const earlyClose = await application.evaluate(async ({ app, BrowserWindow }) => {
      let cancelled = 0
      app.once('browser-window-created', (_event, window) => {
        window.webContents.once('did-start-loading', () => window.close())
      })
      let rejected = false
      try {
        await global.createProgressWindow(() => cancelled++)
      } catch {
        rejected = true
      }
      return { rejected, cancelled, windows: BrowserWindow.getAllWindows().length }
    })
    assert.equal(earlyClose.rejected, true)
    // loadURL may reject before the native closed event; either path must stop
    // initialization, release the window and notify cancellation at most once.
    assert.ok(earlyClose.cancelled <= 1)
    assert.equal(earlyClose.windows, 0)
    const updateFailure = await application.evaluate(async ({ BrowserWindow }) => {
      let cancelled = 0
      const progress = await global.createProgressWindow(() => cancelled++)
      const window = BrowserWindow.getAllWindows()[0]
      window.setProgressBar = () => {
        throw new Error('simulated native taskbar error')
      }
      progress.update({
        phase: 'copying',
        currentFile: 'payload.bin',
        scannedFiles: 1,
        copiedBytes: 0,
        totalBytes: 1,
        copiedFiles: 0,
        totalFiles: 1,
        verifiedBytes: 0,
        verifiedFiles: 0,
      })
      progress.close()
      return { cancelled, windows: BrowserWindow.getAllWindows().length }
    })
    assert.deepEqual(updateFailure, { cancelled: 1, windows: 0 })
    const migration = await application.evaluate(async () => global.runMigrationFixture())
    assert.equal(migration.result.migrated, true)
    assert.equal(migration.activeRoot, migration.destination)
    assert.deepEqual(migration.phases, [
      'scanning',
      'copying',
      'checking-source',
      'verifying',
      'committing',
      'completed',
    ])
    assert.deepEqual(
      profileSnapshot(),
      beforeProfile,
      'Chromium must not alter the source during migration',
    )
    assert.deepEqual(
      fs.readFileSync(path.join(migration.destination, 'test-model.bin')),
      fs.readFileSync(path.join(original, 'test-model.bin')),
    )
    const result = {
      passed: true,
      state,
      verification,
      navigation,
      cancellation,
      completion,
      earlyClose,
      updateFailure,
      migration,
      originalPayloadUnchanged: true,
    }
    fs.writeFileSync(path.join(evidence, 'window-smoke.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await application.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
