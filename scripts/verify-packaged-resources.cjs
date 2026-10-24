const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { inspectLicensePayload } = require('./check-license-payload.cjs')
const { inspectCoveredSourcePayload } = require('./check-covered-source.cjs')
const {
  OFFLINE_BUNDLED_MODEL_NAMES,
  bundledComponentIdsForProfile,
  normalizePackageProfile,
} = require('./package-profile.cjs')

const CORE_RESOURCES = [
  ['projectLicense', path.join('legal', 'LICENSE')],
  ['projectNotice', path.join('legal', 'NOTICE')],
  ['sourceAvailability', path.join('legal', 'SOURCE_AVAILABILITY.md')],
  ['nativeStbLicense', path.join('legal', 'STB-MIT.txt')],
  ['alphaBackupSafety', path.join('legal', 'BACKUP_SAFETY.md')],
  ['appAsar', 'app.asar'],
  ['nativeAddon', 'fast_scanner.node'],
  ['duplicateWorker', 'duplicateFinderWorker.js'],
  ['similarWorker', 'assetSimilarSearchWorker.js'],
  ['suggestionWorker', 'assetSuggestionScanWorker.js'],
  ['clusteringWorker', 'assetClusteringWorker.js'],
  ['feedbackWorker', 'assetCategoryFeedbackWorker.js'],
  ['annWorker', 'vectorAnnWorker.js'],
  ['semanticVectorWorker', 'semanticVectorSearchWorker.js'],
  ['clipWorker', 'clipEmbeddingChild.js'],
  ['dinoWorker', 'dinoEmbeddingChild.js'],
  ['embeddingPreparationWorker', 'embeddingPreparationChild.js'],
  ['userModelRuntimeWorker', 'userModelRuntimeChild.js'],
  ['audioSemanticBuildWorker', 'audioSemanticBuildChild.js'],
  ['modelManifest', path.join('models', 'manifest.json')],
  ['runtimeManifest', 'runtime-manifest.json'],
  ['senseVoiceRunner', path.join('sensevoice', 'sensevoice_runner.py')],
  ['thirdPartyNotices', path.join('legal', 'THIRD_PARTY_NOTICES.md')],
  ['thirdPartyComponents', path.join('legal', 'THIRD_PARTY_COMPONENTS.md')],
  ['nodeThirdPartyComponents', path.join('legal', 'NODE_THIRD_PARTY_COMPONENTS.md')],
  ['sourceHanSansLicense', path.join('legal', 'SourceHanSans-OFL-1.1.txt')],
  ['licenseDecisions', path.join('legal', 'LICENSE_DECISIONS.json')],
  ['thirdPartyLicensePayload', path.join('legal', 'third-party', 'manifest.json')],
  ['coveredSourcePayload', path.join('legal', 'covered-source', 'manifest.json')],
  [
    'sharpBinding',
    path.join(
      'app.asar.unpacked',
      'node_modules',
      '@img',
      'sharp-win32-x64',
      'lib',
      'sharp-win32-x64-0.35.5.node',
    ),
  ],
  [
    'sharpVipsLibrary',
    path.join(
      'app.asar.unpacked',
      'node_modules',
      '@img',
      'sharp-win32-x64',
      'lib',
      'libvips-42.dll',
    ),
  ],
  [
    'sharpVipsCppLibrary',
    path.join(
      'app.asar.unpacked',
      'node_modules',
      '@img',
      'sharp-win32-x64',
      'lib',
      'libvips-cpp-8.18.7.dll',
    ),
  ],
  [
    'projectPreviewCanvasBinding',
    path.join(
      'app.asar.unpacked',
      'node_modules',
      '@napi-rs',
      'canvas-win32-x64-msvc',
      'skia.win32-x64-msvc.node',
    ),
  ],
  [
    'projectPreviewCanvasIcu',
    path.join(
      'app.asar.unpacked',
      'node_modules',
      '@napi-rs',
      'canvas-win32-x64-msvc',
      'icudtl.dat',
    ),
  ],
  [
    'onnxRuntimeBinding',
    path.join(
      'app.asar.unpacked',
      'node_modules',
      'onnxruntime-node',
      'bin',
      'napi-v6',
      'win32',
      'x64',
      'onnxruntime_binding.node',
    ),
  ],
]

const OFFLINE_ONLY_RESOURCES = [
  [
    'dinoModel',
    path.join('ai-models', 'dinov2_vitb14', 'Xenova', 'dinov2-base', 'onnx', 'model_q4.onnx'),
  ],
  [
    'clipModel',
    path.join(
      'ai-models',
      'clip_vit_base_patch32',
      'Xenova',
      'clip-vit-base-patch32',
      'onnx',
      'model_q4.onnx',
    ),
  ],
  [
    'clipTextModel',
    path.join(
      'ai-models',
      'clip_vit_base_patch32',
      'Xenova',
      'clip-vit-base-patch32',
      'onnx',
      'text_model_q4.onnx',
    ),
  ],
  [
    'multilingualTextModel',
    path.join(
      'ai-models',
      'clip_vit_b32_multilingual_v1_text',
      'sentence-transformers',
      'clip-ViT-B-32-multilingual-v1',
      'onnx',
      'model_quint8_avx2.onnx',
    ),
  ],
  ['ffmpeg', path.join('tools', 'ffmpeg', 'bin', 'ffmpeg.exe')],
  ['ffprobe', path.join('tools', 'ffmpeg', 'bin', 'ffprobe.exe')],
]

