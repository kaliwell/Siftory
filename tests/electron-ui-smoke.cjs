const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const {
  assertTemporaryDirectory,
  createSmokeSessionMarker,
  createSmokeSpawnEnvironment,
  createUiSmokeFileFixture,
  verifyUiSmokeFileFixture,
  redactSmokeText,
  resolveUiSmokeExecutable,
} = require('./smoke-test-utils.cjs')

const repo = path.resolve(__dirname, '..')
const packaged = process.argv.includes('--packaged')
const mediaProbeRequested = process.argv.includes('--ffmpeg-media-probe')
const listenerDiagnosticsRequested = process.argv.includes('--listener-diagnostics')
if (mediaProbeRequested && (!packaged || process.platform !== 'win32')) {
  throw new Error('--ffmpeg-media-probe requires a Windows packaged smoke run')
}
const packagedDirectoryArg = process.argv.find((arg) => arg.startsWith('--packaged-dir='))
const requestedPackagedDirectory = packagedDirectoryArg?.slice('--packaged-dir='.length) || ''
if (packagedDirectoryArg && (!packaged || !requestedPackagedDirectory.trim())) {
  console.error('--packaged-dir requires --packaged and a nonempty installation directory')
  process.exit(1)
}
const profileArg = process.argv.find((arg) => arg.startsWith('--profile='))
const requestedProfile = profileArg
  ? profileArg.slice('--profile='.length)
  : process.env.FLOATING_CLOCK_PACKAGE_PROFILE || ''
const localeArg = process.argv.find((arg) => arg.startsWith('--locale='))
const requestedLocale = localeArg ? localeArg.slice('--locale='.length) : 'zh-CN'
const surfaceArg = process.argv.find((arg) => arg.startsWith('--surface='))
const requestedSurface = surfaceArg ? surfaceArg.slice('--surface='.length) : 'solid'
const themeArg = process.argv.find((arg) => arg.startsWith('--theme='))
const requestedTheme = themeArg ? themeArg.slice('--theme='.length) : 'matrix-dark'
const themeModeArg = process.argv.find((arg) => arg.startsWith('--theme-mode='))
const requestedThemeMode = themeModeArg ? themeModeArg.slice('--theme-mode='.length) : 'dark'
const viewportArg = process.argv.find((arg) => arg.startsWith('--viewport='))
const viewportMatch = viewportArg?.slice('--viewport='.length).match(/^(\d+)x(\d+)$/)
const requestedViewport = viewportMatch
  ? { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) }
  : null
const scaleArg = process.argv.find((arg) => arg.startsWith('--scale='))
const requestedScale = scaleArg ? Number(scaleArg.slice('--scale='.length)) : 1
const workAreaArg = process.argv.find((arg) => arg.startsWith('--work-area='))
const churnCyclesArg = process.argv.find((arg) => arg.startsWith('--churn-cycles='))
const requestedChurnCycles = churnCyclesArg
  ? Number(churnCyclesArg.slice('--churn-cycles='.length))
  : 0
const visibilityCyclesArg = process.argv.find((arg) => arg.startsWith('--visibility-cycles='))
const requestedVisibilityCycles = visibilityCyclesArg
  ? Number(visibilityCyclesArg.slice('--visibility-cycles='.length))
  : 3
const thumbnailSourceArg = process.argv.find((arg) => arg.startsWith('--thumbnail-source='))
const requestedThumbnailSource = thumbnailSourceArg
  ? path.resolve(thumbnailSourceArg.slice('--thumbnail-source='.length))
  : ''
const thumbnailSamplesArg = process.argv.find((arg) => arg.startsWith('--thumbnail-samples='))
const requestedThumbnailSamples = thumbnailSamplesArg
  ? Number(thumbnailSamplesArg.slice('--thumbnail-samples='.length))
  : 8
const artifactParentArg = process.argv.find((arg) => arg.startsWith('--artifact-parent='))
const requestedArtifactParent = artifactParentArg
  ? path.resolve(artifactParentArg.slice('--artifact-parent='.length))
  : ''
