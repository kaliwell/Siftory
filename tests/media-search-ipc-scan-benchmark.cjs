const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const repoRoot = path.resolve(__dirname, '..')
const targetRoot = process.argv[2] || path.join(os.homedir(), 'Downloads')
const modeArg = process.argv.find((arg) => arg.startsWith('--mode='))
const mode = modeArg ? modeArg.slice('--mode='.length) : 'metadata'
const timeoutArg = process.argv.find((arg) => arg.startsWith('--timeout-ms='))
const timeoutMs = timeoutArg ? Math.max(1000, Number(timeoutArg.slice('--timeout-ms='.length)) || 0) : 180000
const concurrencyArg = process.argv.find((arg) => arg.startsWith('--concurrency='))
if (concurrencyArg) {
  process.env.FLOATING_CLOCK_MEDIA_SCAN_CONCURRENCY = concurrencyArg.slice('--concurrency='.length)
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6
}

function round(n, digits = 2) {
  const m = 10 ** digits
  return Math.round(n * m) / m
}

function createElectronMock(userDataDir, progressEvents) {
  const handlers = new Map()
  class WebContents {
    send(channel, payload) {
      if (channel === 'mediaSearch:onTaskProgress') progressEvents.push({ atMs: nowMs(), payload })
    }
    on() {}
    once() {}
    getURL() {
      return 'file://test'
    }
    openDevTools() {}
    setWindowOpenHandler() {}
  }
  class BrowserWindow {
    constructor() {
      this.webContents = new WebContents()
    }
    isDestroyed() {
      return false
    }
    isVisible() {
      return true
    }
    on() {}
    once() {}
    show() {}
    showInactive() {}
    hide() {}
    close() {}
    moveTop() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setSkipTaskbar() {}
    setIgnoreMouseEvents() {}
    setOpacity() {}
    setBounds() {}
    getBounds() {
      return { x: 0, y: 0, width: 800, height: 600 }
    }
    getContentBounds() {
      return { x: 0, y: 0, width: 800, height: 600 }
    }
    setShape() {}
    loadFile() {
      return Promise.resolve()
    }
    loadURL() {
      return Promise.resolve()
    }
  }
  BrowserWindow.getAllWindows = () => [new BrowserWindow()]
  return {
    handlers,
    electron: {
      app: {
        isPackaged: false,
        commandLine: { appendSwitch() {} },
        disableHardwareAcceleration() {},
        getPath: () => userDataDir,
        getAppPath: () => repoRoot,
        whenReady: () => new Promise(() => {}),
        on() {},
        once() {},
        quit() {},
        requestSingleInstanceLock: () => true,
        setAppUserModelId() {},
        getVersion: () => '1.0.0',
        getFileIcon: async () => ({ isEmpty: () => true, toDataURL: () => '' }),
      },
      ipcMain: {
        handle: (name, fn) => handlers.set(name, fn),
        on() {},
      },
      BrowserWindow,
      globalShortcut: {
        register: () => true,
        unregister() {},
        unregisterAll() {},
        isRegistered: () => true,
      },
      shell: {
        showItemInFolder() {},
        openPath: async () => '',
        readShortcutLink: () => ({ target: '' }),
      },
      clipboard: {
        readText: () => '',
        writeText() {},
        readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
      },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      screen: {
        getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
        on() {},
      },
      nativeImage: {
        createFromPath: () => ({ isEmpty: () => true, toDataURL: () => '' }),
        createFromBuffer: () => ({
          isEmpty: () => true,
          toDataURL: () => '',
          getSize: () => ({ width: 0, height: 0 }),
          resize() {
            return this
          },
        }),
      },
    },
  }
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-media-ipc-bench-'))
  const progressEvents = []
  const { handlers, electron } = createElectronMock(userDataDir, progressEvents)
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electron
    return originalLoad.call(this, request, parent, isMain)
  }
  process.resourcesPath = repoRoot
  require(path.join(repoRoot, 'dist-electron', 'main.js'))
  const startScan = handlers.get('videoIndex:startScan')
  const getProgress = handlers.get('videoIndex:getTaskProgress')
  const getStatus = handlers.get('mediaSearch:getStatus')
  if (!startScan || !getProgress || !getStatus) {
    throw new Error('MediaSearch IPC handlers were not registered')
  }

  const started = nowMs()
  const result = await startScan({}, { paths: [targetRoot], mode })
  if (!result || !result.ok || !result.taskId) {
    throw new Error(`startScan failed: ${JSON.stringify(result)}`)
  }
  let lastProgress = null
  while (nowMs() - started < timeoutMs) {
    lastProgress = await getProgress({}, result.taskId)
    if (lastProgress && ['done', 'error', 'stopped'].includes(lastProgress.state)) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const elapsedMs = nowMs() - started
  const status = await getStatus({})
  const terminal = lastProgress && ['done', 'error', 'stopped'].includes(lastProgress.state)
  console.log(
    JSON.stringify(
      {
        ok: terminal && lastProgress.state === 'done',
        targetRoot,
        mode,
        concurrency: process.env.FLOATING_CLOCK_MEDIA_SCAN_CONCURRENCY || 'default',
        elapsedMs: round(elapsedMs),
        elapsedSeconds: round(elapsedMs / 1000),
        task: lastProgress,
        status,
        progressEvents: progressEvents.length,
        userDataDir,
      },
      null,
      2,
    ),
  )
  if (!terminal || lastProgress.state !== 'done') process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