const REQUIRED_RESOURCES = [...CORE_RESOURCES, ...OFFLINE_ONLY_RESOURCES]

const LEGACY_DUPLICATE_PATHS = [
  path.join('ai-models', 'yolov8n', 'model.onnx'),
  path.join('ffmpeg', 'bin', 'ffmpeg.exe'),
  path.join('ffmpeg', 'bin', 'ffprobe.exe'),
]

const OFFLINE_ALLOWED_MODEL_PREFIXES = [
  'ai-models/dinov2_vitb14/',
  'ai-models/clip_vit_base_patch32/',
  'ai-models/clip_vit_b32_multilingual_v1_text/',
]
const OFFLINE_ALLOWED_TOOL_FILES = new Set([
  'tools/ffmpeg/bin/README.md',
  'tools/ffmpeg/bin/ffmpeg.exe',
  'tools/ffmpeg/bin/ffprobe.exe',
])
const ALWAYS_FORBIDDEN_RESOURCE_PREFIXES = [
  'cuda-runtime/',
  'managed-video-runtime/',
  'video-semantic-runtime/',
]
const SENSITIVE_RESOURCE_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519)(?:\.pub)?$/i,
  /\.(?:key|p12|pfx)$/i,
]

function normalizeRelativePath(value) {
  return value.split(path.sep).join('/')
}

function listPackagedFiles(root) {
  const files = []
  const pending = [path.resolve(root)]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(absolutePath)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(normalizeRelativePath(path.relative(root, absolutePath)))
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right))
}

function forbiddenPayloadPaths(files, profile) {
  return files.filter((relativePath) => {
    const lower = relativePath.toLowerCase()
    if (ALWAYS_FORBIDDEN_RESOURCE_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      return true
    }
    if (lower.startsWith('models/') && lower !== 'models/manifest.json') return true
    if (lower.startsWith('sensevoice/') && lower !== 'sensevoice/sensevoice_runner.py') {
      return true
    }
    if (profile === 'online') {
      return lower.startsWith('ai-models/') || lower.startsWith('tools/')
    }
    if (lower.startsWith('ai-models/')) {
      return !OFFLINE_ALLOWED_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix))
    }
    if (lower.startsWith('tools/')) return !OFFLINE_ALLOWED_TOOL_FILES.has(relativePath)
    return false
  })
}

function inspectRuntimeManifest(root, profile) {
  const manifestPath = path.join(root, 'runtime-manifest.json')
  const problems = []
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    problems.push(`runtime manifest is unreadable: ${error.message}`)
    return { problems, bundledComponentIds: [] }
  }
  if (manifest.distributionProfile !== profile) {
    problems.push(
      `runtime manifest profile is ${manifest.distributionProfile || 'missing'}, expected ${profile}`,
    )
  }
  if (!Array.isArray(manifest.components)) {
    problems.push('runtime manifest components are missing')
    return { problems, bundledComponentIds: [] }
  }
  const bundledComponentIds = manifest.components
    .filter((component) => component?.distribution?.defaultBundled === true)
    .map((component) => component.id)
    .sort()
  const expectedBundledIds = [...bundledComponentIdsForProfile(profile)].sort()
  if (JSON.stringify(bundledComponentIds) !== JSON.stringify(expectedBundledIds)) {
    problems.push(
      `runtime manifest bundled components are ${bundledComponentIds.join(', ') || 'none'}, expected ${expectedBundledIds.join(', ') || 'none'}`,
    )
  }
  return { problems, bundledComponentIds }
}

function inspectModelManifest(root, profile) {
  const manifestPath = path.join(root, 'models', 'manifest.json')
  const problems = []
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    problems.push(`model manifest is unreadable: ${error.message}`)
    return { problems, bundledModelNames: [] }
  }
  if (manifest.distributionProfile !== profile) {
    problems.push(
      `model manifest profile is ${manifest.distributionProfile || 'missing'}, expected ${profile}`,
    )
  }
  if (!Array.isArray(manifest.models)) {
    problems.push('model manifest models are missing')
    return { problems, bundledModelNames: [] }
  }
  const bundledModelNames = manifest.models
    .filter((model) => model.defaultBundled === true)
    .map((model) => model.name)
    .sort()
  const expectedBundledNames = profile === 'offline' ? [...OFFLINE_BUNDLED_MODEL_NAMES].sort() : []
  if (JSON.stringify(bundledModelNames) !== JSON.stringify(expectedBundledNames)) {
    problems.push(
      `model manifest bundled models are ${bundledModelNames.join(', ') || 'none'}, expected ${expectedBundledNames.join(', ') || 'none'}`,
    )
  }
  return { problems, bundledModelNames }
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function requiredResourcesForProfile(profile) {
  return normalizePackageProfile(profile) === 'online' ? CORE_RESOURCES : REQUIRED_RESOURCES
}