const workAreaMatch = workAreaArg
  ?.slice('--work-area='.length)
  .match(/^(-?\d+),(-?\d+),(\d+),(\d+)$/)
const requestedWorkArea = workAreaMatch
  ? {
      x: Number(workAreaMatch[1]),
      y: Number(workAreaMatch[2]),
      width: Number(workAreaMatch[3]),
      height: Number(workAreaMatch[4]),
    }
  : null
if (requestedLocale !== 'zh-CN' && requestedLocale !== 'en') {
  console.error(`Unsupported UI smoke locale: ${requestedLocale}`)
  process.exit(1)
}
if (requestedProfile && !['offline', 'online'].includes(requestedProfile)) {
  console.error(`Unsupported package profile: ${requestedProfile}`)
  process.exit(1)
}
if (requestedSurface !== 'solid' && requestedSurface !== 'glass') {
  console.error(`Unsupported UI smoke surface: ${requestedSurface}`)
  process.exit(1)
}
if (!/^[a-z0-9-]{1,64}$/.test(requestedTheme)) {
  console.error(`Unsupported UI smoke theme: ${requestedTheme}`)
  process.exit(1)
}
if (!['system', 'light', 'dark'].includes(requestedThemeMode)) {
  console.error(`Unsupported UI smoke theme mode: ${requestedThemeMode}`)
  process.exit(1)
}
if (
  requestedViewport &&
  (requestedViewport.width < 1280 ||
    requestedViewport.width > 3840 ||
    requestedViewport.height < 720 ||
    requestedViewport.height > 2160)
) {
  console.error(`Unsupported UI smoke viewport: ${viewportArg}`)
  process.exit(1)
}
if (
  !Number.isInteger(requestedThumbnailSamples) ||
  requestedThumbnailSamples < 1 ||
  requestedThumbnailSamples > 10_000
) {
  console.error(`Unsupported thumbnail smoke sample count: ${thumbnailSamplesArg}`)
  process.exit(1)
}
if (requestedThumbnailSource) {
  try {
    const entry = fs.lstatSync(requestedThumbnailSource)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('not a regular directory')
  } catch (error) {
    console.error(`Unsupported thumbnail smoke source: ${error.message}`)
    process.exit(1)
  }
}
if (![1, 1.25, 1.5].includes(requestedScale)) {
  console.error(`Unsupported UI smoke scale: ${requestedScale}`)
  process.exit(1)
}
if (
  workAreaArg &&
  (!requestedWorkArea ||
    Math.abs(requestedWorkArea.x) > 10_000 ||
    Math.abs(requestedWorkArea.y) > 10_000 ||
    requestedWorkArea.width < 800 ||
    requestedWorkArea.height < 600 ||
    requestedWorkArea.width > 3840 ||
    requestedWorkArea.height > 2160)
) {
  console.error(`Unsupported UI smoke work area: ${workAreaArg}`)
  process.exit(1)
}
if (
  !Number.isInteger(requestedChurnCycles) ||
  requestedChurnCycles < 0 ||
  requestedChurnCycles > 600
) {
  console.error(`Unsupported UI smoke churn cycles: ${churnCyclesArg}`)
  process.exit(1)
}
if (
  !Number.isInteger(requestedVisibilityCycles) ||
  requestedVisibilityCycles < 0 ||
  requestedVisibilityCycles > 500
) {
  console.error(`Unsupported visibility smoke cycle count: ${visibilityCyclesArg}`)
  process.exit(1)
}
let electronPath
try {
  electronPath = resolveUiSmokeExecutable({
    repo,
    packaged,
    packagedDirectory: requestedPackagedDirectory,
    developmentExecutable: packaged ? null : require('electron'),
  })
} catch (error) {
  console.error(`Invalid UI smoke installation: ${error.message}`)
  process.exit(1)
}
if (!fs.existsSync(electronPath)) {
  console.error(`Smoke executable not found: ${electronPath}`)
  process.exit(1)
}

