const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'controlled-media-player-'))
const videoPath = path.join(temp, 'fixture.webm')
const entryPath = path.join(temp, 'runner.cjs')
const ffmpeg = path.join(root, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe')

try {
  const generated = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=navy:s=320x180:d=3:r=24',
      '-c:v',
      'libvpx-vp9',
      '-pix_fmt',
      'yuv420p',
      videoPath,
    ],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  )
  if (generated.status !== 0) throw new Error(generated.stderr || 'Could not create smoke video')
  buildSync({
    entryPoints: [path.join(__dirname, 'controlled-media-player-smoke-entry.ts')],
    outfile: entryPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'silent',
  })
  const electron = require('electron')
  const run = spawnSync(electron, [entryPath, videoPath, '1250', root], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, FLOATING_CLOCK_REQUIRE_SANDBOX: '1' },
  })
  if (run.status !== 0) throw new Error(run.stderr || `Electron exited ${run.status}`)
  const line = run.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.startsWith('{') && value.endsWith('}'))
  const report = line ? JSON.parse(line) : null
  if (!report?.ok) throw new Error(`Controlled media player smoke failed: ${run.stdout}`)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
