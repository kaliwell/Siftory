// Real Windows Shell API and Electron bootstrap, not the simulated supervisor tests.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const sharp = require('sharp')
const { loadTsModule } = require('./guard-utils.cjs')
const { ShellPreviewRuntime } = loadTsModule('electron/projectPreviewShellRuntime.ts')

async function main() {
  if (process.platform !== 'win32') throw Error('Real Shell integration requires Windows')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'siftory-shell-integration-'))
  let helperLog = ''
  const runtime = new ShellPreviewRuntime(async (nonce) => {
    const profile = await fs.mkdtemp(path.join(root, 'profile-'))
    const env = {
      ...process.env,
      SIFTORY_SHELL_PREVIEW_NONCE: nonce,
      SIFTORY_SHELL_PREVIEW_PROFILE: profile,
    }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(
      require('electron'),
      [path.resolve(__dirname, '..'), `--siftory-shell-preview=${nonce}`],
      {
        env,
        serialization: 'advanced',
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    )
    child.stderr.on('data', (bytes) => {
      helperLog = (helperLog + bytes.toString()).slice(-16000)
    })
    return {
      child,
      cleanup: () =>
        fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    }
  })
  try {
    const source = path.join(root, 'thumbnail.png')
    await sharp({ create: { width: 128, height: 96, channels: 3, background: '#ee4422' } })
      .png()
      .toFile(source)
    const metrics = []
    const bytes = await runtime.run(source, { timeoutMs: 20000, onMetrics: (m) => metrics.push(m) })
    assert.ok(bytes?.length, 'Windows Shell must return real PNG pixels through the helper')
    const metadata = await sharp(bytes).metadata()
    assert.ok(metadata.width > 0 && metadata.width <= 1024)
    assert.ok(metadata.height > 0 && metadata.height <= 1024)
    const { data, info } = await sharp(bytes)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const center =
      (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels
    assert.ok(
      data[center] > 180 && data[center + 1] < 110 && data[center + 2] < 80,
      'Content colors must survive Shell extraction',
    )
    const firstPid = runtime.stats().pids[0]
    await runtime.run(source)
    assert.deepEqual(runtime.stats().pids, [firstPid], 'Reuse the isolated Electron process')
    assert.notEqual(metrics[0].childPid, process.pid)
    for (const step of ['stat', 'thumbnail', 'icon', 'compare', 'encode'])
      assert.ok(Number.isFinite(metrics[0].durations[step]), step)
    await runtime.stop()
    assert.deepEqual(runtime.stats().pids, [])
    console.log(
      JSON.stringify({
        passed: true,
        realWindowsShell: true,
        processReused: true,
        contentPixelsPassed: true,
        cleanupPassed: true,
      }),
    )
  } catch (error) {
    console.error(helperLog)
    throw error
  } finally {
    await runtime.stop()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