const defaultArtifactRoot = path.join(
  repo,
  'artifacts',
  packaged ? 'ui-smoke-packaged' : 'ui-smoke',
  [
    packaged && requestedProfile ? requestedProfile : '',
    requestedLocale,
    requestedSurface !== 'solid' ? requestedSurface : '',
    requestedTheme !== 'matrix-dark' ? requestedTheme : '',
    requestedThemeMode !== 'dark' ? requestedThemeMode : '',
    requestedViewport ? `${requestedViewport.width}x${requestedViewport.height}` : '',
    requestedScale !== 1 ? `scale-${requestedScale}` : '',
    requestedWorkArea
      ? `area-${requestedWorkArea.x}-${requestedWorkArea.y}-${requestedWorkArea.width}x${requestedWorkArea.height}`
      : '',
  ]
    .filter(Boolean)
    .join('-'),
)
const managedArtifactsRoot = path.join(repo, 'artifacts')
let artifactRoot = defaultArtifactRoot
if (requestedArtifactParent) {
  const relative = path.relative(managedArtifactsRoot, requestedArtifactParent)
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    console.error('UI smoke artifact parent must stay below the project artifacts directory')
    process.exit(1)
  }
  let ancestor = requestedArtifactParent
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  const resolvedArtifacts = fs.realpathSync(managedArtifactsRoot)
  const resolvedAncestor = fs.realpathSync(ancestor)
  const ancestorRelative = path.relative(resolvedArtifacts, resolvedAncestor)
  if (
    ancestorRelative === '..' ||
    ancestorRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(ancestorRelative)
  ) {
    console.error('UI smoke artifact parent resolves outside the project artifacts directory')
    process.exit(1)
  }
  fs.mkdirSync(requestedArtifactParent, { recursive: true })
  artifactRoot = fs.mkdtempSync(path.join(requestedArtifactParent, 'ui-smoke-'))
}
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ui-smoke-'))
const resolvedTempRoot = fs.realpathSync(tempRoot)
assertTemporaryDirectory(tempRoot)
const keepTempRoot = process.env.FLOATING_CLOCK_UI_SMOKE_KEEP_TEMP === '1'
const reportPath = path.join(artifactRoot, 'report.json')
const screenshotPath = path.join(artifactRoot, 'screenshot.png')
if (fs.existsSync(artifactRoot)) {
  const relative = path.relative(
    fs.realpathSync(managedArtifactsRoot),
    fs.realpathSync(artifactRoot),
  )
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Refusing to remove smoke artifacts outside the project artifacts directory')
  }
}
fs.rmSync(artifactRoot, { recursive: true, force: true })
fs.mkdirSync(artifactRoot, { recursive: true })
const userDataPath = path.join(tempRoot, 'user-data')
fs.mkdirSync(userDataPath, { recursive: true })
const fileFixture = createUiSmokeFileFixture(tempRoot)
const thumbnailSourceSnapshots = []
let thumbnailManifestPath = ''
if (requestedThumbnailSource) {
  const supported = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'])
  const pending = [requestedThumbnailSource]
  while (pending.length > 0 && thumbnailSourceSnapshots.length < requestedThumbnailSamples) {
    const directory = pending.shift()
    const handle = fs.opendirSync(directory)
    try {
      let entry
      while (
        (entry = handle.readSync()) !== null &&
        thumbnailSourceSnapshots.length < requestedThumbnailSamples
      ) {
        const target = path.join(directory, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) pending.push(target)
        else if (entry.isFile() && supported.has(path.extname(entry.name).toLowerCase())) {
          const stat = fs.statSync(target)
          thumbnailSourceSnapshots.push({ path: target, size: stat.size, mtimeMs: stat.mtimeMs })
        }
      }
    } finally {
      handle.closeSync()
    }
  }
  if (thumbnailSourceSnapshots.length !== requestedThumbnailSamples) {
    console.error('Thumbnail smoke source does not contain enough supported regular files')
    removeTempRoot()
    process.exit(1)
  }
  thumbnailManifestPath = path.join(userDataPath, 'thumbnail-gpu-smoke-inputs.json')
  fs.writeFileSync(
    thumbnailManifestPath,
    JSON.stringify(thumbnailSourceSnapshots.map((snapshot) => snapshot.path)),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  )
}
fs.writeFileSync(
  path.join(userDataPath, 'floating_clock_settings.json'),
  JSON.stringify(
    {
      language: requestedLocale,
      fmPaneTabs: [[fileFixture.directory], [], [], []],
      fmActiveTab: [0, 0, 0, 0],
      transparency: requestedSurface === 'glass' ? 36 : 0,
      theme: 0,
      themeId: requestedTheme,
      themeMode: requestedThemeMode,
    },
    null,
    2,
  ),
  'utf8',
)
const smokeSessionNonce = createSmokeSessionMarker(userDataPath, 'ui')

