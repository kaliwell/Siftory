#!/usr/bin/env node
'use strict'

// Installs the repository's reviewed local-evaluation ONNX candidates through
// the same isolated inspection and atomic transaction used by the Settings UI.
// These models remain user-supplied and are never added to release resources.

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { loadTsModule } = require('../tests/guard-utils.cjs')

const repoRoot = path.resolve(__dirname, '..')
const runtimeChild = path.join(repoRoot, 'dist-electron', 'userModelRuntimeChild.js')
const manifestPath = path.join(repoRoot, 'resources', 'runtime-manifest.json')
const stableUserDataName = 'floating-clock-electron'
const managedModelNames = Object.freeze([
  'dinov2_vitb14',
  'clip_vit_base_patch32',
  'clip_vit_b32_multilingual_v1_text',
])

const candidates = Object.freeze([
  {
    slotId: 'subject-detector',
    profileId: 'subject-yolov8-640',
    componentId: 'ultralytics-yolov8n-coco-onnx',
    targetPath: 'models/yolov8n/model.onnx',
  },
  {
    slotId: 'face-detector',
    profileId: 'face-yolov8-640',
    componentId: 'lindevs-yolov8n-face-onnx',
    targetPath: 'models/yolov8n-face/model.onnx',
  },
  {
    slotId: 'face-embedder',
    profileId: 'face-arcface-112',
    componentId: 'cvlface-adaface-ir101-webface12m-onnx',
    targetPath: 'models/adaface/model.onnx',
  },
  {
    slotId: 'person-reid',
    profileId: 'reid-osnet-256x128',
    componentId: 'osnet-ain-x1-msmt17-onnx',
    targetPath: 'models/osnet/model.onnx',
  },
  {
    slotId: 'segment-encoder',
    profileId: 'sam-encoder-hwc-1024',
    componentId: 'pulpcut-mobilesam-onnx',
    targetPath: 'models/mobilesam/encoder.onnx',
  },
  {
    slotId: 'segment-decoder',
    profileId: 'sam-decoder-original-size',
    componentId: 'pulpcut-mobilesam-onnx',
    targetPath: 'models/mobilesam/decoder.onnx',
  },
])

function usage() {
  return [
    'Usage:',
    '  node scripts/install-local-user-models.cjs --accept-local-user-models',
    '  node scripts/install-local-user-models.cjs --verify-only',
    '',
    'Options:',
    '  --accept-local-user-models  Confirm local-use license/compatibility responsibility.',
    '  --replace-existing          Replace a slot containing a different model (never implicit).',
    '  --verify-only               Do not write; deep-load every installed user model.',
    '  --user-data=<absolute path> Override the stable userData path (diagnostics/tests).',
    '  --help                      Show this help.',
  ].join('\n')
}