function inspectPackagedResources(resourcesPath, options = {}) {
  const root = path.resolve(resourcesPath)
  let profile = options.profile
  if (!profile) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime-manifest.json'), 'utf8'))
      profile = manifest.distributionProfile
    } catch {
      /* the missing manifest is reported by the normal resource check */
    }
  }
  profile = normalizePackageProfile(profile)
  const requiredResources = requiredResourcesForProfile(profile)
  const files = {}
  for (const [id, relativePath] of requiredResources) {
    const absolutePath = path.resolve(root, relativePath)
    let bytes = 0
    let exists = false
    try {
      const stat = fs.statSync(absolutePath)
      exists = stat.isFile() && stat.size > 0
      bytes = stat.isFile() ? stat.size : 0
    } catch {
      /* report the missing resource below */
    }
    files[id] = {
      relativePath: relativePath.split(path.sep).join('/'),
      exists,
      bytes,
      underResources: isInside(root, absolutePath),
    }
  }

  const legacyDuplicates = LEGACY_DUPLICATE_PATHS.filter((relativePath) =>
    fs.existsSync(path.resolve(root, relativePath)),
  ).map((relativePath) => relativePath.split(path.sep).join('/'))
  const missing = Object.entries(files)
    .filter(([, evidence]) => !evidence.exists || !evidence.underResources)
    .map(([id]) => id)
  let packagedFiles = []
  try {
    packagedFiles = listPackagedFiles(root)
  } catch {
    /* missing resources are already reported by the required-file checks */
  }
  const forbiddenPayloads = forbiddenPayloadPaths(packagedFiles, profile)
  const sensitivePayloads = packagedFiles.filter((relativePath) =>
    SENSITIVE_RESOURCE_PATTERNS.some((pattern) => pattern.test(relativePath)),
  )
  const manifestInspection = inspectRuntimeManifest(root, profile)
  const modelManifestInspection = inspectModelManifest(root, profile)
  let licensePayload
  try {
    // Bind packaged bytes to the reviewed source manifest, not a self-consistent
    // replacement manifest supplied by the package being inspected.
    const trustedManifest = fs.readFileSync(
      path.join(__dirname, '..', 'legal', 'third-party', 'manifest.json'),
    )
    licensePayload = inspectLicensePayload({
      payloadRoot: path.join(root, 'legal', 'third-party'),
      expectedManifestSha256: crypto.createHash('sha256').update(trustedManifest).digest('hex'),
    })
  } catch {
    licensePayload = { ok: false, errors: ['Trusted license payload inspection is unavailable'] }
  }

  const coveredSource = inspectCoveredSourcePayload(
    path.join(root, 'legal', 'covered-source'),
    root,
  )
  return {
    ok:
      missing.length === 0 &&
      legacyDuplicates.length === 0 &&
      forbiddenPayloads.length === 0 &&
      sensitivePayloads.length === 0 &&
      manifestInspection.problems.length === 0 &&
      modelManifestInspection.problems.length === 0 &&
      licensePayload.ok &&
      coveredSource.ok,
    profile,
    resourcesPath: root,
    requiredCount: requiredResources.length,
    missing,
    legacyDuplicates,
    forbiddenPayloads,
    sensitivePayloads,
    manifestProblems: manifestInspection.problems,
    modelManifestProblems: modelManifestInspection.problems,
    licensePayload,
    coveredSource,
    bundledComponentIds: manifestInspection.bundledComponentIds,
    bundledModelNames: modelManifestInspection.bundledModelNames,
    packagedFileCount: packagedFiles.length,
    files,
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temporaryPath, filePath)
}

function main() {
  const projectRoot = path.resolve(__dirname, '..')
  const resourcesPath = path.join(projectRoot, 'release', 'win-unpacked', 'resources')
  const profileArgument = process.argv.slice(2).find((value) => value.startsWith('--profile='))
  const requestedProfile = profileArgument?.slice('--profile='.length)
  const report = inspectPackagedResources(resourcesPath, {
    profile: requestedProfile ? normalizePackageProfile(requestedProfile) : undefined,
  })
  const reportPath = path.join(
    projectRoot,
    'artifacts',
    'packaged-runtime',
    'resources-report.json',
  )
  writeJsonAtomic(reportPath, report)
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
}

if (require.main === module) main()

module.exports = {
  LEGACY_DUPLICATE_PATHS,
  OFFLINE_ALLOWED_MODEL_PREFIXES,
  OFFLINE_ALLOWED_TOOL_FILES,
  REQUIRED_RESOURCES,
  CORE_RESOURCES,
  OFFLINE_ONLY_RESOURCES,
  forbiddenPayloadPaths,
  inspectPackagedResources,
  inspectModelManifest,
  inspectRuntimeManifest,
  isInside,
  listPackagedFiles,
  requiredResourcesForProfile,
}