function removeTempRoot() {
  if (keepTempRoot) return
  try {
    if (!fs.existsSync(tempRoot)) return
    assertTemporaryDirectory(tempRoot)
    if (fs.realpathSync(tempRoot) !== resolvedTempRoot) {
      throw new Error('Smoke temporary directory was redirected; refusing cleanup')
    }
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    console.warn(`Could not remove smoke temp directory: ${error.message}`)
  }
}

const electronArgs = packaged ? ['--no-sandbox'] : ['.', '--no-sandbox']
if (mediaProbeRequested) {
  electronArgs.push(
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--mute-audio',
  )
  electronArgs.push(`--user-data-dir=${userDataPath}`)
}
electronArgs.push(`--force-device-scale-factor=${requestedScale}`)
const spawnOptions = {
  cwd: packaged ? path.dirname(electronPath) : repo,
  env: createSmokeSpawnEnvironment({
    FLOATING_CLOCK_UI_SMOKE_REPORT: reportPath,
    FLOATING_CLOCK_UI_SMOKE_SCREENSHOT: screenshotPath,
    FLOATING_CLOCK_UI_SMOKE_USER_DATA: userDataPath,
    FLOATING_CLOCK_SMOKE_SESSION_NONCE: smokeSessionNonce,
    FLOATING_CLOCK_UI_SMOKE_ALLOW_NO_SANDBOX: '1',
    FLOATING_CLOCK_UI_SMOKE_LOCALE: requestedLocale,
    FLOATING_CLOCK_UI_SMOKE_SURFACE: requestedSurface,
    FLOATING_CLOCK_UI_SMOKE_VIEWPORT: requestedViewport
      ? `${requestedViewport.width}x${requestedViewport.height}`
      : '',
    FLOATING_CLOCK_UI_SMOKE_SCALE: String(requestedScale),
    FLOATING_CLOCK_PACKAGE_PROFILE: requestedProfile,
    FLOATING_CLOCK_UI_SMOKE_WORK_AREA: requestedWorkArea
      ? `${requestedWorkArea.x},${requestedWorkArea.y},${requestedWorkArea.width},${requestedWorkArea.height}`
      : '',
    FLOATING_CLOCK_UI_SMOKE_CHURN_CYCLES: String(requestedChurnCycles),
    FLOATING_CLOCK_UI_SMOKE_LISTENER_DIAGNOSTICS: listenerDiagnosticsRequested ? '1' : '',
    FLOATING_CLOCK_UI_SMOKE_FILE_FIXTURE_BYTES: String(fileFixture.totalBytes),
    FLOATING_CLOCK_UI_SMOKE_VISIBILITY_CYCLES: String(requestedVisibilityCycles),
    FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_MANIFEST: thumbnailManifestPath,
    FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_JOBS:
      process.env.FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_JOBS || '2',
    FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_BATCH:
      process.env.FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_BATCH || '2',
    FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_POLLS:
      process.env.FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_POLLS || '2400',
    FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_BACKEND:
      process.env.FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_BACKEND || 'gpu',
    FLOATING_CLOCK_MEDIA_SEARCH_DIR: path.join(tempRoot, 'media-search'),
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
}
if (mediaProbeRequested) {
  delete spawnOptions.env.NODE_OPTIONS
  delete spawnOptions.env.ELECTRON_RUN_AS_NODE
}
const child = spawn(electronPath, electronArgs, spawnOptions)

let stdout = ''
let stderr = ''
let mediaProbePromise = null
const mediaProbeReportPath = path.join(artifactRoot, 'ffmpeg-media-probe.json')
child.stdout.on('data', (chunk) => {
  stdout += chunk
})
child.stderr.on('data', (chunk) => {
  stderr += chunk
  if (mediaProbeRequested && !mediaProbePromise) {
    const match = stderr.match(
      /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/,
    )
    if (match) {
      mediaProbePromise = require('./electron-media-probe.cjs')
        .runMediaProbe({
          browserEndpoint: match[1],
          mainPid: child.pid,
          packageDirectory: path.dirname(electronPath),
          reportPath: mediaProbeReportPath,
        })
        .catch((error) => {
          const report = { ok: false, error: redactSmokeText(String(error)) }
          fs.writeFileSync(mediaProbeReportPath, JSON.stringify(report, null, 2) + '\n')
          return report
        })
    }
  }
})

const timeoutMs = Math.max(
  30_000,
  Math.min(
    600_000,
    Number(process.env.FLOATING_CLOCK_UI_SMOKE_TIMEOUT_MS) ||
      (requestedChurnCycles > 0 || requestedVisibilityCycles > 3 ? 600_000 : 30_000),
  ),
)
const timeout = setTimeout(() => {
  child.kill()
}, timeoutMs)

child.on('error', (error) => {
  clearTimeout(timeout)
  fs.writeFileSync(path.join(artifactRoot, 'stderr.txt'), redactSmokeText(String(error)), 'utf8')
  removeTempRoot()
  process.exitCode = 1
})

child.on('close', async (code) => {
  clearTimeout(timeout)
  if (mediaProbeRequested) {
    const mediaReport = mediaProbePromise ? await mediaProbePromise : null
    if (!mediaReport?.ok) {
      console.error('Packaged FFmpeg media probe did not pass')
      process.exitCode = 1
    }
  }
  fs.writeFileSync(path.join(artifactRoot, 'stdout.txt'), redactSmokeText(stdout), 'utf8')
  fs.writeFileSync(path.join(artifactRoot, 'stderr.txt'), redactSmokeText(stderr), 'utf8')
  const fileFixtureUnchanged = verifyUiSmokeFileFixture(fileFixture)
  removeTempRoot()

  if (!fs.existsSync(reportPath)) {
    console.error(
      `UI smoke did not produce a report (exit ${code}). See ${path.relative(repo, artifactRoot)}`,
    )
    process.exitCode = 1
    return
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  report.fileFixtureUnchanged = fileFixtureUnchanged
  report.fileFixture = { files: fileFixture.files, totalBytes: fileFixture.totalBytes }
  if (!fileFixtureUnchanged) process.exitCode = 1
  report.thumbnailSourceUnchanged = thumbnailSourceSnapshots.every((snapshot) => {
    try {
      const stat = fs.statSync(snapshot.path)
      return stat.size === snapshot.size && stat.mtimeMs === snapshot.mtimeMs
    } catch {
      return false
    }
  })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
  if (!report.thumbnailSourceUnchanged) process.exitCode = 1
  if (keepTempRoot) {
    report.tempRoot = tempRoot
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
  }
  if (packaged) {
    // Second piece of evidence for the native addon check: the main process logs
    // "[ImageSearch] Native addon loaded: fast_scanner <version> from <path>" on success.
    report.nativeAddonStdoutEvidence = stdout.includes('Native addon loaded: fast_scanner')
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
    if (!report.nativeAddonStdoutEvidence) {
      console.error('Packaged smoke: "Native addon loaded: fast_scanner" missing from stdout')
      process.exitCode = 1
    }
  }
  console.log(JSON.stringify(report, null, 2))
  if (code !== 0 || !report.ok) process.exitCode = 1
})