function parseArgs(argv) {
  const options = {
    accept: false,
    replaceExisting: false,
    verifyOnly: false,
    userDataPath: '',
  }
  for (const argument of argv) {
    if (argument === '--accept-local-user-models') options.accept = true
    else if (argument === '--replace-existing') options.replaceExisting = true
    else if (argument === '--verify-only') options.verifyOnly = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else if (argument.startsWith('--user-data=')) {
      options.userDataPath = argument.slice('--user-data='.length).trim()
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  if (!options.verifyOnly && !options.accept && !options.help) {
    throw new Error('--accept-local-user-models is required before installing local model files')
  }
  if (options.verifyOnly && options.replaceExisting) {
    throw new Error('--replace-existing cannot be combined with --verify-only')
  }
  return options
}

function resolveUserDataPath(configuredPath) {
  const defaultPath = process.env.APPDATA
    ? path.join(process.env.APPDATA, stableUserDataName)
    : ''
  const selected = configuredPath || defaultPath
  if (!selected) throw new Error('APPDATA is unavailable; pass --user-data=<absolute path>')
  if (!path.isAbsolute(selected)) throw new Error('--user-data must be an absolute path')
  const resolved = path.resolve(selected)
  if (path.dirname(resolved) === resolved) throw new Error('Refusing to use a filesystem root')
  return resolved
}

function rejectSymlinkIfPresent(targetPath, label) {
  if (!fs.existsSync(targetPath)) return
  if (fs.lstatSync(targetPath).isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${targetPath}`)
  }
}

function validateDestination(userDataPath) {
  rejectSymlinkIfPresent(userDataPath, 'userData')
  const modelRoot = path.join(userDataPath, 'models')
  rejectSymlinkIfPresent(modelRoot, 'User model root')
  for (const candidate of candidates) {
    const slotRoot = path.join(modelRoot, candidate.slotId)
    rejectSymlinkIfPresent(slotRoot, `Model slot ${candidate.slotId}`)
    rejectSymlinkIfPresent(
      path.join(slotRoot, path.basename(candidate.targetPath)),
      `Model file ${candidate.slotId}`,
    )
    rejectSymlinkIfPresent(
      path.join(slotRoot, 'installation.json'),
      `Model metadata ${candidate.slotId}`,
    )
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function verifyCandidateSources() {
  if (!fs.existsSync(runtimeChild)) {
    throw new Error('Missing dist-electron/userModelRuntimeChild.js; run npm run build:renderer first')
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (!Array.isArray(manifest.components)) throw new Error('Runtime manifest has no components')

  const verified = []
  for (const candidate of candidates) {
    const component = manifest.components.find((item) => item.id === candidate.componentId)
    if (!component) throw new Error(`Runtime manifest component is missing: ${candidate.componentId}`)
    if (component.distribution?.defaultBundled !== false) {
      throw new Error(`${candidate.componentId} must remain excluded from default release resources`)
    }
    const artifact = component.artifacts?.find((item) => item.targetPath === candidate.targetPath)
    if (!artifact) throw new Error(`Runtime manifest artifact is missing: ${candidate.targetPath}`)
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256 || '')) {
      throw new Error(`Runtime manifest hash is invalid: ${candidate.targetPath}`)
    }
    const sourcePath = path.resolve(repoRoot, candidate.targetPath)
    const relativeSource = path.relative(repoRoot, sourcePath)
    if (
      !relativeSource ||
      relativeSource === '..' ||
      relativeSource.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeSource)
    ) {
      throw new Error(`Candidate source escapes the repository: ${candidate.targetPath}`)
    }
    const stat = fs.lstatSync(sourcePath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Candidate source is not a regular file: ${candidate.targetPath}`)
    }
    if (stat.size !== artifact.sizeBytes) {
      throw new Error(
        `Candidate size mismatch for ${candidate.targetPath}: expected ${artifact.sizeBytes}, got ${stat.size}`,
      )
    }
    const sha256 = await sha256File(sourcePath)
    if (sha256 !== artifact.sha256) {
      throw new Error(`Candidate SHA-256 mismatch for ${candidate.targetPath}`)
    }
    verified.push({
      ...candidate,
      sourcePath,
      sizeBytes: stat.size,
      sha256,
      license: component.license?.spdx || 'UNKNOWN',
      reviewStatus: component.license?.reviewStatus || 'unknown',
    })
    console.log(
      `[source] ${candidate.slotId}: verified ${stat.size} bytes, ${sha256.slice(0, 12)}…, ${component.license?.spdx || 'UNKNOWN'}`,
    )
  }
  return verified
}

