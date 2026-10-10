const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const workerPath = path.join(projectRoot, 'dist-electron', 'audioSemanticBuildChild.js')
const runnerPath = path.join(projectRoot, 'resources', 'sensevoice', 'sensevoice_runner.py')
const runtimeRoot = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'floating-clock-electron',
  'runtimes',
  'sensevoice',
)
const ffmpegPath = path.join(projectRoot, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe')
const ffprobePath = path.join(projectRoot, 'tools', 'ffmpeg', 'bin', 'ffprobe.exe')

for (const [label, filePath] of [
  ['audio semantic worker', workerPath],
  ['SenseVoice runner', runnerPath],
  ['ffmpeg', ffmpegPath],
  ['ffprobe', ffprobePath],
]) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`${label} is missing`)
}

let ownedInputDirectory = null

function cleanupOwnedInput() {
  if (!ownedInputDirectory) return
  try {
    fs.rmSync(ownedInputDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // The system temp policy can clean a locked synthetic smoke input later.
  }
  ownedInputDirectory = null
}

function createSyntheticInput() {
  ownedInputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-audio-input-'))
  const outputPath = path.join(ownedInputDirectory, 'synthetic-audio.wav')
  const generated = spawnSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=16000:duration=2',
      '-c:a',
      'pcm_s16le',
      outputPath,
    ],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true },
  )
  if (generated.status !== 0 || !fs.existsSync(outputPath)) {
    cleanupOwnedInput()
    throw new Error('Unable to create the synthetic audio smoke input')
  }
  return outputPath
}

const videoPath = process.argv[2] ? path.resolve(process.argv[2]) : createSyntheticInput()
if (!fs.existsSync(videoPath) || !fs.statSync(videoPath).isFile()) {
  cleanupOwnedInput()
  throw new Error('video is missing')
}

const probe = spawnSync(
  ffprobePath,
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', videoPath],
  { encoding: 'utf8', timeout: 15_000, windowsHide: true },
)
const durationMs = Math.round(Number.parseFloat(probe.stdout.trim()) * 1_000)
if (probe.status !== 0 || !Number.isSafeInteger(durationMs) || durationMs < 1) {
  cleanupOwnedInput()
  throw new Error('Unable to determine the smoke video duration')
}

const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-audio-child-smoke-'))
const child = spawn(process.execPath, [workerPath], {
  cwd: mediaDir,
  env: {
    ...process.env,
    FLOATING_CLOCK_MEDIA_SEARCH_DIR: mediaDir,
    FLOATING_CLOCK_RESOURCES_PATH: projectRoot,
    FLOATING_CLOCK_SENSEVOICE_RUNTIME_ROOT: runtimeRoot,
    FLOATING_CLOCK_SENSEVOICE_RUNNER_PATH: runnerPath,
  },
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
let started = false
let settled = false
let stderrSeen = false

function finish(ok, details) {
  if (settled) return
  settled = true
  clearTimeout(timer)
  child.kill()
  try {
    fs.rmSync(mediaDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // The smoke result remains authoritative; a locked temporary directory can be retried later.
  }
  cleanupOwnedInput()
  console.log(JSON.stringify({ ok, durationMs, stderrSeen, ...details }, null, 2))
  process.exitCode = ok ? 0 : 1
}

const timer = setTimeout(() => finish(false, { error: 'audio-child-smoke-timeout' }), 240_000)

child.stdout.on('data', (chunk) => {
  buffer = `${buffer}${chunk}`.slice(-128 * 1024)
  let newline = buffer.indexOf('\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf('\n')
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.type === 'ready' && !started) {
      started = true
      child.stdin.write(
        `${JSON.stringify({
          type: 'start',
          videos: [
            {
              videoId: 'smoke-video-1',
              assetId: 'smoke-asset-1',
              videoPath,
              durationMs,
              sourceFingerprint: 'smoke-source-1',
            },
          ],
        })}\n`,
      )
      continue
    }
    if (message.type === 'error') {
      finish(false, { error: String(message.error || 'audio-child-error') })
      continue
    }
    if (message.type !== 'progress' || !['completed', 'failed'].includes(message.job?.state)) {
      continue
    }
    finish(message.job.state === 'completed', {
      state: message.job.state,
      completedVideos: message.job.completedVideos,
      completedSegments: message.job.completedSegments,
      failedSegments: message.job.failedSegments,
      error: message.job.lastError ? 'audio-child-job-failed' : null,
    })
  }
})

child.stderr.on('data', () => {
  stderrSeen = true
})
child.once('error', (error) => finish(false, { error: error.message }))
child.once('exit', (code) => {
  if (!settled) finish(false, { error: 'audio-child-exited', exitCode: code })
})