async function runPlatform(options, verified, userDataPath) {
  let selectedSource = ''
  const electronStub = {
    app: {
      isPackaged: false,
      getPath: (name) => {
        if (name !== 'userData') throw new Error(`Unsupported app path request: ${name}`)
        return userDataPath
      },
      getAppPath: () => repoRoot,
    },
    dialog: {
      showOpenDialog: async () =>
        selectedSource
          ? { canceled: false, filePaths: [selectedSource] }
          : { canceled: true, filePaths: [] },
    },
    shell: { openPath: async () => '' },
  }

  const originalLoad = Module._load
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return electronStub
    return originalLoad.call(this, request, ...rest)
  }

  let host
  try {
    host = loadTsModule('electron/userModelRuntimeHost.ts')
    host.setUserModelRuntimeChildOptionsForTests({ scriptPath: runtimeChild })
    const service = loadTsModule('electron/userModelPlatformService.ts')
    const sessionService = loadTsModule('electron/userModelSessionService.ts')
    const managedModelService = loadTsModule('electron/modelService.ts')
    const installed = []
    const skipped = []

    if (!options.verifyOnly) {
      fs.mkdirSync(userDataPath, { recursive: true })
      validateDestination(userDataPath)

      for (const candidate of verified) {
        const currentStatus = service
          .listUserModelSlots()
          .find((slot) => slot.id === candidate.slotId)
        const destination = service.getUserModelPath(candidate.slotId)
        let currentHash = ''
        if (fs.existsSync(destination)) currentHash = await sha256File(destination)

        if (
          currentHash === candidate.sha256 &&
          currentStatus?.inspection?.compatible === true &&
          currentStatus.activeProfileId === candidate.profileId
        ) {
          console.log(`[install] ${candidate.slotId}: already installed and inspected`)
          skipped.push(candidate.slotId)
          continue
        }
        if (currentHash && currentHash !== candidate.sha256 && !options.replaceExisting) {
          throw new Error(
            `${candidate.slotId} contains a different user model; rerun with --replace-existing to replace it`,
          )
        }

        selectedSource = candidate.sourcePath
        console.log(`[inspect] ${candidate.slotId}: isolated ONNX graph compatibility check`)
        const result = await service.importUserModel(
          candidate.slotId,
          true,
          candidate.profileId,
        )
        selectedSource = ''
        if (!result.ok) throw new Error(`${candidate.slotId}: ${result.error || 'import failed'}`)
        if (
          result.status?.sha256 !== candidate.sha256 ||
          result.status?.inspection?.compatible !== true
        ) {
          throw new Error(`${candidate.slotId}: committed installation failed integrity checks`)
        }
        console.log(`[install] ${candidate.slotId}: committed atomically`)
        installed.push(candidate.slotId)
      }
    }

    console.log('[runtime] deep-loading six user-model slots in the isolated runtime')
    sessionService.resetUserModelSessionsForTests()
    const readiness = await sessionService.checkUserModelRuntimeSlots()
    for (const status of readiness) {
      console.log(
        `[runtime] ${status.slotId}: ${status.state}${status.error ? ` (${status.error})` : ''}`,
      )
    }
    const ready = readiness.filter((status) => status.state === 'ready').length
    managedModelService.initModelService(userDataPath)
    const managedReadiness = managedModelNames.map((name) => {
      const status = managedModelService.getModelStatus(name)
      const ready =
        ['downloaded', 'verified', 'loaded'].includes(status.state) &&
        typeof status.installedPath === 'string' &&
        status.installedPath.length > 0
      console.log(`[managed] ${name}: ${ready ? 'ready' : status.state}`)
      return {
        name,
        state: status.state,
        ready,
        ...(status.error ? { error: status.error } : {}),
      }
    })
    const managedReady = managedReadiness.filter((status) => status.ready).length
    return {
      ok: ready === readiness.length && managedReady === managedReadiness.length,
      mode: options.verifyOnly ? 'verify-only' : 'install',
      userDataPath,
      sourceFilesVerified: verified.length,
      installed,
      skipped,
      ready,
      total: readiness.length,
      readiness,
      managedReady,
      managedTotal: managedReadiness.length,
      managedReadiness,
    }
  } finally {
    try {
      host?.disposeUserModelRuntimeChild()
      host?.setUserModelRuntimeChildOptionsForTests()
    } finally {
      Module._load = originalLoad
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  const userDataPath = resolveUserDataPath(options.userDataPath)
  validateDestination(userDataPath)
  console.log(`[target] ${userDataPath}`)
  console.log(
    '[policy] local evaluation only; models stay outside packaged resources and retain user-supplied responsibility',
  )
  const verified = await verifyCandidateSources()
  const result = await runPlatform(options, verified, userDataPath)
  console.log(`MODEL_INSTALL_RESULT ${JSON.stringify(result)}`)
  if (!result.ok) process.exitCode = 2
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[model-install] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

module.exports = {
  candidates,
  managedModelNames,
  parseArgs,
  resolveUserDataPath,
  validateDestination,
}
